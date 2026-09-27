/**
 * Workflow Card + Row — the two cells of the §4.5 collection-view canon (rule 11)
 * for the saved-workflows dashboard (`/builder`). The Card fills the existing
 * `.workflows-grid`; the Row fills a `.surface-card.list-view`. Both derive their
 * sub-line + meta from the SAME helpers below, so the grid and list views never
 * diverge (the Projects `ProjectViews` precedent). Composed from existing
 * primitives — no bespoke CSS.
 *
 * Extracted verbatim from `WorkflowsDashboard` so the listing gains a list view
 * without forking the card's rename/duplicate/export/delete behavior. The kebab
 * menu + inline-rename state is still owned by the dashboard and threaded in.
 */

import { Button } from '../ui/Button.js';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
/** A dashboard list item — the lightweight summary the cards render (ADR 0163
 *  Phase 3): backend list-metadata (no full node graph). Structurally compatible
 *  with the backend `WorkflowSummary`. */
export interface WorkflowListItem {
  id: string;
  name: string;
  nodeCount: number;
  updatedAt: string;
  /** ADR 0369 §5 — an unpromoted builder draft (renders the Draft chip). */
  transient?: boolean;
  publishedBehindHead?: boolean;
  /** ADR 0596 (`WFAU-2`) — a MODEL authored this workflow. `chip--ai` is
   *  DESIGN.md §5.3's model-provenance token, already the house pattern across
   *  CMS / documents / sharing / memory; the one surface whose entire output is
   *  machine-written was the one with no chip. Colour is never the only signal:
   *  the chip carries its own text label, like every sibling. */
  authoredVia?: string;
  /** ADR 0482 — daily budget + today's folded spend (chip renders only when
   *  a budget exists; spend includes debug/eval — disclosed in the tooltip). */
  budget?: { dailyUsd: number; hardCap: boolean };
  spentTodayUsd?: number;
}
import { AlertIcon, LockIcon, MoreHorizontalIcon, WorkflowIcon } from '../ui/icons/index.js';
import { InfoTip } from '../ui/InfoTip.js';
import i18n from '../i18n/index.js';
import { formatNumber, formatDate, formatUsd } from '../i18n/format.js';

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return i18n.t('builder:relativeJustNow');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return i18n.t('builder:relativeMinutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return i18n.t('builder:relativeHoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  if (days < 30) return i18n.t('builder:relativeDaysAgo', { count: days });
  return formatDate(iso);
}

/** The dense sub-line from REAL fields — node count + the relative timestamp.
 *  Shared by Card meta + Row sub-line so the two views never diverge. */
export function workflowSubLine(wf: WorkflowListItem, t: TFunction): string {
  return `${t('nodeCount', { count: wf.nodeCount })} · ${t('updatedRelative', {
    time: formatRelativeTime(wf.updatedAt),
  })}`;
}

export interface WorkflowCardActions {
  menuOpen: boolean;
  onMenuToggle(): void;
  renaming: boolean;
  onRenameStart(): void;
  onRenameCommit(name: string): void;
  onRenameCancel(): void;
  onOpen(): void;
  onAssign(): void;
  onDuplicate(): void;
  onDelete(): void;
  onExport(): void;
  /** ADR 0482 — opens the Set-budget dialog (dashboard-owned, like rename). */
  onSetBudget(): void;
  /** ADR 0369 — the workflow's archived state drives the menu verb + chip. */
  archived: boolean;
  onArchiveToggle(): void;
}

interface CardProps extends WorkflowCardActions {
  wf: WorkflowListItem;
  /** ADR 0476 — this workflow's fleet-stats row (absent = no runs in window). */
  stats?: WorkflowCardStats | undefined;
}

/** The slice of the fleet-stats row the cards render. */
export interface WorkflowCardStats {
  successRate: number | null;
  p95Ms: number | null;
  costUsdTotal: number;
  topFailures: Array<{ nodeId: string; label?: string; count: number }>;
}

/** ADR 0476 — the per-card stat chips (shared by Card + Row): success rate
 *  (labeled + toned, never color alone), p95 duration, window cost, and the
 *  top failure hotspot by node. Renders nothing without stats. */
function WorkflowStatChips({ stats, workflowId }: { stats?: WorkflowCardStats | undefined; workflowId: string }): JSX.Element | null {
  const { t } = useTranslation('builder');
  if (!stats) return null;
  // ux-review H4 — never round failures out of existence: with any failure
  // in the window, the chip caps at 99% (a "100% success" beside a failure
  // hotspot is the headline number lying).
  const rawPct = stats.successRate !== null ? Math.round(stats.successRate * 100) : null;
  const hasFailures = stats.topFailures.length > 0 || (stats.successRate !== null && stats.successRate < 1);
  const pct = rawPct !== null && hasFailures ? Math.min(99, rawPct) : rawPct;
  return (
    <>
      {pct !== null ? (
        <span className={`chip ${pct >= 90 ? 'chip--success' : pct >= 50 ? 'chip--warning' : 'chip--danger'} u-fs-10`} title={t('statsSuccessTitle')}>
          {t('statsSuccess', { pct })}
        </span>
      ) : null}
      {stats.p95Ms !== null ? (
        <span className="chip chip--muted u-fs-10" title={t('statsP95Title')}>{t('statsP95', { s: formatNumber(stats.p95Ms / 1000, { maximumFractionDigits: 1 }) })}</span>
      ) : null}
      {stats.costUsdTotal > 0 ? (
        <span className="chip chip--muted u-fs-10" title={t('statsCostTitle')}>{formatUsd(stats.costUsdTotal)}</span>
      ) : null}
      {stats.topFailures.length > 0 ? (
        // Grade-ux #5 — the hotspot is a RAIL, not an inert label: it opens
        // the builder with the failure heatmap already lit.
        <Link
          to={`/builder/${encodeURIComponent(workflowId)}?heatmap=1`}
          className="chip chip--danger u-fs-10"
          title={`${t('statsHotspotTitle')} (${stats.topFailures[0]!.nodeId})`}
          onClick={(e) => e.stopPropagation()}
        >
          {stats.topFailures[0]!.label
            ? t('statsHotspot', { node: stats.topFailures[0]!.label, count: stats.topFailures[0]!.count })
            : t('statsHotspotAnonymous', { count: stats.topFailures[0]!.count })}
        </Link>
      ) : null}
    </>
  );
}

/** ADR 0482 — the per-card budget chip: spent-today / budget with warn (≥80%)
 *  and danger (≥100%) registers; the InfoTip owns the "includes debug/eval
 *  spend" disclosure so it reaches keyboard/SR users (ux-5). A hard cap shows
 *  a visible lock glyph + sr "capped" text; at/over budget an alert glyph
 *  backs the color so color is never the only signal. Renders nothing
 *  without a budget. */
function WorkflowBudgetChip({ wf }: { wf: WorkflowListItem }): JSX.Element | null {
  const { t } = useTranslation('builder');
  if (!wf.budget || !(wf.budget.dailyUsd > 0)) return null;
  const spent = wf.spentTodayUsd ?? 0;
  // ux-12 — threshold on the raw amounts, not a rounded percentage (a 79.6%
  // spend must not wear the warning register because Math.round said 80).
  const over = spent >= wf.budget.dailyUsd;
  const warn = spent >= 0.8 * wf.budget.dailyUsd;
  const tone = over ? 'chip--danger' : warn ? 'chip--warning' : 'chip--muted';
  const pct = Math.round((spent / wf.budget.dailyUsd) * 100);
  return (
    <InfoTip
      label={t('budgetChipTipAria')}
      text={`${t('budgetChipTitle', { pct })}${wf.budget.hardCap ? ` ${t('budgetChipHardCapTitle')}` : ''}`}
    >
      <span className={`chip ${tone} u-fs-10`}>
        {over ? <AlertIcon size={11} aria-hidden /> : null}
        {t('budgetChip', { spent: formatUsd(spent), budget: formatUsd(wf.budget.dailyUsd) })}
        {wf.budget.hardCap ? (
          <>
            <LockIcon size={11} aria-hidden />
            <span className="sr-only">{t('budgetChipCappedAria')}</span>
          </>
        ) : null}
      </span>
    </InfoTip>
  );
}

/** The kebab menu shared by Card + Row: rename / duplicate / export / delete. */
function WorkflowMenu({
  menuOpen,
  onMenuToggle,
  onRenameStart,
  onAssign,
  onDuplicate,
  onDelete,
  onExport,
  onSetBudget,
  archived,
  onArchiveToggle,
}: Pick<
  WorkflowCardActions,
  'menuOpen' | 'onMenuToggle' | 'onRenameStart' | 'onAssign' | 'onDuplicate' | 'onDelete' | 'onExport' | 'onSetBudget' | 'archived' | 'onArchiveToggle'
>) {
  const { t } = useTranslation('builder');
  // BLD-11: role=menu keyboard contract — Escape closes (returning focus to the
  // kebab), ↑↓ rove, first item focused on open. Outside-click close already
  // exists at the card level.
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const root = menuRef.current;
    const items = (): HTMLElement[] => Array.from(root?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onMenuToggle(); // toggles closed — the kebab owns open state
        root?.querySelector<HTMLElement>('.workflow-card-menu-btn')?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen, onMenuToggle]);
  return (
    <div className="workflow-card-menu" ref={menuRef}>
      <Button
        variant="secondary" className="workflow-card-menu-btn"
        aria-label={t('workflowActions')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          onMenuToggle();
        }}
      >
        <MoreHorizontalIcon size={16} aria-hidden />
      </Button>
      {menuOpen && (
        <div className="workflow-card-menu-popover" role="menu">
          <Button variant="primary" role="menuitem" onClick={(e) => { e.stopPropagation(); onRenameStart(); }}>
            {t('rename')}
          </Button>
          <Button variant="primary" role="menuitem" onClick={(e) => { e.stopPropagation(); onAssign(); }}>
            {t('assignToMenuItem')}
          </Button>
          <Button variant="primary" role="menuitem" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}>
            {t('duplicate')}
          </Button>
          <Button variant="primary" role="menuitem" onClick={(e) => { e.stopPropagation(); onExport(); }}>
            {t('exportJson')}
          </Button>
          <Button variant="primary" role="menuitem" onClick={(e) => { e.stopPropagation(); onSetBudget(); }}>
            {t('setBudgetMenuItem')}
          </Button>
          <Button variant="primary" role="menuitem" onClick={(e) => { e.stopPropagation(); onArchiveToggle(); }}>
            {archived ? t('unarchive') : t('archive')}
          </Button>
          <button
            type="button"
            role="menuitem"
            className="workflow-card-menu-danger"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
          >
            {t('common:delete')}
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkflowCard({
  stats,
  wf,
  menuOpen,
  onMenuToggle,
  renaming,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onOpen,
  onAssign,
  onDuplicate,
  onDelete,
  onExport,
  onSetBudget,
  archived,
  onArchiveToggle,
}: CardProps) {
  const { t } = useTranslation('builder');

  return (
    <div className="workflow-card">
      {/* DSA-019 (ADR 0510 Phase 1): the open action is a REAL <button> — the
          title stretched over the card via CSS (.workflow-card-open::after) —
          instead of a focusable aria-labelled generic <div> (ARIA naming is
          prohibited/ignored on generic elements). Sibling controls (menu, links,
          chips) sit ABOVE the overlay (z-index), so nothing nests inside an
          interactive role and full-card click still works. */}
      <div className="workflow-card-title-row">
        {renaming ? (
          <RenameInput
            initialValue={wf.name}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <h3 className="workflow-card-title">
            <button
              type="button"
              className="workflow-card-open"
              aria-label={t('openWorkflowAria', { name: wf.name })}
              onClick={onOpen}
            >
              {wf.name}
            </button>
          </h3>
        )}
        {wf.transient ? <span className="chip chip--muted">{t('draftChip')}</span> : null}
        {wf.authoredVia ? <span className="chip chip--ai" title={t('aiAuthoredChipTitle')}>{t('aiAuthoredChip')}</span> : null}
        {wf.publishedBehindHead ? <span className="chip chip--warning" title={t('unpublishedChangesTitle')}>{t('unpublishedChanges')}</span> : null}
        {archived ? <span className="chip chip--muted">{t('archivedChip')}</span> : null}
        <WorkflowMenu
          menuOpen={menuOpen}
          onMenuToggle={onMenuToggle}
          onRenameStart={onRenameStart}
          onAssign={onAssign}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onExport={onExport}
          onSetBudget={onSetBudget}
          archived={archived}
          onArchiveToggle={onArchiveToggle}
        />
      </div>
      <div className="workflow-card-meta muted">
        <span>{t('nodeCount', { count: wf.nodeCount })}</span>
        <span aria-hidden="true">·</span>
        <span title={wf.updatedAt}>{t('updatedRelative', { time: formatRelativeTime(wf.updatedAt) })}</span>
        <span aria-hidden="true">·</span>
        <Link to={`/runs?q=${encodeURIComponent(wf.id)}`} onClick={(e) => e.stopPropagation()} title={t('viewRunsTitle')}>{t('viewRuns')}</Link>
      </div>
      <div className="u-flex u-items-center u-gap-1 u-wrap">
        <WorkflowStatChips stats={stats} workflowId={wf.id} />
        <WorkflowBudgetChip wf={wf} />
      </div>
    </div>
  );
}

export function WorkflowRow({
  stats,
  wf,
  menuOpen,
  onMenuToggle,
  renaming,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onOpen,
  onAssign,
  onDuplicate,
  onDelete,
  onExport,
  onSetBudget,
  archived,
  onArchiveToggle,
}: CardProps) {
  const { t } = useTranslation('builder');
  return (
    <div className="list-row">
      <button
        type="button"
        className="list-row-id"
        title={t('openWorkflowAria', { name: wf.name })}
        disabled={renaming}
        onClick={onOpen}
      >
        <WorkflowIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            {renaming ? (
              <RenameInput
                initialValue={wf.name}
                onCommit={onRenameCommit}
                onCancel={onRenameCancel}
              />
            ) : (
              <span className="list-row-name">{wf.name}</span>
            )}
          </span>
          <span className="list-row-sub">
            {workflowSubLine(wf, t)}
            {wf.transient ? <> <span className="chip chip--muted">{t('draftChip')}</span></> : null}
            {wf.authoredVia ? <> <span className="chip chip--ai" title={t('aiAuthoredChipTitle')}>{t('aiAuthoredChip')}</span></> : null}
            {wf.publishedBehindHead ? <> <span className="chip chip--warning" title={t('unpublishedChangesTitle')}>{t('unpublishedChanges')}</span></> : null}
            {archived ? <> <span className="chip chip--muted">{t('archivedChip')}</span></> : null}
          </span>
        </span>
      </button>
      <div className="list-row-meta">
        <span>{t('nodeCount', { count: wf.nodeCount })}</span>
        <span title={wf.updatedAt}>{t('updatedRelative', { time: formatRelativeTime(wf.updatedAt) })}</span>
        <WorkflowStatChips stats={stats} workflowId={wf.id} />
        <WorkflowBudgetChip wf={wf} />
      </div>
      <div className="list-row-actions action-bar">
        <Button variant="secondary" size="sm" onClick={onOpen}>{t('openWorkflowAction')}</Button>
        <WorkflowMenu
          menuOpen={menuOpen}
          onMenuToggle={onMenuToggle}
          onRenameStart={onRenameStart}
          onAssign={onAssign}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onExport={onExport}
          onSetBudget={onSetBudget}
          archived={archived}
          onArchiveToggle={onArchiveToggle}
        />
      </div>
    </div>
  );
}

interface RenameInputProps {
  initialValue: string;
  onCommit(name: string): void;
  onCancel(): void;
}

/**
 * Uncontrolled rename input. Parent remounts via `renaming` toggle so
 * `defaultValue` always reflects the live name. The committed ref
 * suppresses the blur→commit race when Enter triggers unmount before
 * blur fires.
 */
function RenameInput({ initialValue, onCommit, onCancel }: RenameInputProps) {
  const committed = useRef(false);

  function commit(value: string) {
    if (committed.current) return;
    committed.current = true;
    onCommit(value);
  }

  return (
    <input
      autoFocus
      className="workflow-card-rename-input"
      defaultValue={initialValue}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(e.currentTarget.value);
        else if (e.key === 'Escape') {
          committed.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}
