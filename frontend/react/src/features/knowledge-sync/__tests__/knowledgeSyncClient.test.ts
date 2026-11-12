/**
 * ADR 1101 — the knowledge-sync client's two new contracts.
 *
 *  1. D5 — Remove is RESUMABLE: the server deletes a bounded batch per request and
 *     answers 202 `{ removing, remaining }` while more is left. The client calls
 *     again until it is done and sums what was removed; it stops after `maxRounds`
 *     rather than spin a tab against a server that never finishes. Sabotage: drop
 *     the loop ⇒ the first case reports 2 removed and `removing: true`.
 *  2. D7 — a refusal keeps its STATUS and body (`ApiError`), so the panel can say
 *     "you don't have permission" instead of toasting the server's sentence.
 *     Sabotage: throw a bare `Error` ⇒ `status` is undefined.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../client/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../client/config.js')>();
  return { ...real, config: { ...real.config, baseUrl: '' } };
});

import { deleteSyncSource, syncNow } from '../knowledgeSyncClient.js';
import { ApiError } from '../../../client/requestJson.js';

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('deleteSyncSource (D5)', () => {
  it('calls again while the server answers 202 removing, and sums what was removed', async () => {
    fetchMock
      .mockResolvedValueOnce(json(202, { deleted: false, removing: true, remaining: 3, documentsRemoved: 2 }))
      .mockResolvedValueOnce(json(202, { deleted: false, removing: true, remaining: 1, documentsRemoved: 2 }))
      .mockResolvedValueOnce(json(200, { deleted: true, documentsRemoved: 1 }));
    const out = await deleteSyncSource('s1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url, init]) => String(url) === '/host/openwop-app/knowledge-sync/s1' && init?.method === 'DELETE')).toBe(true);
    expect(out).toEqual({ deleted: true, documentsRemoved: 5 });
  });

  it('stops after maxRounds and reports the removal as still in progress', async () => {
    fetchMock.mockImplementation(async () => json(202, { deleted: false, removing: true, remaining: 9, documentsRemoved: 1 }));
    const out = await deleteSyncSource('s1', 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ deleted: false, removing: true, documentsRemoved: 2 });
  });
});

describe('refusals keep their status (D7)', () => {
  it('a 403 rejects with an ApiError carrying the status and body', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'forbidden_scope', message: 'Missing required scope: workspace:write' }));
    const err = await syncNow('s1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
    expect((err as ApiError).body).toMatchObject({ error: 'forbidden_scope' });
  });
});
