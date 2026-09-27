/**
 * ADR 0535 P2 — a picked card returns to To Do when its run dies.
 *
 * Before this, `moveCard(card, working)` at `heartbeatService.ts` and
 * `approvalDecision.ts` had NO counterpart on any terminal outcome: the run
 * recovered, the work item never did. These assert the restore and, just as
 * importantly, every case where it must NOT fire.
 *
 * The `lastRunId` guard is the load-bearing piece — it is what makes the
 * restore idempotent, race-safe, fork-safe, and unable to fight a workflow that
 * moved its own card. Each of those is a separate test below, because each was
 * a separate way to lose or duplicate a user's work.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import {
  createBoard,
  createCard,
  getCard,
  moveCard,
  setCardLastRun,
  updateCardFields,
  type KanbanBoard,
} from '../src/host/kanbanService.js';
import {
  composeBlockerNote,
  recoverCardForTerminalRun,
  reconcileStrandedCards,
  cardPointerFromRunMetadata,
} from '../src/host/cardRunRecovery.js';
import { _resetRunLifecycle } from '../src/executor/runLifecycle.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';

const T = 'card-recovery-t1';

let storage: Storage;
let board: KanbanBoard;

/** Create a run row carrying the card pointer the pick paths stamp. */
async function seedRun(
  runId: string,
  status: RunRecord['status'],
  metadata: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await storage.insertRun({
    runId,
    tenantId: T,
    workflowId: 'wf-1',
    status,
    inputs: {},
    metadata,
    configurable: {},
    createdAt: now,
    updatedAt: now,
  });
}

/** A card already picked: sitting in Working, stamped with its run. */
async function pickedCard(runId: string, title = 'do the thing'): Promise<string> {
  const card = await createCard({ boardId: board.id, columnId: 'todo', title });
  await setCardLastRun(card.id, runId);
  await moveCard(card.id, 'working');
  return card.id;
}

const heartbeatMeta = (cardId: string) => ({ heartbeat: { boardId: board.id, cardId, source: 'heartbeat' } });
const approvalMeta = (cardId: string) => ({ approval: { boardId: board.id, cardId, source: 'approval' } });

beforeEach(async () => {
  storage = await openStorage('memory://');
  // `DurableCollection` (kanban's store) resolves storage through this seam;
  // without it every board/card write throws at boot-check.
  initHostExtPersistence(storage);
  board = await createBoard({
    tenantId: T,
    name: 'Agent board',
    ownerSubject: { kind: 'agent', id: 'roster-1' },
    columns: [
      { id: 'todo', name: 'To Do' },
      { id: 'working', name: 'Working' },
      { id: 'done', name: 'Done', terminal: true },
    ],
  });
});
afterEach(() => {
  _resetRunLifecycle();
  __resetHostExtPersistence();
});

describe('ADR 0535 P2 — restore on a terminal run', () => {
  it('a failed run returns its card to To Do with a reason', async () => {
    const cardId = await pickedCard('run-1');
    await seedRun('run-1', 'failed', heartbeatMeta(cardId));

    const restored = await recoverCardForTerminalRun(storage, 'run-1', 'failed');

    expect(restored).toBe(true);
    const card = await getCard(cardId);
    expect(card?.columnId, 'the work must return to the lane the loop picks FROM').toBe('todo');
    expect(card?.blockerNote, 'the board must explain itself').toContain('run-1');
  });

  it('covers the APPROVAL path too, not just the heartbeat path', async () => {
    // A fix applied to one entry point and not the other is a bug that reads as
    // fixed — ADR 0535 D5.
    const cardId = await pickedCard('run-2');
    await seedRun('run-2', 'failed', approvalMeta(cardId));

    expect(await recoverCardForTerminalRun(storage, 'run-2', 'failed')).toBe(true);
    expect((await getCard(cardId))?.columnId).toBe('todo');
  });

  it('a cancelled run restores WITHOUT a blame note', async () => {
    const cardId = await pickedCard('run-3');
    await seedRun('run-3', 'cancelled', heartbeatMeta(cardId));

    expect(await recoverCardForTerminalRun(storage, 'run-3', 'cancelled')).toBe(true);
    const card = await getCard(cardId);
    expect(card?.columnId).toBe('todo');
    expect(card?.blockerNote, 'a human stopping the run is not a fault').toBeUndefined();
  });

  it('a completed run leaves the card alone', async () => {
    const cardId = await pickedCard('run-4');
    await seedRun('run-4', 'completed', heartbeatMeta(cardId));

    expect(await recoverCardForTerminalRun(storage, 'run-4', 'completed')).toBe(false);
    expect((await getCard(cardId))?.columnId, 'a run finishing is not the task being done').toBe('working');
  });
});

describe('ADR 0535 P2 — the lastRunId guard', () => {
  it('is idempotent across run.failed then run.dead_lettered', async () => {
    const cardId = await pickedCard('run-5');
    await seedRun('run-5', 'failed', heartbeatMeta(cardId));

    expect(await recoverCardForTerminalRun(storage, 'run-5', 'failed')).toBe(true);
    expect(await recoverCardForTerminalRun(storage, 'run-5', 'failed')).toBe(false);
    expect((await getCard(cardId))?.columnId).toBe('todo');
  });

  it('a stale run cannot yank a card that was re-picked by a newer run', async () => {
    const cardId = await pickedCard('run-old');
    await setCardLastRun(cardId, 'run-new'); // re-picked
    await seedRun('run-old', 'failed', heartbeatMeta(cardId));

    expect(await recoverCardForTerminalRun(storage, 'run-old', 'failed')).toBe(false);
    expect((await getCard(cardId))?.columnId, 'the newer run still owns this card').toBe('working');
  });

  it('a FORKED run never restores the origin card', async () => {
    // `run.metadata` is replayed verbatim on `:fork`, so the fork's metadata
    // points at the parent's card — the guard is the only thing standing
    // between that and a fork stealing the original's work item.
    const cardId = await pickedCard('run-parent');
    await seedRun('run-fork', 'failed', heartbeatMeta(cardId));

    expect(await recoverCardForTerminalRun(storage, 'run-fork', 'failed')).toBe(false);
    expect((await getCard(cardId))?.columnId).toBe('working');
  });

  it('does not fight a workflow that moved its own card', async () => {
    const cardId = await pickedCard('run-6');
    await moveCard(cardId, 'done'); // the workflow declared completion itself
    await seedRun('run-6', 'failed', heartbeatMeta(cardId));

    expect(await recoverCardForTerminalRun(storage, 'run-6', 'failed')).toBe(false);
    expect((await getCard(cardId))?.columnId, 'a well-behaved workflow wins').toBe('done');
  });

  it('ignores a run with no card pointer (an ordinary non-work-loop run)', async () => {
    await seedRun('run-7', 'failed', { something: 'else' });
    expect(await recoverCardForTerminalRun(storage, 'run-7', 'failed')).toBe(false);
  });
});

describe('ADR 0535 D1a — lazy reconciliation backstop', () => {
  it('restores a card whose run died with nobody listening', async () => {
    // The in-process fan-out is not a delivery guarantee: a process that dies
    // inside the terminal-emit window fires nothing on any instance. Without
    // this backstop the card strands exactly as it did before ADR 0535.
    const cardId = await pickedCard('run-8');
    await seedRun('run-8', 'failed', heartbeatMeta(cardId));

    const restored = await reconcileStrandedCards(storage, board, [
      (await getCard(cardId))!,
    ]);

    expect(restored).toBe(1);
    expect((await getCard(cardId))?.columnId).toBe('todo');
  });

  it('leaves a still-running card alone', async () => {
    const cardId = await pickedCard('run-9');
    await seedRun('run-9', 'running', heartbeatMeta(cardId));

    expect(await reconcileStrandedCards(storage, board, [(await getCard(cardId))!])).toBe(0);
    expect((await getCard(cardId))?.columnId).toBe('working');
  });

  it('RESTORES a card whose run row is gone, flagged unknown-outcome (RI-WL-2)', async () => {
    // A missing run row means the run reached TERMINAL: `removalAt` is stamped
    // only on a terminal transition, and the sweeper re-checks terminality
    // before deleting. So retention can never remove a live run, and leaving
    // the card put — the previous behaviour — stranded it permanently.
    //
    // It restores with the outcome marked UNKNOWN rather than silently: that
    // both warns a human and earns the ADR 0534 `blocked` cost criterion, so
    // the card rejoins the queue without jumping ahead of healthy work.
    const cardId = await pickedCard('run-vanished');

    expect(await reconcileStrandedCards(storage, board, [(await getCard(cardId))!])).toBe(1);
    const card = await getCard(cardId);
    expect(card?.columnId, 'losing work silently is worse than redoing it').toBe('todo');
    expect(card?.blockerNote).toContain('outcome is unknown');
    expect(card?.blockerNote).toContain('run-vanished');
  });

  it('an unknown-outcome restore is idempotent across passes', async () => {
    const cardId = await pickedCard('run-vanished-2');
    expect(await reconcileStrandedCards(storage, board, [(await getCard(cardId))!])).toBe(1);
    // Second pass: the card is no longer in Working, so nothing more happens.
    expect(await reconcileStrandedCards(storage, board, [(await getCard(cardId))!])).toBe(0);
  });
});

describe('cardPointerFromRunMetadata', () => {
  it('reads both stamp shapes and rejects everything else', () => {
    expect(cardPointerFromRunMetadata({ heartbeat: { boardId: 'b', cardId: 'c' } })).toEqual({ boardId: 'b', cardId: 'c' });
    expect(cardPointerFromRunMetadata({ approval: { boardId: 'b', cardId: 'c' } })).toEqual({ boardId: 'b', cardId: 'c' });
    expect(cardPointerFromRunMetadata({ heartbeat: { boardId: 'b' } })).toBeNull();
    expect(cardPointerFromRunMetadata({ other: { boardId: 'b', cardId: 'c' } })).toBeNull();
    expect(cardPointerFromRunMetadata(null)).toBeNull();
    expect(cardPointerFromRunMetadata('nope')).toBeNull();
  });
});

describe('ADR 0535 — the restore never destroys user data', () => {
  it("preserves a human's blocker note and appends the machine reason", async () => {
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'legal thing' });
    await updateCardFields(card.id, { blockerNote: 'waiting on legal' });
    await setCardLastRun(card.id, 'run-note-1');
    await moveCard(card.id, 'working');
    await seedRun('run-note-1', 'failed', heartbeatMeta(card.id));

    expect(await recoverCardForTerminalRun(storage, 'run-note-1', 'failed')).toBe(true);

    const note = (await getCard(card.id))?.blockerNote ?? '';
    expect(note, "a person's note must survive a machine write they never triggered").toContain('waiting on legal');
    expect(note).toContain('run-note-1');
  });

  it('replaces a previous machine note rather than stacking them', () => {
    const once = composeBlockerNote(undefined, '[auto:run-restore] failed (r1).');
    const twice = composeBlockerNote(once, '[auto:run-restore] failed (r2).');

    expect(twice).toBe('[auto:run-restore] failed (r2).');
    expect(twice.split('\n')).toHaveLength(1);
  });

  it('keeps the human line while replacing the machine line', () => {
    const withHuman = composeBlockerNote('waiting on legal', '[auto:run-restore] failed (r1).');
    const again = composeBlockerNote(withHuman, '[auto:run-restore] failed (r2).');

    expect(again).toBe('waiting on legal\n[auto:run-restore] failed (r2).');
  });

  it('de-duplicates on the MARKER, not the prose, so reworded copy still collapses', () => {
    // The whole point of a stable marker: change the sentence (or localize it)
    // and prior machine notes must still be recognised, or they stack forever
    // in a one-line field.
    const old = composeBlockerNote('waiting on legal', '[auto:run-restore] Returned to To Do — run failed (r1).');
    const reworded = composeBlockerNote(old, '[auto:run-restore] Devuelto a Por hacer (r2).');

    expect(reworded).toBe('waiting on legal\n[auto:run-restore] Devuelto a Por hacer (r2).');
  });
});

describe('ADR 0535 — tenant gate on the restore', () => {
  it('refuses to restore a card whose board belongs to another tenant', async () => {
    // The pointer is written by this host's own pick paths, so a mismatch should
    // be impossible — which is why it is CHECKED rather than assumed. A corrupted
    // run.metadata must never move another tenant's card.
    const otherBoard = await createBoard({
      tenantId: 'some-other-tenant',
      name: 'Their board',
      ownerSubject: { kind: 'agent', id: 'roster-other' },
      columns: [{ id: 'todo', name: 'To Do' }, { id: 'working', name: 'Working' }],
    });
    const theirCard = await createCard({ boardId: otherBoard.id, columnId: 'todo', title: 'theirs' });
    await setCardLastRun(theirCard.id, 'run-cross');
    await moveCard(theirCard.id, 'working');
    // A run in OUR tenant pointing at THEIR board.
    await seedRun('run-cross', 'failed', {
      heartbeat: { boardId: otherBoard.id, cardId: theirCard.id, source: 'heartbeat' },
    });

    expect(await recoverCardForTerminalRun(storage, 'run-cross', 'failed')).toBe(false);
    expect((await getCard(theirCard.id))?.columnId, 'another tenant\'s card must not move').toBe('working');
  });
});
