/**
 * Sales Territory Management — Phase 1 (model + hierarchy + lifecycle).
 * ROUTE-level harness (mirrors crm-lifecycle.test.ts). Covers:
 *   - toggle-off 404 (backend authority, ADR 0001 §3.4)
 *   - type + model CRUD, RBAC (viewer read / write denied)
 *   - hierarchy: parent linkage, acyclic guard, cross-model IDOR
 *   - planning-only editing (active model is frozen)
 *   - lifecycle: activate (single active), archive, concurrent-activation → one winner
 *   - activate/archive reserved to host:territories:manage (admin)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { transitionModelViaReview } from './territoryReview.js';

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

interface Res<T = any> { status: number; body: T; headers: Headers }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out, headers: res.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const enableTerritories = async (status: 'on' | 'off'): Promise<void> => {
  const def = getToggleDefault('territories');
  if (def) await saveConfig({ ...def, status }, 'test');
};

async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:terr-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `owner-${Date.now()}-${n++}@acme.test`, tenantId });
  const member = client();
  const memberUser = (await member.post('/v1/host/openwop-app/test/login', { email: `member-${Date.now()}-${n++}@acme.test`, tenantId })).body.user;
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}
const base = (orgId: string): string => `/v1/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;

describe('territories — toggle gating', () => {
  it('404s every route when the toggle is off, then works when on', async () => {
    await enableTerritories('off');
    const { owner, orgId } = await ownerWithMember('admin');
    expect((await owner.get(`${base(orgId)}/models`)).status).toBe(404);
    await enableTerritories('on');
    expect((await owner.get(`${base(orgId)}/models`)).status).toBe(200);
  });
});

describe('territories — archived-model purge cascade (TERR-DATA-2)', () => {
  it('purges an archived model + all descendants; refuses planning/active models; admin-only', async () => {
    await enableTerritories('on');
    const { owner, member, orgId } = await ownerWithMember('editor'); // editor = workspace:write, NOT host:territories:manage
    const B = base(orgId);

    const type = (await owner.post(`${B}/types`, { name: 'Geo', priority: 5 })).body;
    const modelId = (await owner.post(`${B}/models`, { name: 'FY26' })).body.modelId;
    const terr = (await owner.post(`${B}/models/${modelId}/territories`, { name: 'West', territoryTypeId: type.territoryTypeId })).body;
    await owner.post(`${B}/models/${modelId}/rules`, { territoryId: terr.territoryId, target: 'deal', priority: 1, filter: { field: 'amount', op: 'gte', value: 0 } });
    expect((await owner.put(`${B}/models/${modelId}/territories/${terr.territoryId}/quota`, { period: '2026-Q1', amount: 1000, currency: 'USD' })).status).toBe(200);

    // A planning model is NOT purgeable → 409 (and it must NOT wipe the rows first).
    const tooEarly = await owner.del(`${B}/models/${modelId}`);
    expect(tooEarly.status, JSON.stringify(tooEarly.body)).toBe(409);
    expect((await owner.get(`${B}/models/${modelId}/rules`)).body.rules).toHaveLength(1); // rows survived the rejected purge
    expect((await owner.get(`${B}/models/${modelId}/quotas`)).body.quotas).toHaveLength(1);

    // Activate then archive → now purgeable. Activation rides the shared reviews
    // gate now (CFP-1 / D9) — submit-then-approve.
    expect((await transitionModelViaReview(owner, B, modelId)).status).toBe(200);
    const activeModel = (await owner.post(`${B}/models`, { name: 'other' })).body.modelId;
    expect((await transitionModelViaReview(owner, B, activeModel)).status).toBe(200); // archives the first
    expect((await owner.get(`${B}/models`)).body.models.find((m: any) => m.modelId === modelId).state).toBe('archived');

    // A member with only workspace:write cannot purge (host:territories:manage required).
    expect((await member.del(`${B}/models/${modelId}`)).status).toBe(403);

    // Admin owner purges → cascade removes territories + rules + quotas + the model row.
    const purge = await owner.del(`${B}/models/${modelId}`);
    expect(purge.status, JSON.stringify(purge.body)).toBe(200);
    expect(purge.body.removed).toBeGreaterThanOrEqual(4); // 1 territory + 1 rule + 1 quota + model row
    expect((await owner.get(`${B}/models`)).body.models.find((m: any) => m.modelId === modelId)).toBeUndefined();
    expect((await owner.get(`${B}/models/${modelId}/territories`)).status).toBe(404); // model + descendants gone
    expect((await owner.get(`${B}/models/${modelId}/rules`)).status).toBe(404);
  });
});

describe('territories — model + hierarchy CRUD + RBAC', () => {
  it('creates types/models/territories; enforces read/write scopes', async () => {
    await enableTerritories('on');
    const { owner, member, orgId } = await ownerWithMember('viewer');

    const type = await owner.post(`${base(orgId)}/types`, { name: 'Geographic', priority: 10 });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const model = await owner.post(`${base(orgId)}/models`, { name: 'FY26 Plan' });
    expect(model.status).toBe(201);
    expect(model.body.state).toBe('planning');
    const modelId = model.body.modelId;

    const west = await owner.post(`${base(orgId)}/models/${modelId}/territories`, { name: 'West', territoryTypeId: type.body.territoryTypeId });
    expect(west.status, JSON.stringify(west.body)).toBe(201);
    const cal = await owner.post(`${base(orgId)}/models/${modelId}/territories`, { name: 'California', parentTerritoryId: west.body.territoryId, memberSubjectIds: ['user:rep-a', 'user:rep-a'] });
    expect(cal.status).toBe(201);
    expect(cal.body.parentTerritoryId).toBe(west.body.territoryId);
    expect(cal.body.memberSubjectIds).toEqual(['user:rep-a']); // deduped

    // viewer member can read but not write
    expect((await member.get(`${base(orgId)}/models`)).status).toBe(200);
    expect((await member.post(`${base(orgId)}/models`, { name: 'X' })).status).toBe(403);
  });

  it('regionId (ADR 0282 §8 sales-map mapping): create, patch, clear, lowercased', async () => {
    await enableTerritories('on');
    const { owner, orgId } = await ownerWithMember('admin');
    const modelId = (await owner.post(`${base(orgId)}/models`, { name: 'Mapped' })).body.modelId;

    // Create with a region (mixed case in, lowercase stored).
    const emea = await owner.post(`${base(orgId)}/models/${modelId}/territories`, { name: 'EMEA North', regionId: 'DEU' });
    expect(emea.status, JSON.stringify(emea.body)).toBe(201);
    expect(emea.body.regionId).toBe('deu');

    // Create without one → absent, then PATCH it on.
    const t2 = await owner.post(`${base(orgId)}/models/${modelId}/territories`, { name: 'Enterprise Accounts' });
    expect(t2.body.regionId).toBeUndefined();
    const set = await owner.patch(`${base(orgId)}/models/${modelId}/territories/${t2.body.territoryId}`, { regionId: 'usa' });
    expect(set.status).toBe(200);
    expect(set.body.regionId).toBe('usa');

    // Empty string clears the mapping; omitting the key leaves it untouched.
    const kept = await owner.patch(`${base(orgId)}/models/${modelId}/territories/${t2.body.territoryId}`, { name: 'Enterprise' });
    expect(kept.body.regionId).toBe('usa');
    const cleared = await owner.patch(`${base(orgId)}/models/${modelId}/territories/${t2.body.territoryId}`, { regionId: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.regionId).toBeUndefined();
  });

  it('rejects a self-parenting cycle and cross-model parents', async () => {
    await enableTerritories('on');
    const { owner, orgId } = await ownerWithMember('admin');
    const modelId = (await owner.post(`${base(orgId)}/models`, { name: 'M' })).body.modelId;
    const a = await owner.post(`${base(orgId)}/models/${modelId}/territories`, { name: 'A' });
    const b = await owner.post(`${base(orgId)}/models/${modelId}/territories`, { name: 'B', parentTerritoryId: a.body.territoryId });
    // make A report to B → cycle
    const cyc = await owner.patch(`${base(orgId)}/models/${modelId}/territories/${a.body.territoryId}`, { parentTerritoryId: b.body.territoryId });
    expect(cyc.status).toBe(400);
    // self-parent
    expect((await owner.patch(`${base(orgId)}/models/${modelId}/territories/${a.body.territoryId}`, { parentTerritoryId: a.body.territoryId })).status).toBe(400);
    // parent in a different model → 404 (IDOR)
    const other = (await owner.post(`${base(orgId)}/models`, { name: 'Other' })).body.modelId;
    expect((await owner.post(`${base(orgId)}/models/${other}/territories`, { name: 'C', parentTerritoryId: a.body.territoryId })).status).toBe(404);
  });
});

describe('territories — observability', () => {
  it('emits an audit row on model activation (TERR-OBS-1)', async () => {
    await enableTerritories('on');
    const { owner, orgId } = await ownerWithMember('admin');
    const modelId = (await owner.post(`${base(orgId)}/models`, { name: 'Audit' })).body.modelId;
    await transitionModelViaReview(owner, base(orgId), modelId);
    // audit append is fire-and-forget → poll briefly for the row
    let rows: Array<{ action: string; resource?: string }> = [];
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      const all = await __hostExtStorage()!.listAudit({ actionPrefix: 'territory.model.activated', limit: 50 });
      rows = all.filter((r) => r.resource === `territory-model:${modelId}`);
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.action).toBe('territory.model.activated');
  });
});

describe('territories — lifecycle', () => {
  it('activates one model at a time, freezes it, archives the prior, and reserves activate to admin', async () => {
    await enableTerritories('on');
    const { owner, member, orgId } = await ownerWithMember('editor'); // editor has workspace:write but NOT host:territories:manage
    const m1 = (await owner.post(`${base(orgId)}/models`, { name: 'M1' })).body.modelId;
    const m2 = (await owner.post(`${base(orgId)}/models`, { name: 'M2' })).body.modelId;

    // CFP-1 (D9): activation rides the SHARED reviews gate now (org-wide blast
    // radius warrants a gate, not a click). editor can create/edit but cannot even
    // SUBMIT the transition (host:territories:manage on the submit route → 403).
    expect((await member.post(`${base(orgId)}/models/${m1}/activate`)).status).toBe(403);

    // A manager submits + approves through the reviews inbox; the model activates
    // only when the review is claimed (durable decision record).
    const act1 = await transitionModelViaReview(owner, base(orgId), m1);
    expect(act1.status, JSON.stringify(act1.body)).toBe(200);
    expect(act1.body.status).toBe('approved');
    expect((await owner.get(`${base(orgId)}/models/${m1}`)).body.state).toBe('active');
    expect((await owner.get(`${base(orgId)}/active`)).body.activeModelId).toBe(m1);

    // active model is frozen — no new territories
    expect((await owner.post(`${base(orgId)}/models/${m1}/territories`, { name: 'Nope' })).status).toBe(409);

    // activating m2 (through the gate) archives m1
    expect((await transitionModelViaReview(owner, base(orgId), m2)).status).toBe(200);
    expect((await owner.get(`${base(orgId)}/active`)).body.activeModelId).toBe(m2);
    expect((await owner.get(`${base(orgId)}/models/${m1}`)).body.state).toBe('archived');

    // archived model cannot be re-activated — the SUBMIT fails fast (409), no review
    // is queued (a resurrected review that could only fail on apply never exists).
    expect((await owner.post(`${base(orgId)}/models/${m1}/activate`)).status).toBe(409);

    // archive the active model (through the gate) clears the pointer
    expect((await transitionModelViaReview(owner, base(orgId), m2, 'archive')).status).toBe(200);
    expect((await owner.get(`${base(orgId)}/active`)).body.activeModelId).toBeNull();
  });

  it('two concurrent activations yield exactly one active model', async () => {
    await enableTerritories('on');
    const { owner, orgId } = await ownerWithMember('admin');
    const a = (await owner.post(`${base(orgId)}/models`, { name: 'A' })).body.modelId;
    const b = (await owner.post(`${base(orgId)}/models`, { name: 'B' })).body.modelId;
    // CFP-1 (D9): concurrency now lands at the APPROVE step — the handler's
    // activateModel pointer-CAS is the one-winner guard. Submit + approve both
    // concurrently; at most one active pointer survives.
    const [ra, rb] = await Promise.all([
      transitionModelViaReview(owner, base(orgId), a),
      transitionModelViaReview(owner, base(orgId), b),
    ]);
    const statuses = [ra.status, rb.status].sort();
    // one wins (200); the loser either 409 (lost the pointer CAS) or 200-then-archived
    expect(statuses[0]).toBe(200);
    const active = (await owner.get(`${base(orgId)}/active`)).body.activeModelId;
    expect([a, b]).toContain(active);
    // the non-active of the two is not also active
    const other = active === a ? b : a;
    expect((await owner.get(`${base(orgId)}/models/${other}`)).body.state).not.toBe('active');
    // invariant at the API surface: at most ONE model ever reports active (H1)
    const list = (await owner.get(`${base(orgId)}/models`)).body.models as Array<{ state: string }>;
    expect(list.filter((m) => m.state === 'active')).toHaveLength(1);
  });
});
