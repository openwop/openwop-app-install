/**
 * ADR 0963 D3 — the ranking read carries `held` beside `ranked`; the client must
 * pass it through, or the panel's "Held" list can never appear.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBoardRanking } from '../workSelectionClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

const respond = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

describe('getBoardRanking', () => {
  it('passes held cards through beside the ranking', async () => {
    respond(200, { ranked: [], held: [{ cardId: 'h1', title: 'Crashed thing' }] });
    expect(await getBoardRanking('b1')).toEqual({ kind: 'ok', ranked: [], held: [{ cardId: 'h1', title: 'Crashed thing' }] });
  });

  it('an older server without `held` reads as none held', async () => {
    respond(200, { ranked: [] });
    expect(await getBoardRanking('b1')).toEqual({ kind: 'ok', ranked: [], held: [] });
  });

  it('a 404 is the feature being off, not an error', async () => {
    respond(404, {});
    expect(await getBoardRanking('b1')).toEqual({ kind: 'disabled' });
  });
});
