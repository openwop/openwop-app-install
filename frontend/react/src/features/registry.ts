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
import type { FeatureOffline } from '../sw/offlineTypes.js';
import { crmFeature } from './crm/routes.js';
import { cdpFeature } from './cdp/routes.js';
import { csmFeature } from './csm/routes.js';
import { entitiesFeature } from './entities/routes.js';
import { environmentsFeature } from './environments/routes.js';
import { recommendationsFeature } from './recommendations/routes.js';
import { promotionsFeature } from './promotions/routes.js';
import { funnelsFeature } from './funnels/routes.js';
import { experimentsFeature } from './experiments/routes.js';
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
import { agentDeploymentsFeature } from './agent-deployments/routes.js';
import { biFeature } from './bi/routes.js';
import { serviceDeskFeature } from './service-desk/routes.js';
import { scheduledAgentChatsFeature } from './scheduled-chats/routes.js';
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
import { campaignOpsFeature } from './campaign-ops/routes.js';
import { campaignPlaybooksFeature } from './campaign-playbooks/routes.js';
import { collabFeature } from './collab/routes.js';
import { campaignsFeature } from './campaigns/routes.js';
import { campaignConnectorsFeature } from './campaign-connectors/routes.js';
import { webinarsFeature } from './webinars/routes.js';
import { creativeVideoFeature } from './creative-video/routes.js';
import { campaignIntelFeature } from './campaign-intel/routes.js';
import { accessHubFeature } from './access-hub/routes.js';
import { chatDeploymentFeature } from './chat-deployment/routes.js';
import { channelIngressFeature } from './channel-ingress/routes.js';
import { appBuilderFeature } from './app-builder/routes.js';
import { filmsFeature } from './films/routes.js';
import { slidesFeature } from './slides/routes.js';
import { drawingsFeature } from './drawings/routes.js';
import { cadFeature } from './cad/routes.js';
import { documentEditorFeature } from './document-editor/routes.js';
import { campaignStudioFeature } from './campaign-studio/routes.js';
import { canvasPacksFeature } from './canvas-packs/routes.js';
import { productionFeature } from './production/routes.js';
import { billingFeature } from './billing/routes.js';
import { showcaseFeature } from './showcase/routes.js';
import { commerceConnectFeature } from './commerce-connect/routes.js';
import { commerceUcpFeature } from './commerce-ucp/routes.js';
import { commerceUcpBuyerFeature } from './commerce-ucp-buyer/routes.js';
import { commerceFeature } from './commerce/routes.js';
import { manualTestsFeature } from './manual-tests/routes.js';
import { designSystemGalleryFeature } from './design-system-gallery/routes.js';
import { territoriesFeature } from './territories/routes.js';
import { jobSearchFeature } from './job-search/routes.js';
import { claudeCodeFeature } from './claude-code/routes.js';
import { salesCommissionsFeature } from './sales-commissions/routes.js';
import { dealersFeature } from './dealers/routes.js';
import { salesMapsFeature } from './sales-maps/routes.js';
import { i18n } from '../i18n/index.js';
// ADR 1031 — the adopter seam: features an adopter repo ships under
// `src/adopter/features/<id>/routes.tsx` (none in openwop-app), and the two
// shared surfaces a feature contributes to without the host naming it.
import { ADOPTER_FRONTEND_FEATURES, composeFrontendFeatures } from './adopterFeatures.js';
import type { DashboardTileDef } from './dashboard/tileTypes.js';
import type { Project } from './projects/projectsClient.js';
import type { ReviewArtifactRendererProps } from '../chat/reviews/reviewArtifactRenderers.js';
import type { ReviewRequest } from '../chat/reviews/reviewClient.js';
import type { ComponentType } from 'react';
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
  /**
   * ADR 0873 D1 — offline declaration. Set it to the `offline` export of the
   * feature's data-only `offline.ts` sibling (the build reads that file);
   * `src/sw/__tests__/offlineDeclarations.test.ts` pins the two together.
   */
  offline?: FeatureOffline;
  /**
   * ADR 0889 D8 — tabs a feature adds to the agent workspace (`agents/AgentWorkspacePage`).
   * Declared here for the same reason as `publicRoutes`: the page never imports a
   * feature module, so a distribution that excludes the feature drops its tab too.
   */
  agentWorkspaceTabs?: AgentWorkspaceTab[];
  /**
   * ADR 1090 — tabs this feature adds to the project detail page, after the host's
   * own, shown only while the feature is visible to the caller. Keep `render`'s
   * content `lazy(...)` inside a `<Suspense>`: this metadata ships in the entry chunk.
   */
  projectTabs?: ProjectTab[];
  /**
   * ADR 0916 (Book AI P16) — the feature's nav label/hint translations, per
   * locale, merged into the `nav` namespace when the registry loads, so a
   * route's `labelKey`/`hintKey` resolves on first render without the feature's
   * page code (whose catalog arrives with its lazy chunk, after the sidebar
   * paints). Keep it to the two or three nav strings: this ships in the entry
   * chunk. Every key must start with `<feature id>.`, so a feature cannot
   * overwrite a host nav string; `applyFeatureNavMessages` refuses anything else.
   */
  navMessages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * ADR 1031 — dashboard tiles this feature contributes. Composed after the
   * host's own in `dashboard/allTiles.ts` (`ALL_DASHBOARD_TILES`), so a feature
   * — first-party or adopter — adds a tile without editing that file, and a
   * distribution that excludes the feature drops its tiles. Set
   * `owningFeatureToggle` so the tile follows the feature's toggle, and
   * `i18nNamespace` when the label keys live in the feature's own catalog.
   * Keep the component `lazy(...)`: this metadata ships in the entry chunk.
   */
  dashboardTiles?: readonly DashboardTileDef[];
  /**
   * ADR 1031 — typed renderers for review assets this feature's workflows put up
   * for approval, keyed by `artifactTypeId` (the ADR 0459 review renderer
   * registry, which registers them on its first lookup). Wrap a `lazy(...)`
   * component in its own `<Suspense>`: this ships in the entry chunk, and the
   * review card has no boundary of its own.
   */
  reviewArtifactRenderers?: readonly FeatureReviewArtifactRenderer[];
  /**
   * ADR 1031 P2 — nav GROUPS this feature introduces (a `nav.group` label no host
   * group declares), each placed directly after an existing group in the
   * category order (`chrome/features.tsx` `GROUP_ORDER`). Without it a new group
   * sorts after every known one. An unknown anchor or a label already in the
   * order fails a test over the shipped features (chrome/__tests__/features.test.ts),
   * not code here: the splice runs in the entry chunk.
   */
  navGroups?: readonly { label: string; after: string }[];
  /**
   * ADR 1031 P2 — declarations that only LAZY surfaces read (the review card, the
   * chat run header, the Keys page, the dashboard), loaded with them instead of
   * shipping in the entry chunk: `() => import('./extensions.js').then((m) => m.extensions)`. See
   * `features/featureExtensions.ts`, which every such surface reads through.
   */
  lazyExtensions?: () => Promise<FeatureLazyExtensions>;
}

/** ADR 1031 P2 — what a feature's `lazyExtensions` module may declare. */
export interface FeatureLazyExtensions {
  /** As `FrontendFeature.navMessages` (same `<feature id>.` prefix rule and cap), for
   *  nav copy ONLY a lazy surface shows (the admin rail: chrome/AdminLayout loads
   *  these before it renders). Sidebar / site-nav copy stays on the eager
   *  `navMessages` (ADR 0916 D3, first paint). */
  navMessages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** As `FrontendFeature.dashboardTiles`, appended after them. */
  dashboardTiles?: readonly DashboardTileDef[];
  /** As `FrontendFeature.reviewArtifactRenderers`, appended after them. */
  reviewArtifactRenderers?: readonly FeatureReviewArtifactRenderer[];
  /** A section this feature adds to every review card (ADR 0068 ReviewCard), after
   *  the host's own. The component decides whether it applies (null otherwise). */
  reviewCardSections?: readonly FeatureReviewCardSection[];
  /** Display names for this feature's workflows in the chat run header, per locale
   *  (`{ en: { '<workflowId>': 'Name' } }`). Consulted after the `chat` catalog's
   *  `workflowNames` and before the backend's English default. */
  chatWorkflowNames?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** BYOK ref prefixes a card of this feature owns: the Keys page's unscoped bucket
   *  leaves them out (they would read as unscoped keys). */
  cardOwnedCredentialRefPrefixes?: readonly string[];
}

/** ADR 1031 P2 — one feature-contributed review-card section. */
export interface FeatureReviewCardSection {
  id: string;
  component: ComponentType<{ review: ReviewRequest; resolved: boolean }>;
}

/** ADR 1031 — one feature-contributed review renderer. */
export interface FeatureReviewArtifactRenderer {
  artifactTypeId: string;
  component: ComponentType<ReviewArtifactRendererProps>;
  /** Shape check that lets UNTYPED content render in this type's layout. */
  matches?: (content: string) => boolean;
}

/** ADR 1090 — a feature-contributed project tab. `key` is the `?tab=` value. */
export interface ProjectTab {
  key: string;
  /** English fallback; `labelKey` resolves in `labelNamespace` (default: the feature's own namespace). */
  label: string;
  labelKey?: string;
  labelNamespace?: string;
  /** Ascending among contributed tabs; ties by key. */
  order?: number;
  /** ADR 1095 — show only to callers whose project role is listed (a caller with
   *  write access always sees it). PRESENTATION ONLY: a role is a label, never a
   *  scope (ADR 0054 D2); the tab's own reads keep their backend checks. */
  forRoles?: readonly ('lead' | 'contributor' | 'observer')[];
  render: (p: { project: Project; canWrite: boolean }) => ReactNode;
}

/** A feature-contributed agent-workspace tab. `labelKey` is in the `agents` i18n namespace. */
export interface AgentWorkspaceTab {
  key: string;
  labelKey: string;
  /** `onDirtyChange` — the tab reports unsaved edits; the host then asks before switching tabs (ADR 0889 EVUX-5). */
  render: (p: { agentId: string; persona: string; canWrite: boolean; onDirtyChange?: (dirty: boolean) => void }) => ReactNode;
}

/** Every frontend feature the app composes. Append a new feature here.
 *  ADR 1031 — an adopter's features (`src/adopter/features/<id>/routes.tsx`) are
 *  appended after these by `composeFrontendFeatures`, which throws on a duplicate id. */
export const FRONTEND_FEATURES: FrontendFeature[] = composeFrontendFeatures([crmFeature, cdpFeature, csmFeature, usersFeature, profilesFeature, mediaFeature, cmsFeature, notificationsFeature, kbFeature, publishingFeature, sharingFeature, formsFeature, consentFeature, analyticsFeature, connectionsFeature, emailFeature, commentsFeature, marketplaceFeature, agentKnowledgeFeature, advisoryBoardFeature, projectsFeature, documentsFeature, priorityMatrixFeature, strategyFeature, brandFeature, campaignBriefFeature, creativeBriefsFeature, campaignOrchestrationFeature, campaignOpsFeature, collabFeature, campaignPlaybooksFeature, campaignConnectorsFeature, webinarsFeature, creativeVideoFeature, campaignIntelFeature, campaignsFeature, usageAnalyticsFeature, evalsFeature, agentDeploymentsFeature, scheduledAgentChatsFeature, channelsFeature, chatWidgetFeature, capabilityFirewallFeature, modelRouterFeature, ambientWorkGraphFeature, navigationSettingsFeature, accessHubFeature, channelIngressFeature, chatDeploymentFeature, appBuilderFeature, slidesFeature, filmsFeature, drawingsFeature, cadFeature, documentEditorFeature, campaignStudioFeature, canvasPacksFeature, productionFeature, billingFeature, commerceConnectFeature, commerceFeature, commerceUcpFeature, commerceUcpBuyerFeature, recommendationsFeature, promotionsFeature, funnelsFeature, experimentsFeature, tutorialsFeature, customDomainsFeature, discoveryFeature, manualTestsFeature, designSystemGalleryFeature, territoriesFeature, jobSearchFeature, salesCommissionsFeature, dealersFeature, salesMapsFeature, uiPluginsFeature, dashboardFeature, entitiesFeature, environmentsFeature, biFeature, serviceDeskFeature, showcaseFeature, claudeCodeFeature,
], ADOPTER_FRONTEND_FEATURES);

/** ADR 0916 — merge each feature's `navMessages` into the `nav` namespace,
 *  keeping only keys under the feature's own `<id>.` prefix (so a feature can
 *  never overwrite a host nav string). This runs in the ENTRY chunk, so it is
 *  deliberately minimal: the size limits (8 keys / 160 chars per locale) are a
 *  test over the shipped features (`featureNavMessages.test.ts`), not code here. */
export function applyFeatureNavMessages(
  features: readonly Pick<FrontendFeature, 'id' | 'navMessages'>[],
  add: (locale: string, messages: Record<string, string>) => void,
): void {
  for (const f of features) {
    for (const [locale, messages] of Object.entries(f.navMessages ?? {})) {
      add(locale, Object.fromEntries(Object.entries(messages).filter(([k]) => k.startsWith(`${f.id}.`))));
    }
  }
}

applyFeatureNavMessages(FRONTEND_FEATURES, (locale, messages) => i18n.addResourceBundle(locale, 'nav', messages, true, false));

// ADR 1031 P2 — fetch the composed features' lazy-extension chunks off the critical
// path, so the lazy surface that reads them (featureExtensions.ts) finds them loaded.
setTimeout(() => { for (const f of FRONTEND_FEATURES) void f.lazyExtensions?.().catch(() => undefined); }, 0);

/** ADR 1031 P2 — the nav groups the composed features introduce, in registry order. */
export function featureNavGroups(): Array<{ label: string; after: string }> {
  return FRONTEND_FEATURES.flatMap((f) => [...(f.navGroups ?? [])]);
}

/** Flatten every feature's routes for the manifest. */
export function featureRoutes(): FeatureRoute[] {
  // Stamp each route with its OWNING feature id (ADR 0419). Without this the
  // flatten discards the owner and the only handle left is `nav.featureId`, which
  // exists solely on index routes — leaving every detail/deep-link route
  // unguarded by `EntitlementGuard`. Doing it here means it cannot be forgotten
  // by a new feature or a new route within an existing one.
  // ADR 0873 D12 — the offline entitlement mode rides along for the same reason.
  return FRONTEND_FEATURES.flatMap((f) => f.routes.map((r) => ({
    ...r,
    ownerFeatureId: f.id,
    ...(f.offline?.entitlement ? { ownerOfflineEntitlement: f.offline.entitlement } : {}),
  })));
}

/** ADR 0889 — the agent-workspace tabs contributed by the composed features, with their owner. */
/** ADR 1090 — every feature's project tabs, stamped with the feature, in display order. */
export function featureProjectTabs(): Array<ProjectTab & { featureId: string }> {
  return FRONTEND_FEATURES.flatMap((f) => (f.projectTabs ?? []).map((t) => ({ ...t, featureId: f.id })))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key));
}

export function featureAgentWorkspaceTabs(): Array<AgentWorkspaceTab & { featureId: string }> {
  return FRONTEND_FEATURES.flatMap((f) => (f.agentWorkspaceTabs ?? []).map((t) => ({ ...t, featureId: f.id })));
}

/** ADR 0873 D12 — the features whose online answers `FeatureAccessProvider`
 *  records as last-known offline grants. */
export function lastKnownEntitlementFeatureIds(): string[] {
  return FRONTEND_FEATURES.filter((f) => f.offline?.entitlement === 'last-known').map((f) => f.id);
}
