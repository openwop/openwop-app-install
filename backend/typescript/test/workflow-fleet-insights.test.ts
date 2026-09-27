/**
 * ADR 0476 — fleet insights + cost estimate + runs.diagnose, through the real
 * app: the terminal cost stamp (never-overwrite; client-spoof stripped; fork
 * never inherits), the bounded stats aggregation (successRate/p95/hotspots +
 * window disclosure), the two-half estimate, and the grounded diagnosis tool
 * (fail-empty without an acting user; foreign run indistinguishable empty;
 * deep links compose the ADR 0475 debug loop).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { applyCostRollup, stampRunCostOnTerminal } from '../src/observability/costEmitter.js';
import { buildRunRecord } from '../src/host/runDispatch.js';
import { percentile, clearFleetStatsCache } from '../src/host/workflowFleetStats.js';

describe('workflow fleet insights (ADR 0476, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/v1/host/openwop-app/workflows';
  const WF = 'fleet-wf-ok';
  const WF_FAIL = 'fleet-wf-fail';
  const WF_AI = 'fleet-wf-ai';
  const WF_COST = 'fleet-wf-cost';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });

    const mk = (workflowId: string, nodes: Array<{ nodeId: string; typeId: string; config?: Record<string, unknown> }>) =>
      call('POST', API, { workflowId, nodes, edges: [], metadata: { name: workflowId, lifecycle: { transient: true, generatedBy: 'test' } } });
    expect((await mk(WF, [{ nodeId: 'a', typeId: 'core.noop' }])).status).toBe(201);
    expect((await mk(WF_FAIL, [{ nodeId: 'boom', typeId: 'core.fail' }])).status).toBe(201);
    // A "model-configured" node counts as an AI node for the static floor.
    expect((await mk(WF_AI, [{ nodeId: 'ai', typeId: 'core.noop', config: { model: 'claude-sonnet-5' } }])).status).toBe(201);
    // A delayed workflow so a test can record provider spend BEFORE terminal
    // (the stamp folds the rollup at the terminal transition).
    expect((await mk(WF_COST, [{ nodeId: 'wait', typeId: 'core.delay', config: { durationMs: 400 } }])).status).toBe(201);
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

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

  it('percentile: nearest-rank; empty → null', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
  });

  it('buildRunRecord strips client-supplied cost stamps (spoof guard)', () => {
    const run = buildRunRecord({
      workflowId: 'x', tenantId: 't',
      metadata: { costUsd: 999, costTokens: { input: 1, output: 1 }, keep: 'me' },
    });
    expect(run.metadata.costUsd).toBeUndefined();
    expect(run.metadata.costTokens).toBeUndefined();
    expect(run.metadata.keep).toBe('me');
  });

  describe('terminal cost stamp', () => {
    it('folds the rollup at terminal and never overwrites (unit, fake storage)', async () => {
      const rows = new Map<string, { metadata: Record<string, unknown> }>();
      rows.set('r1', { metadata: {} });
      const fake = {
        listEvents: async () => [] as Array<{ type: string; payload?: unknown }>,
        mergeRunMetadata: async (id: string, patch: Record<string, unknown>, opts?: { ifAbsentKey?: string }) => {
          const cur = rows.get(id);
          if (!cur) return false;
          if (opts?.ifAbsentKey && cur.metadata[opts.ifAbsentKey] !== undefined) return false;
          rows.set(id, { metadata: { ...cur.metadata, ...patch } });
          return true;
        },
      };
      applyCostRollup('r1', { 'openwop.cost.usd': 0.5, 'openwop.cost.tokens.input': 100, 'openwop.cost.tokens.output': 50 });
      await stampRunCostOnTerminal(fake, 'r1');
      expect(rows.get('r1')!.metadata.costUsd).toBe(0.5);
      expect(rows.get('r1')!.metadata.costTokens).toEqual({ input: 100, output: 50 });
      // Second stamp with more spend recorded must NOT overwrite (earlier writer wins).
      applyCostRollup('r1', { 'openwop.cost.usd': 99 });
      await stampRunCostOnTerminal(fake, 'r1');
      expect(rows.get('r1')!.metadata.costUsd).toBe(0.5);
    });

    it('stamps END-TO-END at the executor terminal seam, and a fork never inherits it', async () => {
      // WF_COST delays 400ms — record spend for the run WHILE it executes,
      // so the executor's terminal stamp folds it durably.
      const src = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_COST, inputs: {} });
      expect(src.status).toBe(201);
      applyCostRollup(src.body.runId, { 'openwop.cost.usd': 0.5 });
      expect(await settle(src.body.runId)).toBe('completed');

      // The stats read proves the durable stamp (the ONLY HTTP cost surface).
      clearFleetStatsCache();
      const stats1 = await call<{ workflows: Array<{ workflowId: string; costUsdTotal: number }> }>('GET', `${API}/stats`);
      expect(stats1.body.workflows.find((w) => w.workflowId === WF_COST)!.costUsdTotal).toBe(0.5);

      // Fork the source: the fork records NO spend of its own, so if the
      // total stays 0.5 the fork did not inherit the source stamp (the
      // frozen-lie guard); inheritance would read 1.0.
      const fork = await call<{ runId: string }>('POST', `/v1/runs/${src.body.runId}:fork`, { mode: 'replay' });
      expect(fork.status).toBe(201);
      await settle(fork.body.runId);
      clearFleetStatsCache(); // the fork witness must read FRESH data, not the cache
      const stats2 = await call<{ workflows: Array<{ workflowId: string; costUsdTotal: number }> }>('GET', `${API}/stats`);
      expect(stats2.body.workflows.find((w) => w.workflowId === WF_COST)!.costUsdTotal).toBe(0.5);
    });
  });

  describe('fleet stats', () => {
    it('aggregates success rate, percentiles, and failure hotspots with the window disclosed', async () => {
      // Ensure outcomes exist: one more completed WF run + one failed run.
      const ok = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {} });
      expect(await settle(ok.body.runId)).toBe('completed');
      const bad = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_FAIL, inputs: {} });
      expect(await settle(bad.body.runId)).toBe('failed');

      clearFleetStatsCache();
      const stats = await call<{
        rowsConsidered: number; truncated: boolean; sinceOldest: string | null;
        workflows: Array<{
          workflowId: string; completed: number; failed: number; successRate: number | null;
          p50Ms: number | null; p95Ms: number | null; costUsdTotal: number;
          topFailures: Array<{ nodeId: string; count: number }>;
        }>;
      }>('GET', `${API}/stats`);
      expect(stats.status).toBe(200);
      expect(stats.body.rowsConsidered).toBeGreaterThan(0);
      expect(stats.body.truncated).toBe(false);
      expect(stats.body.sinceOldest).toBeTruthy();

      const okRow = stats.body.workflows.find((w) => w.workflowId === WF)!;
      expect(okRow.completed).toBeGreaterThanOrEqual(1);
      expect(okRow.failed).toBe(0);
      expect(okRow.successRate).toBe(1);
      expect(okRow.p50Ms).not.toBeNull();
      expect(okRow.p95Ms).not.toBeNull();
      expect(okRow.costUsdTotal).toBe(0); // noop runs record no spend

      const failRow = stats.body.workflows.find((w) => w.workflowId === WF_FAIL)!;
      expect(failRow.successRate).toBe(0);
      expect(failRow.topFailures.length).toBeGreaterThan(0);
      expect(failRow.topFailures[0]!.nodeId).toBe('boom');
    });

    it('draft/debug/eval runs are segmented OUT of the outcome figures (grade-data H2)', async () => {
      const WF_SEG = 'fleet-wf-segment';
      expect((await call('POST', API, {
        workflowId: WF_SEG,
        nodes: [{ nodeId: 'boom', typeId: 'core.fail' }],
        edges: [],
        metadata: { name: WF_SEG, lifecycle: { transient: true, generatedBy: 'test' } },
      })).status).toBe(201);
      // A builder draft test-run FAILS — but it is launch:'draft', so it must
      // not mint a failure hotspot or tank the (empty) production stats.
      const draft = await call<{ runId: string }>('POST', '/v1/runs', {
        workflowId: WF_SEG, inputs: {}, metadata: { launch: 'draft' },
      });
      expect(await settle(draft.body.runId)).toBe('failed');

      clearFleetStatsCache();
      const stats = await call<{ workflows: Array<{ workflowId: string; runs: number; nonProductionRuns: number; failed: number; successRate: number | null; topFailures: unknown[] }> }>(
        'GET', `${API}/stats`,
      );
      const row = stats.body.workflows.find((w) => w.workflowId === WF_SEG)!;
      expect(row).toBeTruthy();
      expect(row.runs).toBe(0);
      expect(row.nonProductionRuns).toBe(1);
      expect(row.failed).toBe(0);
      expect(row.successRate).toBeNull();
      expect(row.topFailures).toEqual([]);
    });
  });

  describe('cost estimate', () => {
    it('unknown workflow is a 404 (owner posture)', async () => {
      expect((await call('GET', `${API}/does-not-exist/estimate`)).status).toBe(404);
    });

    it('historical from stamps; static floor from AI-node composition', async () => {
      // WF_COST has a stamped run (0.5) → historical present; no AI nodes → no static.
      clearFleetStatsCache();
      const est = await call<{ historical?: { medianUsd: number; samples: number }; static?: unknown }>(
        'GET', `${API}/${WF_COST}/estimate`,
      );
      expect(est.status).toBe(200);
      expect(est.body.historical).toBeTruthy();
      expect(est.body.historical!.medianUsd).toBe(0.5);
      expect(est.body.static).toBeUndefined();

      // WF_AI: no run history → no historical; one model-configured node → static floor.
      const estAi = await call<{ historical?: unknown; static?: { floorUsd: number; aiNodes: number; assumptions: { model: string } } }>(
        'GET', `${API}/${WF_AI}/estimate`,
      );
      expect(estAi.status).toBe(200);
      expect(estAi.body.historical).toBeUndefined();
      expect(estAi.body.static).toBeTruthy();
      expect(estAi.body.static!.aiNodes).toBe(1);
      expect(estAi.body.static!.floorUsd).toBeGreaterThan(0);
      expect(estAi.body.static!.assumptions.model).toBeTruthy();
    });
  });

  describe('runs.diagnose (the grounded failure-context tool)', () => {
    const TOOL = 'openwop:runs.diagnose';
    function runTool(input: Record<string, unknown>, scope: { actingUserId?: string }): Promise<{ content: string; isError?: boolean }> {
      const provider = createAgentToolProvider({ tenantId: 'default', ...scope });
      return provider.executeTool({ name: TOOL, input });
    }

    it('registers as a core builtin', () => {
      expect(builtinAgentToolIds()).toContain(TOOL);
    });

    it('fails EMPTY without an acting user', async () => {
      const bad = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_FAIL, inputs: {} });
      expect(await settle(bad.body.runId)).toBe('failed');
      const res = JSON.parse((await runTool({ runId: bad.body.runId }, {})).content) as { note?: string; failedNodeId?: string };
      expect(res.failedNodeId).toBeUndefined();
      expect(res.note).toBeTruthy();
    });

    it('a foreign-tenant run is an indistinguishable empty', async () => {
      const bad = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_FAIL, inputs: {} });
      expect(await settle(bad.body.runId)).toBe('failed');
      const provider = createAgentToolProvider({ tenantId: 'someone-else', actingUserId: 'u-1' });
      const res = JSON.parse((await provider.executeTool({ name: TOOL, input: { runId: bad.body.runId } })).content) as { note?: string; failedNodeId?: string };
      expect(res.failedNodeId).toBeUndefined();
      expect(res.note).toContain('No such run');
    });

    it('grounds a failed run: classified error, failing node, deep links (incl. debug-in-builder)', async () => {
      const bad = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_FAIL, inputs: {} });
      expect(await settle(bad.body.runId)).toBe('failed');
      const res = JSON.parse((await runTool({ runId: bad.body.runId }, { actingUserId: 'u-1' })).content) as {
        failedNodeId?: string; failedNode?: { typeId: string }; error?: { code: string };
        links?: { runDetail: string; debugInBuilder: string };
      };
      expect(res.failedNodeId).toBe('boom');
      expect(res.failedNode?.typeId).toBe('core.fail');
      expect(res.error?.code).toBeTruthy();
      expect(res.links?.runDetail).toBe(`/runs/${bad.body.runId}`);
      expect(res.links?.debugInBuilder).toContain(`/builder/${WF_FAIL}?debugRun=${bad.body.runId}`);
    });

    it('a non-failed run gets an honest redirect note, not a fabricated diagnosis', async () => {
      const ok = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF, inputs: {} });
      expect(await settle(ok.body.runId)).toBe('completed');
      const res = JSON.parse((await runTool({ runId: ok.body.runId }, { actingUserId: 'u-1' })).content) as { status?: string; note?: string; failedNodeId?: string };
      expect(res.status).toBe('completed');
      expect(res.note).toContain('has not failed');
      expect(res.failedNodeId).toBeUndefined();
    });
  });
});
