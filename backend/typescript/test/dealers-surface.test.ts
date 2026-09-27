/**
 * Dealer Network — Phase 3 (ctx.features.dealers surface + packs).
 * Surface: the governed write (approveRegistration) enforces the run owner's
 * host:dealers:manage; system run denied; reads open to tenant-scoped runs.
 * Packs: node + agent manifests validate; the write is side-effectful + kept out
 * of the advisory agent's allowlist; index.mjs exports the node functions.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildDealerSurface } from '../src/features/dealers/surface.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'dealers']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(withCookie = true) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (withCookie) for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
let n = 0;

describe('dealers P3 — governed surface write + reads', () => {
  it('approveRegistration requires the run owner host:dealers:manage; system run denied', async () => {
    const tenantId = `org:dsurf-${Date.now()}-${n++}`;
    const owner = client();
    const ownerId = (await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const editor = client();
    const editorId = (await editor.post('/v1/host/openwop-app/test/login', { email: `e-${Date.now()}-${n++}@acme.test`, tenantId })).body.user.userId;
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorId, roles: ['editor'] });
    const B = `/v1/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;
    const companyId = (await owner.post(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'DCo' })).body.companyId;
    const dealerId = (await owner.post(`${B}/dealers`, { name: 'D', companyId })).body.dealerId;
    const token = (await owner.post(`${B}/dealers/${dealerId}/portal-token`)).body.token;
    await client(false).post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'X', companyName: 'Y' });
    const regId = (await owner.get(`${B}/registrations`)).body.registrations[0].regId;

    const surfaceFor = (actingUserId?: string) => buildDealerSurface({ tenantId, ...(actingUserId ? { actingUserId } : {}), runId: `run-${n++}` });
    // reads are open
    expect((await surfaceFor(editorId).listDealers!({ orgId })).dealers).toHaveLength(1);
    // approve — editor (no manage) DENIED, system run DENIED, owner SUCCEEDS
    await expect(surfaceFor(editorId).approveRegistration!({ orgId, regId })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(surfaceFor(undefined).approveRegistration!({ orgId, regId })).rejects.toMatchObject({ code: 'forbidden_scope' });
    const out = await surfaceFor(ownerId).approveRegistration!({ orgId, regId }) as { registration: { status: string } };
    expect(out.registration.status).toBe('approved');
  });
});

const REPO_ROOT = join(__dirname, '..', '..', '..');
const NODES_DIR = join(REPO_ROOT, 'packs', 'feature.dealers.nodes');
const AGENTS_DIR = join(REPO_ROOT, 'packs', 'feature.dealers.agents');
interface NodesManifest { name: string; nodes: Array<{ typeId: string; role: string; capabilities: string[] }>; runtime: { entry: string } }
interface AgentsManifest { agents: Array<{ toolAllowlist: string[] }> }

describe('feature.dealers.nodes pack', () => {
  const manifest = JSON.parse(readFileSync(join(NODES_DIR, 'pack.json'), 'utf8')) as NodesManifest;
  it('declares 3 read + 1 governed (side-effectful) write node', () => {
    expect(manifest.name).toBe('feature.dealers.nodes');
    expect(manifest.nodes).toHaveLength(4);
    for (const node of manifest.nodes) expect(node.role, node.typeId).toBe('action');
    expect(manifest.nodes.filter((x) => x.capabilities.includes('side-effectful')).map((x) => x.typeId)).toEqual(['feature.dealers.nodes.approve-registration']);
  });
  it('index.mjs exports every node handler', async () => {
    const mod = (await import(pathToFileURL(join(NODES_DIR, manifest.runtime.entry)).href)) as Record<string, unknown>;
    for (const fn of ['listDealers', 'listOutlets', 'listRegistrations', 'approveRegistration']) expect(typeof mod[fn], fn).toBe('function');
  });
});

describe('feature.dealers.agents pack', () => {
  const manifest = JSON.parse(readFileSync(join(AGENTS_DIR, 'pack.json'), 'utf8')) as AgentsManifest;
  it('the advisory Channel Manager is allowlisted to READS only', () => {
    const allow = manifest.agents[0].toolAllowlist;
    expect(allow).toContain('openwop:dealers.list-registrations');
    expect(allow).not.toContain('openwop:dealers.approve-registration');
  });
});
