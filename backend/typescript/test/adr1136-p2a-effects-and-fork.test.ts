/**
 * ADR 1136 P2a — two of the release manager's P2 conditions, through the REAL
 * session service with the fake executor:
 *
 *  - entry criterion 3: a page script that turns an interact step into a submit
 *    ends the session `unapproved_effect` (one final read for the record, the
 *    step recorded `uncertain`, never resumed);
 *  - condition 4 (the WFAWF-24 lesson): a forked or re-run run that lands on an
 *    existing session reads the record and never reaches the browser.
 *
 * Sabotage witnesses (each red, then restored):
 *  - drop the `effects` check in `submitDecision` → "a checkbox whose script submits";
 *  - make `drivableBy` always true → "a forked run reads the record";
 *  - guard deny as well as approve in `decide` → "a forked run's deny still ends";
 *  - accept `effects` with an extra key in `validateResult` → "effects are validated".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { startTask, decide, resumeSession } from '../src/features/computer-use/computerUseService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { hostLoopAdapter } from '../src/features/computer-use/hostLoopAdapter.js';
import { makeFakeExecutor } from '../src/features/computer-use/fakeExecutor.js';
import { scriptedDriver, type DriverDecision } from '../src/features/computer-use/browserDriver.js';
import { attachExecutor, executorFor, _resetExecutorRegistry } from '../src/features/computer-use/executorRegistry.js';
import { validateResult, type PageSnapshot } from '../src/features/computer-use/executorProtocol.js';

let server: http.Server;
const T = 'tenant-cu-p2a';
const ORG = 'org-p2a';
const ORIGIN = 'https://shop.example.com';
const FORM = `${ORIGIN}/form`;
const SENT = `${ORIGIN}/sent`;

const formPage: PageSnapshot = {
  url: FORM, title: 'Form', text: 'Subscribe',
  elements: [
    { ref: 'f1', role: 'checkbox', name: 'Agree to terms' },
    { ref: 'f2', role: 'textbox', name: 'Name' },
    { ref: 'f3', role: 'button', name: 'Send', submits: true },
  ],
};
const sentPage: PageSnapshot = { url: SENT, title: 'Sent', text: 'Thanks', elements: [] };
const PAGES = { [FORM]: formPage, [SENT]: sentPage };

let n = 0;
const input = (task: string, runId?: string) => ({
  tenantId: T, orgId: ORG, createdBy: 'u1', task: `${task} #${++n}`, startUrl: FORM, allowedOrigins: [ORIGIN],
  ...(runId ? { runId } : {}),
});
const setup = (decisions: DriverDecision[], exec: Parameters<typeof makeFakeExecutor>[0] = { pages: PAGES }) => {
  const executor = makeFakeExecutor(exec);
  attachExecutor(T, 'u1', executor);
  const driver = scriptedDriver(decisions);
  return { executor, driver, adapter: hostLoopAdapter({ driver, executor: () => executorFor(T, 'u1'), opTimeoutMs: 50 }) };
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  const d = getToggleDefault('computer-use'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  await createOrg({ tenantId: T, createdBy: 'test', name: 'CU p2a', orgId: ORG, ownerSubject: 'u1' });
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { _resetExecutorRegistry(); });

describe('ADR 1136 P2 entry criterion 3 — a script-promoted interact step', () => {
  it('a checkbox whose script submits ends the session unapproved_effect, after one final read', async () => {
    const { executor, adapter, driver } = setup([
      { kind: 'op', op: { op: 'click', ref: 'f1' } },
      { kind: 'op', op: { op: 'scroll', dy: 1 } },
    ], { pages: PAGES, submitsTo: { f1: SENT } });
    const v = await startTask(adapter, input('checkbox'));
    expect([v.status, v.error]).toEqual(['failed', 'unapproved_effect']);
    const i = executor.calls.findIndex((c) => c.op === 'click');
    expect(executor.calls.slice(i + 1)).toEqual([{ op: 'snapshot' }]);
    expect(driver.seen).toHaveLength(1); // no further driver step
    expect(executor.current()).toBe(SENT);
  });

  it('a script-bound Tab handler that submits ends it the same way; Tab with no effect does not', async () => {
    const promoted = setup([{ kind: 'op', op: { op: 'press', ref: 'f2', key: 'Tab' } }], { pages: PAGES, submitsTo: { f2: SENT }, scriptSubmitsOnKey: true });
    expect((await startTask(promoted.adapter, input('tab-submits'))).error).toBe('unapproved_effect');
    const plain = setup([{ kind: 'op', op: { op: 'press', ref: 'f2', key: 'Tab' } }, { kind: 'done', summary: 'ok' }]);
    expect((await startTask(plain.adapter, input('tab-plain'))).status).toBe('completed');
  });

  it('a commit step that navigates is what was approved, so it continues', async () => {
    const { adapter } = setup([{ kind: 'op', op: { op: 'click', ref: 'f3' } }, { kind: 'done', summary: 'sent' }], { pages: PAGES, submitsTo: { f3: SENT } });
    const halted = await startTask(adapter, input('commit'));
    expect(halted.status).toBe('awaiting_approval');
    const done = await decide(adapter, { tenantId: T, sessionId: halted.sessionId, approve: true, actor: 'u1', approvalInterruptId: 'itr-p2a-1' });
    expect(done.status).toBe('completed');
  });

  it('effects are validated: an extra key or a non-boolean is a bad_result', () => {
    expect(validateResult({ op: 'click', ref: 'f1' }, { ok: true, effects: { navigated: true, submitted: false } })).toEqual({ ok: true, effects: { navigated: true, submitted: false } });
    expect(validateResult({ op: 'click', ref: 'f1' }, { ok: true, effects: { navigated: true, submitted: false, url: 'x' } })).toEqual({ ok: false, error: 'bad_result' });
    expect(validateResult({ op: 'click', ref: 'f1' }, { ok: true, effects: { navigated: 'yes', submitted: false } })).toEqual({ ok: false, error: 'bad_result' });
    expect(validateResult({ op: 'click', ref: 'f1' }, { ok: true, effects: null })).toEqual({ ok: false, error: 'bad_result' });
  });
});

describe('ADR 1136 P2a condition 4 — a forked run never drives the browser', () => {
  it('a forked run reads the record; only the opening run advances and decides', async () => {
    const { executor, adapter } = setup([
      { kind: 'op', op: { op: 'click', ref: 'f3' } },
      { kind: 'done', summary: 'sent' },
    ], { pages: PAGES, submitsTo: { f3: SENT } });
    const opener = input('fork', 'run-open');
    const halted = await startTask(adapter, opener);
    expect(halted.status).toBe('awaiting_approval');
    const before = executor.calls.length;

    const forked = { ...opener, runId: 'run-fork' };
    expect((await startTask(adapter, forked)).status).toBe('awaiting_approval');
    const decidedByFork = await decide(adapter, { tenantId: T, sessionId: halted.sessionId, approve: true, actor: 'u1', runId: 'run-fork', approvalInterruptId: 'itr-p2a-fork' });
    expect(decidedByFork.status).toBe('awaiting_approval');
    expect((await resumeSession(adapter, { tenantId: T, sessionId: halted.sessionId, actor: 'u1', runId: 'run-fork' })).status).toBe('awaiting_approval');
    expect(executor.calls.length).toBe(before);

    const done = await decide(adapter, { tenantId: T, sessionId: halted.sessionId, approve: true, actor: 'u1', runId: 'run-open', approvalInterruptId: 'itr-p2a-open' });
    expect(done.status).toBe('completed');
    expect(executor.calls.length).toBeGreaterThan(before);
  });

  it("it restricts driving, not stopping: a forked run's deny still ends the session", async () => {
    const { adapter } = setup([{ kind: 'op', op: { op: 'click', ref: 'f3' } }], { pages: PAGES, submitsTo: { f3: SENT } });
    const opener = input('fork-deny', 'run-open-2');
    const halted = await startTask(adapter, opener);
    expect(halted.status).toBe('awaiting_approval');
    const denied = await decide(adapter, { tenantId: T, sessionId: halted.sessionId, approve: false, actor: 'u1', runId: 'run-fork-2' });
    expect(denied.status).toBe('denied');
    // and the opening run cannot revive it
    await expect(decide(adapter, { tenantId: T, sessionId: halted.sessionId, approve: true, actor: 'u1', runId: 'run-open-2', approvalInterruptId: 'itr-p2a-late' })).rejects.toMatchObject({ httpStatus: 409 });
  });
});
