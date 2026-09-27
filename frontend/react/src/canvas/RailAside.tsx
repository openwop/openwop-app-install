/**
 * RailAside (ADR 0365) — the ONE rail aside/chevron chrome both canvas
 * compositions render (§7.2 / CV-14+CV-16): the labeled aside, the collapse
 * strip class, and the chevron toggle whose direction reads "where the rail
 * goes". Rail GEOMETRY (widths, persistence, `[`/`]`) stays each
 * composition's `useRailLayout(<frozen key>)`; rail CONTENT is children.
 */
import { Button } from '../ui/Button.js';
import type { ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from '../ui/icons/index.js';
import type { RailSide } from './useRailLayout.js';

export function RailAside({ side, collapsed, className, label, expandLabel, collapseLabel, onToggle, children }: {
  side: RailSide;
  collapsed: boolean;
  /** The composition's aside class ('cv-editor__palette' / 'builder-rail' …). */
  className: string;
  label: string;
  expandLabel: string;
  collapseLabel: string;
  onToggle: () => void;
  children: ReactNode;
}): JSX.Element {
  const Chevron = (side === 'l') === collapsed ? ChevronRightIcon : ChevronLeftIcon;
  return (
    <aside className={`${className}${collapsed ? ' is-collapsed' : ''}`} aria-label={label}>
      <Button
        variant="quiet" size="sm" className="cv-rail-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? expandLabel : collapseLabel}
        title={collapsed ? expandLabel : collapseLabel}
        onClick={onToggle}
      >
        <Chevron size={14} aria-hidden />
      </Button>
      {children}
    </aside>
  );
}
