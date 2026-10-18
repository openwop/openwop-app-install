/**
 * ADR 0889 post-merge architect review (2026-10-15) — H3, H4, M2, L4 and the
 * kvAgeOut index. H1 is `adr0889-toggle-gate.test.ts`; H2 is
 * `adr0889-cost-ceiling.test.ts`; M1 is the resume test in `adr0889-eval-run.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { hostExtCollectionForPrefix } from '../src/host/hostExtPersistence.js';
import { listRunBoundary, listRunBoundaryWraps, maybeCaptureExecuteTool, setCaptureSetting } from '../src/host/evals/toolBoundary.js';
import { buildTaskFromRun } from '../src/host/evals/promoteRun.js';
import { eraseSubjectEvalSuites, getEvalSuite, lockEvalSuite, putEvalSuite, suiteDigest, validateEvalSuite } from '../src/host/evals/suiteStore.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const TENANT = 'default';
const AGENT = 'eval.review-agent';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const SUITE = (suiteId: string, tasks: unknown[] = [{ taskId: 't', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }]) =>
  validateEvalSuite({ suiteId, version: '1.0.0', modes: ['golden'], tasks });

describe('review H3 — capture rows survive across turns/nodes of one run', () => {
  it('two wraps of the same run keep every call, in order', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    const echo = async (call: { name: string }) => ({ content: JSON.stringify({ tool: call.name }) });
    const turn1 = await maybeCaptureExecuteTool(echo as never, { tenantId: TENANT, runId: 'r-h3', agentId: AGENT, segment: 'turn-1' });
    for (const n of ['a1', 'a2', 'a3']) await turn1({ name: n, input: {} } as never);
    await new Promise((r) => setTimeout(r, 2));
    const turn2 = await maybeCaptureExecuteTool(echo as never, { tenantId: TENANT, runId: 'r-h3', agentId: AGENT, segment: 'turn-2' });
    for (const n of ['b1', 'b2']) await turn2({ name: n, input: {} } as never);
    const rows = await listRunBoundary(TENANT, 'r-h3');
    expect(rows.map((r) => r.tool)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
    const wraps = await listRunBoundaryWraps(TENANT, 'r-h3');
    expect(wraps.map((w) => [w.segment, w.calls])).toEqual([['turn-1', 3], ['turn-2', 2]]);
    expect((await listRunBoundary(TENANT, 'r-h3', { wrapId: wraps[1]!.wrapId })).map((r) => r.tool)).toEqual(['b1', 'b2']);
  });

  it('the kvAgeOut collection carries no unused tenant index', () => {
    expect(hostExtCollectionForPrefix('hostext:agent:tool-boundary:')?.indexed).toBe(false);
  });

  it('review L4 — a captured result gets the known-secret pass too', async () => {
    await setCaptureSetting(TENANT, AGENT, true);
    const leak = await maybeCaptureExecuteTool((async () => ({ content: 'key sk-ant-api03-SECRETSECRETSECRETSECRETSECRET' })) as never, { tenantId: TENANT, runId: 'r-l4', agentId: AGENT });
    await leak({ name: 'x', input: {} } as never);
    expect(JSON.stringify(await listRunBoundary(TENANT, 'r-l4'))).not.toContain('SECRETSECRET');
  });
});

describe('review H4 — a promoted case does not outlive the subject\'s erasure', () => {
  it('erasure redacts the subject inside promoted task content, even on a locked suite', async () => {
    const task = buildTaskFromRun({
      taskId: 'promoted', input: { q: 'refund for alice@example.com' },
      boundary: [{ tool: 'crm:lookup', input: { email: 'alice@example.com' }, result: '{"name":"Alice","email":"alice@example.com"}', isError: false }],
    });
    const h4 = await putEvalSuite(TENANT, SUITE('test.acme.evals.h4', [task]), 'user:owner');
    await lockEvalSuite(TENANT, 'test.acme.evals.h4@1.0.0', suiteDigest(h4.suite));
    await eraseSubjectEvalSuites(TENANT, 'alice@example.com');
    const after = await getEvalSuite(TENANT, 'test.acme.evals.h4@1.0.0');
    expect(JSON.stringify(after?.suite)).not.toContain('alice@example.com');
    expect(after?.lockedAt).toBeTruthy();
    // EVD-10 — the row says why an exact-args fixture may now miss.
    expect(after?.erasedAt).toBeTruthy();
    expect(after?.erasedTasks).toBe(1);
  });
});

describe('review M2 — a run-referenced (locked) suite cannot be deleted and re-created', () => {
  it('DELETE of a locked version is a 409; an unlocked one deletes', async () => {
    const m2 = await putEvalSuite(TENANT, SUITE('test.acme.evals.m2'), 'user:owner');
    await lockEvalSuite(TENANT, 'test.acme.evals.m2@1.0.0', suiteDigest(m2.suite));
    const locked = await fetch(`${base}/host/openwop-app/agent-evals/suites/test.acme.evals.m2@1.0.0`, { method: 'DELETE', headers: V2 });
    expect(locked.status).toBe(409);
    expect(((await locked.json()) as { details?: { reason?: string } }).details?.reason).toBe('suite_locked');
    await putEvalSuite(TENANT, SUITE('test.acme.evals.m2b'), 'user:owner');
    const open = await fetch(`${base}/host/openwop-app/agent-evals/suites/test.acme.evals.m2b@1.0.0`, { method: 'DELETE', headers: V2 });
    expect(open.status).toBe(204);
  });
});

describe('review M1 — resume re-emits a recorded trial\'s missing eval.scored, never re-runs it', () => {
  it('a trial persisted before a crash is emitted once on resume and not dispatched again', async () => {
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const { buildRunRecord } = await import('../src/host/runDispatch.js');
    const { runAgentEval, AGENT_SUITE_KIND } = await import('../src/host/evals/agentEvalRun.js');
    const { getEventLog } = await import('../src/executor/eventLog.js');
    const { evalWorkflowId } = await import('../src/host/evals/suiteStore.js');
    const suite = SUITE('test.acme.evals.m1');
    const storage = hostExtStorage();
    const recorded = { score: 1, passed: true, scoreLabel: 'pass', evaluatorType: 'deterministic', costUsd: 0, latencyMs: 1, efficiency: { toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 }, fixtureMissCount: 0 };
    const run = buildRunRecord({ workflowId: evalWorkflowId('test.acme.evals.m1@1.0.0'), tenantId: TENANT, inputs: {}, metadata: {}, configurable: {}, now: new Date().toISOString() } as never);
    run.status = 'running';
    run.metadata = { mode: 'eval', eval: { kind: AGENT_SUITE_KIND, suiteRef: 'test.acme.evals.m1@1.0.0', suiteSource: 'tenant', agentId: AGENT, rfc0244Wire: false, progress: { t: { '0': recorded } } } };
    await storage.insertRun(run);
    let dispatched = 0;
    await runAgentEval({ storage, run, suite, dispatch: (async () => { dispatched += 1; throw new Error('must not run'); }) as never }, { resume: true });
    expect(dispatched).toBe(0);
    const scored = (await getEventLog().list(run.runId, { limit: 500 })).filter((e) => e.type === 'eval.scored');
    expect(scored).toHaveLength(1);
  });
});
