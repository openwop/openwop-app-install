/**
 * ADR 0959 P5 — the read-only workflow surface `ctx.features['campaign-playbooks']` (behind the
 * `feature.campaign-playbooks.nodes` pack) and the installation matrix the Playbooks tab reads.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the run-stamp client check removed from `bindPlaybookRun`        → "a run stamped for client A"
 *  - `bindRunToClient` dropped (no person / scope check)               → "no person behind the run"
 *  - layer 1 left out of `effectiveConfig`                             → "the effective values"
 *  - the matrix ignoring the playbook id (every installation listed)  → "lists every client"
 *
 * Single guard (checked): `bindRunToClient` also refuses `wrong_client`, but it reads the
 * campaign-ops run stamp, not the playbook stamp, so `bindPlaybookRun`'s check is the only guard
 * on this path. The matrix fixture carries a SECOND playbook installed on client 0, so the
 * playbook filter in `listPlaybookInstallations` has a row to exclude.
 *
 * Probes (wave 73, all witnessed): w73g3-pb5-wrong-client, -no-person, -effective-layer1,
 * -matrix-drift; w73g3-pb5-matrix-filter (the second-playbook exclusion).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { buildCampaignPlaybooksSurface } from '../src/features/campaign-playbooks/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { bareRunId } from './support/bareRunId.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let TENANT = '';
let adminId = '';
let cookie = '';
const orgs: string[] = [];

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: parsed };
}
/** Walk an untyped JSON body without casts. */
const get = (b: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined), b);
const rowsOf = (b: unknown, key: string): unknown[] => { const r = get(b, key); if (!Array.isArray(r)) throw new Error(`${key} is not an array: ${JSON.stringify(b)}`); return r; };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['campaign-ops', 'campaign-playbooks']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  const tag = randomBytes(3).toString('hex');
  TENANT = (await createWorkspace({ name: 'Agency', ownerSubject: `oidc:pb5-owner-${tag}` })).tenantId;
  const admin = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:pb5-admin-${tag}`, source: 'oidc' });
  adminId = admin.userId;
  await createMember({ tenantId: TENANT, orgId: TENANT, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
  for (let i = 0; i < 2; i++) {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: `Client ${i} (synthetic)` })).orgId;
    await createMember({ tenantId: TENANT, orgId, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
    await createClient({ tenantId: TENANT, orgId, name: `Client ${i} (synthetic)`, createdBy: 'seed' });
    orgs.push(orgId);
  }
  const now = Math.floor(Date.now() / 1000);
  cookie = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId: admin.userId, personalTenant: `ws:home-${admin.userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  const base = '/host/openwop-app/campaign-playbooks';
  expect((await call('PUT', `${base}/playbooks/method/draft`, {
    title: 'Method', entryChainId: 'acme.m', defaults: { params: { tone: 'warm' } }, overridable: { params: ['region', 'tone'], slots: [] },
    chains: [{ chainId: 'acme.m', version: '1.0.0', label: 'M', description: 'Synthetic.', parameters: { type: 'object', properties: { region: { type: 'string' }, tone: { type: 'string' } } }, dag: { nodes: [{ id: 'n', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { region: '{{params.region}}' } }], edges: [] } }],
  })).status).toBe(200);
  expect((await call('POST', `${base}/playbooks/method/versions`, { version: '1.0.0' })).status).toBe(201);
  expect((await call('PUT', `${base}/playbooks/method/agency-layer`, { params: { tone: 'bold' } })).status).toBe(200);
  for (const [i, org] of orgs.entries()) expect((await call('POST', `${base}/clients/${org}/installs`, { playbookId: 'method', version: '1.0.0', clientLayer: { params: { region: `R${i}` } } })).status).toBe(201);
  // A second playbook on client 0 only: the matrix for `method` must not list it.
  expect((await call('PUT', `${base}/playbooks/other/draft`, {
    title: 'Other', entryChainId: 'acme.o', defaults: { params: {} }, overridable: { params: [], slots: [] },
    chains: [{ chainId: 'acme.o', version: '1.0.0', label: 'O', description: 'Synthetic.', parameters: { type: 'object', properties: {} }, dag: { nodes: [{ id: 'n', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: {} }], edges: [] } }],
  })).status).toBe(200);
  expect((await call('POST', `${base}/playbooks/other/versions`, { version: '1.0.0' })).status).toBe(201);
  expect((await call('POST', `${base}/clients/${orgs[0]}/installs`, { playbookId: 'other', version: '1.0.0' })).status).toBe(201);
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0959 P5 — the installation matrix', () => {
  it('lists every client on a playbook with its drift (agency admin)', async () => {
    const r = await call('GET', '/host/openwop-app/campaign-playbooks/playbooks/method/installations');
    expect(r.status).toBe(200);
    const rows = rowsOf(r.body, 'installations');
    expect(rows.map((x) => get(x, 'orgId')).sort()).toEqual([...orgs].sort());
    expect(rows.map((x) => get(x, 'playbookId'))).toEqual(['method', 'method']); // `other` (client 0) is not listed
    expect(rows.every((x) => get(x, 'drift') === 'none' && get(x, 'pinnedVersion') === '1.0.0')).toBe(true);
  });
});

describe('ADR 0959 P5 — ctx.features[campaign-playbooks]', () => {
  const scopeFor = (extra: Omit<BundleScope, 'tenantId'>): BundleScope => ({ tenantId: TENANT, ...extra });

  it('the effective values: defaults, then the agency, then the client', async () => {
    const s = buildCampaignPlaybooksSurface(scopeFor({ actingUserId: adminId }));
    expect(await s.effectiveConfig!({ orgId: orgs[0], playbookId: 'method' })).toMatchObject({ version: '1.0.0', params: { tone: 'bold', region: 'R0' } });
    expect(await s.getInstallation!({ orgId: orgs[0], playbookId: 'method' })).toMatchObject({ installed: true, version: '1.0.0', ring: 'general' });
  });

  it('no person behind the run is refused', async () => {
    const s = buildCampaignPlaybooksSurface(scopeFor({}));
    await expect(s.getInstallation!({ orgId: orgs[0], playbookId: 'method' })).rejects.toMatchObject({ details: { reason: 'no_acting_user' } });
  });

  it('a run stamped for client A cannot read client B', async () => {
    const installs = rowsOf((await call('GET', `/host/openwop-app/campaign-playbooks/clients/${orgs[0]}/installs`)).body, 'installations');
    const wf = get(installs.find((i) => get(i, 'playbookId') === 'method'), 'workflowId');
    if (typeof wf !== 'string' || !wf) throw new Error('no method install on client 0');
    const run = await call('POST', '/runs', { workflowId: wf, inputs: {} });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const runId = bareRunId(String(get(run.body, 'runId')));
    expect((await storage.getRun(runId))?.metadata['openwop-app.playbook']).toMatchObject({ orgId: orgs[0] });
    const s = buildCampaignPlaybooksSurface(scopeFor({ actingUserId: adminId, runId }));
    expect(await s.getInstallation!({ orgId: orgs[0], playbookId: 'method' })).toMatchObject({ installed: true });
    await expect(s.getInstallation!({ orgId: orgs[1], playbookId: 'method' })).rejects.toMatchObject({ details: { reason: 'wrong_client' } });
  });
});
