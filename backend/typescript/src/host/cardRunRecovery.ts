/**
 * ADR 0535 P2 — a picked card's lifecycle gets an owner.
 *
 * The autonomous work loop moves a To Do card to Working when it starts a run
 * (`heartbeatService.ts`, and `approvalDecision.ts` on the approved-proposal
 * path). Before this module, NOTHING moved it back on any terminal outcome:
 * the run recovered (dispatch sweeper + ADR 0532 dead-letter) but the work item
 * never returned to the pick path, so a crashed run silently removed work from
 * the board forever.
 *
 * This subscribes to the ADR 0535 P1 global run-terminal seam and RESTORES the
 * card — the fourth disposition beside ADR 0288's PRUNE / DISABLE /
 * TOLERATE-ON-READ.
 *
 * Two design points carry the whole module:
 *
 *   1. **Point lookup, never a scan.** Both entry points stamp `{boardId,
 *      cardId}` into `run.metadata` (`metadata.heartbeat` and
 *      `metadata.approval`), so recovery is one `getRun` + one `getCard`.
 *      Finding the card by scanning for `lastRunId` would put a full
 *      cross-tenant `DurableCollection.list()` on every terminal run — the hot
 *      path ADR 0534 D5 explicitly budgets against. `lastRunId` is the GUARD,
 *      not the lookup key.
 *
 *   2. **`moveCard`'s trigger directive is deliberately discarded.** To Do is
 *      precisely the column that may carry `triggerWorkflowId`, so acting on
 *      the directive would re-run the just-failed workflow immediately —
 *      bypassing the agent-policy verdict, the autonomous run budget, and the
 *      propose gate. Every programmatic caller already ignores it; only the
 *      human drag path (`routes/kanban.ts`) acts on it.
 *
 * The in-process fan-out is not a delivery guarantee (a process that dies
 * inside the terminal-emit window fires nothing anywhere), so the same restore
 * is ALSO reachable from `reconcileStrandedCards`, which the heartbeat pass
 * calls with cards it already has in hand. That turns the residue from a
 * permanent strand into a bounded lag of at most one heartbeat interval, at
 * zero extra scan cost. See ADR 0535 D1a.
 */

import type { Storage } from '../storage/storage.js';
import { onAnyRunTerminal, type RunTerminalStatus } from '../executor/runLifecycle.js';
import {
  getBoard,
  getCard,
  moveCard,
  updateCardFields,
  notifyBoardChanged,
  type KanbanCard,
  type KanbanBoard,
} from './kanbanService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('cardRunRecovery');

/** Registry key — repeat boots overwrite rather than accumulate. */
const RECOVERY_KEY = 'card-run-recovery';

/** Most in-flight cards reconciled per board per pass. Bounded by WIP in
 *  practice, but a board that accumulated hundreds of stranded cards would
 *  otherwise issue hundreds of point reads on the loop's hot path. Anything
 *  skipped is LOGGED — a silent truncation would read as "nothing stranded". */
const RECONCILE_BATCH = 25;

/** The run-metadata keys the two pick paths stamp their card pointer under.
 *  Both must be read: covering only `heartbeat` would silently never recover a
 *  card picked through an approved proposal (ADR 0535 D5). */
const CARD_METADATA_KEYS = ['heartbeat', 'approval'] as const;

interface CardPointer {
  boardId: string;
  cardId: string;
}

/** Extract the card pointer a pick path stamped onto the run, if any. */
export function cardPointerFromRunMetadata(metadata: unknown): CardPointer | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const bag = metadata as Record<string, unknown>;
  for (const key of CARD_METADATA_KEYS) {
    const entry = bag[key];
    if (typeof entry !== 'object' || entry === null) continue;
    const { boardId, cardId } = entry as Record<string, unknown>;
    if (typeof boardId === 'string' && boardId && typeof cardId === 'string' && cardId) {
      return { boardId, cardId };
    }
  }
  return null;
}

/** A column the work loop treats as "in flight" (the lane a pick moves into). */
function workingColumn(board: KanbanBoard): { id: string } | undefined {
  return board.columns.find((c) => c.id === 'working' || c.name.toLowerCase() === 'working');
}

/** The lane a restored card returns to — the same one the loop picks FROM, so
 *  restored work is genuinely back in the queue rather than parked somewhere
 *  the agent never looks. */
function todoColumn(board: KanbanBoard): { id: string } | undefined {
  return board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do');
}

/** A STABLE marker, not the prose. Matching on the sentence would break the
 *  moment the copy is reworded or localized — prior machine notes would stop
 *  being recognised and would silently stack up in a one-line field. */
const RESTORE_NOTE_MARK = '[auto:run-restore]';

/**
 * Why a restore happened, rendered onto the card. `cancelled` carries NO note:
 * the run was stopped deliberately by a human, and a failure note would
 * misreport that as a fault (ADR 0535 D4 correction).
 */
function restoreNote(status: RunTerminalStatus, runId: string): string | null {
  if (status === 'failed') {
    return `${RESTORE_NOTE_MARK} Returned to To Do — its run failed (${runId}).`;
  }
  return null;
}

/**
 * The note for a card whose run row is GONE (ADR 0535 RI-WL-2).
 *
 * Unlike a failure we observed, here the outcome is genuinely unknown — so the
 * note says so. It also earns the card the `blocked` COST criterion in ADR 0534's
 * ranking, which is the point: the work returns to the queue but yields to
 * healthy work instead of jumping the line, and a human sees why.
 */
function unknownOutcomeNote(runId: string): string {
  return `${RESTORE_NOTE_MARK} Returned to To Do — its run (${runId}) is no longer on record, so the outcome is unknown. Check before re-running.`;
}

/**
 * Compose the note WITHOUT destroying what a human wrote.
 *
 * `blockerNote` is user-authored ("waiting on legal"); blindly overwriting it
 * would silently delete a person's content on a path they never triggered. An
 * existing note is preserved and the machine reason appended. A previous
 * MACHINE note is replaced rather than stacked, so a card that fails repeatedly
 * does not grow an unbounded log in a one-line field.
 */
export function composeBlockerNote(existing: string | undefined, added: string): string {
  const human = (existing ?? '')
    .split('\n')
    .filter((line) => line.trim() && !line.includes(RESTORE_NOTE_MARK))
    .join('\n')
    .trim();
  return human ? `${human}\n${added}` : added;
}

/**
 * Restore one card if — and only if — it is still the one this run owns.
 *
 * The `lastRunId` guard is what makes this idempotent (a run emits
 * `run.dead_lettered` then `run.failed`; the second pass finds the card already
 * moved), race-safe (a card manually moved on, or re-picked with a newer run,
 * has a different `lastRunId`), fork-safe (a `:fork` carries the parent's
 * metadata verbatim but gets a NEW runId, so it can never yank the origin
 * card), and non-adversarial (a workflow that correctly moved its own card has
 * already changed `columnId`, so this no-ops).
 *
 * Returns whether a restore actually happened.
 */
async function restoreCardForRun(
  card: KanbanCard,
  board: KanbanBoard,
  runId: string,
  status: RunTerminalStatus,
): Promise<boolean> {
  if (card.lastRunId !== runId) return false;

  const working = workingColumn(board);
  if (!working || card.columnId !== working.id) return false;

  const todo = todoColumn(board);
  if (!todo) return false;

  // The returned trigger directive is DISCARDED on purpose — see the module
  // header. Restoring must never re-dispatch the workflow that just died.
  await moveCard(card.id, todo.id);

  const note = restoreNote(status, runId);
  if (note) await updateCardFields(card.id, { blockerNote: composeBlockerNote(card.blockerNote, note) });

  notifyBoardChanged(board.id);
  log.info('restored stranded card to To Do', { cardId: card.id, boardId: board.id, runId, status });
  return true;
}

/**
 * Restore a card whose run row no longer exists. Same column/ownership guards as
 * `restoreCardForRun`, but keyed on the card's own `lastRunId` (there is no run
 * to compare against) and annotated as unknown-outcome.
 */
async function restoreStrandedUnknown(card: KanbanCard, board: KanbanBoard): Promise<boolean> {
  const working = workingColumn(board);
  const todo = todoColumn(board);
  if (!working || !todo || card.columnId !== working.id || !card.lastRunId) return false;

  await moveCard(card.id, todo.id); // trigger directive discarded — see the module header
  await updateCardFields(card.id, {
    blockerNote: composeBlockerNote(card.blockerNote, unknownOutcomeNote(card.lastRunId)),
  });
  notifyBoardChanged(board.id);
  log.warn('restored card whose run row is gone (retention); outcome unknown', {
    cardId: card.id, boardId: board.id, runId: card.lastRunId,
  });
  return true;
}

/**
 * The seam handler: a run went terminal — return its card to the pick path.
 * `completed` is deliberately inert: a run finishing does not mean the task is
 * done (that is the workflow's to declare), and auto-advancing would silently
 * close work no human accepted.
 */
export async function recoverCardForTerminalRun(
  storage: Storage,
  runId: string,
  status: RunTerminalStatus,
): Promise<boolean> {
  if (status === 'completed') return false;

  const run = await storage.getRun(runId);
  if (!run) return false;

  const pointer = cardPointerFromRunMetadata(run.metadata);
  if (!pointer) return false; // not a work-loop run — nothing owns a card here

  const [card, board] = await Promise.all([getCard(pointer.cardId), getBoard(pointer.boardId)]);
  if (!card || !board) return false;

  // Tenant gate. The pointer is written by this host's own pick paths, so a
  // mismatch should be impossible — which is exactly why it must be checked
  // rather than assumed: a corrupted or hand-edited `run.metadata` would
  // otherwise move ANOTHER tenant's card.
  if (board.tenantId !== run.tenantId) {
    log.warn('refusing cross-tenant card restore', {
      runId, runTenant: run.tenantId, boardTenant: board.tenantId, boardId: board.id,
    });
    return false;
  }
  // The card must belong to the board we just authorised, not merely exist.
  if (card.boardId !== board.id) return false;

  return restoreCardForRun(card, board, runId, status);
}

/**
 * Lazy reconciliation backstop (ADR 0535 D1a). The heartbeat pass already holds
 * every card on the board, so checking the in-flight ones costs no extra scan —
 * only a point `getRun` per card actually sitting in Working.
 *
 * This is what makes the ADR's durability claim true: the in-process fan-out
 * above misses a run whose process died mid-terminal-emit, and without this the
 * card would strand exactly as it did before ADR 0535.
 *
 * Returns how many cards were restored.
 */
export async function reconcileStrandedCards(
  storage: Storage,
  board: KanbanBoard,
  cards: readonly KanbanCard[],
): Promise<number> {
  const working = workingColumn(board);
  if (!working) return 0;

  const inFlight = cards.filter((c) => c.columnId === working.id && c.lastRunId);
  if (inFlight.length > RECONCILE_BATCH) {
    log.warn('stranded-card reconcile capped for this pass', {
      boardId: board.id, inFlight: inFlight.length, examined: RECONCILE_BATCH,
    });
  }

  let restored = 0;
  for (const card of inFlight.slice(0, RECONCILE_BATCH)) {
    const run = await storage.getRun(card.lastRunId!);
    if (!run) {
      // A MISSING run row means the run reached TERMINAL. Verified twice, not
      // assumed: `removalAt` is stamped only on a terminal transition
      // (storage/runRetentionStamp.ts), and the sweeper re-checks terminality
      // before deleting (host/runRetentionSweeper.ts) — a non-terminal run with
      // a stray stamp has it CLEARED rather than being swept. So retention can
      // never delete a live run, and a card waiting on a vanished one is
      // stranded forever.
      //
      // Earlier this `continue`d, on the reasoning that restoring might re-run
      // work that had actually completed. That trades a recoverable cost
      // (redoing something) for an unrecoverable one (losing it silently), and
      // it was the last permanent-strand path left in ADR 0535. Restore it —
      // but say the outcome is unknown, which also sinks it in the ADR 0534
      // ranking so it yields to healthy work.
      if (await restoreStrandedUnknown(card, board)) restored += 1;
      continue;
    }
    if (run.status !== 'failed' && run.status !== 'cancelled') continue;
    if (await restoreCardForRun(card, board, card.lastRunId!, run.status)) restored += 1;
  }
  return restored;
}

/** Register the recovery handler at boot. Keyed, so a repeat boot overwrites. */
export function registerCardRunRecovery(storage: Storage): void {
  onAnyRunTerminal(RECOVERY_KEY, async (runId, status) => {
    await recoverCardForTerminalRun(storage, runId, status);
  });
}
