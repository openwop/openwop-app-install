/**
 * ADR 0598 — the failure disclosures that were INVISIBLE to
 * `check-notice-announce.mjs` until rule 2 learned four new shapes
 * (`variant="error"`, the `if (flag) return <Notice…>` early return, a flag named
 * exactly `failed`, and — per §Correction 2 — a compound `&&` gate whose
 * failed-read flag is not the operand adjacent to the operator).
 *
 * MEASURED: **192 silent disclosures**, across **179 (file, flag) sites** in
 * **153 files**. They are NOT audited and NOT approved — they are pre-existing,
 * and they belong to ~60 other features whose own grade passes will reach them.
 * Fixing them inside feature 26's PR would have hidden the count inside an
 * unrelated change, which is the opposite of what a measured blast radius is for
 * (PR-A's precedent with the 44 title-only notify nodes).
 *
 * ── WHY (file, flag, count) AND NOT A FILE SET (§Correction 3 of the review) ──
 *
 * This shipped as a `Set<file>` plus a global count, and that pair is a
 * **153-file-wide SLOT** — the exact failure this gate's own docblock argues
 * against at `check-notice-announce.mjs` :13-17, reintroduced 192 wide.
 * PROVEN: wiring `announce` onto `agentAllowlists/AgentAllowlistPanel.tsx:90`
 * and adding a brand-new silent disclosure in the SAME file left the count at
 * 192 and the file set unchanged, and the gate printed a tick. A fixed
 * violation had bought a new one.
 *
 * The key is (file, FLAG) rather than file:line for the reason the allowlist
 * gives: line numbers shift on every edit above them, so an entry stops
 * matching, the gate reports a violation on untouched code, and the cheapest
 * repair is bumping the number — which trains "edit the list" instead of "fix
 * the defect". A flag name only changes on a deliberate RENAME, which is exactly
 * when re-reviewing the entry is correct.
 *
 * STILL NOT CAUGHT, and named rather than implied: a swap **within one (file,
 * flag) pair** — fixing one `error`-gated notice in a file and adding another
 * `error`-gated one beside it. Distinguishing those needs line or content
 * identity, which the paragraph above rejects for a 179-entry mechanical list.
 * The slot is now the width of one (file, flag) count, not of 153 files.
 *
 * These are COUNTS, not reasons. 179 fabricated reasons would be worse than
 * none — a list that reads as reviewed and is not. When you clean a feature,
 * DELETE or LOWER its rows here and lower the gate's baseline. Never raise
 * either; the gate refuses a row that matches nothing, so a stale entry cannot
 * sit here pretending to cover something.
 *
 * @type {ReadonlyArray<readonly [file: string, flag: string, count: number]>}
 */
export const LEGACY_SILENT_READ_SITES = [
  ['agentAllowlists/AgentAllowlistPanel.tsx', 'error', 1],
  ['agents/AgentActivityTab.tsx', 'error', 1],
  ['agents/AgentBoardPanel.tsx', 'error', 2],
  ['agents/AgentConnectionStatusPanel.tsx', 'error', 1],
  ['agents/AgentCreateWizard.tsx', 'error', 1],
  ['agents/AgentDashboardPage.tsx', 'error', 1],
  ['agents/AgentDetailPage.tsx', 'error', 1],
  ['agents/AgentGuardrailsPanel.tsx', 'error', 2],
  ['agents/AgentInstallPage.tsx', 'error', 1],
  ['agents/AgentInstallPage.tsx', 'installError', 1],
  ['agents/AgentInstructionsPanel.tsx', 'error', 1],
  ['agents/AgentIntegrationsPanel.tsx', 'error', 1],
  ['agents/AgentVoicePanel.tsx', 'error', 1],
  ['agents/AgentWorkflowPortfolioPanel.tsx', 'error', 1],
  ['agents/RosterPage.tsx', 'error', 1],
  ['auth/AuthCard.tsx', 'error', 2],
  ['auth/SignInButton.tsx', 'deleteError', 1],
  ['auth/SignInButton.tsx', 'error', 2],
  ['brand/AppearancePanel.tsx', 'error', 1],
  ['brand/AppearancePanel.tsx', 'jsonError', 1],
  ['byok/KeysPage.tsx', 'error', 1],
  ['byok/RealtimeVoiceSettings.tsx', 'error', 1],
  ['byok/SubscriptionCredentialCard.tsx', 'error', 1],
  ['canvas/HistoryModal.tsx', 'error', 1],
  ['chat/artifacts/ArtifactWorkbench.tsx', 'error', 1],
  ['chrome/VendorSetupPrompt.tsx', 'error', 1],
  ['discovery/CapabilitiesPanel.tsx', 'error', 1],
  ['features/advisory-board/AdvisoryBoardPage.tsx', 'error', 1],
  ['features/agent-knowledge/AgentMemoryTab.tsx', 'error', 1],
  ['features/ambient-work-graph/WorkGraphPage.tsx', 'error', 1],
  ['features/app-builder/PublishModal.tsx', 'error', 1],
  ['features/app-builder/SyncModal.tsx', 'error', 1],
  ['features/bi/MetricsPage.tsx', 'error', 1],
  ['features/bi/MetricsPage.tsx', 'formError', 1],
  ['features/brand/BrandPage.tsx', 'error', 1],
  ['features/campaign-brief/CampaignBriefPage.tsx', 'error', 1],
  ['features/campaign-connectors/CampaignConnectorsPage.tsx', 'error', 1],
  ['features/campaign-intel/CampaignIntelPage.tsx', 'error', 1],
  ['features/campaign-intel/CampaignIntelPage.tsx', 'planError', 1],
  ['features/campaign-orchestration/CampaignStudioPage.tsx', 'error', 1],
  ['features/capability-firewall/FirewallRulesPage.tsx', 'error', 1],
  ['features/capability-firewall/FirewallRulesPage.tsx', 'exprError', 1],
  ['features/cdp/CdpConsolePage.tsx', 'decisionsError', 1],
  ['features/cdp/CdpConsolePage.tsx', 'eventsError', 1],
  ['features/cdp/CdpConsolePage.tsx', 'mergesError', 1],
  ['features/cdp/CdpConsolePage.tsx', 'schemasError', 1],
  ['features/chat-widget/WidgetGrantEditor.tsx', 'error', 1],
  ['features/chat-widget/WidgetsPage.tsx', 'error', 1],
  ['features/cms/CmsLanguageSettings.tsx', 'error', 1],
  ['features/cms/CmsLanguageSettings.tsx', 'grantsError', 1],
  ['features/cms/CmsLanguageSettings.tsx', 'settingsError', 1],
  ['features/cms/CmsPage.tsx', 'error', 1],
  ['features/cms/PageExperimentsPanel.tsx', 'loadError', 1],
  ['features/commerce/StorefrontPage.tsx', 'error', 1],
  ['features/connections/OAuthClientAdminPanel.tsx', 'error', 1],
  ['features/connections/VaultAdminPanel.tsx', 'error', 1],
  ['features/creative-briefs/CreativeBriefsPage.tsx', 'deepLinkError', 1],
  ['features/creative-briefs/CreativeBriefsPage.tsx', 'error', 1],
  ['features/creative-briefs/RendersSection.tsx', 'error', 1],
  ['features/creative-video/CreativeVideoPage.tsx', 'error', 1],
  ['features/crm/PublicBookingPage.tsx', 'formError', 2],
  ['features/crm/PublicSignPage.tsx', 'error', 1],
  ['features/custom-domains/DomainsPage.tsx', 'error', 1],
  ['features/dashboard/DashboardPage.tsx', 'saveFailed', 1],
  ['features/document-editor/DocumentToolbarExtras.tsx', 'error', 1],
  ['features/documents/DocumentDetailPage.tsx', 'error', 1],
  ['features/documents/DocumentsPage.tsx', 'error', 1],
  ['features/email/EmailTemplateDetailPage.tsx', 'error', 1],
  ['features/entities/EntitiesPage.tsx', 'error', 1],
  ['features/entities/SchemaGraphPage.tsx', 'error', 1],
  ['features/environments/EnvironmentsPage.tsx', 'promotionsError', 1],
  ['features/environments/EnvironmentsPage.tsx', 'snapshotsError', 1],
  ['features/funnels/FunnelDetailPage.tsx', 'error', 2],
  ['features/funnels/FunnelsPage.tsx', 'error', 1],
  ['features/job-search/ApplyGrantPage.tsx', 'error', 1],
  ['features/job-search/JobListingsPage.tsx', 'error', 1],
  ['features/kicktodo-admin/AdminCommercePage.tsx', 'error', 1],
  ['features/kicktodo-admin/AdminCommercePage.tsx', 'payoutError', 1],
  ['features/kicktodo-admin/AdminCommercePage.tsx', 'seatError', 1],
  ['features/kicktodo-circles/CirclesPage.tsx', 'actionError', 1],
  ['features/kicktodo-circles/CirclesPage.tsx', 'error', 1],
  ['features/kicktodo-community/CommunityPage.tsx', 'error', 1],
  ['features/kicktodo-engagement/EngagementPage.tsx', 'error', 1],
  ['features/kicktodo-metrics/MetricsPage.tsx', 'error', 1],
  ['features/kicktodo-org-programs/OrgProgramsPage.tsx', 'error', 1],
  ['features/kicktodo-seats/SeatPurchasePage.tsx', 'error', 1],
  ['features/kicktodo-studio/CandidateWorkspacePage.tsx', 'error', 1],
  ['features/kicktodo-studio/CandidateWorkspacePage.tsx', 'outlineError', 1],
  ['features/kicktodo-studio/CandidateWorkspacePage.tsx', 'retireError', 1],
  ['features/kicktodo-studio/CreatorInsightsPage.tsx', 'error', 1],
  ['features/kicktodo-studio/StudioPage.tsx', 'error', 1],
  ['features/kicktodo/DiscoverPage.tsx', 'error', 1],
  ['features/kicktodo/GuidePage.tsx', 'noteError', 1],
  ['features/kicktodo/GuidePage.tsx', 'renameError', 1],
  ['features/kicktodo/JournalPage.tsx', 'error', 1],
  ['features/kicktodo/PlanPage.tsx', 'error', 1],
  ['features/kicktodo/PlanPage.tsx', 'moveError', 1],
  ['features/kicktodo/TodayPage.tsx', 'actionError', 1],
  ['features/kicktodo/TodayPage.tsx', 'error', 1],
  // ADR 0605 Tier 6 (`KSU-10`) — the two knowledge-sync rows are DELETED, not
  // lowered: both Notices now pass `announce`. Per this file's own instruction,
  // cleaning a feature deletes its rows and lowers the baseline. The UX pass
  // filed this exact quarantine as the reason `check-notice-announce` "exits 0
  // while NAMING this feature in its exemption list" — structurally incapable of
  // failing on it. That exemption is now gone rather than annotated.
  ['features/marketplace/BundleShopPage.tsx', 'error', 1],
  ['features/marketplace/MarketplacePage.tsx', 'error', 2],
  ['features/media/AltTextDialog.tsx', 'error', 1],
  ['features/media/EditImageDialog.tsx', 'error', 1],
  ['features/media/GenerateImageDialog.tsx', 'error', 1],
  ['features/model-router/ModelRouterPage.tsx', 'error', 1],
  ['features/operations/OperationsHubPage.tsx', 'error', 1],
  ['features/operations/OperationsWebhooksPage.tsx', 'error', 1],
  ['features/priority-matrix/PriorityListPage.tsx', 'error', 3],
  ['features/priority-matrix/PriorityMatrixPage.tsx', 'error', 1],
  ['features/product-discovery/DiscoveryPage.tsx', 'error', 1],
  ['features/projects/ProjectChatTab.tsx', 'error', 2],
  ['features/projects/ProjectOverviewTab.tsx', 'error', 3],
  ['features/projects/ProjectsPage.tsx', 'error', 1],
  ['features/projects/ProjectWorkflowsTab.tsx', 'error', 1],
  ['features/promotions/PromotionsPage.tsx', 'error', 1],
  ['features/publishing/PublishingPage.tsx', 'error', 1],
  ['features/recommendations/RecommendationsPage.tsx', 'error', 1],
  ['features/service-desk/SupportPage.tsx', 'error', 1],
  ['features/settings-shell/BudgetPanel.tsx', 'error', 1],
  ['features/settings-shell/EscalationPanel.tsx', 'error', 1],
  ['features/settings-shell/PrivacyPanel.tsx', 'error', 1],
  ['features/settings-shell/SecurityPanel.tsx', 'error', 1],
  ['features/twin/AgentTwinPanel.tsx', 'error', 1],
  ['features/twin/ProfileTwinGrantsTab.tsx', 'error', 1],
  ['features/webinars/WebinarsPage.tsx', 'error', 1],
  ['featureToggles/FeatureTogglePanel.tsx', 'error', 2],
  ['kanban/KanbanPage.tsx', 'error', 1],
  ['memory/MemoryInspectorPage.tsx', 'error', 1],
  // AST-UX-3 (grade-ux) — DELETED, not lowered: ApprovalsInbox's failed FIRST
  // load now renders an announced StateCard + Retry (not a permanent skeleton),
  // and its refresh-failure Notice now passes `announce`. Both failure surfaces
  // announce, so no silent notice remains. Per this file's instruction, cleaning
  // a feature deletes its row and lowers the allowlist.
  ['notifications/DelegationSection.tsx', 'error', 1],
  ['notifications/NeedsYouInbox.tsx', 'error', 1],
  ['notifications/NotificationsPage.tsx', 'error', 1],
  ['notifications/TeamsDeliverySection.tsx', 'error', 1],
  ['orgs/OrgsPage.tsx', 'error', 1],
  ['orgs/WorkspaceCreateSection.tsx', 'error', 1],
  ['prompts/PromptLibraryPage.tsx', 'error', 1],
  ['prompts/PromptLibraryPage.tsx', 'saveError', 1],
  ['prompts/PromptPickerInput.tsx', 'error', 1],
  ['registry/PackBrowser.tsx', 'error', 1],
  ['runs/ActiveRunsTab.tsx', 'listError', 1],
  ['runs/RunAgentTrace.tsx', 'error', 1],
  ['runs/RunAuditPage.tsx', 'error', 1],
  ['runs/RunComparePage.tsx', 'error', 1],
  ['runs/RunDetailPage.tsx', 'error', 1],
  ['runs/RunMemoryPanel.tsx', 'error', 1],
  ['runs/RunOpsPanel.tsx', 'error', 1],
  ['runs/RunsIndexPage.tsx', 'error', 1],
  ['runs/RunsIndexPage.tsx', 'runsError', 1],
  ['settings/AuditLogPage.tsx', 'error', 1],
  ['settings/AuditLogPage.tsx', 'exportError', 1],
  ['settings/EventBindingsPage.tsx', 'error', 1],
  ['settings/ExampleDataPage.tsx', 'error', 1],
  ['settings/HeartbeatSettingsPage.tsx', 'error', 1],
  ['walkthroughs/WalkthroughsPage.tsx', 'error', 1],
  ['workforces/MigrationWizardPage.tsx', 'stageError', 1],
  ['workforces/TraceSearchPanel.tsx', 'error', 1],
  ['workforces/WorkforceOverviewPage.tsx', 'cutoverError', 1],
  ['workforces/WorkforcesGalleryPage.tsx', 'error', 1],
];
