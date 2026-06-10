import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { BrandMark } from '../brand/BrandMark.js';
import { SignInButton } from '../auth/SignInButton.js';
import { NotificationBell } from '../notifications/NotificationBell.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import { MenuIcon, SearchIcon, SettingsIcon } from '../ui/icons/index.js';
import { ThemeToggle } from '../ui/ThemeToggle.js';
import { WORKSPACE_NAV, navItemIsActive } from './features.js';
import { IconButton } from '../ui/IconButton.js';
import { isAdminPath } from './features.js';
import { useFeatureAccess, useFeatureVisible, useFeatureBadge } from '../featureToggles/FeatureAccessContext.js';

const COLLAPSE_KEY = 'openwop.sidebar.collapsed';

export function Sidebar({ netOpen, onToggleNet }: { netOpen: boolean; onToggleNet: () => void }): JSX.Element {
  const location = useLocation();
  // Feature-gated nav: hide items whose `featureId` toggle isn't enabled for
  // this caller (ADR §3.4). Core items (no featureId) always show. Groups that
  // empty out after filtering are dropped. Same predicate the ⌘K palette uses.
  const isVisible = useFeatureVisible();
  const badgeFor = useFeatureBadge();
  // The header bell gates on the `notifications` toggle, but it's a default-ON
  // core surface — show it OPTIMISTICALLY while feature access is still
  // resolving (byId starts empty ⇒ `enabled` is false until the toggles
  // endpoint responds). Hiding-then-showing would flicker the bell on every
  // load; we only hide once we KNOW the toggle is off. (Nav items differ —
  // they're default-OFF, so starting hidden is correct for them.)
  const notifications = useFeatureAccess('notifications');
  const showBell = notifications.enabled || notifications.loading;
  const navGroups = WORKSPACE_NAV
    .map((g) => ({ ...g, items: g.items.filter((item) => isVisible(item.featureId)) }))
    .filter((g) => g.items.length > 0);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  // Mobile: the rail is an off-canvas drawer; close it on every route change.
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);

  return (
    <>
      {/* Mobile launcher — only shown ≤860px via CSS; opens the drawer. */}
      <IconButton
        className="app-sidebar-launcher"
        label="Open navigation"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
        icon={<MenuIcon size={18} />}
      />
      {drawerOpen && <div className="app-sidebar-scrim" onClick={() => setDrawerOpen(false)} aria-hidden />}

      <aside
        className={`app-sidebar${collapsed ? ' is-collapsed' : ''}${drawerOpen ? ' is-open' : ''}`}
        aria-label="Primary"
      >
        <div className="app-sidebar-head">
          <Link to="/" className="app-sidebar-brand" aria-label="OpenWOP home">
            <BrandMark />
          </Link>
          <IconButton
            className="app-sidebar-collapse"
            label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-pressed={collapsed}
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Expand' : 'Collapse'}
            icon={<MenuIcon size={16} />}
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
          title="Search + jump to anything (⌘K)"
        >
          <span className="app-cmdk-icon" aria-hidden><SearchIcon size={15} /></span>
          <span className="app-cmdk-label">Search…</span>
          <kbd className="app-cmdk-kbd" aria-hidden>⌘K</kbd>
        </button>

        <nav className="app-sidebar-nav" aria-label="Sections">
          {navGroups.map((group) => (
            <div key={group.label} className="app-nav-group">
              <div className="app-nav-group-label" aria-hidden>{group.label}</div>
              <ul>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = navItemIsActive(item, location.pathname);
                  const badge = badgeFor(item.featureId);
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        {...(item.end !== undefined ? { end: item.end } : {})}
                        className={`app-nav-link${active ? ' is-active' : ''}`}
                        {...(active ? { 'aria-current': 'page' as const } : {})}
                        title={item.hint}
                      >
                        <span className="app-nav-icon" aria-hidden><Icon size={16} /></span>
                        <span className="app-nav-label">{item.label}</span>
                        {badge ? <span className="nav-badge nav-badge--beta">{badge}</span> : null}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
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
                  title="Platform configuration + console"
                >
                  <span className="app-nav-icon" aria-hidden><SettingsIcon size={16} /></span>
                  <span className="app-nav-label">Admin</span>
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
            aria-label="Open network inspector"
            aria-expanded={netOpen}
            title="Show every REST + SSE call the app is making"
          >
            Network
          </button>
          <ThemeToggle />
          <div className="app-sidebar-account-row">
            {showBell && <NotificationBell />}
            <SignInButton />
          </div>
        </div>
      </aside>
    </>
  );
}
