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
 *     refreshes the localStorage cache from the server on every successful
 *     read, so results the server never received were later overwritten by the
 *     stale server copy and LOST.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config.js', () => ({ config: { baseUrl: '' } }));
vi.mock('../../../client/http.js', () => ({
  fetchOpts: (o: unknown) => o,
  authedHeaders: (h: unknown) => h ?? {},
}));

import { loadAllRuns, saveResults, loadResults } from '../manualTestsClient.js';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('loadAllRuns — a failed read is not an empty result', () => {
  it('returns the runs when the server answers', async () => {
    fetchMock.mockResolvedValue(ok({ runs: [{ suiteKey: 's1', results: { c1: { status: 'pass', note: '', ts: '' } } }] }));
    await expect(loadAllRuns()).resolves.toEqual({ s1: { c1: { status: 'pass', note: '', ts: '' } } });
  });

  it('distinguishes "no runs yet" from a failure', async () => {
    fetchMock.mockResolvedValue(ok({ runs: [] }));
    // Genuinely empty — the tester really has recorded nothing.
    await expect(loadAllRuns()).resolves.toEqual({});
  });

  // THE DEFECT. This used to be `{}`, which the list view renders as 0 done.
  it('returns null on a non-OK response, never an empty map', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(loadAllRuns()).resolves.toBeNull();
  });

  it('returns null when the request never completes', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(loadAllRuns()).resolves.toBeNull();
  });
});

describe('saveResults — a rejected save must not look saved', () => {
  const R = { c1: { status: 'pass' as const, note: 'ok', ts: '2026-08-01T00:00:00Z' } };

  it('reports ok when the server accepts', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(saveResults('s1', R)).resolves.toEqual({ ok: true });
  });

  // THE DEFECT. A 403/500 resolves — the old code neither caught nor checked it.
  it('reports failure on a rejection instead of resolving silently', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
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
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await saveResults('s1', R);
    expect(localStorage.getItem('openwop.manualTests.s1')).toContain('pass');
  });

  // The chain that made this DESTRUCTIVE rather than merely silent.
  it('demonstrates the loss: a stale server read overwrites the unsaved local copy', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const outcome = await saveResults('s1', R);
    expect(outcome.ok).toBe(false); // ← the signal that used to be absent

    // Later the server is healthy again and returns the copy it never received.
    fetchMock.mockResolvedValue(ok({ run: { results: {} } }));
    await loadResults('s1');
    expect(localStorage.getItem('openwop.manualTests.s1')).toBe('{}'); // the result is gone
  });
});
