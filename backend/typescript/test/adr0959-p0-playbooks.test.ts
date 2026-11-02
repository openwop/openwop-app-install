/**
 * ADR 0959 P0 — agency playbooks: drafts, immutable versions, the one-client install, and the
 * run stamp, through the HTTP boundary (createApp + signed session cookies).
 *
 * Exit criteria (ADR 0959 phase table, P0): an install expands, registers, records a revision
 * and ownership; republishing an existing version is refused; a client-B install is invisible
 * to a client-A operator (uniform 404).
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - `publishVersion` writing with `put` instead of `putIfAbsent` + the existence check   → "immutable"
 *  - `parseClientLayer` accepting any key                                                  → "overridable"
 *  - the install route skipping `getClient` (any org)                                      → "not a client"
 *  - `listInstallations` reading the tenant slice instead of the org prefix                → "client A … 404"
 *  - the contributor ignoring `derivedFromRun`                                             → "a fork"
 *  - `openwop-app.playbook` dropped from RESERVED_RUN_METADATA_KEYS                        → "a caller cannot forge"
 *  - the campaign-ops toggle check removed from `requireAgencyAdmin`                      → "both toggles"
 *
 * Every case seeds what it needs (its own playbook id via `seedPublished` / `seedInstalled`),
 * so the file passes in any order: wave 73 found five cases chained through one `local-launch`
 * install and one shared `workflowId`. Refusals assert the exact `error` + `details`.
 *
 * DOUBLE GUARD (recorded): version immutability is held by the `prior.version === version`
 * existence check AND the semver not-newer check (plus `putIfAbsent`). "immutable" pins the
 * first by its REASON (`playbook_version_exists`; the second answers `playbook_version_not_newer`).
 *
 * Probes (wave 73, all witnessed): w73g3-pb0-immutable, -overridable, -notclient, -list-scope,
 * -fork, -reserved, -ops-toggle, -admin.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import { listRevisions } from '../src/host/workflowRevisions.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { bareRunId } from './support/bareRunId.js';
import { playbookRunStampContributor } from '../src/features/campaign-playbooks/runStamp.js';

let BASE = '';
let storage: import('../src/storage/storage.js').Storage;
let server: http.Server;
let TENANT = '';
let orgA = '';
let orgB = '';
let notClient = '';
const cookies: Record<'admin' | 'opA', string> = { admin: '', opA: '' };

interface Res { status: number; body: unknown }
/** Walk an untyped JSON body without casts. */
const get = (b: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined), b);
const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(`${what} is not a string: ${JSON.stringify(v)}`); return v; };
const arr = (v: unknown, what: string): unknown[] => { if (!Array.isArray(v)) throw new Error(`${what} is not an array: ${JSON.stringify(v)}`); return v; };
async function call(who: 'admin' | 'opA', method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: { cookie: cookies[who], ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}
async function raw(method: string, path: string, body?: unknown, cookie = cookies.admin): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}

const chain = (version = '1.0.0') => ({
  chainId: 'acme.local-launch',
  version,
  label: 'Local launch',
  description: 'A synthetic two-step method.',
  parameters: {
    type: 'object',
    required: ['region'],
    properties: { region: { type: 'string', minLength: 1 }, tone: { type: 'string' } },
    additionalProperties: false,
  },
  dag: {
    nodes: [
      { id: 'start', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { region: '{{params.region}}' } },
      { id: 'finish', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { tone: '{{params.tone}}' } },
    ],
    edges: [{ from: 'start', to: 'finish' }],
  },
});
const draftBody = (overrides: Record<string, unknown> = {}) => ({
  title: 'Local-service launch',
  chains: [chain()],
  entryChainId: 'acme.local-launch',
  defaults: { params: { tone: 'warm' } },
  overridable: { params: ['region', 'tone'] },
  changelog: 'First version.',
  ...overrides,
});

let seq = 0;
/** A playbook of this case's own (draft + published 1.0.0), so no case reads another's state. */
async function seedPublished(base = 'local-launch', overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `${base}-${(++seq).toString(36)}`;
  const d = await call('admin', 'PUT', `/campaign-playbooks/playbooks/${id}/draft`, draftBody(overrides));
  if (d.status !== 200) throw new Error(`draft ${id}: ${d.status} ${JSON.stringify(d.body)}`);
  const v = await call('admin', 'POST', `/campaign-playbooks/playbooks/${id}/versions`, { version: '1.0.0' });
  if (v.status !== 201) throw new Error(`publish ${id}: ${v.status} ${JSON.stringify(v.body)}`);
  return id;
}
async function seedInstalled(orgId: string, region: string): Promise<{ playbookId: string; workflowId: string }> {
  const playbookId = await seedPublished();
  const r = await call('admin', 'POST', `/campaign-playbooks/clients/${orgId}/installs`, { playbookId, version: '1.0.0', clientLayer: { params: { region } } });
  if (r.status !== 201) throw new Error(`install ${playbookId} on ${orgId}: ${r.status} ${JSON.stringify(r.body)}`);
  return { playbookId, workflowId: str(get(r.body, 'installation', 'workflowId'), 'installation.workflowId') };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['campaign-ops', 'campaign-orchestration', 'campaign-playbooks']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const tag = randomBytes(3).toString('hex');
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: `oidc:pb-owner-${tag}` })).tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:pb-admin-${tag}`, source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  const op = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:pb-op-${tag}`, source: 'oidc' });
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: op.userId, displayName: 'Operator', roles: ['viewer'] });
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A (synthetic)' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B (synthetic)' })).orgId;
  notClient = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Internal team (synthetic)' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: op.userId, displayName: 'Operator', roles: ['editor'] });
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A (synthetic)', createdBy: 'seed' });
  await createClient({ tenantId: TENANT, orgId: orgB, name: 'Client B (synthetic)', createdBy: 'seed' });
  const now = Math.floor(Date.now() / 1000);
  const sign = (userId: string) => `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId, personalTenant: `ws:home-${userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  cookies.admin = sign(admin.userId);
  cookies.opA = sign(op.userId);
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0959 P0 — drafts and immutable versions', () => {
  it('a draft is validated by the loader\'s own rules', async () => {
    const bad = await call('admin', 'PUT', '/campaign-playbooks/playbooks/local-launch/draft', draftBody({ chains: [{ ...chain(), dag: { nodes: [{ id: 'x', typeId: 'core.flow.noop', config: {}, inputs: {} }], edges: [] } }] }));
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('workflow_chain_unpinned');
    // P1 (D2): a sub-chain is accepted in a draft; publishing refuses one that does not resolve.
    const sub = await call('admin', 'PUT', '/campaign-playbooks/playbooks/dangling/draft', draftBody({ chains: [{ ...chain(), subChains: [{ ref: 'acme.other' }], dag: { nodes: [{ id: 'x', typeId: 'core.subWorkflow@1.0.0', config: { subChainRef: 'acme.other' }, inputs: {} }], edges: [] } }] }));
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const subPub = await call('admin', 'POST', '/campaign-playbooks/playbooks/dangling/versions', { version: '1.0.0' });
    expect(subPub.status).toBe(422);
    expect(subPub.body).toMatchObject({ details: { code: 'sub_chain_unresolved', ref: 'acme.other' } });
    const ok = await call('admin', 'PUT', '/campaign-playbooks/playbooks/local-launch/draft', draftBody());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('only an agency admin authors', async () => {
    const r = await call('opA', 'PUT', '/campaign-playbooks/playbooks/local-launch/draft', draftBody());
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'forbidden_scope', details: { requiredScope: 'host:members:manage' } });
  });

  it('a published version is immutable: republishing it is refused, a lower one too', async () => {
    const id = `local-launch-imm-${(++seq).toString(36)}`;
    expect((await call('admin', 'PUT', `/campaign-playbooks/playbooks/${id}/draft`, draftBody())).status).toBe(200);
    const v1 = await call('admin', 'POST', `/campaign-playbooks/playbooks/${id}/versions`, { version: '1.0.0' });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    const hash1 = str(get(v1.body, 'version', 'contentHash'), 'version.contentHash');
    expect(hash1).toMatch(/^sha256:[0-9a-f]{64}$/);
    await call('admin', 'PUT', `/campaign-playbooks/playbooks/${id}/draft`, draftBody({ changelog: 'Changed after publishing.' }));
    const again = await call('admin', 'POST', `/campaign-playbooks/playbooks/${id}/versions`, { version: '1.0.0' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ details: { reason: 'playbook_version_exists' } });
    const lower = await call('admin', 'POST', `/campaign-playbooks/playbooks/${id}/versions`, { version: '0.9.0' });
    expect(lower.status).toBe(409);
    const listed = await call('admin', 'GET', `/campaign-playbooks/playbooks/${id}/versions`);
    const versions = arr(get(listed.body, 'versions'), 'versions');
    expect(versions.map((v) => get(v, 'version'))).toEqual(['1.0.0']);
    expect(versions[0]).toMatchObject({ contentHash: hash1, changelog: 'First version.' });
  });
});

describe('ADR 0959 P0 — install for one client', () => {
  it('a client value must be overridable, and the merged values must satisfy the chain', async () => {
    const strict = await seedPublished('strict', { overridable: { params: ['region'] } });
    const notAllowed = await call('admin', 'POST', `/campaign-playbooks/clients/${orgA}/installs`, { playbookId: strict, version: '1.0.0', clientLayer: { params: { region: 'Austin', tone: 'loud' } } });
    expect(notAllowed.status).toBe(400);
    expect(notAllowed.body).toMatchObject({ details: { reason: 'playbook_key_not_overridable', key: 'tone' } });
    const missing = await call('admin', 'POST', `/campaign-playbooks/clients/${orgA}/installs`, { playbookId: strict, version: '1.0.0' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ details: { reason: 'playbook_params_invalid' } });
  });

  it('an org that is not a client is a 404', async () => {
    const playbookId = await seedPublished();
    const r = await call('admin', 'POST', `/campaign-playbooks/clients/${notClient}/installs`, { playbookId, version: '1.0.0', clientLayer: { params: { region: 'Austin' } } });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: 'not_found', message: 'Client not found.', details: { orgId: notClient } });
  });

  it('install expands, registers, records a revision and ownership, with the client\'s values', async () => {
    const playbookId = await seedPublished();
    const r = await call('admin', 'POST', `/campaign-playbooks/clients/${orgA}/installs`, { playbookId, version: '1.0.0', clientLayer: { params: { region: 'Austin' } } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const inst = get(r.body, 'installation');
    expect(inst).toMatchObject({ status: 'installed', pinnedVersion: '1.0.0' });
    const workflowId = str(get(inst, 'workflowId'), 'installation.workflowId');
    const def = await getRegisteredWorkflowAsync(workflowId);
    expect(def, 'registered').toBeTruthy();
    expect(JSON.stringify(def!.nodes)).toContain('Austin'); // layer 2
    expect(JSON.stringify(def!.nodes)).toContain('warm'); // layer 0
    const owned = await getOwned(TENANT, workflowId);
    expect(owned).toMatchObject({ subject: `campaign-playbooks:${orgA}:${playbookId}` });
    const revs = await listRevisions(workflowId);
    expect(revs.map((x) => x.revisionHash)).toContain(str(get(inst, 'expectedRevision'), 'installation.expectedRevision'));
    expect(arr(get(inst, 'history'), 'installation.history')).toHaveLength(1);
    const again = await call('admin', 'POST', `/campaign-playbooks/clients/${orgA}/installs`, { playbookId, version: '1.0.0', clientLayer: { params: { region: 'Dallas' } } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ details: { reason: 'playbook_already_installed' } });
  });

  it('client A\'s operator sees A\'s installs; client B\'s are a 404 to them', async () => {
    const a = await seedInstalled(orgA, 'Austin');
    const b = await seedInstalled(orgB, 'Boston');
    const mine = await call('opA', 'GET', `/campaign-playbooks/clients/${orgA}/installs`);
    expect(mine.status).toBe(200);
    const rows = arr(get(mine.body, 'installations'), 'installations');
    // Every row is client A's (other cases install on A too, so the list is not just this case's);
    // this case's A install is present and its B install is not.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((i) => get(i, 'orgId') === orgA)).toBe(true);
    expect(rows.map((i) => get(i, 'playbookId'))).toContain(a.playbookId);
    expect(rows.map((i) => get(i, 'workflowId'))).not.toContain(b.workflowId);
    const theirs = await call('opA', 'GET', `/campaign-playbooks/clients/${orgB}/installs`);
    expect(theirs.status).toBe(404);
    const nobody = await call('opA', 'GET', `/campaign-playbooks/clients/${notClient}/installs`);
    expect(nobody.status).toBe(404);
  });

  it('a run of the installed workflow names the playbook version; a caller cannot forge it', async () => {
    const { playbookId, workflowId } = await seedInstalled(orgA, 'Austin');
    const run = await raw('POST', '/runs', { workflowId, inputs: {}, metadata: { 'openwop-app.playbook': { playbookId: 'forged' } } });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    // The HOST metadata (the snapshot's `metadata` is the caller's own bag, echoed).
    const hostMeta = async (id: string): Promise<Record<string, unknown>> => (await storage.getRun(bareRunId(id)))?.metadata ?? {};
    const meta = await hostMeta(str(get(run.body, 'runId'), 'runId'));
    expect(meta['openwop-app.playbook']).toMatchObject({ playbookId, version: '1.0.0', orgId: orgA, drift: 'none' });
    // Any other workflow: the forged stamp is stripped, and nothing is stamped.
    const other = await raw('POST', '/runs', { workflowId: 'openwop-app.uppercase', inputs: { text: 'x' }, metadata: { 'openwop-app.playbook': { playbookId: 'forged' } } });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    expect((await hostMeta(str(get(other.body, 'runId'), 'runId')))['openwop-app.playbook']).toBeUndefined();
  });

  it('both toggles gate every route: campaign-ops off refuses an install', async () => {
    const playbookId = await seedPublished();
    const ops = getToggleDefault('campaign-ops')!;
    await saveConfig({ ...ops, status: 'off' }, 'test');
    try {
      const r = await call('admin', 'GET', '/campaign-playbooks/playbooks');
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ error: 'not_found', details: { feature: 'campaign-ops' } });
      const i = await call('admin', 'POST', `/campaign-playbooks/clients/${orgA}/installs`, { playbookId, version: '1.0.0', clientLayer: { params: { region: 'X' } } });
      expect(i.status).toBe(404);
      expect(i.body).toMatchObject({ error: 'not_found', details: { feature: 'campaign-ops' } });
    } finally { await saveConfig({ ...ops, status: 'on' }, 'test'); }
  });

  it('a fork contributes nothing (the copied stamp is authoritative)', async () => {
    const { workflowId } = await seedInstalled(orgA, 'Austin');
    expect(await playbookRunStampContributor({ tenantId: TENANT, workflowId, derivedFromRun: true })).toEqual({});
    expect(await playbookRunStampContributor({ tenantId: TENANT, workflowId, metadata: {} })).toMatchObject({ 'openwop-app.playbook': { drift: 'unknown' } });
    expect(await playbookRunStampContributor({ tenantId: TENANT, workflowId, metadata: { definitionRevision: 'sha256:edited' } })).toMatchObject({ 'openwop-app.playbook': { drift: 'edited' } });
  });
});
