/**
 * ADR 0882 D5–D7 — the two CSM plays, end to end through the REAL loader, the
 * REAL executor and real HTTP (no mocks):
 *
 *  - `csm-ops.renewal-runway` writes a 90/60/30 ladder of CRM tasks linked to the
 *    account's company and assigned to its member owner; a re-run re-ENSURES the
 *    same ladder (deterministic ids) instead of duplicating it; with nothing due
 *    it completes down `nothing-due` and writes nothing.
 *  - **HIGH-1 (pre-code review): a play never moves the score it reacts to.**
 *    `health-from-crm` run before and after the ladder lands on the same number.
 *  - `csm-ops.red-account-rescue`, bound to `host.csm.account.health-changed`,
 *    fires on a CROSSING below the threshold and not on a further drop.
 *  - Every edge into the effect node carries a condition (the effect-reject
 *    ratchet only looks behind approval gates, so it cannot see these plays).
 *
 * Tracker TST-BHD-2. Red when (sabotage-witnessed, wave 62): a play's own tasks count
 * against the score (HIGH-1); task ids stop being deterministic (a re-run duplicates);
 * the owner is not assigned; a further drop while already red re-fires the rescue; a
 * same-score save emits a health-changed event; or a due account with no CRM link is
 * written to instead of skipped.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { createHostEventBinding } from '../src/host/hostEventDispatcher.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'csm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
type Call = <T = Record<string, unknown>>(p: string, b?: unknown) => Promise<Res<T>>;
interface Client { get: Call; post: Call; patch: Call }
function client(): Client {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const out: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out as T };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string; userId: string }> {
  const tenantId = `org:csmplay-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `csmplay-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId, userId: r.body.user.userId };
}
const c = (orgId: string, suffix = ''): string => `/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}${suffix}`;
interface Task { taskId: string; title: string; status: string; companyId?: string; assignee?: string; dueDate?: string }
interface RunSnapshot { status: string; error?: { code: string; message: string } }

async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  return vi.waitFor(async () => {
    const snap = (await owner.get<RunSnapshot>(`/runs/${runId}`)).body;
    expect(['completed', 'failed', 'cancelled']).toContain(snap.status);
    return snap;
  }, { timeout: 10_000, interval: 25 });
}

async function run(owner: Client, chainId: string, params: Record<string, unknown>): Promise<RunSnapshot> {
  const found = getChain(chainId);
  expect(found, `${chainId} must be loaded at boot`).toBeTruthy();
  const expanded = expandChain(found!.chain, { params });
  registerWorkflow(expanded);
  const create = await owner.post<{ runId: string }>('/runs', { workflowId: expanded.workflowId, inputs: params });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  return pollRun(owner, create.body.runId);
}

async function linkedAccount(owner: Client, orgId: string, body: Record<string, unknown>): Promise<{ accountId: string; companyId: string }> {
  const company = await owner.post<{ companyId: string }>(c(orgId, '/companies'), { name: `Co ${n++}` });
  expect(company.status, JSON.stringify(company.body)).toBe(201);
  const acct = await owner.post<{ accountId: string }>('/host/openwop-app/csm/accounts', { name: 'Globex', crmRef: { orgId, companyId: company.body.companyId }, ...body });
  expect(acct.status, JSON.stringify(acct.body)).toBe(201);
  return { accountId: acct.body.accountId, companyId: company.body.companyId };
}

const inDays = (d: number): string => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

describe('ADR 0882 D7 — both plays gate their effect on a condition', () => {
  for (const chainId of ['csm-ops.red-account-rescue', 'csm-ops.renewal-runway']) {
    it(`${chainId}: every edge into the play-task writer carries a condition`, () => {
      const expanded = expandChain(getChain(chainId)!.chain, { params: {} });
      const plays = expanded.nodes.find((x) => x.nodeId.endsWith('_plays'));
      expect(plays).toBeTruthy();
      const into = (expanded.edges ?? []).filter((e) => e.targetNodeId === plays!.nodeId);
      expect(into.length).toBeGreaterThan(0);
      for (const e of into) expect(e.condition, JSON.stringify(e)).toBeTruthy();
    });
  }
});

describe('ADR 0882 D7 — csm-ops.renewal-runway', () => {
  it('writes an attributed, assigned ladder; a re-run re-ensures it; the score does not move (HIGH-1)', async () => {
    const { owner, orgId, userId } = await ownerOrg();
    const { accountId, companyId } = await linkedAccount(owner, orgId, { renewalDate: inDays(45), ownerSelf: true });

    // Score BEFORE the play.
    expect((await run(owner, 'csm-ops.health-from-crm', { orgId, companyId, accountId })).status).toBe('completed');
    const before = (await owner.get<{ accounts: Array<{ accountId: string; healthScore?: number }> }>('/host/openwop-app/csm/accounts')).body.accounts.find((a) => a.accountId === accountId)!.healthScore;
    expect(before).toBe(100);

    const first = await run(owner, 'csm-ops.renewal-runway', { days: 90 });
    expect(first.status, JSON.stringify(first)).toBe('completed');
    const tasks1 = (await owner.get<{ tasks: Task[] }>(c(orgId, '/tasks'))).body.tasks.filter((t) => t.taskId.startsWith('task:play:renewal-runway:'));
    expect(tasks1).toHaveLength(3);
    for (const t of tasks1) {
      expect(t.companyId, 'a play task is attributed to the account\'s company (CSMWF-7)').toBe(companyId);
      expect(t.assignee, 'and assigned to its member owner').toBe(userId);
      expect(t.title).toMatch(/— Globex$/);
      // 90/60/30 days before a renewal 45 days out: the first two clamp to today.
      expect(t.dueDate! >= inDays(0)).toBe(true);
    }

    // Re-run: the SAME three ids, no duplicates.
    expect((await run(owner, 'csm-ops.renewal-runway', { days: 90 })).status).toBe('completed');
    const tasks2 = (await owner.get<{ tasks: Task[] }>(c(orgId, '/tasks'))).body.tasks.filter((t) => t.taskId.startsWith('task:play:renewal-runway:'));
    expect(tasks2.map((t) => t.taskId).sort()).toEqual(tasks1.map((t) => t.taskId).sort());

    // HIGH-1 — the play's three OPEN tasks carry this company's id, and the score
    // is unchanged: they are reported as `playTasksOpen`, never scored.
    expect((await run(owner, 'csm-ops.health-from-crm', { orgId, companyId, accountId })).status).toBe('completed');
    const after = (await owner.get<{ accounts: Array<{ accountId: string; healthScore?: number; healthFactors?: Array<{ factor: string; value: number }> }> }>('/host/openwop-app/csm/accounts')).body.accounts.find((a) => a.accountId === accountId)!;
    expect(after.healthScore).toBe(before);
    expect(after.healthFactors?.find((f) => f.factor === 'playTasksOpen')?.value).toBe(3);
  });

  it('nothing due ⇒ completes down `nothing-due` and writes nothing', async () => {
    const { owner, orgId } = await ownerOrg();
    await linkedAccount(owner, orgId, { renewalDate: inDays(200) });
    expect((await run(owner, 'csm-ops.renewal-runway', { days: 90 })).status).toBe('completed');
    const tasks = (await owner.get<{ tasks: Task[] }>(c(orgId, '/tasks'))).body.tasks;
    expect(tasks.filter((t) => t.taskId.startsWith('task:play:'))).toHaveLength(0);
  });

  it('due accounts with no CRM link ⇒ a typed failure, never success-with-empty', async () => {
    const { owner } = await ownerOrg();
    const acct = await owner.post('/host/openwop-app/csm/accounts', { name: 'Unlinked', renewalDate: inDays(10) });
    expect(acct.status).toBe(201);
    const snap = await run(owner, 'csm-ops.renewal-runway', { days: 90 });
    expect(snap.status).toBe('failed');
    // BOTH halves: the typed refusal AND the reason the account was skipped (an OR of
    // the two could not tell a skipped account from a failed write).
    expect(snap.error?.code).toMatch(/(^|\.)no_play_targets$/);
    expect(snap.error?.message).toContain('no-crm-link');
  });
});

/** Wait until at least `want` (≥ 1) runs of this binding exist and all have settled. */
async function runsForBinding(tenantId: string, bindingId: string, want: number): Promise<RunRecord[]> {
  if (want < 1) throw new Error('runsForBinding waits for at least one run; assert absence after a positive control');
  return vi.waitFor(async () => {
    const runs = await storage.listRuns({ tenantId, limit: 50 });
    const found = runs.filter((r) => (r.metadata as { hostEvent?: { bindingId?: string } } | undefined)?.hostEvent?.bindingId === bindingId);
    expect(found.length).toBeGreaterThanOrEqual(want);
    expect(found.every((r) => r.status !== 'pending' && r.status !== 'running')).toBe(true);
    return found;
  }, { timeout: 10_000, interval: 25 });
}

describe('ADR 0882 D5/D6 — csm-ops.red-account-rescue, bound to host.csm.account.health-changed', () => {
  it('fires on the crossing below 70, and a further drop while red adds nothing', async () => {
    const { owner, orgId, tenantId, userId } = await ownerOrg();
    const { accountId } = await linkedAccount(owner, orgId, { healthScore: 80, ownerSelf: true });
    const expanded = expandChain(getChain('csm-ops.red-account-rescue')!.chain, { params: {} });
    registerWorkflow(expanded);
    const binding = await createHostEventBinding({ tenantId, eventType: 'host.csm.account.health-changed', workflowId: expanded.workflowId, createdBy: userId });

    // 80 → 75: a change, not a crossing. 75 → 50: the crossing. 50 → 40: already red.
    for (const score of [75, 50, 40]) {
      const p = await owner.patch(`/host/openwop-app/csm/accounts/${encodeURIComponent(accountId)}`, { healthScore: score });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      await runsForBinding(tenantId, binding.bindingId, [75, 50, 40].indexOf(score) + 1);
    }
    const runs = await runsForBinding(tenantId, binding.bindingId, 3);
    expect(runs).toHaveLength(3);
    for (const r of runs) expect(r.status, JSON.stringify(r.error)).toBe('completed');
    const tasks = (await owner.get<{ tasks: Task[] }>(c(orgId, '/tasks'))).body.tasks.filter((t) => t.taskId.startsWith('task:play:red-account-rescue:'));
    expect(tasks, 'exactly one rescue ladder — for the crossing only').toHaveLength(3);
    for (const t of tasks) expect(t.assignee).toBe(userId);
  });

  it('a re-save of the same score emits nothing', async () => {
    const { owner, orgId, tenantId, userId } = await ownerOrg();
    const { accountId } = await linkedAccount(owner, orgId, { healthScore: 30 });
    const expanded = expandChain(getChain('csm-ops.red-account-rescue')!.chain, { params: {} });
    registerWorkflow(expanded);
    const binding = await createHostEventBinding({ tenantId, eventType: 'host.csm.account.health-changed', workflowId: expanded.workflowId, createdBy: userId });
    expect((await owner.patch(`/host/openwop-app/csm/accounts/${encodeURIComponent(accountId)}`, { healthScore: 30 })).status).toBe(200);
    // Positive control: a CHANGING save (30 → 25, already red) does emit — one run,
    // which completes without a ladder. Exactly one run proves the same-score save
    // above added none (the pipeline is live, so its absence is not a slow bus).
    expect((await owner.patch(`/host/openwop-app/csm/accounts/${encodeURIComponent(accountId)}`, { healthScore: 25 })).status).toBe(200);
    const runs = await runsForBinding(tenantId, binding.bindingId, 1);
    expect(runs).toHaveLength(1);
    // …and that one run is the 25 save's (a run for the same-score save would be the
    // FIRST to appear, so this also catches it when the wait returns early).
    const fired = (runs[0]!.metadata as { triggerData?: { payload?: { healthScore?: number } } } | undefined)?.triggerData?.payload?.healthScore;
    expect(fired).toBe(25);
  });
});
