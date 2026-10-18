/**
 * ADR 0872 — kanban cards adopt the ADR 0866 tenant index.
 *
 * A card row carried no tenant, so every board read scanned every tenant's
 * cards. Cards are now stamped with their board's tenant on every write (D1),
 * legacy rows are stamped by the hook that runs before each hourly reconcile
 * (D2), and a row that cannot be stamped keeps the index unverified (D3). Once
 * verified, display reads use the index; dedupe/cap/repoint reads keep the
 * exact scan (D4). `rawCard` writes a row the way pre-0872 code (or an old
 * revision during a deploy overlap) did: no `tenantId`, no marker.
 *
 * Red if createCard / a move stops stamping the tenant (probes w37g1-idx-create-stamp,
 * -idx-move-stamp), a card is created without a board (-idx-board-required), the
 * pre-reconcile stamping hook is unregistered (-idx-hook), verified reads stop using
 * the index (-idx-indexed-read), an orphan is stamped/ignored instead of keeping the
 * index unverified (-idx-orphan-stamped, -idx-skip-resets), or the exact read uses
 * the index (-idx-exact-read).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { reconcileTenantIndexesOnce } from '../src/host/tenantIndexAdoption.js';
import {
  createBoard,
  createCard,
  getCard,
  listBoardsWithCards,
  listCards,
  listCardsExact,
  moveCard,
  __resetKanbanStore,
} from '../src/host/kanbanService.js';
import type { Storage } from '../src/storage/storage.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-10T00:00:00Z');
const SCAN_PREFIX = 'hostext:kanban:card:';
const ADOPTION_KEY = 'hostextidxmeta:kanban:card:adoption';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetKanbanStore();
});
// The scan-count spy must not survive a failed assertion into the next case.
afterEach(() => { vi.restoreAllMocks(); });

async function rawCard(id: string, boardId: string, columnId = 'todo'): Promise<void> {
  const now = new Date(T0).toISOString();
  await storage.kvSet(`${SCAN_PREFIX}${id}`, JSON.stringify({
    id, boardId, columnId, title: id, source: 'human', version: 1, order: 1, createdAt: now, updatedAt: now,
  }));
}
const verified = async (): Promise<boolean> => JSON.parse((await storage.kvGet(ADOPTION_KEY)) ?? '{}').verifiedAt !== undefined;
/** Two passes a full window apart (default 180 min), then one indexed read to run
 *  the one-time backfill, so a later dropped marker is not silently re-added. */
async function verifyIndex(tenantId: string, start = T0): Promise<void> {
  await reconcileTenantIndexesOnce(storage, start);
  await reconcileTenantIndexesOnce(storage, start + 3 * HOUR);
  await listBoardsWithCards(tenantId);
}
function countScans(): () => number {
  const spy = vi.spyOn(storage, 'kvList');
  return () => spy.mock.calls.filter(([prefix]) => prefix === SCAN_PREFIX).length;
}

describe('ADR 0872 — kanban card tenant index', () => {
  it('D1: every write stamps the board tenant; a card needs a board', async () => {
    const b = await createBoard({ tenantId: 'ws:k-d1', name: 'B' });
    const c = await createCard({ boardId: b.id, columnId: b.columns[0].id, title: 'one' });
    expect(c.tenantId).toBe('ws:k-d1');
    await expect(createCard({ boardId: 'board-gone', columnId: 'todo', title: 'x' })).rejects.toThrow(/kanban_board_not_found/);

    await rawCard('card-legacy', b.id, b.columns[0].id);
    await moveCard('card-legacy', b.columns[1].id);
    expect((await getCard('card-legacy'))?.tenantId).toBe('ws:k-d1');
  });

  it('D2: the hook stamps legacy cards, and the index verifies; reads then make no full scan', async () => {
    const t = 'ws:k-d2';
    const b = await createBoard({ tenantId: t, name: 'B' });
    const other = await createBoard({ tenantId: 'ws:k-other', name: 'O' });
    await rawCard('card-old', b.id, b.columns[0].id);
    await rawCard('card-foreign', other.id, other.columns[0].id);
    await createCard({ boardId: b.id, columnId: b.columns[0].id, title: 'new' });

    await verifyIndex(t);
    expect((await getCard('card-old'))?.tenantId).toBe(t);
    expect(await verified()).toBe(true);

    const scans = countScans();
    expect((await listCards(b.id)).map((c) => c.title).sort()).toEqual(['card-old', 'new']);
    const [withCards] = (await listBoardsWithCards(t)).filter((x) => x.id === b.id);
    expect(withCards.cards).toHaveLength(2);
    await createCard({ boardId: b.id, columnId: b.columns[0].id, title: 'third' });
    expect(scans(), 'verified reads and sibling ordering never scan every tenant').toBe(0);
  });

  it('D3: an orphan (unstampable) card keeps the index unverified, and reads keep scanning', async () => {
    const t = 'ws:k-d3';
    const b = await createBoard({ tenantId: t, name: 'B' });
    await createCard({ boardId: b.id, columnId: b.columns[0].id, title: 'live' });
    await rawCard('card-orphan', 'board-deleted');

    await verifyIndex(t);
    expect(await verified()).toBe(false);
    const scans = countScans();
    expect(await listCards(b.id)).toHaveLength(1);
    expect(scans()).toBeGreaterThan(0);
    vi.restoreAllMocks(); // stop counting before the repair pass below

    // Once the orphan is gone, a later window verifies.
    await storage.kvDelete(`${SCAN_PREFIX}card-orphan`);
    await verifyIndex(t, T0 + 4 * HOUR);
    expect(await verified()).toBe(true);
  });

  it('D3: an unstamped row appearing after verification resets it', async () => {
    const t = 'ws:k-reset';
    const b = await createBoard({ tenantId: t, name: 'B' });
    await createCard({ boardId: b.id, columnId: b.columns[0].id, title: 'live' });
    await verifyIndex(t);
    expect(await verified()).toBe(true);

    await rawCard('card-late-orphan', 'board-gone-too');
    await reconcileTenantIndexesOnce(storage, T0 + 4 * HOUR);
    expect(await verified()).toBe(false);
  });

  it('D4: a card the index misses is still seen by the exact read', async () => {
    const t = 'ws:k-d4';
    const b = await createBoard({ tenantId: t, name: 'B' });
    const c = await createCard({ boardId: b.id, columnId: b.columns[0].id, title: 'hidden' });
    await verifyIndex(t);
    await storage.kvDelete(`hostextidx:kanban:card:${t}:${c.id}`);

    expect(await listCards(b.id), 'display may miss it until the next repair').toHaveLength(0);
    expect((await listCardsExact(b.id)).map((x) => x.id)).toEqual([c.id]);
  });
});
