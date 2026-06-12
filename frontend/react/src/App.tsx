import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { installNetworkRecorder } from './devtools/networkRecorder.js';
import { useNotificationStore } from './notifications/notificationStore.js';

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
import { DemoHostBanner } from './builder/DemoHostBanner.js';
import { NotFoundPage } from './NotFoundPage.js';
import { Sidebar } from './chrome/Sidebar.js';
import { AppGate } from './chrome/AppGate.js';
import { PublicShell } from './chrome/PublicShell.js';
import { AdminLayout } from './chrome/AdminLayout.js';
import { AutoSeedDemoData } from './chrome/AutoSeedDemoData.js';
import { FEATURES, chromeFor, isAdminPath } from './chrome/features.js';
import { Toaster } from './ui/toast.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { Skeleton } from './ui/Skeleton.js';
import { brand } from './brand/brand.js';
import { FeatureAccessProvider } from './featureToggles/FeatureAccessContext.js';
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
export function App() {
  const location = useLocation();
  const { user, loading } = useAuth();
  // ADR 0027 — public front page at '/'. Resolve the runtime pointer only for an
  // anonymous visitor on root (during auth-resolution `user` is null, so this is
  // active then too). `showPublic` = render the PublicShell (its splash, or the
  // page) instead of the app shell; computed before the effects so they can skip
  // app-only bootstrap while the marketing page is shown.
  const onRoot = location.pathname === '/';
  const { loading: fpLoading, pointer } = useFrontPage(onRoot && !user);
  const showPublic = onRoot && !user && (loading || fpLoading || (pointer?.enabled ?? false));
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
        {loading || fpLoading
          ? <div className="u-p-4"><Skeleton /></div>
          : <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><FrontPage orgId={pointer?.orgId ?? ''} slug={pointer?.slug ?? 'home'} /></Suspense>}
      </PublicShell>
    );
  }

  return (
    <AppGate>
    <FeatureAccessProvider>
    <div className={chrome === 'chat' ? 'app-shell app-shell--ai' : 'app-shell'}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <AutoSeedDemoData />
      {/* Persistent left rail: grouped workspace nav (Build / Operate) + the
          single Admin entry, collapsible, with the workspace/org switcher +
          account chrome. Chat stays first (feedback_chat_first_nav). */}
      <Sidebar netOpen={netOpen} onToggleNet={() => setNetOpen((v) => !v)} />
      <div className="app-body">
        <DemoHostBanner />
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
              collapsible admin rail. */}
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
        <footer className="app-footer">
          {brand.footerText} ·{' '}
          <Link to="/privacy">Privacy</Link>
        </footer>
      </div>
      {netOpen ? (
        <Suspense fallback={null}><NetworkPanel open={netOpen} onClose={() => setNetOpen(false)} /></Suspense>
      ) : null}
      {notifPanelOpen ? (
        <Suspense fallback={null}><NotificationPanel /></Suspense>
      ) : null}
      <CommandPaletteLazy />
      <Toaster />
    </div>
    </FeatureAccessProvider>
    </AppGate>
  );
}
