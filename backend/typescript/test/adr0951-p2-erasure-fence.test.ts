/** ADR 0951 P2.5: erasure must fence visibility and late writers before deleting
 * bytes. Real SQLite connections share the index; the real memory blob adapter
 * stores bytes. Only its delete failure / put interleaving is injected. These
 * are storage-boundary witnesses, not a claim of public ingest qualification. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildHostSurfaceBundle, initInMemorySurfaces, type BlobSurface } from '../src/host/inMemorySurfaces.js';
import { registerSurfaceAdapter } from '../src/host/surfaceBackends.js';
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, eraseSubjectReplays, getReplaySession, listReplaySessionsForTenant,
  putReplayChunk, replayChunkPrefix, type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let b: Storage;
let dir: string;
let blob: BlobSurface;
let originalBackend: string | undefined;
let failDelete: boolean;
let beforePut: (() => Promise<void>) | undefined;
let tenantId: string;
const CHUNK = Buffer.from('masked geometry only').toString('base64');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-erasure-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-erase-${randomUUID()}`;
  originalBackend = process.env.OPENWOP_SURFACE_BLOB;
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  failDelete = false;
  beforePut = undefined;
  registerSurfaceAdapter<BlobSurface>('blob', 'replay-erasure-witness', () => ({
    ...blob,
    put: async args => { await beforePut?.(); return blob.put(args); },
    delete: async args => failDelete ? { ok: false } : blob.delete(args),
  }));
  process.env.OPENWOP_SURFACE_BLOB = 'replay-erasure-witness';
  for (const subjectKey of ['visitor:erase-me', 'visitor:keep-me']) {
    await mergeConsentCategories({ tenantId, subjectKey,
      categories: { 'analytics.replay': true }, source: 'public:client-a' });
  }
});
// ADR 0951 P2.5: recordings need both replay toggles ON (helpers/replayToggles.ts).
beforeEach(async () => { await setReplayToggles('on'); await attestReplayOrg(tenantId, 'client-a'); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (originalBackend === undefined) delete process.env.OPENWOP_SURFACE_BLOB;
  else process.env.OPENWOP_SURFACE_BLOB = originalBackend;
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(subjectKey = 'visitor:erase-me'): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey,
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100,
    bytes: Buffer.from(CHUNK, 'base64').length, chunkCount: 1, flags: {} };
}
async function keys(r: ReplaySession): Promise<string[]> {
  const result = await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) }) as { entries: Array<{ key: string }> };
  return result.entries.map(entry => entry.key);
}
const get = (r: ReplaySession) => getReplaySession(r.tenantId, r.orgId, r.sessionId);

describe('ADR 0951 P2.5 — durable erasure fences', () => {
  it('failed physical deletion hides the session across clients and retains a retry path', async () => {
    const mine = row();
    const other = row('visitor:keep-me');
    await putReplayChunk(mine, 0, CHUNK);
    await putReplayChunk(other, 0, CHUNK);
    expect(await keys(mine)).toHaveLength(1);
    failDelete = true;
    await expect(eraseSubjectReplays(tenantId, mine.subjectKey)).rejects.toThrow();
    initHostExtPersistence(b);
    expect(await get(mine)).toBeNull();
    expect((await listReplaySessionsForTenant(tenantId)).map(item => item.sessionId)).toEqual([other.sessionId]);
    expect(await keys(mine), 'physical bytes remain, so this is not a false success witness').toHaveLength(1);
    failDelete = false;
    await eraseSubjectReplays(tenantId, mine.subjectKey);
    expect(await keys(mine)).toEqual([]);
    expect(await get(mine)).toBeNull();
    expect(await get(other)).not.toBeNull();
    expect(await keys(other)).toHaveLength(1);
  });

  it('a later storage client cannot reuse an erased session identity', async () => {
    const mine = row();
    await putReplayChunk(mine, 0, CHUNK);
    await eraseSubjectReplays(tenantId, mine.subjectKey);
    expect(await keys(mine)).toEqual([]);
    const receipt = await b.kvGet(`hostext:analytics:replay:${tenantId}:${mine.orgId}:${mine.sessionId}`);
    expect(receipt && JSON.parse(receipt)).toEqual({
      tenantId, orgId: mine.orgId, sessionId: mine.sessionId, privacy: { state: 'erased', erasedAt: expect.any(String) },
    });
    initHostExtPersistence(b);
    await expect(putReplayChunk(mine, 1, CHUNK)).rejects.toThrow();
    expect(await get(mine)).toBeNull();
    expect(await keys(mine)).toEqual([]);
  });

  it('the sweep keeps an erased fence for a day, then drops it; a fence without erasedAt is stamped first', async () => {
    const { sweepExpiredReplays } = await import('../src/features/analytics/replayStore.js');
    const mine = row();
    await putReplayChunk(mine, 0, CHUNK);
    await eraseSubjectReplays(tenantId, mine.subjectKey);
    const fenceKey = `hostext:analytics:replay:${tenantId}:${mine.orgId}:${mine.sessionId}`;
    const erasedAt = (JSON.parse((await b.kvGet(fenceKey))!) as { privacy: { erasedAt: string } }).privacy.erasedAt;
    await sweepExpiredReplays(Date.parse(erasedAt) + 23 * 3_600_000);
    expect(await b.kvGet(fenceKey)).not.toBeNull();
    await sweepExpiredReplays(Date.parse(erasedAt) + 25 * 3_600_000);
    expect(await b.kvGet(fenceKey)).toBeNull();
    const legacyKey = `hostext:analytics:replay:${tenantId}:${mine.orgId}:legacy-fence`;
    await b.kvSet(legacyKey, JSON.stringify({ tenantId, orgId: mine.orgId, sessionId: 'legacy-fence', privacy: { state: 'erased' } }));
    const now = Date.now();
    await sweepExpiredReplays(now);
    const stamped = JSON.parse((await b.kvGet(legacyKey))!) as { privacy: { erasedAt?: string } };
    expect(stamped.privacy.erasedAt).toBe(new Date(now).toISOString());
    await sweepExpiredReplays(now + 25 * 3_600_000);
    expect(await b.kvGet(legacyKey)).toBeNull();
  });

  it('a lost finalization acknowledgement preserves the committed chunk', async () => {
    const mine = row();
    let committed: unknown;
    const original = a.kvCompareAndSwap.bind(a);
    let injected = false;
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const result = await original(key, expected, next);
      if (result.swapped && key.startsWith('hostext:analytics:replay:')
        && JSON.parse(next).privacy?.committed === true && !injected) {
        injected = true;
        const { privacy: _privacy, ...recording } = JSON.parse(next);
        committed = recording;
        throw new Error('Lost acknowledgement after SQLite committed');
      }
      return result;
    });
    await putReplayChunk(mine, 0, CHUNK);
    expect(injected).toBe(true);
    initHostExtPersistence(b);
    const { startedAt: _startedAt, updatedAt: _updatedAt, ...content } = mine;
    expect(committed).toMatchObject(content);
    expect(await get(mine)).toEqual(committed);
    expect(await keys(mine)).toHaveLength(1);
    expect(await blob.get({ key: `${replayChunkPrefix(tenantId, mine.orgId, mine.sessionId)}0` })).toMatchObject({ contentBase64: CHUNK });
  });

  it('a lost blob response retains an unsettled receipt even after an empty-prefix delete', async () => {
    const mine = row();
    let finishRemotePut: (() => Promise<unknown>) | undefined;
    registerSurfaceAdapter<BlobSurface>('blob', 'replay-erasure-witness', () => ({
      ...blob,
      put: async args => {
        // The caller loses its response while the remote service still owns
        // the operation. A subsequent DELETE can finish before that PUT.
        finishRemotePut = () => blob.put(args);
        throw new Error('Blob response lost; remote completion is unknown');
      },
    }));
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toThrow(/response lost/);
    expect(await keys(mine)).toEqual([]);
    initHostExtPersistence(b);
    await expect(eraseSubjectReplays(tenantId, mine.subjectKey)).rejects.toThrow(/not deleted/);
    expect(finishRemotePut).toBeTypeOf('function');
    await finishRemotePut?.();
    expect(await keys(mine), 'the remote PUT can land after the first deletion').toHaveLength(1);
    await expect(eraseSubjectReplays(tenantId, mine.subjectKey)).rejects.toThrow(/not deleted/);
    expect(await keys(mine)).toEqual([]);
    expect(await get(mine)).toBeNull();
    const receipt = await b.kvGet(`hostext:analytics:replay:${tenantId}:${mine.orgId}:${mine.sessionId}`);
    expect(receipt && JSON.parse(receipt)).toMatchObject({ privacy: { state: 'erasing', pending: [expect.any(Object)] } });
  });

  it('a missing put acknowledgement cannot publish a readable session', async () => {
    const mine = row();
    registerSurfaceAdapter<BlobSurface>('blob', 'replay-erasure-witness', () => ({ ...blob, put: async () => ({}) }));
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toThrow();
    initHostExtPersistence(b);
    expect(await get(mine)).toBeNull();
    await expect(eraseSubjectReplays(tenantId, mine.subjectKey)).rejects.toThrow(/not deleted/);
  });

  it('a missing delete acknowledgement cannot discard the retry record', async () => {
    const mine = row();
    await putReplayChunk(mine, 0, CHUNK);
    registerSurfaceAdapter<BlobSurface>('blob', 'replay-erasure-witness', () => ({ ...blob, delete: async () => ({}) }));
    await expect(eraseSubjectReplays(tenantId, mine.subjectKey)).rejects.toThrow(/not deleted/);
    initHostExtPersistence(b);
    expect(await get(mine)).toBeNull();
    expect(await keys(mine)).toHaveLength(1);
    registerSurfaceAdapter<BlobSurface>('blob', 'replay-erasure-witness', () => blob);
    await eraseSubjectReplays(tenantId, mine.subjectKey);
    expect(await keys(mine)).toEqual([]);
  });

  it('erasure while the first blob write is delayed prevents finalization and removes late bytes', async () => {
    const mine = row();
    let entered!: () => void;
    let resume!: () => void;
    const atBlob = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { resume = resolve; });
    beforePut = async () => { entered(); await barrier; };
    const pending = putReplayChunk(mine, 0, CHUNK).then(
      () => ({ status: 'fulfilled' as const }),
      error => ({ status: 'rejected' as const, error }),
    );
    try {
      await atBlob;
      expect(await keys(mine)).toEqual([]);
      initHostExtPersistence(b);
      // The empty prefix is not completion: the admitted blob put has not
      // settled. Erasure must deny reads now and truthfully report pending work.
      await expect(eraseSubjectReplays(tenantId, mine.subjectKey)).rejects.toThrow(/not deleted/);
      expect(await get(mine)).toBeNull();
    } finally { resume(); }
    const outcome = await pending;
    expect(outcome.status).toBe('rejected');
    expect(await get(mine)).toBeNull();
    expect(await keys(mine)).toEqual([]);
    await eraseSubjectReplays(tenantId, mine.subjectKey);
  });
});
