/**
 * Strategy workflow surface (ADR 0079 Phase 6 / ADR 0014 Phase 1) — the typed
 * `ctx.features.strategy` a workflow node calls. Tenant comes from the run scope
 * (CTI-1); toggle-gated at the registry seam (featureSurfaces.gate).
 *
 * Authoring stays read-only (strategy CRUD is a human/admin act). ADR 0231 adds
 * ONE write — `checkIn` — that is STRUCTURALLY a proposal: an agent/run write
 * lands `proposed` for a human to confirm; only the metric-sync mode writes
 * `confirmed`, and only against a KR whose `measure.source` a human configured
 * (fail-closed in `checkIns.ts` — the capability firewall cannot see node
 * calls, adsAdapter.ts:204).
 *
 * RBAC. The STRATEGY-ROW lane is tenant-trusted: the surface exposes the SHARED
 * strategies (`workspace`/`org` scope) only — `user`-scoped private drafts are
 * authorized creator-only and CANNOT be exposed to a run, so they are excluded
 * (no private-draft leak across a tenant). Context project enrichment rides
 * `resolveProjectAccess`, so member-scoped `private` projects are likewise
 * omitted (fail-closed).
 *
 * CORRECTION 2026-08-22 (ADR 0597 §Correction 1) — this header used to say "a
 * `BundleScope` carries no caller subject", and the CROSS-ENTITY link lane was
 * built on that. It is false: `BundleScope.actingUserId` carries the run
 * owner's durable principal for every human-started run (`executor.ts` reads
 * `run.metadata.actingUserId`); it is absent only for SYSTEM runs, which is the
 * fail-closed signal, not the universal case. The org-read gate now keys on it
 * (`runOrgReadPredicate` below) and falls back to tenant-wide only when it is
 * genuinely absent.
 *
 * @see docs/adr/0079-strategic-planning.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptStr } from '../../host/featureSurfaces.js';
import { listStrategies, getStrategy, resolveStrategyContext, resolveStrategyHealth, orgReadPredicate } from './strategyService.js';
import { appendCheckIn, listCheckIns, listCheckInsByStrategy, computeStrategyProgress, DEFAULT_STALE_DAYS } from './checkIns.js';
import { syncSourcedKrs } from './metricSync.js';
import type { Strategy } from './types.js';

/** Shared (non-private-draft) strategies a subjectless run may see. */
const isShared = (s: Strategy): boolean => s.scope !== 'user';

const refOf = (s: Strategy) => ({
  id: s.id,
  title: s.title,
  scope: s.scope,
  status: s.status,
  horizon: s.planningHorizon,
  orgId: s.orgId,
});

/**
 * ADR 0597 §Correction 1 — the org-read gate for a RUN.
 *
 * This lane used to pass `async () => true` unconditionally, and ADR 0597 §2
 * defended it with *"a run has no acting human to scope to."* That premise was
 * FALSE: `executor.ts` reads `run.metadata.actingUserId` and stamps it onto the
 * `BundleScope`, `inMemorySurfaces.ts` documents it as present for human runs
 * and ABSENT for system runs (schedule / inbound webhook — "the correct
 * fail-closed signal"), and this feature's OWN `agentTools.ts` already keyed on
 * it. So an org-A-only member who started a run received org-B idea titles,
 * `computedPriority` and `rank` through `getStrategyContext`, and org-B link
 * counts through `getHealth` — while `GET /:id/context` over the same links
 * withheld them and the agent tool over the same data withheld them too. Two
 * lanes of one feature disagreeing is the shape SPC-2 closed one file away.
 *
 * The `true` FALLBACK IS LOAD-BEARING and stays. A cadence fire registers no
 * `metadata.actingUserId` (`cadence.ts` passes no `metadata` to `registerJob`),
 * so a scheduled weekly-checkin / board-pack is genuinely subjectless and must
 * still project the tenant's shared data — the priority-matrix `listPortfolio`
 * precedent. Narrowing it to "no subject ⇒ nothing" would empty every scheduled
 * digest, which is why the fallback has its own witness in
 * `strategy-cross-org.test.ts` alongside the narrowing.
 *
 * SCOPE, stated so the next reader does not over-read this: it gates the
 * cross-entity LINK projection only. Which STRATEGY ROWS a run may see is still
 * the tenant-trusted `isShared` posture documented at the top of this file —
 * unchanged here, and recorded as a residual in ADR 0597 rather than widened
 * inside a fix for something else.
 */
const runOrgReadPredicate = (scope: BundleScope): ((orgId: string) => Promise<boolean>) =>
  (scope.actingUserId ? orgReadPredicate(scope.tenantId, scope.actingUserId) : async () => true);

export function buildStrategySurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** The workspace's SHARED strategies (compact refs; excludes user drafts + archived). */
    listStrategies: async () => ({
      strategies: (await listStrategies(tenantId, { includeArchived: false })).filter(isShared).map(refOf),
    }),

    /** One strategy by id, with its objectives/initiatives/links. Returns null for
     *  a missing OR user-scoped (private-draft) strategy — a subjectless run can't
     *  authorize a creator-only read. */
    getStrategy: async (args) => {
      const s = await getStrategy(tenantId, surfaceStr(args.id));
      if (!s || !isShared(s)) return { strategy: null };
      return {
        strategy: {
          ...refOf(s),
          ...(s.summary ? { summary: s.summary } : {}),
          ...(s.rationale ? { rationale: s.rationale } : {}),
          objectives: s.objectives.map((o) => ({ title: o.title, keyResults: o.keyResults.map((k) => ({ title: k.title, ...(k.target ? { target: k.target } : {}) })) })),
          initiatives: s.initiatives.map((i) => ({ title: i.title, ...(i.status ? { status: i.status } : {}) })),
          links: s.links,
        },
      };
    },

    /** Resolve the compact strategy context packet for a consumer ref
     *  (projectId | priorityListId[+cardId] | boardId). Tenant-trusted: shared
     *  strategies whose links match, enriched (private projects omitted). */
    getStrategyContext: async (args) => {
      const projectId = surfaceOptStr(args.projectId);
      const priorityListId = surfaceOptStr(args.priorityListId);
      const cardId = surfaceOptStr(args.cardId);
      const boardId = surfaceOptStr(args.boardId);
      const all = (await listStrategies(tenantId, { includeArchived: false })).filter(isShared);
      const linked = all.filter((s) => s.links.some((l) => {
        if (projectId) return l.kind === 'project' && l.projectId === projectId;
        if (priorityListId && cardId) return l.kind === 'priority-idea' && l.listId === priorityListId && l.cardId === cardId;
        if (priorityListId) return (l.kind === 'priority-list' && l.listId === priorityListId) || (l.kind === 'priority-idea' && l.listId === priorityListId);
        if (boardId) return l.kind === 'advisory-board' && l.boardId === boardId;
        return false;
      }));
      // ADR 0597 §Correction 1 — scoped to the run's acting human when it has
      // one; tenant-wide only for a genuinely subjectless (system) run. Projects
      // still gate on their own member-scoped access via resolveProjectAccess.
      const strategies = await resolveStrategyContext(tenantId, linked, undefined, runOrgReadPredicate(scope));
      return { strategies };
    },

    /** Per-strategy health rollup over the workspace's SHARED strategies (ADR 0080).
     *  Tenant-trusted; each row carries the component `signals` so the caller (the
     *  Strategy Analyst) can reason about gaps without inventing precision. */
    getHealth: async () => {
      const shared = (await listStrategies(tenantId, { includeArchived: false })).filter(isShared);
      const strategies = await resolveStrategyHealth(tenantId, shared, undefined, runOrgReadPredicate(scope));
      return { strategies };
    },

    // ── ADR 0231: the measurement loop (the ONE write is structurally a proposal) ──

    /** Record a check-in from a run. `mode:'sync'` (the metric-sync chain) writes
     *  CONFIRMED — but ONLY against a KR whose `measure.source` a human configured
     *  (fail-closed otherwise). Anything else (the Strategy Analyst included)
     *  lands as PROPOSED for a human to confirm — the capability firewall cannot
     *  see node calls (adsAdapter.ts:204), so the gate lives HERE, in the owner. */
    checkIn: async (args) => {
      const s = await getStrategy(tenantId, surfaceStr(args.strategyId));
      if (!s || !isShared(s)) return { checkIn: null };
      const mode = surfaceOptStr(args.mode) === 'sync' ? 'sync' : 'agent';
      const value = typeof args.value === 'number' && Number.isFinite(args.value) ? args.value : undefined;
      const note = surfaceOptStr(args.note);
      const row = await appendCheckIn({
        strategy: s,
        krId: surfaceStr(args.krId),
        ...(value !== undefined ? { value } : {}),
        ...(note ? { note } : {}),
        origin: mode,
        actor: surfaceOptStr(args.actor) ?? 'workflow',
      });
      return { checkIn: row };
    },

    /** Check-ins for one shared strategy (newest first; optionally one KR). */
    listCheckIns: async (args) => {
      const s = await getStrategy(tenantId, surfaceStr(args.strategyId));
      if (!s || !isShared(s)) return { checkIns: [] };
      return { checkIns: await listCheckIns(tenantId, s.id, surfaceOptStr(args.krId)) };
    },

    /** ADR 0231 §C3 — sync every sourced KR from its configured data owner.
     *  Writes ride the ONE check-in path (`origin:'sync'` — confirmed only by
     *  the standing `measure.source` authorization). Returns the honest
     *  synced/skipped matrix; the run output IS the sync-health view. */
    syncMetrics: async (args) => {
      const r = await syncSourcedKrs(tenantId, surfaceOptStr(args.actor) ?? 'workflow');
      return { synced: r.synced, skipped: r.skipped };
    },

    /** Measured KRs with no confirmed check-in inside the staleness window —
     *  the cadence chain's work list (ADR 0231 §C2). */
    listStaleKrs: async (args) => {
      const staleDays = typeof args.staleDays === 'number' && Number.isFinite(args.staleDays) && args.staleDays > 0 ? args.staleDays : DEFAULT_STALE_DAYS;
      const shared = (await listStrategies(tenantId, { includeArchived: false })).filter(isShared).filter((s) => s.status === 'active');
      const out: Array<{ strategyId: string; strategyTitle: string; orgId: string; krId: string; krTitle: string; ownerUserId?: string }> = [];
      // STRAT-PERF-1 (grade-code): one indexed read for the whole work list.
      const byStrategy = await listCheckInsByStrategy(tenantId);
      for (const s of shared) {
        const rows = byStrategy.get(s.id) ?? [];
        const progress = computeStrategyProgress(s, rows, Date.now(), staleDays);
        if (progress.staleKrCount === 0) continue;
        const confirmedByKr = new Map<string, string>();
        for (const r of rows) if (r.status === 'confirmed' && (!confirmedByKr.has(r.krId) || confirmedByKr.get(r.krId)! < r.createdAt)) confirmedByKr.set(r.krId, r.createdAt);
        const staleBefore = Date.now() - staleDays * 86_400_000;
        for (const o of s.objectives) {
          for (const kr of o.keyResults) {
            if (!kr.measure) continue;
            const last = confirmedByKr.get(kr.id);
            if (!last || Date.parse(last) < staleBefore) {
              out.push({ strategyId: s.id, strategyTitle: s.title, orgId: s.orgId, krId: kr.id, krTitle: kr.title, ...(s.ownerUserId ? { ownerUserId: s.ownerUserId } : {}) });
            }
          }
        }
      }
      return { staleKrs: out };
    },
  };
}
