import type { ReactNode } from 'react';
import { ChevronDownIcon, LockIcon } from '../ui/icons/index.js';

export function NavRailSection({ classPrefix, title, showHeader, collapsed, onToggle, children }: {
  classPrefix: 'app-nav' | 'admin-nav';
  title: string;
  showHeader: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`${classPrefix}-group nav-rail-group`}>
      {showHeader ? (
        <button type="button" className={`${classPrefix}-group-label ${classPrefix}-group-toggle nav-rail-group-toggle`} aria-expanded={!collapsed} onClick={onToggle}>
          <span>{title}</span>
          <span className={`${classPrefix}-group-chevron${collapsed ? ' is-collapsed' : ''}`} aria-hidden><ChevronDownIcon size={11} /></span>
        </button>
      ) : null}
      {!collapsed ? <ul>{children}</ul> : null}
    </div>
  );
}

export function NavRailItemContent({ classPrefix, icon, label, locked, lockedLabel, badge, compact }: {
  classPrefix: 'app-nav' | 'admin-nav';
  icon: ReactNode;
  label: string;
  locked: boolean;
  lockedLabel: string;
  badge?: string | null | undefined;
  compact: boolean;
}): JSX.Element {
  return (
    <>
      <span className={`${classPrefix}-icon nav-rail-item-icon`} aria-hidden>{icon}</span>
      {/* The desktop rail intentionally hides its visible label when compact.
          Keep the destination name in the accessibility tree: an icon alone
          is not a link name, and tooltips are not a reliable accessible name. */}
      {compact
        ? <span className="sr-only">{label}</span>
        : <span className={`${classPrefix}-label nav-rail-item-label`}>{label}</span>}
      {locked && !compact ? <span role="img" className="app-nav-lock" aria-label={lockedLabel}><LockIcon size={13} /></span>
        : badge && !compact ? <span className="nav-badge nav-badge--beta">{badge}</span> : null}
    </>
  );
}
