/**
 * ADR 0083 — run-output artifact producer + run-event projection.
 *
 * The long-deferred PRODUCER: persist a node output as a durable artifact (replay-safe,
 * idempotent on the deterministic ${runId}:${nodeId} key), then read it back through the
 * existing `artifactProjection` `run-event` source so the workbench/Library/approval-card
 * can preview it. Verifies kind derivation, idempotency, projection round-trip, the Library
 * list, and cross-tenant isolation.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import {
  persistRunArtifact, getRunArtifact, deriveArtifact, listRunArtifactsForTenant, __resetRunArtifactStore,
} from '../src/host/runArtifactStore.js';
import { getArtifact, getArtifactRevision, listArtifacts } from '../src/host/artifactProjection.js';
import { createDocument } from '../src/features/documents/documentsService.js';
import { __resetMedia } from '../src/features/media/mediaService.js';

// a tiny valid base64 payload (the media store just persists the bytes)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetRunArtifactStore();
  await __resetMedia();
});

describe('ADR 0083 — run-artifact producer', () => {
  it('deriveArtifact classifies content kind + unwraps a lone output/input port', () => {
    expect(deriveArtifact('# Title\nbody', 'n').kind).toBe('markdown');
    expect(deriveArtifact('{"a":1}', 'n').kind).toBe('data');
    expect(deriveArtifact('plain text', 'n').kind).toBe('text');
    expect(deriveArtifact({ a: 1 }, 'n').format).toBe('application/json');
    expect(deriveArtifact({ output: 'hi' }, 'n').content).toBe('hi'); // terminal unwrap
    expect(deriveArtifact({ input: 'hi' }, 'n').content).toBe('hi'); // gate-input unwrap
  });

  it('persists + reads back; idempotent on the deterministic key (replay-safe)', async () => {
    const r1 = await persistRunArtifact({ tenantId: 't1', runId: 'run1', nodeId: 'gate', role: 'gate-preview', output: { subject: 'Hi', body: 'congrats on 10 years' }, now: '2026-06-20T00:00:00Z' });
    expect(r1?.artifactId).toBe('run-event:run1:gate');
    expect(r1?.revisionId).toBe('run1:gate:1');
    expect((await getRunArtifact('run1:gate'))?.status).toBe('in-review');
    // A re-execution writing the SAME key is a no-op — first write wins, no duplicate, same id.
    const r2 = await persistRunArtifact({ tenantId: 't1', runId: 'run1', nodeId: 'gate', role: 'gate-preview', output: { different: 'ignored' }, now: '2026-06-20T01:00:00Z' });
    expect(r2?.artifactId).toBe('run-event:run1:gate');
    const all = await listRunArtifactsForTenant('t1');
    expect(all.length).toBe(1);
    expect(all[0]!.content).toContain('congrats on 10 years'); // original preserved
  });

  it('null/empty output → no row', async () => {
    expect(await persistRunArtifact({ tenantId: 't1', runId: 'r', nodeId: 'n', role: 'deliverable', output: null, now: 'x' })).toBeNull();
  });

  it('projects a run-event artifact through artifactProjection + lists it in the Library', async () => {
    await persistRunArtifact({ tenantId: 't1', runId: 'run9', nodeId: 'final', role: 'deliverable', output: '# Report\nQ3 variance', now: '2026-06-20T00:00:00Z' });
    const proj = await getArtifact('t1', undefined, 'run-event:run9:final');
    expect(proj?.source).toBe('run-event');
    expect(proj?.kind).toBe('markdown');
    expect(proj?.status).toBe('final');
    expect(proj?.createdBy.kind).toBe('run');
    expect(proj?.provenance.runId).toBe('run9');
    const rev = await getArtifactRevision('t1', undefined, 'run-event:run9:final', 'run9:final:1');
    expect(rev?.content).toContain('Q3 variance');
    const lib = await listArtifacts('t1', undefined);
    expect(lib.some((a) => a.artifactId === 'run-event:run9:final')).toBe(true);
  });

  it('cross-tenant isolation: another tenant cannot read the row', async () => {
    await persistRunArtifact({ tenantId: 't1', runId: 'runX', nodeId: 'n', role: 'deliverable', output: 'secret', now: 'x' });
    expect(await getArtifact('t2', undefined, 'run-event:runX:n')).toBeNull();
    expect((await listArtifacts('t2', undefined)).some((a) => a.artifactId === 'run-event:runX:n')).toBe(false);
  });
});

describe('ADR 0083 amendment — reference resolution (media / document / serve)', () => {
  it('INLINE BINARY → mints a media: artifact (previewable image), not a JSON blob; idempotent (no re-mint)', async () => {
    const r = await persistRunArtifact({ tenantId: 'tA', runId: 'imgRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toMatch(/^media:/);
    // the media artifact previews as a real image (source media, image kind)
    const proj = await getArtifact('tA', undefined, r!.artifactId);
    expect(proj?.source).toBe('media');
    expect(proj?.kind).toBe('image');
    // run-event has NO inline blob row for it (the media owner represents it)
    expect((await listRunArtifactsForTenant('tA')).length).toBe(0);
    // the Library lists the media artifact (not a duplicate run-event)
    const lib = await listArtifacts('tA', undefined);
    expect(lib.filter((a) => a.artifactId === r!.artifactId).length).toBe(1);
    // idempotent: a re-execution returns the SAME media id without re-minting
    const r2 = await persistRunArtifact({ tenantId: 'tA', runId: 'imgRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T01:00:00Z' });
    expect(r2?.artifactId).toBe(r!.artifactId);
    expect((await listArtifacts('tA', undefined)).filter((a) => a.source === 'media').length).toBe(1); // no second asset
  });

  it('MULTI-IMAGE generator mints a media: artifact for EVERY image (ADR 0083 #3)', async () => {
    const r = await persistRunArtifact({ tenantId: 'tM', runId: 'mRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toMatch(/^media:/); // the binding/primary is the first image
    expect((await listArtifacts('tM', undefined)).filter((a) => a.source === 'media').length).toBe(3); // all 3 captured
    // idempotent: re-exec mints none
    await persistRunArtifact({ tenantId: 'tM', runId: 'mRun', nodeId: 'gen', role: 'deliverable', output: { images: [{ contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }, { contentBase64: PNG_B64, contentType: 'image/png' }] }, now: '2026-06-20T01:00:00Z' });
    expect((await listArtifacts('tM', undefined)).filter((a) => a.source === 'media').length).toBe(3);
  });

  it('ADR 0115 Phase 4 — URL-based image array (image-gen output) → a file artifact per image, not a JSON blob; replay-idempotent', async () => {
    // The image-generate node emits `images: [{ url }]` (bytes already a host media asset).
    const out = { images: [{ url: '/v1/host/openwop-app/assets/img-a', mimeType: 'image/png' }, { url: '/v1/host/openwop-app/assets/img-b', mimeType: 'image/png' }] };
    const r = await persistRunArtifact({ tenantId: 'tU', runId: 'uRun', nodeId: 'gen', role: 'deliverable', output: out, now: '2026-06-20T00:00:00Z' });
    expect(r).not.toBeNull();
    const rows = await listRunArtifactsForTenant('tU');
    expect(rows.length).toBe(2);                                   // both images captured…
    expect(rows.every((a) => a.kind === 'file')).toBe(true);       // …as file artifacts…
    expect(rows.some((a) => a.format === 'application/json')).toBe(false); // …NOT a JSON blob
    expect(rows.some((a) => a.content.includes('/assets/img-a'))).toBe(true);
    expect(rows.some((a) => a.content.includes('/assets/img-b'))).toBe(true);
    // replay-safe: a re-execution writes no new rows (insert-only on the deterministic key)
    await persistRunArtifact({ tenantId: 'tU', runId: 'uRun', nodeId: 'gen', role: 'deliverable', output: out, now: '2026-06-20T01:00:00Z' });
    expect((await listRunArtifactsForTenant('tU')).length).toBe(2);
  });

  it('DOCUMENT reference → links the document: artifact (no duplicate run-event blob)', async () => {
    const doc = await createDocument({ tenantId: 'tD', orgId: 'tD', title: 'SOW', kind: 'sow', provenance: { producedBy: { kind: 'run', id: 'docRun' } }, createdBy: 'docRun' });
    const r = await persistRunArtifact({ tenantId: 'tD', runId: 'docRun', nodeId: 'gen', role: 'deliverable', output: { document: { documentId: doc.documentId }, version: 1 }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toBe(`document:${doc.documentId}`);
    // no inline run-event artifact duplicating the document
    expect((await listRunArtifactsForTenant('tD')).length).toBe(0);
    // the bookkeeping row exists (idempotency) but is a link, not a projectable run-event
    expect((await getRunArtifact('docRun:gen'))?.linkedArtifactId).toBe(`document:${doc.documentId}`);
    expect(await getArtifact('tD', undefined, 'run-event:docRun:gen')).toBeNull();
  });

  it('SERVE reference (renderedMediaToken) → a click-to-open link, not a JSON blob', async () => {
    const r = await persistRunArtifact({ tenantId: 'tS', runId: 'rndRun', nodeId: 'render', role: 'deliverable', output: { versionId: 'v1', renderedMediaToken: 'tok-xyz', url: '/v1/host/openwop-app/assets/tok-xyz', sizeBytes: 99 }, now: '2026-06-20T00:00:00Z' });
    expect(r?.artifactId).toBe('run-event:rndRun:render');
    const rev = await getArtifactRevision('tS', undefined, r!.artifactId, r!.revisionId);
    expect(rev?.content).toContain('/v1/host/openwop-app/assets/tok-xyz');
    expect(rev?.content).toMatch(/^\[.*\]\(/); // a markdown link, not raw JSON
  });
});
