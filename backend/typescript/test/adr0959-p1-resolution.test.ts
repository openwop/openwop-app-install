/**
 * ADR 0959 P1 — versioned sub-chain resolution (D2), slots and layered overrides (D3), and
 * drift detection, through the HTTP boundary.
 *
 * Exit criterion (ADR 0959 phase table, P1): a playbook pinning `child@1.0.0` still resolves
 * `@1.0.0` after `@2.0.0` is installed globally.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the playbook resolution dropping `resolveSibling` (the global registry answers)      → "still resolves @1.0.0"
 *  - the host-pack branch ignoring the version                                             → "a host pack at a version it does not have"
 *  - `getVersion` reading any tenant's version (a cross-tenant scan)                      → "another workspace's playbook"
 *  - the slot binding ignored by the resolver                                              → "a slot binding"
 *  - layer 1 dropped from `mergeLayers`                                                    → "the agency layer"
 *  - `installationDrift` comparing nothing (always `none`)                                → "drift"
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { getRegisteredWorkflowAsync, registerWorkflowDurable } from '../src/host/workflowsRegistry.js';
import { getChain, loadWorkflowChainPacks, mintChildWorkflowId } from '../src/host/workflowChainPackLoader.js';

let BASE = '';
let server: http.Server;
const ws: Record<'a' | 'b', { tenant: string; cookie: string; orgs: string[] }> = { a: { tenant: '', cookie: '', orgs: [] }, b: { tenant: '', cookie: '', orgs: [] } };

interface Res { status: number; body: Record<string, unknown> }
async function call(who: 'a' | 'b', method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, { method, headers: { cookie: ws[who].cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const params = { type: 'object', properties: { region: { type: 'string' }, tone: { type: 'string' } }, additionalProperties: false };
/** A chain whose one node carries a marker the expanded definition shows. */
const leaf = (chainId: string, version: string, marker: string) => ({
  chainId, version, label: chainId, description: 'A synthetic leaf.', parameters: { type: 'object', properties: {} },
  dag: { nodes: [{ id: 'leaf', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { marker } }], edges: [] },
});
/** A parent that composes `ref` (sibling string, or an external object). */
const parent = (ref: string | { packName: string; chainId: string; version: string }) => ({
  chainId: 'acme.parent', version: '1.0.0', label: 'Parent', description: 'Composes a child.', parameters: params,
  subChains: [{ ref }],
  dag: {
    nodes: [
      { id: 'start', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { region: '{{params.region}}', tone: '{{params.tone}}' } },
      { id: 'child', typeId: 'core.subWorkflow@1.0.0', config: { subChainRef: typeof ref === 'string' ? ref : ref.chainId }, inputs: {} },
    ],
    edges: [{ from: 'start', to: 'child' }],
  },
});
async function publish(who: 'a' | 'b', id: string, body: Record<string, unknown>, version = '1.0.0'): Promise<Res> {
  const d = await call(who, 'PUT', `/campaign-playbooks/playbooks/${id}/draft`, { title: id, changelog: '', defaults: { params: {} }, overridable: { params: [], slots: [] }, ...body });
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  return call(who, 'POST', `/campaign-playbooks/playbooks/${id}/versions`, { version });
}
async function install(org: string, playbookId: string, clientLayer?: unknown): Promise<Res> {
  return call('a', 'POST', `/campaign-playbooks/clients/${org}/installs`, { playbookId, version: '1.0.0', ...(clientLayer ? { clientLayer } : {}) });
}
const workflowOf = (r: Res): string => (r.body.installation as { workflowId: string }).workflowId;
async function childDefsOf(workflowId: string): Promise<string> {
  const def = await getRegisteredWorkflowAsync(workflowId);
  const childIds = (def?.nodes ?? []).map((n) => (n.config as { workflowId?: string } | undefined)?.workflowId).filter((x): x is string => !!x);
  const children = await Promise.all(childIds.map((id) => getRegisteredWorkflowAsync(id)));
  return JSON.stringify({ childIds, children });
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['campaign-ops', 'campaign-playbooks']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  // The host has `acme.child` at 2.0.0 (a chain pack in the GLOBAL registry).
  const root = mkdtempSync(join(tmpdir(), 'pb-p1-'));
  mkdirSync(join(root, 'child'));
  writeFileSync(join(root, 'child', 'pack.json'), JSON.stringify({ name: 'community.pbtest.child', version: '2.0.0', kind: 'workflow-chain', engines: { openwop: '>=1.0.0 <3.0.0' }, chains: [leaf('acme.child', '2.0.0', 'host-v2')] }));
  const loaded = loadWorkflowChainPacks({ roots: [root] });
  expect(loaded.errors.filter((e) => e.pack.includes('pbtest')), JSON.stringify(loaded.errors)).toEqual([]);
  expect(getChain('acme.child')?.chain.version).toBe('2.0.0');
  for (const k of ['a', 'b'] as const) {
    const tag = randomBytes(3).toString('hex');
    ws[k].tenant = (await createWorkspace({ name: `Agency ${k}`, ownerSubject: `oidc:pb1-owner-${k}-${tag}` })).tenantId;
    const admin = await upsertFromPrincipal({ tenantId: ws[k].tenant, principalId: `oidc:pb1-admin-${k}-${tag}`, source: 'oidc' });
    await createMember({ tenantId: ws[k].tenant, orgId: ws[k].tenant, subject: admin.userId, displayName: 'Admin', roles: ['admin'] });
    for (let i = 0; i < 6; i++) {
      const orgId = (await createOrg({ tenantId: ws[k].tenant, createdBy: 'seed', name: `Client ${i} (synthetic)` })).orgId;
      await createClient({ tenantId: ws[k].tenant, orgId, name: `Client ${i} (synthetic)`, createdBy: 'seed' });
      ws[k].orgs.push(orgId);
    }
    const now = Math.floor(Date.now() / 1000);
    ws[k].cookie = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: ws[k].tenant, tier: 'user', userId: admin.userId, personalTenant: `ws:home-${admin.userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  }
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0959 D2 — versioned sub-chain resolution', () => {
  it('a playbook pinning child@1.0.0 still resolves @1.0.0 after @2.0.0 is installed globally', async () => {
    const pub = await publish('a', 'pinned', { chains: [parent('acme.child'), leaf('acme.child', '1.0.0', 'playbook-v1')], entryChainId: 'acme.parent' });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const r = await install(ws.a.orgs[0]!, 'pinned');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const children = await childDefsOf(workflowOf(r));
    expect(children).toContain('playbook-v1');
    expect(children).not.toContain('host-v2');
    // Minted per playbook version, not the host's shared (tenant, chainId, version) child.
    expect(children).not.toContain(mintChildWorkflowId(ws.a.tenant, 'acme.child', '1.0.0'));
    // Two clients on the same version share the child (D4).
    const r2 = await install(ws.a.orgs[1]!, 'pinned');
    expect(JSON.parse(await childDefsOf(workflowOf(r2))).childIds).toEqual(JSON.parse(children).childIds);
  });

  it('a host pack at a version it does not have is refused; at the loaded version it resolves', async () => {
    const missing = await publish('a', 'host-old', { chains: [parent({ packName: 'community.pbtest.child', chainId: 'acme.child', version: '1.0.0' })], entryChainId: 'acme.parent' });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ details: { code: 'sub_chain_unresolved' } });
    const wrongPack = await publish('a', 'host-other', { chains: [parent({ packName: 'community.someone-else', chainId: 'acme.child', version: '2.0.0' })], entryChainId: 'acme.parent' });
    expect(wrongPack.status).toBe(422);
    const ok = await publish('a', 'host-ok', { chains: [parent({ packName: 'community.pbtest.child', chainId: 'acme.child', version: '2.0.0' })], entryChainId: 'acme.parent' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const r = await install(ws.a.orgs[2]!, 'host-ok');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await childDefsOf(workflowOf(r))).toContain('host-v2');
  });

  it('a ref to another playbook resolves in this workspace; another workspace\'s playbook never does', async () => {
    expect((await publish('a', 'lib', { chains: [leaf('lib.step', '1.0.0', 'lib-a')], entryChainId: 'lib.step' })).status).toBe(201);
    expect((await publish('b', 'lib-b', { chains: [leaf('lib.step', '1.0.0', 'lib-b')], entryChainId: 'lib.step' })).status).toBe(201);
    const own = await publish('a', 'uses-lib', { chains: [parent({ packName: 'playbook:lib', chainId: 'lib.step', version: '1.0.0' })], entryChainId: 'acme.parent' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const r = await install(ws.a.orgs[3]!, 'uses-lib');
    expect(await childDefsOf(workflowOf(r))).toContain('lib-a');
    const foreign = await publish('a', 'uses-foreign', { chains: [parent({ packName: 'playbook:lib-b', chainId: 'lib.step', version: '1.0.0' })], entryChainId: 'acme.parent' });
    expect(foreign.status).toBe(422);
  });
});

describe('ADR 0959 D3 — slots and layers', () => {
  it('a slot binding swaps the child for one client; an undeclared or locked slot is refused', async () => {
    expect((await publish('a', 'alt', { chains: [leaf('alt.step', '1.0.0', 'client-own')], entryChainId: 'alt.step' })).status).toBe(201);
    const slotted = await publish('a', 'slotted', {
      chains: [parent('acme.child'), leaf('acme.child', '1.0.0', 'default-step')],
      entryChainId: 'acme.parent',
      slots: [{ ref: 'acme.child', label: 'Follow-up step' }],
      overridable: { params: ['region'], slots: ['acme.child'] },
    });
    expect(slotted.status, JSON.stringify(slotted.body)).toBe(201);
    const bound = await install(ws.a.orgs[4]!, 'slotted', { params: { region: 'Austin' }, slots: { 'acme.child': { playbookId: 'alt', version: '1.0.0', chainId: 'alt.step' } } });
    expect(bound.status, JSON.stringify(bound.body)).toBe(201);
    const kids = await childDefsOf(workflowOf(bound));
    expect(kids).toContain('client-own');
    expect(kids).not.toContain('default-step');
    const unknown = await install(ws.a.orgs[5]!, 'slotted', { slots: { 'not.a.slot': { playbookId: 'alt', version: '1.0.0', chainId: 'alt.step' } } });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ details: { reason: 'playbook_key_not_overridable' } });
    const dangling = await install(ws.a.orgs[5]!, 'slotted', { slots: { 'acme.child': { playbookId: 'alt', version: '9.9.9', chainId: 'alt.step' } } });
    expect(dangling.status).toBe(422);
    expect(dangling.body).toMatchObject({ details: { code: 'sub_chain_unresolved' } });
  });

  it('the agency layer applies to every client, and a client value wins over it', async () => {
    const pub = await publish('a', 'layered', { chains: [{ ...leaf('acme.layered', '1.0.0', 'x'), parameters: params, dag: { nodes: [{ id: 'n', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { region: '{{params.region}}', tone: '{{params.tone}}' } }], edges: [] } }], entryChainId: 'acme.layered', defaults: { params: { tone: 'warm' } }, overridable: { params: ['region', 'tone'], slots: [] } });
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const set = await call('a', 'PUT', '/campaign-playbooks/playbooks/layered/agency-layer', { params: { tone: 'bold', region: 'Texas' } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const notAllowed = await call('a', 'PUT', '/campaign-playbooks/playbooks/layered/agency-layer', { params: { other: 1 } });
    expect(notAllowed.status).toBe(400);
    const r = await install(ws.a.orgs[5]!, 'layered', { params: { region: 'Austin' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const def = JSON.stringify((await getRegisteredWorkflowAsync(workflowOf(r)))!.nodes);
    expect(def).toContain('bold'); // layer 1 over layer 0
    expect(def).toContain('Austin'); // layer 2 over layer 1
    expect(def).not.toContain('Texas');
  });
});

describe('ADR 0959 D3 — drift', () => {
  it('an installation reports none, then edited after a builder save, then missing after delete', async () => {
    const org = ws.a.orgs[0]!;
    const list = async () => ((await call('a', 'GET', `/campaign-playbooks/clients/${org}/installs`)).body.installations as Array<{ playbookId: string; drift: string; workflowId: string }>).find((i) => i.playbookId === 'pinned')!;
    const row = await list();
    expect(row.drift).toBe('none');
    const def = (await getRegisteredWorkflowAsync(row.workflowId))!;
    await registerWorkflowDurable({ ...def, nodes: def.nodes.map((n, i) => (i === 0 ? { ...n, name: 'Renamed in the builder' } : n)) });
    expect((await list()).drift).toBe('edited');
    const del = await fetch(`${BASE}/host/openwop-app/workflows/${encodeURIComponent(row.workflowId)}`, { method: 'DELETE', headers: { cookie: ws.a.cookie } });
    expect([200, 204]).toContain(del.status);
    expect((await list()).drift).toBe('missing');
  });
});
