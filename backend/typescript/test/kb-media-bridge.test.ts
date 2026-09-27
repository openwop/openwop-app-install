/**
 * ADR 0398 Phase 2 — media-collection → KB bridge.
 *
 * Pins: extractable assets ingest as untrusted-fenced, stable-id (`media:<assetId>`)
 * documents; non-extractable assets are SKIPPED with a per-asset reason (typed, itemized —
 * never a silent drop); re-running is IDEMPOTENT (no duplicate docs / no count drift); and
 * the bridge is a one-directional kb→media read (media never learns about KB).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces, storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createCollection, ingestMediaCollection, getCollection, listDocuments } from '../src/features/kb/kbService.js';
import { createCollection as createMediaCollection, createAsset } from '../src/features/media/mediaService.js';

const tenantId = 'tenant-bridge';
const orgId = 'org-bridge';

async function seedAsset(mediaCollectionId: string, name: string, contentType: string, body: string): Promise<string> {
  const stored = await storeMediaAsset(tenantId, { contentBase64: Buffer.from(body).toString('base64'), contentType });
  const asset = await createAsset({ tenantId, orgId, collectionId: mediaCollectionId, name, contentType, sizeBytes: stored.bytes, storageRef: stored.token, serveToken: stored.token, uploadedBy: 'actor' });
  return asset.assetId;
}

describe('ingestMediaCollection (ADR 0398 P2)', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbbridge-')) });
    initHostExtPersistence(await openStorage('memory://'));
  });

  it('ingests extractable assets untrusted-fenced + skips non-extractable ones with a reason', async () => {
    const kb = await createCollection(tenantId, orgId, 'actor', { name: 'From Media' });
    const media = await createMediaCollection(tenantId, orgId, 'Docs', 'actor');
    await seedAsset(media.collectionId, 'notes.txt', 'text/plain', '# Notes\nQuarterly revenue rose sharply.');
    await seedAsset(media.collectionId, 'clip.mp4', 'video/mp4', 'not-really-a-video');

    const result = await ingestMediaCollection(tenantId, orgId, 'actor', kb.collectionId, media.collectionId);
    expect(result.ingested).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.name).toBe('clip.mp4');
    expect(result.skipped[0]!.reason).toMatch(/extract|supported|video/i);

    const docs = await listDocuments(tenantId, orgId, kb.collectionId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.documentId.startsWith('media:')).toBe(true);
    expect(docs[0]!.contentTrust).toBe('untrusted'); // file-extracted content is never trusted
  });

  it('is idempotent — a re-run does not duplicate docs or drift the collection count', async () => {
    const kb = await createCollection(tenantId, orgId, 'actor', { name: 'Idem' });
    const media = await createMediaCollection(tenantId, orgId, 'Docs2', 'actor');
    await seedAsset(media.collectionId, 'a.md', 'text/markdown', '# A\nAlpha section body.');
    await seedAsset(media.collectionId, 'b.md', 'text/markdown', '# B\nBeta section body.');

    const first = await ingestMediaCollection(tenantId, orgId, 'actor', kb.collectionId, media.collectionId);
    expect(first.ingested).toBe(2);
    const second = await ingestMediaCollection(tenantId, orgId, 'actor', kb.collectionId, media.collectionId);
    expect(second.ingested).toBe(2); // re-ingests (snapshot), but…

    const col = await getCollection(tenantId, orgId, kb.collectionId);
    expect(col!.documentCount).toBe(2); // …NO duplicate docs / count drift (stable-id upsert)
    const docs = await listDocuments(tenantId, orgId, kb.collectionId);
    expect(docs).toHaveLength(2);
  });

  it('404s on an unknown media collection', async () => {
    const kb = await createCollection(tenantId, orgId, 'actor', { name: 'X' });
    await expect(ingestMediaCollection(tenantId, orgId, 'actor', kb.collectionId, 'mcol:does-not-exist')).rejects.toMatchObject({ httpStatus: 404 });
  });
});
