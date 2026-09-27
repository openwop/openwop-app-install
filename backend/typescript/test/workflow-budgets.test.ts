/**
 * ADR 0482 — per-node cost attribution + per-workflow budgets, through the
 * real app: the costByNode stamp shape (top-8 + __other, 6dp, same atomic
 * merge as costUsd), the budget routes (owner-gated 404 posture, validation,
 * clear), the spend-day fold + once-per-threshold-per-day alerts, the hard
 * cap at POST /v1/runs (429 + details.reason) with FAIL-OPEN on read errors,
 * and the debug lane staying unblocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { aggregateCostByNode, stampRunCostOnTerminal } from '../src/observability/costEmitter.js';
import {
  __budgetReadsForTests,
  getTodaySpendUsd,
  getWorkflowBudget,
  recordWorkflowSpend,
  workflowBudgetExhausted,
} from '../src/host/workflowBudgets.js';
import { getNotificationEmitter } from '../src/notifications/emitter.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('workflow budgets (ADR 0482, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/v1/host/openwop-app/workflows';
  const TENANT = 'default';
  const WF_CAP = 'budget-wf-cap';
  const WF_ALERT = 'budget-wf-alert';
  const WF_ROUTES = 'budget-wf-routes';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const mk = (workflowId: string) =>
      call('POST', API, { workflowId, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [], metadata: { name: workflowId, lifecycle: { transient: true, generatedBy: 'test' } } });
    expect((await mk(WF_CAP)).status).toBe(201);
    expect((await mk(WF_ALERT)).status).toBe(201);
    expect((await mk(WF_ROUTES)).status).toBe(201);
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

  /* ── the costByNode stamp shape ─────────────────────────────────────────── */

  describe('costByNode stamp (§1)', () => {
    it('aggregateCostByNode: top-8 by spend + __other remainder, 6dp, unattributed folds into __other', () => {
      const perNode = new Map<string, number>();
      for (let i = 1; i <= 10; i += 1) perNode.set(`n${i}`, i * 0.01); // n10 biggest
      const out = aggregateCostByNode(perNode, 0.005)!;
      // Top 8 = n10..n3; remainder = n2 (0.02) + n1 (0.01) + 0.005 unattributed.
      expect(Object.keys(out).sort()).toEqual(['__other', 'n10', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'].sort());
      expect(out.n10).toBe(0.1);
      expect(out.__other).toBeCloseTo(0.035, 9);
      // 6dp rounding.
      expect(aggregateCostByNode(new Map([['a', 0.1234567891]]), 0)).toEqual({ a: 0.123457 });
      // No attributed nodes ⇒ null (never a lone __other bucket).
      expect(aggregateCostByNode(new Map(), 1)).toBeNull();
    });

    it('stampRunCostOnTerminal writes costUsd + costByNode in ONE merge, returns the total, never overwrites', async () => {
      const rows = new Map<string, { metadata: Record<string, unknown> }>();
      rows.set('r1', { metadata: {} });
      let mergeCalls = 0;
      const fake = {
        listEvents: async () => [
          { type: 'provider.usage', nodeId: 'ai-1', payload: { costEstimateUsd: 0.3, inputTokens: 100, outputTokens: 50 } },
          { type: 'provider.usage', nodeId: 'ai-2', payload: { costEstimateUsd: 0.1 } },
          { type: 'provider.usage', payload: { costEstimateUsd: 0.05 } }, // no nodeId → __other
          { type: 'node.completed', nodeId: 'x', payload: {} },
        ],
        mergeRunMetadata: async (id: string, patch: Record<string, unknown>, opts?: { ifAbsentKey?: string }) => {
          mergeCalls += 1;
          const cur = rows.get(id);
          if (!cur) return false;
          if (opts?.ifAbsentKey && cur.metadata[opts.ifAbsentKey] !== undefined) return false;
          rows.set(id, { metadata: { ...cur.metadata, ...patch } });
          return true;
        },
      };
      const total = await stampRunCostOnTerminal(fake, 'r1');
      expect(total).toBeCloseTo(0.45, 9);
      expect(mergeCalls).toBe(1); // one atomic statement — the pair can never split
      const m = rows.get('r1')!.metadata;
      expect(m.costUsd).toBe(0.45);
      expect(m.costByNode).toEqual({ 'ai-1': 0.3, 'ai-2': 0.1, __other: 0.05 });
      // Never-overwrite: a second stamp keeps the first pair intact.
      await stampRunCostOnTerminal(fake, 'r1');
      expect(rows.get('r1')!.metadata.costUsd).toBe(0.45);
    });

    it('client-supplied costByNode is a RESERVED key (spoof strip)', async () => {
      const { buildRunRecord } = await import('../src/host/runDispatch.js');
      const run = buildRunRecord({ workflowId: 'x', tenantId: 't', metadata: { costByNode: { evil: 1 }, keep: 'me' } });
      expect(run.metadata.costByNode).toBeUndefined();
      expect(run.metadata.keep).toBe('me');
    });
  });

  /* ── budget routes (§3) ─────────────────────────────────────────────────── */

  describe('the fold ticket (review C1)', () => {
    it('a skipped merge returns 0 — one run can never fold spend twice', async () => {
      const { stampRunCostOnTerminal } = await import('../src/observability/costEmitter.js');
      const rows = new Map<string, { metadata: Record<string, unknown> }>([['r-c1', { metadata: {} }]]);
      const fake = {
        listEvents: async () => [
          { type: 'provider.usage', nodeId: 'a', payload: { costEstimateUsd: 0.3, inputTokens: 1, outputTokens: 1 } },
        ],
        mergeRunMetadata: async (id: string, patch: Record<string, unknown>, opts?: { ifAbsentKey?: string }) => {
          const cur = rows.get(id);
          if (!cur) return false;
          if (opts?.ifAbsentKey && cur.metadata[opts.ifAbsentKey] !== undefined) return false;
          rows.set(id, { metadata: { ...cur.metadata, ...patch } });
          return true;
        },
      };
      // First terminal writer (e.g. a cancel) stamps and returns the figure.
      expect(await stampRunCostOnTerminal(fake, 'r-c1')).toBeCloseTo(0.3, 9);
      // The racing second terminal (the in-flight executor finishing) is a
      // no-op merge — it MUST return 0 so the budget counter never folds the
      // same run twice (the original returned the computed figure, double-
      // counting spend and tripping alerts/hard caps on phantom money).
      expect(await stampRunCostOnTerminal(fake, 'r-c1')).toBe(0);
    });
  });

  describe('budget routes', () => {
    const PATH = `${API}/${WF_ROUTES}/budget`;

    it('GET before any budget → null + zero spend', async () => {
      const r = await call<{ budget: unknown; spentTodayUsd: number }>('GET', PATH);
      expect(r.status).toBe(200);
      expect(r.body.budget).toBeNull();
      expect(r.body.spentTodayUsd).toBe(0);
    });

    it('PUT validates dailyUsd and hardCap', async () => {
      expect((await call('PUT', PATH, { dailyUsd: 0 })).status).toBe(400);
      expect((await call('PUT', PATH, { dailyUsd: -1 })).status).toBe(400);
      expect((await call('PUT', PATH, { dailyUsd: 'x' })).status).toBe(400);
      expect((await call('PUT', PATH, { dailyUsd: 1, hardCap: 'yes' })).status).toBe(400);
    });

    it('PUT set → GET roundtrip → PUT null clears', async () => {
      const set = await call<{ budget: { dailyUsd: number; hardCap: boolean } }>('PUT', PATH, { dailyUsd: 2.5, hardCap: true });
      expect(set.status).toBe(200);
      expect(set.body.budget).toMatchObject({ dailyUsd: 2.5, hardCap: true });
      const got = await call<{ budget: { dailyUsd: number; hardCap: boolean } | null }>('GET', PATH);
      expect(got.body.budget).toMatchObject({ dailyUsd: 2.5, hardCap: true });
      const cleared = await call<{ budget: null }>('PUT', PATH, { dailyUsd: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.budget).toBeNull();
      expect((await call<{ budget: unknown }>('GET', PATH)).body.budget).toBeNull();
    });

    it('unknown/foreign workflow is an indistinguishable 404 (owner gate)', async () => {
      expect((await call('GET', `${API}/never-registered-wf/budget`)).status).toBe(404);
      expect((await call('PUT', `${API}/never-registered-wf/budget`, { dailyUsd: 1 })).status).toBe(404);
    });

    it('the scoped list carries the budget chip payload (two prefix reads, no N+1)', async () => {
      expect((await call('PUT', PATH, { dailyUsd: 3, hardCap: false })).status).toBe(200);
      await recordWorkflowSpend(TENANT, WF_ROUTES, 0.25);
      const list = await call<{ workflows: Array<{ workflowId: string; budget?: { dailyUsd: number; hardCap: boolean }; spentTodayUsd?: number }> }>('GET', API);
      const row = list.body.workflows.find((w) => w.workflowId === WF_ROUTES)!;
      expect(row.budget).toEqual({ dailyUsd: 3, hardCap: false });
      expect(row.spentTodayUsd).toBeCloseTo(0.25, 6);
      // Un-budgeted rows carry NO chip payload.
      const bare = list.body.workflows.find((w) => w.workflowId === WF_CAP)!;
      expect(bare.budget).toBeUndefined();
      // Cleanup for the cap tests below.
      await call('PUT', PATH, { dailyUsd: null });
    });
  });

  /* ── spend fold + alerts (§2/§4) ────────────────────────────────────────── */

  describe('spend fold + alerts', () => {
    it('folds spend and fires each threshold alert exactly once per day (flags ride the SAME CAS row)', async () => {
      const seen: Array<{ type: string; threshold?: unknown }> = [];
      const unsub = getNotificationEmitter().subscribe((n) => {
        if (n.type === 'openwop-app.workflow.budget-alert' && n.workflowId === WF_ALERT) {
          seen.push({ type: n.type, threshold: (n.metadata as { threshold?: unknown } | undefined)?.threshold });
        }
      });
      try {
        expect((await call('PUT', `${API}/${WF_ALERT}/budget`, { dailyUsd: 1, hardCap: false })).status).toBe(200);
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.5); // 50% — no alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.4); // 90% — crosses 80 → ONE alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.05); // 95% — no new alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.1); // 105% — crosses 100 → ONE alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.2); // beyond — silent
        await new Promise((res) => setTimeout(res, 100)); // alert emit is fire-and-forget
        expect(seen.map((s) => s.threshold)).toEqual([80, 100]);
        expect(await getTodaySpendUsd(TENANT, WF_ALERT)).toBeCloseTo(1.25, 6);
      } finally {
        unsub();
      }
    });

    it('a single fold crossing both thresholds emits only the 100% alert (both flags set)', async () => {
      const wf = 'budget-wf-bothcross';
      expect((await call('POST', API, { workflowId: wf, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [], metadata: { name: wf, lifecycle: { transient: true, generatedBy: 'test' } } })).status).toBe(201);
      expect((await call('PUT', `${API}/${wf}/budget`, { dailyUsd: 1 })).status).toBe(200);
      const seen: unknown[] = [];
      const unsub = getNotificationEmitter().subscribe((n) => {
        if (n.type === 'openwop-app.workflow.budget-alert' && n.workflowId === wf) seen.push((n.metadata as { threshold?: unknown }).threshold);
      });
      try {
        await recordWorkflowSpend(TENANT, wf, 1.5);
        await new Promise((res) => setTimeout(res, 100));
        expect(seen).toEqual([100]);
        await recordWorkflowSpend(TENANT, wf, 0.5); // neither fires again
        await new Promise((res) => setTimeout(res, 100));
        expect(seen).toEqual([100]);
      } finally {
        unsub();
      }
    });
  });

  /* ── the hard cap (§5) ──────────────────────────────────────────────────── */

  describe('hard cap', () => {
    it('POST /v1/runs → 429 rate_limited + details.reason once a hard-capped budget is exhausted', async () => {
      expect((await call('PUT', `${API}/${WF_CAP}/budget`, { dailyUsd: 0.5, hardCap: true })).status).toBe(200);
      // Under budget: runs proceed.
      expect(await workflowBudgetExhausted(TENANT, WF_CAP)).toBe(false);
      const ok = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_CAP, inputs: {} });
      expect(ok.status).toBe(201);
      // Exhaust it.
      await recordWorkflowSpend(TENANT, WF_CAP, 0.6);
      expect(await workflowBudgetExhausted(TENANT, WF_CAP)).toBe(true);
      const blocked = await call<{ error: string; details?: { reason?: string; workflowId?: string } }>('POST', '/v1/runs', { workflowId: WF_CAP, inputs: {} });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe('rate_limited');
      expect(blocked.body.details?.reason).toBe('workflow_budget_exhausted');
      expect(blocked.body.details?.workflowId).toBe(WF_CAP);
    });

    it('soft budgets (hardCap false) never block', async () => {
      expect((await call('PUT', `${API}/${WF_CAP}/budget`, { dailyUsd: 0.5, hardCap: false })).status).toBe(200);
      expect(await workflowBudgetExhausted(TENANT, WF_CAP)).toBe(false);
      expect((await call('POST', '/v1/runs', { workflowId: WF_CAP, inputs: {} })).status).toBe(201);
      // Restore the hard cap for the following lanes.
      expect((await call('PUT', `${API}/${WF_CAP}/budget`, { dailyUsd: 0.5, hardCap: true })).status).toBe(200);
    });

    it('FAIL-OPEN: a budget-read error lets the run proceed (never blocks production)', async () => {
      const orig = __budgetReadsForTests.budget;
      __budgetReadsForTests.budget = async () => { throw new Error('budget store down'); };
      try {
        expect(await workflowBudgetExhausted(TENANT, WF_CAP)).toBe(false);
        expect((await call('POST', '/v1/runs', { workflowId: WF_CAP, inputs: {} })).status).toBe(201);
      } finally {
        __budgetReadsForTests.budget = orig;
      }
      // With reads healthy again, the cap bites (proves the fail-open was the seam).
      expect(await workflowBudgetExhausted(TENANT, WF_CAP)).toBe(true);
    });

    it('the debug lane stays unblocked while the cap bites (diagnostic spend)', async () => {
      expect(await workflowBudgetExhausted(TENANT, WF_CAP)).toBe(true);
      expect((await call('POST', '/v1/runs', { workflowId: WF_CAP, inputs: {} })).status).toBe(429);
      // The ADR 0475 debug run — from the first node, no pins needed.
      const dbg = await call<{ runId?: string }>('POST', `${API}/${WF_CAP}/debug-run`, { fromNodeId: 'a' });
      expect([200, 201, 202]).toContain(dbg.status);
    });

    it('structural tripwire: workflowBudgetExhausted has EXACTLY the two sanctioned call sites', () => {
      // The exemption list (child dispatch / debug / eval / redrive) is enforced
      // by absence — this scan fails the build the day a third call site lands
      // without revisiting ADR 0482 §5.
      const src = (rel: string): string => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');
      expect(src('routes/runs.ts')).toMatch(/workflowBudgetExhausted\(/);
      expect(src('host/runStarter.ts')).toMatch(/workflowBudgetExhausted\(/);
      for (const rel of ['executor/subWorkflowDispatcher.ts', 'routes/workflowDebug.ts', 'routes/workflowEvals.ts']) {
        expect(src(rel), `${rel} must NOT hard-cap (ADR 0482 §5)`).not.toMatch(/workflowBudgetExhausted\(/);
      }
    });
  });

  /* ── snapshot projection (§6) ───────────────────────────────────────────── */

  it('the run snapshot surfaces the stamped costUsd (host-written metadata only)', async () => {
    expect((await call('PUT', `${API}/${WF_ROUTES}/budget`, { dailyUsd: null })).status).toBe(200);
    const created = await call<{ runId: string }>('POST', '/v1/runs', { workflowId: WF_ROUTES, inputs: {} });
    expect(created.status).toBe(201);
    for (let i = 0; i < 200; i += 1) {
      const r = await call<{ status: string }>('GET', `/v1/runs/${created.body.runId}`);
      if (r.body.status && !['pending', 'running'].includes(r.body.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    // core.noop emits no provider.usage — the additive fields stay ABSENT
    // (never zero-filled), which is the §6 fallback contract the FE relies on.
    const snap = await call<{ costUsd?: number; costByNode?: Record<string, number> }>('GET', `/v1/runs/${created.body.runId}`);
    expect(snap.body.costUsd).toBeUndefined();
    expect(snap.body.costByNode).toBeUndefined();
  });

  it('budget row eraser redacts updatedBy in place', async () => {
    const { eraseSubjectWorkflowBudgets } = await import('../src/host/workflowBudgets.js');
    const { putWorkflowBudget } = await import('../src/host/workflowBudgets.js');
    await putWorkflowBudget(TENANT, WF_ROUTES, { dailyUsd: 9, hardCap: false, updatedBy: 'user:erase-me' });
    await eraseSubjectWorkflowBudgets(TENANT, 'user:erase-me');
    const after = await getWorkflowBudget(TENANT, WF_ROUTES);
    expect(after?.updatedBy).toBe('[erased]');
    expect(after?.dailyUsd).toBe(9);
  });
});
