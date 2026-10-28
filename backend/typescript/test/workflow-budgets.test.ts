/**
 * ADR 0482 — per-node cost attribution + per-workflow budgets, through the
 * real app: the costByNode stamp shape (top-8 + __other, 6dp, same atomic
 * merge as costUsd), the budget routes (owner-gated 404 posture, validation,
 * clear), the spend-day fold + once-per-threshold-per-day alerts, the hard
 * cap at POST /v1/runs (429 + details.reason) with FAIL-OPEN on read errors,
 * and the debug lane staying unblocked.
 *
 * Sabotage-witnessed (wave 64, probes 8fw5g1-wb-*): the 429 cap, fail-open, soft
 * budgets, once-per-threshold, the 100%-subsumes-80% choice, the fold ticket, top-8,
 * the reserved-key strip and the DSAR eraser. Every case owns its workflow + budget
 * + spend, and alert absence is settled on a sentinel alert (not a sleep), so the
 * file passes in any order. Residual: a fold pair straddling 00:00Z would land on two
 * spend days (real clock; the clock-shift lane moves the whole year, not the hour).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('workflow budgets (ADR 0482, sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/host/openwop-app/workflows';
  const TENANT = 'default';
  const WF_CAP = 'budget-wf-cap';
  const WF_ALERT = 'budget-wf-alert';
  const WF_ROUTES = 'budget-wf-routes';
  let seq = 0;
  const mk = (workflowId: string) =>
    call('POST', API, { workflowId, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [], metadata: { name: workflowId, lifecycle: { transient: true, generatedBy: 'test' } } });

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
      // Its own workflow: WF_ROUTES carries spend from the list case, in whatever order they run.
      const wf = `budget-wf-fresh-${seq++}`;
      expect((await mk(wf)).status).toBe(201);
      const r = await call<{ budget: unknown; spentTodayUsd: number }>('GET', `${API}/${wf}/budget`);
      expect(r.status).toBe(200);
      expect(r.body.budget).toBeNull();
      expect(r.body.spentTodayUsd).toBe(0);
    });

    it('PUT validates dailyUsd and hardCap', async () => {
      const DAILY = { error: 'validation_error', message: 'dailyUsd must be a finite number > 0 (or null to clear the budget).' };
      for (const dailyUsd of [0, -1, 'x']) {
        const r = await call('PUT', PATH, { dailyUsd });
        expect(r.status, String(dailyUsd)).toBe(400);
        expect(r.body).toMatchObject(DAILY);
      }
      const cap = await call('PUT', PATH, { dailyUsd: 1, hardCap: 'yes' });
      expect(cap.status).toBe(400);
      expect(cap.body).toMatchObject({ error: 'validation_error', message: 'hardCap must be a boolean.' });
      // Nothing was written by any refusal.
      expect((await call<{ budget: unknown }>('GET', PATH)).body.budget).toBeNull();
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

    // A FOREIGN tenant is not reachable in this single-tenant (dev-token) file; the
    // owner gate's cross-tenant leg is the loadOwnedHead seam's own tests' claim.
    it('an unknown workflow is a 404 on both verbs (owner gate)', async () => {
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
    /**
     * The alert emit is fire-and-forget (`void emitBudgetAlert(...)`), so "no further
     * alert" needs a settle signal, not a sleep: fold a SENTINEL workflow over its
     * budget and wait for ITS alert. Emits leave in fold order, so once the sentinel's
     * has arrived every earlier fold's alert (wanted or spurious) has too.
     */
    async function settleAlerts(seenFor: (wf: string) => unknown[]): Promise<void> {
      const sentinel = `budget-wf-sentinel-${seq++}`;
      expect((await mk(sentinel)).status).toBe(201);
      expect((await call('PUT', `${API}/${sentinel}/budget`, { dailyUsd: 1, hardCap: false })).status).toBe(200);
      await recordWorkflowSpend(TENANT, sentinel, 1.5);
      await vi.waitFor(() => { expect(seenFor(sentinel)).toEqual([100]); }, { timeout: 5000, interval: 10 });
    }

    function watchAlerts(): { thresholds: (wf: string) => unknown[]; unsub: () => void } {
      const seen: Array<{ workflowId: string; threshold: unknown }> = [];
      const unsub = getNotificationEmitter().subscribe((n) => {
        if (n.type === 'openwop-app.workflow.budget-alert' && typeof n.workflowId === 'string') {
          seen.push({ workflowId: n.workflowId, threshold: (n.metadata as { threshold?: unknown } | undefined)?.threshold });
        }
      });
      return { thresholds: (wf) => seen.filter((x) => x.workflowId === wf).map((x) => x.threshold), unsub };
    }

    it('folds spend and fires each threshold alert exactly once per day (flags ride the SAME CAS row)', async () => {
      const w = watchAlerts();
      try {
        expect((await call('PUT', `${API}/${WF_ALERT}/budget`, { dailyUsd: 1, hardCap: false })).status).toBe(200);
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.5); // 50% — no alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.4); // 90% — crosses 80 → ONE alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.05); // 95% — no new alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.1); // 105% — crosses 100 → ONE alert
        await recordWorkflowSpend(TENANT, WF_ALERT, 0.2); // beyond — silent
        await settleAlerts(w.thresholds);
        expect(w.thresholds(WF_ALERT)).toEqual([80, 100]);
        expect(await getTodaySpendUsd(TENANT, WF_ALERT)).toBeCloseTo(1.25, 6);
      } finally {
        w.unsub();
      }
    });

    it('a single fold crossing both thresholds emits only the 100% alert (both flags set)', async () => {
      const wf = `budget-wf-bothcross-${seq++}`;
      expect((await mk(wf)).status).toBe(201);
      expect((await call('PUT', `${API}/${wf}/budget`, { dailyUsd: 1 })).status).toBe(200);
      const w = watchAlerts();
      try {
        await recordWorkflowSpend(TENANT, wf, 1.5);
        await settleAlerts(w.thresholds);
        expect(w.thresholds(wf)).toEqual([100]);
        await recordWorkflowSpend(TENANT, wf, 0.5); // neither fires again
        await settleAlerts(w.thresholds);
        expect(w.thresholds(wf)).toEqual([100]);
      } finally {
        w.unsub();
      }
    });
  });

  /* ── the hard cap (§5) ──────────────────────────────────────────────────── */

  describe('hard cap', () => {
    /** Each case owns its workflow, budget and spend, so the cases pass in any order. */
    async function cappedWorkflow(opts: { hardCap: boolean; exhaust: boolean }): Promise<string> {
      const wf = `budget-wf-cap-${seq++}`;
      expect((await mk(wf)).status).toBe(201);
      expect((await call('PUT', `${API}/${wf}/budget`, { dailyUsd: 0.5, hardCap: opts.hardCap })).status).toBe(200);
      if (opts.exhaust) await recordWorkflowSpend(TENANT, wf, 0.6);
      return wf;
    }

    it('POST /v1/runs → 429 rate_limited + details.reason once a hard-capped budget is exhausted', async () => {
      const wf = await cappedWorkflow({ hardCap: true, exhaust: false });
      // Under budget: runs proceed.
      expect(await workflowBudgetExhausted(TENANT, wf)).toBe(false);
      const ok = await call<{ runId: string }>('POST', '/runs', { workflowId: wf, inputs: {} });
      expect(ok.status).toBe(201);
      // Exhaust it.
      await recordWorkflowSpend(TENANT, wf, 0.6);
      expect(await workflowBudgetExhausted(TENANT, wf)).toBe(true);
      const blocked = await call<{ error: string; details?: { reason?: string; workflowId?: string } }>('POST', '/runs', { workflowId: wf, inputs: {} });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe('rate_limited');
      expect(blocked.body.details?.reason).toBe('workflow_budget_exhausted');
      expect(blocked.body.details?.workflowId).toBe(wf);
    });

    it('soft budgets (hardCap false) never block', async () => {
      const wf = await cappedWorkflow({ hardCap: false, exhaust: true });
      expect(await getTodaySpendUsd(TENANT, wf), 'precondition: spend is past the budget').toBeCloseTo(0.6, 6);
      expect(await workflowBudgetExhausted(TENANT, wf)).toBe(false);
      expect((await call('POST', '/runs', { workflowId: wf, inputs: {} })).status).toBe(201);
    });

    it('FAIL-OPEN: a budget-read error lets the run proceed (never blocks production)', async () => {
      const wf = await cappedWorkflow({ hardCap: true, exhaust: true });
      expect(await workflowBudgetExhausted(TENANT, wf), 'precondition: the cap bites').toBe(true);
      const orig = __budgetReadsForTests.budget;
      __budgetReadsForTests.budget = async () => { throw new Error('budget store down'); };
      try {
        expect(await workflowBudgetExhausted(TENANT, wf)).toBe(false);
        expect((await call('POST', '/runs', { workflowId: wf, inputs: {} })).status).toBe(201);
      } finally {
        __budgetReadsForTests.budget = orig;
      }
      // With reads healthy again, the cap bites (proves the fail-open was the seam).
      expect(await workflowBudgetExhausted(TENANT, wf)).toBe(true);
    });

    it('the debug lane stays unblocked while the cap bites (diagnostic spend)', async () => {
      const wf = await cappedWorkflow({ hardCap: true, exhaust: true });
      expect(await workflowBudgetExhausted(TENANT, wf)).toBe(true);
      expect((await call('POST', '/runs', { workflowId: wf, inputs: {} })).status).toBe(429);
      // The ADR 0475 debug run — from the first node, no pins needed.
      const dbg = await call<{ runId?: string }>('POST', `${API}/${wf}/debug-run`, { fromNodeId: 'a' });
      expect([200, 201, 202]).toContain(dbg.status);
      expect(typeof dbg.body.runId).toBe('string');
    });

    it('structural tripwire: workflowBudgetExhausted has EXACTLY the three sanctioned call sites (create, fork, runStarter)', () => {
      // The exemption list (child dispatch / debug / eval / redrive) is enforced
      // by absence — this scan fails the build the day another call site lands
      // without revisiting ADR 0482 §5. MEASURED at 19d13e682 (wave 64): 3 sites —
      // routes/runs.ts create (POST /runs) + fork, host/runStarter.ts. (This title
      // said "two" while runs.ts held two of them; a per-file regex could not count.)
      const CALL = /\bworkflowBudgetExhausted\(/g;
      const srcRoot = join(__dirname, '..', 'src');
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []);
      const counts = new Map<string, number>();
      for (const f of walk(srcRoot)) {
        const text = readFileSync(f, 'utf8');
        if (!text.includes('workflowBudgetExhausted(')) continue;
        const n = [...text.matchAll(CALL)].length - (/export async function workflowBudgetExhausted\(/.test(text) ? 1 : 0);
        if (n > 0) counts.set(f.slice(srcRoot.length + 1), n);
      }
      expect(Object.fromEntries(counts)).toEqual({ 'routes/runs.ts': 2, 'host/runStarter.ts': 1 });
    });
  });

  /* ── snapshot projection (§6) ───────────────────────────────────────────── */

  it('the run snapshot surfaces the stamped costUsd (host-written metadata only)', async () => {
    expect((await call('PUT', `${API}/${WF_ROUTES}/budget`, { dailyUsd: null })).status).toBe(200);
    const created = await call<{ runId: string }>('POST', '/runs', { workflowId: WF_ROUTES, inputs: {} });
    expect(created.status).toBe(201);
    let settled = '';
    for (let i = 0; i < 200 && !settled; i += 1) {
      const r = await call<{ status: string }>('GET', `/runs/${created.body.runId}`);
      if (r.body.status && !['pending', 'running'].includes(r.body.status)) settled = r.body.status;
      else await new Promise((res) => setTimeout(res, 25));
    }
    if (!settled) throw new Error(`run ${created.body.runId} did not settle after 200 polls`);
    expect(settled).toBe('completed');
    // core.noop emits no provider.usage — the additive fields stay ABSENT
    // (never zero-filled), which is the §6 fallback contract the FE relies on.
    const snap = await call<{ costUsd?: number; costByNode?: Record<string, number> }>('GET', `/runs/${created.body.runId}`);
    expect(snap.body.costUsd).toBeUndefined();
    expect(snap.body.costByNode).toBeUndefined();
  });

  it('budget row eraser redacts updatedBy in place', async () => {
    const { eraseSubjectWorkflowBudgets } = await import('../src/host/workflowBudgets.js');
    const { putWorkflowBudget } = await import('../src/host/workflowBudgets.js');
    // Its own workflow id, so the routes cases never see this budget whatever the order.
    const wf = `budget-wf-erase-${seq++}`;
    await putWorkflowBudget(TENANT, wf, { dailyUsd: 9, hardCap: false, updatedBy: 'user:erase-me' });
    expect((await getWorkflowBudget(TENANT, wf))?.updatedBy, 'precondition').toBe('user:erase-me');
    await eraseSubjectWorkflowBudgets(TENANT, 'user:erase-me');
    const after = await getWorkflowBudget(TENANT, wf);
    expect(after?.updatedBy).toBe('[erased]');
    expect(after?.dailyUsd).toBe(9);
  });
});
