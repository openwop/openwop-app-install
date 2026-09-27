import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Route, Routes, matchPath, useLocation } from 'react-router-dom';
import { useNotificationStore } from './notifications/notificationStore.js';
import { useReviewStatusStore } from './chat/reviews/reviewStatusStore.js';

// Overlays are lazy-loaded and mounted only when actually opened, so the
// devtools network panel, notification panel, and command palette (+ their
// command registry / fuzzy search) stay out of the entry chunk (bundle
// hygiene, frontend enterprise-review Batch F). The whole network-inspector
// seam (recorder + panel) is lazy too — ADR 0196 Phase 2 moved the recorder
// install behind the `developer-tools` toggle inside NetworkInspectorMount,
// which also takes networkRecorder out of the entry chunk.
// Two conditional shell prompts, lazy for the same reason (CLNP-8): each renders
// nothing until an async read says it applies (an in-memory host; a workspace
// with no model vendor), so an eager import made every visitor pay for a
// component almost nobody sees. Found when main's ENTRY went 6 B over budget.
const InMemoryHostBanner = lazy(() => import('./builder/InMemoryHostBanner.js').then((m) => ({ default: m.InMemoryHostBanner })));
const VendorSetupPrompt = lazy(() => import('./chrome/VendorSetupPrompt.js').then((m) => ({ default: m.VendorSetupPrompt })));
const NetworkInspectorMount = lazy(() => import('./devtools/NetworkInspectorMount.js').then((m) => ({ default: m.NetworkInspectorMount })));
const NotificationPanel = lazy(() => import('./notifications/NotificationPanel.js').then((m) => ({ default: m.NotificationPanel })));
const CommandPalette = lazy(() => import('./ui/CommandPalette.js').then((m) => ({ default: m.CommandPalette })));
// The operator shell is needed only on admin-tier routes. Keeping its rail,
// access gate, and state UI out of the workspace entry chunk also gives the
// near-limit entry bundle durable headroom.
const AdminLayout = lazy(() => import('./chrome/AdminLayout.js').then((m) => ({ default: m.AdminLayout })));
// ADR 0027 — the public CMS-driven front page, lazy so it stays out of the app
// entry chunk (only anonymous visitors at '/' load it).
const FrontPage = lazy(() => import('./features/site/FrontPage.js').then((m) => ({ default: m.FrontPage })));
// ADR 0122 Phase 6 — the public read-only viewer for a `/shared/:token` link.
const SharedSharePage = lazy(() => import('./features/sharing/SharedSharePage.js').then((m) => ({ default: m.SharedSharePage })));
const PresentRemotePage = lazy(() => import('./canvas/PresentRemotePage.js').then((mod) => ({ default: mod.PresentRemotePage })));
const StorefrontPage = lazy(() => import('./features/commerce/StorefrontPage.js').then((mm) => ({ default: mm.StorefrontPage })));
// ADR 0392 — the public docs tier (nav tree + doc body), bare-PublicShell posture.
const DocsPublicPage = lazy(() => import('./features/docs/DocsPublicPage.js').then((m) => ({ default: m.DocsPublicPage })));
// ADR 0331 — the hosted public form fill page at `/f/:formId`.
const PublicFormPage = lazy(() => import('./features/forms/PublicFormPage.js').then((mm) => ({ default: mm.PublicFormPage })));
// ADR 0339 — the visitor-facing funnel viewer at `/fn/:orgId/:slug`.
const FunnelViewerPage = lazy(() => import('./features/funnels/viewer/FunnelViewerPage.js').then((mm) => ({ default: mm.FunnelViewerPage })));
// ADR 0402 — the public CRM booking page (`/book/:slug`) + manage (`/book/manage/:token`).
const PublicBookingPage = lazy(() => import('./features/crm/PublicBookingPage.js').then((mm) => ({ default: mm.PublicBookingPage })));
const PublicBookingManagePage = lazy(() => import('./features/crm/PublicBookingManagePage.js').then((mm) => ({ default: mm.PublicBookingManagePage })));
const PublicSignPage = lazy(() => import('./features/crm/PublicSignPage.js').then((mm) => ({ default: mm.PublicSignPage })));
// R2 IN-SP-5 (UX_UPGRADE-invitations) — the invite-accept page joins the
// public-route branch: under white-label appGate modes (sign-in/password) the
// signed-out preview could never render — a password wall instead of the
// invitation. Same bare-PublicShell posture as every other token page.
const InviteAcceptPublicPage = lazy(() => import('./orgs/InviteAcceptPage.js').then((mm) => ({ default: mm.InviteAcceptPage })));
// ADR 0391 — the public blog archive (`/blog/*`) + post view, and the `/pricing`
// marketing page, all in the bare PublicShell above the auth gate.
const BlogPage = lazy(() => import('./features/site/BlogPage.js').then((mm) => ({ default: mm.BlogPage })));
const BlogPostPage = lazy(() => import('./features/site/BlogPostPage.js').then((mm) => ({ default: mm.BlogPostPage })));
const PricingPage = lazy(() => import('./features/site/PricingPage.js').then((mm) => ({ default: mm.PricingPage })));
// ADR 0390 — the public podcast pages (`/pod/:orgId[/:showSlug[/:episodeSlug]]`)
// in the bare PublicShell above the auth gate (published-only, org→tenant server-side).
const PublicPodcastPage = lazy(() => import('./features/podcasts/PublicPodcastPage.js').then((mm) => ({ default: mm.PublicPodcastPage })));
// ADR 0544 P3 — the public attestation verification page at `/verify/:token`.
const AttestationVerifyPage = lazy(() => import('./features/job-search/AttestationVerifyPage.js').then((mm) => ({ default: mm.AttestationVerifyPage })));

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

import { RateLimitBanner } from './chrome/RateLimitBanner.js';
import { NavTelemetry } from './chrome/NavTelemetry.js';
import { NotificationNavigator } from './notifications/NotificationNavigator.js';
import { NotFoundPage } from './NotFoundPage.js';
import { Sidebar } from './chrome/Sidebar.js';
import { AppGate } from './chrome/AppGate.js';
import { SiteShell } from './chrome/SiteShell.js';
import { siteWrapsAppGate, tierIsSessionBearing } from './chrome/tierShell.js';
import { PublicShell } from './chrome/PublicShell.js';
import { matchSharedToken } from './features/sharing/shareRoute.js';
import { matchPresentRemoteToken } from './canvas/presentRemoteRoute.js';
import { matchFormFillId } from './features/forms/fillRoute.js';
import { matchFunnelView } from './features/funnels/viewer/viewRoute.js';
import { matchBookSlug, matchBookManage } from './features/crm/bookRoute.js';
import { matchSignToken } from './features/crm/signRoute.js';
import { matchPublicPageSlug } from './features/site/publicPageRoute.js';
import { matchBlogRoute } from './features/site/blogRoute.js';
import { matchPricingRoute } from './features/site/pricingRoute.js';
import { FRONTEND_FEATURES } from './features/registry.js';
import { config } from './client/config.js';
import { matchDocsIndex, matchDocsSlug } from './features/docs/docsRoute.js';
import { matchStoreOrgId } from './features/commerce/storeRoute.js';
import { matchPodcastView } from './features/podcasts/podcastRoute.js';
import { matchVerifyToken } from './features/job-search/verifyRoute.js';
import { AutoSeedExampleData } from './chrome/AutoSeedExampleData.js';
import { FEATURES, chromeFor, isAdminPath, prefetchChatTab } from './chrome/features.js';
import type { FeatureRoute } from './chrome/featureTypes.js';
import { EntitlementGuard } from './featureToggles/EntitlementGuard.js';

/**
 * Which feature id an ADR 0419 entitlement check should key on for a route.
 *
 * `ownerFeatureId` (stamped by `featureRoutes()`) covers EVERY route a feature
 * contributes, including detail/deep-link routes that carry no nav entry.
 * `nav.featureId` is the fallback for `CORE_FEATURES` routes, which are declared
 * inline and have no owning `FrontendFeature` — those are core substrate and
 * resolve unlocked anyway, so the fallback is belt-and-braces, not load-bearing.
 */
const entitlementKeyOf = (f: FeatureRoute): string | undefined => f.ownerFeatureId ?? f.nav?.featureId;
import { Toaster } from './ui/toast.js';
const WalkthroughOverlayHost = lazy(() => import('./walkthroughs/WalkthroughOverlayHost.js').then((m) => ({ default: m.WalkthroughOverlayHost })));
const TutorialHint = lazy(() => import('./features/tutorials/TutorialHint.js').then((m) => ({ default: m.TutorialHint })));
// ADR 0378 P4 — boot-eager triggers for the core-page walkthrough packs (each
// pack stays a lazy chunk; the pages are lazy routes so registration can't
// wait for a visit).
void import('./walkthroughs/corePacks.js').then((m) => m.registerCoreWalkthroughPacks());
import { GlobalLiveRegion } from './ui/announce.js';
import { ConfirmRoot } from './ui/confirm.js';
import { ErrorBoundary } from './ui/ErrorBoundary.js';
import { Skeleton } from './ui/Skeleton.js';
import { useBrand } from './brand/BrandProvider.js';
import { FeatureAccessProvider } from './featureToggles/FeatureAccessContext.js';
import { NavConfigProvider } from './chrome/navConfig/NavConfigProvider.js';
import { shouldShowFrontPage, hasLegacyChatParams } from './chrome/rootRoute.js';
import { reportRouteView } from './platform/telemetry.js';
import { useAuth } from './auth/useAuth.js';
import { resolveFrontPage, type FrontPagePointer } from './features/site/siteConfigClient.js';

/** Route chunks load inside the app's already-mounted main landmark. The
 * fallback is named and status-bearing without introducing a nested main. */
function RouteLoading(): JSX.Element {
  const { t } = useTranslation('chrome');
  return (
    <div className="u-p-4" role="status" aria-label={t('common:loading')} aria-busy="true">
      <Skeleton />
      <span className="sr-only">{t('common:loading')}</span>
    </div>
  );
}

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
 * The ONE deliberate exception (ADR 0027): a public CMS-driven front page at '/',
 * rendered in <PublicShell> ABOVE <AppGate> so a sign-in / password gate can't
 * hide a deployment's own marketing page. The content is the host-level system
 * home page.
 *
 * CORRECTED 2026-09-11: this used to read "for anonymous visitors ... the
 * signed-in '/' is the Dashboard". It is now for EVERY visitor when the operator's
 * front-page toggle is on — which is what that toggle's label always claimed. A
 * signed-in visitor gets an "Open app" affordance on the page rather than a
 * redirect past it. With the toggle OFF, `/` is the app shell for everyone and
 * `RootRedirect` sends a signed-in visitor to /dashboard. See
 * `chrome/rootRoute.ts` for the full note and the ADR 0487 reversal.
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
  // § Correction (2026-07-25, ADR 0487): '/' is ALWAYS the public marketing home
  // for an anonymous visitor — no `app-entered` marker, no dual-purpose root. A
  // SIGNED-IN visitor at '/' falls through to the app shell, whose '/' route
  // redirects to the Dashboard's own URL (`/dashboard`). A legacy chat deep link
  // ('/?agent='/'?conversation='/'?new=' — a live "Ask <agent>" entry point,
  // reachable by anon) ALSO falls through so `RootRedirect` forwards it to /chat;
  // the shared gate excludes those params. This restores ADR 0027's intent
  // unconditionally without stranding a logged-out visitor on the dashboard.
  const rootIsLegacyChat = onRoot && hasLegacyChatParams(location.search);
  // CORRECTION 2026-09-11 — no `!user` here. The pointer must resolve for EVERY
  // visitor on `/`, or `shouldShowFrontPage` receives `frontPageEnabled: false`
  // for a signed-in one and the operator's toggle is silently inert. This is the
  // second of the two places that enforced anonymous-only; see `chrome/rootRoute.ts`.
  const { loading: fpLoading, pointer } = useFrontPage(onRoot && !rootIsLegacyChat);
  const showFrontPage = shouldShowFrontPage({
    onRoot, hasUser: user !== null, search: location.search,
    authLoading: loading, frontPageLoading: fpLoading, frontPageEnabled: pointer?.enabled ?? false,
  });
  // ADR 0027 — host-global published CMS pages are viewable publicly at `/p/:slug`
  // (e.g. the seeded `/p/features`), rendered in the bare PublicShell for anyone
  // (anonymous or signed-in), reusing FrontPage pointed at the system-site org.
  const publicPageSlug = matchPublicPageSlug(location.pathname);
  // ADR 0392 — the public docs tier at `/docs` (index) and `/docs/:slug`, same
  // bare-PublicShell posture as `/p/:slug` (published-only enforced server-side).
  const docsSlug = matchDocsSlug(location.pathname);
  const docsIndex = matchDocsIndex(location.pathname);

  // ADR 0122 Phase 6 — a public, anonymous-reachable read-only share viewer at
  // `/shared/:token`, rendered in the bare PublicShell like `/p/:slug`.
  const sharedToken = matchSharedToken(location.pathname);
  // ADR 0328 P4 — the public phone-remote controller at `/present-remote/:token`,
  // same bare-PublicShell posture (the capability token IS the credential).
  const presentRemoteToken = matchPresentRemoteToken(location.pathname);
  // Ecommerce gap plan §5C C2 — the public storefront at `/store/:orgId`, same
  // bare-PublicShell posture (anonymous OR signed-in visitors shop the same page).
  const storeOrgId = matchStoreOrgId(location.pathname);
  // ADR 0331 §D3 — the hosted public fill page at `/f/:formId`, same bare-
  // PublicShell posture (published-only + toggle-on enforced server-side).
  const fillFormId = matchFormFillId(location.pathname);
  // ADR 0339 — the funnel viewer, same bare-PublicShell posture.
  const funnelView = matchFunnelView(location.pathname);
  // ADR 0402 — match `manage` BEFORE `slug` (the slug regex excludes `manage`).
  const bookManage = matchBookManage(location.pathname);
  const bookSlug = matchBookSlug(location.pathname);
  const signToken = matchSignToken(location.pathname);
  // Trailing-slash tolerant (review F7): the manifest route was REMOVED (this
  // branch is the one registration), so a near-miss must not 404 into AppGate.
  const inviteAccept = location.pathname.replace(/\/+$/, '') === '/invitations/accept';
  // ADR 0391 — the public blog archive (`/blog/*`) + the `/pricing` marketing
  // page, same bare-PublicShell posture (published-only, org→tenant server-side).
  const blogRoute = matchBlogRoute(location.pathname);
  const pricingRoute = matchPricingRoute(location.pathname);
  // ADR 0390 — the public podcast show/episode pages, same bare-PublicShell posture.
  const podcastView = matchPodcastView(location.pathname);
  // ADR 0544 P3 — `/verify/:token`, a SIBLING public path (never under
  // `/job-search`). The bearer token IS the credential and the page is
  // noindex; the backend refuses unknown/revoked/malformed identically.
  const verifyToken = matchVerifyToken(location.pathname);
  // ADR 0630 — feature-declared public pages (`FrontendFeature.publicRoutes`) in the same bare-PublicShell posture; App.tsx imports only the registry, so a distribution that excludes a feature excludes its public page.
  const featurePublic = FRONTEND_FEATURES.flatMap((f) => f.publicRoutes ?? []).find((r) => r.match(location.pathname));
  const showPublic = featurePublic !== undefined || verifyToken !== null || showFrontPage || publicPageSlug !== null || sharedToken !== null || storeOrgId !== null || presentRemoteToken !== null || fillFormId !== null || funnelView !== null || bookManage !== null || bookSlug !== null || signToken !== null || inviteAccept || blogRoute !== null || pricingRoute || podcastView !== null || docsSlug !== null || docsIndex;

  // ── ADR 0641 — the `site` tier ────────────────────────────────────────────
  // The third branch. `site` routes render in <SiteShell> (bare product chrome
  // WITH nav), and the per-route `auth` posture — NOT the tier — decides whether
  // <AppGate> wraps them.
  //
  // Matched by exact path against the manifest rather than by <Routes>, because
  // shell selection has to happen BEFORE the router: by the time a <Route>
  // element renders we are already inside whichever shell was chosen, which is
  // the same structural reason `chromeFor()` could not express this tier.
  const siteRoute = FEATURES.find((f) => f.tier === 'site' && matchPath({ path: f.path, end: true }, location.pathname) !== null);
  // Session/SSE bootstrap keys on whether the route is SESSION-BEARING, not on
  // `showPublic`. That boolean conflated two questions — "is this the bare
  // marketing shell" and "should we open a session" — which is exactly why a
  // bare-shell-but-authenticated surface was inexpressible. A `site` route is
  // session-bearing under both postures: `auth:'optional'` still renders richer
  // for a signed-in visitor, so it wants the session when one exists.
  const sessionBearing = siteRoute !== undefined ? tierIsSessionBearing('site') : !showPublic;
  // Network inspector — the recorder install AND the panel mount are owned by
  // NetworkInspectorMount, gated on the `developer-tools` toggle (ADR 0196
  // Phase 2): a clean install never wraps fetch or buffers bodies at all.
  // Bootstrap the notification store — hydrate via REST + attach SSE
  // for live deltas. Idempotent: `connect()` no-ops if already connected.
  // Skipped while the public front page is shown (an anonymous visitor has no
  // session to stream); re-runs to connect once the app shell takes over.
  const connectNotifications = useNotificationStore((s) => s.connect);
  const disconnectNotifications = useNotificationStore((s) => s.disconnect);
  useEffect(() => {
    if (!sessionBearing) return;
    void connectNotifications();
    return () => disconnectNotifications();
  }, [sessionBearing, connectNotifications, disconnectNotifications]);
  // ADR 0074 — keep the shared review-status store live app-wide (gated on the
  // authed shell), so every review surface (Reviews tab, in-chat + Runs approval
  // cards, inbox) reflects a decision made anywhere, on any client, in real time.
  // Reuses the already-connected notifications stream — no second connection.
  // Ref-counted, so surface-level connects share this one hydrate.
  const connectReviewStatus = useReviewStatusStore((s) => s.connect);
  const disconnectReviewStatus = useReviewStatusStore((s) => s.disconnect);
  useEffect(() => {
    if (!sessionBearing) return;
    void connectReviewStatus();
    return () => disconnectReviewStatus();
  }, [sessionBearing, connectReviewStatus, disconnectReviewStatus]);
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

  // ENG-4 / IDN-10 — the chat tree is a lazy chunk (chrome/features.tsx). Warm
  // it once, after first paint, so the most likely next hop (and the target of
  // every legacy `/?agent=` deep link) is already cached when it is clicked.
  // Empty deps: exactly one warm per shell mount, not one per navigation.
  useEffect(() => { prefetchChatTab(); }, []);

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
  // ── ADR 0641 decision 3 — the site branch, BEFORE the public branch ───────
  // Ordering is load-bearing. A `site` route must never fall through into
  // <PublicShell>: that shell carries no nav and sits strictly above <AppGate>,
  // so an `auth: 'required'` participant surface would render chrome-less AND
  // ungated. Matching first makes the tier authoritative over any later
  // path-shaped guess.
  if (siteRoute !== undefined) {
    // The element renders THROUGH a <Route> whose pattern is the manifest path,
    // not as a bare child: `useParams()` only resolves inside a route match
    // context, and rendering `siteRoute.element` directly handed every
    // `tier:'site'` route with a `:param` an EMPTY params object. Measured on
    // production 2026-09-15: `/discover/:challengeId` read `challengeId=''`
    // for every visitor and rendered "Challenge not found". Shell selection
    // still happens above the router, by `matchPath`, exactly as before; this
    // only gives the matched element the params that match produced.
    const body = (
      <SiteShell>
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path={siteRoute.path} element={siteRoute.element} />
          </Routes>
        </Suspense>
      </SiteShell>
    );
    // `required` wraps the sign-in wall; `optional` MUST NOT (decision 3).
    // Omission selects `required` — fail-closed, matching siteRouteContract and
    // tierShell: a route that forgets the field gets the wall rather than
    // silently exposing a surface.
    //
    // Both postures render inside <FeatureAccessProvider> + <NavConfigProvider>
    // because the nav strip resolves through the toggle gate either way; on the
    // anonymous path those providers simply resolve an empty/for-anon set, which
    // is the correct answer rather than a missing one.
    return siteWrapsAppGate(siteRoute.auth) ? (
      <AppGate>
        <FeatureAccessProvider>
          <NavConfigProvider>{body}</NavConfigProvider>
        </FeatureAccessProvider>
      </AppGate>
    ) : (
      <FeatureAccessProvider>
        <NavConfigProvider>{body}</NavConfigProvider>
      </FeatureAccessProvider>
    );
  }

  if (showPublic) {
    return (
      <PublicShell>
        {verifyToken
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><AttestationVerifyPage token={verifyToken} /></Suspense>
          : podcastView
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><PublicPodcastPage view={podcastView} /></Suspense>
          : pricingRoute
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><PricingPage /></Suspense>
          : featurePublic
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}>{featurePublic.render()}</Suspense>
          : blogRoute
          ? (blogRoute.kind === 'post'
              ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><BlogPostPage orgId={config.siteOrgId} slug={blogRoute.slug} /></Suspense>
              : <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><BlogPage orgId={config.siteOrgId} route={blogRoute} /></Suspense>)
          : storeOrgId
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><StorefrontPage orgId={storeOrgId} /></Suspense>
          : fillFormId
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><PublicFormPage formId={fillFormId} /></Suspense>
          : funnelView
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><FunnelViewerPage key={`${funnelView.orgId}/${funnelView.slug}`} orgId={funnelView.orgId} slug={funnelView.slug} /></Suspense>
          : bookManage
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><PublicBookingManagePage token={bookManage.token} /></Suspense>
          : bookSlug
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><PublicBookingPage slug={bookSlug.slug} /></Suspense>
          : signToken
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><PublicSignPage token={signToken.token} /></Suspense>
          : inviteAccept
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><InviteAcceptPublicPage /></Suspense>
          : presentRemoteToken
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><PresentRemotePage token={presentRemoteToken} /></Suspense>
          : sharedToken
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><SharedSharePage token={sharedToken} /></Suspense>
          : docsSlug !== null || docsIndex
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><DocsPublicPage orgId={SYSTEM_SITE_ORG} slug={docsSlug} /></Suspense>
          : publicPageSlug
          ? <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><FrontPage orgId={SYSTEM_SITE_ORG} slug={publicPageSlug} surface="slug" /></Suspense>
          : loading || fpLoading
            ? <div className="u-p-4"><Skeleton /></div>
            : <Suspense fallback={<div className="u-p-4"><Skeleton /></div>}><FrontPage orgId={pointer?.orgId ?? ''} slug={pointer?.slug ?? 'home'} surface="root" /></Suspense>}
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
      <Suspense fallback={null}><VendorSetupPrompt /></Suspense>
      {/* Persistent left rail: grouped workspace nav (Build / Operate) + the
          single Admin entry, collapsible, with the workspace/org switcher +
          account chrome. Dashboard first, then Chat (2026-07-16 user request). */}
      <Sidebar netOpen={netOpen} onToggleNet={() => setNetOpen((v) => !v)} />
      <div className="app-body">
        <Suspense fallback={null}><InMemoryHostBanner /></Suspense>
        {/* ADR 0640 — a rate limit presents as many unrelated failures; say so once. */}
        <RateLimitBanner />
        <NavTelemetry />
        {/* CMNT-UX-4 — registers the router navigator with notificationStore so a
            desktop-toast / native-shell click actually navigates the SPA. */}
        <NotificationNavigator />
        <main id="main-content" ref={mainRef} tabIndex={-1} className={mainClass}>
        <ErrorBoundary resetKey={location.pathname} label="page">
        <Suspense fallback={<RouteLoading />}>
        <Routes>
          {/* Workspace-tier routes render in the app shell. (Public-tier routes,
              ADR 0027, render above AppGate and never reach here.) */}
          {FEATURES.filter((f) => f.tier === 'workspace').map((f) => (
            // ADR 0419 — a paid-but-unbought feature deep-linked directly renders the
            // "unlock in the feature store" state; passthrough when unlocked / billing
            // off. Backend stays the authority.
            //
            // Keyed on `ownerFeatureId` (stamped at composition), NOT `nav.featureId`.
            // The latter exists only on INDEX routes, so keying on it left 21
            // bundle-feature DETAIL routes unguarded — `/crm/deals/:dealId`,
            // `/slides/:canvasId`, `/documents/:documentId`, … — i.e. exactly the
            // bookmark/share URLs this guard exists to cover.
            <Route
              key={f.path}
              path={f.path}
              element={entitlementKeyOf(f) ? <EntitlementGuard featureId={entitlementKeyOf(f)!}>{f.element}</EntitlementGuard> : f.element}
            />
          ))}
          {/* Admin tier: a PATHLESS layout route — admin pages keep their
              original deep-link paths while rendering inside the embedded
              collapsible admin rail.

              ADR 0203: `admin` is the role-gated operator shell. AdminLayout
              projects the caller's effective access before rendering; every
              backend route remains the authoritative enforcement point. */}
          <Route element={<AdminLayout />}>
            {FEATURES.filter((f) => f.tier === 'admin').map((f) => (
              // Authority and entitlement are different axes.
              // Admin-tier features can sit in a sellable bundle (`commerce-ucp`,
              // `custom-domains`), so they get the same ADR 0419 locked state. The
              // server remains the single authority either way; this only avoids
              // rendering a page the backend will 403.
              <Route
                key={f.path}
                path={f.path}
                element={entitlementKeyOf(f) ? <EntitlementGuard featureId={entitlementKeyOf(f)!}>{f.element}</EntitlementGuard> : f.element}
              />
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
            {brand.footerText ? <>{brand.footerText} ·{' '}</> : null}
            <Link to="/privacy">{t('footerPrivacy')}</Link>
          </footer>
        )}
      </div>
      <Suspense fallback={null}><NetworkInspectorMount open={netOpen} onClose={() => setNetOpen(false)} /></Suspense>
      {notifPanelOpen ? (
        <Suspense fallback={null}><NotificationPanel /></Suspense>
      ) : null}
      <CommandPaletteLazy />
      <Toaster />
      <GlobalLiveRegion />
      <ConfirmRoot />
      <Suspense fallback={null}><WalkthroughOverlayHost /></Suspense>
      {/* ADR 0488 D7 — the contextual "Teach me this" affordance. */}
      <Suspense fallback={null}><TutorialHint /></Suspense>
    </div>
    </NavConfigProvider>
    </FeatureAccessProvider>
    </AppGate>
  );
}
