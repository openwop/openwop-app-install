/**
 * Backend feature registry (ADR 0001 §2.2).
 *
 * The single list the base app composes alongside the core route modules. A
 * separately-distributed feature is wired by appending its BackendFeature here
 * — no edits to registerAllRoutes' core list. `registerBackendFeatures` is
 * called once, after the core modules are mounted, from registerAllRoutes.ts.
 *
 * Each feature, at registration: (1) declares its toggle default into the
 * toggle registry, (2) mounts its routes. Pack installation (requiredPacks) is
 * driven separately at boot from the union of features (Phase 3/4) so packs
 * stay present regardless of toggle state.
 */

import { createLogger } from '../observability/logger.js';
import { registerFeatureDependencies, registerFeaturePacks, registerFeatureRecommends, registerToggleDefault } from '../host/featureToggles/registry.js';
import { retireToggleOverrides } from '../host/featureToggles/service.js';
import { registerFeatureSurface } from '../host/featureSurfaces.js';
import { registerChainBackedWorkflow, validateChainBackedSubChainBinds } from '../host/chainBackedWorkflows.js';
import type { RouteDeps } from '../routes/registerAllRoutes.js';
import type { BackendFeature, PackRef } from './types.js';
import { widgetsFeature } from './widgets.js';
import { crmFeature } from './crm/feature.js';
import { cdpFeature } from './cdp/feature.js';
import { computerUseFeature } from './computer-use/feature.js';
import { biFeature } from './bi/feature.js';
import { serviceDeskFeature } from './service-desk/feature.js';
import { destinationSyncFeature } from './destination-sync/feature.js';
import { developerKeysFeature } from './developer-keys/feature.js';
import { csmFeature } from './csm/feature.js';
import { entitiesFeature } from './entities/feature.js';
import { environmentsFeature } from './environments/feature.js';
import { whatsappFeature } from './whatsapp/feature.js';
import { webinarsFeature } from './webinars/feature.js';
import { creativeVideoFeature } from './creative-video/feature.js';
import { operationsFeature } from './operations/feature.js';
import { settingsFeature } from './settings/feature.js';
import { usersFeature } from './users/feature.js';
import { orgsFeature } from './orgs/feature.js';
import { profilesFeature } from './profiles/feature.js';
import { profileMemoryFeature } from './profile-memory/feature.js';
import { mediaFeature } from './media/feature.js';
import { cmsFeature } from './cms/feature.js';
import { notificationsFeature } from './notifications/feature.js';
import { kbFeature } from './kb/feature.js';
import { conversationSearchFeature } from './conversation-search/feature.js';
import { codeExecFeature } from './code-exec/feature.js';
import { promptsFeature } from './prompts/feature.js';
import { memoryAutoExtractFeature } from './memory-auto-extract/feature.js';
import { scheduledAgentChatsFeature } from './scheduled-agent-chats/feature.js';
import { channelsFeature } from './channels/feature.js';
import { chatWidgetFeature } from './chat-widget/feature.js';
import { interactiveArtifactsFeature } from './interactive-artifacts/feature.js';
import { slidesFeature } from './slides/feature.js';
import { canvasPacksFeature } from './canvas-packs/feature.js';
import { appBuilderFeature } from './app-builder/feature.js';
import { campaignStudioFeature } from './campaign-studio/feature.js';
import { drawingsFeature } from './drawings/feature.js';
import { cadFeature } from './cad/feature.js';
import { documentEditorFeature } from './document-editor/feature.js';
import { collaborationFeature } from '../host/collab/collabServer.js';
import { workflowCollabFeature } from '../host/collab/workflowCollabResource.js';
import { modelRouterFeature } from './model-router/feature.js';
import { conversationToolsFeature } from './conversation-tools/feature.js';
import { taskDeckFeature } from './task-deck/feature.js';
import { capabilityFirewallFeature } from './capability-firewall/feature.js';
import { intentLedgerFeature } from './intent-ledger/feature.js';
import { ambientWorkGraphFeature } from './ambient-work-graph/feature.js';
import { chatExportFeature } from './chat-export/feature.js';
import { evalsFeature } from './evals/feature.js';
import { usageAnalyticsFeature } from './usage-analytics/feature.js';
import { voiceFeature } from './voice/feature.js';
import { navigationSettingsFeature } from './navigation-settings/feature.js';
import { heartbeatAdminFeature } from './heartbeat-admin/feature.js';
import { runtimePostureFeature } from './runtime-posture/feature.js';
import { modelsFeature } from './models/feature.js';
import { chatDeploymentFeature } from './chat-deployment/feature.js';
import { campaignsFeature } from './campaigns/feature.js';
import { contextEconomyFeature } from './context-economy/feature.js';
import { productionFeature } from './production/feature.js';
import { docsFeature } from './docs/feature.js';
import { accessibilityFeature } from './accessibility/feature.js';
import { billingFeature } from './billing/feature.js';
import { commerceFeature } from './commerce/feature.js';
import { recommendationsFeature } from './recommendations/feature.js';
import { promotionsFeature } from './promotions/feature.js';
import { funnelsFeature } from './funnels/feature.js';
import { customDomainsFeature } from './custom-domains/feature.js';
import { discoveryFeature } from './discovery/feature.js';
import { manualTestsFeature } from './manual-tests/feature.js';
import { developerToolsFeature } from './developer-tools/feature.js';
import { runInputFormsFeature } from './run-input-forms/feature.js';
import { territoriesFeature } from './territories/feature.js';
import { salesCommissionsFeature } from './sales-commissions/feature.js';
import { dealersFeature } from './dealers/feature.js';
import { salesMapsFeature } from './sales-maps/feature.js';
import { publishingFeature } from './publishing/feature.js';
import { sharingFeature } from './sharing/feature.js';
import { formsFeature } from './forms/feature.js';
import { consentFeature } from './consent/feature.js';
import { uiPluginsFeature } from './ui-plugins/feature.js';
import { analyticsFeature } from './analytics/feature.js';
import { assistantFeature } from './assistant/feature.js';
import { connectionsFeature } from './connections/feature.js';
import { emailFeature } from './email/feature.js';
import { commentsFeature } from './comments/feature.js';
import { marketplaceFeature } from './marketplace/feature.js';
import { agentKnowledgeFeature } from './agent-knowledge/feature.js';
import { advisoryBoardFeature } from './advisory-board/feature.js';
import { proposalsFeature } from './proposals/feature.js';
import { goalsFeature } from './goals/feature.js';
import { walkthroughsFeature } from './walkthroughs/feature.js';
import { tutorialsFeature } from './tutorials/feature.js';
import { dashboardFeature } from './dashboard/feature.js';
import { portabilityFeature } from './portability/feature.js';
import { twinFeature } from './twin/feature.js';
import { projectsFeature } from './projects/feature.js';
import { documentsFeature } from './documents/feature.js';
import { priorityMatrixFeature } from './priority-matrix/feature.js';
import { strategyFeature } from './strategy/feature.js';
import { brandFeature } from './brand/feature.js';
import { campaignBriefFeature } from './campaign-brief/feature.js';
import { creativeBriefsFeature } from './creative-briefs/feature.js';
import { campaignChannelsFeature } from './campaign-channels/feature.js';
import { campaignOrchestrationFeature } from './campaign-orchestration/feature.js';
import { campaignConnectorsFeature } from './campaign-connectors/feature.js';
import { campaignIntelFeature } from './campaign-intel/feature.js';
import { campaignJourneysFeature } from './campaign-journeys/feature.js';
import { workflowAuthorFeature } from './workflow-author/feature.js';
import { agentAuthorFeature } from './agent-author/feature.js';
import { insightsSuiteFeature } from './insights-suite/feature.js';
import { toolOutputCompactionFeature } from './tool-output-compaction/feature.js';
import { notebooksFeature } from './notebooks/feature.js';
import { podcastsFeature } from './podcasts/feature.js';
import { knowledgeSyncFeature } from './knowledge-sync/feature.js';
import { multiTabChatFeature } from './multi-tab-chat/feature.js';
import { chatAutotitleFeature } from './chat-autotitle/feature.js';
import { commerceConnectFeature } from './commerce-connect/feature.js';
import { kicktodoCoreFeature } from './kicktodo-core/feature.js';
import { kicktodoCreatorFeature } from './kicktodo-creator/feature.js';
import { kicktodoCommerceFeature } from './kicktodo-commerce/feature.js';
import { kicktodoAccountabilityFeature } from './kicktodo-accountability/feature.js';
import { kicktodoIntegrationsFeature } from './kicktodo-integrations/feature.js';
import { kicktodoEngagementFeature } from './kicktodo-engagement/feature.js';
import { kicktodoCommunityFeature } from './kicktodo-community/feature.js';
import { kicktodoOrganizationsFeature } from './kicktodo-organizations/feature.js';
import { kicktodoMetricsFeature } from './kicktodo-metrics/feature.js';
import { workSelectionFeature } from './work-selection/feature.js';
import { jobSearchFeature } from './job-search/feature.js';
import type { WorkflowDefinition } from '../executor/types.js';
// ADR 0472 Phase 3 — the still-pinned builtin workflow defs, imported DIRECTLY
// from their source modules to build the LEGACY_PINNED_WORKFLOWS quarantine.
import { ucpMcpToolWorkflows } from './commerce/ucp/ucpMcpTools.js';
import { kicktodoBuiltinWorkflows } from './kicktodo-core/builtinWorkflows.js';
import { campaignOrchestrationParallel } from './campaign-orchestration/orchestrationWorkflow.js';
import { kicktodoIntegrationsBuiltinWorkflows } from './kicktodo-integrations/builtinWorkflows.js';
import { docsMcpToolWorkflows } from './docs/mcpToolsWorkflows.js';
import { podcastsBuiltinWorkflows } from './podcasts/generateWorkflow.js';
import { MARKET_INTEL_WORKFLOWS, KERNEL_WORKFLOWS } from './campaign-brief/intelWorkflows.js';
import { CHANNEL_WORKFLOWS } from './campaign-channels/channelWorkflows.js';
import { productionBuiltinWorkflows } from './production/builtinWorkflows.js';
import { ONWARD_SYNC_WORKFLOWS } from './destination-sync/onwardSyncWorkflow.js';
import { kicktodoCreatorBuiltinWorkflows } from './kicktodo-creator/builtinWorkflows.js';
import { notebooksBuiltinWorkflows } from './notebooks/summarizeWorkflow.js';
import { notebookMcpToolWorkflows } from './notebooks/mcpToolsWorkflows.js';
import { appBuilderMcpControlWorkflows } from './app-builder/mcpControlWorkflows.js';
import { kicktodoAccountabilityBuiltinWorkflows } from './kicktodo-accountability/builtinWorkflows.js';

const log = createLogger('features');

/**
 * Toggle ids RETIRED when their feature became always-on (ADR 0027 — cms/media/
 * publishing; ADR 0024 § Correction — connections; ADR 0002 § Correction —
 * users). `registerBackendFeatures` deletes any lingering durable override for
 * these at boot so they don't resurrect as ghost toggles (the store wins over the
 * now-absent default). Keep entries here even after the override is gone — the
 * reconcile is idempotent and documents the retirement.
 */
const RETIRED_TOGGLE_IDS = [
  'cms', 'media', 'publishing', 'connections', 'users', 'profiles', 'profile-memory', 'projects', 'agent-knowledge', 'project-collab', 'workflow-author',
  // ADR 0134 — the AI-chat feature set graduated to always-on (toggles removed); retire any stale per-tenant overrides at boot.
  'conversation-search', 'conversation-tools', 'model-router', 'interactive-artifacts', 'prompts', 'chat-export',
  'memory-auto-extract', 'scheduled-agent-chats', 'task-deck', 'evals', 'kb', 'channels', 'chat-widget', 'code-exec',
  // 2026-06-24 — the three governance/automation features graduated to always-on
  // (ADR 0135 firewall ships rule-less; 0136 ledger user-initiated; 0137 work-graph
  // page + on-demand scan; the work-graph background sweep stays env-gated).
  'capability-firewall', 'intent-ledger', 'ambient-work-graph',
  // ADR 0170 — brand graduated to always-on/core (no toggleDefault); retire
  // stale stored rows so getEffectiveConfig ghosts prune at boot (grade-data
  // DG-DOC-4 closure — the code already matched the ADR; only this retirement
  // line was missing).
  'brand',
  // ADR 0319 — each canvas type merged its generation + editor toggles into ONE
  // (the bare `<type>` id survives); retire the now-removed `-editor` variants so a
  // tenant's stored per-tenant override doesn't linger as an orphan. Also `canvases`
  // — the standalone Canvases browser folded into Documents (its toggle is gone).
  'slides-editor', 'drawings-editor', 'cad-editor', 'campaign-studio-editor', 'canvases',
  // ADR 0434 (2026-07-19) — four substrate features graduated to always-on, plus
  // `context-economy` retired as an inert switch. All five were ALREADY classified
  // `core` in distributions/bundles.json (non-excludable substrate) while their
  // toggles still advertised them as optional — the two catalogs disagreed.
  // `run-input-forms` was an explicit pre-GA opt-in; `sharing` is a host seam five
  // features import (it had needed a toggle-bypass carve-out); `developer-keys`
  // gated only key MANAGEMENT while core auth verified keys unconditionally;
  // `models` chose a nav shape, not a capability; `context-economy` gated nothing
  // at all (env-governed — now a read-only admin/env-governed projection).
  'run-input-forms', 'sharing', 'developer-keys', 'models', 'context-economy',
] as const;

/** Every backend feature the app composes. Append a new feature here. */
export const BACKEND_FEATURES: BackendFeature[] = [widgetsFeature, crmFeature, cdpFeature, destinationSyncFeature, developerKeysFeature, csmFeature, usersFeature, orgsFeature, profilesFeature, profileMemoryFeature, mediaFeature, cmsFeature, notificationsFeature, kbFeature, publishingFeature, sharingFeature, formsFeature, consentFeature, analyticsFeature, assistantFeature, connectionsFeature, emailFeature, commentsFeature, marketplaceFeature, agentKnowledgeFeature, advisoryBoardFeature, proposalsFeature, goalsFeature, portabilityFeature, twinFeature, projectsFeature, documentsFeature, priorityMatrixFeature, strategyFeature, brandFeature, campaignBriefFeature, creativeBriefsFeature, campaignChannelsFeature, campaignOrchestrationFeature, campaignConnectorsFeature, campaignIntelFeature, campaignJourneysFeature, campaignsFeature, workflowAuthorFeature, agentAuthorFeature, insightsSuiteFeature, toolOutputCompactionFeature, notebooksFeature, podcastsFeature, knowledgeSyncFeature, conversationSearchFeature, codeExecFeature, promptsFeature, memoryAutoExtractFeature, scheduledAgentChatsFeature, channelsFeature, chatWidgetFeature, interactiveArtifactsFeature, slidesFeature, appBuilderFeature, campaignStudioFeature, drawingsFeature, cadFeature, documentEditorFeature, modelRouterFeature, conversationToolsFeature, taskDeckFeature, capabilityFirewallFeature, intentLedgerFeature, ambientWorkGraphFeature, chatExportFeature, evalsFeature, usageAnalyticsFeature, voiceFeature, navigationSettingsFeature, modelsFeature, chatDeploymentFeature, multiTabChatFeature, chatAutotitleFeature, contextEconomyFeature, productionFeature, accessibilityFeature, billingFeature, commerceFeature, recommendationsFeature, promotionsFeature, discoveryFeature, funnelsFeature, customDomainsFeature, manualTestsFeature, developerToolsFeature, runInputFormsFeature, territoriesFeature, salesCommissionsFeature, dealersFeature, salesMapsFeature, uiPluginsFeature, canvasPacksFeature, heartbeatAdminFeature, runtimePostureFeature, collaborationFeature, workflowCollabFeature, walkthroughsFeature, tutorialsFeature, dashboardFeature, commerceConnectFeature, docsFeature, entitiesFeature, environmentsFeature, whatsappFeature, webinarsFeature, creativeVideoFeature, operationsFeature, settingsFeature, kicktodoCoreFeature, kicktodoCreatorFeature, biFeature, computerUseFeature, kicktodoCommerceFeature, kicktodoAccountabilityFeature, kicktodoIntegrationsFeature, kicktodoEngagementFeature, kicktodoCommunityFeature, kicktodoOrganizationsFeature, serviceDeskFeature, kicktodoMetricsFeature, workSelectionFeature, jobSearchFeature];

/**
 * ADR 0472 Phase 4 — DRAINED QUARANTINE (terminal state). This array held the builtin
 * workflow defs not yet migrated to a chain pack; it is now EMPTY — every builtin
 * migrated to an RFC 0013/0133 chain pack (chain-backed same-id) or a re-pointed
 * mechanism, and `host/builtinWorkflows.ts` (the registry that consumed this) is
 * DELETED. A code-pinned, UI-unreachable workflow is no longer expressible at any
 * layer: the `BackendFeature.builtinWorkflows` FIELD is gone (declaring one is a
 * TypeScript error), the registry MODULE is gone, and this array is frozen empty by
 * the ADR 0472 ratchet (NO-GROWTH anchored at zero). It is retained ONLY as the
 * ratchet's empty-enforcement fixture — DO NOT ADD to it; ship a chain pack via
 * `registerChainBackedWorkflow`, or a stack (ADR 0311). See
 * docs/adr/0472-retire-builtin-workflows-seam.md.
 */
export const LEGACY_PINNED_WORKFLOWS: readonly WorkflowDefinition[] = [
];

/** Declare toggle defaults + mount routes + register workflow surfaces for every
 *  backend feature (ADR 0014 — the composer wires all faces in one pass). */
/**
 * ADR 0472 P4 — register the 19 MCP tool-projection workflows CHAIN-BACKED (from
 * `examples/workflow-chain-packs/mcp-tool-projections/`), under their original *.mcp.*
 * ids so the MCP router + /v1/tools projection resolve unchanged. The per-projection
 * workflow METADATA carries the ADR 0087 security gates (`mcpRequiresAuth`,
 * `mcpFeatureToggle`, `mcpSafetyTier`, `mcpApproval`, `mcpTool`) which the portable
 * fragment cannot carry — so it is restored VERBATIM from the source def here, along
 * with each node's `outputRole`. The source arrays stay the readable SSoT (no longer
 * builtins — out of LEGACY_PINNED). NO gate is recomputed; the exact original object
 * is copied, so the projection's authz is byte-identical.
 */
/** ADR 0472 P4 — the 4 notebooks workflows CHAIN-BACKED (from the notebooks pack),
 *  under their stable ids (ignition + replay unchanged), node outputRoles restored
 *  verbatim from the source defs (fragment can't carry them). Source stays the SSoT. */
export function registerNotebooksWorkflows(): void {
  for (const src of notebooksBuiltinWorkflows) {
    const roles = new Map(src.nodes.filter((n) => n.outputRole).map((n) => [n.nodeId, n.outputRole] as const));
    registerChainBackedWorkflow(src.workflowId, {
      postProcess: (def) => {
        for (const node of def.nodes) {
          let role: 'primary' | 'secondary' | undefined;
          // Grade-trio fix: pick the LONGEST matching source id — a bare suffix
          // match lets 'build-0' also claim 'x_build-0' (last-match-wins was order-dependent).
          let bestLen = -1;
          for (const [origId, r] of roles) {
            if (node.nodeId !== origId && !node.nodeId.endsWith(`_${origId}`)) continue;
            if (origId.length > bestLen) { bestLen = origId.length; role = r; }
          }
          if (role) node.outputRole = role; else if (node.outputRole !== undefined) delete node.outputRole;
        }
      },
    });
  }
}

/** ADR 0472 P4 — register a set of migrated defs CHAIN-BACKED under their stable ids,
 *  restoring each node's `outputRole` verbatim from the source (the fragment can't carry
 *  it). The source array stays the readable SSoT (no longer a builtin). */
export function registerLegacyDefsChainBacked(defs: readonly { workflowId: string; nodes: ReadonlyArray<{ nodeId: string; outputRole?: 'primary' | 'secondary' }> }[]): void {
  for (const src of defs) {
    const roles = new Map(src.nodes.filter((n) => n.outputRole).map((n) => [n.nodeId, n.outputRole] as const));
    registerChainBackedWorkflow(src.workflowId, {
      postProcess: (def) => {
        for (const node of def.nodes) {
          let role: 'primary' | 'secondary' | undefined;
          // Grade-trio fix: pick the LONGEST matching source id — a bare suffix
          // match lets 'build-0' also claim 'x_build-0' (last-match-wins was order-dependent).
          let bestLen = -1;
          for (const [origId, r] of roles) {
            if (node.nodeId !== origId && !node.nodeId.endsWith(`_${origId}`)) continue;
            if (origId.length > bestLen) { bestLen = origId.length; role = r; }
          }
          if (role) node.outputRole = role; else if (node.outputRole !== undefined) delete node.outputRole;
        }
      },
    });
  }
}

export function registerMcpProjectionWorkflows(): void {
  const sources = [...ucpMcpToolWorkflows, ...docsMcpToolWorkflows, ...notebookMcpToolWorkflows, ...appBuilderMcpControlWorkflows];
  for (const src of sources) {
    const roles = new Map(src.nodes.filter((n) => n.outputRole).map((n) => [n.nodeId, n.outputRole] as const));
    registerChainBackedWorkflow(src.workflowId, {
      postProcess: (def) => {
        // The ADR 0087 gates ride VERBATIM from the source (they win every collision)
        // — but this was a REPLACE, and a replace DELETES the chain-derived metadata
        // the expansion just produced. MEASURED (ADR 0603 §2): it strips
        // `deferredParameterAliases` from 3 of the 4 sampled MCP projections, which
        // makes the PODWF-1 fix in `buildChainBackedDefinition` structurally
        // unreachable for this whole lane, plus `chainId` / `expansionMode` /
        // `expandedFrom` (the re-parameterization anchor; `seedWorkflows.ts:196,283`
        // reads `expansionMode`) and `mintedPromptTemplates`. MERGE, never replace.
        // Additive: `src.metadata` here is `{kind, feature, mcpTool, mcpFeatureToggle,
        // mcpRequiresAuth, mcpSafetyTier, mcpApproval}` — it collides with NONE of the
        // chain keys, so every gate is byte-identical to before.
        def.metadata = { ...(def.metadata ?? {}), ...(src.metadata ?? {}) };
        for (const node of def.nodes) {
          let role: 'primary' | 'secondary' | undefined;
          // Grade-trio fix: pick the LONGEST matching source id — a bare suffix
          // match lets 'build-0' also claim 'x_build-0' (last-match-wins was order-dependent).
          let bestLen = -1;
          for (const [origId, r] of roles) {
            if (node.nodeId !== origId && !node.nodeId.endsWith(`_${origId}`)) continue;
            if (origId.length > bestLen) { bestLen = origId.length; role = r; }
          }
          if (role) node.outputRole = role; else if (node.outputRole !== undefined) delete node.outputRole;
        }
      },
    });
  }
}

/**
 * ADR 0684 phase 1 — the default orgs features declare, for the boot provisioner.
 * Mirrors `featurePackRefs()`: the feature declares, boot consumes, core never
 * learns a product name.
 */
export function featureDefaultOrgs(): { featureId: string; orgId: string; tenantId: string; name: string }[] {
  // orgId AND tenantId both come from the single declared `id`: a workspace
  // root is an org whose id equals its tenant, so there is nothing to choose
  // between and no way to declare them apart (ADR 0684 correction).
  return BACKEND_FEATURES.flatMap((f) =>
    f.defaultOrg ? [{ featureId: f.id, orgId: f.defaultOrg.id, tenantId: f.defaultOrg.id, name: f.defaultOrg.name }] : []);
}

export function registerBackendFeatures(deps: RouteDeps): void {
  for (const feature of BACKEND_FEATURES) {
    if (feature.toggleDefault) registerToggleDefault(feature.toggleDefault);
    // ADR 0404 §P4 — a feature's sub-toggles (nested capabilities), registered the
    // same way as the primary toggle but AND-gated with it at the route/verb.
    for (const t of feature.extraToggleDefaults ?? []) registerToggleDefault(t);
    // ADR 0194 — hard feature deps → the disable-lock graph (always register, even
    // when empty, so a hot-reload that DROPS a dep clears the stale edge).
    registerFeatureDependencies(feature.id, feature.dependsOn ?? []);
    // ADR 0194 Phase 2 — pinned packs → the Plugins-console projection (same rule).
    registerFeaturePacks(feature.id, feature.requiredPacks ?? []);
    // ADR 0194 Phase 5 — soft deps → console suggestions (advisory, never a lock).
    registerFeatureRecommends(feature.id, feature.recommends ?? []);
    feature.registerRoutes(deps);
    // Face 2 (ADR 0014 Phase 1): the feature's ctx.features.<id> workflow surface.
    if (feature.surface) registerFeatureSurface(feature.surface.id, feature.surface.build);
    log.debug('feature_registered', { id: feature.id, packs: feature.requiredPacks?.length ?? 0, surface: feature.surface?.id ?? null });
  }
  registerMcpProjectionWorkflows(); // ADR 0472 P4 — MCP projections are chain-backed now
  registerNotebooksWorkflows(); // ADR 0472 P4
  registerLegacyDefsChainBacked(podcastsBuiltinWorkflows); // ADR 0472 P4
  registerLegacyDefsChainBacked(productionBuiltinWorkflows); // ADR 0472 P4
  registerLegacyDefsChainBacked(KERNEL_WORKFLOWS); // ADR 0472 P4
  registerLegacyDefsChainBacked(MARKET_INTEL_WORKFLOWS); // ADR 0472 P4
  registerLegacyDefsChainBacked(kicktodoBuiltinWorkflows); // ADR 0472 P4 (replan; falsy edge rides RFC 0134)
  registerLegacyDefsChainBacked(ONWARD_SYNC_WORKFLOWS); // ADR 0472 P4 (cdp-sync; peerIngestUrl resolves via config template at runtime)
  registerLegacyDefsChainBacked(CHANNEL_WORKFLOWS); // ADR 0472 P4 (5 campaign channels; static channel + itemsFrom preserved)
  registerLegacyDefsChainBacked([campaignOrchestrationParallel]); // ADR 0472 P4 (parallel channel fan-out shape; sequential kill-switch retired)
  registerLegacyDefsChainBacked(kicktodoCreatorBuiltinWorkflows); // ADR 0472 P4 TERMINAL (challenge-factory + lesson-batch; RFC 0133 sub-chain host-default binds subChainRef→same-id child)
  registerLegacyDefsChainBacked(kicktodoIntegrationsBuiltinWorkflows); // ADR 0472 P4
  registerLegacyDefsChainBacked(kicktodoAccountabilityBuiltinWorkflows); // ADR 0472 P4
  // CBW-1 — after every chain-backed registration above, verify each host-default
  // subChainRef→workflowId bind resolves to a workflow actually registered same-id
  // (a declared-but-unregistered sibling, or an external ref this host never
  // registered, is otherwise a silent dangling runtime dispatch). Loud, soft at boot.
  validateChainBackedSubChainBinds();
  // ADR 0027: retire durable overrides for features that became always-on, so a
  // previously-saved per-tenant override doesn't linger as a ghost toggle.
  // Fire-and-forget — boot must not block on storage; logged on completion.
  void retireToggleOverrides(RETIRED_TOGGLE_IDS)
    .then((removed) => { if (removed.length) log.info('retired_toggle_overrides', { ids: removed }); })
    .catch((err) => log.warn('retire_toggle_overrides_failed', { error: String(err) }));
}

/** The union of all features' required packs (Phase 3/4: boot install set). */
export function featurePackRefs(): PackRef[] {
  const seen = new Set<string>();
  const out: PackRef[] = [];
  for (const feature of BACKEND_FEATURES) {
    for (const ref of feature.requiredPacks ?? []) {
      const key = `${ref.name}@${ref.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}
