import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { installNetworkRecorder } from './devtools/networkRecorder.js';
import { useNotificationStore } from './notifications/notificationStore.js';
import { useReviewStatusStore } from './chat/reviews/reviewStatusStore.js';

// Overlays are lazy-loaded and mounted only when actually opened, so the
// devtools network panel, notification panel, and command palette (+ their
// command registry / fuzzy search) stay out of the entry chunk (bundle
// hygiene, frontend enterprise-review Batch F).
const NetworkPanel = lazy(() => import('./devtools/NetworkPanel.js').then((m) => ({ default: m.NetworkPanel })));
const NotificationPanel = lazy(() => import('./notifications/NotificationPanel.js').then((m) => ({ default: m.NotificationPanel })));
const CommandPalette = lazy(() => import('./ui/CommandPalette.js').then((m) => ({ default: m.CommandPalette })));
// ADR 0027 — the public CMS-driven front page, lazy so it stays out of the app
// entry chunk (only anonymous visitors at '/' load it).
const FrontPage = lazy(() => import('./features/site/FrontPage.js').then((m) => ({ default: m.FrontPage })));
// ADR 0122 Phase 6 — the public read-only viewer for a `/shared/:token` link.
const SharedSharePage = lazy(() => import('./features/sharing/SharedSharePage.js').then((m) => ({ default: m.SharedSharePage })));

/** Always-mounted, near-zero-cost trigger that mounts the (lazy) command
 *  palette on first ⌘K / `openwop:cmdk`, forwarding the activation via
 *  openSignal so the first keystroke still opens it. Once mounted, the palette
 *  owns the hotkey and this listener detaches. */
function CommandPaletteLazy(): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const [openSignal, setOpenSignal] = useState(0);
  useEffect(() => {
    if (mounted) return;
    function open() { setMounted(true); setOpenSignal((n) => n + 1); }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); open(); }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('openwop:cmdk', open);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('openwop:cmdk', open); };
  }, [mounted]);
  if (!mounted) return null;
  return <Suspense fallback={null}><CommandPalette openSignal={openSignal} /></Suspense>;
}
import { InMemoryHostBanner } from './builder/InMemoryHostBanner.js';
import { NotFoundPage } from './NotFoundPage.js';
import { Sidebar } from './chrome/Sidebar.js';
import { AppGate } from './chrome/AppGate.js';
import { PublicShell } from './chrome/PublicShell.js';
import { matchSharedToken } from './features/sharing/shareRoute.js';
import { AdminLayout } from './chrome/AdminLayout.js';
import { AutoSeedExampleData } from './chrome/AutoSeedExampleData.js';
import { FEATURES, chromeFor, isAdminPath } from './chrome/features.js';
import { Toaster } from './ui/toast.js';
import { ConfirmRoot } from './ui/confirm.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { Skeleton } from './ui/Skeleton.js';
import { useBrand } from './brand/BrandProvider.js';
import { FeatureAccessProvider } from './featureToggles/FeatureAccessContext.js';
import { NavConfigProvider } from './chrome/navConfig/NavConfigProvider.js';
import { reportRouteView } from './platform/telemetry.js';
import { useAuth } from './auth/useAuth.js';
import { resolveFrontPage, type FrontPagePointer } from './features/site/siteConfigClient.js';

/**
 * Resolve the runtime front-page pointer (ADR 0027) when `active` — i.e. an
 * anonymous visitor on '/'. Reads the public `public-site-config` (the host-level
 * system home page, superadmin-managed); cached per page load. Returns `loading`
 * until resolved so the root gate can splash instead of flashing.
 */
function useFrontPage(active: boolean): { loading: boolean; pointer: FrontPagePointer | null } {
  const [state, setState] = useState<{ loading: boolean; pointer: FrontPagePointer | null }>({ loading: active, pointer: null });
  useEffect(() => {
    if (!active) { setState({ loading: false, pointer: null }); return; }
    let live = true;
    setState((s) => (s.loading ? s : { loading: true, pointer: s.pointer }));
    void resolveFrontPage().then((p) => { if (live) setState({ loading: false, pointer: p }); });
    return () => { live = false; };
  }, [active]);
  return state;
}

/**
 * The app shell renders ENTIRELY from the feature manifest
 * (`chrome/features.tsx`) — routes, the workspace/admin tier split, and the
 * width chrome all derive from declarations there. Adding a page means adding
 * ONE manifest entry; this file is otherwise stable (white-label PRD §2/§3).
 *
 * The ONE deliberate exception (ADR 0027): a public CMS-driven front page at '/'
 * for anonymous visitors, rendered in <PublicShell> ABOVE <AppGate> so a
 * sign-in / password gate can't hide a deployment's own marketing page. The
 * content is the host-level system home page; this never moves the signed-in '/'
 * (Chat).
 */
/** The reserved host-global system-site org (ADR 0027; see backend host/systemSite.ts).
 *  Its published CMS pages render publicly at `/p/:slug` (e.g. the seeded Features page). */
const SYSTEM_SITE_ORG = 'host-site';

export function App() {
  const { t } = useTranslation('chrome');
  const location = useLocation();
  const { user, loading } = useAuth();
  // ADR 0170 — subscribe the root to the runtime brand so a super-admin override
  // (loaded by BrandProvider) re-renders the tree, refreshing every `brand.*`
  // consumer (footer, gate, chrome) — not just the `useBrand()` ones.
  const brand = useBrand();
  // ADR 0027 — public front page at '/'. Resolve the runtime pointer only for an
  // anonymous visitor on root (during auth-resolution `user` is null, so this is
  // active then too). `showPublic` = render the PublicShell (its splash, or the
  // page) instead of the app shell; computed before the effects so they can skip
  // app-only bootstrap while the marketing page is shown.
  const onRoot = location.pathname === '/';
  const { loading: fpLoading, pointer } = useFrontPage(onRoot && !user);
  const showFrontPage = onRoot && !user && (loading || fpLoading || (pointer?.enabled ?? false));
  // ADR 0027 — host-global published CMS pages are viewable publicly at `/p/:slug`
  // (e.g. the seeded `/p/features`), rendered in the bare PublicShell for anyone
  // (anonymous or signed-in), reusing FrontPage pointed at the system-site org.
  const publicPageMatch = location.pathname.match(/^\/p\/([a-z0-9][a-z0-9-]*)$/);
  const publicPageSlug = publicPageMatch ? publicPageMatch[1] : null;
  // ADR 0122 Phase 6 — a public, anonymous-reachable read-only share viewer at
  // `/shared/:token`, rendered in the bare PublicShell like `/p/:slug`.
  const sharedToken = matchSharedToken(location.pathname);
  const showPublic = showFrontPage || publicPageSlug !== null || sharedToken !== null;
  // Network inspector toggle — installs the fetch interceptor on first
  // mount so calls made before the panel is opened are still captured.
  // Idempotent: installNetworkRecorder() short-circuits after the first
  // call so HMR / StrictMode double-renders don't double-wrap fetch.
  useEffect(() => { installNetworkRecorder(); }, []);
  // Bootstrap the notification store — hydrate via REST + attach SSE
  // for live deltas. Idempotent: `connect()` no-ops if already connected.
  // Skipped while the public front page is shown (an anonymous visitor has no
  // session to stream); re-runs to connect once the app shell takes over.
  const connectNotifications = useNotificationStore((s) => s.connect);
  const disconnectNotifications = useNotificationStore((s) => s.disconnect);
  useEffect(() => {
    if (showPublic) return;
    void connectNotifications();
    return () => disconnectNotifications();
  }, [showPublic, connectNotifications, disconnectNotifications]);
  // ADR 0074 — keep the shared review-status store live app-wide (gated on the
  // authed shell), so every review surface (Reviews tab, in-chat + Runs approval
  // cards, inbox) reflects a decision made anywhere, on any client, in real time.
  // Reuses the already-connected notifications stream — no second connection.
  // Ref-counted, so surface-level connects share this one hydrate.
  const connectReviewStatus = useReviewStatusStore((s) => s.connect);
  const disconnectReviewStatus = useReviewStatusStore((s) => s.disconnect);
  useEffect(() => {
    if (showPublic) return;
    void connectReviewStatus();
    return () => disconnectReviewStatus();
  }, [showPublic, connectReviewStatus, disconnectReviewStatus]);
  const [netOpen, setNetOpen] = useState(false);
  const notifPanelOpen = useNotificationStore((s) => s.panelOpen);

  // Width/scroll treatment is manifest-declared per route (`chrome:`), never
  // hand-listed here. Admin-tier routes render inside <AdminLayout>'s
  // two-column shell, which needs the full-bleed main.
  // Move keyboard focus to <main> on every navigation (a11y, GAP-ANALYSIS E6),
  // so a route change doesn't strand focus on a now-irrelevant sidebar link.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.focus();
    reportRouteView(location.pathname);
  }, [location.pathname]);

  const chrome = chromeFor(location.pathname);
  const admin = isAdminPath(location.pathname);
  const mainClass = admin
    ? 'app-main app-main-fullbleed page-enter'
    : chrome === 'fullbleed'
      ? 'app-main app-main-fullbleed'
      : chrome === 'chat'
        ? 'app-main app-main--ai'
        : chrome === 'narrow'
          ? 'app-main app-main--narrow page-enter'
          : 'app-main page-enter';

  // ADR 0027 — public front page. At '/', an anonymous visitor gets the
  // CMS-driven marketing page in the bare PublicShell ABOVE AppGate. While auth or
  // the front-page pointer is still resolving, show a neutral splash to avoid a
  // wrong-content flash; once resolved, an enabled pointer renders the page (a
  // disabled one makes `showPublic` false → falls through to the app, '/' = Chat).
  if (showPublic) {
    return (
      <PublicShell>
        {sharedToken
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><SharedSharePage token={sharedToken} /></Suspense>
          : publicPageSlug
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><FrontPage orgId={SYSTEM_SITE_ORG} slug={publicPageSlug} /></Suspense>
          : loading || fpLoading
            ? <div className="u-p-4"><Skeleton /></div>
            : <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><FrontPage orgId={pointer?.orgId ?? ''} slug={pointer?.slug ?? 'home'} /></Suspense>}
      </PublicShell>
    );
  }

  return (
    <AppGate>
    <FeatureAccessProvider>
    <NavConfigProvider>
    <div className={chrome === 'chat' ? 'app-shell app-shell--ai' : 'app-shell'}>
      <a className="skip-link" href="#main-content">{t('skipToContent')}</a>
      <AutoSeedExampleData />
      {/* Persistent left rail: grouped workspace nav (Build / Operate) + the
          single Admin entry, collapsible, with the workspace/org switcher +
          account chrome. Chat stays first (feedback_chat_first_nav). */}
      <Sidebar netOpen={netOpen} onToggleNet={() => setNetOpen((v) => !v)} />
      <div className="app-body">
        <InMemoryHostBanner />
        <main id="main-content" ref={mainRef} tabIndex={-1} className={mainClass}>
        <ErrorBoundary resetKey={location.pathname} label="page">
        <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}>
        <Routes>
          {/* Workspace-tier routes render in the app shell. (Public-tier routes,
              ADR 0027, render above AppGate and never reach here.) */}
          {FEATURES.filter((f) => f.tier === 'workspace').map((f) => (
            <Route key={f.path} path={f.path} element={f.element} />
          ))}
          {/* Admin tier: a PATHLESS layout route — admin pages keep their
              original deep-link paths while rendering inside the embedded
              collapsible admin rail.

              UI-1 (deliberate non-gating): there is intentionally NO client-side
              RequireRole guard here. "admin tier" is an IA grouping, not a
              permission — admin authority is server-side (superadmin via
              OPENWOP_SUPERADMIN_TENANTS) and EVERY admin data call is RBAC-gated
              on the backend, returning 403 for non-admins (panels self-hide on
              403). The client deliberately exposes no role boolean to gate on,
              so a direct /admin deep-link may render empty admin chrome before
              the server denies its reads — a cosmetic leak, never a data leak.
              The server is the single authority; do not add a client guard that
              would imply otherwise. */}
          <Route element={<AdminLayout />}>
            {FEATURES.filter((f) => f.tier === 'admin').map((f) => (
              <Route key={f.path} path={f.path} element={f.element} />
            ))}
          </Route>
          {/* Catch-all: the SPA host rewrites every path to index.html, so an
              unmatched URL must resolve here rather than render a blank main. */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
        </ErrorBoundary>
        </main>
        {/* The AI chat surface is a full-height, immersive composer — the global
            privacy footer rail just steals vertical space below the composer
            there. Hide it on the chat chrome; every other surface keeps it. */}
        {chrome !== 'chat' && (
          <footer className="app-footer">
            {brand.footerText} ·{' '}
            <Link to="/privacy">{t('footerPrivacy')}</Link>
          </footer>
        )}
      </div>
      {netOpen ? (
        <Suspense fallback={null}><NetworkPanel open={netOpen} onClose={() => setNetOpen(false)} /></Suspense>
      ) : null}
      {notifPanelOpen ? (
        <Suspense fallback={null}><NotificationPanel /></Suspense>
      ) : null}
      <CommandPaletteLazy />
      <Toaster />
      <ConfirmRoot />
    </div>
    </NavConfigProvider>
    </FeatureAccessProvider>
    </AppGate>
  );
}
