import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { chromeFor, navItemIsActive, GROUP_LABEL_KEYS } from './features.js';
import { ChevronDownIcon, ChevronRightIcon } from '../ui/icons/index.js';
import { IconButton } from '../ui/IconButton.js';
import { useFeatureBadge } from '../featureToggles/FeatureAccessContext.js';
import { useResolvedNav } from './navConfig/NavConfigProvider.js';
import { readCollapsedHeaders, toggleCollapsedHeader } from './navConfig/navCollapseCookie.js';

const COLLAPSE_KEY = 'openwop.admin.railCollapsed';

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
  const location = useLocation();
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
  // The effective admin rail (ADR 0139): declared nav overlaid with the menu
  // config + feature-gated by `resolveNav` (a `beta` feature renders a badge).
  const badgeFor = useFeatureBadge();
  const { admin: navGroups } = useResolvedNav();
  // Per-section collapse (ADR 0139), shared cookie with the workspace rail.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => readCollapsedHeaders());
  const toggleSection = (id: string) => setCollapsedSections(toggleCollapsedHeader(id));
  // Width chrome still derives from the manifest: a `narrow` admin page (CLI,
  // demo-data) keeps its reading width inside the admin content column.
  const narrow = chromeFor(location.pathname) === 'narrow';
  return (
    <div className={`admin-shell${collapsed ? ' is-collapsed' : ''}`}>
      <aside className="admin-rail" aria-label={t('adminSections')}>
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
        <nav aria-label={t('sections')}>
          {navGroups.map((group) => {
            const isRoot = group.id === 'Admin';
            const title = group.custom ? group.label : tn(GROUP_LABEL_KEYS[group.id] ?? '', { defaultValue: group.label });
            // The root 'Admin' group (Overview) is header-less + never collapses
            // (the rail title already names the tier). Section toggles also hide
            // when the rail collapses to the icon strip.
            const sectionCollapsed = !isRoot && !collapsed && collapsedSections.has(group.id);
            return (
            <div key={group.id} className="admin-nav-group">
              {!isRoot && !collapsed && (
                <button
                  type="button"
                  className="admin-nav-group-label admin-nav-group-toggle"
                  aria-expanded={!sectionCollapsed}
                  onClick={() => toggleSection(group.id)}
                >
                  <span>{title}</span>
                  <span className={`admin-nav-group-chevron${sectionCollapsed ? ' is-collapsed' : ''}`} aria-hidden><ChevronDownIcon size={11} /></span>
                </button>
              )}
              {!sectionCollapsed && (
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
                        className={`admin-nav-link${active ? ' is-active' : ''}`}
                        {...(active ? { 'aria-current': 'page' as const } : {})}
                        title={collapsed
                          ? (item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label)
                          : (item.hintKey ? tn(item.hintKey, { defaultValue: item.hint }) : item.hint)}
                      >
                        <span className="admin-nav-icon" aria-hidden><Icon size={16} /></span>
                        <span className="admin-nav-label">{item.labelKey ? tn(item.labelKey, { defaultValue: item.label }) : item.label}</span>
                        {badge && !collapsed ? <span className="nav-badge nav-badge--beta">{badge}</span> : null}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
              )}
            </div>
            );
          })}
        </nav>
      </aside>
      <div className={narrow ? 'admin-content admin-content--narrow' : 'admin-content'}>
        <Outlet />
      </div>
    </div>
  );
}
