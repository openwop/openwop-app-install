/**
 * ADR 0477 — workflow evaluations through the real app: closed-world set
 * validation, the run→verdict loop (positive, negative-status, pinned-mock,
 * judge-unavailable, timeout), and the evals-green promote gate
 * (failing → 409, green → promote, head-move → stale 409).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('workflow evaluations (ADR 0477, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/v1/host/openwop-app/workflows';
  const WF = 'eval-wf-chain';       // a → b (noop)
  const WF_FAIL = 'eval-wf-fail';   // boom (core.fail)
  const WF_GATE = 'eval-wf-gate';   // transient draft for the promote gate
  const WF_WAIT = 'eval-wf-wait';   // approvalGate — suspends (timeout case)

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    process.env.OPENWOP_EVAL_CASE_TIMEOUT_MS = '600';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

    const mk = (workflowId: string, nodes: Array<{ nodeId: string; typeId: string; config?: Record<string, unknown> }>, edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }> = []) =>
      call('POST', API, { workflowId, nodes, edges, metadata: { name: workflowId, lifecycle: { transient: true, generatedBy: 'test' } } });
    expect((await mk(WF, [
      { nodeId: 'a', typeId: 'core.noop' },
      { nodeId: 'b', typeId: 'core.noop' },
    ], [{ edgeId: 'e-ab', sourceNodeId: 'a', targetNodeId: 'b' }])).status).toBe(201);
    expect((await mk(WF_FAIL, [{ nodeId: 'boom', typeId: 'core.fail' }])).status).toBe(201);
    expect((await mk(WF_GATE, [{ nodeId: 'g', typeId: 'core.noop' }])).status).toBe(201);
    expect((await mk(WF_WAIT, [{ nodeId: 'gate', typeId: 'core.approvalGate' }])).status).toBe(201);
  });
  afterAll(async () => {
    delete process.env.OPENWOP_EVAL_CASE_TIMEOUT_MS;
    await new Promise<void>((res) => server.close(() => res()));
  });

  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  }

  interface ResultRow {
    resultId: string; status: string; revisionHash: string;
    cases: Array<{ caseId: string; runId: string; status: string; assertions: Array<{ kind: string; pass: boolean; detail?: string }> }>;
  }
  async function awaitResult(workflowId: string, evalSetId: string, resultId: string): Promise<ResultRow> {
    for (let i = 0; i < 300; i += 1) {
      const r = await call<{ items: ResultRow[] }>('GET', `${API}/${workflowId}/eval-results?evalSetId=${evalSetId}`);
      const row = r.body.items?.find((x) => x.resultId === resultId);
      if (row && row.status === 'complete') return row;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('eval result never completed');
  }

  describe('set validation (closed world)', () => {
    it('rejects unknown assertion kinds, duplicate caseIds, and empty cases', async () => {
      const put = (body: unknown) => call('PUT', `${API}/${WF}/eval-sets/v1`, body);
      expect((await put({ name: 'x', cases: [] })).status).toBe(400);
      expect((await put({ name: 'x', cases: [{ caseId: 'c1', assertions: [{ kind: 'nope' }] }] })).status).toBe(400);
      expect((await put({
        name: 'x',
        cases: [
          { caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] },
          { caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] },
        ],
      })).status).toBe(400);
      expect((await put({ name: 'x', cases: [{ caseId: 'c1', assertions: [] }] })).status).toBe(400);
    });

    it('unknown workflow is a 404 on every verb (owner posture)', async () => {
      expect((await call('GET', `${API}/does-not-exist/eval-sets`)).status).toBe(404);
      expect((await call('PUT', `${API}/does-not-exist/eval-sets/x`, { name: 'x', cases: [{ caseId: 'c', assertions: [{ kind: 'status', value: 'completed' }] }] })).status).toBe(404);
      expect((await call('POST', `${API}/does-not-exist/eval-sets/x/run`)).status).toBe(404);
      expect((await call('GET', `${API}/does-not-exist/eval-results`)).status).toBe(404);
    });
  });

  describe('run → verdicts', () => {
    it('a full pass: fresh-run case + pinned-mock case, per-assertion verdicts', async () => {
      const put = await call('PUT', `${API}/${WF}/eval-sets/smoke`, {
        name: 'Smoke',
        cases: [
          {
            caseId: 'fresh',
            inputs: { marker: 'EVAL-X' },
            assertions: [
              { kind: 'status', value: 'completed' },
              { kind: 'output-contains', value: 'EVAL-X' },
              { kind: 'node-completed', nodeId: 'b' },
            ],
          },
          {
            caseId: 'mocked',
            pins: [{ nodeId: 'a', output: { marker: 'PINNED-EVAL' } }],
            assertions: [
              { kind: 'status', value: 'completed' },
              { kind: 'output-contains', value: 'PINNED-EVAL' },
              { kind: 'node-not-run', nodeId: 'a' },  // pinned = mocked, never ran live
              { kind: 'node-completed', nodeId: 'b' },
            ],
          },
        ],
      });
      expect(put.status).toBe(201);
      const run = await call<{ resultId: string; cases: number }>('POST', `${API}/${WF}/eval-sets/smoke/run`);
      expect(run.status).toBe(202);
      expect(run.body.cases).toBe(2);
      const result = await awaitResult(WF, 'smoke', run.body.resultId);
      expect(result.revisionHash).toBeTruthy();
      const fresh = result.cases.find((c) => c.caseId === 'fresh')!;
      expect(fresh.status).toBe('passed');
      expect(fresh.runId).toBeTruthy();
      const mocked = result.cases.find((c) => c.caseId === 'mocked')!;
      expect(mocked.status).toBe('passed');
      expect(mocked.assertions.every((a) => a.pass)).toBe(true);
    });

    it('a negative test: asserting status=failed on a failing workflow PASSES', async () => {
      expect((await call('PUT', `${API}/${WF_FAIL}/eval-sets/neg`, {
        name: 'Negative',
        cases: [{ caseId: 'boom', assertions: [{ kind: 'status', value: 'failed' }] }],
      })).status).toBe(201);
      const run = await call<{ resultId: string }>('POST', `${API}/${WF_FAIL}/eval-sets/neg/run`);
      const result = await awaitResult(WF_FAIL, 'neg', run.body.resultId);
      expect(result.cases[0]!.status).toBe('passed');
    });

    it('a failing assertion yields a FAILED case with the detail visible', async () => {
      expect((await call('PUT', `${API}/${WF}/eval-sets/redherring`, {
        name: 'Red',
        cases: [{ caseId: 'c', inputs: { marker: 'YES' }, assertions: [{ kind: 'output-contains', value: 'ABSENT-TOKEN' }] }],
      })).status).toBe(201);
      const run = await call<{ resultId: string }>('POST', `${API}/${WF}/eval-sets/redherring/run`);
      const result = await awaitResult(WF, 'redherring', run.body.resultId);
      expect(result.cases[0]!.status).toBe('failed');
      expect(result.cases[0]!.assertions[0]!.pass).toBe(false);
      expect(result.cases[0]!.assertions[0]!.detail).toContain('ABSENT-TOKEN');
    });

    it('an llm-judge assertion without a provider FAILS with a named reason (never silently passes)', async () => {
      expect((await call('PUT', `${API}/${WF}/eval-sets/judge`, {
        name: 'Judge',
        cases: [{ caseId: 'c', inputs: {}, assertions: [{ kind: 'llm-judge', criteria: 'The output is polite.' }] }],
      })).status).toBe(201);
      const run = await call<{ resultId: string }>('POST', `${API}/${WF}/eval-sets/judge/run`);
      const result = await awaitResult(WF, 'judge', run.body.resultId);
      expect(result.cases[0]!.status).toBe('failed');
      const a = result.cases[0]!.assertions[0]!;
      expect(a.pass).toBe(false);
      expect(a.detail).toMatch(/judge_(unavailable|error)/);
    });

    it('a run that suspends on a gate is TIMED OUT with an honest verdict', async () => {
      expect((await call('PUT', `${API}/${WF_WAIT}/eval-sets/hang`, {
        name: 'Hang',
        cases: [{ caseId: 'c', assertions: [{ kind: 'status', value: 'completed' }] }],
      })).status).toBe(201);
      const run = await call<{ resultId: string }>('POST', `${API}/${WF_WAIT}/eval-sets/hang/run`);
      const result = await awaitResult(WF_WAIT, 'hang', run.body.resultId);
      expect(result.cases[0]!.status).toBe('timed_out');
      expect(result.cases[0]!.assertions[0]!.detail).toContain('interrupt gate');
    });
  });

  describe('concurrent settles (review HIGH-1 regression)', () => {
    it('two near-simultaneous case settles both land (no lost update)', async () => {
      const { newEvalResultRow, putEvalResult, settleEvalCase, getEvalResult } = await import('../src/host/workflowEvalSets.js');
      const parts = { tenantId: 'default', workflowId: 'race-wf', evalSetId: 'race-set', resultId: 'race-1' };
      await putEvalResult(newEvalResultRow({
        ...parts, revisionHash: 'x'.repeat(64), caseIds: ['c1', 'c2'],
      }));
      // Fire both settles in the same tick — the raw read-modify-write lost
      // one of these before the per-key serialization landed.
      await Promise.all([
        settleEvalCase(parts, { caseId: 'c1', runId: 'r1', status: 'passed', assertions: [{ kind: 'status', pass: true }] }),
        settleEvalCase(parts, { caseId: 'c2', runId: 'r2', status: 'failed', assertions: [{ kind: 'status', pass: false }] }),
      ]);
      const row = await getEvalResult(parts.tenantId, parts.workflowId, parts.evalSetId, parts.resultId);
      expect(row!.status).toBe('complete');
      expect(row!.cases.find((c) => c.caseId === 'c1')!.status).toBe('passed');
      expect(row!.cases.find((c) => c.caseId === 'c2')!.status).toBe('failed');
    });
  });

  describe('grade-trio regressions', () => {
    it('an UNKNOWN persisted assertion kind fails closed, never silently passes (grade-data M5)', async () => {
      const { evaluateAssertions } = await import('../src/host/workflowEvalRunner.js');
      const rogue = [{ kind: 'assert-vibes', value: 'x' }] as unknown as Parameters<typeof evaluateAssertions>[0];
      const verdicts = await evaluateAssertions(rogue, {
        status: 'completed', output: {}, completedNodes: new Set<string>(), touchedNodes: new Set<string>(),
      });
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]!.pass).toBe(false);
      expect(verdicts[0]!.detail).toContain('unknown_assertion_kind');
    });

    it('subject erasure scrubs fixture payloads and verdict details (grade-data H3)', async () => {
      const { putEvalSet, getEvalSet, newEvalResultRow, putEvalResult, getEvalResult, eraseSubjectEvalRows } =
        await import('../src/host/workflowEvalSets.js');
      const T = 'default';
      const now = new Date().toISOString();
      await putEvalSet({
        key: `${T}:${encodeURIComponent('erase-wf')}:erase-set`,
        tenantId: T, workflowId: 'erase-wf', evalSetId: 'erase-set', name: 'Erase', requiredForPromote: false,
        createdAt: now, updatedAt: now, createdBy: 'user:owner',
        cases: [{
          caseId: 'c1',
          inputs: { email: 'user:gone quoted here' },
          pins: [{ nodeId: 'step', output: { quote: 'said by user:gone yesterday' } }],
          assertions: [{ kind: 'output-contains', value: 'user:gone' }],
        }],
      });
      const parts = { tenantId: T, workflowId: 'erase-wf', evalSetId: 'erase-set', resultId: 'er-1' };
      await putEvalResult({
        ...newEvalResultRow({ ...parts, revisionHash: 'y'.repeat(64), caseIds: ['c1'] }),
        status: 'complete',
        cases: [{ caseId: 'c1', runId: 'r1', status: 'failed', assertions: [{ kind: 'output-contains', pass: false, detail: 'output does not contain user:gone snippet' }] }],
      });

      await eraseSubjectEvalRows(T, 'user:gone');

      const set = await getEvalSet(T, 'erase-wf', 'erase-set');
      const caseJson = JSON.stringify(set!.cases);
      expect(caseJson).not.toContain('user:gone');
      expect(caseJson).toContain('[erased]');
      const result = await getEvalResult(T, 'erase-wf', 'erase-set', 'er-1');
      expect(JSON.stringify(result!.cases)).not.toContain('user:gone');
      // The owner's attribution is untouched — a different subject.
      expect(set!.createdBy).toBe('user:owner');
    });

    it('a long-stale RUNNING result is repaired to an honest `incomplete` on read (grade-data M6)', async () => {
      const { newEvalResultRow, putEvalResult, listEvalResults } = await import('../src/host/workflowEvalSets.js');
      const parts = { tenantId: 'default', workflowId: 'stale-wf', evalSetId: 'stale-set', resultId: 'st-1' };
      const row = newEvalResultRow({ ...parts, revisionHash: 'z'.repeat(64), caseIds: ['c1'] });
      row.startedAt = new Date(Date.now() - 60 * 60_000).toISOString(); // an hour ago
      await putEvalResult(row);
      const rows = await listEvalResults('default', 'stale-wf', 'stale-set');
      expect(rows[0]!.status).toBe('incomplete');
      expect(rows[0]!.finishedAt).toBeTruthy();
    });
  });

  describe('the evals-green promote gate', () => {
    async function settle(runId: string): Promise<string> {
      for (let i = 0; i < 200; i += 1) {
        const r = await call<{ status: string }>('GET', `/v1/runs/${runId}`);
        if (r.body.status && !['pending', 'running'].includes(r.body.status)) return r.body.status;
        await new Promise((res) => setTimeout(res, 25));
      }
      return 'timeout';
    }

    it('failing → 409 evals_failing; green → promote; head-move → stale 409; re-green → promote', async () => {
      // Green-run gate first (the pre-existing OQ5 gate).
      const seed = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_GATE, inputs: {} });
      expect(await settle(seed.body.runId)).toBe('completed');

      // A required set that FAILS.
      expect((await call('PUT', `${API}/${WF_GATE}/eval-sets/gate`, {
        name: 'Gate',
        requiredForPromote: true,
        cases: [{ caseId: 'c', inputs: { marker: 'OK' }, assertions: [{ kind: 'output-contains', value: 'NEVER' }] }],
      })).status).toBe(201);
      const r1 = await call<{ resultId: string }>('POST', `${API}/${WF_GATE}/eval-sets/gate/run`);
      await awaitResult(WF_GATE, 'gate', r1.body.resultId);
      const p1 = await call<{ details?: { reason?: string } }>('POST', `${API}/${WF_GATE}/promote`);
      expect(p1.status).toBe(409);
      expect(p1.body.details?.reason).toBe('evals_failing');

      // Fix the set → green → promote succeeds... but first prove STALE:
      expect((await call('PUT', `${API}/${WF_GATE}/eval-sets/gate`, {
        name: 'Gate',
        requiredForPromote: true,
        cases: [{ caseId: 'c', inputs: { marker: 'OK' }, assertions: [{ kind: 'output-contains', value: 'OK' }] }],
      })).status).toBe(200);
      const r2 = await call<{ resultId: string }>('POST', `${API}/${WF_GATE}/eval-sets/gate/run`);
      await awaitResult(WF_GATE, 'gate', r2.body.resultId);

      // Move the head AFTER the green result — the gate must call it stale.
      expect((await call('POST', API, {
        workflowId: WF_GATE,
        nodes: [{ nodeId: 'g', typeId: 'core.noop' }, { nodeId: 'g2', typeId: 'core.noop' }],
        edges: [],
        metadata: { name: WF_GATE, lifecycle: { transient: true, generatedBy: 'test' } },
      })).status).toBe(201);
      const p2 = await call<{ details?: { reason?: string } }>('POST', `${API}/${WF_GATE}/promote`);
      expect(p2.status).toBe(409);
      expect(p2.body.details?.reason).toBe('evals_failing'); // stale ≠ green

      // Re-run against the new head → green → promote passes the eval gate.
      const r3 = await call<{ resultId: string }>('POST', `${API}/${WF_GATE}/eval-sets/gate/run`);
      await awaitResult(WF_GATE, 'gate', r3.body.resultId);
      const p3 = await call<{ publishedRevision?: string }>('POST', `${API}/${WF_GATE}/promote`);
      expect(p3.status).toBe(200);
      expect(p3.body.publishedRevision).toBeTruthy();
    });
  });
});
