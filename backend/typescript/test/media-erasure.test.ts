/**
 * UX_UPGRADE-media ROUND 3 — MED2-M3 (the erasure/classification half).
 *
 * `media` stored `uploadedBy`/`createdBy` and free-text `lineage.prompt` with
 * NO subject eraser and NO PII declaration — a DSAR fan-out skipped the store
 * and reported success. Anonymize-not-delete (the documents posture): the
 * asset is ORG content; the attribution is the personal data; the erased
 * subject's own prompt is their words and goes with the byline.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createAsset, createCollection, getAsset, listCollections } from '../src/features/media/mediaService.js';
import { eraseMediaSubject, ERASED_SUBJECT } from '../src/features/media/erasure.js';
import { isPiiField } from '../src/host/dataClassification.js';

const T = 'tenant-media-erase';
let ORG = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const org = await createOrg({ tenantId: T, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  ORG = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const asset = (uploadedBy: string, prompt?: string) => createAsset({
  tenantId: T, orgId: ORG, name: `a-${Math.floor(performance.now() * 1000)}`,
  contentType: 'image/png', sizeBytes: 10, storageRef: `ref-${uploadedBy}-${prompt ?? 'x'}`, serveToken: `tok-${uploadedBy}-${prompt ?? 'x'}`,
  uploadedBy, ...(prompt ? { lineage: { kind: 'generated', prompt } } : {}),
});

describe('MED2-M3 — media is erasable, and the free text is declared', () => {
  it('erases the subject attribution AND their prompt; other subjects untouched', async () => {
    const mine = await asset('u-erase-me', 'a prompt naming Alice');
    const theirs = await asset('u-keeper', 'a prompt naming Bob');
    const col = await createCollection(T, ORG, 'My shots', 'u-erase-me');
    await eraseMediaSubject(T, 'u-erase-me');

    const minedAfter = await getAsset(T, ORG, mine.assetId);
    expect(minedAfter!.uploadedBy).toBe(ERASED_SUBJECT);
    expect(minedAfter!.lineage?.prompt).toBe('[erased on subject request]');
    const theirsAfter = await getAsset(T, ORG, theirs.assetId);
    expect(theirsAfter!.uploadedBy).toBe('u-keeper');            // untouched polarity
    expect(theirsAfter!.lineage?.prompt).toBe('a prompt naming Bob');
    const cols = await listCollections(T, ORG);
    expect(cols.find((c) => c.collectionId === col.collectionId)!.createdBy).toBe(ERASED_SUBJECT);
  });

  it('lineage is a DECLARED PII field; the opaque id fields are deliberately not', () => {
    expect(isPiiField('media:asset', 'lineage')).toBe(true);
    expect(isPiiField('media:asset', 'uploadedBy')).toBe(false);
  });
});
