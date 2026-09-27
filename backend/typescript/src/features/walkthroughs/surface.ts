/**
 * Guided-tours workflow surface (ADR 0368 Phase 6d — `ctx.features.walkthroughs`).
 * A THIN, READ-ONLY adapter (ADR 0014), the honest replacement for the
 * originally-deferred `ctx.guidedTours.launch`: a backend run has no live FE
 * player, so it cannot *launch* a tour at a user — but it CAN read tour state to
 * gate a branch (e.g. an onboarding/heartbeat workflow: "has the tenant
 * completed the intro tour? if not, …"). No writes, no imperative launch.
 *
 * Both ops are tenant-scoped (`scope.tenantId`) and toggle-gated automatically
 * by `registerFeatureSurface` (the surface id IS the `guided-tours` toggle id —
 * a tenant with the feature OFF gets `host_capability_disabled` on every call).
 * Progress is TENANT-level (the store carries no userId); named accordingly.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import type { FeatureSurface } from '../../host/featureSurfaces.js';
import type { WorkflowDefinition } from '../../executor/types.js';
import { listRegisteredWorkflows } from '../../host/workflowsRegistry.js';
import { listChainBackedWorkflows } from '../../host/chainBackedWorkflows.js';
import { LEGACY_CAMPAIGN_STUDIO_ID } from './walkthroughIds.js';
import { listOwned } from '../../host/workflowOwnership.js';
import { listWalkthroughProgress } from './progressStore.js';

const isWalkthrough = (d: WorkflowDefinition): boolean => d.metadata?.walkthrough === true || d.metadata?.tour === true;
const projectWalkthrough = (d: WorkflowDefinition): { walkthroughId: string; name: string } => ({
  walkthroughId: d.workflowId,
  name: typeof d.metadata?.name === 'string' ? d.metadata.name : d.workflowId,
});

export function buildWalkthroughsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** Tours this tenant can launch: first-party SYSTEM tours (builtins, visible
     *  to every tenant) ∪ the caller-tenant's OWN authored tours. The owned half
     *  is resolved via the ownership index (ADR 0163 R1) — NEVER the raw global
     *  registry, which holds every tenant's workflows and would leak them.
     *  Transient/archived drafts are excluded (the catalog default filter). */
    listWalkthroughs: async () => {
      const ownedIds = new Set((await listOwned(tenantId)).map((r) => r.workflowId));
      const byId = new Map<string, { walkthroughId: string; name: string }>();
      for (const d of listChainBackedWorkflows()) if (isWalkthrough(d) && d.workflowId !== LEGACY_CAMPAIGN_STUDIO_ID) byId.set(d.workflowId, projectWalkthrough(d));
      for (const d of listRegisteredWorkflows()) if (isWalkthrough(d) && ownedIds.has(d.workflowId)) byId.set(d.workflowId, projectWalkthrough(d));
      return { walkthroughs: [...byId.values()] };
    },
    /** The tenant's tour progress (tenant-level: started/completed per tour).
     *  Internal columns (tenantId, key) are dropped. */
    walkthroughProgress: async () => ({
      // Grade-pass (two independent audits): pass the RUN's acting user so the
      // surface sees the ADR 0378 P3 per-user rows — with no userId the store
      // returns LEGACY tenant-level rows only, so every post-P3 completion was
      // invisible here ("has the tenant done the intro walkthrough" always
      // read false). System runs (no actingUserId) still get the legacy view.
      progress: (await listWalkthroughProgress(tenantId, scope.actingUserId)).map(({ walkthroughId, status, runId, updatedAt }) => ({ walkthroughId, status, runId, updatedAt })),
    }),
  };
}
