/**
 * CRM org-scoped surface (ADR 0008, Phase 1) — ROUTE-level harness. Boots the
 * real app and drives Companies / Deals / Pipelines over HTTP: toggle gating,
 * the lazy default pipeline, company + deal CRUD with link validation, stage
 * moves, pipeline-delete-while-referenced refusal, and the workspace RBAC
 * (owner/editor write, viewer read-only, cross-org + cross-tenant fail-closed).
 *
 * The legacy tenant-scoped contacts surface is untouched here (its own test
 * still covers it); a deal links a tenant contact to prove the two layers
 * compose.
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
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
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

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
  snapshot: () => string;
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
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    snapshot: () => cookie,
  };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
// ADR 0026: real sign-in is Firebase OIDC; tests mint an authenticated user via
// the env-gated auth test seam. Pass a shared `tenantId` to make co-tenant users.
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('crm'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const enableCrm = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('crm');
  if (def) await saveConfig({ ...def, status }, 'test');
};

/** Owner + a same-tenant member with `role`, plus an org owned by the owner.
 *  Mint each into one shared explicit tenantId, each in its own client. */
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

describe('crm org surface — toggle gating', () => {
  it('404s when the crm toggle is off', async () => {
    await enableCrm('off');
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.get(c(orgId, '/pipelines'))).status).toBe(404);
    await enableCrm('on');
  });
});

describe('crm org surface — companies, deals, pipelines (owner)', () => {
  it('lazy default pipeline, company + deal CRUD with links, stage move, delete refusal', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');

    // Lazy default pipeline (5 stages).
    const pipes = await owner.get(c(orgId, '/pipelines'));
    expect(pipes.status, JSON.stringify(pipes.body)).toBe(200);
    expect(pipes.body.pipelines).toHaveLength(1);
    const pipeline = pipes.body.pipelines[0];
    expect(pipeline.stages.length).toBe(5);

    // Company.
    const co = await owner.post(c(orgId, '/companies'), { name: 'Globex', domain: 'globex.test', tags: ['Key', 'key'] });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.tags).toEqual(['key']); // deduped + lowercased
    const companyId = co.body.companyId;
    expect((await owner.get(c(orgId, '/companies?q=glob'))).body.companies).toHaveLength(1);

    // A tenant-scoped contact (legacy surface) to link.
    const contact = await owner.post('/v1/host/openwop-app/crm/contacts', { name: 'Jane' });
    expect(contact.status).toBe(201);
    const contactId = contact.body.contactId;

    // Deal on the default pipeline's first stage, linking the company + contact.
    const deal = await owner.post(c(orgId, '/deals'), { title: 'Globex expansion', amount: 5000, currency: 'USD', companyId, contactId });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);
    expect(deal.body.pipelineId).toBe(pipeline.pipelineId);
    expect(deal.body.stageId).toBe(pipeline.stages[0].stageId);
    expect(deal.body.companyId).toBe(companyId);
    expect(deal.body.contactId).toBe(contactId);

    // Link validation: a foreign company / contact id is rejected.
    expect((await owner.post(c(orgId, '/deals'), { title: 'x', companyId: 'cmp:nope' })).status).toBe(404);
    expect((await owner.post(c(orgId, '/deals'), { title: 'x', contactId: 'crm:nope' })).status).toBe(404);

    // Move the deal to the 'Qualified' stage.
    const moved = await owner.patch(c(orgId, `/deals/${encodeURIComponent(deal.body.dealId)}`), { stageId: pipeline.stages[1].stageId });
    expect(moved.body.stageId).toBe(pipeline.stages[1].stageId);

    // Filtering by stage.
    expect((await owner.get(c(orgId, `/deals?stageId=${encodeURIComponent(pipeline.stages[1].stageId)}`))).body.deals).toHaveLength(1);

    // Pipeline delete refused while a deal references it; allowed after the deal is gone.
    expect((await owner.del(c(orgId, `/pipelines/${encodeURIComponent(pipeline.pipelineId)}`))).status).toBe(409);
    expect((await owner.del(c(orgId, `/deals/${encodeURIComponent(deal.body.dealId)}`))).status).toBe(204);
    expect((await owner.del(c(orgId, `/pipelines/${encodeURIComponent(pipeline.pipelineId)}`))).status).toBe(204);
  });
});

describe('crm org surface — deal owner/closeDate/status (ADR 0008 amendment)', () => {
  it('derives status from stage moves, honors explicit status, validates closeDate', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pipeline = (await owner.get(c(orgId, '/pipelines'))).body.pipelines[0];
    const wonStage = pipeline.stages.find((s: { name: string }) => s.name === 'Won');
    const lostStage = pipeline.stages.find((s: { name: string }) => s.name === 'Lost');

    // Create: defaults to open (first stage), accepts owner + closeDate.
    const deal = await owner.post(c(orgId, '/deals'), { title: 'Amendment deal', owner: 'user:alice', closeDate: '2026-09-30' });
    expect(deal.status, JSON.stringify(deal.body)).toBe(201);
    expect(deal.body.status).toBe('open');
    expect(deal.body.owner).toBe('user:alice');
    expect(deal.body.closeDate).toBe('2026-09-30');
    const id = encodeURIComponent(deal.body.dealId);

    // Garbage closeDate / status → 400.
    expect((await owner.post(c(orgId, '/deals'), { title: 'x', closeDate: 'soon' })).status).toBe(400);
    expect((await owner.post(c(orgId, '/deals'), { title: 'x', status: 'paused' })).status).toBe(400);
    expect((await owner.patch(c(orgId, `/deals/${id}`), { closeDate: '2026-13-45' })).status).toBe(400);

    // Stage move to Won derives status=won; to Lost derives lost; back to an
    // open-named stage derives open.
    expect((await owner.patch(c(orgId, `/deals/${id}`), { stageId: wonStage.stageId })).body.status).toBe('won');
    expect((await owner.patch(c(orgId, `/deals/${id}`), { stageId: lostStage.stageId })).body.status).toBe('lost');
    expect((await owner.patch(c(orgId, `/deals/${id}`), { stageId: pipeline.stages[0].stageId })).body.status).toBe('open');

    // Explicit status in the SAME patch as a stage move wins over derivation.
    const explicit = await owner.patch(c(orgId, `/deals/${id}`), { stageId: wonStage.stageId, status: 'open' });
    expect(explicit.body.status).toBe('open');

    // Owner + closeDate clear with null.
    const cleared = await owner.patch(c(orgId, `/deals/${id}`), { owner: null, closeDate: null });
    expect(cleared.body.owner).toBeUndefined();
    expect(cleared.body.closeDate).toBeUndefined();
  });
});

describe('crm org surface — RBAC', () => {
  it('editor writes; viewer is read-only (403); cross-org + cross-tenant fail closed', async () => {
    await enableCrm('on');
    // Editor can write.
    const ed = await ownerWithMember('editor');
    expect((await ed.member.post(c(ed.orgId, '/companies'), { name: 'EditorCo' })).status).toBe(201);

    // Viewer: read 200, write 403.
    const vw = await ownerWithMember('viewer');
    await vw.owner.post(c(vw.orgId, '/companies'), { name: 'Seed' });
    expect((await vw.member.get(c(vw.orgId, '/companies'))).status).toBe(200);
    const denied = await vw.member.post(c(vw.orgId, '/companies'), { name: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('forbidden_scope');

    // Cross-tenant non-member → 404 (org not in their tenant).
    const stranger = client();
    await signup(stranger);
    expect((await stranger.get(c(vw.orgId, '/companies'))).status).toBe(404);

    // Cross-org SAME tenant: editor of org A is not a member of org B → 403.
    const tenantId = `org:test-${Date.now()}-${n++}`;
    const ownerC = client();
    await signup(ownerC, { tenantId });
    const bob = client();
    const bobUser = await signup(bob, { tenantId });
    const orgA = (await ownerC.post('/v1/host/openwop-app/orgs', { name: 'A' })).body.orgId;
    const orgB = (await ownerC.post('/v1/host/openwop-app/orgs', { name: 'B' })).body.orgId;
    await ownerC.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'Bob', subject: bobUser.userId, roles: ['editor'] });
    expect((await bob.post(c(orgA, '/companies'), { name: 'OK' })).status).toBe(201);
    expect((await bob.get(c(orgB, '/companies'))).status).toBe(403);
  });
});

describe('crm org surface — tasks + activities (Phase 2)', () => {
  it('tasks CRUD + status; activities are append-only newest-first; links validated', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const deal = (await owner.post(c(orgId, '/deals'), { title: 'D' })).body;

    // Task linked to the deal.
    const task = await owner.post(c(orgId, '/tasks'), { title: 'Follow up', dealId: deal.dealId, dueDate: '2026-07-01' });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    expect(task.body.status).toBe('open');
    // Move through statuses.
    const done = await owner.patch(c(orgId, `/tasks/${encodeURIComponent(task.body.taskId)}`), { status: 'done' });
    expect(done.body.status).toBe('done');
    // Filter by deal + status.
    expect((await owner.get(c(orgId, `/tasks?dealId=${encodeURIComponent(deal.dealId)}`))).body.tasks).toHaveLength(1);
    expect((await owner.get(c(orgId, '/tasks?status=open'))).body.tasks).toHaveLength(0);
    // A foreign deal link is rejected.
    expect((await owner.post(c(orgId, '/tasks'), { title: 'x', dealId: 'deal:nope' })).status).toBe(404);
    expect((await owner.del(c(orgId, `/tasks/${encodeURIComponent(task.body.taskId)}`))).status).toBe(204);

    // Activities — append-only timeline, newest first.
    const a1 = await owner.post(c(orgId, '/activities'), { kind: 'note', body: 'first', dealId: deal.dealId });
    expect(a1.status, JSON.stringify(a1.body)).toBe(201);
    const a2 = await owner.post(c(orgId, '/activities'), { kind: 'call', body: 'second', dealId: deal.dealId });
    expect(a2.status).toBe(201);
    const list = await owner.get(c(orgId, `/activities?dealId=${encodeURIComponent(deal.dealId)}`));
    expect(list.body.activities).toHaveLength(2);
    expect(list.body.activities[0].body).toBe('second'); // newest first
    // Invalid kind → 400; there is NO update/delete route (append-only).
    expect((await owner.post(c(orgId, '/activities'), { kind: 'sms', body: 'x' })).status).toBe(400);
    expect((await owner.del(c(orgId, `/activities/${encodeURIComponent(a1.body.activityId)}`))).status).toBe(404);
  });
});

describe('crm org surface — custom fields + import (Phase 3)', () => {
  it('custom fields: required enforced, unknown rejected, type-checked', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    // Define a required string field + a number field for companies.
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'tier', label: 'Tier', type: 'string', required: true })).status).toBe(201);
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'employees', label: 'Employees', type: 'number' })).status).toBe(201);

    // Missing the required field → 400.
    expect((await owner.post(c(orgId, '/companies'), { name: 'NoTier' })).status).toBe(400);
    // Unknown custom field → 400.
    expect((await owner.post(c(orgId, '/companies'), { name: 'X', customFields: { tier: 'gold', bogus: 1 } })).status).toBe(400);
    // Wrong type (employees must be a number) → 400.
    expect((await owner.post(c(orgId, '/companies'), { name: 'X', customFields: { tier: 'gold', employees: 'lots' } })).status).toBe(400);
    // Valid → 201, custom fields persisted.
    const ok = await owner.post(c(orgId, '/companies'), { name: 'Acme', customFields: { tier: 'gold', employees: 250 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.customFields).toEqual({ tier: 'gold', employees: 250 });
  });

  it('ADR 0213 §1 — date/enum/reference field types: validation + tombstoned/cross-org refs rejected', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');

    // date
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'deal', key: 'renewal', label: 'Renewal', type: 'date' })).status).toBe(201);
    expect((await owner.post(c(orgId, '/deals'), { title: 'D', customFields: { renewal: 'not-a-date' } })).status).toBe(400);
    const dealOk = await owner.post(c(orgId, '/deals'), { title: 'D', customFields: { renewal: '2026-12-31' } });
    expect(dealOk.status, JSON.stringify(dealOk.body)).toBe(201);
    expect(dealOk.body.customFields.renewal).toBe('2026-12-31');

    // enum
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'plan', label: 'Plan', type: 'enum', options: ['starter', 'pro', 'enterprise'] })).status).toBe(201);
    expect((await owner.post(c(orgId, '/companies'), { name: 'X', customFields: { plan: 'ultra' } })).status).toBe(400);
    const companyOk = await owner.post(c(orgId, '/companies'), { name: 'X', customFields: { plan: 'pro' } });
    expect(companyOk.status, JSON.stringify(companyOk.body)).toBe(201);

    // reference (company → company): valid, dangling, cross-org, tombstoned.
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'parent', label: 'Parent', type: 'reference', refEntityType: 'company' })).status).toBe(201);
    const parent = await owner.post(c(orgId, '/companies'), { name: 'Parent Co' });
    expect((await owner.post(c(orgId, '/companies'), { name: 'Y', customFields: { plan: 'pro', parent: 'cmp:nope' } })).status).toBe(400); // dangling
    const child = await owner.post(c(orgId, '/companies'), { name: 'Y', customFields: { plan: 'pro', parent: parent.body.companyId } });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.customFields.parent).toBe(parent.body.companyId);

    // Tombstoned reference target rejected.
    const other = await owner.post(c(orgId, '/companies'), { name: 'Other' });
    const merged = await owner.post(c(orgId, `/companies/${encodeURIComponent(parent.body.companyId)}/merge`), { sourceCompanyId: other.body.companyId });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect((await owner.post(c(orgId, '/companies'), { name: 'Z', customFields: { plan: 'pro', parent: other.body.companyId } })).status).toBe(400);

    // Cross-org reference rejected (a company that exists, but in a DIFFERENT org).
    const another = await ownerWithMember('viewer');
    await another.owner.post(c(another.orgId, '/fields'), { entityType: 'company', key: 'parent', label: 'Parent', type: 'reference', refEntityType: 'company' });
    expect((await another.owner.post(c(another.orgId, '/companies'), { name: 'Foreign', customFields: { parent: parent.body.companyId } })).status).toBe(400);

    // Bad enum/reference field defs.
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'badenum', label: 'Bad', type: 'enum', options: [] })).status).toBe(400);
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'badref', label: 'Bad', type: 'reference', refEntityType: 'not-a-thing' })).status).toBe(400);
  });

  it('ADR 0257 seam adoption — a rollover date is now rejected; a real leap day is accepted', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'deal', key: 'renewal', label: 'Renewal', type: 'date' })).status).toBe(201);
    // Day-overflow "rollover" dates (that Date.parse silently rolls to the next month) are now
    // rejected at write time by the shared seam's strict round-trip check — the ONE deliberate
    // behavior delta of the seam adoption (write-time only; stored rows are never re-validated).
    expect((await owner.post(c(orgId, '/deals'), { title: 'D', customFields: { renewal: '2023-02-30' } })).status).toBe(400);
    expect((await owner.post(c(orgId, '/deals'), { title: 'D', customFields: { renewal: '2023-04-31' } })).status).toBe(400);
    // A real leap day still validates.
    const leap = await owner.post(c(orgId, '/deals'), { title: 'D', customFields: { renewal: '2024-02-29' } });
    expect(leap.status, JSON.stringify(leap.body)).toBe(201);
    expect(leap.body.customFields.renewal).toBe('2024-02-29');
  });

  it('ADR 0257 seam adoption — a string custom field is still bounded + secret-scrubbed (unchanged)', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    expect((await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'note', label: 'Note', type: 'string' })).status).toBe(201);
    // The seam uses the SAME host cleanString (cap 120 + secret-shape scrub) CRM already used —
    // so a >120-char value is capped, exactly as before delegation.
    const long = 'x'.repeat(200);
    const co = await owner.post(c(orgId, '/companies'), { name: 'Bounded', customFields: { note: long } });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect((co.body.customFields.note as string).length).toBeLessThanOrEqual(120);
  });

  it('import: dedup by key, column mapping, per-row errors', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    // Company import with name dedup.
    const imp = await owner.post(c(orgId, '/import'), {
      entityType: 'company',
      dedupeBy: 'name',
      rows: [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Alpha' }, { notname: 'x' }],
    });
    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    expect(imp.body.created).toBe(2); // Alpha, Beta
    expect(imp.body.skipped).toBe(1); // duplicate Alpha
    expect(imp.body.errors).toHaveLength(1); // the row with no name
    expect((await owner.get(c(orgId, '/companies'))).body.companies).toHaveLength(2);

    // Column mapping (source column → target field).
    const mapped = await owner.post(c(orgId, '/import'), { entityType: 'company', mapping: { Org: 'name' }, rows: [{ Org: 'Gamma' }] });
    expect(mapped.body.created).toBe(1);
    expect((await owner.get(c(orgId, '/companies?q=gamma'))).body.companies).toHaveLength(1);
  });
});

describe('crm org surface — followup hardening', () => {
  it('refuses removing a pipeline stage that deals sit on (409), allows it once moved', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    const pipeline = (await owner.get(c(orgId, '/pipelines'))).body.pipelines[0];
    const deal = (await owner.post(c(orgId, '/deals'), { title: 'D' })).body; // on stage[0]
    expect(deal.stageId).toBe(pipeline.stages[0].stageId);

    // Drop stage[0] (which the deal sits on) → 409, no orphaning.
    const keepWithoutFirst = pipeline.stages.slice(1).map((s: { stageId: string; name: string; probability: number }) => ({ stageId: s.stageId, name: s.name, probability: s.probability }));
    const refused = await owner.patch(c(orgId, `/pipelines/${encodeURIComponent(pipeline.pipelineId)}`), { stages: keepWithoutFirst });
    expect(refused.status).toBe(409);

    // Move the deal off stage[0], then the drop is allowed.
    await owner.patch(c(orgId, `/deals/${encodeURIComponent(deal.dealId)}`), { stageId: pipeline.stages[1].stageId });
    const ok = await owner.patch(c(orgId, `/pipelines/${encodeURIComponent(pipeline.pipelineId)}`), { stages: keepWithoutFirst });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.stages).toHaveLength(4);
  });

  it('persists falsy custom-field values (number 0, boolean false)', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'count', label: 'Count', type: 'number' });
    await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'active', label: 'Active', type: 'boolean' });
    const co = await owner.post(c(orgId, '/companies'), { name: 'Zero', customFields: { count: 0, active: false } });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    expect(co.body.customFields).toEqual({ count: 0, active: false }); // not dropped as falsy
  });

  it('import honors a required custom field (rows without it become per-row errors)', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'tier', label: 'Tier', type: 'string', required: true });
    const imp = await owner.post(c(orgId, '/import'), { entityType: 'company', rows: [{ name: 'A' }, { name: 'B', customFields: { tier: 'gold' } }] });
    expect(imp.status).toBe(200);
    expect(imp.body.created).toBe(1); // only the row with tier
    expect(imp.body.errors).toHaveLength(1); // the row missing the required field
  });

  // CRMGAP-6: the field-def resolution + entity-cap count are now hoisted OUT
  // of the per-row loop (read once, not once per row) — this pins that a
  // larger batch still enforces per-row required-field validation, type
  // validation, and dedup EXACTLY like the single-row path, so the hoist is a
  // performance change only, never a correctness one.
  it('import: a 200-row batch still validates required/typed custom fields + dedup per row', async () => {
    await enableCrm('on');
    const { owner, orgId } = await ownerWithMember('viewer');
    await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'tier', label: 'Tier', type: 'string', required: true });
    await owner.post(c(orgId, '/fields'), { entityType: 'company', key: 'employees', label: 'Employees', type: 'number' });

    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 200; i++) {
      if (i % 20 === 0) {
        // Every 20th row is missing the required `tier` field → per-row error.
        rows.push({ name: `NoTier-${i}` });
      } else if (i % 20 === 1) {
        // Every 20th+1 row has a WRONG-typed custom field → per-row error.
        rows.push({ name: `BadType-${i}`, customFields: { tier: 'gold', employees: 'lots' } });
      } else if (i % 20 === 2) {
        // A duplicate name (dedup exercised across a large seen-set).
        rows.push({ name: `NoTier-0`, customFields: { tier: 'gold' } });
      } else {
        rows.push({ name: `Company-${i}`, customFields: { tier: 'gold', employees: i } });
      }
    }
    const imp = await owner.post(c(orgId, '/import'), { entityType: 'company', dedupeBy: 'name', rows });
    expect(imp.status, JSON.stringify(imp.body)).toBe(200);
    // 10 missing-tier + 10 bad-type = 20 errors; 10 duplicate `NoTier-0` names
    // (i%20==2) = 10 skipped (the dedup check runs BEFORE field validation, so
    // the i=0 row's name is already in the seen-set by the time its own
    // missing-tier error is raised — it counts as an error, not a skip).
    expect(imp.body.errors.length).toBe(20);
    expect(imp.body.skipped).toBe(10);
    expect(imp.body.created).toBe(200 - 20 - 10);
    const list = await owner.get(c(orgId, '/companies'));
    expect(list.body.companies).toHaveLength(imp.body.created);
    for (const co of list.body.companies) {
      expect(co.customFields.tier).toBe('gold');
    }
  });

  // CRMGAP-6/9: the import route's running cap counter (seeded from one
  // pre-loop `listCompanies`, incremented per successful create, checked via
  // the shared `assertUnderCap` — CRMGAP-9's one cap-check primitive every
  // per-scope CRM entity count uses) must throw the SAME validation_error/409
  // shape at the SAME threshold the direct-create path's internal
  // full-collection check uses — a full 5000-row fixture is too slow for a
  // unit test, so this pins the shared primitive directly instead.
  it('assertUnderCap (the primitive the import route\'s hoisted counter and createCompany both call) enforces MAX_PER_ORG_ENTITIES', async () => {
    const { assertUnderCap, MAX_PER_ORG_ENTITIES } = await import('../src/features/crm/crmEntitiesService.js');
    expect(MAX_PER_ORG_ENTITIES).toBe(5000);
    expect(() => assertUnderCap(4999, MAX_PER_ORG_ENTITIES, 'companies')).not.toThrow();
    let threw: unknown;
    try {
      assertUnderCap(5000, MAX_PER_ORG_ENTITIES, 'companies');
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as { code?: string }).code).toBe('validation_error');
    expect((threw as { httpStatus?: number }).httpStatus).toBe(409);
  });
});
