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
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const PORT = 18671;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(PORT, res);
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
  const r = await c.post('/v1/host/sample/test/login', { email: uniqEmail('crm'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
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
  const org = await owner.post('/v1/host/sample/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/sample/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, memberId: memberUser.userId, orgId };
}
const c = (orgId: string, suffix = ''): string => `/v1/host/sample/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;

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
    const contact = await owner.post('/v1/host/sample/crm/contacts', { name: 'Jane' });
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
    const orgA = (await ownerC.post('/v1/host/sample/orgs', { name: 'A' })).body.orgId;
    const orgB = (await ownerC.post('/v1/host/sample/orgs', { name: 'B' })).body.orgId;
    await ownerC.post(`/v1/host/sample/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'Bob', subject: bobUser.userId, roles: ['editor'] });
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
});
