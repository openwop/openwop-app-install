/**
 * Advisory-board Card + Row — the two cells of the §4.5 collection-view canon
 * (rule 11) for the Board of Advisors MANAGEMENT page. The Card fills a
 * `.card-grid` (the discovery default — preserving today's stacked-board feel,
 * incl. the rich per-board `<SharedKnowledgeControls>` sub-panel); the Row fills
 * a `.surface-card.list-view` (the dense fleet view — NO sub-panel). Both derive
 * their @@handle/visibility/count chips + sub-line from the SAME helpers below,
 * so the grid and list views never diverge (the `subLine` precedent on
 * `/agents`). Composed from existing primitives — no bespoke CSS.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ScaleIcon, FlagIcon, FolderIcon, BookOpenIcon, CheckIcon, TrashIcon } from '../../ui/icons/index.js';
import { toast } from '../../ui/toast.js';
import {
  getSharedKnowledge, setSharedKnowledge,
  type AdvisoryBoard, type SharedKnowledgeItem,
} from './advisoryBoardClient.js';

/** The handlers a board card/row needs — the page owns the actual client calls. */
export interface BoardActions {
  onEdit: (b: AdvisoryBoard) => void;
  onClone: (b: AdvisoryBoard) => void;
  onDeleteRequest: (b: AdvisoryBoard) => void;
}

/** The contextual one-liner from REAL fields — the disclaimer, else an advisor
 *  summary. Shared by Card + Row. */
export function boardSubLine(b: AdvisoryBoard, t: TFunction): string {
  return b.disclaimer || t('advisorsCount', { count: b.advisors.length });
}

/** Handle + visibility + advisor/context counts — shared by Card + Row. */
function BoardChips({ b, t }: { b: AdvisoryBoard; t: TFunction }): JSX.Element {
  const strategyN = (b.contextRefs ?? []).filter((r) => r.kind === 'strategy').length;
  const projectN = (b.contextRefs ?? []).filter((r) => r.kind === 'project').length;
  return (
    <>
      <span className="chip chip--accent">@@{b.handle}</span>
      <span className={`chip ${b.visibility === 'shared' ? 'chip--success' : 'chip--muted'}`}>{b.visibility}</span>
      <span className="chip chip--muted">{t('advisorsCount', { count: b.advisors.length })}</span>
      {strategyN > 0 ? <span className="chip chip--accent"><FlagIcon size={11} aria-hidden /> {t('strategyContextCount', { count: strategyN })}</span> : null}
      {projectN > 0 ? <span className="chip chip--accent"><FolderIcon size={11} aria-hidden /> {t('projectContextCount', { count: projectN })}</span> : null}
    </>
  );
}

function BoardRowActions({ b, t, onEdit, onClone, onDeleteRequest }: { b: AdvisoryBoard; t: TFunction } & BoardActions): JSX.Element {
  return (
    <>
      <button type="button" className="ghost btn-sm" onClick={() => onEdit(b)} title={t('editBoardLabel', { name: b.name })}>{t('editAction')}</button>
      <button type="button" className="ghost btn-sm" onClick={() => onClone(b)} title={t('cloneBoardLabel', { name: b.name })}>{t('cloneAction')}</button>
      <button type="button" className="ghost btn-sm" onClick={() => onDeleteRequest(b)} aria-label={t('deleteBoardLabel', { name: b.name })} title={t('deleteBoardLabel', { name: b.name })}><TrashIcon size={14} aria-hidden /></button>
    </>
  );
}

export function AdvisoryBoardCard({ board: b, onEdit, onClone, onDeleteRequest }: { board: AdvisoryBoard } & BoardActions): JSX.Element {
  const { t } = useTranslation('advisory-board');
  return (
    <div className="surface-card u-grid u-gap-2">
      <div className="action-bar u-items-center u-gap-2">
        <h2 className="u-fs-16 u-m-0">{b.name}</h2>
        <BoardChips b={b} t={t} />
        <div className="u-flex u-gap-1 u-ml-auto">
          <BoardRowActions b={b} t={t} onEdit={onEdit} onClone={onClone} onDeleteRequest={onDeleteRequest} />
        </div>
      </div>
      {b.disclaimer ? <p className="u-fs-12 muted">{b.disclaimer}</p> : null}
      <SharedKnowledgeControls boardId={b.boardId} />
    </div>
  );
}

export function AdvisoryBoardRow({ board: b, onEdit, onClone, onDeleteRequest }: { board: AdvisoryBoard } & BoardActions): JSX.Element {
  const { t } = useTranslation('advisory-board');
  return (
    <div className="list-row">
      <button type="button" className="list-row-id" onClick={() => onEdit(b)} title={t('editBoardLabel', { name: b.name })}>
        <ScaleIcon size={18} aria-hidden />
        <span className="list-row-name-wrap">
          <span className="list-row-name-line">
            <span className="list-row-name">{b.name}</span>
          </span>
          <span className="list-row-sub">{boardSubLine(b, t)}</span>
        </span>
      </button>
      <div className="list-row-meta">
        <BoardChips b={b} t={t} />
      </div>
      <div className="list-row-actions action-bar">
        <BoardRowActions b={b} t={t} onEdit={onEdit} onClone={onClone} onDeleteRequest={onDeleteRequest} />
      </div>
    </div>
  );
}

/**
 * "Shared knowledge" (ADR 0100 D2) — give every advisor on the board access to a
 * managed planning KB ('Strategy KB' / 'Priority Matrix KB') by binding it to each
 * advisor's profile (the per-agent knowledge binding, applied board-wide). Hidden
 * when KB is off (the managed collections don't exist). Lives ONLY in the grid/card
 * view — a rich per-board panel that doesn't belong in a dense row.
 */
function SharedKnowledgeControls({ boardId }: { boardId: string }): JSX.Element | null {
  const { t } = useTranslation('advisory-board');
  const kbEnabled = true; // KB always-on (toggle removed)
  const [items, setItems] = useState<SharedKnowledgeItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!kbEnabled) return undefined;
    let live = true;
    getSharedKnowledge(boardId).then((x) => { if (live) setItems(x); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [boardId, kbEnabled]);
  if (!kbEnabled || !items || items.length === 0) return null;
  const toggle = async (kind: SharedKnowledgeItem['kind'], shared: boolean): Promise<void> => {
    setBusy(true);
    try { setItems(await setSharedKnowledge(boardId, kind, shared)); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="u-flex u-gap-2 u-items-center u-flex-wrap">
      <span className="u-label-sm u-flex u-items-center u-gap-1"><BookOpenIcon size={13} aria-hidden /> {t('sharedKnowledgeLabel')}</span>
      {items.map((it) => (
        <button
          key={it.kind}
          type="button"
          disabled={busy || (it.shareable === false && !it.shared)}
          className={`chip ${it.shared ? 'chip--success' : 'chip--muted'}`}
          aria-pressed={it.shared}
          title={
            it.shareable === false && !it.shared
              ? t('sharedKnowledgeEmptyTitle', { kind: t(`sharedKind_${it.kind}`) })
              : t(it.shared ? 'sharedKnowledgeOnTitle' : 'sharedKnowledgeOffTitle', { kind: t(`sharedKind_${it.kind}`) })
          }
          onClick={() => void toggle(it.kind, !it.shared)}
        >
          {it.shared ? <CheckIcon size={11} aria-hidden /> : null} {t(`sharedKind_${it.kind}`)}
        </button>
      ))}
    </div>
  );
}
