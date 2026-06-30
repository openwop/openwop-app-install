import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { BrandMark } from '../brand/BrandMark.js';
import { SignInButton } from '../auth/SignInButton.js';
import { NotificationBell } from '../notifications/NotificationBell.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, MenuIcon, SearchIcon, SettingsIcon } from '../ui/icons/index.js';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { navItemIsActive, GROUP_LABEL_KEYS } from './features.js';
import { IconButton } from '../ui/IconButton.js';
import { useFocusTrap } from '../ui/useFocusTrap.js';
import { isAdminPath } from './features.js';
import { useFeatureBadge } from '../featureToggles/FeatureAccessContext.js';
import { useResolvedNav } from './navConfig/NavConfigProvider.js';
import { readCollapsedHeaders, toggleCollapsedHeader } from './navConfig/navCollapseCookie.js';
import { AgentsNavItem } from './PinnedAgentsNav.js';

const COLLAPSE_KEY = 'openwop.sidebar.collapsed';

export function Sidebar({ netOpen, onToggleNet }: { netOpen: boolean; onToggleNet: () => void }): JSX.Element {
  const { t } = useTranslation('chrome');
  const { t: tn } = useTranslation('nav');
  const location = useLocation();
  const badgeFor = useFeatureBadge();
  // The effective workspace rail (ADR 0139): the declared nav overlaid with the
  // tenant+user menu config and already feature-gated by `resolveNav` (a
  // toggled-off feature never appears). Empty groups are dropped there too.
  // Notifications is CORE platform infrastructure (the toggle was removed
  // 2026-06-11 — docs/adr/0010-notifications.md § Correction), so the header
  // bell always shows; per-user preferences are the control.
  const { workspace: navGroups } = useResolvedNav();
  // Per-section collapse (ADR 0139) — remembered per browser in a cookie, keyed
  // by the stable header id (survives renames).
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => readCollapsedHeaders());
  const toggleSection = (id: string) => setCollapsedSections(toggleCollapsedHeader(id));
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  // Mobile: the rail is an off-canvas drawer; close it on every route change.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  // SHELL-1 — while the mobile drawer is open it is a modal surface: trap focus
  // inside it (+ restore to the launcher on close, both via useFocusTrap) and
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
      {/* Mobile launcher — only shown ≤860px via CSS; opens the drawer. */}
      <IconButton
        className="app-sidebar-launcher"
        label={t('openNavigation')}
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        icon={<MenuIcon size={18} />}
      />
      {drawerOpen && <div className="app-sidebar-scrim" onClick={() => setDrawerOpen(false)} aria-hidden />}

      <aside
        ref={drawerRef}
        className={`app-sidebar${collapsed ? ' is-collapsed' : ''}${drawerOpen ? ' is-open' : ''}`}
        aria-label={t('primary')}
        {...(drawerOpen ? { role: 'dialog' as const, 'aria-modal': true } : {})}
      >
        <div className="app-sidebar-head">
          <Link to="/" className="app-sidebar-brand" aria-label={t('brandHome')}>
            <BrandMark />
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
            const sectionCollapsed = !collapsed && collapsedSections.has(group.id);
            return (
            <div key={group.id} className="app-nav-group">
              {/* Collapsible section header (ADR 0139). Hidden when the whole
                  rail is icon-collapsed (labels are hidden then anyway). */}
              {!collapsed && (
                <button
                  type="button"
                  className="app-nav-group-label app-nav-group-toggle"
                  aria-expanded={!sectionCollapsed}
                  onClick={() => toggleSection(group.id)}
                >
                  <span>{title}</span>
                  <span className={`app-nav-group-chevron${sectionCollapsed ? ' is-collapsed' : ''}`} aria-hidden><ChevronDownIcon size={11} /></span>
                </button>
              )}
              {!sectionCollapsed && (
              <ul>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = navItemIsActive(item, location.pathname);
                  const badge = badgeFor(item.featureId);
                  // ADR 0023 — the "Agents" item owns a collapsible sub-menu of
                  // pinned agents (indented, toggled, open by default), so it
                  // renders its whole <li> (link + disclosure + sub-list).
                  if (item.to === '/agents') {
                    return <AgentsNavItem key={item.to} item={item} badge={badge} />;
                  }
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        {...(item.end !== undefined ? { end: item.end } : {})}
                        className={`app-nav-link${active ? ' is-active' : ''}`}
                        {...(active ? { 'aria-current': 'page' as const } : {})}
                        title={item.hintKey ? tn(item.hintKey, { defaultValue: item.hint }) : item.hint}
                      >
                        <span className="app-nav-icon" aria-hidden><Icon size={16} /></span>
                        <span className="app-nav-label">{item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label}</span>
                        {badge ? <span className="nav-badge nav-badge--beta">{badge}</span> : null}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
              )}
            </div>
            );
          })}
          {/* The admin tier surfaces as ONE pinned entry (white-label PRD §2):
              everything platform/config lives behind it, inside <AdminLayout>'s
              embedded rail. Active whenever any admin-tier route is open. */}
          <div className="app-nav-group app-nav-group--admin">
            <ul>
              <li>
                <NavLink
                  to="/admin"
                  className={`app-nav-link${isAdminPath(location.pathname) ? ' is-active' : ''}`}
                  aria-current={isAdminPath(location.pathname) ? 'page' : undefined}
                  title={t('adminEntryHint')}
                >
                  <span className="app-nav-icon" aria-hidden><SettingsIcon size={16} /></span>
                  <span className="app-nav-label">{tn('groupAdmin', { defaultValue: 'Admin' })}</span>
                </NavLink>
              </li>
            </ul>
          </div>
        </nav>

        <div className="app-sidebar-foot">
          <button
            type="button"
            className="secondary btn-sm app-sidebar-net"
            onClick={onToggleNet}
            aria-label={t('openNetworkInspector')}
            aria-expanded={netOpen}
            title={t('networkInspectorHint')}
          >
            {t('network')}
          </button>
          <ThemeToggle />
          <LanguageSwitcher />
          <div className="app-sidebar-account-row">
            <NotificationBell />
            <SignInButton />
          </div>
        </div>
      </aside>
    </>
  );
}
