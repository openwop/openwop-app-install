/**
 * Site shell (ADR 0641). The "public side of the app" — product surfaces at
 * clean root URLs (`/today`, `/discover`), free of console chrome, WITH a
 * product nav.
 *
 * Deliberately NOT `PublicShell` and deliberately NOT the workspace shell:
 *
 *  - `PublicShell` (ADR 0027) carries no nav by design — "a `public` route
 *    carries no `nav` (it is not a menu item)" — and renders strictly above
 *    <AppGate>. It cannot host a signed-in, session-bearing surface.
 *  - The workspace shell carries the <Sidebar> rail, <VendorSetupPrompt>,
 *    <AutoSeedExampleData> and <InMemoryHostBanner>. ADR 0641 decision 3 states
 *    the requirement concretely: *"a participant at `/today` must not receive a
 *    vendor-setup prompt."*
 *
 * David's framing settled why one shell serves routes with DIFFERENT auth
 * requirements: all six KickTodo surfaces are "on the public side of the app,
 * not the private side" regardless of whether each needs a session. So the tier
 * picks the shell; the per-route `auth` posture decides only whether <AppGate>
 * wraps it. A signed-in, participant-scoped Leaderboard is still a site surface.
 *
 * CHROME CLASSES ARE REUSED FROM `.public-shell*`, not forked. They already
 * express exactly this: sticky brand header, flex column, `flex:1` main. A
 * parallel `.site-shell*` family would duplicate the tokens, and
 * `check-orphan-classes` / `check-css-tokens` would be carrying two owners of
 * one visual contract. The only addition is the nav strip.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmRoot } from '../ui/confirm.js';
import { Toaster } from '../ui/toast.js';
import { GlobalLiveRegion } from '../ui/announce.js';
import { ErrorBoundary } from '../ui/ErrorBoundary.js';
import { useBrand } from '../brand/BrandProvider.js';
import { BrandLockup } from '../brand/BrandLockup.js';
import { SignInButton } from '../auth/SignInButton.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';
import { useResolvedNav } from './navConfig/NavConfigProvider.js';
import { Button } from '../ui/Button.js';

/**
 * The phone rail is deliberately smaller than the desktop rail. These are the
 * five repeat-use participant destinations; every other enabled `site` route
 * remains manifest-derived and is exposed by the More disclosure. Labels,
 * icons, feature gates, and destinations still come from `FEATURES` — this list
 * owns only the mobile information hierarchy.
 */
const MOBILE_PRIMARY_PATHS = ['/today', '/discover', '/plan', '/progress', '/guide'] as const;

/**
 * The site nav strip.
 *
 * Drawn from `useResolvedNav().site` — the same `FEATURES` manifest the
 * workspace rail reads, through the same toggle `access()` gate. That is ADR
 * 0641's withdrawal of `cms.menu` made concrete: menu membership is DERIVED
 * from toggle resolution rather than stored a second time.
 *
 * Renders nothing when the rail is empty. An empty <nav> landmark is worse than
 * no landmark — a screen-reader user tabs into a navigation region containing
 * nothing.
 */
function SiteNav(): JSX.Element | null {
  const { site } = useResolvedNav();
  const { t: tn } = useTranslation('nav');
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const morePanelRef = useRef<HTMLDivElement>(null);
  const morePanelId = useId();
  const items = site.flatMap((g) => g.items);
  const byPath = new Map(items.map((item) => [item.to, item] as const));
  const mobilePrimary = MOBILE_PRIMARY_PATHS.flatMap((path) => {
    const item = byPath.get(path);
    return item ? [item] : [];
  });
  const primaryPaths = new Set<string>(mobilePrimary.map((item) => item.to));
  const mobileMore = items.filter((item) => !primaryPaths.has(item.to));

  useEffect(() => { setMoreOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    morePanelRef.current?.querySelector<HTMLElement>('a, button, select')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const panelFocusable = Array.from(
        morePanelRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled])') ?? [],
      );
      const toggle = moreButtonRef.current;
      const first = panelFocusable[0];
      const last = panelFocusable[panelFocusable.length - 1];
      if (!toggle || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        toggle.focus();
      } else if (event.shiftKey && document.activeElement === toggle) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        toggle.focus();
      } else if (!event.shiftKey && document.activeElement === toggle) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointer = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (moreButtonRef.current?.contains(target) || morePanelRef.current?.contains(target)) return;
      setMoreOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [moreOpen]);

  const labelOf = (item: (typeof items)[number]): string =>
    item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label;
  const isItemActive = (item: (typeof items)[number]): boolean => (
    item.end || item.to === '/' ? location.pathname === item.to : location.pathname.startsWith(item.to)
  );
  const activeItem = items.find((item) => (
    isItemActive(item)
  ));

  if (items.length === 0) return null;

  return (
    <>
      <nav className="site-nav site-nav--desktop" aria-label={tn('siteNavLabel')}>
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end ?? false}
            className={({ isActive }) => (isActive ? 'site-nav-link is-active' : 'site-nav-link')}
          >
            {labelOf(it)}
          </NavLink>
        ))}
      </nav>

      <div className="site-mobile-nav">
        <span className="sr-only" aria-live="polite">
          {activeItem ? tn('siteNavCurrent', { label: labelOf(activeItem) }) : ''}
        </span>
        <nav className="site-mobile-nav__primary" aria-label={tn('siteNavLabel')}>
          {mobilePrimary.map((it) => {
            const Icon = it.icon;
            return (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.end ?? false}
                className={({ isActive }) => (isActive ? 'site-mobile-nav__item is-active' : 'site-mobile-nav__item')}
              >
                <Icon size={19} aria-hidden />
                <span>{labelOf(it)}</span>
              </NavLink>
            );
          })}
          {mobileMore.length > 0 ? (
            <Button
              ref={moreButtonRef}
              variant="quiet"
              className={moreOpen || mobileMore.some(isItemActive)
                ? 'site-mobile-nav__item is-active'
                : 'site-mobile-nav__item'}
              aria-expanded={moreOpen}
              aria-controls={morePanelId}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <span className={moreOpen ? 'site-mobile-nav__menu-glyph is-open' : 'site-mobile-nav__menu-glyph'} aria-hidden />
              <span>{tn('siteNavMore')}</span>
            </Button>
          ) : null}
        </nav>
        {moreOpen ? (
          <div ref={morePanelRef} id={morePanelId} className="site-mobile-nav__panel">
            <p className="site-mobile-nav__heading">{tn('siteNavMore')}</p>
            <nav className="site-mobile-nav__more" aria-label={tn('siteNavMoreLabel')}>
              {mobileMore.map((it) => {
                const Icon = it.icon;
                return (
                  <NavLink key={it.to} to={it.to} className="site-mobile-nav__more-link">
                    <Icon size={18} aria-hidden />
                    <span>{labelOf(it)}</span>
                  </NavLink>
                );
              })}
            </nav>
            <div className="site-mobile-nav__locale"><LanguageSwitcher /></div>
          </div>
        ) : null}
      </div>
    </>
  );
}

export function SiteShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation('chrome');
  const brand = useBrand();
  const location = useLocation();
  return (
    <div className="public-shell site-shell">
      <a className="skip-link" href="#site-main">{t('common:skipToContent')}</a>
      <header className="public-shell-header">
        <Link to="/" className="public-shell-brand" aria-label={brand.productName}>
          <BrandLockup
            brand={brand}
            lockupClassName="public-shell-lockup"
            markClassName="public-shell-logo"
            productClassName="app-gate-product"
          />
        </Link>
        <SiteNav />
        <div className="public-shell-actions">
          <ThemeToggle />
          <div className="site-header-language"><LanguageSwitcher /></div>
          {/* Session-bearing under BOTH postures. On `auth: 'optional'` an
              anonymous visitor sees the sign-in affordance (the funnel's whole
              point); a signed-in one sees their account chrome. SignInButton
              already branches on session state, so no posture plumbing here. */}
          <SignInButton />
        </div>
      </header>
      <main id="site-main" className="public-shell-main" tabIndex={-1}>
        {/* Reset on navigation: a thrown route must not strand the shell. */}
        <ErrorBoundary resetKey={location.pathname} label="site">
          {children}
        </ErrorBoundary>
      </main>
      <GlobalLiveRegion />
      <Toaster />
      <ConfirmRoot />
    </div>
  );
}
