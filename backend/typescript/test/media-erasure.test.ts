/**
 * UX_UPGRADE-media ROUND 3 — MED2-M3 (the erasure/classification half).
 *
 * `media` stored `uploadedBy`/`createdBy` and free-text `lineage.prompt` with
 * NO subject eraser and NO PII declaration — a DSAR fan-out skipped the store
 * and reported success. Anonymize-not-delete (the documents posture): the
 * asset is ORG content; the attribution is the personal data; the erased
 * subject's own prompt is their words and goes with the byline.
 *
 * Driven through the HOST fan-out (`eraseSubject`), not the media eraser
 * directly, so the claim includes the wiring: a store whose eraser is not
 * registered is exactly the "DSAR skipped it and reported success" defect.
 * Breaks if the eraser is unregistered, stops anonymizing the byline / the
 * prompt / the collection creator, touches another subject's rows, or the
 * `lineage` PII declaration is dropped (probes w5g2-erase-*).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createAsset, createCollection, getAsset, listCollections } from '../src/features/media/mediaService.js';
import { ERASED_SUBJECT } from '../src/features/media/erasure.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
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
    const theirsCol = await createCollection(T, ORG, 'Their shots', 'u-keeper');
    await eraseSubject(T, 'u-erase-me');

    const minedAfter = await getAsset(T, ORG, mine.assetId);
    expect(minedAfter!.uploadedBy).toBe(ERASED_SUBJECT);
    expect(minedAfter!.lineage?.prompt).toBe('[erased on subject request]');
    const theirsAfter = await getAsset(T, ORG, theirs.assetId);
    expect(theirsAfter!.uploadedBy).toBe('u-keeper');            // untouched polarity
    expect(theirsAfter!.lineage?.prompt).toBe('a prompt naming Bob');
    const cols = await listCollections(T, ORG);
    expect(cols.find((c) => c.collectionId === col.collectionId)!.createdBy).toBe(ERASED_SUBJECT);
    expect(cols.find((c) => c.collectionId === theirsCol.collectionId)!.createdBy).toBe('u-keeper'); // untouched polarity
  });

  it('lineage is a DECLARED PII field; the opaque id fields are deliberately not', () => {
    expect(isPiiField('media:asset', 'lineage')).toBe(true);
    expect(isPiiField('media:asset', 'uploadedBy')).toBe(false);
  });
});
