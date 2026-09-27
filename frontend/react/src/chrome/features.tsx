/**
 * The declarative feature manifest — the single source of truth for the app
 * shell (white-label PRD §3 "the paved path").
 *
 * Every route declares itself here once: its element, which IA *tier* it
 * belongs to (`workspace` = the product rail; `admin` = the platform/console
 * surface inside <AdminLayout>), which width *chrome* the shell gives it, and
 * (optionally) the nav entry that advertises it. Everything else derives:
 *
 *   - App.tsx renders <Routes> FROM this list (no hand-wired <Route>s),
 *   - Sidebar renders the workspace rail + the single Admin entry from it,
 *   - AdminLayout renders the embedded admin rail from it,
 *   - the ⌘K palette catalog derives from it,
 *   - width rules (`narrow`/`fullbleed`/`chat`) derive from it — the old
 *     `NARROW_ROUTES` set + ad-hoc regexes are gone, so they cannot drift.
 *
 * Adding a page = ONE entry here. Wiring a nav item, the admin chrome, and
 * the width tier all happen by declaration, not by editing layout code
 * (white-label PRD §2/§3 acceptance).
 */
import { lazy } from 'react';
import { Navigate, matchRoutes, useLocation } from 'react-router-dom';
import { featureRoutes } from '../features/registry.js';
import type {
  IconCmp,
  FeatureTier,
  FeatureChrome,
  FeatureNav,
  FeatureRoute,
} from './featureTypes.js';
import { assertSiteRouteContracts } from './siteRouteContract.js';
import {
  MessageSquareIcon, BotIcon, WorkflowIcon, PlayIcon, ColumnsIcon, UserIcon,
  DatabaseIcon, FileTextIcon, PackageIcon,
  BoxesIcon, ShieldIcon, TerminalIcon, SettingsIcon,
  FlagIcon, SparklesIcon, ZapIcon, ActivityIcon,
} from '../ui/icons/index.js';
// ChatTab is lazy like every other route component, so the chat tree stays out
// of the entry chunk and loads on navigation (frontend enterprise-review Batch
// G). The shell's <Suspense> boundary (App.tsx) renders the fallback.
//
// It was EAGER until 2026-07-28 (ENG-4 / IDN-10), under the rationale "ChatTab
// is the home route (`/`) — keep it eager so first paint has no lazy flash".
// That rationale died when ADR 0375 made the Dashboard the always-on home and
// moved chat to `/chat` (re-confirmed by ADR 0487's `/` gate); the eager import
// outlived it by ~six weeks and was holding ~197 kB raw / ~30% of the entry
// chunk — the single largest first-party contributor, and the thing the
// STOP-BUMPING-SPLIT-NEXT gate in scripts/check-bundle-budget.mjs points at.
// `/chat` is still reachable in one hop from a legacy deep link
// (`/?agent=` → RootRedirect → `/chat`), so the chunk is PREFETCHED on idle —
// see `prefetchChatTab` below. Do NOT make this eager again to "fix" a flash:
// warm the prefetch instead.
const ChatTab = lazy(() => import('../chat/ChatTab.js').then((m) => ({ default: m.ChatTab })));

/**
 * Warm the lazy chat chunk after first paint, so navigating to `/chat` — the
 * single most likely next hop, and the target every legacy `/?agent=` deep link
 * redirects to — resolves from cache instead of a cold network fetch.
 *
 * Idle-scheduled and fire-and-forget: a rejected prefetch is a non-event (the
 * real navigation will retry through Suspense and surface any error there), so
 * it is swallowed rather than reported.
 */
export function prefetchChatTab(): void {
  const warm = () => { void import('../chat/ChatTab.js').catch(() => {}); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 1000);
}
const RunsIndexPage = lazy(() => import('../runs/RunsIndexPage.js').then((m) => ({ default: m.RunsIndexPage })));
const WalkthroughsPage = lazy(() => import('../walkthroughs/WalkthroughsPage.js').then((m) => ({ default: m.WalkthroughsPage })));
const OperationsWebhooksPage = lazy(() => import('../features/operations/OperationsWebhooksPage.js').then((m) => ({ default: m.OperationsWebhooksPage })));
const OperationsHubPage = lazy(() => import('../features/operations/OperationsHubPage.js').then((m) => ({ default: m.OperationsHubPage })));
const SettingsPage = lazy(() => import('../features/settings-shell/SettingsPage.js').then((m) => ({ default: m.SettingsPage })));
const RunDetailPage = lazy(() => import('../runs/RunDetailPage.js').then((m) => ({ default: m.RunDetailPage })));
const RunAuditPage = lazy(() => import('../runs/RunAuditPage.js').then((m) => ({ default: m.RunAuditPage })));
const RunComparePage = lazy(() => import('../runs/RunComparePage.js').then((m) => ({ default: m.RunComparePage })));
const CapabilitiesPanel = lazy(() => import('../discovery/CapabilitiesPanel.js').then((m) => ({ default: m.CapabilitiesPanel })));
const BuilderTab = lazy(() => import('../builder/BuilderTab.js').then((m) => ({ default: m.BuilderTab })));
const WorkflowsDashboard = lazy(() => import('../builder/WorkflowsDashboard.js').then((m) => ({ default: m.WorkflowsDashboard })));
const PrivacyPage = lazy(() => import('../PrivacyPage.js').then((m) => ({ default: m.PrivacyPage })));
const CliPage = lazy(() => import('../CliPage.js').then((m) => ({ default: m.CliPage })));
const PromptLibraryPage = lazy(() => import('../prompts/PromptLibraryPage.js').then((m) => ({ default: m.PromptLibraryPage })));
const KeysPage = lazy(() => import('../byok/KeysPage.js').then((m) => ({ default: m.KeysPage })));
const VoiceSettingsPage = lazy(() => import('../byok/VoiceSettingsPage.js').then((m) => ({ default: m.VoiceSettingsPage })));
const CompatEndpointsPage = lazy(() => import('../byok/CompatEndpointsPage.js').then((m) => ({ default: m.CompatEndpointsPage })));
const MemoryInspectorPage = lazy(() => import('../memory/MemoryInspectorPage.js').then((m) => ({ default: m.MemoryInspectorPage })));
const KanbanPage = lazy(() => import('../kanban/KanbanPage.js').then((m) => ({ default: m.KanbanPage })));
const LibraryPage = lazy(() => import('../chat/artifacts/LibraryPage.js').then((m) => ({ default: m.LibraryPage })));

// ADR 0049 — the standalone `/my-work` page was folded into the personal board
// as an "Assigned to me" rail (2026-06-16). Keep the path as a query-preserving
// redirect so already-emitted assignment notifications (`/my-work?card=<id>`)
// and bookmarks land on the board rail, which honors `?card=`.
function MyWorkRedirect(): JSX.Element {
  const { search } = useLocation();
  return <Navigate to={`/boards${search}`} replace />;
}
const RosterPage = lazy(() => import('../agents/RosterPage.js').then((m) => ({ default: m.RosterPage })));
const AgentsPage = lazy(() => import('../agents/AgentsPage.js').then((m) => ({ default: m.AgentsPage })));
const AgentDetailPage = lazy(() => import('../agents/AgentDetailPage.js').then((m) => ({ default: m.AgentDetailPage })));
const AgentInstallPage = lazy(() => import('../agents/AgentInstallPage.js').then((m) => ({ default: m.AgentInstallPage })));
const AgentNewPage = lazy(() => import('../agents/AgentNewPage.js').then((m) => ({ default: m.AgentNewPage })));
const AgentDashboardPage = lazy(() => import('../agents/AgentDashboardPage.js').then((m) => ({ default: m.AgentDashboardPage })));
const AgentWorkspacePage = lazy(() => import('../agents/AgentWorkspacePage.js').then((m) => ({ default: m.AgentWorkspacePage })));
const AgentCreateWizard = lazy(() => import('../agents/AgentCreateWizard.js').then((m) => ({ default: m.AgentCreateWizard })));
const WorkforcesGalleryPage = lazy(() => import('../workforces/WorkforcesGalleryPage.js').then((m) => ({ default: m.WorkforcesGalleryPage })));
const WorkforceOverviewPage = lazy(() => import('../workforces/WorkforceOverviewPage.js').then((m) => ({ default: m.WorkforceOverviewPage })));
const MigrationWizardPage = lazy(() => import('../workforces/MigrationWizardPage.js').then((m) => ({ default: m.MigrationWizardPage })));
const ExampleDataPage = lazy(() => import('../settings/ExampleDataPage.js').then((m) => ({ default: m.ExampleDataPage })));
const EventBindingsPage = lazy(() => import('../settings/EventBindingsPage.js').then((m) => ({ default: m.EventBindingsPage })));
const AuditLogPage = lazy(() => import('../settings/AuditLogPage.js').then((m) => ({ default: m.AuditLogPage })));
const HeartbeatSettingsPage = lazy(() => import('../settings/HeartbeatSettingsPage.js').then((m) => ({ default: m.HeartbeatSettingsPage })));
const RuntimePosturePage = lazy(() => import('../settings/RuntimePosturePage.js').then((m) => ({ default: m.RuntimePosturePage })));
const AdminOverviewPage = lazy(() => import('../settings/AdminOverviewPage.js').then((m) => ({ default: m.AdminOverviewPage })));
const OrgsPage = lazy(() => import('../orgs/OrgsPage.js').then((m) => ({ default: m.OrgsPage })));
const FeatureTogglePanel = lazy(() => import('../featureToggles/FeatureTogglePanel.js').then((m) => ({ default: m.FeatureTogglePanel })));
const AgentAllowlistPanel = lazy(() => import('../agentAllowlists/AgentAllowlistPanel.js').then((m) => ({ default: m.AgentAllowlistPanel })));
const AppearancePanel = lazy(() => import('../brand/AppearancePanel.js').then((m) => ({ default: m.AppearancePanel })));

// The feature manifest types now live in ./featureTypes (extracted so feature
// packages can import them without a cycle). Re-exported here for back-compat.
export type { IconCmp, FeatureTier, FeatureChrome, FeatureNav, FeatureRoute };

// Grouped IA (renamed 2026-06-04 per David): Workspace = the day-to-day
// product surfaces (Chat · Agents · Boards · Inbox); Author = workflow
// authoring; admin tier = platform/config that doesn't change per session.
// § Correction (2026-07-25, ADR 0487): '/' is the PUBLIC marketing home; the
// Dashboard owns its own '/dashboard' URL (dashboard feature manifest — core
// deliberately does NOT claim it, preserving the ADR 0001 no-core->feature-import
// rule) and sits FIRST in the pinned cluster; Chat is at '/chat'. The dashboard
// feature's '/' route redirects a signed-in visitor to '/dashboard' (and legacy
// '/?conversation='/'?agent=' deep links to '/chat').
const CORE_FEATURES: FeatureRoute[] = [
  // ── workspace · the day-to-day product surfaces ────────────────────────
  // '/chat' is chat's canonical URL.
  {
    path: '/chat', element: <ChatTab />, tier: 'workspace', archetype: 'immersive-chat', chrome: 'chat',
    nav: { group: 'Pinned', label: 'Chat', labelKey: 'chatLabel', icon: MessageSquareIcon, hint: 'Conversational entry point', hintKey: 'chatHint', order: 10 },
  },
  {
    path: '/agents', element: <AgentDashboardPage />, tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Pinned', label: 'Agents', labelKey: 'agentsLabel', icon: BotIcon, hint: 'Your digital workforce — named AI coworkers', hintKey: 'agentsHint', notUnder: ['/agents/templates'], order: 20 },
  },
  {
    // ADR 0083 (§Amendment 2026-07-05) — the Library: the generated ASSETS the AI
    // produced (documents, media, typed artifacts — decks/CAD/designs/…), opened in the
    // existing ArtifactWorkbench. Raw JSON/text run outputs are filtered out server-side.
    // label/hint inline (no nav-key needed — the renderer falls back to label).
    // Moved to the admin Operations group (2026-06-21, user request) — it sits beside
    // Runs/Boards as the output side of run state inside the operator shell.
    path: '/library', element: <LibraryPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Operations', label: 'Library', labelKey: 'libraryLabel', icon: BoxesIcon, hint: 'Generated assets', hintKey: 'libraryHint', requiredScope: 'artifacts:read' },
  },
  { path: '/agents/new', element: <AgentCreateWizard />, tier: 'workspace', archetype: 'narrow-form', chrome: 'narrow' },
  // Raw single-form authoring (also the ?fork= target) — kept for the
  // fork-to-customize flow from a pack/template agent.
  { path: '/agents/fork', element: <AgentNewPage />, tier: 'workspace', archetype: 'narrow-form', chrome: 'narrow' },
  { path: '/agents/install', element: <AgentInstallPage />, tier: 'workspace', archetype: 'narrow-form', chrome: 'narrow' },
  // Per-agent workspace (a roster id) — the agents-demo PRD's primary surface.
  { path: '/agents/:agentId', element: <AgentWorkspacePage />, tier: 'workspace' , archetype: 'detail',},
  // NOTE: governed workforces moved to the admin tier (2026-06-07) — a
  // configure-and-govern surface (read-only telemetry + lifecycle cut-over),
  // not a day-to-day product surface. See the admin "Workforces" group below.
  {
    path: '/builder', element: <WorkflowsDashboard />, tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Workspace', label: 'Workflows', labelKey: 'workflowsLabel', icon: WorkflowIcon, hint: 'Author + edit workflows', hintKey: 'workflowsHint', order: 10 },
  },
  // The canvas is its own scroll/zoom region — full viewport, no centered column.
  { path: '/builder/:workflowId', element: <BuilderTab />, tier: 'workspace', archetype: 'canvas-editor', chrome: 'fullbleed' },

  // ── workspace · (Inbox continues the Workspace group; Workflows above carries
  //    the Author group; Boards moved to the admin "Operations" group) ────────
  // /workforce merged into /agents (2026-06-04) — redirect keeps bookmarks.
  { path: '/workforce', element: <Navigate to="/agents" replace />, tier: 'workspace' , archetype: 'standard-index',},
  // ADR 0049 — the "assigned to me" mirror is now a collapsible "Assigned to me"
  // rail on the personal board (no standalone page / nav item). `/my-work`
  // redirects to /boards, preserving `?card=` for notification deep-links.
  { path: '/my-work', element: <MyWorkRedirect />, tier: 'workspace' , archetype: 'standard-index',},
  // NOTE: the /inbox (Notifications) route migrated to the feature registry
  // (features/notifications/routes.tsx) per ADR 0010 — nav-gated on the
  // `notifications` toggle. Composed via featureRoutes() below, not here.
  { path: '/privacy', element: <PrivacyPage />, tier: 'workspace', archetype: 'narrow-form', chrome: 'narrow' },

  // ── admin (platform/console — one flat rail inside <AdminLayout>) ──────
  {
    path: '/admin', element: <AdminOverviewPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Admin', label: 'Overview', labelKey: 'overviewLabel', icon: SettingsIcon, hint: 'Admin home', hintKey: 'overviewHint', end: true },
  },
  // ─ Operations: observe + drive run state (relocated from the workspace
  //   tier 2026-06-04 — the day-to-day view is /agents' ledger).
  // Mission Control folded into /runs as the "Active runs" tab (2026-07-05); the
  // path stays as a query-preserving redirect for bookmarks/notifications, off the rail.
  { path: '/mission', element: <Navigate to="/runs?tab=active" replace />, tier: 'admin' , archetype: 'admin',},
  {
    path: '/runs', element: <RunsIndexPage />, tier: 'admin', archetype: 'data-dense-index',
    nav: { group: 'Operations', label: 'Runs', labelKey: 'runsLabel', icon: PlayIcon, hint: 'Execution history + detail', hintKey: 'runsHint', requiredScope: 'runs:read' },
  },
  {
    path: '/walkthroughs', element: <WalkthroughsPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Learning & support', label: 'Walkthroughs', labelKey: 'walkthroughsLabel', icon: FlagIcon, hint: 'Record + play walkthroughs', hintKey: 'walkthroughsHint', featureId: 'walkthroughs' },
  },
  {
    // ADR 0395 Phase D — the Operations hub console (health + DLQ + the admin
    // consoles). The `operations` toggle gates the surface; every cross-tenant
    // read + write action is superadmin-gated server-side regardless (D3).
    path: '/operations', element: <OperationsHubPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'System operations', label: 'Ops Console', labelKey: 'opsHubLabel', icon: ActivityIcon, hint: 'System health, DLQ, webhook + admin consoles', hintKey: 'opsHubHint', featureId: 'operations', superadminOnly: true },
  },
  {
    // ADR 0395 Phase A — the webhook-delivery health panel (linked from the hub).
    path: '/operations/webhooks', parentPath: '/operations', element: <OperationsWebhooksPage />, tier: 'admin', archetype: 'admin',
  },
  {
    // ADR 0396 — the consolidated personal-settings shell (composition only;
    // every panel's capability keeps its owning feature + toggle).
    path: '/settings', element: <SettingsPage />, tier: 'workspace', archetype: 'standard-index',
    nav: { group: 'Workspace', label: 'Settings', labelKey: 'settingsShellLabel', icon: SettingsIcon, hint: 'Personal preferences — theme, accessibility, AI budget, privacy', hintKey: 'settingsShellHint', featureId: 'settings-shell' },
  },
  { path: '/runs/:runId', element: <RunDetailPage />, tier: 'admin' , archetype: 'admin',},
  { path: '/runs/:runId/audit', element: <RunAuditPage />, tier: 'admin' , archetype: 'admin',},
  { path: '/compare', element: <RunComparePage />, tier: 'admin' , archetype: 'admin',},
  // Boards moved out of the workspace rail into the admin Operations group
  // (2026-06-17). The role-gated operator shell and board backend RBAC both
  // apply. `/my-work` still redirects
  // here. Kept the canvas default chrome (the board scrolls horizontally).
  {
    path: '/boards', element: <KanbanPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Operations', label: 'Boards', labelKey: 'boardsLabel', icon: ColumnsIcon, hint: 'Kanban — card → run trigger', hintKey: 'boardsHint', requiredScope: 'workspace:read' },
  },
  // Per-board URL (routing-correction wave, ADR 0058/0079 precedent): the bare
  // /boards redirects to the first (or personal) board, so it never greets
  // with an empty shell.
  { path: '/boards/:boardId', element: <KanbanPage />, tier: 'admin' , archetype: 'admin',},
  // ─ Workforces: governed agent clusters (purpose/policy, telemetry, autonomy
  //   graduation, lifecycle cut-over) + the configuration side of the named
  //   agents that compose them. Read-only governance surface, hence admin tier.
  {
    path: '/workforces', element: <WorkforcesGalleryPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Workforces', label: 'Workforces', labelKey: 'workforcesLabel', icon: BoxesIcon, hint: 'Governed agent clusters — purpose, telemetry, autonomy', hintKey: 'workforcesHint' },
  },
  { path: '/workforces/:workforceId', element: <WorkforceOverviewPage />, tier: 'admin' , archetype: 'admin',},
  // Workforce migration journey wizard (EP1 MG-0) — guided 6-stage onboarding.
  { path: '/workforces/:workforceId/migrate', element: <MigrationWizardPage />, tier: 'admin', archetype: 'admin', chrome: 'narrow' },
  {
    path: '/agents/templates', element: <AgentsPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Workforces', label: 'Agent templates', labelKey: 'agentTemplatesLabel', icon: PackageIcon, hint: 'Installed manifest agents + packs', hintKey: 'agentTemplatesHint' },
  },
  { path: '/agents/templates/:agentId', element: <AgentDetailPage />, tier: 'admin', archetype: 'admin', chrome: 'narrow' },
  {
    path: '/roster', element: <RosterPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Workforces', label: 'Org chart', labelKey: 'orgChartLabel', icon: UserIcon, hint: 'Roster + org-chart editor (descriptive only — confers no authority)', hintKey: 'orgChartHint' },
  },
  // ─ Platform: inspection + tooling surfaces.
  {
    path: '/prompts', element: <PromptLibraryPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'AI & automation', label: 'Prompts', labelKey: 'promptsLabel', icon: FileTextIcon, hint: 'Reusable templates + variables', hintKey: 'promptsHint' },
  },
  {
    path: '/memory', element: <MemoryInspectorPage />, tier: 'admin', archetype: 'admin',
    nav: { group: 'AI & automation', label: 'Memory', labelKey: 'memoryLabel', icon: DatabaseIcon, hint: 'Tenant-attributed memory writes', hintKey: 'memoryHint' },
  },
  {
    path: '/capabilities', element: <CapabilitiesPanel />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Governance & security', label: 'Capabilities', labelKey: 'capabilitiesLabel', icon: ShieldIcon, hint: 'What this host advertises', hintKey: 'capabilitiesHint' },
  },
  {
    path: '/cli', element: <CliPage />, tier: 'admin', archetype: 'admin', chrome: 'narrow',
    nav: { group: 'Developer', label: 'CLI', labelKey: 'cliLabel', icon: TerminalIcon, hint: 'In-app CLI quickstart + catalog', hintKey: 'cliHint' },
  },
  // `/test` (Manual tests) moved to features/manual-tests/ (ADR 0183) — registered via
  // FRONTEND_FEATURES in features/registry.ts, no longer in the core manifest.
  // ─ Access & data: identity, credentials, and the demo dataset.
  // ADR 0144 §Correction (2026-06-26) — the Access Hub graduated to always-on, so
  // these surfaces are reached ONLY through it: no standalone `nav` (the rail shows
  // the single "Access" entry). Routes + `hubTab` stay (the hub renders the element).
  {
    path: '/orgs', element: <OrgsPage />, tier: 'admin', archetype: 'admin',
    hubTab: { group: 'identity', order: 0 },
  },
  // Invitation redemption (ADR 0004 UI; AUTH-3) — nav-less deep-link target for
  {
    path: '/keys', element: <KeysPage />, tier: 'admin', archetype: 'admin',
    hubTab: { group: 'credentials', order: 0 },
  },
  // ADR 0144 — Voice + self-hosted endpoints are Access Hub tabs only (no rail
  // entry): promoted out of the Keys page. Reachable directly for deep links.
  { path: '/access/voice', element: <VoiceSettingsPage />, tier: 'admin', archetype: 'admin', hubTab: { group: 'credentials', order: 2 } },
  { path: '/access/endpoints', element: <CompatEndpointsPage />, tier: 'admin', archetype: 'admin', hubTab: { group: 'credentials', order: 3 } },
  {
    path: '/feature-toggles', element: <FeatureTogglePanel />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Governance & security', label: 'Feature toggles', labelKey: 'featureTogglesLabel', icon: FlagIcon, hint: 'On / off / beta + multivariant traffic-splitting', hintKey: 'featureTogglesHint', superadminOnly: true },
  },
  // ADR 0104 — superadmin editor for an agent's offered-tool allowlist (override the pack default).
  {
    path: '/agent-allowlists', element: <AgentAllowlistPanel />, tier: 'admin', archetype: 'admin',
    nav: { group: 'Governance & security', label: 'Agent tool allowlists', labelKey: 'agentAllowlistLabel', icon: ShieldIcon, hint: 'Grant or revoke an agent’s tools without editing a pack', hintKey: 'agentAllowlistHint', superadminOnly: true },
  },
  // ADR 0027 — the public front page collapsed into the CMS Page Builder: a super
  // admin edits it as the "Front page" scope inside CMS (/cms). No standalone nav
  // entry or editor panel; the on/off switch moved into CMS too. The CMS/Media/
  // Publishing nav lands in this 'Content' group, from their feature packages.
  {
    path: '/example-data', element: <ExampleDataPage />, tier: 'admin', archetype: 'admin', chrome: 'narrow',
    nav: { group: 'Data & knowledge', label: 'Example data', labelKey: 'exampleDataLabel', icon: DatabaseIcon, hint: 'Re-seed the built-in example roster', hintKey: 'exampleDataHint' },
  },
  // Deferred Phase B.2 (ADM-7) — the ADR 0028 audit READ view as a first-class
  // admin page (backend tenant-scopes fail-closed; superadmin gate rendered as
  // an honest message state).
  {
    path: '/audit-log', element: <AuditLogPage />, tier: 'admin', archetype: 'admin', chrome: 'narrow',
    nav: { group: 'Governance & security', label: 'Audit log', labelKey: 'auditLogLabel', icon: ShieldIcon, hint: 'Every audited action, tenant-scoped', hintKey: 'auditLogHint', order: 93, superadminOnly: true },
  },
  // ADR 0208 §1 — the host-event → workflow binding registry's admin UI (it
  // shipped API-only). Host-level tenant automation (same trust tier as
  // webhook subscriptions, RFC 0093) — not a FrontendFeature toggle package,
  // so it's declared directly here like Audit log / Example data.
  {
    path: '/event-bindings', element: <EventBindingsPage />, tier: 'admin', archetype: 'admin', chrome: 'narrow',
    nav: { group: 'AI & automation', label: 'Event bindings', labelKey: 'eventBindingsLabel', icon: ZapIcon, hint: 'Start a workflow when a record changes', hintKey: 'eventBindingsHint', order: 94 },
  },
  {
    // ADR 0318 — host-wide superadmin control over the ADR 0313 autonomous work
    // loop: master on/off, an auto-disabling run window, cadence, run budget.
    path: '/heartbeat-settings', element: <HeartbeatSettingsPage />, tier: 'admin', archetype: 'admin', chrome: 'narrow',
    nav: { group: 'AI & automation', label: 'Heartbeat', labelKey: 'heartbeatLabel', icon: ActivityIcon, hint: 'Autonomous work-loop cadence + on/off', hintKey: 'heartbeatHint', order: 95, superadminOnly: true },
  },
  // ADR 0742 — superadmin view of the Cloud Run posture (warm / cold), read
  // live from Cloud Run; change requests are audited and applied by an operator.
  {
    path: '/runtime-posture', element: <RuntimePosturePage />, tier: 'admin', archetype: 'admin', chrome: 'narrow',
    nav: { group: 'Deployment & customization', label: 'Runtime posture', labelKey: 'runtimePostureLabel', icon: ActivityIcon, hint: 'Warm or cold on Cloud Run, read live', hintKey: 'runtimePostureHint', order: 61, superadminOnly: true },
  },
  // ADR 0170 — the runtime, superadmin-managed white-label app identity (logo /
  // colors / fonts / name / theme). Host-level authority; applies live, no rebuild.
  {
    path: '/appearance', element: <AppearancePanel />, tier: 'admin', archetype: 'admin', chrome: 'narrow',
    nav: { group: 'Deployment & customization', label: 'Appearance', labelKey: 'appearanceLabel', icon: SparklesIcon, hint: 'Logo, colors, fonts & name for this installation', hintKey: 'appearanceHint', order: 60, superadminOnly: true },
  },
];

/** The full manifest: core routes + every separately-distributed feature's
 *  routes (ADR §2.2). Adding a feature appends to FRONTEND_FEATURES, not here. */
export const FEATURES: FeatureRoute[] = [...CORE_FEATURES, ...featureRoutes()];

// ADR 0641 phase 5 — the site-route contract, enforced AT COMPOSITION.
//
// Module scope on purpose: this runs when the manifest is built, so a violation
// fails at import rather than when a visitor happens to reach the route. Both
// rules it can check here are silent at request time — a relative `site` path
// mounts the surface under whatever precedes it, and neither produces an error
// page.
//
// WHAT THIS CANNOT SEE, stated rather than left implied. Decision 12's toggle
// rules (no variants, no partial rollout, no tenant overrides on a public route)
// need the TOGGLE CONFIG, which lives in the backend registry and is not part of
// the frontend manifest. `assertSiteRouteContract` checks them when a caller
// supplies `toggle`; no frontend caller can. Enforcing that half where the data
// actually lives is a follow-up, and the seam is the route's `ownerFeatureId` →
// the toggle it names. Until then the rule is documented in the ADR and checked
// by the contract's own tests, not by this call — which is a real gap and is why
// it is written down here instead of in a commit message nobody greps.
assertSiteRouteContracts(
  FEATURES.filter((f) => f.tier === 'site').map((f) => ({
    path: f.path,
    tier: f.tier,
    ...(f.auth === undefined ? {} : { auth: f.auth }),
  })),
);

// ADR 0718 D3 — the DUPLICATE-PATH contract, enforced at the same composition seam
// and for the same reason: a collision is SILENT at request time. Two features
// declaring one path does not error — one simply wins and the other's surface is
// unreachable, with no signal anywhere.
//
// And the winner is NOT the one the usual rule predicts. "First registrant wins" is
// the reflex (it is what the architecture review's own lead check says), but
// `App.tsx` selects a SITE-tier route by path BEFORE the router runs, because shell
// selection must precede routing. So a `site` claimant pre-empts an `admin` one
// regardless of manifest order — which is exactly how `/leaderboard` went unnoticed:
// `evals` is first in the manifest and `kicktodo-engagement` is what actually renders.
//
// SHRINK-ONLY. The list may lose entries, never gain them. A new collision fails at
// import; the one known pair is recorded here with its resolution rather than
// silently tolerated, so the next reader sees a decision instead of an oversight.
const KNOWN_PATH_COLLISIONS: ReadonlySet<string> = new Set([
  // `/leaderboard`: `kicktodo-engagement` (site, gamification, has the nav entry and
  // the user-facing bookmarks) WINS over `evals` (admin, model Elo). The model
  // leaderboard's canonical home is the Models console tab — `/models?tab=leaderboard`
  // — and ADR 0718 D1 retargeted the two inbound links that used to land users on the
  // wrong feature. Taking the path back would break a shipped user-facing surface to
  // serve an admin page that already has a home.
  '/leaderboard',
]);

{
  const byPath = new Map<string, string[]>();
  for (const f of FEATURES) {
    byPath.set(f.path, [...(byPath.get(f.path) ?? []), f.ownerFeatureId ?? '(core)']);
  }
  const unexpected = [...byPath.entries()]
    .filter(([path, owners]) => owners.length > 1 && !KNOWN_PATH_COLLISIONS.has(path))
    .map(([path, owners]) => `${path} <- ${owners.join(', ')}`);
  if (unexpected.length > 0) {
    throw new Error(
      `ADR 0718: two features declare the same route path, so one surface is silently unreachable. `
      + `Note the winner is the SITE-tier claimant (App.tsx pre-empts the router), not the first registrant. `
      + `Give one a distinct path, or record it in KNOWN_PATH_COLLISIONS with the reason: ${unexpected.join(' ; ')}`,
    );
  }
}

// ── Derivations (consumers render these; never re-declare nav/width data) ──

export interface NavItem extends FeatureNav { to: string }
/** A rendered nav category. `id` is the STABLE key (built-in id = the declared
 *  group label, e.g. 'Platform'); `label` is the DISPLAY string (== id unless a
 *  menu-config override renamed it, in which case `custom` is set and the literal
 *  label wins over the GROUP_LABEL_KEYS i18n lookup). ADR 0139. */
export interface NavGroup { id: string; label: string; items: NavItem[]; custom?: boolean; headerless?: boolean }

/**
 * Groups rendered WITHOUT a section header — a flush, always-expanded cluster of
 * top-level entries pinned above the labelled sections. The Sidebar suppresses
 * the collapse toggle for these and never collapses them. Today: the 'Pinned'
 * group (Chat · Inbox · Agents).
 */
export const HEADERLESS_GROUP_IDS: ReadonlySet<string> = new Set(['Pinned']);

/**
 * Category display order. A group not listed here sorts AFTER the known ones,
 * stable by first appearance. This is the one place the menu's category
 * sequence is declared — features place themselves in a category via
 * `nav.group` and a position within it via `nav.order` (chrome/featureTypes).
 */
export const GROUP_ORDER: string[] = [
  // workspace tier. 'Marketing' (Campaign Studio cluster) is now always present
  // because brand graduated to always-on (ADR 0170) — it used to appear only when
  // a Marketing feature was toggled on.
  // Revenue cluster carved out of the overloaded generic 'Workspace' group:
  // 'CRM' = customer core (crm/email/forms/csm/analytics); 'Sales' = field/rep sales
  // over CRM (dealers/territories/commissions/sales-maps); 'Commerce' = store +
  // merchandising (commerce/discovery/promotions/recommendations). 'Studio' = the
  // content-authoring cluster (documents/notebooks/podcasts/production).
  // 'Pinned' is the header-less top cluster (Chat · Inbox · Agents). 'Workspace'
  // now labels the authoring section (Workflows · Forms · Documents · Comments —
  // formerly shown as "Create"); its old top items live in 'Pinned'.
  // 'Business' = the cross-functional business cluster (BI metrics · Support) —
  // it was declared by the bi + service-desk features but MISSING here, so it
  // fell back to end-rank and tripped the "known category" invariant test.
  'Pinned', 'Workspace', 'KickTodo', 'CRM', 'Sales', 'Commerce', 'Business', 'Planning', 'Marketing', 'Customer Data Platform', 'Studio', 'Canvas',
  // admin tier ('Content' = CMS / Media / Publishing / Sharing — ADR 0027).
  // 'Developer' = the ui-plugins extensibility surface (was missing from the order —
  // its nav group fell back to end-rank + tripped the "known category" invariant test).
  'Admin', 'Operations', 'System operations', 'Workforces', 'AI & automation', 'Content',
  'Governance & security', 'Access & data', 'Data & knowledge', 'Billing & commerce',
  'Analytics & usage', 'Deployment & customization', 'Developer', 'Learning & support',
  // Legacy built-in ids stay ranked so explicit saved menu overrides continue
  // to render predictably after the Phase 2 default-taxonomy change.
  'Platform', 'Business',
];

/**
 * Group-header English label → its key in the `nav` i18n namespace. Consumers
 * (Sidebar / AdminLayout) resolve a group title via
 * `t(GROUP_LABEL_KEYS[label], { defaultValue: label })`. A group not listed
 * here falls back to its English `label` (feature packages can add their own
 * group catalogs).
 */
export const GROUP_LABEL_KEYS: Record<string, string> = {
  Workspace: 'groupWorkspace',
  CRM: 'groupCrm',
  Sales: 'groupSales',
  Commerce: 'groupCommerce',
  Planning: 'groupPlanning',
  Marketing: 'groupMarketing',
  'Customer Data Platform': 'groupCdp',
  Studio: 'groupStudio',
  Admin: 'groupAdmin',
  Operations: 'groupWorkManagement',
  'System operations': 'groupSystemOperations',
  Workforces: 'groupWorkforces',
  Content: 'groupContent',
  'AI & automation': 'groupAiAutomation',
  'Governance & security': 'groupGovernanceSecurity',
  'Data & knowledge': 'groupDataKnowledge',
  'Billing & commerce': 'groupBillingCommerce',
  'Analytics & usage': 'groupAnalyticsUsage',
  'Deployment & customization': 'groupDeploymentCustomization',
  'Learning & support': 'groupLearningSupport',
  Platform: 'groupPlatform',
  Developer: 'groupDeveloperTools',
  Business: 'groupBusiness',
  'Access & data': 'groupIdentityAccess',
  Actions: 'groupActions',
};

export const groupRank = (label: string): number => {
  const i = GROUP_ORDER.indexOf(label);
  return i === -1 ? GROUP_ORDER.length : i;
};

/**
 * Build the grouped, ordered nav from a slice of the manifest. Groups sort by
 * GROUP_ORDER; items sort by `nav.order` ascending. Items without an `order`
 * sort after ordered ones (so omitting it keeps the historical append-at-end
 * shape). `Array.prototype.sort` is stable (ES2019), so equal keys keep their
 * declaration / first-appearance order without an explicit tiebreak.
 *
 * This is the ONE grouping/ordering primitive (ADR 0139): the static exports
 * below and the live `resolveNav` overlay (`chrome/navConfig/`) both route
 * through it — no second orderer. A group's `id` is the declared group label.
 */
export function navGroups(routes: FeatureRoute[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const f of routes) {
    if (!f.nav) continue;
    let g = groups.find((x) => x.id === f.nav!.group);
    if (!g) { g = { id: f.nav.group, label: f.nav.group, items: [], ...(HEADERLESS_GROUP_IDS.has(f.nav.group) ? { headerless: true } : {}) }; groups.push(g); }
    g.items.push({ ...f.nav, to: f.path });
  }
  const ord = (n?: number): number => (n === undefined ? Number.POSITIVE_INFINITY : n);
  for (const g of groups) g.items.sort((a, b) => ord(a.order) - ord(b.order));
  groups.sort((a, b) => groupRank(a.id) - groupRank(b.id));
  return groups;
}

/** The primary product rail (Sidebar): workspace-tier groups only. The admin
 *  tier appears there as ONE pinned entry (Sidebar renders it explicitly). */
export const WORKSPACE_NAV: NavGroup[] = navGroups(FEATURES.filter((f) => f.tier === 'workspace'));

/** The embedded admin rail (<AdminLayout>), grouped. The root 'Admin' group
 *  (Overview) renders header-less — the rail's own title already says Admin. */
export const ADMIN_NAV_GROUPS: NavGroup[] = navGroups(FEATURES.filter((f) => f.tier === 'admin'));

/** Flat admin catalog (the /admin overview card grid). */
export const ADMIN_NAV: NavItem[] = ADMIN_NAV_GROUPS.flatMap((g) => g.items);

/** The full catalog (⌘K palette): workspace groups + the Admin group. */
export const NAV: NavGroup[] = navGroups(FEATURES);

export function navItemIsActive(item: NavItem, pathname: string): boolean {
  const candidates = [item.to, ...(item.activeFor ?? [])];
  if (item.end) return candidates.includes(pathname);
  const under = candidates.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  if (!under) return false;
  return !(item.notUnder ?? []).some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// matchRoutes applies react-router's own specificity ranking, so
// `/agents/templates` wins over `/agents/:agentId` exactly as <Routes> would —
// the manifest never needs to be order-sensitive.
const MATCHABLE = FEATURES.map((f) => ({ path: f.path }));

export function featureFor(pathname: string): FeatureRoute | null {
  const matches = matchRoutes(MATCHABLE, pathname);
  if (!matches || matches.length === 0) return null;
  const matchedPath = matches[matches.length - 1]?.route.path;
  return FEATURES.find((f) => f.path === matchedPath) ?? null;
}

/** Shell width/scroll treatment for the current location. */
export function chromeFor(pathname: string): FeatureChrome {
  return featureFor(pathname)?.chrome ?? 'default';
}

/** True when the location renders inside the admin chrome. */
export function isAdminPath(pathname: string): boolean {
  return featureFor(pathname)?.tier === 'admin';
}
