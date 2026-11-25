/**
 * ADR 1155 P5b — the reads that want every card follow pages, because the host refuses
 * an unpaged read above 2,000 cards.
 *
 * Red if: a whole read sends no `limit` (it would hit the cap); it stops before the
 * last page or reads one twice; an older host that ignores `limit` costs more than one
 * request; or a repeated cursor loops forever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWholeBoard, listAssignedToMe } from '../kanbanClient.js';

const BOARD = { id: 'b1', tenantId: 't1', name: 'House', columns: [], createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z' };

/** Serve `pages` in order, and record every requested URL. */
function serve(pages: Array<Record<string, unknown>>): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    const body = pages[urls.length - 1] ?? pages[pages.length - 1];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  return urls;
}
const cursorOf = (url: string): string | null => new URL(url, 'http://x').searchParams.get('cursor');
const limitOf = (url: string): string | null => new URL(url, 'http://x').searchParams.get('limit');

afterEach(() => { vi.unstubAllGlobals(); });

describe('getWholeBoard', () => {
  it('follows nextCursor to the last page', async () => {
    const urls = serve([
      { board: BOARD, cards: [{ id: 'a' }], workItems: [{ workItemId: 'w1' }], total: 3, nextCursor: 'c1' },
      { board: BOARD, cards: [{ id: 'b' }], workItems: [], total: 3, nextCursor: 'c2' },
      { board: BOARD, cards: [{ id: 'c' }], workItems: [], total: 3 },
    ]);
    const got = await getWholeBoard('b1');
    expect(got.cards.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(got.workItems.map((w) => w.workItemId)).toEqual(['w1']);
    expect(got.board.id).toBe('b1');
    expect(urls.map(limitOf)).toEqual(['100', '100', '100']);
    expect(urls.map(cursorOf)).toEqual([null, 'c1', 'c2']);
  });

  it('takes one request from a host that ignores limit, and stops on a repeated cursor', async () => {
    serve([{ board: BOARD, cards: [{ id: 'a' }, { id: 'b' }], workItems: [] }]);
    expect((await getWholeBoard('b1')).cards).toHaveLength(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    serve([{ board: BOARD, cards: [], workItems: [], nextCursor: 'same' }]);
    await expect(getWholeBoard('b1')).rejects.toThrow(/repeated page cursor/);
  });
});

describe('listAssignedToMe', () => {
  it('follows nextCursor to the last page', async () => {
    const urls = serve([
      { cards: [{ id: 'a' }], total: 2, nextCursor: 'c1' },
      { cards: [{ id: 'b' }], total: 2 },
    ]);
    expect((await listAssignedToMe()).map((c) => c.id)).toEqual(['a', 'b']);
    expect(urls.map(limitOf)).toEqual(['100', '100']);
    expect(urls.map(cursorOf)).toEqual([null, 'c1']);
  });

  it('takes one request from a host that ignores limit, and stops on a repeated cursor', async () => {
    serve([{ cards: [{ id: 'a' }, { id: 'b' }] }]);
    expect(await listAssignedToMe()).toHaveLength(2);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
    serve([{ cards: [], nextCursor: 'same' }]);
    await expect(listAssignedToMe()).rejects.toThrow(/repeated page cursor/);
  });
});
