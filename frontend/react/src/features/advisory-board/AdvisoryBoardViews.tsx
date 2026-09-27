/**
 * Advisory-board Card + Row — the two cells of the §4.5 collection-view canon
 * (rule 11) for the Board of Advisors MANAGEMENT page. The Card fills a
 * `.card-grid` (the discovery default — preserving today's stacked-board feel);
 * the Row fills a `.surface-card.list-view` (the dense fleet view). Both derive
 * their @@handle/visibility/count chips + sub-line from the SAME helpers below,
 * so the grid and list views never diverge (the `subLine` precedent on
 * `/agents`). Composed from existing primitives — no bespoke CSS.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import { Button } from '../../ui/Button.js';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ScaleIcon, FlagIcon, FolderIcon, TrashIcon } from '../../ui/icons/index.js';
import { type AdvisoryBoard } from './advisoryBoardClient.js';

/** The handlers a board card/row needs — the page owns the actual client calls. */
export interface BoardActions {
  /** ADR 0278 — open (ensure-or-join) the board's canonical conversation. */
  onOpenChat: (b: AdvisoryBoard) => void;
  /** The board whose chat is currently being opened (busy state), or null. */
  openingChatBoardId: string | null;
  onEdit: (b: AdvisoryBoard) => void;
  onClone: (b: AdvisoryBoard) => void;
  onDeleteRequest: (b: AdvisoryBoard) => void;
}

/** The contextual one-liner from REAL fields — the disclaimer, else an advisor
 *  summary. Shared by Card + Row. */
function boardSubLine(b: AdvisoryBoard, t: TFunction): string {
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

function BoardRowActions({ b, t, onOpenChat, openingChatBoardId, onEdit, onClone, onDeleteRequest }: { b: AdvisoryBoard; t: TFunction } & BoardActions): JSX.Element {
  const opening = openingChatBoardId === b.boardId;
  return (
    <>
      <Button variant="quiet" size="sm" disabled={opening} aria-busy={opening} onClick={() => onOpenChat(b)} title={t('openBoardChatLabel', { name: b.name })}>{opening ? t('openingChatAction') : t('openChatAction')}</Button>
      <Button variant="quiet" size="sm" onClick={() => onEdit(b)} title={t('editBoardLabel', { name: b.name })}>{t('editAction')}</Button>
      <Button variant="quiet" size="sm" onClick={() => onClone(b)} title={t('cloneBoardLabel', { name: b.name })}>{t('cloneAction')}</Button>
      <Button variant="quiet" size="sm" onClick={() => onDeleteRequest(b)} aria-label={t('deleteBoardLabel', { name: b.name })} title={t('deleteBoardLabel', { name: b.name })}><TrashIcon size={14} aria-hidden /></Button>
    </>
  );
}

export function AdvisoryBoardCard({ board: b, onOpenChat, openingChatBoardId, onEdit, onClone, onDeleteRequest }: { board: AdvisoryBoard } & BoardActions): JSX.Element {
  const { t } = useTranslation('advisory-board');
  return (
    <div className="surface-card u-grid u-gap-2">
      <div className="action-bar u-items-center u-gap-2">
        <h2 className="u-fs-16 u-m-0">{b.name}</h2>
        <BoardChips b={b} t={t} />
        <div className="u-flex u-gap-1 u-ml-auto">
          <BoardRowActions b={b} t={t} onOpenChat={onOpenChat} openingChatBoardId={openingChatBoardId} onEdit={onEdit} onClone={onClone} onDeleteRequest={onDeleteRequest} />
        </div>
      </div>
      {b.disclaimer ? <p className="u-fs-12 muted">{b.disclaimer}</p> : null}
    </div>
  );
}

export function AdvisoryBoardRow({ board: b, onOpenChat, openingChatBoardId, onEdit, onClone, onDeleteRequest }: { board: AdvisoryBoard } & BoardActions): JSX.Element {
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
        <BoardRowActions b={b} t={t} onOpenChat={onOpenChat} openingChatBoardId={openingChatBoardId} onEdit={onEdit} onClone={onClone} onDeleteRequest={onDeleteRequest} />
      </div>
    </div>
  );
}
