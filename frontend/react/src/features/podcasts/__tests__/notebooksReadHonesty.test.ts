/**
 * The notebooks picker read fails HONESTLY — in THREE directions, not two.
 *
 * R2 SP-3 (UX_UPGRADE-podcasts) established the first: the old shape returned `[]` on
 * ANY failure, so the Studio rendered "No notebooks found — create a research notebook
 * first" over a 500 — an INSTRUCTIVE empty state on a failed read.
 *
 * `PODU-8` (ADR 0603 §7) is the half SP-3 left, AND THIS FILE PINNED IT. The old
 * assertion here was `404 → []`, byte-identical to "this org has no notebooks yet" —
 * so a user whose administrator has SWITCHED NOTEBOOKS OFF was told to go and create
 * one. They cannot: there is no notebooks surface to create it on. A test that encodes
 * what the code does wrong is worse than no test, because the next reader takes the
 * green as a verdict; this file was that test, for two rounds.
 *
 * All three polarities are pinned below, and the 404 case now asserts the DISTINCTION
 * rather than the shared shape.
 *
 * Sabotage-witnessed (grade-tests w21, `podcastsClient.ts`): 404 → `featureUnavailable:
 * false` reds the 404 case; the 200 branch flagged `true` reds both 200 cases; a non-ok
 * that returns instead of throwing reds the 500 case; dropping `body.notebooks` reds the
 * list case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listNotebooksForPodcasts } from '../podcastsClient.js';

afterEach(() => vi.unstubAllGlobals());

// A REAL Response (no laundering cast): `ok`, `status` and `json()` all come from
// the platform type the client actually reads.
const stub = (status: number, body: unknown = {}): void => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
};

describe('listNotebooksForPodcasts — three outcomes, three shapes', () => {
  it('404 (the notebooks feature is OFF) is FLAGGED, not flattened into an empty list', async () => {
    stub(404);
    const r = await listNotebooksForPodcasts();
    expect(r.featureUnavailable).toBe(true);
    expect(r.notebooks).toEqual([]);
  });

  it('200 with NO notebooks is the same empty list — and is NOT flagged unavailable', async () => {
    // The discriminating half. Without this, `featureUnavailable: true` above could
    // be satisfied by a flag that is simply always set, and the two states would be
    // conflated again one field over.
    stub(200, { notebooks: [] });
    const r = await listNotebooksForPodcasts();
    expect(r.featureUnavailable).toBe(false);
    expect(r.notebooks).toEqual([]);
  });

  it('500 THROWS so the Studio renders its failed state instead of any instruction', async () => {
    stub(500);
    await expect(listNotebooksForPodcasts()).rejects.toMatchObject({ status: 500 });
  });

  it('200 resolves the notebook list', async () => {
    stub(200, { notebooks: [{ id: 'nb1', name: 'Research' }] });
    const r = await listNotebooksForPodcasts();
    expect(r.notebooks).toEqual([{ id: 'nb1', name: 'Research' }]);
    expect(r.featureUnavailable).toBe(false);
  });
});
