/**
 * ADR 0480 — online evals: production runs scored at terminal against a
 * set's ONLINE invariant assertions, folded into daily trend buckets.
 * Through the real app (memory storage): the executor terminal hook fires
 * for ordinary runs; non-production runs never score; judge spend is capped;
 * the read route is owner-gated.
 *
 * Every scoring case owns its OWN workflow: a run scores against EVERY enabled
 * set on its workflow, so shared workflows made counts depend on case order
 * (wave 64: the draft case read another case's set and reddened under shuffle).
 * Exact counts are asserted on those per-case workflows.
 *
 * No live provider: the managed judge resolves to MiniMax, so its key (and the
 * other provider keys) is removed before boot and around every case. The judge
 * cap case therefore needs no network either way.
 *
 * Double guard (honest): the judge cap is enforced twice (`cap === 0` short
 * circuit + the per-day count), so deleting either line alone is a no-op; the
 * witness that the CAP is the cause is 8fw5g2-woe-cap-cause (cap forced high ⇒
 * the unavailable judge fails the run). Sabotage that turns it red: the
 * segmentation predicate (8fw5g2-woe-segment), the sampling gate
 * (8fw5g2-woe-sampling-r2), the pass/fail fold (-woe-passed, -woe-failure-ref),
 * the closed-world validators (-woe-nonempty-r2, -woe-judge-optin) and the
 * owner fence on the read (8fw5g2-woe-owner-r2).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { OnlineEvalBucket } from '../src/host/workflowEvalOnline.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { recordOwnership } from '../src/host/workflowOwnership.js';
import { bareRunId } from './support/bareRunId.js';

/** Every AI / web provider key the host reads from the environment. */
const PROVIDER_KEYS = ['MINIMAX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'OPENWOP_WEBSEARCH_API_KEY'] as const;
const savedKeys = new Map(PROVIDER_KEYS.map((k) => [k, process.env[k]]));
const clearProviderKeys = (): void => { for (const k of PROVIDER_KEYS) delete process.env[k]; };
const restoreProviderKeys = (): void => {
  for (const [k, v] of savedKeys) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

describe('online evals (ADR 0480, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/host/openwop-app/workflows';
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
      const r = await call<{ status: string }>('GET', `/runs/${runId}`);
      if (r.body.status && !['pending', 'running'].includes(r.body.status)) return r.body.status;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`run ${runId} did not settle after 200 polls (25 ms apart)`);
  }

  /** Online scoring is fire-and-forget AFTER terminal — poll the bucket read. */
  async function pollBuckets(wf: string, setId: string, until: (items: OnlineEvalBucket[]) => boolean): Promise<OnlineEvalBucket[]> {
    for (let i = 0; i < 100; i += 1) {
      const r = await call<{ items: OnlineEvalBucket[] }>('GET', `${API}/${wf}/eval-sets/${setId}/online`);
      if (r.status === 200 && until(r.body.items)) return r.body.items;
      await new Promise((res) => setTimeout(res, 30));
    }
    throw new Error(`bucket condition never held for ${wf}/${setId} after 100 polls (30 ms apart)`);
  }

  /** Sum one counter over every day bucket (a case can straddle UTC midnight). */
  const total = (items: OnlineEvalBucket[], k: 'evaluated' | 'passed' | 'failed' | 'judged' | 'judgeSkipped' | 'sampledOut'): number =>
    items.reduce((a, b) => a + (b[k] ?? 0), 0);

  const mk = (workflowId: string, nodes: Array<{ nodeId: string; typeId: string; config?: Record<string, unknown> }>) =>
    call('POST', API, { workflowId, nodes, edges: [], metadata: { name: workflowId, lifecycle: { transient: true, generatedBy: 'test' } } });

  beforeEach(clearProviderKeys);
  afterEach(clearProviderKeys);

  beforeAll(async () => {
    clearProviderKeys(); // before boot, so no managed key is seeded
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    delete process.env.OPENWOP_ONLINE_EVALS;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

    expect((await mk(WF, [{ nodeId: 'a', typeId: 'core.noop' }])).status).toBe(201);
    expect((await mk(WF_FAIL, [{ nodeId: 'boom', typeId: 'core.fail' }])).status).toBe(201);
  });
  afterAll(async () => {
    restoreProviderKeys();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('rejects an enabled online block without assertions (closed world)', async () => {
    const NONEMPTY = 'online.assertions must be a non-empty array of assertions (input-independent invariants).';
    for (const online of [{ enabled: true }, { enabled: true, assertions: [] }]) {
      const bad = await call<{ error: string; message: string }>('PUT', `${API}/${WF}/eval-sets/no-assert`, {
        name: 'Bad', cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
        online,
      });
      expect(bad.status, JSON.stringify(online)).toBe(400);
      expect(bad.body, JSON.stringify(online)).toMatchObject({ error: 'validation_error', message: NONEMPTY });
    }
  });

  it('scores a completed production run against online invariants and buckets it', async () => {
    expect((await call('PUT', `${API}/${WF}/eval-sets/inv`, {
      name: 'Invariants',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, assertions: [{ kind: 'status', value: 'completed' }, { kind: 'node-completed', nodeId: 'a' }] },
    })).status).toBe(201);

    const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF, inputs: {} });
    expect(await settle(run.body.runId)).toBe('completed');

    const items = await pollBuckets(WF, 'inv', (it) => total(it, 'evaluated') >= 1);
    // WF's only enabled set is `inv` and only this case runs WF, so the counts are exact.
    expect(total(items, 'evaluated')).toBe(1);
    expect(total(items, 'passed')).toBe(1);
    expect(total(items, 'failed')).toBe(0);
  });

  it('a FAILED production run scores red — honest signal, with the failing kinds referenced', async () => {
    expect((await call('PUT', `${API}/${WF_FAIL}/eval-sets/inv`, {
      name: 'Invariants',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, assertions: [{ kind: 'status', value: 'completed' }, { kind: 'output-contains', value: 'never-there' }] },
    })).status).toBe(201);

    const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_FAIL, inputs: {} });
    expect(await settle(run.body.runId)).toBe('failed');

    const items = await pollBuckets(WF_FAIL, 'inv', (it) => total(it, 'failed') >= 1);
    const today = items[items.length - 1]!;
    expect(total(items, 'failed')).toBe(1);
    expect(total(items, 'passed')).toBe(0);
    expect(today.failures).toHaveLength(1);
    expect(today.failures[today.failures.length - 1]!.runId).toBe(bareRunId(run.body.runId));
    expect(today.failures[today.failures.length - 1]!.failedKinds).toContain('status');
    // The reference is OPAQUE: no output/detail strings ride the bucket.
    expect(JSON.stringify(today.failures)).not.toContain('expected status');
  });

  // Only the DRAFT launch is driven here: `isProductionRun` also excludes
  // `metadata.debug` / `metadata.eval`, but those are stamped by the debug and
  // eval lanes, not by a plain POST /runs, so the title claims draft only.
  it('a draft-launch run never scores (segmentation doctrine)', async () => {
    const WF_SEG = 'online-wf-segment';
    expect((await mk(WF_SEG, [{ nodeId: 'a', typeId: 'core.noop' }])).status).toBe(201);
    expect((await call('PUT', `${API}/${WF_SEG}/eval-sets/seg`, {
      name: 'Segmentation',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, assertions: [{ kind: 'status', value: 'completed' }] },
    })).status).toBe(201);
    // One non-production run of the draft launch kind, then ONE production
    // run as the positive control. Scoring is per-run and ordered by terminal,
    // so once the control has scored, a wrongly-scored draft would already
    // show as evaluated === 2: no sleep needed.
    const draft = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_SEG, inputs: {}, metadata: { launch: 'draft' } });
    expect(await settle(draft.body.runId)).toBe('completed');
    const prod = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_SEG, inputs: {} });
    expect(await settle(prod.body.runId)).toBe('completed');
    const items = await pollBuckets(WF_SEG, 'seg', (it) => total(it, 'evaluated') >= 1);
    expect(total(items, 'evaluated'), 'only the production run scored').toBe(1);
    expect(total(items, 'passed')).toBe(1);
  });

  it('the online read is owner-gated (unknown workflow → 404)', async () => {
    const NOT_FOUND = (workflowId: string) => ({ status: 404, body: { error: 'workflow_not_found', message: 'Workflow not found in this catalog.', details: { workflowId } } });
    expect(await call('GET', `${API}/does-not-exist/eval-sets/inv/online`)).toEqual(NOT_FOUND('does-not-exist'));
    // The OWNER fence, not just a missing id: registered, but owned by another tenant.
    const FOREIGN = 'online-wf-foreign-owned';
    registerWorkflow({ workflowId: FOREIGN, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [] });
    await recordOwnership('tenant-someone-else', FOREIGN, { name: FOREIGN, nodeCount: 1 });
    expect(await call('GET', `${API}/${FOREIGN}/eval-sets/inv/online`)).toEqual(NOT_FOUND(FOREIGN));
    // Positive control: the owner's read of an existing set on its own workflow answers 200.
    const WF_OWN = 'online-wf-owner-control';
    expect((await mk(WF_OWN, [{ nodeId: 'a', typeId: 'core.noop' }])).status).toBe(201);
    expect((await call('PUT', `${API}/${WF_OWN}/eval-sets/inv`, {
      name: 'Owner', cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, assertions: [{ kind: 'status', value: 'completed' }] },
    })).status).toBe(201);
    expect((await call('GET', `${API}/${WF_OWN}/eval-sets/inv/online`)).status).toBe(200);
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
    const WF_JUDGE = 'online-wf-judge';
    try {
      expect((await mk(WF_JUDGE, [{ nodeId: 'a', typeId: 'core.noop' }])).status).toBe(201);
      expect((await call('PUT', `${API}/${WF_JUDGE}/eval-sets/judged`, {
        name: 'Judged',
        cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
        online: { enabled: true, judge: true, assertions: [{ kind: 'status', value: 'completed' }, { kind: 'llm-judge', criteria: 'is it fine?' }] },
      })).status).toBe(201);
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_JUDGE, inputs: {} });
      expect(await settle(run.body.runId)).toBe('completed');
      const items = await pollBuckets(WF_JUDGE, 'judged', (it) => total(it, 'evaluated') >= 1);
      expect(total(items, 'evaluated')).toBe(1);
      expect(total(items, 'judgeSkipped')).toBe(1);
      expect(total(items, 'judged')).toBe(0);
      // The ORIGINAL behavior failed every over-budget run — manufacturing
      // red trend signal exactly when the feature is used most. The healthy
      // run must PASS on its deterministic assertions; coverage loss is
      // disclosed by judgeSkipped, never faked as quality loss.
      expect(total(items, 'passed')).toBe(1);
      expect(total(items, 'failed')).toBe(0);
    } finally {
      delete process.env.OPENWOP_ONLINE_EVAL_JUDGE_RUNS_PER_DAY;
    }
  });

  it('sampling: rate ~0 counts sampledOut, never evaluated', async () => {
    // Its own workflow, so only this run reaches the set. At 1e-6 the run is
    // sampled OUT with probability 1 − 1e-6 (the validator forbids 0); that is
    // the recorded flake bound. Round 1's assertion was the poll's own
    // disjunction, so deleting sampling stayed green (8fw5g2-woe-sampling).
    const WF_SAMPLE = 'online-wf-sample';
    expect((await mk(WF_SAMPLE, [{ nodeId: 'a', typeId: 'core.noop' }])).status).toBe(201);
    expect((await call('PUT', `${API}/${WF_SAMPLE}/eval-sets/sampled`, {
      name: 'Sampled',
      cases: [{ caseId: 'c1', assertions: [{ kind: 'status', value: 'completed' }] }],
      online: { enabled: true, sampleRate: 0.000001, assertions: [{ kind: 'status', value: 'completed' }] },
    })).status).toBe(201);
    const run = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_SAMPLE, inputs: {} });
    expect(await settle(run.body.runId)).toBe('completed');
    const items = await pollBuckets(WF_SAMPLE, 'sampled', (it) => total(it, 'sampledOut') + total(it, 'evaluated') >= 1);
    expect(total(items, 'sampledOut')).toBe(1);
    expect(total(items, 'evaluated')).toBe(0);
  });
});
