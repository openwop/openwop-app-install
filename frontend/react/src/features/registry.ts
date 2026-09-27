import type { ReactNode } from 'react';
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
import { cdpFeature } from './cdp/routes.js';
import { csmFeature } from './csm/routes.js';
import { entitiesFeature } from './entities/routes.js';
import { environmentsFeature } from './environments/routes.js';
import { recommendationsFeature } from './recommendations/routes.js';
import { promotionsFeature } from './promotions/routes.js';
import { funnelsFeature } from './funnels/routes.js';
import { tutorialsFeature } from './tutorials/routes.js';
import { customDomainsFeature } from './custom-domains/routes.js';
import { discoveryFeature } from './product-discovery/routes.js';
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
import { uiPluginsFeature } from './ui-plugins/routes.js';
import { analyticsFeature } from './analytics/routes.js';
import { usageAnalyticsFeature } from './usage-analytics/routes.js';
import { evalsFeature } from './evals/routes.js';
import { biFeature } from './bi/routes.js';
import { serviceDeskFeature } from './service-desk/routes.js';
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
import { dashboardFeature } from './dashboard/routes.js';
import { brandFeature } from './brand/routes.js';
import { campaignBriefFeature } from './campaign-brief/routes.js';
import { creativeBriefsFeature } from './creative-briefs/routes.js';
import { campaignOrchestrationFeature } from './campaign-orchestration/routes.js';
import { campaignsFeature } from './campaigns/routes.js';
import { campaignConnectorsFeature } from './campaign-connectors/routes.js';
import { webinarsFeature } from './webinars/routes.js';
import { creativeVideoFeature } from './creative-video/routes.js';
import { campaignIntelFeature } from './campaign-intel/routes.js';
import { accessHubFeature } from './access-hub/routes.js';
import { modelsFeature } from './models/routes.js';
import { chatDeploymentFeature } from './chat-deployment/routes.js';
import { appBuilderFeature } from './app-builder/routes.js';
import { slidesFeature } from './slides/routes.js';
import { drawingsFeature } from './drawings/routes.js';
import { cadFeature } from './cad/routes.js';
import { documentEditorFeature } from './document-editor/routes.js';
import { campaignStudioFeature } from './campaign-studio/routes.js';
import { canvasPacksFeature } from './canvas-packs/routes.js';
import { productionFeature } from './production/routes.js';
import { billingFeature } from './billing/routes.js';
import { commerceConnectFeature } from './commerce-connect/routes.js';
import { commerceUcpFeature } from './commerce-ucp/routes.js';
import { commerceUcpBuyerFeature } from './commerce-ucp-buyer/routes.js';
import { commerceFeature } from './commerce/routes.js';
import { manualTestsFeature } from './manual-tests/routes.js';
import { designSystemGalleryFeature } from './design-system-gallery/routes.js';
import { territoriesFeature } from './territories/routes.js';
import { jobSearchFeature } from './job-search/routes.js';
import { salesCommissionsFeature } from './sales-commissions/routes.js';
import { dealersFeature } from './dealers/routes.js';
import { salesMapsFeature } from './sales-maps/routes.js';
import { kicktodoFeature } from './kicktodo/routes.js';
import { kicktodoCirclesFeature } from './kicktodo-circles/routes.js';
import { kicktodoEngagementFeature } from './kicktodo-engagement/routes.js';
import { kicktodoCommunityFeature } from './kicktodo-community/routes.js';
import { kicktodoOrgProgramsFeature } from './kicktodo-org-programs/routes.js';
import { kicktodoStudioFeature } from './kicktodo-studio/routes.js';
import { kicktodoAdminFeature } from './kicktodo-admin/routes.js';
import { kicktodoMetricsFeature } from './kicktodo-metrics/routes.js';
import { kicktodoSeatsFeature } from './kicktodo-seats/routes.js';
// ADR 0084 correction — notebooks (Sources) + podcasts are surfaced as PROJECT tabs
// (ProjectDetailPage), not standalone top-level nav destinations. Their feature
// modules + i18n still ship (the panels are imported by the projects feature); only
// the standalone routes/nav are withdrawn here.

export interface FrontendFeature {
  /** Feature id — matches the backend toggle id. */
  id: string;
  /** Route + nav entries appended to the app's FEATURES manifest. */
  routes: FeatureRoute[];
  /**
   * ADR 0630 — PUBLIC pages a feature owns above the auth gate (rendered in the bare
   * PublicShell by App.tsx). Declared here so App.tsx never imports a feature module
   * directly: a distribution that excludes the feature excludes its public page too.
   * `match` is a pure pathname test; `render` returns the (lazy) element.
   */
  publicRoutes?: { match: (pathname: string) => boolean; render: () => ReactNode }[];
}

/** Every frontend feature the app composes. Append a new feature here. */
export const FRONTEND_FEATURES: FrontendFeature[] = [crmFeature, cdpFeature, csmFeature, usersFeature, profilesFeature, mediaFeature, cmsFeature, notificationsFeature, kbFeature, publishingFeature, sharingFeature, formsFeature, consentFeature, analyticsFeature, connectionsFeature, emailFeature, commentsFeature, marketplaceFeature, agentKnowledgeFeature, advisoryBoardFeature, projectsFeature, documentsFeature, priorityMatrixFeature, strategyFeature, brandFeature, campaignBriefFeature, creativeBriefsFeature, campaignOrchestrationFeature, campaignConnectorsFeature, webinarsFeature, creativeVideoFeature, campaignIntelFeature, campaignsFeature, usageAnalyticsFeature, evalsFeature, scheduledChatsFeature, channelsFeature, chatWidgetFeature, capabilityFirewallFeature, modelRouterFeature, ambientWorkGraphFeature, navigationSettingsFeature, accessHubFeature, modelsFeature, chatDeploymentFeature, appBuilderFeature, slidesFeature, drawingsFeature, cadFeature, documentEditorFeature, campaignStudioFeature, canvasPacksFeature, productionFeature, billingFeature, commerceConnectFeature, commerceFeature, commerceUcpFeature, commerceUcpBuyerFeature, recommendationsFeature, promotionsFeature, funnelsFeature, tutorialsFeature, customDomainsFeature, discoveryFeature, manualTestsFeature, designSystemGalleryFeature, territoriesFeature, jobSearchFeature, salesCommissionsFeature, dealersFeature, salesMapsFeature, uiPluginsFeature, dashboardFeature, entitiesFeature, environmentsFeature, kicktodoFeature, kicktodoCirclesFeature,
  kicktodoEngagementFeature,
  kicktodoCommunityFeature, kicktodoOrgProgramsFeature,
  kicktodoStudioFeature,
  kicktodoAdminFeature,
  kicktodoMetricsFeature,
  kicktodoSeatsFeature, biFeature, serviceDeskFeature,
];

/** Flatten every feature's routes for the manifest. */
export function featureRoutes(): FeatureRoute[] {
  // Stamp each route with its OWNING feature id (ADR 0419). Without this the
  // flatten discards the owner and the only handle left is `nav.featureId`, which
  // exists solely on index routes — leaving every detail/deep-link route
  // unguarded by `EntitlementGuard`. Doing it here means it cannot be forgotten
  // by a new feature or a new route within an existing one.
  return FRONTEND_FEATURES.flatMap((f) => f.routes.map((r) => ({ ...r, ownerFeatureId: f.id })));
}
