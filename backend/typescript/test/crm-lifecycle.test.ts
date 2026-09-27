/**
 * CRM record-lifecycle ops (ADR 0209 §1-§3, ADR 0210 §1/§3/§5) — ROUTE-level
 * harness, mirroring crm-org-route.test.ts's client/signup helpers. Covers:
 *   - duplicate review (contacts by email, companies by domain/name)
 *   - contact + company merge (field precedence, relink, tombstone exclusion, 409s)
 *   - lead conversion (get-or-create, idempotent re-convert, forward-only stage, RBAC)
 *   - stage history on create + move
 *   - the pipeline report shape
 *   - CSV export (header row, quoting/formula guard, RBAC, toggle-off 404)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T; text?: string; headers: Headers }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
}
function client(initialCookie = ''): Client {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) {
      const m = /(__session=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/csv')) {
      const text = await res.text();
      return { status: res.status, body: undefined, text, headers: res.headers };
    }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out, headers: res.headers };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('crm'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enableCrm = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('crm');
  if (def) await saveConfig({ ...def, status }, 'test');
};

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; memberId: string; orgId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, memberId: memberUser.userId, orgId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('crm lifecycle — duplicate review', () => {
  it('groups contacts by case-folded email; email-less contacts never group', async () => {
    await enableCrm('on');
    const { owner } = await ownerWithMember('viewer');
    const email = `dup-${Date.now()}@acme.test`;
    await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Ada', email: email.toUpperCase() });
    // ADR 0627 D6 — CREATE claims the primary email and an email PATCH is gated
    // the same way (review S1), so no API lane can mint a primary-email duplicate
    // any more. Duplicate review exists for the rows that PRE-DATE the claim
    // (and for the merge-released / imported shapes): seed one the way it
    // really arises — a legacy row already in the store, no claim, same address.
    const dupCreate = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Ada Two', email });
    expect(dupCreate.status, JSON.stringify(dupCreate.body)).toBe(409);
    const adaTwo = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Ada Two', email: `other-${Date.now()}@acme.test` })).body;
    const dupPatch = await owner.patch(`/v1/host/openwop-app/crm/contacts/${encodeURIComponent(adaTwo.contactId)}`, { email });
    expect(dupPatch.status, 'the PATCH lane is gated like the create lane').toBe(409);
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const rowKey = `hostext:crm:contact:${adaTwo.contactId}`;
    const legacyRow = JSON.parse((await hostExtStorage().kvGet(rowKey))!);
    await hostExtStorage().kvSet(rowKey, JSON.stringify({ ...legacyRow, email }));
    await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'No Email' });

    const dups = await owner.get('/v1/host/openwop-app/crm/duplicates?entityType=contact');
    expect(dups.status, JSON.stringify(dups.body)).toBe(200);
    const group = dups.body.groups.find((g: { key: string }) => g.key === email.toLowerCase());
    expect(group).toBeTruthy();
    expect(group.contacts).toHaveLength(2);

    expect((await owner.get('/v1/host/openwop-app/crm/duplicates?entityType=bogus')).status).toBe(400);
  });

  it('groups companies by case-folded domain, else exact case-folded name', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    await owner.post(c(orgId, '/companies'), { name: 'Globex A', domain: 'GLOBEX.test' });
    await owner.post(c(orgId, '/companies'), { name: 'Globex B', domain: 'globex.test' });
    await owner.post(c(orgId, '/companies'), { name: 'Acme Same' });
    await owner.post(c(orgId, '/companies'), { name: 'ACME SAME' });

    const dups = await owner.get(c(orgId, '/duplicates?entityType=company'));
    expect(dups.status, JSON.stringify(dups.body)).toBe(200);
    const byDomain = dups.body.groups.find((g: { key: string }) => g.key === 'domain:globex.test');
    expect(byDomain?.companies).toHaveLength(2);
    const byName = dups.body.groups.find((g: { key: string }) => g.key === 'name:acme same');
    expect(byName?.companies).toHaveLength(2);
  });
});

describe('crm lifecycle — contact merge', () => {
  it('survivor wins, source fills blanks, relinks references, tombstones the source', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const survivor = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Survivor', owner: 'user:alice' })).body;
    const source = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Source', email: 'source@acme.test', company: 'SourceCo' })).body;

    const deal = (await owner.post(c(orgId, '/deals'), { title: 'D', contactId: source.contactId })).body;
    const task = (await owner.post(c(orgId, '/tasks'), { title: 'T', contactId: source.contactId })).body;
    const activity = (await owner.post(c(orgId, '/activities'), { kind: 'note', body: 'n', contactId: source.contactId })).body;

    const merged = await owner.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: source.contactId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body.owner).toBe('user:alice'); // survivor wins, never regressed
    expect(merged.body.email).toBe('source@acme.test'); // source fills a blank
    expect(merged.body.company).toBe('SourceCo');

    // Relinked.
    expect((await owner.get(c(orgId, `/deals/${deal.dealId}`))).body.contactId).toBe(survivor.contactId);
    expect((await owner.get(c(orgId, `/tasks/${task.taskId}`))).body.contactId).toBe(survivor.contactId);
    expect((await owner.get(c(orgId, '/activities'))).body.activities.find((a: { activityId: string }) => a.activityId === activity.activityId).contactId).toBe(survivor.contactId);

    // Tombstoned: excluded from list, still resolvable by id.
    const list = await owner.get('/v1/host/openwop-app/crm/contacts');
    expect(list.body.contacts.some((x: { contactId: string }) => x.contactId === source.contactId)).toBe(false);
    const byId = await owner.get(`/v1/host/openwop-app/crm/contacts/${source.contactId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.mergedInto).toBe(survivor.contactId);

    // 409s: self-merge, merge into/from a tombstone.
    expect((await owner.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: survivor.contactId })).status).toBe(409);
    expect((await owner.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: source.contactId })).status).toBe(409);
  });

  // CRMGAP-8 — TOCTOU: two DIFFERENT sources merged into the SAME survivor
  // CONCURRENTLY must not lose either fill to the other's last-writer-wins
  // `put` (the CAS retry in `crmMergeService.mergeContacts`). Before the fix
  // this was a real lost-update race: whichever `put` landed second would
  // overwrite the first writer's fill with a snapshot that never saw it.
  it('two concurrent merges into the SAME survivor (different sources) both land — no lost update', async () => {
    await enableCrm('on');
    const { owner } = await ownerWithMember('viewer');
    const survivor = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Survivor' })).body; // no email/company/owner set
    const sourceEmail = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Source Email', email: 'race@acme.test' })).body;
    const sourceCompany = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Source Company', company: 'RaceCo' })).body;

    const [r1, r2] = await Promise.all([
      owner.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: sourceEmail.contactId }),
      owner.post(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}/merge`, { sourceContactId: sourceCompany.contactId }),
    ]);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);

    // BOTH fills must be present — neither concurrent merge's write was lost.
    const final = await owner.get(`/v1/host/openwop-app/crm/contacts/${survivor.contactId}`);
    expect(final.body.email).toBe('race@acme.test');
    expect(final.body.company).toBe('RaceCo');
    // Both sources tombstoned.
    expect((await owner.get(`/v1/host/openwop-app/crm/contacts/${sourceEmail.contactId}`)).body.mergedInto).toBe(survivor.contactId);
    expect((await owner.get(`/v1/host/openwop-app/crm/contacts/${sourceCompany.contactId}`)).body.mergedInto).toBe(survivor.contactId);
  });
});

describe('crm lifecycle — company merge', () => {
  it('unions tags + customFields (survivor wins per-key), relinks references', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'tier', label: 'Tier', type: 'string' });
    const survivor = (await owner.post(c(orgId, '/companies'), { name: 'Survivor Co', tags: ['vip'], customFields: { tier: 'gold' } })).body;
    const source = (await owner.post(c(orgId, '/companies'), { name: 'Source Co', tags: ['lead'] })).body;
    const deal = (await owner.post(c(orgId, '/deals'), { title: 'D', companyId: source.companyId })).body;

    const merged = await owner.post(c(orgId, `/companies/${survivor.companyId}/merge`), { sourceCompanyId: source.companyId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(merged.body.tags.sort()).toEqual(['lead', 'vip']);
    expect(merged.body.customFields.tier).toBe('gold'); // survivor wins per-key

    expect((await owner.get(c(orgId, `/deals/${deal.dealId}`))).body.companyId).toBe(survivor.companyId);
    const list = await owner.get(c(orgId, '/companies'));
    expect(list.body.companies.some((x: { companyId: string }) => x.companyId === source.companyId)).toBe(false);
  });
});

describe('crm lifecycle — lead conversion', () => {
  it('creates company + deal, is idempotent-by-outcome, advances stage forward-only, RBAC-gated', async () => {
    await enableCrm('on');
    const { owner, member, orgId } = await ownerWithMember('viewer');
    const contact = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Prospect', email: 'prospect@newco.test' })).body;
    expect(contact.stage).toBe('lead');

    // Viewer is read-only: 403.
    const denied = await member.post(`/v1/host/openwop-app/crm/contacts/${contact.contactId}/convert`, { orgId });
    expect(denied.status).toBe(403);

    const converted = await owner.post(`/v1/host/openwop-app/crm/contacts/${contact.contactId}/convert`, { orgId });
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.created).toEqual({ company: true, deal: true });
    expect(converted.body.company.domain).toBe('newco.test');
    expect(converted.body.contact.stage).toBe('qualified'); // lead → qualified

    // Re-convert: idempotent by outcome — same company + same OPEN deal, no dupes.
    const again = await owner.post(`/v1/host/openwop-app/crm/contacts/${contact.contactId}/convert`, { orgId });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.created).toEqual({ company: false, deal: false });
    expect(again.body.company.companyId).toBe(converted.body.company.companyId);
    expect(again.body.deal.dealId).toBe(converted.body.deal.dealId);
    // Forward-only: already qualified, stays qualified (never regresses / re-advances further).
    expect(again.body.contact.stage).toBe('qualified');
  });

  it('free-mail domains never identify a company; falls back to name match', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const contact = (await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Gmail Prospect', email: 'someone@gmail.com', company: 'FreeMailCo' })).body;
    const converted = await owner.post(`/v1/host/openwop-app/crm/contacts/${contact.contactId}/convert`, { orgId });
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.company.domain).toBeUndefined();
    expect(converted.body.company.name).toBe('FreeMailCo');
  });
});

describe('crm lifecycle — stage history', () => {
  it('appends an initial row on create and one per stage move', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pipeline = (await owner.get(c(orgId, '/pipelines'))).body.pipelines[0];
    const deal = (await owner.post(c(orgId, '/deals'), { title: 'D' })).body;

    const initial = await owner.get(c(orgId, `/deals/${deal.dealId}/stage-history`));
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    expect(initial.body.history).toHaveLength(1);
    expect(initial.body.history[0].fromStageId).toBeNull();
    expect(initial.body.history[0].toStageId).toBe(pipeline.stages[0].stageId);

    await owner.patch(c(orgId, `/deals/${deal.dealId}`), { stageId: pipeline.stages[1].stageId });
    await owner.patch(c(orgId, `/deals/${deal.dealId}`), { stageId: pipeline.stages[2].stageId });

    const after = await owner.get(c(orgId, `/deals/${deal.dealId}/stage-history`));
    expect(after.body.history).toHaveLength(3);
    expect(after.body.history[0].fromStageId).toBe(pipeline.stages[1].stageId); // newest first
    expect(after.body.history[0].toStageId).toBe(pipeline.stages[2].stageId);
  });
});

describe('crm lifecycle — pipeline report', () => {
  it('returns funnel/perStage/totals/winRate/aging/conversions in one fetch', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pipeline = (await owner.get(c(orgId, '/pipelines'))).body.pipelines[0];
    const wonStage = pipeline.stages.find((s: { name: string }) => s.name === 'Won');
    const lostStage = pipeline.stages.find((s: { name: string }) => s.name === 'Lost');

    await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Lead1', stage: 'lead' });
    await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Cust1', stage: 'customer' });

    const openDeal = (await owner.post(c(orgId, '/deals'), { title: 'Open', amount: 1000 })).body;
    // R2 CC-SP-3 — two more OPEN deals in the first stage with mixed/cased
    // currencies, to pin the currency-grouped sums.
    await owner.post(c(orgId, '/deals'), { title: 'Euro', amount: 300, currency: 'EUR' });
    await owner.post(c(orgId, '/deals'), { title: 'LowerUsd', amount: 700, currency: 'usd' });
    await owner.post(c(orgId, '/deals'), { title: 'UpperUsd', amount: 100, currency: 'USD' });
    await owner.post(c(orgId, '/deals'), { title: 'Won', amount: 500, stageId: wonStage.stageId });
    await owner.post(c(orgId, '/deals'), { title: 'Lost', amount: 200, stageId: lostStage.stageId });

    const report = await owner.get(c(orgId, `/reports/pipeline?pipelineId=${pipeline.pipelineId}`));
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.funnel.find((f: { stage: string }) => f.stage === 'lead').count).toBeGreaterThanOrEqual(1);
    const firstStage = report.body.perStage.find((s: { stageId: string }) => s.stageId === pipeline.stages[0].stageId);
    expect(firstStage.sum).toBe(2100); // the compat figure stays (blind)
    // R2 CC-SP-3 — the currency-grouped sums: unitless / EUR / USD, with the
    // agent-cased 'usd' folded into ONE 'USD' group (review F11), and the
    // report-level currency list uppercased+sorted.
    expect(firstStage.sums).toEqual([
      { currency: null, sum: 1000, weightedSum: expect.any(Number) },
      { currency: 'EUR', sum: 300, weightedSum: expect.any(Number) },
      { currency: 'USD', sum: 800, weightedSum: expect.any(Number) },
    ]);
    expect(report.body.currencies).toEqual(['EUR', 'USD']);
    expect(report.body.totals).toEqual({ openCount: 4, wonCount: 1, lostCount: 1, winRate: 0.5 });
    expect(Array.isArray(report.body.aging)).toBe(true);
    expect(Array.isArray(report.body.snapshots)).toBe(true);
    expect(Array.isArray(report.body.conversions)).toBe(true);
    // The 'Open' deal never moved, so it shouldn't be an aging outlier this soon.
    expect(report.body.aging.some((a: { dealId: string }) => a.dealId === openDeal.dealId)).toBe(false);
  });
});

describe('crm lifecycle — CSV export', () => {
  it('org export: header row, RFC 4180 quoting, formula-injection guard, viewer read allowed, toggle-off 404', async () => {
    await enableCrm('on');
    const { owner, member, orgId } = await ownerWithMember('viewer');
    await owner.post(c(orgId, '/companies'), { name: 'Comma, Inc' });
    await owner.post(c(orgId, '/companies'), { name: '=SUM(1,2)' });

    const exp = await owner.get(c(orgId, '/export?entityType=companies'));
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type')).toContain('text/csv');
    expect(exp.headers.get('content-disposition')).toContain('attachment; filename="crm-companies-');
    const text = exp.text ?? '';
    expect(text.split('\r\n')[0]).toContain('companyId,name,domain');
    expect(text).toContain('"Comma, Inc"');
    expect(text).toContain("'=SUM(1,2)");

    // Viewer can read the export.
    expect((await member.get(c(orgId, '/export?entityType=companies'))).status).toBe(200);

    // Toggle off → 404.
    await enableCrm('off');
    expect((await owner.get(c(orgId, '/export?entityType=companies'))).status).toBe(404);
    await enableCrm('on');
  });

  it('tenant contact export', async () => {
    await enableCrm('on');
    const { owner } = await ownerWithMember('viewer');
    await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Export Me' });
    const exp = await owner.get('/v1/host/openwop-app/crm/export?entityType=contacts');
    expect(exp.status).toBe(200);
    expect(exp.text?.split('\r\n')[0]).toContain('contactId,name,email');
  });
});
