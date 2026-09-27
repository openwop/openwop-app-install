/**
 * Campaign Studio governance wiring (campaign gap plan §5B, Phase B) — proves:
 *  - B1 audit rows: brief/campaign mutations land `campaign.*` rows in the ONE
 *    audit store with `payload.tenantId` stamped (the governance-view contract);
 *  - B4 versions + protected-field re-approval: a content edit to a confirmed
 *    brief demotes it to draft, bumps `version`, and pins the pre-edit snapshot;
 *    re-finalizing a campaign bumps its version with snapshots;
 *  - B5 reads: `GET /campaigns/:id/{versions,dispatches}` serve under the same
 *    scope guard;
 *  - B3 spend gate: the ads adapter (the chokepoint — node ctx.ads calls bypass
 *    the capability-firewall) enforces `adSpend.approvalThresholdMinor` via a
 *    `campaign-spend` PendingApproval keyed fork-stable, honors explicit
 *    actionPolicy `disabled`/`draft-only`, and lets an approved record through.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { listApprovals, resolveApproval } from '../src/host/approvalService.js';
import { makeAdsAdapter } from '../src/host/adsAdapter.js';
import { setKernel } from '../src/features/campaign-brief/briefService.js';

const FINALIZE_KERNEL = {
  headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
};

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['campaign-brief', 'campaign-orchestration']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; tenantId?: string }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const uniqEmail = (): string => `cg-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const owner = client();
  // Explicit tenant so a test can set the kernel via the service (no kernel HTTP route).
  const tenantId = `user:cg-${Date.now()}-${n++}`;
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail(), tenantId });
  expect(r.status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

const BRIEF = '/v1/host/openwop-app/campaign-brief/briefs';
const ORCH = '/v1/host/openwop-app/campaign-orchestration';

function storageOrThrow() {
  const s = __hostExtStorage();
  if (!s) throw new Error('host-ext storage not initialized');
  return s;
}

async function confirmedBrief(owner: Client, orgId: string, tenantId: string): Promise<string> {
  const created = await owner.post(BRIEF, {
    orgId, name: 'Solstice Launch', productName: 'Solstice', objective: 'Grow subs',
    personaIds: ['p1'], messaging: { primaryValueProp: 'Fresher coffee' },
    channels: [{ type: 'landing_page', enabled: true, config: {} }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id: string = created.body.brief.id;
  // ORCH-1: finalize requires an approved messaging kernel — set it before confirm.
  await setKernel(tenantId, id, FINALIZE_KERNEL);
  const confirmed = await owner.patch(`${BRIEF}/${id}`, { status: 'confirmed' });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.brief.status).toBe('confirmed');
  return id;
}

describe('B1/B4 — brief bookkeeping: audit, versions, protected-field re-approval', () => {
  it('demotes a confirmed brief to draft on a protected-field edit, bumps version, pins the snapshot, audits it', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const id = await confirmedBrief(owner, orgId, tenantId);

    // Protected-field edit (objective) on a CONFIRMED brief.
    const edited = await owner.patch(`${BRIEF}/${id}`, { objective: 'Bigger goal' });
    expect(edited.status).toBe(200);
    expect(edited.body.brief.status).toBe('draft'); // demoted — re-approval required
    expect(edited.body.brief.version).toBe(2);

    // The PRE-edit revision is pinned.
    const versions = await owner.get(`${BRIEF}/${id}/versions`);
    expect(versions.status).toBe(200);
    const v1 = versions.body.versions.find((v: any) => v.version === 1);
    expect(v1).toBeTruthy();
    expect(v1.snapshot.objective).toBe('Grow subs');
    expect(v1.snapshot.status).toBe('confirmed');

    // Audit rows landed with payload.tenantId (the governance-view contract).
    const rows = await storageOrThrow().listAudit({ actionPrefix: 'campaign.brief.', limit: 200 });
    const actions = rows.filter((r) => r.resource === id).map((r) => r.action);
    expect(actions).toContain('campaign.brief.created');
    expect(actions).toContain('campaign.brief.confirmed');
    expect(actions).toContain('campaign.brief.reapproval-required');
    for (const r of rows.filter((x) => x.resource === id)) {
      expect((r.payload as { tenantId?: string }).tenantId).toBeTruthy();
    }
  });
});

describe('B4/B5 — campaign versions + governance reads', () => {
  it('finalize snapshots v1, re-finalize bumps to v2; versions + dispatches routes serve', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const briefId = await confirmedBrief(owner, orgId, tenantId);

    const fin1 = await owner.post(`${ORCH}/finalize`, { briefId });
    expect(fin1.status, JSON.stringify(fin1.body)).toBe(201);
    const campaignId: string = fin1.body.campaign.id;
    expect(fin1.body.campaign.version).toBe(1);

    const fin2 = await owner.post(`${ORCH}/finalize`, { briefId });
    expect(fin2.status).toBe(201);
    expect(fin2.body.campaign.id).toBe(campaignId); // one campaign per brief
    expect(fin2.body.campaign.version).toBe(2);

    const versions = await owner.get(`${ORCH}/campaigns/${campaignId}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions.map((v: any) => v.version).sort()).toEqual([1, 2]);

    const dispatches = await owner.get(`${ORCH}/campaigns/${campaignId}/dispatches`);
    expect(dispatches.status).toBe(200);
    expect(dispatches.body.dispatches).toEqual([]);

    const rows = await storageOrThrow().listAudit({ actionPrefix: 'campaign.campaign.', limit: 200 });
    const mine = rows.filter((r) => r.resource === campaignId);
    expect(mine.some((r) => r.action === 'campaign.campaign.finalized')).toBe(true);
    for (const r of mine) expect((r.payload as { tenantId?: string }).tenantId).toBeTruthy();
  });
});

describe('B3 — ad-spend governance gate in the ads adapter', () => {
  const TENANT = 'user:campaign-spend-test';
  const publishArgs = {
    platform: 'meta' as const,
    briefId: 'brief-spend-1',
    adAccountId: 'act_123',
    campaignName: 'Spendy',
    copy: { headline: 'H' },
    dailyBudgetMinor: 10_000,
    pageId: 'page-1', // ADR 0223: meta dispatch requires a pageId — this suite tests the SPEND GATE, which sits before the strategy
  };

  it('at/above the threshold: requires a campaign-spend approval; approved → gate opens; below: passes straight through', async () => {
    const adapter = makeAdsAdapter({ storage: storageOrThrow(), tenantId: TENANT, runId: 'run-1', actingUserId: 'user-1' });
    await setGovernancePolicy(TENANT, { adSpend: { approvalThresholdMinor: 5_000 } }, 'test');

    // Above threshold → requires_approval + a pending campaign-spend approval.
    const r1 = await adapter.publishAd(publishArgs);
    expect(r1.outcome).toBe('requires_approval');
    const approvalId = (r1 as { approvalId: string }).approvalId;
    const pending = await listApprovals(TENANT, 'pending');
    const appr = pending.find((a) => a.approvalId === approvalId);
    expect(appr?.kind).toBe('campaign-spend');
    expect(appr?.spendKind).toBe('publish');
    expect(appr?.dailyBudgetMinor).toBe(10_000);

    // Same key while pending → same approval, not a duplicate.
    const r2 = await adapter.publishAd(publishArgs);
    expect(r2.outcome).toBe('requires_approval');
    expect((r2 as { approvalId: string }).approvalId).toBe(approvalId);

    // Approve → the gate opens; the dispatch proceeds to the platform leg
    // (no connection in tests ⇒ no_connection — i.e. PAST the gate).
    const resolved = await resolveApproval(approvalId, { status: 'approved' });
    expect(resolved?.changed).toBe(true);
    const r3 = await adapter.publishAd(publishArgs);
    expect(r3.outcome).toBe('no_connection');

    // Below threshold → no approval friction at all.
    const r4 = await adapter.publishAd({ ...publishArgs, briefId: 'brief-spend-2', dailyBudgetMinor: 4_999 });
    expect(r4.outcome).toBe('no_connection');
  });

  it('explicit actionPolicy: disabled refuses; draft-only forces a preview; budget mutation honors the threshold', async () => {
    const adapter = makeAdsAdapter({ storage: storageOrThrow(), tenantId: TENANT, runId: 'run-2', actingUserId: 'user-1' });

    await setGovernancePolicy(TENANT, { actionPolicy: { 'ads.publish': 'disabled' }, adSpend: {} }, 'test');
    const r1 = await adapter.publishAd({ ...publishArgs, briefId: 'brief-spend-3' });
    expect(r1).toEqual({ outcome: 'failed', error: 'policy_disabled' });

    await setGovernancePolicy(TENANT, { actionPolicy: { 'ads.publish': 'draft-only' } }, 'test');
    const r2 = await adapter.publishAd({ ...publishArgs, briefId: 'brief-spend-4' });
    expect(r2.outcome).toBe('preview'); // draft-only ⇒ behaves as dryRun, zero platform calls

    await setGovernancePolicy(TENANT, { adSpend: { approvalThresholdMinor: 1_000 } }, 'test');
    const b1 = await adapter.updateBudget({ platform: 'meta', adAccountId: 'act_123', campaignId: 'c1', dailyBudgetMinor: 2_000 });
    expect(b1.outcome).toBe('requires_approval');
    // dryRun preview is side-effect-free and bypasses the gate.
    const b2 = await adapter.updateBudget({ platform: 'meta', adAccountId: 'act_123', campaignId: 'c1', dailyBudgetMinor: 2_000, dryRun: true });
    expect(b2.outcome).toBe('preview');
  });
});
