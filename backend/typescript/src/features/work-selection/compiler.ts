/**
 * ADR 0534 P1 — work-selection policy: WHICH card the autonomous loop takes next.
 *
 * Before this, selection was strictly oldest-filed-first: `kanbanService.listCards`
 * sorts by `(columnId, order)`, `order` is append-position, and the heartbeat takes
 * the first runnable match. `card.priority` existed but was read only to decide
 * whether to ask a human — never to order. A `high` card filed today waited behind
 * every `low` card ever filed.
 *
 * This module is deliberately SMALL, because the ranking engine already exists:
 * `host/weightedScoring.ts` (hoisted in P0) owns aggregation, and this contributes
 * only the two things that are actually policy —
 *
 *   1. `WORK_SELECTION_CRITERIA` — which factors matter and their relative weight;
 *   2. `projectCardScores` — how a card's intrinsic fields map onto the engine's
 *      1..10 band.
 *
 * Both are pure: no I/O, no clock read except the `now` the caller passes, no
 * randomness. That is what makes the ordering rules testable without a database,
 * a board, or a run — the thing the inline `for`-loop never was.
 *
 * ## Where the weights come from
 *
 * Taskwarrior's urgency model is the best-tested prior art for exactly this
 * problem (a personal work queue ranked by intrinsic task fields). Its published
 * coefficients are due-date 12.0, priority 6.0/3.9/1.8, age 2.0, blocked 8.0. The
 * weights below keep those PROPORTIONS on our engine's 1..10 weight scale rather
 * than inventing a fresh set.
 * @see https://taskwarrior.org/docs/urgency/
 *
 * Age being a first-class term is the load-bearing borrow: it is what stops a
 * pure ranking from starving the permanent tail, without a separate aging
 * mechanism to build and tune (ADR 0534 OQ-2).
 *
 * ## The 0-means-unscored trap
 *
 * `computePriority` treats a criterion scored 0 as UNSCORED and lets it drag the
 * item to the bottom. So every projection here returns >= 1: "this card has no due
 * date" must read as *low urgency*, never as *no data*. Getting this wrong would
 * sink every undated card below every dated one permanently, which for most boards
 * means almost everything.
 */

import type { KanbanCard } from '../../host/kanbanService.js';
import type { CriteriaSet } from '../../host/weightedScoring.js';

/** Criterion ids. Exported so tests and the reason-renderer share one vocabulary. */
export const WS_CRITERION = {
  urgency: 'ws.urgency',
  priority: 'ws.priority',
  age: 'ws.age',
  blocked: 'ws.blocked',
} as const;

/**
 * The built-in work-selection criteria set.
 *
 * `aggregation: 'weighted-sum'` (not `ratio`): the ratio family divides by an
 * effort/size criterion, and a card carries no reliable effort estimate
 * (`estimateHours` is optional and usually absent), so a ratio model would divide
 * by a mostly-missing number.
 */
export const WORK_SELECTION_CRITERIA: CriteriaSet = {
  aggregation: 'weighted-sum',
  criteria: [
    {
      id: WS_CRITERION.urgency,
      name: 'Due-date urgency',
      description: 'How close (or past) the due date is. Overdue work outranks everything else.',
      weight: 10,
      direction: 'benefit',
      scaleHint: '10 = overdue, 5 = due this week, 2 = no due date',
    },
    {
      id: WS_CRITERION.blocked,
      name: 'Blocked',
      description:
        'A card carrying a blocker note. Costed, so blocked work sinks — including a card ' +
        'ADR 0535 just restored after its run failed, which is what damps a crash loop.',
      weight: 7,
      direction: 'cost',
      scaleHint: '10 = blocked, 1 = clear',
    },
    {
      id: WS_CRITERION.priority,
      name: 'Stated priority',
      description: "The human's own priority flag on the card.",
      weight: 5,
      direction: 'benefit',
      scaleHint: '10 = high, 5 = normal, 2 = low',
    },
    {
      id: WS_CRITERION.age,
      name: 'Age',
      description:
        'Days since the card was filed. Present so a pure ranking cannot starve the ' +
        'permanent tail — the anti-starvation term, not a tiebreaker.',
      weight: 2,
      direction: 'benefit',
      scaleHint: '10 = 30+ days old, 1 = filed today',
    },
  ],
};

const DAY_MS = 86_400_000;

/** Clamp into the engine's scored band. Never 0 — see the module header. */
const band = (n: number): number => Math.min(10, Math.max(1, Math.round(n)));

/**
 * Due-date urgency. Overdue saturates at 10; an undated card scores low (2) rather
 * than neutral, matching Taskwarrior's semantics where no due date contributes no
 * urgency. The `age` criterion is what keeps such cards from starving.
 */
export function urgencyScore(card: KanbanCard, now: number): number {
  if (!card.dueAt) return 2;
  const due = Date.parse(card.dueAt);
  if (Number.isNaN(due)) return 2; // an unparseable date is no information, not urgency
  const daysUntil = (due - now) / DAY_MS;
  if (daysUntil <= 0) return 10; // overdue
  if (daysUntil >= 14) return 3;
  // 0 days -> 10, 14 days -> 3, linear between.
  return band(10 - (daysUntil / 14) * 7);
}

/** Stated priority. An unset priority reads as `normal`, not as missing. */
export function priorityScore(card: KanbanCard): number {
  if (card.priority === 'high') return 10;
  if (card.priority === 'low') return 2;
  return 5;
}

/** Age in days, saturating at 30. The anti-starvation term. */
export function ageScore(card: KanbanCard, now: number): number {
  const created = Date.parse(card.createdAt);
  if (Number.isNaN(created)) return 1;
  const days = Math.max(0, (now - created) / DAY_MS);
  if (days >= 30) return 10;
  return band(1 + (days / 30) * 9);
}

/**
 * Blocked, as a COST. A non-empty blocker note drags the card down.
 *
 * This is also how crash-loop damping falls out for free: ADR 0535 writes a
 * blocker note when it restores a card whose run failed, so a repeatedly-failing
 * card sinks on its own without a bespoke retry damper. Clearing the note (a human
 * saying "this is fine now") restores its rank.
 */
export function blockedScore(card: KanbanCard): number {
  return card.blockerNote && card.blockerNote.trim().length > 0 ? 10 : 1;
}

/**
 * Project one card onto the criteria set. Pure — `now` is supplied, never read,
 * so the same card at the same instant always ranks identically (a hard
 * requirement for the ADR 0534 D3 replay stamp to mean anything).
 */
export function projectCardScores(card: KanbanCard, now: number): Record<string, number> {
  return {
    [WS_CRITERION.urgency]: urgencyScore(card, now),
    [WS_CRITERION.priority]: priorityScore(card),
    [WS_CRITERION.age]: ageScore(card, now),
    [WS_CRITERION.blocked]: blockedScore(card),
  };
}
