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
import {
  MessageSquareIcon, BotIcon, WorkflowIcon, PlayIcon, ColumnsIcon, UserIcon,
  ActivityIcon, DatabaseIcon, FileTextIcon, PackageIcon,
  BoxesIcon, ShieldIcon, TerminalIcon, SettingsIcon,
  FlagIcon, GlobeIcon, ClipboardIcon, SparklesIcon,
} from '../ui/icons/index.js';
// ChatTab is the home route (`/`) — keep it eager so first paint has no lazy
// flash. Every other route component is lazy so it stays out of the entry
// chunk and loads on navigation (frontend enterprise-review Batch G). The
// shell's <Suspense> boundary (App.tsx) renders the fallback.
import { ChatTab } from '../chat/ChatTab.js';
const RunsIndexPage = lazy(() => import('../runs/RunsIndexPage.js').then((m) => ({ default: m.RunsIndexPage })));
const RunDetailPage = lazy(() => import('../runs/RunDetailPage.js').then((m) => ({ default: m.RunDetailPage })));
const RunAuditPage = lazy(() => import('../runs/RunAuditPage.js').then((m) => ({ default: m.RunAuditPage })));
const RunComparePage = lazy(() => import('../runs/RunComparePage.js').then((m) => ({ default: m.RunComparePage })));
const CommandCenterPage = lazy(() => import('../runs/CommandCenterPage.js').then((m) => ({ default: m.CommandCenterPage })));
const CapabilitiesPanel = lazy(() => import('../discovery/CapabilitiesPanel.js').then((m) => ({ default: m.CapabilitiesPanel })));
const BuilderTab = lazy(() => import('../builder/BuilderTab.js').then((m) => ({ default: m.BuilderTab })));
const WorkflowsDashboard = lazy(() => import('../builder/WorkflowsDashboard.js').then((m) => ({ default: m.WorkflowsDashboard })));
const PrivacyPage = lazy(() => import('../PrivacyPage.js').then((m) => ({ default: m.PrivacyPage })));
const CliPage = lazy(() => import('../CliPage.js').then((m) => ({ default: m.CliPage })));
const ManualTestPage = lazy(() => import('../test/ManualTestPage.js').then((m) => ({ default: m.ManualTestPage })));
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
const AdminOverviewPage = lazy(() => import('../settings/AdminOverviewPage.js').then((m) => ({ default: m.AdminOverviewPage })));
const OrgsPage = lazy(() => import('../orgs/OrgsPage.js').then((m) => ({ default: m.OrgsPage })));
const FeatureTogglePanel = lazy(() => import('../featureToggles/FeatureTogglePanel.js').then((m) => ({ default: m.FeatureTogglePanel })));
const AgentAllowlistPanel = lazy(() => import('../agentAllowlists/AgentAllowlistPanel.js').then((m) => ({ default: m.AgentAllowlistPanel })));
const FrontPageSettingsPanel = lazy(() => import('../site/FrontPageSettingsPanel.js').then((m) => ({ default: m.FrontPageSettingsPanel })));
const AppearancePanel = lazy(() => import('../brand/AppearancePanel.js').then((m) => ({ default: m.AppearancePanel })));

// The feature manifest types now live in ./featureTypes (extracted so feature
// packages can import them without a cycle). Re-exported here for back-compat.
export type { IconCmp, FeatureTier, FeatureChrome, FeatureNav, FeatureRoute };

// Grouped IA (renamed 2026-06-04 per David): Workspace = the day-to-day
// product surfaces (Chat · Agents · Boards · Inbox); Author = workflow
// authoring; admin tier = platform/config that doesn't change per session.
// Chat stays first (feedback_chat_first_nav).
const CORE_FEATURES: FeatureRoute[] = [
  // ── workspace · the day-to-day product surfaces ────────────────────────
  {
    path: '/', element: <ChatTab />, tier: 'workspace', chrome: 'chat',
    nav: { group: 'Workspace', label: 'Chat', labelKey: 'chatLabel', icon: MessageSquareIcon, hint: 'Conversational entry point', hintKey: 'chatHint', end: true, order: 10 },
  },
  // /chat is the chat surface's own stable URL (the same ChatTab as "/"). It
  // renders DIRECTLY — not a redirect to "/" — because "/" is the public marketing
  // front page for anonymous visitors (ADR 0027); redirecting "/chat" → "/" would
  // bounce an "open the app" link onto the marketing page.
  { path: '/chat', element: <ChatTab />, tier: 'workspace', chrome: 'chat' },
  {
    path: '/agents', element: <AgentDashboardPage />, tier: 'workspace',
    nav: { group: 'Workspace', label: 'Agents', labelKey: 'agentsLabel', icon: BotIcon, hint: 'Your digital workforce — named AI coworkers', hintKey: 'agentsHint', notUnder: ['/agents/templates'], order: 20 },
  },
  {
    // ADR 0083 — the Library: every artifact the AI produced (run outputs, documents,
    // media), opened in the existing ArtifactWorkbench. label/hint inline (no nav-key
    // needed — the renderer falls back to label when labelKey is absent).
    // Moved to the admin Operations group (2026-06-21, user request) — it sits beside
    // Runs/Boards as the output side of run state. Still reachable by every user.
    path: '/library', element: <LibraryPage />, tier: 'admin',
    nav: { group: 'Operations', label: 'Library', icon: BoxesIcon, hint: 'Everything the AI produced' },
  },
  { path: '/agents/new', element: <AgentCreateWizard />, tier: 'workspace', chrome: 'narrow' },
  // Raw single-form authoring (also the ?fork= target) — kept for the
  // fork-to-customize flow from a pack/template agent.
  { path: '/agents/fork', element: <AgentNewPage />, tier: 'workspace', chrome: 'narrow' },
  { path: '/agents/install', element: <AgentInstallPage />, tier: 'workspace', chrome: 'narrow' },
  // Per-agent workspace (a roster id) — the agents-demo PRD's primary surface.
  { path: '/agents/:agentId', element: <AgentWorkspacePage />, tier: 'workspace' },
  // NOTE: governed workforces moved to the admin tier (2026-06-07) — a
  // configure-and-govern surface (read-only telemetry + lifecycle cut-over),
  // not a day-to-day product surface. See the admin "Workforces" group below.
  {
    path: '/builder', element: <WorkflowsDashboard />, tier: 'workspace',
    nav: { group: 'Author', label: 'Workflows', labelKey: 'workflowsLabel', icon: WorkflowIcon, hint: 'Author + edit workflows', hintKey: 'workflowsHint' },
  },
  // The canvas is its own scroll/zoom region — full viewport, no centered column.
  { path: '/builder/:workflowId', element: <BuilderTab />, tier: 'workspace', chrome: 'fullbleed' },

  // ── workspace · (Inbox continues the Workspace group; Workflows above carries
  //    the Author group; Boards moved to the admin "Operations" group) ────────
  // /workforce merged into /agents (2026-06-04) — redirect keeps bookmarks.
  { path: '/workforce', element: <Navigate to="/agents" replace />, tier: 'workspace' },
  // ADR 0049 — the "assigned to me" mirror is now a collapsible "Assigned to me"
  // rail on the personal board (no standalone page / nav item). `/my-work`
  // redirects to /boards, preserving `?card=` for notification deep-links.
  { path: '/my-work', element: <MyWorkRedirect />, tier: 'workspace' },
  // NOTE: the /inbox (Notifications) route migrated to the feature registry
  // (features/notifications/routes.tsx) per ADR 0010 — nav-gated on the
  // `notifications` toggle. Composed via featureRoutes() below, not here.
  { path: '/privacy', element: <PrivacyPage />, tier: 'workspace', chrome: 'narrow' },

  // ── admin (platform/console — one flat rail inside <AdminLayout>) ──────
  {
    path: '/admin', element: <AdminOverviewPage />, tier: 'admin',
    nav: { group: 'Admin', label: 'Overview', labelKey: 'overviewLabel', icon: SettingsIcon, hint: 'Admin home', hintKey: 'overviewHint', end: true },
  },
  // ─ Operations: observe + drive run state (relocated from the workspace
  //   tier 2026-06-04 — the day-to-day view is /agents' ledger).
  {
    path: '/mission', element: <CommandCenterPage />, tier: 'admin',
    nav: { group: 'Operations', label: 'Mission Control', labelKey: 'missionLabel', icon: ActivityIcon, hint: 'Live fleet view across runs', hintKey: 'missionHint' },
  },
  {
    path: '/runs', element: <RunsIndexPage />, tier: 'admin',
    nav: { group: 'Operations', label: 'Runs', labelKey: 'runsLabel', icon: PlayIcon, hint: 'Execution history + detail', hintKey: 'runsHint' },
  },
  { path: '/runs/:runId', element: <RunDetailPage />, tier: 'admin' },
  { path: '/runs/:runId/audit', element: <RunAuditPage />, tier: 'admin' },
  { path: '/compare', element: <RunComparePage />, tier: 'admin' },
  // Boards moved out of the workspace rail into the admin Operations group
  // (2026-06-17, user request). Still reachable by every user — the admin
  // surface is ungated; the board keeps its own RBAC. `/my-work` still redirects
  // here. Kept the canvas default chrome (the board scrolls horizontally).
  {
    path: '/boards', element: <KanbanPage />, tier: 'admin',
    nav: { group: 'Operations', label: 'Boards', labelKey: 'boardsLabel', icon: ColumnsIcon, hint: 'Kanban — card → run trigger', hintKey: 'boardsHint' },
  },
  // ─ Workforces: governed agent clusters (purpose/policy, telemetry, autonomy
  //   graduation, lifecycle cut-over) + the configuration side of the named
  //   agents that compose them. Read-only governance surface, hence admin tier.
  {
    path: '/workforces', element: <WorkforcesGalleryPage />, tier: 'admin',
    nav: { group: 'Workforces', label: 'Workforces', labelKey: 'workforcesLabel', icon: BoxesIcon, hint: 'Governed agent clusters — purpose, telemetry, autonomy', hintKey: 'workforcesHint' },
  },
  { path: '/workforces/:workforceId', element: <WorkforceOverviewPage />, tier: 'admin' },
  // Workforce migration journey wizard (EP1 MG-0) — guided 6-stage onboarding.
  { path: '/workforces/:workforceId/migrate', element: <MigrationWizardPage />, tier: 'admin', chrome: 'narrow' },
  {
    path: '/agents/templates', element: <AgentsPage />, tier: 'admin',
    nav: { group: 'Workforces', label: 'Agent templates', labelKey: 'agentTemplatesLabel', icon: PackageIcon, hint: 'Installed manifest agents + packs', hintKey: 'agentTemplatesHint' },
  },
  { path: '/agents/templates/:agentId', element: <AgentDetailPage />, tier: 'admin', chrome: 'narrow' },
  {
    path: '/roster', element: <RosterPage />, tier: 'admin',
    nav: { group: 'Workforces', label: 'Org chart', labelKey: 'orgChartLabel', icon: UserIcon, hint: 'Roster + org-chart editor (descriptive only — confers no authority)', hintKey: 'orgChartHint' },
  },
  // ─ Platform: inspection + tooling surfaces.
  {
    path: '/prompts', element: <PromptLibraryPage />, tier: 'admin',
    nav: { group: 'Platform', label: 'Prompts', labelKey: 'promptsLabel', icon: FileTextIcon, hint: 'Reusable templates + variables', hintKey: 'promptsHint' },
  },
  {
    path: '/memory', element: <MemoryInspectorPage />, tier: 'admin',
    nav: { group: 'Platform', label: 'Memory', labelKey: 'memoryLabel', icon: DatabaseIcon, hint: 'Tenant-attributed memory writes', hintKey: 'memoryHint' },
  },
  {
    path: '/capabilities', element: <CapabilitiesPanel />, tier: 'admin',
    nav: { group: 'Platform', label: 'Capabilities', labelKey: 'capabilitiesLabel', icon: ShieldIcon, hint: 'What this host advertises', hintKey: 'capabilitiesHint' },
  },
  {
    path: '/cli', element: <CliPage />, tier: 'admin', chrome: 'narrow',
    nav: { group: 'Platform', label: 'CLI', labelKey: 'cliLabel', icon: TerminalIcon, hint: 'In-app CLI quickstart + catalog', hintKey: 'cliHint' },
  },
  {
    path: '/test', element: <ManualTestPage />, tier: 'admin', chrome: 'narrow',
    nav: { group: 'Platform', label: 'Manual tests', labelKey: 'manualTestsLabel', icon: ClipboardIcon, hint: 'Human-run feature tests', hintKey: 'manualTestsHint' },
  },
  // ─ Access & data: identity, credentials, and the demo dataset.
  // ADR 0144 §Correction (2026-06-26) — the Access Hub graduated to always-on, so
  // these surfaces are reached ONLY through it: no standalone `nav` (the rail shows
  // the single "Access" entry). Routes + `hubTab` stay (the hub renders the element).
  {
    path: '/orgs', element: <OrgsPage />, tier: 'admin',
    hubTab: { group: 'identity', order: 0 },
  },
  {
    path: '/keys', element: <KeysPage />, tier: 'admin',
    hubTab: { group: 'credentials', order: 0 },
  },
  // ADR 0144 — Voice + self-hosted endpoints are Access Hub tabs only (no rail
  // entry): promoted out of the Keys page. Reachable directly for deep links.
  { path: '/access/voice', element: <VoiceSettingsPage />, tier: 'admin', hubTab: { group: 'credentials', order: 2 } },
  { path: '/access/endpoints', element: <CompatEndpointsPage />, tier: 'admin', hubTab: { group: 'credentials', order: 3 } },
  {
    path: '/feature-toggles', element: <FeatureTogglePanel />, tier: 'admin',
    nav: { group: 'Platform', label: 'Feature toggles', labelKey: 'featureTogglesLabel', icon: FlagIcon, hint: 'On / off / beta + multivariant traffic-splitting', hintKey: 'featureTogglesHint' },
  },
  // ADR 0104 — superadmin editor for an agent's offered-tool allowlist (override the pack default).
  {
    path: '/agent-allowlists', element: <AgentAllowlistPanel />, tier: 'admin',
    nav: { group: 'Platform', label: 'Agent tool allowlists', labelKey: 'agentAllowlistLabel', icon: ShieldIcon, hint: 'Grant or revoke an agent’s tools without editing a pack', hintKey: 'agentAllowlistHint' },
  },
  // ADR 0027 — the runtime, superadmin-managed public front-page pointer (the
  // CMS/Media/Publishing nav also lands in this 'Content' group, from their
  // feature packages).
  {
    path: '/front-page', element: <FrontPageSettingsPanel />, tier: 'admin', chrome: 'narrow',
    nav: { group: 'Content', label: 'Front page', labelKey: 'frontPageLabel', icon: GlobeIcon, hint: 'The public landing page at / (which org + page)', hintKey: 'frontPageHint', order: 50 },
  },
  {
    path: '/example-data', element: <ExampleDataPage />, tier: 'admin', chrome: 'narrow',
    nav: { group: 'Access & data', label: 'Example data', labelKey: 'exampleDataLabel', icon: DatabaseIcon, hint: 'Re-seed the built-in example roster', hintKey: 'exampleDataHint' },
  },
  // ADR 0170 — the runtime, superadmin-managed white-label app identity (logo /
  // colors / fonts / name / theme). Host-level authority; applies live, no rebuild.
  {
    path: '/appearance', element: <AppearancePanel />, tier: 'admin', chrome: 'narrow',
    nav: { group: 'Platform', label: 'Appearance', icon: SparklesIcon, hint: 'Logo, colors, fonts & name for this installation', order: 60 },
  },
];

/** The full manifest: core routes + every separately-distributed feature's
 *  routes (ADR §2.2). Adding a feature appends to FRONTEND_FEATURES, not here. */
export const FEATURES: FeatureRoute[] = [...CORE_FEATURES, ...featureRoutes()];

// ── Derivations (consumers render these; never re-declare nav/width data) ──

export interface NavItem extends FeatureNav { to: string }
/** A rendered nav category. `id` is the STABLE key (built-in id = the declared
 *  group label, e.g. 'Platform'); `label` is the DISPLAY string (== id unless a
 *  menu-config override renamed it, in which case `custom` is set and the literal
 *  label wins over the GROUP_LABEL_KEYS i18n lookup). ADR 0139. */
export interface NavGroup { id: string; label: string; items: NavItem[]; custom?: boolean }

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
  'Workspace', 'Leadership', 'Author', 'Marketing',
  // admin tier ('Content' = CMS / Media / Publishing / Sharing — ADR 0027)
  'Admin', 'Operations', 'Workforces', 'Content', 'Platform', 'Access & data',
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
  Leadership: 'groupLeadership',
  Author: 'groupAuthor',
  Admin: 'groupAdmin',
  Operations: 'groupOperations',
  Workforces: 'groupWorkforces',
  Content: 'groupContent',
  Platform: 'groupPlatform',
  'Access & data': 'groupAccessData',
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
    if (!g) { g = { id: f.nav.group, label: f.nav.group, items: [] }; groups.push(g); }
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
  if (item.end) return pathname === item.to;
  const under = pathname === item.to || pathname.startsWith(`${item.to}/`);
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
