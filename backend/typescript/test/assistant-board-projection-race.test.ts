/**
 * ADR 0862 D4 (`COS2WF-3`) — two concurrent board projections of one commitment mint ONE card.
 *
 * `projectCommitmentToBoard` read `kanbanCardId`, created a card, then blind-wrote the
 * back-ref. Two callers in flight (the `assistant.populate-board` chat tool and the palette
 * node) both saw no back-ref, both created a card, and the later write orphaned the earlier
 * card on the board — a duplicate the principal then had to find and delete by hand.
 *
 * What each case proves, and the sabotage that turns it red (grade-tests w11):
 *  - two concurrent projections → one card: the in-loop "another card won ⇒ drop ours and
 *    reuse it" branch (`current.kanbanCardId !== card.id` forced false → 2 cards / no reuse).
 *  - the two LOST-SWAP cases force their window deterministically. A plain `Promise.all`
 *    never interleaves there (the competing write finishes before the projection's
 *    get→compareAndSwap), so the first draft of both cases passed with the lost-swap
 *    handling sabotaged. A one-shot hook on `DurableCollection.compareAndSwap` now lands
 *    the competing write between the read and the swap:
 *      · unrelated update vs the projection's back-ref swap — red when a lost swap is
 *        treated as a lost race (card deleted, null returned);
 *      · projection vs an ingest upsert's swap — red when the upsert writes a stale spread
 *        or clears `kanbanCardId` (COS2C-3).
 *  - foreign board refused (COS2C-1): red when the tenant check is dropped.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetAssistantStore,
  getCommitment,
  projectCommitmentToBoard,
  updateCommitment,
  upsertCommitmentBySource,
} from '../src/features/assistant/assistantService.js';
import { createBoard, listCards } from '../src/host/kanbanService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18998, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
});

afterEach(() => vi.restoreAllMocks());

/** Runs `hook` ONCE, immediately before the first commitment compareAndSwap that `match`
 *  selects — i.e. after that writer read the row and before it swaps — so the competing
 *  write lands inside the read→swap window. Returns a probe of whether it fired. */
function openSwapWindow(match: (expected: unknown, next: Record<string, unknown>) => boolean, hook: () => Promise<unknown>): { fired: () => boolean } {
  const orig = DurableCollection.prototype.compareAndSwap;
  let pending: (() => Promise<unknown>) | null = hook;
  vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: DurableCollection<unknown>, expected: unknown, next: unknown) {
    const n = next as Record<string, unknown>;
    if (pending && typeof n.commitmentId === 'string' && match(expected, n)) {
      const run = pending;
      pending = null;
      await run();
    }
    return orig.call(this, expected, next);
  });
  return { fired: () => pending === null };
}

const source = (id: string) => ({ kind: 'manual' as const, externalId: id, contentHash: `h-${id}`, capturedAt: '2026-01-01T00:00:00.000Z' });

describe('D4 — the board projection cannot mint two cards', () => {
  it('two projections in flight leave exactly one card, and the back-ref names it', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'Work' });
    const { commitment } = await upsertCommitmentBySource(TENANT, { owner: { kind: 'self' }, description: 'Send the Q3 deck', source: source('race-1') });

    const [a, b] = await Promise.all([
      projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: board.id }),
      projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: board.id }),
    ]);

    const cards = (await listCards(board.id)).filter((c) => c.sourceLabel === `assistant:commitment:${commitment.commitmentId}`);
    expect(cards).toHaveLength(1);
    const backRef = (await getCommitment(TENANT, commitment.commitmentId))?.kanbanCardId;
    expect(backRef).toBe(cards[0]!.id);
    // Exactly one caller created it; the other reused the winner's card.
    expect([a?.created, b?.created].filter(Boolean)).toHaveLength(1);
    expect(a?.card?.id).toBe(cards[0]!.id);
    expect(b?.card?.id).toBe(cards[0]!.id);
  });

  it('a swap lost to an UNRELATED row update keeps the card (it is not a competing card) — window forced', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'Work 2' });
    const { commitment } = await upsertCommitmentBySource(TENANT, { owner: { kind: 'self' }, description: 'Book the offsite', source: source('race-2') });
    // The unrelated update lands between the projection's read and its back-ref swap.
    const window = openSwapWindow(
      (expected, next) => next.commitmentId === commitment.commitmentId && typeof next.kanbanCardId === 'string'
        && !(expected as { kanbanCardId?: string } | null)?.kanbanCardId,
      () => updateCommitment(TENANT, commitment.commitmentId, { dueAt: '2026-12-01T00:00:00.000Z' }),
    );
    const projected = await projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: board.id });
    expect(window.fired(), 'the read→swap window must actually have been opened').toBe(true);
    const cards = (await listCards(board.id)).filter((c) => c.sourceLabel === `assistant:commitment:${commitment.commitmentId}`);
    expect(cards).toHaveLength(1);
    expect(projected?.created).toBe(true);
    expect(projected?.card?.id).toBe(cards[0]!.id);
    const row = await getCommitment(TENANT, commitment.commitmentId);
    expect(row?.kanbanCardId).toBe(cards[0]!.id);
    // …and the retried swap did not overwrite the update that beat it.
    expect(row?.dueAt).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('grade-code — an ingest re-tick cannot erase the back-ref a projection just wrote', () => {
  it('a source upsert racing the projection keeps kanbanCardId, so the next projection reuses the card — window forced', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'Work 3' });
    const input = { owner: { kind: 'self' as const }, description: 'Prep the board pack', source: source('race-3') };
    const { commitment } = await upsertCommitmentBySource(TENANT, input);
    // The projection (card + back-ref) lands between the ingest upsert's read and its swap,
    // so the upsert's swap is against a stale row: the pre-COS2C-3 blind spread erased the
    // back-ref here.
    let projectedCardId: string | undefined;
    const window = openSwapWindow(
      (_expected, next) => next.commitmentId === commitment.commitmentId && next.confidence === 0.9,
      async () => { projectedCardId = (await projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: board.id }))?.card?.id; },
    );
    await upsertCommitmentBySource(TENANT, { ...input, confidence: 0.9 });
    expect(window.fired(), 'the read→swap window must actually have been opened').toBe(true);
    expect(projectedCardId).toBeTruthy();
    const row = await getCommitment(TENANT, commitment.commitmentId);
    expect(row?.kanbanCardId).toBe(projectedCardId);
    expect(row?.confidence).toBe(0.9); // the upsert landed too — it re-read, it did not lose
    const again = await projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: board.id });
    expect(again?.created).toBe(false);
    expect((await listCards(board.id)).filter((c) => c.sourceLabel === `assistant:commitment:${commitment.commitmentId}`)).toHaveLength(1);
  });
});

describe('grade-code Blocker — a projection never writes onto ANOTHER tenant\'s board', () => {
  it('a foreign boardId is refused: no card, no back-ref', async () => {
    const foreign = await createBoard({ tenantId: 'org:someone-else', name: 'Their board' });
    const { commitment } = await upsertCommitmentBySource(TENANT, { owner: { kind: 'self' }, description: 'Plant a card', source: source('xt-1') });
    const out = await projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: foreign.id });
    expect(out).toBeNull();
    expect(await listCards(foreign.id)).toHaveLength(0);
    expect((await getCommitment(TENANT, commitment.commitmentId))?.kanbanCardId).toBeUndefined();
  });

  it('the tenant\'s own board still works (negative control)', async () => {
    const own = await createBoard({ tenantId: TENANT, name: 'Mine' });
    const { commitment } = await upsertCommitmentBySource(TENANT, { owner: { kind: 'self' }, description: 'My card', source: source('xt-2') });
    expect((await projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: own.id }))?.created).toBe(true);
  });
});
