/**
 * AssignedColumn — the "Assigned to me" live mirror (ADR 0049), folded into the
 * personal board (ADR 0025) as a synthetic LEFTMOST column rather than a
 * standalone `/my-work` page (correction 2026-06-16).
 *
 * The cards here live on OTHER boards (any board where `assigneeId == me`, or a
 * role I hold). This is a derived view over the same records — no copies. No
 * drag here; each card links to its origin board (assignment grants the
 * card-scoped access, D4), and a role-addressed (unclaimed) card shows a Claim
 * action. ADR 1138: a card I hold also offers Done (moves it to its board's
 * completion lane through the same card move a drag makes), an Open link to
 * where its work happens (`sourceRef`), and its due state.
 *
 * Rendered by `KanbanPage` ONLY when the active board is the caller's personal
 * board, and ONLY when it holds open cards — otherwise the column collapses
 * away entirely (the parent renders nothing).
 */

import { CardHandoffNote } from './CardHandoffNote.js';
import { Button } from '../ui/Button.js';
import { useEffect, useRef } from 'react';
import { scrollBehavior } from '../ui/motion.js';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { CheckIcon, CheckSquareIcon, ExternalLinkIcon, InboxIcon } from '../ui/icons/index.js';
import { CardDue } from './CardDue.js';
import type { AssignedCard } from './kanbanClient.js';

export function AssignedColumn({
  cards,
  busyId,
  highlightId,
  onClaim,
  onDone,
}: {
  cards: readonly AssignedCard[];
  busyId: string | null;
  highlightId: string | null;
  onClaim: (cardId: string) => void;
  /** ADR 1138 D2 — finish a card I hold (absent ⇒ no Done button). */
  onDone?: (card: AssignedCard) => void;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const highlightRef = useRef<HTMLLIElement | null>(null);

  // Scroll the notification deep-linked card (`/boards?card=<id>`) into view
  // once it has rendered in the rail.
  useEffect(() => {
    if (highlightId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    }
  }, [highlightId, cards]);

  return (
    <div className="kb-col kb-col--assigned">
      <div className="kb-col-head">
        <span className="kb-col-name">
          <InboxIcon size={13} aria-hidden /> {t('assignedToMe')}
        </span>
        <span className="kb-col-count">{cards.length}</span>
      </div>
      {/* i18n fix (was a hardcoded EN constant serving all 4 locales) + one
          affordance instead of two: the visible hint IS the accessible hint —
          the old info IconButton repeated the same sentence to SR users. */}
      <p className="muted u-fs-12 u-mt-1">{t('assignedHint')}</p>
      <ul className="u-list-none u-grid u-gap-2">
        {cards.map((card) => {
          const highlighted = card.id === highlightId;
          const unclaimed = Boolean(card.assigneeRole) && !card.assigneeId;
          const canFinish = Boolean(onDone) && !unclaimed && !card.terminal && Boolean(card.doneColumnId);
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
                {card.dueAt ? <CardDue dueAt={card.dueAt} finished={card.terminal} /> : null}
              </div>
              {card.assignmentReason ? (
                <div className="muted u-fs-12 u-mt-1">{card.assignmentReason}</div>
              ) : null}
              {card.handoff ? <CardHandoffNote handoff={card.handoff} /> : null}
              <div className="kb-card-foot">
                {unclaimed ? (
                  <Button
                    variant="accent-solid" size="sm" className="u-iflex u-items-center u-gap-1"
                    disabled={busyId === card.id}
                    onClick={() => onClaim(card.id)}
                  >
                    <CheckSquareIcon size={12} aria-hidden /> {busyId === card.id ? t('claiming') : t('claim')}
                  </Button>
                ) : null}
                {canFinish ? (
                  <Button
                    variant="secondary" size="sm" className="u-iflex u-items-center u-gap-1"
                    disabled={busyId === card.id}
                    aria-label={t('markDoneNamed', { title: card.title })}
                    onClick={() => onDone?.(card)}
                  >
                    <CheckIcon size={12} aria-hidden /> {busyId === card.id ? t('markingDone') : t('markDone')}
                  </Button>
                ) : null}
                {card.sourceRef ? (
                  <Link to={card.sourceRef.path} className="kb-run-link u-iflex u-items-center u-gap-1">
                    <ExternalLinkIcon size={12} aria-hidden /> {t('openSource', { label: card.sourceRef.label })}
                  </Link>
                ) : null}
                <span className="kb-card-foot-spacer" />
                <Link to={`/boards/${encodeURIComponent(card.boardId)}?card=${encodeURIComponent(card.id)}`} className="kb-run-link" title={t('openOnBoard', { board: card.boardName })}>
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
