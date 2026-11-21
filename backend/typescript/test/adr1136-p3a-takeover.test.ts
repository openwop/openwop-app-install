/**
 * ADR 1136 P3a — take-over: a credential step in the person's OWN browser window
 * is handed to the person, never typed by the agent, and resumes only on the
 * opener's verified answer. Release-manager conditions:
 *
 *  1. the card shows the page's real origin (the executor's report, never model text);
 *  2. bounded: an expiry, a per-session cap, opener-only (a non-opener's answer is
 *     refused), and continue is opening-run-only while stop is allowed from any run;
 *  3. no secret in what follows: a typed value never reaches the model input, the
 *     session projection or the run's event log.
 *
 * Two lanes: the host-run loop with the fake executor (service level), and a real
 * run of `computer-use.run-task` with the mock adapter in take-over mode (the
 * approver ACL and the run-record verification end to end).
 *
 * Sabotage witnesses (each red, then restored):
 *  - fail the session instead of handing over → "a credential field is handed";
 *  - skip the expiry check in completeTakeover → "an expired take-over";
 *  - drop the MAX_TAKEOVERS bound → "at most three";
 *  - accept any approver list in verifiedTakeoverAnswer → the end-to-end case's direct
 *    check (the host ACL refuses a non-opener first, so only a direct call reaches it);
 *  - put a `value` on the recorded take-over → the end-to-end case's event-log check.
 * The event log is read from storage: the events ROUTE streams, and a JSON read of
 * it was `{}`, against which a "contains no value" check could not fail.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';

vi.mock('node:dns/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  return { ...orig, lookup, default: { ...orig, lookup } };
});
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createOrg } from '../src/host/accessControlService.js';
import { startTask, completeTakeover, MAX_TAKEOVERS } from '../src/features/computer-use/computerUseService.js';
import { hostLoopAdapter } from '../src/features/computer-use/hostLoopAdapter.js';
import { makeFakeExecutor } from '../src/features/computer-use/fakeExecutor.js';
import { scriptedDriver, type DriverDecision } from '../src/features/computer-use/browserDriver.js';
import { attachExecutor, executorFor, _resetExecutorRegistry } from '../src/features/computer-use/executorRegistry.js';
import { sessions, putSession, getSession } from '../src/features/computer-use/sessionStore.js';
import { projectSession } from '../src/features/computer-use/routes.js';
import { sweepComputerUseSessions } from '../src/features/computer-use/revocation.js';
import { verifiedTakeoverAnswer } from '../src/features/computer-use/approvalBinding.js';
import type { PageSnapshot } from '../src/features/computer-use/executorProtocol.js';
import type { CuAction } from '../src/features/computer-use/adapter.js';

let server: http.Server;
let BASE = '';
let appStorage: { listEvents(runId: string, o: { fromSeq: number; limit: number }): Promise<Array<{ type: string }>> } | undefined;
const T = 'tenant-cu-p3a';
const ORG = 'org-p3a';
const ORIGIN = 'https://shop.example.com';
const LOGIN = `${ORIGIN}/login`;
const HOME = `${ORIGIN}/home`;
const SECRET = 'S3cret-value-9f2c';

const loginPage: PageSnapshot = {
  url: LOGIN, title: 'Sign in', text: 'Sign in to continue',
  elements: [
    { ref: 'u1', role: 'textbox', name: 'Email', inputType: 'email' },
    { ref: 'p1', role: 'textbox', name: 'Password', inputType: 'password' },
    { ref: 's1', role: 'button', name: 'Sign in', submits: true },
  ],
};
// After the person signed in. A misbehaving executor even reports the password
// field's VALUE; the protocol validator must drop it.
const homePage = {
  url: HOME, title: 'Home', text: 'Welcome back',
  elements: [{ ref: 'h1', role: 'link', name: 'Orders', href: `${ORIGIN}/orders`, value: SECRET }],
} as unknown as PageSnapshot;

let n = 0;
const input = (task: string, runId = `run-open-${++n}`) => ({
  tenantId: T, orgId: ORG, createdBy: 'u1', task: `${task} #${++n}`, startUrl: LOGIN, allowedOrigins: [ORIGIN], runId,
});
const setup = (decisions: DriverDecision[]) => {
  const pages: Record<string, PageSnapshot> = { [LOGIN]: loginPage, [HOME]: homePage };
  const executor = makeFakeExecutor({ pages });
  attachExecutor(T, 'u1', executor);
  const driver = scriptedDriver(decisions);
  return { executor, driver, adapter: hostLoopAdapter({ driver, executor: () => executorFor(T, 'u1'), opTimeoutMs: 50 }), pages };
};
const typePassword: DriverDecision = { kind: 'op', op: { op: 'type', ref: 'p1', text: 'model-would-type-this' } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COMPUTER_USE_PROVIDER = 'mock';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr1136-p3a', serviceVersion: '0.0.1', enableConsoleTracer: false });
  appStorage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['computer-use', 'users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await createOrg({ tenantId: T, createdBy: 'test', name: 'CU p3a', orgId: ORG, ownerSubject: 'u1' });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { _resetExecutorRegistry(); });

describe('ADR 1136 P3a — the host-run loop hands a credential step to the person', () => {
  it('a credential field is handed over: the agent never types, and the origin is the page the executor reported', async () => {
    const { executor, adapter } = setup([typePassword]);
    const v = await startTask(adapter, input('signin'));
    expect(v.status).toBe('awaiting_takeover');
    expect(v.takeover?.origin).toBe(ORIGIN);
    expect(v.takeover?.reason).toBe('credential');
    expect(executor.calls.some((c) => c.op === 'type')).toBe(false);
  });

  it('continue needs a verified answer, from the opening run, once; then the page is read afresh', async () => {
    const { executor, adapter, driver } = setup([typePassword, { kind: 'done', summary: 'signed in' }]);
    const i = input('continue');
    const v = await startTask(adapter, i);
    expect(v.status).toBe('awaiting_takeover');
    const base = { tenantId: T, sessionId: v.sessionId, actor: 'u1', proceed: true };
    await expect(completeTakeover(adapter, { ...base, runId: i.runId })).rejects.toMatchObject({ code: 'approval_required' });
    expect((await completeTakeover(adapter, { ...base, runId: 'run-fork', takeoverInterruptId: 'itr-a' })).status).toBe('awaiting_takeover');
    await expect(completeTakeover(adapter, { ...base, actor: 'u2', runId: i.runId, takeoverInterruptId: 'itr-a' })).rejects.toMatchObject({ httpStatus: 403 });
    executor.calls.length = 0;
    const done = await completeTakeover(adapter, { ...base, runId: i.runId, takeoverInterruptId: 'itr-a' });
    expect(done.status).toBe('completed');
    expect(executor.calls[0]).toEqual({ op: 'snapshot' });
    expect(driver.seen.at(-1)!.history.at(-1)!.outcome).toBe('handed_over');
    // The answer is spent: it cannot resume a later take-over.
    const row = (await getSession(T, v.sessionId))!;
    expect(row.consumedApprovals).toContain('itr-a');
  });

  it('stop ends the session from any run the opener acts in', async () => {
    const { adapter } = setup([typePassword]);
    const v = await startTask(adapter, input('stop'));
    const stopped = await completeTakeover(adapter, { tenantId: T, sessionId: v.sessionId, actor: 'u1', proceed: false, runId: 'run-other' });
    expect([stopped.status, stopped.error]).toEqual(['aborted', 'stopped_at_takeover']);
  });

  it('an expired take-over ends instead of resuming', async () => {
    const { adapter } = setup([typePassword]);
    const i = input('expire');
    const v = await startTask(adapter, i);
    const row = (await getSession(T, v.sessionId))!;
    await putSession({ ...row, takeover: { ...row.takeover!, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    const out = await completeTakeover(adapter, { tenantId: T, sessionId: v.sessionId, actor: 'u1', proceed: true, runId: i.runId, takeoverInterruptId: 'itr-x' });
    expect([out.status, out.error]).toEqual(['aborted', 'takeover_expired']);
  });

  it('the sweep ends a take-over nobody answered in time, releasing the browser', async () => {
    const { adapter } = setup([typePassword]);
    const v = await startTask(adapter, input('sweep'));
    const row = (await getSession(T, v.sessionId))!;
    expect(row.status).toBe('awaiting_takeover');
    await putSession({ ...row, takeover: { ...row.takeover!, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    await sweepComputerUseSessions({ getRun: async () => null });
    const ended = (await getSession(T, v.sessionId))!;
    expect([ended.status, ended.error, ended.takeover]).toEqual(['aborted', 'takeover_expired', undefined]);
  });

  it(`at most ${MAX_TAKEOVERS} take-overs; the next credential step fails the session`, async () => {
    const decisions: DriverDecision[] = Array.from({ length: MAX_TAKEOVERS + 1 }, () => typePassword);
    const { adapter } = setup(decisions);
    const i = input('cap');
    let v = await startTask(adapter, i);
    for (let k = 1; k <= MAX_TAKEOVERS; k += 1) {
      expect(v.status, `take-over ${k}`).toBe('awaiting_takeover');
      v = await completeTakeover(adapter, { tenantId: T, sessionId: v.sessionId, actor: 'u1', proceed: true, runId: i.runId, takeoverInterruptId: `itr-cap-${k}` });
    }
    expect([v.status, v.error]).toEqual(['failed', 'takeover_limit_reached']);
  });

  it('a secret typed by the person reaches neither the model input nor the session record', async () => {
    const { adapter, driver, pages } = setup([typePassword, { kind: 'op', op: { op: 'scroll', dy: 1 } }, { kind: 'done', summary: 'ok' }]);
    const i = input('secret');
    const v = await startTask(adapter, i);
    // The person signs in in the browser window: the page moves on.
    pages[LOGIN] = homePage;
    await completeTakeover(adapter, { tenantId: T, sessionId: v.sessionId, actor: 'u1', proceed: true, runId: i.runId, takeoverInterruptId: 'itr-s' });
    expect(driver.seen.map((x) => x.snapshot).join('\n')).not.toContain(SECRET);
    const row = (await getSession(T, v.sessionId))!;
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(JSON.stringify(projectSession(row))).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain('model-would-type-this');
  });
});

describe('ADR 1136 P3a — end to end: only the opener can continue a take-over', () => {
  const act = (actionId: string, kind: CuAction['kind'], url?: string): CuAction => ({ actionId, kind, description: `${kind}`, ...(url ? { url } : {}) });
  function client() {
    let cookie = '';
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
  }
  const bare = (id: string) => id.replace(/^.*\//, '');

  it('the run suspends on a take-over card naming the real origin; a non-opener is refused; the opener continues', async () => {
    const tenantId = `org:cu-p3a-${Date.now()}`;
    const opener = client();
    const login = await opener('POST', '/host/openwop-app/test/login', { email: `p3a-o-${Date.now()}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const orgId = (await opener('POST', '/host/openwop-app/orgs', { name: 'P3a' })).json.orgId as string;
    const task = `mock:${JSON.stringify({ actions: [act('c1', 'credential', `${ORIGIN}/login`), act('a2', 'screenshot')], resultSummary: 'done', takeover: true })}`;
    const wf = await opener('POST', '/host/openwop-app/workflows/from-chain', { chainId: 'computer-use.run-task', params: { orgId, task, startUrl: `${ORIGIN}/login`, allowedOrigins: [ORIGIN] } });
    const run = await opener('POST', '/runs', { workflowId: wf.json.workflowId, inputs: {} });
    const runId = run.json.runId as string;
    let open: Array<{ nodeId: string; kind: string; data: Record<string, any> }> = [];
    for (let k = 0; k < 120 && open.length === 0; k++) {
      await new Promise((r) => setTimeout(r, 50));
      open = (await opener('GET', `/host/openwop-app/runs/${bare(runId)}/interrupts`)).json?.interrupts ?? [];
    }
    expect(open.length, 'the run reaches the take-over').toBe(1);
    const itr = open[0]!;
    expect(itr.kind).toBe('clarification');
    expect(itr.data.computerUseTakeover?.origin).toBe(ORIGIN);
    expect(itr.data.approverRefs).toHaveLength(1);
    // What is persisted about the take-over is exactly this, and no value.
    expect(Object.keys(itr.data.computerUseTakeover).sort()).toEqual(['expiresAt', 'label', 'n', 'origin', 'reason', 'sessionId']);

    // Someone else in the workspace answers "continue": refused.
    const other = client();
    await other('POST', '/host/openwop-app/test/login', { email: `p3a-x-${Date.now()}@acme.test`, tenantId });
    const forged = await other('POST', `/runs/${runId}/interrupts/${itr.nodeId}`, { resumeValue: { action: 'continue' } });
    // The host's approver ACL refuses them (ADR 0932): the card names the opener alone.
    expect([forged.status, forged.json.error]).toEqual([403, 'forbidden']);
    const still = (await sessions.listByPrefix(`${tenantId}:`))[0]!;
    expect(still.status).toBe('awaiting_takeover');

    // The opener continues: the session runs to completion.
    const ok = await opener('POST', `/runs/${runId}/interrupts/${itr.nodeId}`, { resumeValue: { action: 'continue' } });
    expect(ok.status).toBeLessThan(300);
    let status = '';
    for (let k = 0; k < 120; k++) {
      await new Promise((r) => setTimeout(r, 50));
      status = (await sessions.listByPrefix(`${tenantId}:`))[0]!.status;
      if (status === 'completed' || status === 'failed' || status === 'aborted') break;
    }
    expect(status).toBe('completed');
    // The run's events, which debug bundles are built from, carry no field value
    // and no typed text.
    // Read from storage, not the events route: that route streams, so a JSON read of
    // it is `{}`, and a "contains nothing" check over `{}` cannot fail.
    const st = appStorage!;
    const evs = [...await st.listEvents(runId, { fromSeq: -1, limit: 1000 }), ...await st.listEvents(bare(runId), { fromSeq: -1, limit: 1000 })];
    expect(evs.length, 'the run has events to inspect').toBeGreaterThan(3);
    expect(evs.some((e) => e.type === 'node.suspended'), 'including the take-over suspend').toBe(true);
    const text = JSON.stringify(evs);
    expect(text, 'the take-over itself is in the log').toContain('"takeover":{"n":1,"reason":"credential"');

    // The surface's own check, against the real recorded interrupt (defence in depth
    // behind the host ACL): the opener's answer verifies; the same record presented
    // for a session claiming another opener does not.
    const asRaised = { ...still, consumedApprovals: [] };
    // The run id the surface sees is the stored one, not the wire id POST /runs returned.
    const storedRunId = (evs[0] as unknown as { runId: string }).runId;
    await expect(verifiedTakeoverAnswer({ runId: storedRunId, nodeId: itr.nodeId, session: asRaised })).resolves.toEqual(expect.any(String));
    await expect(verifiedTakeoverAnswer({ runId: storedRunId, nodeId: itr.nodeId, session: { ...asRaised, createdBy: 'user:someone-else' } })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(verifiedTakeoverAnswer({ runId: storedRunId, nodeId: itr.nodeId, session: { ...asRaised, takeover: { ...asRaised.takeover!, origin: 'https://look-alike.example' } } })).rejects.toMatchObject({ code: 'approval_required' });
    expect(text).not.toMatch(/"value"\s*:/);
    expect(text).not.toMatch(/"op"\s*:\s*"type"/);
  }, 60_000);
});
