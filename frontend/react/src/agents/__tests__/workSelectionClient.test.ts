/**
 * ADR 0963 D3 — the ranking read carries `held` beside `ranked`; the client must
 * pass it through, or the panel's "Held" list can never appear. ADR 0534 P5 — a
 * 404 is the feature being off; any other failure is an error, never silence.
 *
 * Sabotage (witnessed): dropping `held` or `ranked`, dropping the `held` default,
 * a wrong path, removing the 404 branch, and removing the non-ok branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../client/config.js';
import { getBoardRanking, type RankedCard } from '../workSelectionClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

function respond(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const RANKED: RankedCard = { cardId: 'c1', title: 'Next thing', rank: 1, score: 0.75, why: [{ criterionId: 'age', criterion: 'Age', value: 0.5 }] };

describe('getBoardRanking', () => {
  it('passes held cards through beside the ranking', async () => {
    const fetchMock = respond(200, { ranked: [RANKED], held: [{ cardId: 'h1', title: 'Crashed thing' }] });
    expect(await getBoardRanking('b/1')).toEqual({ kind: 'ok', ranked: [RANKED], held: [{ cardId: 'h1', title: 'Crashed thing' }] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${config.baseUrl}/host/openwop-app/work-selection/boards/b%2F1/ranking`);
  });

  it('an older server without `held` reads as none held', async () => {
    respond(200, { ranked: [] });
    expect(await getBoardRanking('b1')).toEqual({ kind: 'ok', ranked: [], held: [] });
  });

  it('a 404 is the feature being off, not an error', async () => {
    respond(404, {});
    expect(await getBoardRanking('b1')).toEqual({ kind: 'disabled' });
  });

  it('any other failure is an error, never the feature being off', async () => {
    respond(500, {});
    expect(await getBoardRanking('b1')).toEqual({ kind: 'error' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await getBoardRanking('b1')).toEqual({ kind: 'error' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })));
    expect(await getBoardRanking('b1')).toEqual({ kind: 'error' });
  });
});
