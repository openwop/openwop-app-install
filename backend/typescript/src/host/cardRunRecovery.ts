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
 * TOLERATE-ON-READ. ADR 0963 D3: a restored card comes back HELD (a machine
 * note the loop will not pick past); a person releases it by clearing the note.
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
  applyBoardCommand,
  RESTORE_NOTE_MARK,
  getBoard,
  getCard,
  isPreconditionFailure,
  notifyBoardChanged,
  recordCardRunStatus,
  releaseCardClaim,
  todoColumnOf,
  workingColumnOf,
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

/** ADR 0774 D3 — the keys whose card gets a run STATUS stamp: the two loop
 *  pick paths plus the human trigger-lane run (`metadata.kanban`, stamped by
 *  `kanbanTriggerDelivery.ts`). Deliberately wider than `CARD_METADATA_KEYS`:
 *  showing a human-triggered run's outcome is honest, but RESTORING that card
 *  into the loop's To Do lane would hand a human's card to the agent. */
const STATUS_METADATA_KEYS = ['heartbeat', 'approval', 'kanban'] as const;

/** ADR 0774 D2 — a claimed card whose run row does not exist yet may simply be
 *  mid-start on another instance (the claim CAS lands before
 *  `startWorkflowRun` writes the row). Reconcile leaves it alone for this long
 *  after the claim; a claim whose process died is then restored. Far above any
 *  observed start latency. */
export const PICK_CLAIM_GRACE_MS = 2 * 60_000;
interface CardPointer {
  boardId: string;
  cardId: string;
}

/** Extract the card pointer a pick path stamped onto the run, if any. */
export function cardPointerFromRunMetadata(
  metadata: unknown,
  keys: readonly string[] = CARD_METADATA_KEYS,
): CardPointer | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const bag = metadata as Record<string, unknown>;
  for (const key of keys) {
    const entry = bag[key];
    if (typeof entry !== 'object' || entry === null) continue;
    const { boardId, cardId } = entry as Record<string, unknown>;
    if (typeof boardId === 'string' && boardId && typeof cardId === 'string' && cardId) {
      return { boardId, cardId };
    }
  }
  return null;
}

/** A column the work loop treats as "in flight" (the lane a pick moves into) —
 *  resolved by lane KIND (ADR 0774 D1), so a default board's `doing` counts. */
const workingColumn = workingColumnOf;

/** The lane a restored card returns to — the same one the loop picks FROM, so
 *  restored work is genuinely back in the queue rather than parked somewhere
 *  the agent never looks. */
const todoColumn = todoColumnOf;

/** The instruction every hold note ends with — the release is the existing
 *  card edit, so the note itself tells a person how (ADR 0963 D3). */
const RELEASE_HINT = 'Clear this note to let the agent pick it up again.';

/**
 * Why a restore happened, rendered onto the card. Every restore HOLDS the card
 * (ADR 0963 D3): the loop does not retry what stopped, a person decides.
 *
 * `cancelled` is worded neutrally (ADR 0963 A2): a run is cancelled by a person,
 * by a workflow deletion, by an eval or by a contract cut, and the note must not
 * blame any of them. ADR 0535 D4 objected to blaming, not to recording the stop.
 */
function restoreNote(status: RunTerminalStatus, runId: string): string | null {
  if (status === 'failed') {
    return `${RESTORE_NOTE_MARK} Held — its run failed (${runId}). ${RELEASE_HINT}`;
  }
  if (status === 'cancelled') {
    return `${RESTORE_NOTE_MARK} Held — its run was cancelled (${runId}). ${RELEASE_HINT}`;
  }
  return null;
}

/**
 * The note for a card whose run row is GONE (ADR 0535 RI-WL-2).
 *
 * Unlike a failure we observed, here the outcome is genuinely unknown — so the
 * note says so, and the card is held like any other restore (ADR 0963 D3).
 */
function unknownOutcomeNote(runId: string): string {
  return `${RESTORE_NOTE_MARK} Held — its run (${runId}) is no longer on record, so the outcome is unknown. ${RELEASE_HINT}`;
}

/**
 * ADR 0963 D3 — the ONE "held" predicate. A To Do card carrying the machine
 * restore mark is not picked by the work loop (daemon or manual Check now) and
 * is not ranked by the preview. A person releases it by clearing the note; the
 * human-authored part of a note never holds a card.
 */
export function isHeldForReview(card: Pick<KanbanCard, 'blockerNote'>): boolean {
  return typeof card.blockerNote === 'string' && card.blockerNote.includes(RESTORE_NOTE_MARK);
}

/** The human-authored lines of a blocker note, with every machine line removed. */
function humanPartOf(existing: string | undefined): string {
  return (existing ?? '')
    .split('\n')
    .filter((line) => line.trim() && !line.includes(RESTORE_NOTE_MARK))
    .join('\n')
    .trim();
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
  const human = humanPartOf(existing);
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

  // ONE preconditioned CAS (grade-code KSCD-1): the checks above read a
  // snapshot, and another pass may have restored and RE-CLAIMED this card
  // since. The move, the note and the outcome land together, and only if the
  // fresh card still points at this run in the working lane. The move's
  // trigger directive is not acted on — see the module header: restoring must
  // never re-dispatch the workflow that just died.
  const note = restoreNote(status, runId);
  const moved = await releaseCardClaim({
    cardId: card.id,
    boardId: board.id,
    tenantId: board.tenantId,
    runId,
    workingColumnId: working.id,
    toColumnId: todo.id,
    // The card is back in the queue carrying its run's outcome; the next pick
    // stamps a fresh one.
    lastRunStatus: status,
    ...(note ? { blockerNote: composeBlockerNote(card.blockerNote, note) } : {}),
    // ADR 0963 A1 — the note above was composed from a snapshot; a person's edit
    // that landed since must not be overwritten. A lost race leaves the card in
    // Working and the next reconcile retries from a fresh read.
    expectedBlockerNote: card.blockerNote,
  });
  if (!moved) return false;

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

  // One preconditioned CAS, as in `restoreCardForRun` (KSCD-1).
  const moved = await releaseCardClaim({
    cardId: card.id,
    boardId: board.id,
    tenantId: board.tenantId,
    runId: card.lastRunId,
    workingColumnId: working.id,
    toColumnId: todo.id,
    lastRunStatus: null,
    blockerNote: composeBlockerNote(card.blockerNote, unknownOutcomeNote(card.lastRunId)),
    expectedBlockerNote: card.blockerNote, // ADR 0963 A1
  });
  if (!moved) return false;
  notifyBoardChanged(board.id);
  log.warn('restored card whose run row is gone (retention); outcome unknown', {
    cardId: card.id, boardId: board.id, runId: card.lastRunId,
  });
  return true;
}

/**
 * ADR 0963 D4 — strip the machine restore lines from a card whose run `runId`
 * completed, keeping any human text.
 *
 * Its own write (A1): conditioned on the card still pointing at the run AND on
 * the note being the one read, so a person's concurrent edit is never
 * overwritten. One retry from a fresh read covers an unrelated edit racing it.
 * Returns whether it wrote.
 */
export async function clearRestoreNote(cardId: string, runId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const card = await getCard(cardId);
    if (!card || card.lastRunId !== runId || !isHeldForReview(card)) return false;
    const board = await getBoard(card.boardId);
    if (!board) return false;
    const seen = card.blockerNote;
    try {
      await applyBoardCommand({
        type: 'card.patch',
        tenantId: board.tenantId,
        boardId: board.id,
        cardId,
        patch: { blockerNote: humanPartOf(seen) },
        precondition: (fresh) => fresh.lastRunId === runId && fresh.blockerNote === seen,
      });
      return true;
    } catch (err) {
      if (!isPreconditionFailure(err)) throw err;
    }
  }
  return false;
}

/** Stamp a run's terminal status onto the card its metadata points at, if that
 *  card is in the run's tenant and still points at the run. Best-effort: a
 *  stamp failure must not stop the restore that follows. */
async function stampRunStatus(
  runTenantId: string,
  metadata: unknown,
  runId: string,
  status: RunTerminalStatus,
): Promise<void> {
  const pointer = cardPointerFromRunMetadata(metadata, STATUS_METADATA_KEYS);
  if (!pointer) return;
  try {
    const board = await getBoard(pointer.boardId);
    // Same tenant gate as the restore below: a corrupted pointer must never
    // write to another tenant's card.
    if (!board || board.tenantId !== runTenantId) return;
    const card = await getCard(pointer.cardId);
    if (!card || card.boardId !== board.id) return;
    const stamped = await recordCardRunStatus(card.id, runId, status);
    // ADR 0963 D4 — a completed run makes a restore note false ("outcome
    // unknown", "its run failed"). Cleared independently of the status stamp,
    // which no-ops when reconcile already wrote `completed` (A1).
    const cleared = status === 'completed' && (await clearRestoreNote(card.id, runId));
    if (stamped || cleared) notifyBoardChanged(board.id);
  } catch (err) {
    log.warn('card run-status stamp failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }
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
  const run = await storage.getRun(runId);
  if (!run) return false;

  // ADR 0774 D3 — stamp the outcome onto the card FIRST, for every status and
  // every card-bound run. This is what makes "finished" durable: once retention
  // deletes the run row, the card still says `completed`, so reconcile will not
  // mistake it for lost work and run it again (`KSTWF-3`).
  await stampRunStatus(run.tenantId, run.metadata, runId, status);
  if (status === 'completed') return false;

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

  if (await restoreCardForRun(card, board, runId, status)) return true;
  // ADR 0963 A1 — the restore lost a race with a person's note edit (or another
  // writer). Only an agent board is ever reconciled again (the heartbeat pass),
  // so a card on any other board would strand in Working: retry ONCE from a
  // fresh read. Every guard in `restoreCardForRun` re-applies to the new card.
  const fresh = await getCard(pointer.cardId);
  return fresh ? restoreCardForRun(fresh, board, runId, status) : false;
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
  now: number = Date.now(),
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
      // ADR 0774 D3 correction (A1) — but "terminal" includes COMPLETED, and a
      // completed run's card stays in Working by design. Restoring every card
      // whose row is gone re-ran finished work (`KSTWF-3`), and once D1 made a
      // default board's `doing` lane the working lane it would also have swept
      // up human cards and every legacy card. So only a card the LOOP put in
      // flight is restored: its `lastRunStatus` is still `running` (the pick
      // claim and the approval dispatch are the only writers), meaning no
      // terminal stamp ever landed. And never inside the claim's grace window,
      // when the row may simply not be written yet.
      if (card.lastRunStatus !== 'running') continue;
      if (now - Date.parse(card.updatedAt) < PICK_CLAIM_GRACE_MS) continue;
      if (await restoreStrandedUnknown(card, board)) restored += 1;
      continue;
    }
    // ADR 0774 A1 — only a run the loop started for THIS card may move it.
    const pointer = cardPointerFromRunMetadata(run.metadata);
    if (!pointer || pointer.cardId !== card.id || pointer.boardId !== board.id) continue;
    if (run.status === 'completed') {
      // The terminal fan-out may have been missed (process died mid-emit).
      // Stamp it now so the outcome outlives the row.
      const stamped = await recordCardRunStatus(card.id, card.lastRunId!, 'completed');
      const cleared = await clearRestoreNote(card.id, card.lastRunId!); // ADR 0963 D4
      if (stamped || cleared) notifyBoardChanged(board.id);
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
