/**
 * ADR 1022 — campaign performance: each org sees its own numbers, every write
 * is declared, every cap holds. Feature loop round 2, row 71 (`CP71WF-*`).
 *
 * One tenant, two client orgs. The OWNER created both; EDITOR is an editor of
 * org A, VIEWER a viewer of org A. Every leg goes through the real seams:
 * `buildFeatureSurfaces` (the ADR 0832 floor the executor binds), the services
 * the routes call, and the notification emitter.
 *
 * Sabotage (each run red, then reverted):
 * - D1: drop `dispatchBelongsToOrg` from `planSync` → the org-B batch is kept.
 * - D2: drop the `orgEmailIds` filter in `buildAttribution` → org B's email
 *   campaign appears in org A's report.
 * - D3: drop `requireOrg` from `listRecords` → the empty-org reads resolve.
 * - D4: delete `CAMPAIGN_CONNECTORS_SURFACE_POLICY` from the feature → the
 *   viewer's import lands.
 * - D7: write `lastSuccessAt` on a failed attempt → the failed sync reads fresh.
 * - D8: emit pacing alerts with no recipient → a record without
 *   `recipientUserId` appears, and the viewer is told.
 * - CP71WF-10: map an absent conversions column to 0 → the row reads 0.
 * - CP71WF-36: drop the org check in `resolveKpiCurrency` → org B's EUR
 *   budget labels org A's KPI.
 * - CP71CD-1: drop `orgOwnsAdCampaign` from `/recommendations/apply` → org A
 *   reaches org B's campaign.
 * - CP71CD-4: drop `assertAccountsNotOtherOrgs` → org A names org B's account.
 * - CP71CD-11: drop the "ledger says someone else's" check in `orgOwnsAdCampaign`
 *   → org A's settings reach org B's campaign.
 * - CP71CD-12: ignore legacy rows in `assertAccountsNotOtherOrgs` → A claims B's account.
 * - CP71CD-13: drop the attempt note before the conflict → no failed attempt.
 * - D5a: drop the other-org skip in `coverage()` → org A's increase throws
 *   on org B's broken cap.
 *
 * w83 re-grade (each sabotage-witnessed): drop the `orgVerified` conjunct
 * (CP71CD-2); drop the `orgId !== observed.orgId` conjunct → org B's VERIFIED
 * target is skipped (the case now sends one); drop `noteSyncAttempt` / the
 * failure reason / the org filter or `allowed` check in the re-plan; each D4
 * scope lowered to read; the tenant floor gone (audience); per-recipient emits
 * collapsed to a broadcast, the org scope check, the `orgId` stamp; the
 * absent-column null; the tombstone and ledger checks in `orgOwnsAdCampaign`;
 * each account-exclusivity arm; a misspelt policy key.
 *
 * Refusals are matched by code AND message: several paths share each code.
 *
 * Not covered here: the root-admin arm of `emitToOrg` (CP71CD-5). It runs only
 * for a shared `ws:` workspace (`materialiseRecipients` returns null otherwise),
 * and this tenant is `org:…`, so the owner is told as org A's owner MEMBER.
 * Removing the admin arm stays green (w83 probe ot-d8-admins); filed as gap row
 * TST-FJ-GC-3.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces, type FeatureSurface } from '../src/host/featureSurfaces.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { __putDispatchRecordForTests } from '../src/host/adsAdapter.js';
import { getSyncStatus, saveConnectorSettings } from '../src/features/campaign-connectors/syncService.js';
import { buildCampaignConnectorsSurface, CAMPAIGN_CONNECTORS_SURFACE_POLICY } from '../src/features/campaign-connectors/surface.js';
import { buildCampaignIntelSurface, CAMPAIGN_INTEL_SURFACE_POLICY } from '../src/features/campaign-intel/surface.js';
import { kpiSummary, listRecords, persistRecords } from '../src/features/campaign-connectors/performanceService.js';
import { computeDerived, mapAndValidate, parseCsv, autodetectMapping } from '../src/features/campaign-connectors/csvImport.js';
import { buildAttribution } from '../src/features/campaign-intel/attribution.js';
import { runPacingCheck } from '../src/features/campaign-intel/pacing.js';
import { capBlocksIncrease, createCap } from '../src/features/campaign-intel/spendCaps.js';
import { createBrief, setKernel } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { createCampaign as createEmailCampaign, createTemplate as createEmailTemplate } from '../src/features/email/emailService.js';
import { mintToken, recordOpen } from '../src/features/email/engagementService.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'campaign-connectors', 'campaign-intel', 'email']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body { user?: { userId: string }; orgId?: string; error?: string; message?: string; outcome?: string }
function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: Body }> } {
  let cookie = '';
  return {
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
    },
  };
}

const H = '/host/openwop-app';
const KERNEL = { headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z' };

async function fixture() {
  const tenantId = `org:cp71-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post(`${H}/test/login`, { email: `cp71-o-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const editor = client();
  const editorId = (await editor.post(`${H}/test/login`, { email: `cp71-e-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const viewer = client();
  const viewerId = (await viewer.post(`${H}/test/login`, { email: `cp71-v-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const orgA = (await owner.post(`${H}/orgs`, { name: 'Client A' })).body.orgId ?? '';
  const orgB = (await owner.post(`${H}/orgs`, { name: 'Client B' })).body.orgId ?? '';
  expect(ownerId && editorId && viewerId && orgA && orgB, 'fixture: three users and two orgs exist').toBeTruthy();
  expect((await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'E', subject: editorId, roles: ['editor'] })).status).toBe(201);
  expect((await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] })).status).toBe(201);
  return { tenantId, ownerId, editorId, viewerId, orgA, orgB, owner, editor };
}

const surfaces = (scope: BundleScope): Record<string, FeatureSurface> => buildFeatureSurfaces(scope);

async function campaignIn(tenantId: string, orgId: string, name: string, budgetMinor?: number): Promise<{ id: string; briefId: string }> {
  const brief = await createBrief(tenantId, orgId, 'test', {
    name, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' },
    channels: [{ type: 'ad_variants', enabled: true, config: {} }], utm: { campaign: `${name}-key` },
    ...(budgetMinor !== undefined ? { budget: { totalMinor: budgetMinor, currency: 'USD' } } : {}),
  });
  const withKernel = (await setKernel(tenantId, brief.id, KERNEL))!;
  const c = await finalizeFromBrief(tenantId, withKernel, 'test');
  return { id: c.id, briefId: brief.id };
}

const SCOPE_WRITE = { code: 'forbidden_scope', message: 'Missing required scope: workspace:write' };
const ORG_REQUIRED = { code: 'validation_error', message: '`orgId` is required: performance records belong to one organization.' };
const ACCOUNT_TAKEN = { code: 'conflict', message: 'That ad account belongs to another client organization in this workspace.' };
const CAP_UNRESOLVED = { code: 'conflict', message: 'Spend-cap coverage could not be resolved.' };
// A dry run of an owned campaign: the exact write, no call (adsAdapter `updateBudget`).
const DRY_RUN_OUTCOME = 'preview';
const NOT_IN_ORG = { error: 'not_found', message: 'No such campaign in this organization.' };

const perfRow = (campaignName: string, spend: number) => {
  const base = { spend, impressions: 100, clicks: 10, conversions: 1, revenue: 5 };
  return { platform: 'meta' as const, campaignName, adSet: 'a', date: '2026-07-01', ...base, ...computeDerived(base) };
};

describe('ADR 1022 D1 — a sync records only the org\'s own accounts', () => {
  it('the host re-plans: a batch from another org\'s dispatched account is dropped, and the attempt is recorded', async () => {
    const f = await fixture();
    const a = await campaignIn(f.tenantId, f.orgA, 'Mine');
    const b = await campaignIn(f.tenantId, f.orgB, 'Theirs');
    const stamp = { platformAdSetId: 's', platformAdId: 'x', createdAt: '2026-07-01T00:00:00Z' };
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pa', ...stamp, platformAdId: 'xa', briefId: a.briefId, campaignId: a.id, orgId: f.orgA, campaignName: 'Mine', adAccountId: 'act_a' });
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pb', ...stamp, platformAdId: 'xb', briefId: b.briefId, campaignId: b.id, orgId: f.orgB, campaignName: 'Theirs', adAccountId: 'act_b' });
    const cc = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId })['campaign-connectors']!;
    const metric = (campaignId: string, campaignName: string) => ({ date: '2026-07-01', campaignId, campaignName, impressions: 10, clicks: 1, spend: 2, conversions: 1, revenue: 3 });
    const out = await cc.recordAccountRows!({
      orgId: f.orgA, platform: 'meta', since: '2026-06-25', until: '2026-07-01',
      batches: [{ adAccountId: 'act_a', rows: [metric('pa', 'Mine')] }, { adAccountId: 'act_b', rows: [metric('pb', 'Theirs')] }],
      failures: [],
    });
    expect(out).toMatchObject({ imported: 1, droppedBatches: 1 });
    expect((await listRecords(f.tenantId, f.orgA)).map((r) => r.campaignName)).toEqual(['Mine']);
    expect((await getSyncStatus(f.tenantId, f.orgA))[0]).toMatchObject({ platform: 'meta', lastAttempt: { outcome: 'ok' }, lastSuccessAt: expect.any(String) });
  });
});

describe('ADR 1022 D7 — a failed attempt never reads as fresh', () => {
  it('CP71CD-13 — a plan that changed mid-sync is refused AND leaves a failed attempt', async () => {
    const f = await fixture();
    const cc = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId })['campaign-connectors']!;
    // No dispatches and no settings: the host's re-plan is `no_dispatches`.
    await expect(cc.recordAccountRows!({ orgId: f.orgA, platform: 'meta', batches: [{ adAccountId: 'act_x', rows: [] }], failures: [] })).rejects.toMatchObject({ code: 'conflict', message: 'The sync plan changed while the accounts were read (no_dispatches); nothing was recorded.' });
    expect((await getSyncStatus(f.tenantId, f.orgA))[0]).toMatchObject({ lastAttempt: { outcome: 'failed', reason: 'plan_changed' } });
  });

  it('no account answered: lastAttempt failed, no lastSuccessAt', async () => {
    const f = await fixture();
    const a = await campaignIn(f.tenantId, f.orgA, 'Mine');
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pa', platformAdSetId: 's', platformAdId: 'xa', createdAt: '2026-07-01T00:00:00Z', briefId: a.briefId, campaignId: a.id, orgId: f.orgA, adAccountId: 'act_a' });
    const cc = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId })['campaign-connectors']!;
    await cc.claimSync!({ orgId: f.orgA, platform: 'meta' });
    await cc.recordAccountRows!({ orgId: f.orgA, platform: 'meta', batches: [], failures: [{ adAccountId: 'act_a', reason: 'no_connection' }] });
    const [status] = await getSyncStatus(f.tenantId, f.orgA);
    expect(status).toMatchObject({ platform: 'meta', lastAttempt: { outcome: 'failed', reason: 'no_connection' } });
    expect(status!.lastSuccessAt).toBeUndefined();
    expect(status!.lastSyncAt, 'the cooldown claim is still kept').toEqual(expect.any(String));
  });
});

describe('ADR 1022 D3/D4 — the run surfaces ask what the routes ask', () => {
  it('a viewer cannot write through a workflow; the owner can; an org-less read is refused', async () => {
    const f = await fixture();
    const csv = 'date,campaign,spend,impressions,clicks,conversions,revenue\n2026-07-01,Promo,10,100,5,1,20\n';
    const asViewer = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.viewerId });
    await expect(asViewer['campaign-connectors']!.importCsv!({ orgId: f.orgA, csv })).rejects.toMatchObject(SCOPE_WRITE);
    await expect(asViewer['campaign-connectors']!.claimSync!({ orgId: f.orgA, platform: 'meta' })).rejects.toMatchObject(SCOPE_WRITE);
    await expect(asViewer['campaign-intel']!.pacingCheck!({ orgId: f.orgA })).rejects.toMatchObject(SCOPE_WRITE);
    // A viewer may still READ its org.
    await expect(asViewer['campaign-connectors']!.kpiSummary!({ orgId: f.orgA })).resolves.toMatchObject({ recordCount: 0 });
    // Positive control: the owner's import lands.
    const asOwner = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.ownerId });
    await expect(asOwner['campaign-connectors']!.importCsv!({ orgId: f.orgA, csv })).resolves.toMatchObject({ imported: 1 });
    // D3 — an empty org named nobody; it used to mean "every org".
    await persistRecords(f.tenantId, f.orgB, [perfRow('B only', 50)], 'csv');
    await expect(asOwner['campaign-connectors']!.kpiSummary!({})).rejects.toMatchObject(ORG_REQUIRED);
    await expect(asOwner['campaign-intel']!.planBudget!({ orgId: '', totalBudgetMinor: 1000, targetConversions: 10 })).rejects.toMatchObject(ORG_REQUIRED);
    await expect(asOwner['campaign-intel']!.anomalies!({})).rejects.toMatchObject(ORG_REQUIRED);
    await expect(listRecords(f.tenantId, '')).rejects.toMatchObject(ORG_REQUIRED);
  });

  it('the audience build (tenant-wide contacts) refuses a viewer', async () => {
    const f = await fixture();
    const asViewer = surfaces({ tenantId: f.tenantId, runId: 'r1', actingUserId: f.viewerId });
    await expect(asViewer['campaign-connectors']!.buildAudienceUpload!({ segmentId: 'seg-1' })).rejects.toMatchObject(SCOPE_WRITE);
  });
});

describe('ADR 1022 D2 — attribution reports only the org\'s email campaigns', () => {
  it('org B\'s email campaign and its opens never appear in org A\'s report', async () => {
    const f = await fixture();
    for (const [org, id] of [[f.orgA, 'tmpl-a'], [f.orgB, 'tmpl-b']] as const) {
      await createEmailTemplate({ tenantId: f.tenantId, orgId: org, name: id, subject: 's', body: 'b', createdBy: 'test', templateId: id });
    }
    await createEmailCampaign({ tenantId: f.tenantId, orgId: f.orgA, templateId: 'tmpl-a', createdBy: 'test', campaignId: 'em-a' });
    await createEmailCampaign({ tenantId: f.tenantId, orgId: f.orgB, templateId: 'tmpl-b', createdBy: 'test', campaignId: 'em-b' });
    for (const id of ['em-a', 'em-b']) await recordOpen(await mintToken({ tenantId: f.tenantId, campaignId: id, contactId: `ct-${id}`, kind: 'open' }));
    const report = await buildAttribution(f.tenantId, f.orgA);
    expect(report.email).toEqual([expect.objectContaining({ emailCampaignId: 'em-a', opens: 1, uniqueOpens: 1 })]);
  });
});

describe('ADR 1022 D8 — a client\'s pacing alert reaches that client\'s people', () => {
  it('org A\'s writers are told by name; the viewer and the rest of the workspace are not', async () => {
    const f = await fixture();
    const c = await campaignIn(f.tenantId, f.orgA, 'Overspend', 10000);
    await persistRecords(f.tenantId, f.orgA, [perfRow('Overspend', 150)], 'csv', c.id);
    const got: Array<{ recipientUserId?: string; recipientRole?: string; type: string; metadata?: Record<string, unknown> }> = [];
    const unsub = getNotificationEmitter().subscribe((r) => { if (r.tenantId === f.tenantId && r.type === 'campaign.pacing') got.push(r); });
    try {
      const run = await runPacingCheck(f.tenantId, f.orgA);
      expect(run.alerted).toEqual([{ campaignId: c.id, band: 'over' }]);
    } finally { unsub(); }
    expect(got.every((r) => typeof r.recipientUserId === 'string'), 'no tenant broadcast').toBe(true);
    const told = new Set(got.map((r) => r.recipientUserId));
    expect(told.has(f.editorId)).toBe(true);
    expect(told.has(f.ownerId), 'the org\'s owner (an owner member of org A) is told too').toBe(true);
    expect(told.has(f.viewerId)).toBe(false);
    expect(got.every((r) => r.metadata?.orgId === f.orgA)).toBe(true);
  });
});

describe('ADR 1022 (CP71WF-10) — a CSV column that is not there is unreported, not zero', () => {
  it('a spend-only export records conversions and revenue as null', () => {
    const { headers, rows } = parseCsv('date,campaign,spend,impressions,clicks\n2026-07-01,Promo,10,100,5\n');
    const { records } = mapAndValidate(headers, rows, autodetectMapping(headers), 'google', '2026-07-02');
    expect(records[0]).toMatchObject({ spend: 10, conversions: null, revenue: null });
    // A mapped column with an empty cell is still a measured 0.
    const withCol = parseCsv('date,campaign,spend,impressions,clicks,conversions\n2026-07-01,Promo,10,100,5,\n');
    expect(mapAndValidate(withCol.headers, withCol.rows, autodetectMapping(withCol.headers), 'google', '2026-07-02').records[0]).toMatchObject({ conversions: 0, revenue: null });
  });
});

describe('ADR 1022 D5a — one client\'s broken cap does not freeze another client', () => {
  it('an unresolvable cap in org B refuses org B\'s targets and skips org A\'s', async () => {
    const f = await fixture();
    // A client cap in org B whose ledger holds a tombstoned row (no account id):
    // its coverage cannot be resolved (target_account_unknown).
    await createCap(f.tenantId, f.orgB, { scope: { kind: 'client' }, limitMinor: 5000, currency: 'USD' }, 'creator');
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pb-tomb', platformAdSetId: 's', platformAdId: 'tomb', createdAt: '2026-07-01T00:00:00Z', campaignId: 'mc-b', orgId: f.orgB });
    // Org A's campaign on an account the broken cap is not known to cover.
    await expect(capBlocksIncrease(f.tenantId, { platform: 'meta', adAccountId: 'act_a', campaignId: 'pa', orgId: f.orgA, orgVerified: true }, 100)).resolves.toBeNull();
    // CP71CD-2 — an org the caller only ASSUMED (the adapter's own, not a stamped
    // ledger row) never earns the skip: still fail-closed.
    await expect(capBlocksIncrease(f.tenantId, { platform: 'meta', adAccountId: 'act_a', campaignId: 'pa', orgId: f.orgA }, 100)).rejects.toMatchObject(CAP_UNRESOLVED);
    // Org B's own target stays fail-closed, verified or not: the skip is for OTHER orgs only.
    await expect(capBlocksIncrease(f.tenantId, { platform: 'meta', adAccountId: 'act_b', campaignId: 'pb', orgId: f.orgB }, 100)).rejects.toMatchObject(CAP_UNRESOLVED);
    await expect(capBlocksIncrease(f.tenantId, { platform: 'meta', adAccountId: 'act_b', campaignId: 'pb', orgId: f.orgB, orgVerified: true }, 100)).rejects.toMatchObject(CAP_UNRESOLVED);
  });
});

describe('ADR 1022 (CP71WF-36) — another org\'s campaign says nothing about this org\'s currency', () => {
  it('a KPI read filtered by org B\'s campaign id does not take org B\'s budget currency', async () => {
    const f = await fixture();
    const brief = await createBrief(f.tenantId, f.orgB, 'test', {
      name: 'Euro', objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' },
      channels: [{ type: 'ad_variants', enabled: true, config: {} }], utm: { campaign: 'euro-key' }, budget: { totalMinor: 1000, currency: 'EUR' },
    });
    const b = await finalizeFromBrief(f.tenantId, (await setKernel(f.tenantId, brief.id, KERNEL))!, 'test');
    expect(await kpiSummary(f.tenantId, f.orgB, b.id)).toMatchObject({ currency: 'EUR', currencyKnown: true }); // positive control
    expect(await kpiSummary(f.tenantId, f.orgA, b.id)).toMatchObject({ currencyKnown: false, recordCount: 0 });
  });
});

describe('ADR 1022 (CP71CD-1) — a budget door touches only the org\'s own campaigns', () => {
  it('a writer in org A cannot apply a budget to org B\'s campaign through org A', async () => {
    const f = await fixture();
    const stamp = { platformAdSetId: 's', createdAt: '2026-07-01T00:00:00Z' };
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pb-1', platformAdId: 'xb1', ...stamp, campaignId: 'mc-b', orgId: f.orgB, adAccountId: 'act_b' });
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pa-1', platformAdId: 'xa1', ...stamp, campaignId: 'mc-a', orgId: f.orgA, adAccountId: 'act_a' });
    const apply = (campaignId: string, adAccountId: string) => f.editor.post(`${H}/campaign-intel/recommendations/apply`, { orgId: f.orgA, platform: 'meta', adAccountId, campaignId, dailyBudgetMinor: 100, dryRun: true });
    const theirs = await apply('pb-1', 'act_b');
    expect(theirs.status).toBe(404);
    expect(theirs.body).toMatchObject(NOT_IN_ORG);
    // Positive control: org A's own campaign passes the ownership check and
    // reaches the adapter's dry run.
    const mine = await apply('pa-1', 'act_a');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.outcome).toBe(DRY_RUN_OUTCOME);
    // CP71CD-14 — a tombstoned row (account id lost) cannot vouch for whatever
    // account the caller names.
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pa-tomb', platformAdId: 'xat', ...stamp, campaignId: 'mc-a2', orgId: f.orgA });
    const tomb = await apply('pa-tomb', 'act_anything');
    expect(tomb.status).toBe(404);
    expect(tomb.body).toMatchObject(NOT_IN_ORG);
  });

  it('CP71CD-11 — org A\'s account-scope settings never override the ledger saying a campaign is org B\'s', async () => {
    const f = await fixture();
    await saveConnectorSettings(f.tenantId, f.orgA, 'meta', { syncScope: 'account', adAccountIds: ['act_777'] });
    // Client B then launches on that account (a launch does not consult A's settings).
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pb-7', platformAdSetId: 's', platformAdId: 'xb7', createdAt: '2026-07-01T00:00:00Z', campaignId: 'mc-b7', orgId: f.orgB, adAccountId: 'act_777' });
    const apply = (campaignId: string) => f.editor.post(`${H}/campaign-intel/recommendations/apply`, { orgId: f.orgA, platform: 'meta', adAccountId: 'act_777', campaignId, dailyBudgetMinor: 100, dryRun: true });
    const theirs = await apply('pb-7');
    expect(theirs.status).toBe(404);
    expect(theirs.body).toMatchObject(NOT_IN_ORG);
    // A campaign the ledger does not know, on A's own configured account, is A's.
    const mine = await apply('p-unlaunched');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.outcome).toBe(DRY_RUN_OUTCOME);
  });
});

describe('ADR 1022 (CP71CD-4) — an ad account belongs to one client org', () => {
  it('org A cannot name an account org B launched on or already syncs', async () => {
    const f = await fixture();
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pb-2', platformAdSetId: 's', platformAdId: 'xb2', createdAt: '2026-07-01T00:00:00Z', campaignId: 'mc-b2', orgId: f.orgB, adAccountId: 'act_222' });
    await expect(saveConnectorSettings(f.tenantId, f.orgA, 'meta', { syncScope: 'account', adAccountIds: ['act_222'] })).rejects.toMatchObject(ACCOUNT_TAKEN);
    await saveConnectorSettings(f.tenantId, f.orgB, 'meta', { syncScope: 'account', adAccountIds: ['act_333'] });
    await expect(saveConnectorSettings(f.tenantId, f.orgA, 'meta', { syncScope: 'account', adAccountIds: ['333'] })).rejects.toMatchObject(ACCOUNT_TAKEN);
    // CP71CD-12 — a LEGACY row (no org stamp) is resolved through its brief.
    const legacyB = await campaignIn(f.tenantId, f.orgB, 'Legacy B');
    await __putDispatchRecordForTests({ tenantId: f.tenantId, platform: 'meta', platformCampaignId: 'pb-l', platformAdSetId: 's', platformAdId: 'xbl', createdAt: '2026-07-01T00:00:00Z', briefId: legacyB.briefId, adAccountId: 'act_555' });
    await expect(saveConnectorSettings(f.tenantId, f.orgA, 'meta', { syncScope: 'account', adAccountIds: ['act_555'] })).rejects.toMatchObject(ACCOUNT_TAKEN);
    // Positive control: an account nobody else holds is fine.
    await expect(saveConnectorSettings(f.tenantId, f.orgA, 'meta', { syncScope: 'account', adAccountIds: ['act_444'] })).resolves.toMatchObject({ adAccountIds: ['act_444'] });
  });
});

describe('ADR 1022 D4 (CP71CD-9) — every policy entry names a real surface method', () => {
  it('a renamed method cannot leave a dead floor entry behind', () => {
    const scope = { tenantId: 't', runId: 'r' };
    const cc = Object.keys(buildCampaignConnectorsSurface(scope));
    const ci = Object.keys(buildCampaignIntelSurface(scope));
    expect(Object.keys(CAMPAIGN_CONNECTORS_SURFACE_POLICY.methodScopes).filter((m) => !cc.includes(m))).toEqual([]);
    expect(Object.keys(CAMPAIGN_CONNECTORS_SURFACE_POLICY.tenantMethodScopes).filter((m) => !cc.includes(m))).toEqual([]);
    expect(Object.keys(CAMPAIGN_INTEL_SURFACE_POLICY.methodScopes).filter((m) => !ci.includes(m))).toEqual([]);
  });
});
