/**
 * Frontend feature registry (ADR 0001 §2.2).
 *
 * The single list of separately-distributed feature packages' frontend halves.
 * chrome/features.tsx composes the app's FEATURES from the core routes PLUS the
 * routes collected here — so a new feature is wired by appending its
 * FrontendFeature, never by editing the core manifest.
 *
 * Each FrontendFeature contributes route+nav entries (FeatureRoute[]); a feature
 * gates its own nav/pages on its toggle via useFeatureAccess at render time
 * (Phase 4). Empty until the first product feature (CRM) ships.
 */
import type { FeatureRoute } from '../chrome/featureTypes.js';
import { crmFeature } from './crm/routes.js';
import { csmFeature } from './csm/routes.js';
import { usersFeature } from './users/routes.js';
import { profilesFeature } from './profiles/routes.js';
import { mediaFeature } from './media/routes.js';
import { cmsFeature } from './cms/routes.js';
import { notificationsFeature } from './notifications/routes.js';
import { kbFeature } from './kb/routes.js';
import { publishingFeature } from './publishing/routes.js';
import { sharingFeature } from './sharing/routes.js';
import { formsFeature } from './forms/routes.js';
import { consentFeature } from './consent/routes.js';
import { analyticsFeature } from './analytics/routes.js';
import { usageAnalyticsFeature } from './usage-analytics/routes.js';
import { evalsFeature } from './evals/routes.js';
import { scheduledChatsFeature } from './scheduled-chats/routes.js';
import { channelsFeature } from './channels/routes.js';
import { chatWidgetFeature } from './chat-widget/routes.js';
import { capabilityFirewallFeature } from './capability-firewall/routes.js';
import { modelRouterFeature } from './model-router/routes.js';
import { ambientWorkGraphFeature } from './ambient-work-graph/routes.js';
import { navigationSettingsFeature } from './navigation-settings/routes.js';
import { connectionsFeature } from './connections/routes.js';
import { emailFeature } from './email/routes.js';
import { commentsFeature } from './comments/routes.js';
import { marketplaceFeature } from './marketplace/routes.js';
import { agentKnowledgeFeature } from './agent-knowledge/routes.js';
import { advisoryBoardFeature } from './advisory-board/routes.js';
import { projectsFeature } from './projects/routes.js';
import { documentsFeature } from './documents/routes.js';
import { priorityMatrixFeature } from './priority-matrix/routes.js';
import { strategyFeature } from './strategy/routes.js';
import { brandFeature } from './brand/routes.js';
import { campaignBriefFeature } from './campaign-brief/routes.js';
import { campaignOrchestrationFeature } from './campaign-orchestration/routes.js';
import { campaignConnectorsFeature } from './campaign-connectors/routes.js';
import { campaignIntelFeature } from './campaign-intel/routes.js';
import { accessHubFeature } from './access-hub/routes.js';
import { modelsFeature } from './models/routes.js';
import { chatDeploymentFeature } from './chat-deployment/routes.js';
import { appBuilderFeature } from './app-builder/routes.js';
// ADR 0084 correction — notebooks (Sources) + podcasts are surfaced as PROJECT tabs
// (ProjectDetailPage), not standalone top-level nav destinations. Their feature
// modules + i18n still ship (the panels are imported by the projects feature); only
// the standalone routes/nav are withdrawn here.

export interface FrontendFeature {
  /** Feature id — matches the backend toggle id. */
  id: string;
  /** Route + nav entries appended to the app's FEATURES manifest. */
  routes: FeatureRoute[];
}

/** Every frontend feature the app composes. Append a new feature here. */
export const FRONTEND_FEATURES: FrontendFeature[] = [crmFeature, csmFeature, usersFeature, profilesFeature, mediaFeature, cmsFeature, notificationsFeature, kbFeature, publishingFeature, sharingFeature, formsFeature, consentFeature, analyticsFeature, connectionsFeature, emailFeature, commentsFeature, marketplaceFeature, agentKnowledgeFeature, advisoryBoardFeature, projectsFeature, documentsFeature, priorityMatrixFeature, strategyFeature, brandFeature, campaignBriefFeature, campaignOrchestrationFeature, campaignConnectorsFeature, campaignIntelFeature, usageAnalyticsFeature, evalsFeature, scheduledChatsFeature, channelsFeature, chatWidgetFeature, capabilityFirewallFeature, modelRouterFeature, ambientWorkGraphFeature, navigationSettingsFeature, accessHubFeature, modelsFeature, chatDeploymentFeature, appBuilderFeature];

/** Flatten every feature's routes for the manifest. */
export function featureRoutes(): FeatureRoute[] {
  return FRONTEND_FEATURES.flatMap((f) => f.routes);
}
