/**
 * DashboardTileCard (ADR 0375 Phase 2) — the per-tile chrome: title bar + the
 * lazy tile body wrapped in its OWN ErrorBoundary + Suspense + LazyMount, so one
 * tile that errors or is slow never takes down the dashboard (fail-closed
 * isolation, architect-required). In customize mode the title bar exposes
 * keyboard-operable reorder (↑/↓), resize (half↔full), and remove controls,
 * and the whole card is a drag handle (HTML5 DnD) — the buttons stay, so
 * pointer drag and keyboard reorder are parity paths, never alternatives.
 * In view mode the bar carries a refresh control: remounting the body re-runs
 * the tile's fetch-on-mount read (and clears a stuck error state), with a
 * quiet "data age" stamp that stays silent for the first minute.
 */
import { Button } from '../../ui/Button.js';
import { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '../../ui/ErrorBoundary.js';
import { SkeletonRows } from '../../ui/Skeleton.js';
import { ArrowUpIcon, ArrowDownIcon, ArrowUpToLineIcon, ArrowDownToLineIcon, XIcon, ColumnsIcon, SquareIcon, RotateCwIcon, GripVerticalIcon } from '../../ui/icons/index.js';
import { formatRelativeTime, formatTime } from '../../i18n/format.js';
import { LazyMount } from './LazyMount.js';
import type { ResolvedTile } from './resolveTiles.js';

interface Props {
  tile: ResolvedTile;
  customizing: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  /** DASH-1 — keyboard shortcut past the O(n) press tail on long grids. */
  onMoveToEdge: (edge: 'top' | 'bottom') => void;
  onToggleSize: () => void;
  onRemove: () => void;
  /** Routes SR feedback to the page's single polite live region. */
  onAnnounce: (msg: string) => void;
  /** Pointer-drag reorder (customize mode). Buttons remain the keyboard path. */
  onDragStartTile: () => void;
  onDropOnTile: () => void;
  onDragEndTile: () => void;
}

export function DashboardTileCard({ tile, customizing, isFirst, isLast, onMove, onMoveToEdge, onToggleSize, onRemove, onAnnounce, onDragStartTile, onDropOnTile, onDragEndTile }: Props): JSX.Element {
  const { t } = useTranslation('dashboard');
  const { def, size } = tile;
  const Icon = def.icon;
  const label = t(def.labelKey, { defaultValue: def.label });
  const compact = size === 'half';

  // Refresh = remount the body (tiles fetch on mount), stamped for the age label.
  const [refreshKey, setRefreshKey] = useState(0);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const [dropTarget, setDropTarget] = useState(false);
  // Re-render each minute so the age stamp ticks; silent under a minute.
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(iv);
  }, []);
  const ageMs = Date.now() - loadedAt;
  const refresh = (): void => {
    setRefreshKey((k) => k + 1);
    setLoadedAt(Date.now());
    onAnnounce(t('refreshedAnnounce', { name: label }));
  };

  // DASH-1 focus restore: a reorder unmounts the control the user activated,
  // so the page needs to find this tile again to put focus back (data-tile-id).
  return (
    <section
      className={`dash-tile dash-tile--${size}${customizing ? ' dash-tile--customizing' : ''}${dropTarget ? ' dash-tile--drop-target' : ''}`}
      aria-label={label}
      {...{ 'data-tile-id': tile.def.id }}
    >
      {/* The drag surface is a generic wrapper, NOT the section itself — the tile
          keeps its named-region semantics, and drag handlers on a landmark trip
          jsx-a11y (non-interactive element). Keyboard reorder rides the buttons. */}
      <div
        className="dash-tile__dnd"
        draggable={customizing}
        onDragStart={customizing ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', def.id); onDragStartTile(); } : undefined}
        onDragOver={customizing ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(true); } : undefined}
        onDragLeave={customizing ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(false); } : undefined}
        onDrop={customizing ? (e) => { e.preventDefault(); setDropTarget(false); onDropOnTile(); } : undefined}
        onDragEnd={customizing ? () => { setDropTarget(false); onDragEndTile(); } : undefined}
      >
      <header className="dash-tile__bar">
        <span className="dash-tile__title u-truncate">
          {customizing ? <span className="dash-tile__grip" aria-hidden><GripVerticalIcon size={13} /></span> : null}
          <Icon size={14} className="dash-tile__icon" /> {label}
        </span>
        {customizing ? (
          <span className="dash-tile__controls" role="group" aria-label={t('tileControls', { defaultValue: 'Tile controls' })}>
            <Button variant="quiet" size="sm" className="dash-tile__ctrl" onClick={() => onMoveToEdge('top')} disabled={isFirst} aria-label={t('moveToTop')} title={t('moveToTop')}><ArrowUpToLineIcon size={13} /></Button>
            <Button variant="quiet" size="sm" className="dash-tile__ctrl" onClick={() => onMove(-1)} disabled={isFirst} aria-label={t('moveUp', { defaultValue: 'Move up' })} title={t('moveUp', { defaultValue: 'Move up' })}><ArrowUpIcon size={13} /></Button>
            <Button variant="quiet" size="sm" className="dash-tile__ctrl" onClick={() => onMove(1)} disabled={isLast} aria-label={t('moveDown', { defaultValue: 'Move down' })} title={t('moveDown', { defaultValue: 'Move down' })}><ArrowDownIcon size={13} /></Button>
            <Button variant="quiet" size="sm" className="dash-tile__ctrl" onClick={() => onMoveToEdge('bottom')} disabled={isLast} aria-label={t('moveToBottom')} title={t('moveToBottom')}><ArrowDownToLineIcon size={13} /></Button>
            {def.resizable ? (
              <Button variant="quiet" size="sm" className="dash-tile__ctrl" onClick={onToggleSize} aria-label={compact ? t('makeWide', { defaultValue: 'Make wide' }) : t('makeCompact', { defaultValue: 'Make compact' })} title={compact ? t('makeWide', { defaultValue: 'Make wide' }) : t('makeCompact', { defaultValue: 'Make compact' })}>
                {compact ? <ColumnsIcon size={13} /> : <SquareIcon size={13} />}
              </Button>
            ) : null}
            <Button variant="quiet" size="sm" className="dash-tile__ctrl" onClick={onRemove} aria-label={t('removeTile', { defaultValue: 'Remove tile', name: label })} title={t('removeTile', { defaultValue: 'Remove tile' })}><XIcon size={13} /></Button>
          </span>
        ) : (
          <span className="dash-tile__controls">
            {ageMs >= 60_000 ? (
              <span className="dash-tile__age muted" title={t('loadedAtTitle', { time: formatTime(loadedAt) })}>
                {formatRelativeTime(new Date(loadedAt).toISOString())}
              </span>
            ) : null}
            <Button variant="quiet" size="sm" className="dash-tile__ctrl" onClick={refresh} aria-label={t('refreshTile', { name: label })} title={t('refreshTile', { name: label })}><RotateCwIcon size={13} /></Button>
          </span>
        )}
      </header>
      <div className="dash-tile__body" key={refreshKey}>
        <ErrorBoundary label={`dashboard tile ${def.id}`} fallback={() => <p className="dash-tile__state muted">{t('tileError')}</p>}>
          <LazyMount placeholder={<SkeletonRows rows={compact ? 3 : 5} columns={['70%', '55%', '60%']} />}>
            <Suspense fallback={<SkeletonRows rows={compact ? 3 : 5} columns={['70%', '55%', '60%']} />}>
              <def.component compact={compact} />
            </Suspense>
          </LazyMount>
        </ErrorBoundary>
      </div>
      </div>
    </section>
  );
}
