import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, matchPath, useLocation } from 'react-router-dom';
import { setNavSource } from './navSource.js';
import { chromeFor, navItemIsActive, GROUP_LABEL_KEYS, FEATURES } from './features.js';
import { ChevronDownIcon, ChevronRightIcon } from '../ui/icons/index.js';
import { IconButton } from '../ui/IconButton.js';
import { useFeatureBadge, useFeatureLocked } from '../featureToggles/FeatureAccessContext.js';
import { useResolvedNav } from './navConfig/NavConfigProvider.js';
import { readExpandedHeaders, toggleExpandedHeader } from './navConfig/navCollapseCookie.js';
import { isAdminCaller, useEffectiveAccessState } from '../client/useEffectiveAccess.js';
import { StateCard } from '../ui/StateCard.js';
import { Skeleton } from '../ui/Skeleton.js';
import { ShieldIcon } from '../ui/icons/index.js';
import { Notice } from '../ui/Notice.js';
import { Tooltip } from '../ui/Tooltip.js';
import { recordRecentAdminDestination } from './adminRecents.js';
import { useMediaQuery } from '../ui/useMediaQuery.js';
import { AdminRouteProvider, type AdminParentRoute } from './AdminRouteContext.js';
import { NavRailItemContent, NavRailSection } from './NavRailPrimitives.js';

const COLLAPSE_KEY = 'openwop.admin.railCollapsed';
const FEATURE_STORE = '/marketplace/bundles';

/**
 * <AdminLayout> — the single Admin surface with its own embedded left rail
 * (white-label PRD §2: two-tier IA shipped as framework chrome, not a fork).
 *
 * Mounted as a PATHLESS layout route wrapping every admin-tier feature, so the
 * secondary admin rail stays pinned while you move between Organizations,
 * Keys, Capabilities, etc. The wrapped routes keep their original top-level
 * paths — existing deep links keep working; only the surrounding chrome
 * changes. Which routes render here is declared in the feature manifest
 * (`features.tsx` `tier: 'admin'`) — this component hard-codes nothing.
 *
 * The rail collapses to an icon strip (default expanded); the chevron toggle
 * persists the choice per browser.
 */
export function AdminLayout(): JSX.Element {
  const { t } = useTranslation('chrome');
  const { t: tn } = useTranslation('nav');
  const lockedFor = useFeatureLocked();
  const location = useLocation();
  const mobile = useMediaQuery('(max-width: 860px)');
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };
  // DSA-026 (ADR 0510 Phase 7) — ≤860px the rail used to render as a wrapping
  // link CLOUD above the content. It is now a compact disclosure: one labeled
  // row naming the current admin destination; the sections expand on demand
  // and close again on navigation. Inline disclosure (aria-expanded), not a
  // modal drawer — no focus trap wanted.
  const [mobileOpen, setMobileOpen] = useState(false);
  // The effective admin rail (ADR 0139): declared nav overlaid with the menu
  // config + feature-gated by `resolveNav` (a `beta` feature renders a badge).
  const badgeFor = useFeatureBadge();
  const { admin: navGroups, degraded } = useResolvedNav();
  // Per-section collapse (ADR 0139, inverted 2026-07-06: collapsed by default),
  // shared cookie with the workspace rail. Mirrors Sidebar: the active route's
  // group is revealed in state (mount + navigation), never written to the cookie.
  const activeGroupId = (): string | undefined =>
    navGroups.find((g) => g.items.some((item) => navItemIsActive(item, location.pathname)))?.id;
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => {
    const ids = readExpandedHeaders();
    const active = activeGroupId();
    if (active) ids.add(active);
    return ids;
  });
  const toggleSection = (id: string) => setExpandedSections(toggleExpandedHeader(id));
  // Close the mobile disclosure on NAVIGATION only — its own effect, keyed on
  // the pathname alone: `navGroups` below is identity-unstable per render, and
  // closing on it made the disclosure re-close the instant it opened.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => {
    const active = activeGroupId();
    if (!active) return;
    setExpandedSections((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeGroupId derives from these two
  }, [location.pathname, navGroups]);
  // One bounded local recency projection for the Admin home. Record the
  // canonical manifest destination rather than the visited deep URL, and only
  // after it survives the effective access/toggle/menu resolver.
  const recentDestination = navGroups.flatMap((group) => group.items)
    .find((item) => navItemIsActive(item, location.pathname))?.to;
  useEffect(() => {
    if (recentDestination) recordRecentAdminDestination(recentDestination);
  }, [recentDestination]);
  /** The current destination's nav label — the mobile disclosure row names
   *  where you ARE, so the collapsed state is informative, not a bare menu. */
  const currentItemLabel = (): string | undefined => {
    for (const g of navGroups) {
      const hit = g.items.find((item) => navItemIsActive(item, location.pathname));
      if (hit) return hit.labelKey ? tn(hit.labelKey, { defaultValue: hit.label }) : hit.label;
    }
    return undefined;
  };
  // Width chrome still derives from the manifest: a `narrow` admin page (CLI,
  // demo-data) keeps its reading width inside the admin content column.
  const narrow = chromeFor(location.pathname) === 'narrow';
  const parentRoute = (() : AdminParentRoute | null => {
    const current = FEATURES.find((feature) => matchPath({ path: feature.path, end: true }, location.pathname));
    if (!current?.parentPath) return null;
    const parent = FEATURES.find((feature) => feature.path === current.parentPath);
    if (!parent?.nav || parent.tier !== 'admin') return null;
    return { path: parent.path, label: parent.nav.label, ...(parent.nav.labelKey ? { labelKey: parent.nav.labelKey } : {}) };
  })();
  // ADR 0203 — admin-tier PAGE enforcement (ADM-8). Presentation-only (every
  // backend route 403s on its own); the ONE layout wrapping all admin routes,
  // so present and future admin pages are covered with zero per-page wiring.
  // Unresolved → quiet loading (no deny flash); resolved non-admin → honest
  // StateCard, no redirect (deep links stay shareable; the auth-change
  // re-resolve lands an admin who signs in on this URL correctly). Demo host
  // unaffected (anon resolves basis:'tenant-owner' server-side).
  const { access, resolved } = useEffectiveAccessState();
  if (!resolved) {
    // UXDEF-2 — a visible skeleton beats a momentarily blank shell on slow
    // networks (one resolve per page load; usually sub-100ms).
    return (
      <div className="admin-shell" aria-busy="true">
        <div className="admin-content" role="status" aria-label={t('common:loading')}>
          <Skeleton width="40%" height={20} />
          <div className="u-mt-3"><Skeleton width="100%" height={14} /></div>
          <div className="u-mt-2"><Skeleton width="80%" height={14} /></div>
          <span className="sr-only">{t('common:loading')}</span>
        </div>
      </div>
    );
  }
  if (!isAdminCaller(access)) {
    return (
      <div className="admin-shell">
        <div className="admin-content">
          <StateCard
            icon={<ShieldIcon size={20} />}
            title={t('adminAccessRequiredTitle')}
            body={t('adminAccessRequiredBody')}
          />
        </div>
      </div>
    );
  }
  return (
    <div className={`admin-shell${collapsed ? ' is-collapsed' : ''}${mobileOpen ? ' is-mobile-nav-open' : ''}`}>
      <aside className="admin-rail" aria-label={t('adminSections')}>
        {/* ≤860px only (CSS-hidden on desktop): the compact disclosure row. */}
        <button
          type="button"
          className="admin-rail-mobile-toggle u-fw-600"
          aria-expanded={mobileOpen}
          aria-controls="admin-rail-nav"
          onClick={() => setMobileOpen((v) => !v)}
        >
          <span className="admin-rail-mobile-current">
            {tn('groupAdmin', { defaultValue: 'Admin' })}
            {currentItemLabel() ? <> · {currentItemLabel()}</> : null}
          </span>
          <span className={`admin-nav-group-chevron${mobileOpen ? '' : ' is-collapsed'}`} aria-hidden><ChevronDownIcon size={14} /></span>
        </button>
        <div className="admin-rail-head">
          {!collapsed && <div className="admin-rail-title">{tn('groupAdmin', { defaultValue: 'Admin' })}</div>}
          <IconButton
            className="admin-rail-toggle"
            onClick={toggle}
            label={collapsed ? t('expandAdminMenu') : t('collapseAdminMenu')}
            aria-pressed={collapsed}
            title={collapsed ? t('expand') : t('collapse')}
            icon={<ChevronRightIcon size={16} />}
          />
        </div>
        <nav id="admin-rail-nav" aria-label={t('adminSections')}>
          {navGroups.map((group) => {
            const isRoot = group.id === 'Admin';
            const title = group.custom ? group.label : tn(GROUP_LABEL_KEYS[group.id] ?? '', { defaultValue: group.label });
            // The root 'Admin' group (Overview) is header-less + never collapses
            // (the rail title already names the tier). Section toggles also hide
            // when the rail collapses to the icon strip.
            // Desktop collapse is an icon strip (all destination icons remain
            // reachable). Mobile is a labeled accordion and must not inherit
            // that desktop preference, or every item opens without headings.
            const sectionCollapsed = !isRoot && (mobile || !collapsed) && !expandedSections.has(group.id);
            return (
            <NavRailSection key={group.id} classPrefix="admin-nav" title={title} showHeader={!isRoot && (mobile || !collapsed)} collapsed={sectionCollapsed} onToggle={() => toggleSection(group.id)}>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = navItemIsActive(item, location.pathname);
                  const badge = badgeFor(item.featureId);
                  const locked = lockedFor(item.featureId);
                  const label = item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label;
                  const tooltip = locked ? t('navLocked') : collapsed
                    ? label
                    : (item.hintKey ? tn(item.hintKey, { defaultValue: item.hint }) : item.hint);
                  return (
                    <li key={item.to}>
                      <Tooltip text={tooltip} disabled={!collapsed}>
                      <Link
                        to={locked ? FEATURE_STORE : item.to}
                        onClick={() => setNavSource('admin-rail')}
                        className={`admin-nav-link${active && !locked ? ' is-active' : ''}`}
                        {...(active && !locked ? { 'aria-current': 'page' as const } : {})}
                        aria-label={collapsed ? label : undefined}
                        title={!collapsed ? tooltip : undefined}
                      >
                        <NavRailItemContent classPrefix="admin-nav" icon={<Icon size={16} />} label={label} locked={locked} lockedLabel={t('navLocked')} badge={badge} compact={collapsed && !mobile} />
                      </Link>
                      </Tooltip>
                    </li>
                  );
                })}
            </NavRailSection>
            );
          })}
        </nav>
      </aside>
      <div className={narrow ? 'admin-content admin-content--narrow' : 'admin-content'}>
        {degraded ? (
          <Notice variant="warning" announce={t('adminNavDegraded')}>
            {t('adminNavDegraded')}
          </Notice>
        ) : null}
        {navGroups.length === 0 ? <StateCard title={t('adminNavEmptyTitle')} body={t('adminNavEmptyBody')} /> : null}
        <AdminRouteProvider parent={parentRoute}><Outlet /></AdminRouteProvider>
      </div>
    </div>
  );
}
