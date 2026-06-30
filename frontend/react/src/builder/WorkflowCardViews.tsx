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

import { useRef } from 'react';
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
}
import { MoreHorizontalIcon, WorkflowIcon } from '../ui/icons/index.js';
import i18n from '../i18n/index.js';
import { formatDate } from '../i18n/format.js';

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
}

interface CardProps extends WorkflowCardActions {
  wf: WorkflowListItem;
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
}: Pick<
  WorkflowCardActions,
  'menuOpen' | 'onMenuToggle' | 'onRenameStart' | 'onAssign' | 'onDuplicate' | 'onDelete' | 'onExport'
>) {
  const { t } = useTranslation('builder');
  return (
    <div className="workflow-card-menu">
      <button
        type="button"
        className="workflow-card-menu-btn secondary"
        aria-label={t('workflowActions')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(e) => {
          e.stopPropagation();
          onMenuToggle();
        }}
      >
        <MoreHorizontalIcon size={16} aria-hidden />
      </button>
      {menuOpen && (
        <div className="workflow-card-menu-popover" role="menu">
          <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); onRenameStart(); }}>
            {t('rename')}
          </button>
          <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); onAssign(); }}>
            {t('assignToMenuItem')}
          </button>
          <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}>
            {t('duplicate')}
          </button>
          <button type="button" role="menuitem" onClick={(e) => { e.stopPropagation(); onExport(); }}>
            {t('exportJson')}
          </button>
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
}: CardProps) {
  const { t } = useTranslation('builder');
  function onCardKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (renaming) return;
    // Only act on keystrokes targeting the card itself, not bubbled from
    // child <button>s — Enter/Space on the kebab or a menu item must not
    // also navigate to the canvas.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }

  return (
    <div
      className="workflow-card"
      // NOT role="button": the card contains its own menu <button> + rename
      // input, and an interactive role can't nest interactive controls
      // (axe nested-interactive). It stays a focusable, keyboard-operable
      // region (tabIndex + onKeyDown → open) with an aria-label, so full-card
      // click AND keyboard both work without the invalid nesting.
      aria-label={t('openWorkflowAria', { name: wf.name })}
      tabIndex={renaming ? -1 : 0}
      onClick={(e) => {
        if (renaming) return;
        // Ignore clicks that originated inside the menu region.
        if (e.target instanceof Element && e.target.closest('.workflow-card-menu')) return;
        onOpen();
      }}
      onKeyDown={onCardKey}
    >
      <div className="workflow-card-title-row">
        {renaming ? (
          <RenameInput
            initialValue={wf.name}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <h3 className="workflow-card-title">{wf.name}</h3>
        )}
        <WorkflowMenu
          menuOpen={menuOpen}
          onMenuToggle={onMenuToggle}
          onRenameStart={onRenameStart}
          onAssign={onAssign}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onExport={onExport}
        />
      </div>
      <div className="workflow-card-meta muted">
        <span>{t('nodeCount', { count: wf.nodeCount })}</span>
        <span aria-hidden="true">·</span>
        <span title={wf.updatedAt}>{t('updatedRelative', { time: formatRelativeTime(wf.updatedAt) })}</span>
      </div>
    </div>
  );
}

export function WorkflowRow({
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
          <span className="list-row-sub">{workflowSubLine(wf, t)}</span>
        </span>
      </button>
      <div className="list-row-meta">
        <span>{t('nodeCount', { count: wf.nodeCount })}</span>
        <span title={wf.updatedAt}>{t('updatedRelative', { time: formatRelativeTime(wf.updatedAt) })}</span>
      </div>
      <div className="list-row-actions action-bar">
        <button type="button" className="secondary btn-sm" onClick={onOpen}>{t('openWorkflowAction')}</button>
        <WorkflowMenu
          menuOpen={menuOpen}
          onMenuToggle={onMenuToggle}
          onRenameStart={onRenameStart}
          onAssign={onAssign}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onExport={onExport}
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
