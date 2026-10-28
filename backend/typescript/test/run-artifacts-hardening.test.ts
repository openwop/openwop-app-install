/**
 * ADR 0083 — Run-Artifacts hardening (ART-1 Library pagination + ART-6 base64 floor).
 *
 * ART-1: `listArtifactsPage` bounds the Library payload with a keyset cursor (newest-first,
 *   tie-broken by id) so a large workspace doesn't ship every artifact in one response.
 * ART-6: the base64 media detector requires the value to DECODE to non-trivial bytes, so a
 *   charset-valid all-padding string can't mint an empty media asset (it falls through to an
 *   inline run-event artifact instead).
 *
 * Breaks it (round-1 probes, witnessed): the cursor comparison `<`→`<=`
 * (8fw2g2-rah-cursor), the lower clamp (rah-lower), a cursor on the last page
 * (rah-lastcursor), the newest-first sort (rah-sort), the ART-6 decode floor
 * (rah-art6). The UPPER clamp (500) needs a set larger than the cap: round 1's
 * 3-row fixture returned 3 either way (8fw2g2-rah-upper VACUOUS), so the clamp
 * case now seeds 501 rows (8fw2g2-rah-upper-r2).
 *
 * "is tenant-scoped" was round-1 VACUOUS for a FIXTURE reason first: both tenants
 * seeded runId 'run', so tB's rows collided with tA's keys and were never
 * written — the case compared tA against nothing. Each tenant now seeds its own
 * runId and the case asserts tB's rows exist (positive control).
 * Round 2 predicted a double guard here (`listArtifacts` also deny-filters on
 * `canRead(row.orgId)`, and a run-artifact row's `orgId` is its tenantId), but
 * MEASURED otherwise: removing the tenant filter in `listRunArtifactsForTenant`
 * alone reddens this case and the pagination case (8fw2g2-rah-tenant-r2
 * witnessed), so on this read path the tenant filter is the guard. The shared
 * tenant identity `writeRow` stamps is probed too (8fw2g2-rah-stamp-r2).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { persistRunArtifact, __resetRunArtifactStore } from '../src/host/runArtifactStore.js';
import { listArtifacts, listArtifactsPage } from '../src/host/artifactProjection.js';
import { __resetMedia } from '../src/features/media/mediaService.js';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetRunArtifactStore();
  await __resetMedia();
});

async function seed(tenantId: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await persistRunArtifact({
      // The row key is `${runId}:${nodeId}` (global, not tenant-prefixed — real runIds
      // are UUIDs), so each tenant seeds its OWN runId or the second seed loses the
      // insert-only CAS and writes nothing.
      tenantId, runId: `run-${tenantId}`, nodeId: `n${i}`, role: 'deliverable',
      // Asset-class run artifacts (kind:'file' via a serve ref) so they survive the
      // Library's asset filter (ADR 0083 §Amendment); `alt` becomes the title.
      output: { image: { url: `https://cdn.test/a${i}.png`, alt: `Artifact ${i}` } }, now: `2026-06-20T00:00:0${i}.000Z`,
    });
  }
}

describe('ART-1 — Library keyset pagination', () => {
  it('caps a page to `limit`, returns a cursor, and walks the full set newest-first without gaps/dupes', async () => {
    await seed('t', 5);
    const full = await listArtifacts('t', undefined); // the full sorted set (newest-first)
    expect(full.map((a) => a.title)).toEqual(['Artifact 5', 'Artifact 4', 'Artifact 3', 'Artifact 2', 'Artifact 1']);

    const p1 = await listArtifactsPage('t', undefined, { limit: 2 });
    expect(p1.artifacts.map((a) => a.title)).toEqual(['Artifact 5', 'Artifact 4']);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await listArtifactsPage('t', undefined, { limit: 2, cursor: p1.nextCursor });
    expect(p2.artifacts.map((a) => a.title)).toEqual(['Artifact 3', 'Artifact 2']);
    expect(p2.nextCursor).toBeTruthy();

    const p3 = await listArtifactsPage('t', undefined, { limit: 2, cursor: p2.nextCursor });
    expect(p3.artifacts.map((a) => a.title)).toEqual(['Artifact 1']);
    expect(p3.nextCursor).toBeUndefined(); // last page — no cursor

    // No gaps / no duplicates across the walk.
    const walked = [...p1.artifacts, ...p2.artifacts, ...p3.artifacts].map((a) => a.artifactId);
    expect(new Set(walked).size).toBe(5);
    expect(walked).toEqual(full.map((a) => a.artifactId));
  });

  it('clamps limit to [1, 500] and a cursor past the end yields an empty final page', async () => {
    await seed('t', 3);
    expect((await listArtifactsPage('t', undefined, { limit: 0 })).artifacts).toHaveLength(1); // clamped to >=1
    // The upper clamp needs MORE rows than the cap, or 9999 and 500 read the same.
    for (let i = 0; i < 501; i++) {
      await persistRunArtifact({
        tenantId: 'tBig', runId: 'big', nodeId: `b${i}`, role: 'deliverable',
        output: { image: { url: `https://cdn.test/b${i}.png`, alt: `Big ${i}` } },
        now: new Date(Date.UTC(2026, 5, 20) + i).toISOString(),
      });
    }
    const capped = await listArtifactsPage('tBig', undefined, { limit: 9999 });
    expect(capped.artifacts).toHaveLength(500); // clamped to <=500…
    expect(capped.nextCursor).toBeTruthy(); // …with the 501st one page away
    const rest = await listArtifactsPage('tBig', undefined, { limit: 9999, cursor: capped.nextCursor });
    expect(rest.artifacts.map((a) => a.title)).toEqual(['Big 0']);
    const last = await listArtifactsPage('t', undefined, { limit: 3 });
    expect(last.nextCursor).toBeUndefined();
    expect((await listArtifactsPage('t', undefined, { limit: 2, cursor: '0000 z' })).artifacts).toEqual([]); // cursor older than everything
  });

  it('is tenant-scoped — a page never includes another tenant artifacts', async () => {
    await seed('tA', 2);
    await seed('tB', 2);
    const page = await listArtifactsPage('tA', undefined, { limit: 50 });
    expect(page.artifacts.every((a) => a.tenantId === 'tA')).toBe(true);
    expect(page.artifacts).toHaveLength(2);
    // Positive control: tB's rows exist and are listed for tB.
    expect((await listArtifactsPage('tB', undefined, { limit: 50 })).artifacts).toHaveLength(2);
  });
});

describe('ART-6 — base64 media detector decode floor', () => {
  it('a charset-valid ALL-PADDING contentBase64 does NOT mint a media asset (falls through to run-event)', async () => {
    const r = await persistRunArtifact({
      tenantId: 't', runId: 'run', nodeId: 'pad', role: 'deliverable',
      output: { contentBase64: '='.repeat(80) }, now: '2026-06-20T00:00:00.000Z',
    });
    expect(r?.artifactId.startsWith('run-event:')).toBe(true); // inline, NOT media:
    const lib = await listArtifacts('t', undefined);
    expect(lib.filter((a) => a.source === 'media')).toHaveLength(0);
  });
});
