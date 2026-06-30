/**
 * AssignedColumn — the "Assigned to me" live mirror (ADR 0049), folded into the
 * personal board (ADR 0025) as a synthetic LEFTMOST column rather than a
 * standalone `/my-work` page (correction 2026-06-16).
 *
 * The cards here live on OTHER boards (any board where `assigneeId == me`, or a
 * role I hold). This is a derived view over the same records — no copies. They
 * are therefore READ-ONLY in this column: no drag, no lane actions. Each card
 * links to its origin board to progress it (assignment grants the card-scoped
 * access, D4); a role-addressed (unclaimed) card shows a Claim action.
 *
 * Rendered by `KanbanPage` ONLY when the active board is the caller's personal
 * board, and ONLY when it holds open cards — otherwise the column collapses
 * away entirely (the parent renders nothing).
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckSquareIcon, InboxIcon, InfoIcon } from '../ui/icons/index.js';
import { IconButton } from '../ui/IconButton.js';
import type { AssignedCard } from './kanbanClient.js';

const ASSIGNED_HINT = 'A cross-board, read-only view of cards assigned to you. Open a card on its origin board to work it.';

export function AssignedColumn({
  cards,
  busyId,
  highlightId,
  onClaim,
}: {
  cards: readonly AssignedCard[];
  busyId: string | null;
  highlightId: string | null;
  onClaim: (cardId: string) => void;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const highlightRef = useRef<HTMLLIElement | null>(null);

  // Scroll the notification deep-linked card (`/boards?card=<id>`) into view
  // once it has rendered in the rail.
  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlightId, cards]);

  return (
    <div className="kb-col kb-col--assigned">
      <div className="kb-col-head">
        <span className="kb-col-name">
          <InboxIcon size={13} aria-hidden /> {t('assignedToMe')}
          <IconButton label={ASSIGNED_HINT} icon={<InfoIcon size={13} />} />
        </span>
        <span className="kb-col-count">{cards.length}</span>
      </div>
      <p className="muted u-fs-12 u-mt-1">{ASSIGNED_HINT}</p>
      <ul className="u-list-none u-grid u-gap-2">
        {cards.map((card) => {
          const highlighted = card.id === highlightId;
          const unclaimed = Boolean(card.assigneeRole) && !card.assigneeId;
          return (
            <li
              key={card.id}
              ref={highlighted ? highlightRef : undefined}
              className={`surface-card kb-card${highlighted ? ' kb-assigned--highlight' : ''}`}
            >
              <div className="u-fw-600 u-fs-13">{card.title}</div>
              <div className="u-flex u-gap-1 u-wrap u-items-center u-mt-1">
                <span className="chip chip--muted">{card.columnName}</span>
                {unclaimed ? (
                  <span className="chip chip--warning">{t('unclaimedWithRole', { role: card.assigneeRole })}</span>
                ) : null}
                {card.priority === 'high' ? <span className="chip chip--danger kb-prio">{t('priorityHigh')}</span> : null}
              </div>
              {card.assignmentReason ? (
                <div className="muted u-fs-12 u-mt-1">{card.assignmentReason}</div>
              ) : null}
              <div className="kb-card-foot">
                {unclaimed ? (
                  <button
                    type="button"
                    className="btn-accent-solid btn-sm u-iflex u-items-center u-gap-1"
                    disabled={busyId === card.id}
                    onClick={() => onClaim(card.id)}
                  >
                    <CheckSquareIcon size={12} aria-hidden /> {busyId === card.id ? t('claiming') : t('claim')}
                  </button>
                ) : null}
                <span className="kb-card-foot-spacer" />
                <Link to={`/boards?board=${encodeURIComponent(card.boardId)}`} className="kb-run-link" title={t('openOnBoard', { board: card.boardName })}>
                  {t('boardArrow', { board: card.boardName })}
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
