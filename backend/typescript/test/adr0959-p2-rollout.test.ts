/**
 * ADR 0959 P2 — rollout plan + diff, the `playbook-rollout` approval, manual per-client apply,
 * and rollback, through the HTTP boundary.
 *
 * Exit criteria (ADR 0959 phase table, P2): the plan makes zero writes; rollback re-installs the
 * exact prior revision hash.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the decide handler skipping the re-plan hash check                              → "plan_changed"
 *  - the separation-of-duties check removed                                          → "the requester cannot approve"
 *  - apply skipping the per-target re-plan                                           → "target_changed"
 *  - rollback using today's layers instead of the recorded ones                      → "exact prior revision"
 *  - the per-target `applied` short-circuit removed (a repeat apply writes again)    → "idempotent"
 *
 * NOT witnessed by sabotage: the head compare-and-swap inside `instantiateOwnedChain({into})`.
 * The per-target re-plan refuses a moved head first (the `target_changed` case), so removing the
 * CAS reds nothing here; it guards the race between that re-plan and the write, which this
 * harness cannot interleave. Recorded, not claimed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { getRegisteredWorkflowAsync, registerWorkflowDurable } from '../src/host/workflowsRegistry.js';
import { revisionHashOf } from '../src/host/definitionHash.js';
import { listRevisions } from '../src/host/workflowRevisions.js';
import { getApproval } from '../src/host/approvalService.js';
import { getInstallation, eraseInstallers } from '../src/features/campaign-playbooks/installService.js';
import { getRollout } from '../src/features/campaign-playbooks/rolloutService.js';
import type { PlaybookInstallation } from '../src/features/campaign-playbooks/types.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let TENANT = '';
const orgs: string[] = [];
const cookies = { admin1: '', admin2: '' };

interface Res { status: number; body: Record<string, unknown> }
async function call(who: keyof typeof cookies, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, { method, headers: { cookie: cookies[who], 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const chain = (version: string, extra: boolean) => ({
  chainId: 'acme.method', version, label: 'Method', description: 'Synthetic.',
  parameters: { type: 'object', properties: { region: { type: 'string' }, tone: { type: 'string' } }, additionalProperties: false },
  dag: {
    nodes: [
      { id: 'start', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { region: '{{params.region}}', step: version } },
      { id: 'finish', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { tone: '{{params.tone}}' } },
      ...(extra ? [{ id: 'extra', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: {} }] : []),
    ],
    edges: [{ from: 'start', to: 'finish' }, ...(extra ? [{ from: 'finish', to: 'extra' }] : [])],
  },
});
async function publish(version: string, extra: boolean, overridable: string[]): Promise<void> {
  expect((await call('admin1', 'PUT', '/campaign-playbooks/playbooks/method/draft', { title: 'Method', chains: [chain(version, extra)], entryChainId: 'acme.method', defaults: { params: { tone: 'warm' } }, overridable: { params: overridable, slots: [] }, changelog: version })).status).toBe(200);
  const r = await call('admin1', 'POST', '/campaign-playbooks/playbooks/method/versions', { version });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const installOf = async (orgId: string) => ((await call('admin1', 'GET', `/campaign-playbooks/clients/${orgId}/installs`)).body.installations as Array<{ playbookId: string; workflowId: string; pinnedVersion: string; expectedRevision: string; drift: string }>).find((i) => i.playbookId === 'method')!;
const headOf = async (workflowId: string): Promise<string> => revisionHashOf((await getRegisteredWorkflowAsync(workflowId))!);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['campaign-ops', 'campaign-playbooks']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  const tag = randomBytes(3).toString('hex');
  TENANT = (await createWorkspace({ name: 'Agency', ownerSubject: `oidc:pb2-owner-${tag}` })).tenantId;
  const now = Math.floor(Date.now() / 1000);
  for (const k of ['admin1', 'admin2'] as const) {
    const u = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:pb2-${k}-${tag}`, source: 'oidc' });
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: u.userId, displayName: k, roles: ['admin'] });
    cookies[k] = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId: u.userId, personalTenant: `ws:home-${u.userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  }
  for (let i = 0; i < 4; i++) {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: `Client ${i} (synthetic)` })).orgId;
    await createClient({ tenantId: TENANT, orgId, name: `Client ${i} (synthetic)`, createdBy: 'seed' });
    orgs.push(orgId);
  }
  await publish('1.0.0', false, ['region', 'tone']);
  for (const [i, org] of orgs.entries()) {
    const layer = i === 2 ? { params: { region: `R${i}`, tone: 'loud' } } : { params: { region: `R${i}` } };
    const r = await call('admin1', 'POST', `/campaign-playbooks/clients/${org}/installs`, { playbookId: 'method', version: '1.0.0', clientLayer: layer });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  // 2.0.0 adds a node, changes a step, and no longer lets a client set `tone`.
  await publish('2.0.0', true, ['region']);
  // Client 1 edits its copy in the builder.
  const wf = (await installOf(orgs[1]!)).workflowId;
  const def = (await getRegisteredWorkflowAsync(wf))!;
  await registerWorkflowDurable({ ...def, nodes: def.nodes.map((n, i) => (i === 0 ? { ...n, name: 'Edited by the client' } : n)) });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0959 D6.1 — the plan', () => {
  it('classifies each client and diffs by original node id; it makes zero writes', async () => {
    const countWrites = async <T>(fn: () => Promise<T>): Promise<{ out: T; writes: string[] }> => {
      const writes: string[] = [];
      const originals = { kvSet: storage.kvSet.bind(storage), kvDelete: storage.kvDelete.bind(storage), kvCompareAndSwap: storage.kvCompareAndSwap.bind(storage) };
      const wrapped = (['kvSet', 'kvDelete', 'kvCompareAndSwap'] as const).map((m) => vi.spyOn(storage, m).mockImplementation(((...args: unknown[]) => {
        const key = String(args[0]);
        if (/campaign-playbooks|wfreg|workflow|approval/.test(key)) writes.push(`${m}:${key}`);
        return (originals[m] as (...a: unknown[]) => unknown)(...args);
      }) as never));
      try { return { out: await fn(), writes }; } finally { for (const w of wrapped) w.mockRestore(); }
    };
    // Non-vacuity: the same probe sees a draft save write.
    const control = await countWrites(() => call('admin1', 'PUT', '/campaign-playbooks/playbooks/probe/draft', { title: 'Probe', chains: [chain('1.0.0', false)], entryChainId: 'acme.method', overridable: { params: [], slots: [] } }));
    expect(control.writes.length, 'the write probe sees nothing — it is not wired to this storage').toBeGreaterThan(0);
    const { out: r, writes } = await countWrites(() => call('admin1', 'POST', '/campaign-playbooks/playbooks/method/rollouts/plan', { toVersion: '2.0.0', orgIds: orgs.slice(0, 3) }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(writes, 'the plan wrote').toEqual([]);
    const plan = r.body.plan as Array<{ orgId: string; class: string; chainDiff: { added: string[]; changed: string[] }; conflicts: Array<{ kind: string; key?: string }>; configDiff: { changes: unknown[] } }>;
    const by = (o: string) => plan.find((p) => p.orgId === o)!;
    expect(by(orgs[0]!).class).toBe('clean');
    expect(by(orgs[0]!).chainDiff).toMatchObject({ added: ['extra'], changed: ['start'] });
    expect(by(orgs[1]!).class).toBe('detached');
    expect(by(orgs[2]!).class).toBe('conflicts');
    expect(by(orgs[2]!).conflicts[0]).toMatchObject({ kind: 'playbook_key_not_overridable', key: 'tone' });
  });
});

describe('ADR 0959 D6.2/D7 — the gate', () => {
  it('the requester cannot approve; a plan that changed closes the review', async () => {
    const created = await call('admin1', 'POST', '/campaign-playbooks/playbooks/method/rollouts', { toVersion: '2.0.0', orgIds: [orgs[3]!] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approvalId = (created.body.approval as { approvalId: string }).approvalId;
    const self = await call('admin1', 'POST', `/approvals/${approvalId}/claim`, {});
    expect(self.status).toBe(403);
    // The client is edited after the plan was made: the plan no longer hashes the same.
    const wf = (await installOf(orgs[3]!)).workflowId;
    const def = (await getRegisteredWorkflowAsync(wf))!;
    await registerWorkflowDurable({ ...def, nodes: def.nodes.map((n, i) => (i === 1 ? { ...n, name: 'Changed after planning' } : n)) });
    const stale = await call('admin2', 'POST', `/approvals/${approvalId}/claim`, {});
    expect(stale.status).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('plan_changed');
    const rolloutId = (created.body.rollout as { rolloutId: string }).rolloutId;
    expect(((await call('admin1', 'GET', `/campaign-playbooks/rollouts/${rolloutId}`)).body.rollout as { status: string }).status).toBe('closed');
  });
});

describe('ADR 0959 D6.4/D6.5 — apply and rollback', () => {
  let rolloutId = '';
  it('an approved rollout applies per client: clean at once, conflicts with new values, detached only with overwrite', async () => {
    const created = await call('admin1', 'POST', '/campaign-playbooks/playbooks/method/rollouts', { toVersion: '2.0.0', orgIds: orgs.slice(0, 3) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    rolloutId = (created.body.rollout as { rolloutId: string }).rolloutId;
    const approvalId = (created.body.approval as { approvalId: string }).approvalId;
    const notYet = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[0]}/apply`, {});
    expect(notYet.status).toBe(409);
    const ok = await call('admin2', 'POST', `/approvals/${approvalId}/claim`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    const before = await installOf(orgs[0]!);
    const a = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[0]}/apply`, {});
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const after = await installOf(orgs[0]!);
    expect(after).toMatchObject({ pinnedVersion: '2.0.0', workflowId: before.workflowId, drift: 'none' });
    expect(JSON.stringify((await getRegisteredWorkflowAsync(after.workflowId))!.nodes)).toContain('2.0.0');
    expect((await listRevisions(after.workflowId)).length).toBeGreaterThanOrEqual(2);

    const c = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[2]}/apply`, {});
    expect(c.status).toBe(409);
    expect(JSON.stringify(c.body)).toContain('conflicts_need_resolution');
    const c2 = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[2]}/apply`, { clientLayer: { params: { region: 'R2' } } });
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);

    const d = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[1]}/apply`, {});
    expect(d.status).toBe(409);
    expect(JSON.stringify(d.body)).toContain('detached_needs_overwrite');
    const d2 = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[1]}/apply`, { overwrite: true });
    expect(d2.status, JSON.stringify(d2.body)).toBe(200);
  });

  it('a repeat apply is idempotent (no second revision)', async () => {
    const inst = await installOf(orgs[0]!);
    const n = (await listRevisions(inst.workflowId)).length;
    const again = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[0]}/apply`, {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyApplied: true });
    expect((await listRevisions(inst.workflowId)).length).toBe(n);
  });

  it('rollback re-installs the exact prior revision hash, with the layers it ran with', async () => {
    // Client 2's 1.0.0 install carried tone=loud; its upgrade dropped it.
    const priorRevision = (await (async () => {
      const rows = (await call('admin1', 'GET', `/campaign-playbooks/clients/${orgs[2]}/installs`)).body.installations as Array<{ playbookId: string; history: Array<{ version: string; revision: string }> }>;
      return rows.find((r) => r.playbookId === 'method')!.history.find((h) => h.version === '1.0.0')!.revision;
    })());
    const rb = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgs[2]}/rollback`, {});
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    const inst = await installOf(orgs[2]!);
    expect(inst.pinnedVersion).toBe('1.0.0');
    expect(await headOf(inst.workflowId)).toBe(priorRevision);
    expect(JSON.stringify((await getRegisteredWorkflowAsync(inst.workflowId))!.nodes)).toContain('loud');
  });

  it('a client edited after approval is refused (target_changed), never clobbered', async () => {
    const created = await call('admin1', 'POST', '/campaign-playbooks/playbooks/method/rollouts', { toVersion: '2.0.0', orgIds: [orgs[2]!] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const rid = (created.body.rollout as { rolloutId: string }).rolloutId;
    expect((await call('admin2', 'POST', `/approvals/${(created.body.approval as { approvalId: string }).approvalId}/claim`, {})).status).toBe(200);
    const wf = (await installOf(orgs[2]!)).workflowId;
    const def = (await getRegisteredWorkflowAsync(wf))!;
    const edited = { ...def, nodes: def.nodes.map((n, i) => (i === 0 ? { ...n, name: 'Edited after approval' } : n)) };
    await registerWorkflowDurable(edited);
    const r = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/targets/${orgs[2]}/apply`, { clientLayer: { params: { region: 'R2' } } });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('target_changed');
    expect(await headOf(wf)).toBe(revisionHashOf(edited));
  });
});

describe('ADR 0959 recovery — durable operation acknowledgements', () => {
  async function target(approve = true) {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Recovery client' })).orgId;
    await createClient({ tenantId: TENANT, orgId, name: 'Recovery client', createdBy: 'seed' });
    expect((await call('admin1', 'POST', `/campaign-playbooks/clients/${orgId}/installs`, { playbookId: 'method', version: '1.0.0', clientLayer: { params: { region: 'Recovery' } } })).status).toBe(201);
    const created = await call('admin1', 'POST', '/campaign-playbooks/playbooks/method/rollouts', { toVersion: '2.0.0', orgIds: [orgId] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const rolloutId = (created.body.rollout as { rolloutId: string }).rolloutId;
    const approvalId = (created.body.approval as { approvalId: string }).approvalId;
    if (approve) expect((await call('admin2', 'POST', `/approvals/${approvalId}/claim`, {})).status).toBe(200);
    const install = (await getInstallation(TENANT, orgId, 'method'))!;
    return { orgId, rolloutId, approvalId, install, path: `/campaign-playbooks/rollouts/${rolloutId}/targets/${orgId}/apply` };
  }

  it('the first installation reserves one random copy id before a lost workflow acknowledgement', async () => {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Initial recovery' })).orgId;
    await createClient({ tenantId: TENANT, orgId, name: 'Initial recovery', createdBy: 'seed' });
    const marker = `INITIAL-${orgId}`;
    const body = { playbookId: 'method', version: '1.0.0', clientLayer: { params: { region: marker } } };
    const path = `/campaign-playbooks/clients/${orgId}/installs`;
    const original = storage.kvCompareAndSwap.bind(storage);
    let copyId = ''; let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key.startsWith('hostext:campaign-playbooks:install:') && JSON.parse(next).orgId === orgId) copyId = JSON.parse(next).workflowId as string;
      const out = await original(key, expected, next);
      if (!injected && copyId && key === `wfreg:${copyId}` && out.swapped) { injected = true; throw new Error('lost first workflow acknowledgement'); }
      return out;
    });
    try { expect((await call('admin1', 'POST', path, body)).status).toBe(500); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect(await getInstallation(TENANT, orgId, 'method')).toMatchObject({ status: 'installing', workflowId: copyId });
    const retry = await call('admin1', 'POST', path, body);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    const installed = (await getInstallation(TENANT, orgId, 'method'))!;
    expect(installed).toMatchObject({ status: 'installed', workflowId: copyId });
    expect(installed.history).toHaveLength(1);
    expect((await storage.kvList('wfreg:')).filter((r) => r.value.includes(marker))).toHaveLength(1);
  });

  it('a lost workflow-write acknowledgement resumes the same upgrade without a second history entry', async () => {
    const t = await target();
    const original = storage.kvCompareAndSwap.bind(storage);
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const out = await original(key, expected, next);
      if (!injected && key === `wfreg:${t.install.workflowId}` && out.swapped) { injected = true; throw new Error('lost workflow acknowledgement'); }
      return out;
    });
    try { expect((await call('admin1', 'POST', t.path, {})).status).toBe(500); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect((await getInstallation(TENANT, t.orgId, 'method'))?.pendingUpgrade?.rolloutId).toBe(t.rolloutId);
    const retry = await call('admin1', 'POST', t.path, {});
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    const confirmed = (await getInstallation(TENANT, t.orgId, 'method'))!;
    expect(confirmed.pendingUpgrade).toBeUndefined();
    expect(confirmed.pinnedVersion).toBe('2.0.0');
    expect(confirmed.history.filter((h) => h.rolloutId === t.rolloutId)).toHaveLength(1);
    expect(await headOf(confirmed.workflowId!)).toBe(confirmed.expectedRevision);
  });

  it('a concurrent ring edit survives installation finalization', async () => {
    const t = await target();
    const original = storage.kvCompareAndSwap.bind(storage);
    const keyOf = `hostext:campaign-playbooks:install:${t.install.key}`;
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!injected && key === keyOf && (JSON.parse(next) as PlaybookInstallation).pinnedVersion === '2.0.0') {
        injected = true;
        const current = (await storage.kvGet(key))!;
        expect((await original(key, current, JSON.stringify({ ...JSON.parse(current), ring: 'early' }))).swapped).toBe(true);
      }
      return original(key, expected, next);
    });
    try { const applied = await call('admin1', 'POST', t.path, {}); expect(applied.status, JSON.stringify(applied.body)).toBe(200); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect(await getInstallation(TENANT, t.orgId, 'method')).toMatchObject({ pinnedVersion: '2.0.0', ring: 'early' });
  });

  it('a human edit after a lost upgrade acknowledgement is never overwritten by the retry', async () => {
    const t = await target();
    const original = storage.kvCompareAndSwap.bind(storage);
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const out = await original(key, expected, next);
      if (!injected && key === `wfreg:${t.install.workflowId}` && out.swapped) { injected = true; throw new Error('lost workflow acknowledgement'); }
      return out;
    });
    try { expect((await call('admin1', 'POST', t.path, {})).status).toBe(500); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    const raw = (await storage.kvGet(`wfreg:${t.install.workflowId}`))!;
    const def = JSON.parse(raw) as NonNullable<Awaited<ReturnType<typeof getRegisteredWorkflowAsync>>>;
    const edited = { ...def, nodes: def.nodes.map((n, i) => i === 0 ? { ...n, name: 'Human edit after acknowledgement loss' } : n) };
    await registerWorkflowDurable(edited);
    const retry = await call('admin1', 'POST', t.path, {});
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
    expect(await headOf(t.install.workflowId!)).toBe(revisionHashOf(edited));
  });

  it('a lost installation acknowledgement reconciles the rollout without another upgrade', async () => {
    const t = await target();
    const original = storage.kvCompareAndSwap.bind(storage);
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const out = await original(key, expected, next);
      if (!injected && key === `hostext:campaign-playbooks:install:${t.install.key}` && out.swapped && (JSON.parse(next) as PlaybookInstallation).pinnedVersion === '2.0.0') {
        injected = true; throw new Error('lost installation acknowledgement');
      }
      return out;
    });
    try { expect((await call('admin1', 'POST', t.path, {})).status).toBe(500); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    const before = (await getInstallation(TENANT, t.orgId, 'method'))!;
    const retry = await call('admin1', 'POST', t.path, {});
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.alreadyApplied).toBe(true);
    expect((await getInstallation(TENANT, t.orgId, 'method'))?.history).toEqual(before.history);
    expect((await getRollout(TENANT, t.rolloutId))?.targets[t.orgId]?.status).toBe('applied');
  });

  it('a resolved approval repairs its rollout on retry and keeps the original decider', async () => {
    const t = await target(false);
    const original = storage.kvCompareAndSwap.bind(storage);
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!injected && key.startsWith('hostext:campaign-playbooks:rollout:') && JSON.parse(next).status === 'approved') {
        injected = true; throw new Error('rollout write refused after approval committed');
      }
      return original(key, expected, next);
    });
    try { expect((await call('admin2', 'POST', `/approvals/${t.approvalId}/claim`, {})).status).toBe(500); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    const decision = (await getApproval(t.approvalId))!;
    expect(decision.status).toBe('approved');
    expect((await call('admin1', 'POST', `/approvals/${t.approvalId}/claim`, {})).status).toBe(409);
    expect(await getRollout(TENANT, t.rolloutId)).toMatchObject({ status: 'approved', decidedBy: decision.decidedBy, decidedAt: decision.resolvedAt });
  });

  it('erasure retries a fresh installation after a concurrent ring edit', async () => {
    const t = await target();
    const original = storage.kvCompareAndSwap.bind(storage);
    let injected = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!injected && key === `hostext:campaign-playbooks:install:${t.install.key}` && JSON.parse(next).installedBy === 'erased:recovery') {
        injected = true;
        const current = (await storage.kvGet(key))!;
        expect((await original(key, current, JSON.stringify({ ...JSON.parse(current), ring: 'early' }))).swapped).toBe(true);
      }
      return original(key, expected, next);
    });
    try { expect(await eraseInstallers(TENANT, new Set([t.install.installedBy]), 'erased:recovery')).toBeGreaterThan(0); } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    expect(await getInstallation(TENANT, t.orgId, 'method')).toMatchObject({ installedBy: 'erased:recovery', ring: 'early' });
  });

  it('erasure reports contention rather than declaring success with the installer still present', async () => {
    const t = await target();
    const original = storage.kvCompareAndSwap.bind(storage);
    let attempts = 0;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === `hostext:campaign-playbooks:install:${t.install.key}` && JSON.parse(next).installedBy === 'erased:blocked') {
        attempts++; return { swapped: false, actual: await storage.kvGet(key) };
      }
      return original(key, expected, next);
    });
    try { await expect(eraseInstallers(TENANT, new Set([t.install.installedBy]), 'erased:blocked')).rejects.toMatchObject({ details: { reason: 'playbook_erasure_changed' } }); } finally { spy.mockRestore(); }
    expect(attempts).toBe(6);
    expect((await getInstallation(TENANT, t.orgId, 'method'))?.installedBy).toBe(t.install.installedBy);
  });
});
