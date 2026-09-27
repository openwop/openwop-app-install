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
import { Toaster } from '../ui/toast.js';
import { GlobalLiveRegion } from '../ui/announce.js';
import { Link, useLocation } from 'react-router-dom';
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

interface NavLink { to: string; label: string }
interface NavGroup { id: string; heading: string; links: NavLink[] }

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
let pagesProbe: Promise<NavLink[]> | null = null;
function usePublishedPages(): NavLink[] {
  const [pages, setPages] = useState<NavLink[]>([]);
  useEffect(() => {
    let live = true;
    pagesProbe ??= fetch(`${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(SYSTEM_SITE_ORG)}/pages`, fetchOpts({}))
      .then(async (r) => (r.ok ? ((await r.json()) as { pages?: { slug: string; title: string }[] }).pages ?? [] : []))
      .then((list) => (Array.isArray(list) ? list.map((p) => ({ to: `/p/${p.slug}`, label: p.title })) : []))
      .catch(() => []);
    void pagesProbe.then((list) => { if (live) setPages(list); });
    return () => { live = false; };
  }, []);
  return pages;
}

/** The public navigation model (ADR 0486). ONE source so the hamburger menu and
 *  the footer never drift. Two groups: MAIN FUNCTIONALITY (curated product
 *  destinations — Docs only when this deployment has published docs) and PAGES
 *  (every OTHER published CMS page, resolved live — the "all pages reachable"
 *  guarantee). The curated slugs are excluded from the dynamic group so a page
 *  never appears twice. */
function usePublicNav(): { groups: NavGroup[]; flat: NavLink[]; primary: NavLink[] } {
  const { t } = useTranslation('chrome');
  const hasDocs = useDocsAvailable();
  const published = usePublishedPages();

  const product: NavLink[] = [
    { to: '/p/features', label: t('navFeatures') },
    { to: '/p/compare', label: t('navCompare') },
    { to: '/pricing', label: t('navPricing') },
    { to: '/blog', label: t('navBlog') },
    ...(hasDocs ? [{ to: '/docs', label: t('navDocs') }] : []),
  ];
  // Slugs already surfaced above — dropped from the dynamic group so nothing
  // lists twice. `home` is the brand link; `features`/`compare` are the curated
  // `/p/:slug` entries; `pricing`/`blog`/`docs` are the reserved route names (a
  // CMS page slugged the same would otherwise read as a confusing duplicate).
  const curatedSlugs = new Set(['home', 'features', 'compare', 'pricing', 'blog', 'docs']);
  const morePages = published.filter((l) => !curatedSlugs.has(l.to.replace(/^\/p\//, '')));

  const groups: NavGroup[] = [
    { id: 'product', heading: t('navGroupProduct'), links: product },
    ...(morePages.length > 0 ? [{ id: 'pages', heading: t('navGroupPages'), links: morePages }] : []),
  ];
  // Keep the decision-making links visible on wide screens. Compare and Blog
  // remain in the disclosure: they are valuable research destinations, but
  // Features and Pricing answer the two questions most first-time visitors ask
  // before they are willing to open a menu. Mobile keeps the compact disclosure.
  const primary = product.filter((link) => link.to === '/p/features' || link.to === '/pricing');
  return { groups, flat: groups.flatMap((g) => g.links), primary };
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
function PublicMenu({ groups, setPageActionsTarget }: {
  groups: NavGroup[];
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
    <div className="public-menu">
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
      <nav ref={panelRef} id={menuId} className="public-menu__panel" aria-label={t('publicNavLabel')} hidden={!open}>
        <div className="public-menu__utilities">
          <ThemeToggle />
          <LanguageSwitcher />
        </div>
        <div ref={setPageActionsTarget} className="public-menu__page-actions" />
        {groups.map((g) => (
          <div key={g.id} className="public-menu__group">
            <p className="public-menu__heading">{g.heading}</p>
            {g.links.map((l) => (
              <Link key={l.to} className="public-menu__link" to={l.to} onClick={() => setOpen(false)}>{l.label}</Link>
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}

export function PublicShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation('chrome');
  const brand = useBrand(); // live runtime brand (ADR 0170)
  const { groups, flat, primary } = usePublicNav();
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
            <div className="public-shell-header__inner">
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
                  {primary.map((link) => (
                    <Link key={link.to} className="public-primary-nav__link" to={link.to}>{link.label}</Link>
                  ))}
                </nav>
              ) : null}
              {/* One ordered command bar: navigation, primary page action, account.
                  Theme + locale live inside the navigation disclosure at every
                  viewport so utilities never crowd out the primary task. */}
              <div className="public-shell-actions">
                <PublicMenu groups={groups} setPageActionsTarget={setMenuActionsTarget} />
                {demo && <a className="chip public-shell-demochip" href={brand.homeUrl} rel="noopener noreferrer">{t('readTheSpec')}</a>}
                {demo && <Link className="chip public-shell-demochip" to="/chat">{t('exploreTheDemo')}</Link>}
                <div ref={setHeaderActionsTarget} className="public-shell-page-actions" />
                <SignInButton />
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
          <footer className="app-footer">
            {brand.footerText ? <span className="app-footer__brand">{brand.footerText}</span> : null}
            <nav aria-label={t('footerNavLabel')}>
              <ul className="app-footer__links">
                {flat.map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}
                <li><Link to="/privacy">{t('common:privacy')}</Link></li>
              </ul>
            </nav>
          </footer>
        </div>
      </PublicMenuActionsTarget.Provider>
    </PublicHeaderActionsTarget.Provider>
  );
}
