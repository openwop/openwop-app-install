/**
 * The two failures this client used to report as ordinary answers.
 *
 * This is the manual-test runner: recording results IS the product. Both
 * defects therefore hit the one thing the feature exists to do.
 *
 *  1. `loadAllRuns` returned `{}` for BOTH "no runs yet" and "the read failed",
 *     so a 500 rendered as "0 of 47 tested" — a confident, wrong answer telling
 *     a tester their recorded work does not exist.
 *
 *  2. `saveResults` never checked `res.ok`, so a 403/500 resolved normally and
 *     was indistinguishable from a save. Worse than silent: `loadResults`
 *     refreshed the localStorage cache from the server on every successful
 *     read, so results the server never received were later overwritten by the
 *     stale server copy and LOST (MT-LOSS-1, closed: see the last three cases).
 *
 * ADR 0183 — "no lost progress either way". The client's config module is the
 * one it actually imports (`client/config.js`), with `baseUrl: ''` so every
 * request URL is asserted exactly; fixtures are real `Response`s.
 * Sabotages that turn it red: `loadAllRuns` `if (!res.ok) return null` dropped
 * (w52g1-mt-allruns-notok), its URL changed (w52g1-mt-allruns-url-r2), the
 * save's `PUT` changed (w52g1-mt-save-method-r2), the save outcome forced ok
 * (w52g1-mt-save-rejected), the `isUnsynced` merge dropped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module the client actually imports (round 1 found the old two mocks
// pointed at `src/config.js` / `src/client/http.js`, which do not exist).
vi.mock('../../../client/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../client/config.js')>();
  return { ...real, config: { ...real.config, baseUrl: '' } };
});

import { loadAllRuns, saveResults, loadResults } from '../manualTestsClient.js';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

const res = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (body: unknown): Response => res(body);
/** The [url, init] of the Nth fetch call, typed. */
const call = (n: number): { url: string; init: RequestInit } => {
  const c = fetchMock.mock.calls[n];
  if (!c) throw new Error(`fetch call ${n} was not made`);
  return { url: String(c[0]), init: c[1] ?? {} };
};

describe('loadAllRuns — a failed read is not an empty result', () => {
  it('returns the runs when the server answers', async () => {
    fetchMock.mockResolvedValue(ok({ runs: [{ suiteKey: 's1', results: { c1: { status: 'pass', note: '', ts: '' } } }] }));
    await expect(loadAllRuns()).resolves.toEqual({ s1: { c1: { status: 'pass', note: '', ts: '' } } });
    expect(call(0).url).toBe('/host/openwop-app/manual-tests/runs');
  });

  it('distinguishes "no runs yet" from a failure', async () => {
    fetchMock.mockResolvedValue(ok({ runs: [] }));
    // Genuinely empty — the tester really has recorded nothing.
    await expect(loadAllRuns()).resolves.toEqual({});
  });

  // THE DEFECT. This used to be `{}`, which the list view renders as 0 done.
  it('returns null on a non-OK response, never an empty map', async () => {
    fetchMock.mockResolvedValue(res({}, 500));
    await expect(loadAllRuns()).resolves.toBeNull();
  });

  it('returns null when the request never completes', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(loadAllRuns()).resolves.toBeNull();
  });
});

describe('saveResults — a rejected save must not look saved', () => {
  const R = { c1: { status: 'pass' as const, note: 'ok', ts: '2026-08-01T00:00:00Z' } };

  it('reports ok when the server accepts — and sends the results as a PUT to the suite', async () => {
    fetchMock.mockResolvedValue(ok({}));
    await expect(saveResults('s1', R)).resolves.toEqual({ ok: true });
    const { url, init } = call(0);
    expect(url).toBe('/host/openwop-app/manual-tests/runs/s1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ results: R });
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  // THE DEFECT. A 403/500 resolves — the old code neither caught nor checked it.
  it('reports failure on a rejection instead of resolving silently', async () => {
    fetchMock.mockResolvedValue(res({}, 403));
    await expect(saveResults('s1', R)).resolves.toEqual({ ok: false, reason: 'rejected', status: 403 });
  });

  it('reports failure when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    await expect(saveResults('s1', R)).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  // The local write still happens — the point is that the user is TOLD the
  // server copy did not, so "reload to retry" is actionable rather than a
  // silent race against the next cache refresh.
  it('still writes the local cache when the server refuses', async () => {
    fetchMock.mockResolvedValue(res({}, 500));
    await saveResults('s1', R);
    expect(localStorage.getItem('openwop.manualTests.s1')).toContain('pass');
  });

  // The chain that made this DESTRUCTIVE rather than merely silent, now closed
  // (MT-LOSS-1): a rejected save marks the suite unsynced, and the next healthy
  // read MERGES the server copy into the local one instead of overwriting it.
  // Sabotage: drop the `isUnsynced(...)` merge in `loadResults` → red.
  it('a healthy read after a rejected save does not erase the unsynced local result (MT-LOSS-1)', async () => {
    fetchMock.mockResolvedValue(res({}, 500));
    const outcome = await saveResults('s1', R);
    expect(outcome.ok).toBe(false); // ← the signal that used to be absent

    // Later the server is healthy again and returns the copy it never received.
    fetchMock.mockResolvedValue(ok({ run: { results: {} } }));
    const loaded = await loadResults('s1');
    expect(loaded).toEqual(R);
    expect(JSON.parse(localStorage.getItem('openwop.manualTests.s1') ?? '{}')).toEqual(R);
  });

  // The merge is per case and newest-wins, so a result recorded on another
  // device AFTER the local one is not clobbered by the stale local copy.
  // Sabotage: make `mergeNewer` prefer local unconditionally → red.
  it('the merge keeps the NEWER result per case, from either side (MT-LOSS-1)', async () => {
    const local = {
      c1: { status: 'pass' as const, note: 'local, older', ts: '2026-01-01T00:00:00.000Z' },
      c2: { status: 'fail' as const, note: 'local only', ts: '2026-01-01T00:00:00.000Z' },
    };
    fetchMock.mockResolvedValue(res({}, 503));
    await saveResults('s1', local);
    const server = { c1: { status: 'fail' as const, note: 'server, newer', ts: '2026-01-02T00:00:00.000Z' } };
    fetchMock.mockResolvedValue(ok({ run: { results: server } }));
    await expect(loadResults('s1')).resolves.toEqual({ c1: server.c1, c2: local.c2 });
  });

  // An accepted save clears the mark, so the server is authoritative again.
  // Sabotage: drop `markUnsynced(suiteKey, false)` on success → red.
  it('after an accepted save, a read takes the server copy as it is', async () => {
    fetchMock.mockResolvedValue(res({}, 500));
    await saveResults('s1', R);
    fetchMock.mockResolvedValue(ok({}));
    await expect(saveResults('s1', R)).resolves.toEqual({ ok: true });
    fetchMock.mockResolvedValue(ok({ run: { results: {} } }));
    await expect(loadResults('s1')).resolves.toEqual({});
  });
});
