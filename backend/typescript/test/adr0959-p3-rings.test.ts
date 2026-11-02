/**
 * ADR 0959 P3 — rollout rings, soak, the health check, the CAS ring advance, and held installs,
 * through the HTTP boundary and the real executor (the health signal is real failed runs).
 *
 * Exit criteria (ADR 0959 phase table, P3): a concurrent advance produces one transition; a
 * failing canary stops the rollout.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - the health check removed                                                 → "a failing canary stops the rollout"
 *  - the health check ignoring the version (an old-version failure counts)    → "an old version's failures do not"
 *  - apply ignoring the open ring                                             → "only the open ring"
 *  - the advance writing with `put` instead of compare-and-swap               → "one transition"
 *  - the soak check removed                                                   → "soak"
 *  - the plan accepting a held client by name                                 → "held"
 *
 * DOUBLE GUARD / EQUIVALENT MUTANT (recorded): `failedRunsSince` counts a failed run only when
 * its stamp names the rollout's `toVersion` AND it was created at or after the client's apply.
 * The old 1.0.0 failure in "only the open ring" is created BEFORE the apply, so dropping only the
 * version filter changes nothing on this fixture (probe w73g3-pb3-health-version-only: vacuous,
 * an equivalent mutant). The header's "ignoring the version" sabotage breaks both filters in one
 * edit (w73g3-pb3-health-version-since: witnessed). A 1.0.0 failure AFTER the apply cannot be
 * produced once the install runs 2.0.0, so the version filter alone has no reachable witness.
 *
 * Every case builds its OWN playbook (`ringFixture`: v1 + v2 published, installed on the four
 * clients, rings canary/early/general/held) and its own rollout, so the file passes in any
 * order (wave 73: three cases shared one rollout id and a `good@3.0.0` leaked into another).
 * Run settle polls a real 25 ms tick: the executor exposes no completion hook (honest ceiling).
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
import { advanceRollout } from '../src/features/campaign-playbooks/rolloutService.js';
import type { Storage } from '../src/storage/storage.js';

let BASE = '';
let server: http.Server;
let TENANT = '';
let storage: Storage;
const orgs: string[] = [];
const cookies = { admin1: '', admin2: '' };

interface Res { status: number; body: unknown }
/** Walk an untyped JSON body without casts. */
const get = (b: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined), b);
const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw new Error(`${what} is not a string: ${JSON.stringify(v)}`); return v; };
async function call(who: keyof typeof cookies, method: string, path: string, body?: unknown, root = '/host/openwop-app'): Promise<Res> {
  const res = await fetch(`${BASE}${root}${path}`, { method, headers: { cookie: cookies[who], 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const raw = res.status === 204 ? '' : await res.text();
  let parsed: unknown = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
  return { status: res.status, body: parsed };
}

const chain = (version: string, fails: boolean) => ({
  chainId: 'acme.ringed', version, label: 'Ringed', description: 'Synthetic.',
  parameters: { type: 'object', properties: { region: { type: 'string' } } },
  dag: {
    nodes: [
      { id: 'start', typeId: 'core.flow.noop@1.0.0', config: {}, inputs: { region: '{{params.region}}', step: version } },
      ...(fails ? [{ id: 'boom', typeId: 'core.flow.stop-and-error@1.0.0', config: { code: 'SYNTHETIC', message: 'synthetic failure' }, inputs: {} }] : []),
    ],
    edges: fails ? [{ from: 'start', to: 'boom' }] : [],
  },
});
async function publish(id: string, version: string, fails: boolean): Promise<void> {
  expect((await call('admin1', 'PUT', `/campaign-playbooks/playbooks/${id}/draft`, { title: id, chains: [chain(version, fails)], entryChainId: 'acme.ringed', overridable: { params: ['region'], slots: [] } })).status).toBe(200);
  const r = await call('admin1', 'POST', `/campaign-playbooks/playbooks/${id}/versions`, { version });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
async function installAll(id: string): Promise<void> {
  for (const org of orgs) expect((await call('admin1', 'POST', `/campaign-playbooks/clients/${org}/installs`, { playbookId: id, version: '1.0.0', clientLayer: { params: { region: 'X' } } })).status).toBe(201);
  const rings = ['canary', 'early', 'general', 'held'];
  for (const [i, org] of orgs.entries()) expect((await call('admin1', 'PUT', `/campaign-playbooks/clients/${org}/installs/${id}/ring`, { ring: rings[i] })).status).toBe(200);
}
let seq = 0;
/** This case's own playbook: 1.0.0 installed on the four clients (rings canary/early/general/held),
 *  then 2.0.0 published. `good`: 1.0.0 fails every run, 2.0.0 is healthy. `bad`: the reverse. */
async function ringFixture(kind: 'good' | 'bad'): Promise<string> {
  const id = `${kind}-${(++seq).toString(36)}`;
  await publish(id, '1.0.0', kind === 'good');
  await installAll(id);
  await publish(id, '2.0.0', kind === 'bad');
  return id;
}
async function approvedRollout(id: string, soakHours: Record<string, number>): Promise<string> {
  const created = await call('admin1', 'POST', `/campaign-playbooks/playbooks/${id}/rollouts`, { toVersion: '2.0.0', rings: true, soakHours });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await call('admin2', 'POST', `/approvals/${str(get(created.body, 'approval', 'approvalId'), 'approval.approvalId')}/claim`, {})).status).toBe(200);
  return str(get(created.body, 'rollout', 'rolloutId'), 'rollout.rolloutId');
}
async function installationOf(orgId: string, id: string): Promise<unknown> {
  const rows = get((await call('admin1', 'GET', `/campaign-playbooks/clients/${orgId}/installs`)).body, 'installations');
  if (!Array.isArray(rows)) throw new Error('installations is not an array');
  const row: unknown = rows.find((i) => get(i, 'playbookId') === id);
  if (!row) throw new Error(`no installation of ${id} on ${orgId}`);
  return row;
}
const workflowOf = async (orgId: string, id: string): Promise<string> => str(get(await installationOf(orgId, id), 'workflowId'), 'workflowId');
async function runToEnd(workflowId: string): Promise<string> {
  const r = await call('admin1', 'POST', '/runs', { workflowId, inputs: {} }, '');
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const runId = str(get(r.body, 'runId'), 'runId');
  for (let i = 0; i < 120; i++) {
    const s = get((await call('admin1', 'GET', `/runs/${runId}`, undefined, '')).body, 'status');
    if (typeof s === 'string' && ['completed', 'failed', 'cancelled'].includes(s)) return s;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`run ${runId} did not settle within 120 polls`);
}
const getRollout = async (rid: string): Promise<unknown> => get((await call('admin1', 'GET', `/campaign-playbooks/rollouts/${rid}`)).body, 'rollout');
const ringsOf = (rollout: unknown): unknown[] => { const r = get(rollout, 'rings'); if (!Array.isArray(r)) throw new Error('rollout.rings is not an array'); return r; };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['campaign-ops', 'campaign-playbooks']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  const tag = randomBytes(3).toString('hex');
  TENANT = (await createWorkspace({ name: 'Agency', ownerSubject: `oidc:pb3-owner-${tag}` })).tenantId;
  const now = Math.floor(Date.now() / 1000);
  for (const k of ['admin1', 'admin2'] as const) {
    const u = await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:pb3-${k}-${tag}`, source: 'oidc' });
    await createMember({ tenantId: TENANT, orgId: TENANT, subject: u.userId, displayName: k, roles: ['admin'] });
    cookies[k] = `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: TENANT, tier: 'user', userId: u.userId, personalTenant: `ws:home-${u.userId}`, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
  }
  for (let i = 0; i < 4; i++) {
    const orgId = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: `Client ${i} (synthetic)` })).orgId;
    await createClient({ tenantId: TENANT, orgId, name: `Client ${i} (synthetic)`, createdBy: 'seed' });
    orgs.push(orgId);
  }
}, 120_000);
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0959 D6.3 — rings', () => {
  it('held clients are skipped, by a ring rollout and by name', async () => {
    const good = await ringFixture('good');
    const byName = await call('admin1', 'POST', `/campaign-playbooks/playbooks/${good}/rollouts`, { toVersion: '2.0.0', orgIds: [orgs[3]!] });
    expect(byName.status).toBe(409);
    expect(JSON.stringify(byName.body)).toContain('install_held');
    const rid = await approvedRollout(good, { canary: 0, early: 1, general: 0 });
    expect(ringsOf(await getRollout(rid)).map((x) => [get(x, 'name'), get(x, 'orgIds')])).toEqual([['canary', [orgs[0]]], ['early', [orgs[1]]], ['general', [orgs[2]]]]);
  });

  it('only the open ring applies; an old version\'s failures do not stop the next ring', async () => {
    const good = await ringFixture('good');
    const rid = await approvedRollout(good, { canary: 0, early: 1, general: 0 });
    expect(await runToEnd(await workflowOf(orgs[0]!, good))).toBe('failed'); // a 1.0.0 failure, before the apply
    const early = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/targets/${orgs[1]}/apply`, {});
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toContain('ring_not_open');
    const ring0 = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/apply-ring`, {});
    expect(ring0.status, JSON.stringify(ring0.body)).toBe(200);
    expect(ring0.body).toMatchObject({ applied: [orgs[0]] });
    expect(await runToEnd(await workflowOf(orgs[0]!, good))).toBe('completed'); // 2.0.0 is healthy
    const adv = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/advance`, {});
    expect(adv.status, JSON.stringify(adv.body)).toBe(200);
    expect(get(await getRollout(rid), 'ringIndex')).toBe(1);
  });

  it('a ring still soaking does not advance', async () => {
    const good = await ringFixture('good');
    const rid = await approvedRollout(good, { canary: 0, early: 1, general: 0 });
    expect((await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/apply-ring`, {})).status).toBe(200); // canary
    const first = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/advance`, {});
    expect(first.status, JSON.stringify(first.body)).toBe(200); // canary soaks 0 h
    expect((await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/apply-ring`, {})).status).toBe(200); // early
    const adv = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/advance`, {});
    expect(adv.status).toBe(409);
    expect(JSON.stringify(adv.body)).toContain('soak_pending');
    expect(get(await getRollout(rid), 'ringIndex')).toBe(1);
  });
});

describe('ADR 0959 D6.3 — the exit criteria', () => {
  it('concurrent advances produce one transition', async () => {
    const good = await ringFixture('good');
    const rid = await approvedRollout(good, { canary: 0, early: 0, general: 0 });
    expect((await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/apply-ring`, {})).status).toBe(200);
    // In-process, so the five interleave at every storage await (over HTTP they serialize and
    // the losers merely see `ring_incomplete`, which would not test the compare-and-swap).
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => advanceRollout(storage, TENANT, rid, 'u')));
    expect(results.filter((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(get(r.reason, 'details', 'reason')) : 'ok')))).toHaveLength(1);
    expect(get(await getRollout(rid), 'ringIndex')).toBe(1);
  });

  it('a failing canary stops the rollout; rollback stays open', async () => {
    const bad = await ringFixture('bad');
    const rid = await approvedRollout(bad, { canary: 0, early: 0, general: 0 });
    expect((await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/apply-ring`, {})).status).toBe(200);
    expect(await runToEnd(await workflowOf(orgs[0]!, bad))).toBe('failed'); // 2.0.0 fails
    const adv = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/advance`, {});
    expect(adv.status).toBe(409);
    expect(adv.body).toMatchObject({ details: { reason: 'health_failed', orgIds: [orgs[0]] } });
    expect(get(await getRollout(rid), 'status')).toBe('halted');
    expect((await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/advance`, {})).status).toBe(409);
    const blocked = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/targets/${orgs[1]}/apply`, {});
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('rollout_halted');
    expect(get(await installationOf(orgs[0]!, bad), 'pinnedVersion')).toBe('2.0.0');
    const back = await call('admin1', 'POST', `/campaign-playbooks/rollouts/${rid}/targets/${orgs[0]}/rollback`, {});
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // Rolled back, read from the installation (not the response): the client is on 1.0.0 again.
    expect(get(await installationOf(orgs[0]!, bad), 'pinnedVersion')).toBe('1.0.0');
  });
});
