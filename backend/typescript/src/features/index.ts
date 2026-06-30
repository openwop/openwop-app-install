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
import { registerToggleDefault } from '../host/featureToggles/registry.js';
import { retireToggleOverrides } from '../host/featureToggles/service.js';
import { registerFeatureSurface } from '../host/featureSurfaces.js';
import { registerBuiltinWorkflow } from '../host/builtinWorkflows.js';
import type { RouteDeps } from '../routes/registerAllRoutes.js';
import type { BackendFeature, PackRef } from './types.js';
import { widgetsFeature } from './widgets.js';
import { crmFeature } from './crm/feature.js';
import { csmFeature } from './csm/feature.js';
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
import { appBuilderFeature } from './app-builder/feature.js';
import { campaignStudioFeature } from './campaign-studio/feature.js';
import { drawingsFeature } from './drawings/feature.js';
import { cadFeature } from './cad/feature.js';
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
import { modelsFeature } from './models/feature.js';
import { chatDeploymentFeature } from './chat-deployment/feature.js';
import { contextEconomyFeature } from './context-economy/feature.js';
import { publishingFeature } from './publishing/feature.js';
import { sharingFeature } from './sharing/feature.js';
import { formsFeature } from './forms/feature.js';
import { consentFeature } from './consent/feature.js';
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
import { portabilityFeature } from './portability/feature.js';
import { twinFeature } from './twin/feature.js';
import { projectsFeature } from './projects/feature.js';
import { documentsFeature } from './documents/feature.js';
import { priorityMatrixFeature } from './priority-matrix/feature.js';
import { strategyFeature } from './strategy/feature.js';
import { brandFeature } from './brand/feature.js';
import { campaignBriefFeature } from './campaign-brief/feature.js';
import { campaignChannelsFeature } from './campaign-channels/feature.js';
import { campaignOrchestrationFeature } from './campaign-orchestration/feature.js';
import { campaignConnectorsFeature } from './campaign-connectors/feature.js';
import { campaignIntelFeature } from './campaign-intel/feature.js';
import { workflowAuthorFeature } from './workflow-author/feature.js';
import { insightsSuiteFeature } from './insights-suite/feature.js';
import { toolOutputCompactionFeature } from './tool-output-compaction/feature.js';
import { notebooksFeature } from './notebooks/feature.js';
import { podcastsFeature } from './podcasts/feature.js';
import { knowledgeSyncFeature } from './knowledge-sync/feature.js';
import { multiTabChatFeature } from './multi-tab-chat/feature.js';
import { chatAutotitleFeature } from './chat-autotitle/feature.js';

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
] as const;

/** Every backend feature the app composes. Append a new feature here. */
export const BACKEND_FEATURES: BackendFeature[] = [widgetsFeature, crmFeature, csmFeature, usersFeature, orgsFeature, profilesFeature, profileMemoryFeature, mediaFeature, cmsFeature, notificationsFeature, kbFeature, publishingFeature, sharingFeature, formsFeature, consentFeature, analyticsFeature, assistantFeature, connectionsFeature, emailFeature, commentsFeature, marketplaceFeature, agentKnowledgeFeature, advisoryBoardFeature, proposalsFeature, goalsFeature, portabilityFeature, twinFeature, projectsFeature, documentsFeature, priorityMatrixFeature, strategyFeature, brandFeature, campaignBriefFeature, campaignChannelsFeature, campaignOrchestrationFeature, campaignConnectorsFeature, campaignIntelFeature, workflowAuthorFeature, insightsSuiteFeature, toolOutputCompactionFeature, notebooksFeature, podcastsFeature, knowledgeSyncFeature, conversationSearchFeature, codeExecFeature, promptsFeature, memoryAutoExtractFeature, scheduledAgentChatsFeature, channelsFeature, chatWidgetFeature, interactiveArtifactsFeature, slidesFeature, appBuilderFeature, campaignStudioFeature, drawingsFeature, cadFeature, modelRouterFeature, conversationToolsFeature, taskDeckFeature, capabilityFirewallFeature, intentLedgerFeature, ambientWorkGraphFeature, chatExportFeature, evalsFeature, usageAnalyticsFeature, voiceFeature, navigationSettingsFeature, modelsFeature, chatDeploymentFeature, multiTabChatFeature, chatAutotitleFeature, contextEconomyFeature];

/** Declare toggle defaults + mount routes + register workflow surfaces for every
 *  backend feature (ADR 0014 — the composer wires all faces in one pass). */
export function registerBackendFeatures(deps: RouteDeps): void {
  for (const feature of BACKEND_FEATURES) {
    if (feature.toggleDefault) registerToggleDefault(feature.toggleDefault);
    feature.registerRoutes(deps);
    // Face 2 (ADR 0014 Phase 1): the feature's ctx.features.<id> workflow surface.
    if (feature.surface) registerFeatureSurface(feature.surface.id, feature.surface.build);
    // Built-in workflows (hard-coded catalog seam): restart-safe + cross-instance,
    // resolved by host/index.ts source A — not the in-memory builder registry.
    for (const wf of feature.builtinWorkflows ?? []) registerBuiltinWorkflow(wf);
    log.debug('feature_registered', { id: feature.id, packs: feature.requiredPacks?.length ?? 0, surface: feature.surface?.id ?? null, builtinWorkflows: feature.builtinWorkflows?.length ?? 0 });
  }
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
