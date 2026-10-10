/**
 * ADR 0669 addendum — federation to peers reads the RFC 0181 canonical root
 * first and falls back to the `/v1` twin only for a peer that does not serve it.
 *
 * Before this, every peer read went to `${peer}/v1/host/openwop-app/…`. A peer
 * that has made the ADR 0669 cut answers that address `410`, so federation
 * would have stopped on the first peer's retirement day, not on ours.
 */
import { describe, expect, it } from 'vitest';
import { peerPortfolioGet, peerPortfolioUrls, type PeerAttempt } from '../src/features/priority-matrix/federationService.js';

const BASE = 'https://peer.example.test';
const CANONICAL = `${BASE}/host/openwop-app/priority-matrix/portfolio?topN=5`;
const TWIN = `${BASE}/v1/host/openwop-app/priority-matrix/portfolio?topN=5`;
const ITEM = { id: 'i1' } as never;

function scripted(answers: Record<string, PeerAttempt>): { attempt: (url: string) => Promise<PeerAttempt>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    attempt: async (url) => {
      calls.push(url);
      const a = answers[url];
      if (!a) throw new Error(`unscripted url ${url}`);
      return a;
    },
  };
}

describe('ADR 0669 — federation is canonical first', () => {
  it('orders the canonical root before the /v1 twin, and tolerates a trailing slash', () => {
    expect(peerPortfolioUrls(BASE, 5)).toEqual([CANONICAL, TWIN]);
    expect(peerPortfolioUrls(`${BASE}/`, 5)).toEqual([CANONICAL, TWIN]);
  });

  it('a peer serving the canonical root is read there, and the twin is never called', async () => {
    const s = scripted({ [CANONICAL]: { kind: 'ok', items: [ITEM] } });
    expect(await peerPortfolioGet(BASE, 5, s.attempt)).toEqual({ ok: true, items: [ITEM] });
    expect(s.calls).toEqual([CANONICAL]);
  });

  it('a peer that retired v1 still federates: its twin would 410, and is not reached', async () => {
    const s = scripted({ [CANONICAL]: { kind: 'ok', items: [] }, [TWIN]: { kind: 'error', error: 'HTTP 410' } });
    expect(await peerPortfolioGet(BASE, 5, s.attempt)).toEqual({ ok: true, items: [] });
    expect(s.calls).toEqual([CANONICAL]);
  });

  it('a pre-canonical peer (404 at the root) is read on the twin', async () => {
    const s = scripted({ [CANONICAL]: { kind: 'not-served', error: 'HTTP 404' }, [TWIN]: { kind: 'ok', items: [ITEM] } });
    expect(await peerPortfolioGet(BASE, 5, s.attempt)).toEqual({ ok: true, items: [ITEM] });
    expect(s.calls).toEqual([CANONICAL, TWIN]);
  });

  it('a real error at the canonical root is the answer: no retry that could double a 401 or a 5xx', async () => {
    for (const error of ['HTTP 401', 'HTTP 503', 'response too large', 'fetch failed']) {
      const s = scripted({ [CANONICAL]: { kind: 'error', error } });
      expect(await peerPortfolioGet(BASE, 5, s.attempt)).toEqual({ ok: false, error });
      expect(s.calls).toEqual([CANONICAL]);
    }
  });

  it('served at neither address fails soft with the last reason', async () => {
    const s = scripted({
      [CANONICAL]: { kind: 'not-served', error: 'response is not JSON' },
      [TWIN]: { kind: 'not-served', error: 'HTTP 404' },
    });
    expect(await peerPortfolioGet(BASE, 5, s.attempt)).toEqual({ ok: false, error: 'HTTP 404' });
  });
});
