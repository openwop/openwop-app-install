/**
 * ADR 0480 — online evals: production runs scored at terminal against a
 * set's ONLINE invariant assertions, folded into daily trend buckets.
 * Through the real app (memory storage): the executor terminal hook fires
 * for ordinary runs; non-production runs never score; judge spend is capped;
 * the read route is owner-gated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';

describe('online evals (ADR 0480, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/v1/host/openwop-app/workflows';
  const WF = 'online-wf-ok';
  const WF_FAIL = 'online-wf-fail';

  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  }

  async function settle(runId: string): Promise<string> {
    for (let i = 0; i < 200; i += 1) {
      const r = await call<{ status: string }>('GET', `/v1/runs/${runId}`);
      if (r.body.status && !['pending', 'running'].includes(r.body.status)) return r.body.status;
      await new Promise((res) => setTimeout(res, 25));
    }
    return 'timeout';
  }

  /** Online scoring is fire-and-forget AFTER terminal — poll the bucket read. */
  async function pollBuckets(wf: string, setId: string, until: (items: Array<Record<string, number>>) => boolean): Promise<Array<Record<string, number>>> {
    for (let i = 0; i < 100; i += 1) {
      const r = await call<{ items: Array<Record<string, number>> }>('GET', `${API}/${wf}/eval-sets/${setId}/online`);
      if (r.status === 200 && until(r.body.items)) return r.body.items;
      await new Promise((res) => setTimeout(res, 30));
    }
    throw new Error('bucket condition never held');
  }

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    delete process.env.OPENWOP_ONLINE_EVALS;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

    const mk = (workflowId: string, nodes: Array<{ nodeId: string; typeId: string; config?: Record<string, unknown> }>) =>
      call('POST', API, { workflowId, nodes, edges: [], metadata: { name: workflowId, lifecycle: { transient: true, generatedBy: 'test' } } });
    expect((await mk(WF, [{ nodeId: 'a', typeId: 'core.noop' }])).status).toBe(201);
    expect((await mk(WF_FAIL, [{ nodeId: 'boom', typeId: 'core.fail' }])).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('rejects an enabled online block without assertions (closed world)', async () => {
    const bad = await call('PUT', `${API}/${WF}/eval-sets/no-assert`, {
      name: 'Bad', cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true },
    });
    expect(bad.status).toBe(400);
  });

  it('scores a completed production run against online invariants and buckets it', async () => {
    expect((await call('PUT', `${API}/${WF}/eval-sets/inv`, {
      name: 'Invariants',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, assertions: [{ kind: 'status', value: 'completed' }, { kind: 'node-completed', nodeId: 'a' }] },
    })).status).toBe(201);

    const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {} });
    expect(await settle(run.body.runId)).toBe('completed');

    const items = await pollBuckets(WF, 'inv', (it) => it.some((b) => (b.evaluated ?? 0) >= 1));
    const today = items[items.length - 1]!;
    expect(today.passed).toBeGreaterThanOrEqual(1);
    expect(today.failed ?? 0).toBe(0);
  });

  it('a FAILED production run scores red — honest signal, with the failing kinds referenced', async () => {
    expect((await call('PUT', `${API}/${WF_FAIL}/eval-sets/inv`, {
      name: 'Invariants',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, assertions: [{ kind: 'status', value: 'completed' }, { kind: 'output-contains', value: 'never-there' }] },
    })).status).toBe(201);

    const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_FAIL, inputs: {} });
    expect(await settle(run.body.runId)).toBe('failed');

    const items = await pollBuckets(WF_FAIL, 'inv', (it) => it.some((b) => (b.failed ?? 0) >= 1));
    const today = items[items.length - 1] as unknown as { failed: number; failures: Array<{ runId: string; failedKinds: string[] }> };
    expect(today.failed).toBeGreaterThanOrEqual(1);
    expect(today.failures.length).toBeGreaterThanOrEqual(1);
    expect(today.failures[today.failures.length - 1]!.runId).toBe(run.body.runId);
    expect(today.failures[today.failures.length - 1]!.failedKinds).toContain('status');
    // The reference is OPAQUE: no output/detail strings ride the bucket.
    expect(JSON.stringify(today.failures)).not.toContain('expected status');
  });

  it('debug/eval/draft-launch runs never score (segmentation doctrine)', async () => {
    const before = await call<{ items: Array<{ evaluated: number }> }>('GET', `${API}/${WF}/eval-sets/inv/online`);
    const evaluatedBefore = before.body.items.reduce((a, b) => a + b.evaluated, 0);
    const draft = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {}, metadata: { launch: 'draft' } });
    expect(await settle(draft.body.runId)).toBe('completed');
    await new Promise((res) => setTimeout(res, 300)); // give a wrong impl time to score
    const after = await call<{ items: Array<{ evaluated: number }> }>('GET', `${API}/${WF}/eval-sets/inv/online`);
    expect(after.body.items.reduce((a, b) => a + b.evaluated, 0)).toBe(evaluatedBefore);
  });

  it('the online read is owner-gated (unknown workflow → 404)', async () => {
    expect((await call('GET', `${API}/does-not-exist/eval-sets/inv/online`)).status).toBe(404);
  });

  it('rejects llm-judge online assertions without judge: true (code-review H2)', async () => {
    const bad = await call('PUT', `${API}/${WF}/eval-sets/misconfig`, {
      name: 'Misconfig',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, assertions: [{ kind: 'llm-judge', criteria: 'fine?' }] },
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('online.judge');
  });

  it('judge cap exhausted: judge EXCLUDED from pass/fail (never manufactured failure), skip counted (code-review H1)', async () => {
    process.env.OPENWOP_ONLINE_EVAL_JUDGE_RUNS_PER_DAY = '0'; // cap = 0 → every judge skips
    try {
      expect((await call('PUT', `${API}/${WF}/eval-sets/judged`, {
        name: 'Judged',
        cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
        online: { enabled: true, judge: true, assertions: [{ kind: 'status', value: 'completed' }, { kind: 'llm-judge', criteria: 'is it fine?' }] },
      })).status).toBe(201);
      const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {} });
      expect(await settle(run.body.runId)).toBe('completed');
      const items = await pollBuckets(WF, 'judged', (it) => it.some((b) => (b.evaluated ?? 0) >= 1));
      const today = items[items.length - 1]!;
      expect(today.judgeSkipped).toBeGreaterThanOrEqual(1);
      expect(today.judged ?? 0).toBe(0);
      // The ORIGINAL behavior failed every over-budget run — manufacturing
      // red trend signal exactly when the feature is used most. The healthy
      // run must PASS on its deterministic assertions; coverage loss is
      // disclosed by judgeSkipped, never faked as quality loss.
      expect(today.passed).toBeGreaterThanOrEqual(1);
      expect(today.failed ?? 0).toBe(0);
    } finally {
      delete process.env.OPENWOP_ONLINE_EVAL_JUDGE_RUNS_PER_DAY;
    }
  });

  it('sampling: rate ~0 counts sampledOut, never evaluated', async () => {
    expect((await call('PUT', `${API}/${WF}/eval-sets/sampled`, {
      name: 'Sampled',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, sampleRate: 0.000001, assertions: [{ kind: 'status', value: 'completed' }] },
    })).status).toBe(201);
    const run = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {} });
    expect(await settle(run.body.runId)).toBe('completed');
    const items = await pollBuckets(WF, 'sampled', (it) => it.some((b) => ((b.sampledOut ?? 0) + (b.evaluated ?? 0)) >= 1));
    const today = items[items.length - 1]!;
    expect((today.sampledOut ?? 0) >= 1 || (today.evaluated ?? 0) >= 1).toBe(true); // ~always sampledOut at 1e-6
  });
});
