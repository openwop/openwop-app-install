/**
 * Strategy workflow surface (ADR 0079 Phase 6 / ADR 0014 Phase 1) — the typed
 * `ctx.features.strategy` a workflow node calls. Tenant comes from the run scope
 * (CTI-1); toggle-gated at the registry seam (featureSurfaces.gate). READ-ONLY:
 * strategy authoring stays a human/admin act (the deferred agent pack is the
 * write path, ADR 0058 chat-drivability pattern).
 *
 * RBAC: a run is TENANT-TRUSTED (a `BundleScope` carries no caller subject — the
 * priority-matrix `listPortfolio` precedent). The surface therefore exposes the
 * SHARED strategies (`workspace`/`org` scope) only — `user`-scoped private drafts
 * are authorized creator-only and CANNOT be exposed to a subjectless run, so they
 * are excluded (no private-draft leak across a tenant). Context project
 * enrichment rides `resolveProjectAccess`, so member-scoped `private` projects
 * are likewise omitted (fail-closed).
 *
 * @see docs/adr/0079-strategic-planning.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptStr } from '../../host/featureSurfaces.js';
import { listStrategies, getStrategy, resolveStrategyContext, resolveStrategyHealth } from './strategyService.js';
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
      // Tenant-trusted: orgs are all readable; projects still gate on their own
      // (member-scoped) access via resolveProjectAccess inside resolveStrategyContext.
      const strategies = await resolveStrategyContext(tenantId, linked, undefined, async () => true);
      return { strategies };
    },

    /** Per-strategy health rollup over the workspace's SHARED strategies (ADR 0080).
     *  Tenant-trusted; each row carries the component `signals` so the caller (the
     *  Strategy Analyst) can reason about gaps without inventing precision. */
    getHealth: async () => {
      const shared = (await listStrategies(tenantId, { includeArchived: false })).filter(isShared);
      const strategies = await resolveStrategyHealth(tenantId, shared, undefined, async () => true);
      return { strategies };
    },
  };
}
