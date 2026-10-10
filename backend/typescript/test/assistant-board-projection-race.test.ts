/**
 * ADR 0862 D4 (`COS2WF-3`) — two concurrent board projections of one commitment mint ONE card.
 *
 * `projectCommitmentToBoard` read `kanbanCardId`, created a card, then blind-wrote the
 * back-ref. Two callers in flight (the `assistant.populate-board` chat tool and the palette
 * node) both saw no back-ref, both created a card, and the later write orphaned the earlier
 * card on the board — a duplicate the principal then had to find and delete by hand.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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

const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18998, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
});

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

  it('a swap lost to an UNRELATED row update keeps the card (it is not a competing card)', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'Work 2' });
    const { commitment } = await upsertCommitmentBySource(TENANT, { owner: { kind: 'self' }, description: 'Book the offsite', source: source('race-2') });
    const [projected] = await Promise.all([
      projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: board.id }),
      updateCommitment(TENANT, commitment.commitmentId, { dueAt: '2026-12-01T00:00:00.000Z' }),
    ]);
    const cards = (await listCards(board.id)).filter((c) => c.sourceLabel === `assistant:commitment:${commitment.commitmentId}`);
    expect(cards).toHaveLength(1);
    expect(projected?.created).toBe(true);
    expect((await getCommitment(TENANT, commitment.commitmentId))?.kanbanCardId).toBe(cards[0]!.id);
  });
});

describe('grade-code — an ingest re-tick cannot erase the back-ref a projection just wrote', () => {
  it('a source upsert racing the projection keeps kanbanCardId, so the next projection reuses the card', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'Work 3' });
    const input = { owner: { kind: 'self' as const }, description: 'Prep the board pack', source: source('race-3') };
    const { commitment } = await upsertCommitmentBySource(TENANT, input);
    await Promise.all([
      projectCommitmentToBoard(TENANT, commitment.commitmentId, { boardId: board.id }),
      upsertCommitmentBySource(TENANT, { ...input, confidence: 0.9 }),
    ]);
    expect((await getCommitment(TENANT, commitment.commitmentId))?.kanbanCardId).toBeTruthy();
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
