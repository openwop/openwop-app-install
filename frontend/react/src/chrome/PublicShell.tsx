/**
 * Public shell (ADR 0027). A bare chrome for the anonymous CMS-driven front page:
 * brand header + sign-in, the page body, and the footer — NO Sidebar, NO admin
 * rail, NO auth gate. Rendered by App.tsx ABOVE <AppGate> so the marketing page
 * stays reachable even when a deployment runs a sign-in / password gate.
 */
import { Button } from '../ui/Button.js';
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmRoot } from '../ui/confirm.js';
import { ReauthRoot } from '../auth/ReauthRoot.js';
import { Toaster } from '../ui/toast.js';
import { GlobalLiveRegion } from '../ui/announce.js';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ErrorBoundary } from '../ui/ErrorBoundary.js';
import { useBrand } from '../brand/BrandProvider.js';
import { BrandLockup } from '../brand/BrandLockup.js';
import { SignInButton } from '../auth/SignInButton.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';
import { useDemoMode } from '../client/useDemoMode.js';
import { MenuIcon, XIcon } from '../ui/icons/index.js';
import { getDocsNav } from '../features/docs/docsClient.js';
import { SYSTEM_SITE_ORG } from '../features/cms/siteOrg.js';
import { config, fetchOpts } from '../client/config.js';
import { PRIVACY_HREF } from '../brand/privacyHref.js';
import { isInternalHref } from '../lib/internalHref.js';

/**
 * UX_UPGRADE-docs D-G4 — whether this deployment actually has published docs.
 * `/docs` is routed unconditionally, but the docs tier is tenant-toggle-gated
 * server-side, so a nav link must never point at an empty page. The public
 * nav read answers both questions at once (404 ⇒ docs off / unknown org ⇒ `[]`).
 *
 * Resolved ONCE per page load and shared by every caller: `PublicShell` wraps
 * public form fill, funnels, the storefront and e-sign too, and none of those
 * should pay for a second request. A failure resolves to "no docs" — a missing
 * link is a smaller harm than a link into nothing.
 */
let docsProbe: Promise<boolean> | null = null;
function useDocsAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    docsProbe ??= getDocsNav(SYSTEM_SITE_ORG).then((d) => (d?.length ?? 0) > 0).catch(() => false);
    void docsProbe.then((ok) => { if (live) setAvailable(ok); });
    return () => { live = false; };
  }, []);
  return available;
}

/**
 * ADR 1080 D13 — the Blog link, like Docs, is listed only when the site
 * publishes a post. `/blog` renders on every install, but an install that has
 * never posted would send visitors to an empty archive. One shared read per
 * page load; a failure hides the link, the smaller harm.
 */
let blogProbe: Promise<boolean> | null = null;
function useBlogAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    // A direct public read, not `features/site`'s client: the shell may import a
    // feature only through the registry (ADR 0630), and `site` has no id.
    blogProbe ??= fetch(`${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(SYSTEM_SITE_ORG)}/blog`)
      .then(async (res) => (res.ok ? ((await res.json()) as { posts?: unknown }).posts : null))
      .then((posts) => Array.isArray(posts) && posts.length > 0)
      .catch(() => false);
    void blogProbe.then((ok) => { if (live) setAvailable(ok); });
    return () => { live = false; };
  }, []);
  return available;
}

interface NavLink { to: string; label: string; description?: string }
/** ADR 1049 — the public-site nav groups, in render order. `pages` is the
 *  ADR 0486 catch-all for a published page that names no group. */
const NAV_GROUP_ORDER = ['product', 'audience', 'resources', 'trust', 'company', 'pages', 'legal'] as const;
type NavGroupId = (typeof NAV_GROUP_ORDER)[number];
/** The groups a page may NAME in its `siteNav` (server-validated, ADR 1049). */
const AUTHORED_GROUPS: ReadonlySet<string> = new Set(['product', 'audience', 'resources', 'trust', 'company', 'legal']);
interface NavGroup { id: NavGroupId; heading: string; links: NavLink[] }
interface NavEntry extends NavLink { group: NavGroupId; order: number; primary: boolean; cta?: string; utility?: boolean }

/**
 * Primary actions owned by a public page (for example, "Open app") belong in
 * the shell's command bar, not in a floating layer over published content. A
 * portal keeps that ownership boundary honest: the page decides which actions
 * exist, while PublicShell decides where public chrome is laid out.
 *
 * `undefined` is the deliberate standalone fallback used by focused component
 * tests and embeds that do not mount PublicShell. `null` means PublicShell is
 * present but its header ref has not committed yet, so nothing flashes in the
 * page body while the portal target is being established.
 */
const PublicHeaderActionsTarget = createContext<HTMLElement | null | undefined>(undefined);
const PublicMenuActionsTarget = createContext<HTMLElement | null | undefined>(undefined);

export function PublicHeaderActions({ children }: { children: ReactNode }): JSX.Element | null {
  const target = useContext(PublicHeaderActionsTarget);
  if (target === undefined) return <>{children}</>;
  return target ? createPortal(children, target) : null;
}

/** Lower-frequency, page-owned actions live in the navigation disclosure. */
export function PublicMenuActions({ children }: { children: ReactNode }): JSX.Element | null {
  const target = useContext(PublicMenuActionsTarget);
  if (target === undefined) return <>{children}</>;
  return target ? createPortal(children, target) : null;
}

/**
 * ADR 0486 — the published-pages probe. One shared read of the public-site NAV
 * list (`/public/{org}/pages` → published CMS pages, slug + title) so EVERY
 * published page is reachable from the home page WITHOUT a stale hard-coded
 * list. Resolved ONCE per page load (like {@link useDocsAvailable}); a failure
 * resolves to `[]` (the curated groups still render — a missing dynamic link is
 * a smaller harm than a request storm). Draft pages never appear (the endpoint
 * is published-only), so a link here can never point at an unpublished page.
 */
/** One row of the nav list. `nav` (ADR 1049) is the page's `siteNav`
 *  placement, absent when the page has none. */
interface PublishedPage {
  slug: string;
  title: string;
  nav?: { group?: Exclude<NavGroupId, 'pages'>; label?: string; description?: string; order?: number; primary?: boolean; cta?: string; utility?: boolean };
}

/** Defensive read of one `nav` value: the server validates it, but a stale or
 *  foreign deployment must not be able to break the chrome, so anything outside
 *  the known shape is dropped rather than rendered. */
function readNav(raw: unknown): PublishedPage['nav'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const nav: NonNullable<PublishedPage['nav']> = {};
  if (typeof r.group === 'string' && AUTHORED_GROUPS.has(r.group)) nav.group = r.group as Exclude<NavGroupId, 'pages'>;
  if (typeof r.label === 'string' && r.label.trim()) nav.label = r.label.trim();
  if (typeof r.description === 'string' && r.description.trim()) nav.description = r.description.trim();
  if (typeof r.order === 'number' && Number.isFinite(r.order)) nav.order = r.order;
  if (r.primary === true) nav.primary = true;
  // ADR 1056 — the grouped footer's call to action + bottom-bar utility links.
  if (typeof r.cta === 'string' && r.cta.trim()) nav.cta = r.cta.trim();
  if (r.utility === true) nav.utility = true;
  return Object.keys(nav).length > 0 ? nav : undefined;
}

/** ADR 1062 D2 — the mega menu's featured card, as the nav read returns it:
 *  the owning page's slug plus its `siteNav.featured`. `to` is resolved here
 *  (a `#fragment` href lands on the owning page), so the card never links off
 *  the site: the server only accepts a fragment or an internal path. */
interface FeaturedCard { to: string; eyebrow?: string; title: string; meta?: string }

function readFeatured(raw: unknown): FeaturedCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const title = s(r.title);
  const slug = s(r.slug);
  if (!title || !slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  const page = slug === 'home' ? '/' : `/p/${slug}`;
  const href = s(r.href);
  // Defensive like readNav, and as strict as the server: only the closed
  // fragment grammar or the shared internal-path check (which also refuses
  // `/\host` and control characters, both of which a browser can resolve
  // off-site). Anything else falls back to the owning page.
  const to = !href ? page : /^#[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(href) ? `${page}${href}` : isInternalHref(href) ? href : page;
  const eyebrow = s(r.eyebrow);
  const meta = s(r.meta);
  return { to, title, ...(eyebrow ? { eyebrow } : {}), ...(meta ? { meta } : {}) };
}

interface PublishedNav { pages: PublishedPage[]; featured: FeaturedCard | null }
const EMPTY_NAV: PublishedNav = { pages: [], featured: null };

let pagesProbe: Promise<PublishedNav> | null = null;
function usePublishedPages(): PublishedNav {
  const [nav, setNav] = useState<PublishedNav>(EMPTY_NAV);
  useEffect(() => {
    let live = true;
    pagesProbe ??= fetch(`${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(SYSTEM_SITE_ORG)}/pages`, fetchOpts({}))
      .then(async (r) => (r.ok ? ((await r.json()) as { pages?: unknown; featured?: unknown }) : {}))
      .then((body): PublishedNav => ({
        pages: Array.isArray(body.pages)
          ? (body.pages as { slug?: unknown; title?: unknown; nav?: unknown }[])
            .filter((p) => typeof p?.slug === 'string' && typeof p.title === 'string')
            .map((p) => {
              const nav = readNav(p.nav);
              return { slug: p.slug as string, title: p.title as string, ...(nav ? { nav } : {}) };
            })
          : [],
        featured: readFeatured(body.featured),
      }))
      .catch(() => EMPTY_NAV);
    void pagesProbe.then((next) => { if (live) setNav(next); });
    return () => { live = false; };
  }, []);
  return nav;
}

/** The order a page without `nav.order` takes: after every curated entry. */
const DEFAULT_PAGE_ORDER = 500;
const byOrderThenLabel = (a: NavEntry, b: NavEntry): number =>
  a.order - b.order || (a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0);
const groupRank = (g: NavGroupId): number => NAV_GROUP_ORDER.indexOf(g);

/** The public navigation model (ADR 0486, grouped by ADR 1049). ONE source so
 *  the menu and the footer never drift.
 *
 *  Every destination is one entry: each published CMS page (label = its
 *  `siteNav.label` or title; group = its `siteNav.group`, else Product for the
 *  curated `features`/`compare`/`white-label` slugs and Pages for the rest),
 *  plus the app routes `/pricing`, `/blog` and — when this deployment has
 *  published docs — `/docs`. Entries sort by `order` then label inside a group.
 *
 *  GROUPED MODE (ADR 1049) is on when at least one published page names a
 *  group: the groups render as Product, Who it's for, Trust, Company, Pages,
 *  Legal, and Blog moves to Company. A site whose pages carry no `siteNav`
 *  renders exactly the ADR 0486 Product + Pages menu. */
function usePublicNav(): { groups: NavGroup[]; flat: NavLink[]; primary: NavLink[]; grouped: boolean; cta: NavLink | null; utility: NavLink[]; featured: FeaturedCard | null; hasLink: (to: string) => boolean } {
  const { t } = useTranslation('chrome');
  const hasDocs = useDocsAvailable();
  const hasBlog = useBlogAvailable();
  const { pages: published, featured } = usePublishedPages();
  const grouped = published.some((p) => p.nav?.group !== undefined);
  const hasResources = published.some((p) => p.nav?.group === 'resources');
  // ADR 1062 D3 — `/pricing` renders the CMS `pricing` page when one is
  // published, so that page's `siteNav` (label, description, group, order,
  // primary, cta, utility) places the ONE `/pricing` entry. The slug stays
  // reserved, so there is never a second /p/pricing link.
  const pricingNav = published.find((p) => p.slug === 'pricing')?.nav;

  // The curated CMS pages (`features`, `compare`, `white-label`) are seeded
  // content, not routes: an adopter may archive or never publish them, and a
  // curated link must never point into a 404. So each is listed only when the
  // site org actually publishes it (the same published-only nav read) — it is
  // simply one of the published pages, with a curated label + position.
  // The white-label page is seeded only on the OpenWOP showcase (demo mode),
  // so a white-label install never shows a link to it.
  const curated: Record<string, { label: string; order: number }> = {
    features: { label: t('navFeatures'), order: 10 },
    compare: { label: t('navCompare'), order: 20 },
    'white-label': { label: t('navWhiteLabel'), order: 30 },
  };
  // `home` is the brand link; `pricing`/`blog`/`docs` are the reserved route
  // names (a CMS page slugged the same would otherwise read as a confusing
  // duplicate of the app route).
  const reservedSlugs = new Set(['home', 'pricing', 'blog', 'docs']);

  const entries: NavEntry[] = [
    ...published.filter((p) => !reservedSlugs.has(p.slug)).map((p): NavEntry => {
      const c = curated[p.slug];
      const description = p.nav?.description;
      return {
        to: `/p/${p.slug}`,
        label: p.nav?.label ?? c?.label ?? p.title,
        ...(description ? { description } : {}),
        group: p.nav?.group ?? (c ? 'product' : 'pages'),
        order: p.nav?.order ?? c?.order ?? DEFAULT_PAGE_ORDER,
        primary: p.nav?.primary === true,
        ...(p.nav?.cta ? { cta: p.nav.cta } : {}),
        ...(p.nav?.utility ? { utility: true } : {}),
      };
    }),
    // `/pricing` is an app route that renders on every install, so it stays
    // unconditional. `/blog` waits for a published post (ADR 1080 D13).
    {
      to: '/pricing',
      label: pricingNav?.label ?? t('navPricing'),
      ...(pricingNav?.description ? { description: pricingNav.description } : {}),
      group: pricingNav?.group ?? 'product',
      order: pricingNav?.order ?? 40,
      primary: pricingNav?.primary === true,
      ...(pricingNav?.cta ? { cta: pricingNav.cta } : {}),
      ...(pricingNav?.utility ? { utility: true } : {}),
    },
    // The automatic `/blog` entry sits under Resources when the site has that
    // group (a blog is a resource), else under Company as before (ADR 1049).
    ...(hasBlog ? [{ to: '/blog', label: t('navBlog'), group: !grouped ? 'product' as const : hasResources ? 'resources' as const : 'company' as const, order: 50, primary: false }] : []),
    ...(hasDocs ? [{ to: '/docs', label: t('navDocs'), group: 'product' as const, order: 60, primary: false }] : []),
  ];

  const headings: Record<NavGroupId, string> = {
    product: t('navGroupProduct'),
    audience: t('navGroupAudience'),
    resources: t('navGroupResources'),
    trust: t('navGroupTrust'),
    company: t('navGroupCompany'),
    pages: t('navGroupPages'),
    legal: t('navGroupLegal'),
  };
  const toLink = ({ to, label, description }: NavEntry): NavLink => ({ to, label, ...(description ? { description } : {}) });
  const groups: NavGroup[] = NAV_GROUP_ORDER
    .map((id) => ({ id, heading: headings[id], links: entries.filter((e) => e.group === id).sort(byOrderThenLabel).map(toLink) }))
    .filter((g) => g.links.length > 0);

  // Keep the decision-making links visible on wide screens. By default that is
  // Features and Pricing — the two questions most first-time visitors ask
  // before they are willing to open a menu. A site that flags pages
  // `siteNav.primary` (ADR 1049) chooses its own, always with Pricing.
  // Mobile keeps the compact disclosure.
  const flagged = entries.some((e) => e.primary);
  const primary = (flagged
    ? entries.filter((e) => e.primary || e.to === '/pricing').sort((a, b) => groupRank(a.group) - groupRank(b.group) || byOrderThenLabel(a, b))
    : entries.filter((e) => e.group === 'product' && (e.to === '/p/features' || e.to === '/pricing')).sort(byOrderThenLabel)
  ).map(toLink);
  // ADR 1056 — the grouped footer's call to action is the first page (group,
  // then order) that sets `siteNav.cta`; its label is the button text. Utility
  // pages also fill the footer's bottom bar, in the same order. Both are
  // grouped-mode only, so an ungrouped site's footer is unchanged.
  const ranked = [...entries].sort((a, b) => groupRank(a.group) - groupRank(b.group) || byOrderThenLabel(a, b));
  const ctaEntry = grouped ? ranked.find((e) => e.cta) : undefined;
  const cta = ctaEntry?.cta ? { to: ctaEntry.to, label: ctaEntry.cta } : null;
  const utility = grouped ? ranked.filter((e) => e.utility).map(({ to, label }) => ({ to, label })) : [];
  return { groups, flat: groups.flatMap((g) => g.links), primary, grouped, cta, utility, featured: grouped ? featured : null, hasLink: (to) => entries.some((e) => e.to === to) };
}

/**
 * ADR 0486 — the public hamburger menu. ONE disclosure at ALL viewports (it
 * replaces the split desktop-nav + mobile-only menu) that opens a GROUPED panel
 * reaching main functionality + every published child page. WAI disclosure
 * pattern: `aria-expanded` + `aria-controls` (no `aria-haspopup` — that role
 * semantics is for menus, not a disclosure nav); Esc and outside-click close
 * and return focus to the button; links are tab-stops. The accessible name is
 * the VISIBLE "Menu" label (WCAG 2.5.3 label-in-name — SITE-R2-8); open/closed
 * state rides `aria-expanded`, not the name.
 */
function PublicMenu({ groups, mega, featured, setPageActionsTarget }: {
  groups: NavGroup[];
  /** ADR 1062 D2 — the grouped panel's featured card (grouped mode only). */
  featured: FeaturedCard | null;
  /** ADR 1049 grouped mode: the panel becomes a multi-column mega menu and each
   *  link shows its one-line description. */
  mega: boolean;
  setPageActionsTarget: (target: HTMLDivElement | null) => void;
}): JSX.Element {
  const { t } = useTranslation('chrome');
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); }
    };
    const onPointer = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  return (
    <div className={mega ? 'public-menu public-menu--mega' : 'public-menu'}>
      <Button
        ref={btnRef}
        variant="quiet" size="sm" className="public-menu__btn"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t('navMenu')}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <XIcon size={18} /> : <MenuIcon size={18} />}
        <span className="public-menu__label">{t('navMenu')}</span>
      </Button>
      <nav ref={panelRef} id={menuId} className={mega ? 'public-menu__panel public-menu__panel--mega' : 'public-menu__panel'} aria-label={t('publicNavLabel')} hidden={!open}>
        {groups.map((g) => (
          <div key={g.id} className="public-menu__group">
            <p className="public-menu__heading">{g.heading}</p>
            {g.links.map((l) => (
              <Link key={l.to} className="public-menu__link" to={l.to} onClick={() => setOpen(false)}>
                {l.label}
                {mega && l.description ? <>{' '}<span className="public-menu__desc">{l.description}</span></> : null}
              </Link>
            ))}
          </div>
        ))}
        {featured ? (
          <Link className="public-menu__featured" to={featured.to} onClick={() => setOpen(false)}>
            {featured.eyebrow ? <span className="public-menu__featured-eyebrow">{featured.eyebrow}</span> : null}
            <span className="public-menu__featured-title">{featured.title}</span>
            {featured.meta ? <span className="public-menu__featured-meta">{featured.meta}</span> : null}
          </Link>
        ) : null}
        {/* ADR 1062 D1 — the utilities close the panel: navigation first, then
            the theme, language and page actions ("Edit this page") as one row. */}
        <div className="public-menu__footer">
          <div className="public-menu__utilities">
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
          {/* On a phone the account button moves in here, so the header's
              wordmark keeps its full width (CSS shows exactly one of the two). */}
          <div className="public-menu__signin"><SignInButton /></div>
          <div ref={setPageActionsTarget} className="public-menu__page-actions" />
        </div>
      </nav>
    </div>
  );
}

export function PublicShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation('chrome');
  const brand = useBrand(); // live runtime brand (ADR 0170)
  const { groups, flat, primary, grouped, cta, utility, featured, hasLink } = usePublicNav();
  // ADR 1049 — Legal is footer-only: policies are reachable, not promoted.
  const menuGroups = groups.filter((g) => g.id !== 'legal');
  // The privacy link is always reachable from the footer. In grouped mode it
  // joins the Legal column, unless a published page already links there.
  const privacyLink: NavLink = { to: PRIVACY_HREF, label: t('common:privacy') };
  const privacyListed = hasLink(PRIVACY_HREF);
  const footerGroups = grouped && !privacyListed
    ? groups.map((g) => (g.id === 'legal' ? { ...g, links: [...g.links, privacyLink] } : g))
    : groups;
  // With no Legal column, the privacy link closes the bottom bar instead.
  const privacyTrailing = grouped && !privacyListed && !groups.some((g) => g.id === 'legal');
  const bottomLinks = privacyTrailing ? [...utility, privacyLink] : utility;
  // "Read the spec ↗" + "Explore the demo →" are OpenWOP-showcase chrome
  // (ADR 0196 Gate A / DEMO-7): a white-label install's public page must not
  // invite visitors to "explore the demo" or point at openwop.dev.
  const demo = useDemoMode();
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLDivElement | null>(null);
  const [menuActionsTarget, setMenuActionsTarget] = useState<HTMLDivElement | null>(null);
  return (
    <PublicHeaderActionsTarget.Provider value={headerActionsTarget}>
      <PublicMenuActionsTarget.Provider value={menuActionsTarget}>
        <div className="public-shell">
          <a className="skip-link" href="#public-main">{t('common:skipToContent')}</a>
          <header className="public-shell-header">
            <div className={grouped ? 'public-shell-header__inner public-shell-header__inner--mega' : 'public-shell-header__inner'}>
              <Link to="/" className="public-shell-brand" aria-label={brand.productName}>
                <BrandLockup
                  brand={brand}
                  lockupClassName="public-shell-lockup"
                  markClassName="public-shell-logo"
                  productClassName="app-gate-product"
                />
              </Link>
              {primary.length > 0 ? (
                <nav className="public-primary-nav" aria-label={t('publicPrimaryNavLabel')}>
                  {/* ADR 1062 D1 — NavLink marks the current page (`aria-current="page"`). */}
                  {primary.map((link) => (
                    <NavLink key={link.to} className="public-primary-nav__link" to={link.to} end>{link.label}</NavLink>
                  ))}
                </nav>
              ) : null}
              {/* One ordered command bar: navigation, primary page action, account.
                  Theme + locale live inside the navigation disclosure at every
                  viewport so utilities never crowd out the primary task. */}
              <div className="public-shell-actions">
                <PublicMenu groups={menuGroups} mega={grouped} featured={featured} setPageActionsTarget={setMenuActionsTarget} />
                {demo && <a className="chip public-shell-demochip" href={brand.homeUrl} rel="noopener noreferrer">{t('readTheSpec')}</a>}
                {demo && <Link className="chip public-shell-demochip" to="/chat">{t('exploreTheDemo')}</Link>}
                <div ref={setHeaderActionsTarget} className="public-shell-page-actions" />
                {/* ADR 1062 D1 — the site's call to action (the same `siteNav.cta`
                    page the footer's button names) is always visible in grouped mode. */}
                {cta ? <Link className="btn public-shell-cta" to={cta.to}>{cta.label}</Link> : null}
                <div className="public-shell-signin"><SignInButton /></div>
              </div>
            </div>
          </header>
          <main id="public-main" className="public-shell-main">
            {/* A render throw in ANY public page (e.g. a wire shape the client didn't
                guard) is contained to an error card INSIDE the shell chrome — never a
                full white screen for an anonymous visitor. The authed shell has the
                same boundary; the public shell was the gap that made the pricing '*'
                crash a blank page. Resets on navigation. */}
            <ErrorBoundary resetKey={useLocation().pathname} label="public">
              {children}
            </ErrorBoundary>
          </main>
          {/* R2 CRMPUB2-7 (UX_UPGRADE-crm-public) — the public surfaces use the
              designed confirm + toasts too: without these mounts, `confirm()` fell
              back to native window.confirm (off-brand, unlocalized button) on the
              booking cancel, and public toasts went nowhere. */}
          <ConfirmRoot />
          <ReauthRoot />
          <Toaster />
          {/* FRMUX-1 / ADR 0648 — the ONE live region. It was mounted only in the
              authed tree (`App.tsx`, below the `showPublic` early return), so on every
              public surface `Notice announce=…`, `StateCard announce=…` and every toast
              wrote to a listener set that was EMPTY — and `Notice` deliberately strips
              its own `role` when delegating, so this was a removal, not a fallback. A
              screen-reader user refused on the app's only internet-facing form was told
              nothing. `ui/Notice.tsx`'s premise ("mounted once at App.tsx, so it exists
              long before any message") was false here. */}
          <GlobalLiveRegion />
          {/* SITE-R2-9 — a real footer NAV landmark (list semantics, separators in
              CSS not content) so SR users can jump to it and never hear "dot"
              between links. Same `usePublicNav()` source as the header menu, so a
              page can never appear in one place and not the other (ADR 0486). */}
          {/* ADR 1049 — in grouped mode the footer is one column per group,
              Legal included (the only place Legal appears). ADR 1056 — a brand
              column leads (mark + name, the footer text, the site's call to
              action) and a bottom bar closes it (copyright + utility links). */}
          {grouped ? (
            <footer className="app-footer app-footer--grouped">
              <div className="app-footer__top">
                <div className="app-footer__brand-col">
                  <Link to="/" className="app-footer__home" aria-label={brand.productName}>
                    <BrandLockup
                      brand={brand}
                      lockupClassName="app-footer__lockup"
                      markClassName="app-footer__mark"
                      productClassName="app-footer__name"
                    />
                  </Link>
                  {brand.footerText ? <p className="app-footer__brand">{brand.footerText}</p> : null}
                  {cta ? <Link className="btn app-footer__cta" to={cta.to}>{cta.label}</Link> : null}
                </div>
                <nav className="app-footer__nav" aria-label={t('footerNavLabel')}>
                  <div className="app-footer__groups">
                    {footerGroups.map((g) => (
                      <div key={g.id} className={g.id === 'legal' ? 'app-footer__group app-footer__group--legal' : 'app-footer__group'}>
                        <h2 className="app-footer__heading">{g.heading}</h2>
                        <ul className="app-footer__group-links">
                          {g.links.map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                </nav>
              </div>
              <div className="app-footer__bottom">
                {/* ADR 1062 D5 — the brand's `chromePolicy.customCopyright`, when set,
                    replaces the generated line (it is published brand content). */}
                <p className="app-footer__copyright">{brand.customCopyright || t('footerCopyright', { year: new Date().getFullYear(), name: brand.productName })}</p>
                {bottomLinks.length > 0 ? (
                  <nav aria-label={t('footerUtilityNavLabel')}>
                    <ul className="app-footer__utility">
                      {bottomLinks.map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}
                    </ul>
                  </nav>
                ) : null}
              </div>
            </footer>
          ) : (
            <footer className="app-footer">
              {brand.footerText ? <span className="app-footer__brand">{brand.footerText}</span> : null}
              <nav aria-label={t('footerNavLabel')}>
                <ul className="app-footer__links">
                  {flat.map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}
                  <li><Link to={PRIVACY_HREF}>{t('common:privacy')}</Link></li>
                </ul>
              </nav>
            </footer>
          )}
        </div>
      </PublicMenuActionsTarget.Provider>
    </PublicHeaderActionsTarget.Provider>
  );
}
