/**
 * ADR 0083 — Run-Artifacts hardening (ART-1 Library pagination + ART-6 base64 floor).
 *
 * ART-1: `listArtifactsPage` bounds the Library payload with a keyset cursor (newest-first,
 *   tie-broken by id) so a large workspace doesn't ship every artifact in one response.
 * ART-6: the base64 media detector requires the value to DECODE to non-trivial bytes, so a
 *   charset-valid all-padding string can't mint an empty media asset (it falls through to an
 *   inline run-event artifact instead).
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
      tenantId, runId: 'run', nodeId: `n${i}`, role: 'deliverable',
      output: `# Artifact ${i}`, now: `2026-06-20T00:00:0${i}.000Z`,
    });
  }
}

describe('ART-1 — Library keyset pagination', () => {
  it('caps a page to `limit`, returns a cursor, and walks the full set newest-first without gaps/dupes', async () => {
    await seed('t', 5);
    const full = await listArtifacts('t', undefined); // the full sorted set (newest-first)
    expect(full.map((a) => a.title)).toEqual(['# Artifact 5', '# Artifact 4', '# Artifact 3', '# Artifact 2', '# Artifact 1']);

    const p1 = await listArtifactsPage('t', undefined, { limit: 2 });
    expect(p1.artifacts.map((a) => a.title)).toEqual(['# Artifact 5', '# Artifact 4']);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await listArtifactsPage('t', undefined, { limit: 2, cursor: p1.nextCursor });
    expect(p2.artifacts.map((a) => a.title)).toEqual(['# Artifact 3', '# Artifact 2']);
    expect(p2.nextCursor).toBeTruthy();

    const p3 = await listArtifactsPage('t', undefined, { limit: 2, cursor: p2.nextCursor });
    expect(p3.artifacts.map((a) => a.title)).toEqual(['# Artifact 1']);
    expect(p3.nextCursor).toBeUndefined(); // last page — no cursor

    // No gaps / no duplicates across the walk.
    const walked = [...p1.artifacts, ...p2.artifacts, ...p3.artifacts].map((a) => a.artifactId);
    expect(new Set(walked).size).toBe(5);
    expect(walked).toEqual(full.map((a) => a.artifactId));
  });

  it('clamps limit to [1, 500] and a cursor past the end yields an empty final page', async () => {
    await seed('t', 3);
    expect((await listArtifactsPage('t', undefined, { limit: 0 })).artifacts).toHaveLength(1); // clamped to >=1
    expect((await listArtifactsPage('t', undefined, { limit: 9999 })).artifacts).toHaveLength(3); // all (cap is generous)
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
