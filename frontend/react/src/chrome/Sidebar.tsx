import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { setNavSource } from './navSource.js';
import { BrandLogo } from '../brand/BrandLogo.js';
import { BrandLockup } from '../brand/BrandLockup.js';
import { useBrand } from '../brand/BrandProvider.js';
import { SignInButton } from '../auth/SignInButton.js';
import { useAccountPresence } from '../auth/accountPresence.js';
import { NotificationBell } from '../notifications/NotificationBell.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon, SearchIcon, SettingsIcon } from '../ui/icons/index.js';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { A11yPrefsControl } from '../ui/A11yPrefsControl.js';
import { navItemIsActive, GROUP_LABEL_KEYS } from './features.js';
import { IconButton } from '../ui/IconButton.js';
import { useFocusTrap } from '../ui/useFocusTrap.js';
import { isAdminPath } from './features.js';
import { useFeatureAccess, useFeatureBadge, useFeatureLocked } from '../featureToggles/FeatureAccessContext.js';
import { isAdminCaller, useEffectiveAccess } from '../client/useEffectiveAccess.js';
import { useResolvedNav } from './navConfig/NavConfigProvider.js';
import { readExpandedHeaders, toggleExpandedHeader } from './navConfig/navCollapseCookie.js';
import { AgentsNavItem } from './PinnedAgentsNav.js';
import { NavRailItemContent, NavRailSection } from './NavRailPrimitives.js';

const COLLAPSE_KEY = 'openwop.sidebar.collapsed';

export function Sidebar({ netOpen, onToggleNet }: { netOpen: boolean; onToggleNet: () => void }): JSX.Element {
  const { t } = useTranslation('chrome');
  const { t: tn } = useTranslation('nav');
  const brand = useBrand();
  const location = useLocation();
  const badgeFor = useFeatureBadge();
  const lockedFor = useFeatureLocked();
  const STORE = '/marketplace/bundles'; // ADR 0419 — where a locked feature upsells
  // Gate B (ADR 0196): the network-inspector button is an engineering surface —
  // hidden entirely unless the `developer-tools` toggle resolves enabled.
  const devTools = useFeatureAccess('developer-tools');
  // ADM-8 (ADR 0196 Phase 4): the caller's effective access gates admin chrome.
  const access = useEffectiveAccess();
  // Accessibility + language moved INTO the account menu; the footer keeps
  // them only as a fallback when no account menu is showing (signed-out /
  // Firebase-unconfigured — the demo host's anonymous visitors). `null`
  // (still resolving) renders neither placement, so nothing flashes.
  const accountPresent = useAccountPresence();
  // The effective workspace rail (ADR 0139): the declared nav overlaid with the
  // tenant+user menu config and already feature-gated by `resolveNav` (a
  // toggled-off feature never appears). Empty groups are dropped there too.
  // Notifications is CORE platform infrastructure (the toggle was removed
  // 2026-06-11 — docs/adr/0010-notifications.md § Correction), so the header
  // bell always shows; per-user preferences are the control.
  const { workspace: navGroups } = useResolvedNav();
  // The phone bar is an adaptive projection of the effective Pinned group,
  // never a second catalog. Tenant/user menu overrides, feature gating, labels,
  // and ordering therefore stay authoritative. Four destinations leave one
  // stable slot for More, which opens the complete, focus-trapped drawer.
  const mobilePrimary = navGroups.find((group) => group.headerless)?.items.slice(0, 4) ?? [];
  // Per-section collapse (ADR 0139, inverted 2026-07-06: collapsed by default) —
  // explicit expansions remembered per browser in a cookie, keyed by the stable
  // header id (survives renames). The group holding the active route is revealed
  // in STATE (mount seed + the navigation effect below) rather than forced open
  // at render, so a deep link never hides the current page's item yet the user
  // can still collapse that group; the reveal never writes the cookie.
  const activeGroupId = (): string | undefined =>
    navGroups.find((g) => g.items.some((item) => navItemIsActive(item, location.pathname)))?.id;
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => {
    const ids = readExpandedHeaders();
    const active = activeGroupId();
    if (active) ids.add(active);
    return ids;
  });
  const toggleSection = (id: string) => setExpandedSections(toggleExpandedHeader(id));
  useEffect(() => {
    const active = activeGroupId();
    if (!active) return;
    setExpandedSections((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeGroupId derives from these two
  }, [location.pathname, navGroups]);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  // Mobile: the rail is an off-canvas drawer; close it on every route change.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  // SHELL-1 — while the mobile drawer is open it is a modal surface: trap focus
  // inside it (+ restore to the More trigger on close, both via useFocusTrap) and
  // close on Escape. Inactive on desktop (drawerOpen is always false there).
  const drawerRef = useFocusTrap<HTMLElement>(drawerOpen);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  return (
    <>
      <nav className="app-mobile-nav" aria-label={t('mobileQuickAccess')}>
        {mobilePrimary.map((item) => {
          const Icon = item.icon;
          const active = navItemIsActive(item, location.pathname);
          const locked = lockedFor(item.featureId);
          const label = item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label;
          return (
            <Link
              key={item.to}
              to={locked ? STORE : item.to}
              className={`app-mobile-nav__item${active && !locked ? ' is-active' : ''}`}
              onClick={() => setNavSource('sidebar')}
              {...(active && !locked ? { 'aria-current': 'page' as const } : {})}
              title={locked ? t('navLocked') : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          );
        })}
        <Button
          variant="quiet"
          className={`app-mobile-nav__item${drawerOpen ? ' is-active' : ''}`}
          aria-expanded={drawerOpen}
          aria-controls="app-primary-navigation"
          onClick={() => setDrawerOpen(true)}
        >
          <MoreHorizontalIcon size={18} />
          <span>{t('mobileMore')}</span>
        </Button>
      </nav>
      {drawerOpen && <div className="app-sidebar-scrim" onClick={() => setDrawerOpen(false)} aria-hidden />}

      <aside
        id="app-primary-navigation"
        ref={drawerRef}
        className={`app-sidebar${collapsed ? ' is-collapsed' : ''}${drawerOpen ? ' is-open' : ''}`}
        aria-label={t('primary')}
        {...(drawerOpen ? { role: 'dialog' as const, 'aria-modal': true } : {})}
      >
        <div className="app-sidebar-context">
          <div className="app-sidebar-head">
            {/* ADR 0487 — the in-app brand goes to the Dashboard's own URL ('/'
                is the public marketing home; a bare '/' would only redirect here).
                Render the resolved product name as one identity instead of rebuilding
                it from brandMark.pre/emphasis/sub: `sub` is a descriptor for the
                stock brand, but some distributions historically used it to finish
                their name, which split the wordmark across two lines. */}
            <Link
              to="/dashboard"
              className="app-sidebar-brand"
              aria-label={t('brandHome', { productName: brand.productName })}
            >
              <span className="app-sidebar-brand-expanded">
                <BrandLockup
                  brand={brand}
                  lockupClassName="app-sidebar-brand-lockup"
                  markClassName="app-sidebar-brand-logo"
                  productClassName="app-sidebar-product"
                />
              </span>
              <span className="app-sidebar-brand-compact" aria-hidden="true">
                <BrandLogo
                  src={brand.markSrc}
                  srcDark={brand.markSrcDark || undefined}
                  imgClassName="app-sidebar-brand-logo"
                />
              </span>
            </Link>
            <IconButton
              className="app-sidebar-collapse"
              label={collapsed ? t('expandNavigation') : t('collapseNavigation')}
              aria-pressed={collapsed}
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? t('expand') : t('collapse')}
              icon={collapsed ? <ChevronRightIcon size={16} /> : <ChevronLeftIcon size={16} />}
            />
          </div>

          {/* Workspace switcher (ADR 0015 — workspace-as-tenant): lists the
              caller's workspaces, switches the active one, creates new ones.
              Falls back to a static link to /orgs before workspaces load. */}
          <WorkspaceSwitcher />
        </div>

        {/* Discoverable entry to the ⌘K command palette (the hotkey also works
            globally). Dispatches a custom event the palette listens for. */}
        <button
          type="button"
          className="app-cmdk-trigger"
          onClick={() => window.dispatchEvent(new Event('openwop:cmdk'))}
          title={t('cmdkTrigger')}
        >
          <span className="app-cmdk-icon" aria-hidden><SearchIcon size={15} /></span>
          <span className="app-cmdk-label">{t('common:search')}…</span>
          <kbd className="app-cmdk-kbd" aria-hidden>⌘K</kbd>
        </button>

        <nav className="app-sidebar-nav" aria-label={t('sections')}>
          {navGroups.map((group) => {
            const title = group.custom ? group.label : tn(GROUP_LABEL_KEYS[group.id] ?? '', { defaultValue: group.label });
            // Header-less groups (the pinned Chat/Inbox/Agents cluster) render
            // flush and always-expanded — no toggle, never collapsed.
            const sectionCollapsed = group.headerless ? false : (!collapsed && !expandedSections.has(group.id));
            return (
            <NavRailSection key={group.id} classPrefix="app-nav" title={title} showHeader={!collapsed && !group.headerless} collapsed={sectionCollapsed} onToggle={() => toggleSection(group.id)}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = navItemIsActive(item, location.pathname);
                  const badge = badgeFor(item.featureId);
                  // ADR 0419 — a locked (paid-but-unbought) feature: route the click
                  // to the feature store (upsell) instead of its page (which 403s),
                  // and show a quiet lock. false when billing is off / entitled.
                  const locked = lockedFor(item.featureId);
                  // ADR 0023 — the "Agents" item owns a collapsible sub-menu of
                  // pinned agents (indented, toggled, open by default), so it
                  // renders its whole <li> (link + disclosure + sub-list).
                  if (item.to === '/agents') {
                    return <AgentsNavItem key={item.to} item={item} badge={badge} locked={locked} />;
                  }
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={locked ? STORE : item.to}
                        onClick={() => setNavSource('sidebar')}
                        {...(!locked && item.end !== undefined ? { end: item.end } : {})}
                        className={`app-nav-link${active && !locked ? ' is-active' : ''}`}
                        {...(active && !locked ? { 'aria-current': 'page' as const } : {})}
                        title={locked ? t('navLocked') : item.hintKey ? tn(item.hintKey, { defaultValue: item.hint }) : item.hint}
                      >
                        <NavRailItemContent
                          classPrefix="app-nav"
                          icon={<Icon size={16} />}
                          label={item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label}
                          locked={locked}
                          lockedLabel={t('navLocked')}
                          badge={badge}
                          compact={collapsed}
                        />
                      </NavLink>
                    </li>
                  );
                })}
            </NavRailSection>
            );
          })}
          {/* The admin tier surfaces as ONE pinned entry (white-label PRD §2):
              everything platform/config lives behind it, inside <AdminLayout>'s
              embedded rail. Active whenever any admin-tier route is open.
              ADM-8 (ADR 0196 Phase 4): hidden unless the caller resolves as the
              workspace owner or an admin/owner-role member — presentation only;
              every admin route still 403s server-side for non-admins. */}
          {isAdminCaller(access) && (
            <div className="app-nav-group app-nav-group--admin">
              <ul>
                <li>
                  <Link
                    to="/admin"
                    className={`app-nav-link${isAdminPath(location.pathname) ? ' is-active' : ''}`}
                    title={t('adminEntryHint')}
                  >
                    <span className="app-nav-icon" aria-hidden><SettingsIcon size={16} /></span>
                    <span className="app-nav-label">{tn('groupAdmin', { defaultValue: 'Admin' })}</span>
                  </Link>
                </li>
              </ul>
            </div>
          )}
        </nav>

        <div className="app-sidebar-foot">
          {devTools.enabled && (
            <Button
              variant="secondary" size="sm" className="app-sidebar-net"
              onClick={onToggleNet}
              aria-label={t('openNetworkInspector')}
              aria-expanded={netOpen}
              title={t('networkInspectorHint')}
            >
              {t('network')}
            </Button>
          )}
          <ThemeToggle />
          {accountPresent === false && (
            <>
              <A11yPrefsControl />
              <LanguageSwitcher />
            </>
          )}
          <div className="app-sidebar-account-row">
            <NotificationBell />
            <SignInButton />
          </div>
        </div>
      </aside>
    </>
  );
}
