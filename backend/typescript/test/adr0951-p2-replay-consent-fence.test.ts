/** ADR 0951 P2.2/P2.5: the consent row, not a successful deletion callback,
 * decides whether a recording can be read or finalized. Two SQLite clients
 * share real rows and real blob bytes. Faults pause a specific CAS or fail the
 * existing cleanup hook; no consent/store evaluator is mocked. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildHostSurfaceBundle, initInMemorySurfaces, type BlobSurface } from '../src/host/inMemorySurfaces.js';
import { registerSurfaceAdapter } from '../src/host/surfaceBackends.js';
import {
  getConsent, mergeConsentCategories, registerConsentWithdrawalHook, writeErasureTombstone,
} from '../src/features/consent/consentService.js';
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
let tenantId: string;
let writes: number;
const CHUNK = Buffer.from('masked geometry').toString('base64');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-consent-fence-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-consent-fence-${randomUUID()}`;
  originalBackend = process.env.OPENWOP_SURFACE_BLOB;
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  writes = 0;
  registerSurfaceAdapter<BlobSurface>('blob', 'replay-consent-fence-witness', () => ({
    ...blob, put: async args => { writes++; return blob.put(args); },
  }));
  process.env.OPENWOP_SURFACE_BLOB = 'replay-consent-fence-witness';
});
// ADR 0951 P2.5: recordings need both replay toggles ON (helpers/replayToggles.ts).
beforeEach(async () => { await setReplayToggles('on'); await attestReplayOrg(tenantId, 'client-a'); });
afterEach(async () => {
  vi.restoreAllMocks();
  registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', eraseSubjectReplays);
  if (originalBackend === undefined) delete process.env.OPENWOP_SURFACE_BLOB;
  else process.env.OPENWOP_SURFACE_BLOB = originalBackend;
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey: 'visitor:recording',
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100, bytes: 0, chunkCount: 0, flags: {} };
}
const rawKey = (r: ReplaySession) => `hostext:analytics:replay:${r.tenantId}:${r.orgId}:${r.sessionId}`;
const consentKey = (r: ReplaySession) => `hostext:consent:record:${r.tenantId}:${r.subjectKey}`;
const get = (r: ReplaySession) => getReplaySession(r.tenantId, r.orgId, r.sessionId);
const choose = (r: ReplaySession, granted: boolean) => mergeConsentCategories({
  tenantId: r.tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': granted }, source: `public:${r.orgId}`,
});
async function keys(r: ReplaySession): Promise<string[]> {
  const result = await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) }) as { entries: Array<{ key: string }> };
  return result.entries.map(entry => entry.key);
}
function failCleanupHook(): void {
  registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', async () => { throw new Error('cleanup unavailable'); });
}

describe('ADR 0951 P2 — consent fences every recording boundary', () => {
  it('refuses a first write without a current visitor grant before storing any bytes', async () => {
    const mine = row();
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await keys(mine)).toEqual([]);
    expect(await b.kvGet(rawKey(mine))).toBeNull();
    expect(writes).toBe(0);
  });

  it('a legacy boolean grant cannot admit recording until the visitor affirms again', async () => {
    const mine = row();
    await b.kvSet(consentKey(mine), JSON.stringify({ tenantId, subjectKey: mine.subjectKey,
      categories: { necessary: true, analytics: true, marketing: false, 'analytics.replay': true },
      source: 'public:client-a', ts: new Date().toISOString() }));
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await keys(mine)).toEqual([]);
    await choose(mine, true);
    await putReplayChunk(mine, 0, CHUNK);
    expect(await get(mine)).toMatchObject({ sessionId: mine.sessionId });
  });

  it('withdrawal hides rows even if the physical deletion callback fails; re-grant does not revive them', async () => {
    const mine = row();
    await choose(mine, true);
    const original = (await getConsent(tenantId, mine.subjectKey))?.strictGrantGenerations?.['analytics.replay'];
    await putReplayChunk(mine, 0, CHUNK);
    failCleanupHook();
    initHostExtPersistence(b);
    await choose(mine, false);
    expect(await keys(mine), 'bytes really remain after the failed callback').toHaveLength(1);
    expect(await get(mine)).toBeNull();
    expect(await listReplaySessionsForTenant(tenantId)).toEqual([]);
    await choose(mine, true);
    expect((await getConsent(tenantId, mine.subjectKey))?.strictGrantGenerations?.['analytics.replay']).not.toBe(original);
    expect(await get(mine)).toBeNull();
    await expect(putReplayChunk(mine, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    const fresh = { ...mine, sessionId: randomUUID() };
    await putReplayChunk(fresh, 0, CHUNK);
    expect(await get(fresh)).toMatchObject({ sessionId: fresh.sessionId });
  });

  it('withdrawal before the first reservation CAS cannot be missed by an empty erasure scan', async () => {
    const mine = row();
    await choose(mine, true);
    const cas = a.kvCompareAndSwap.bind(a);
    let withdrew = false;
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === rawKey(mine) && !withdrew) {
        withdrew = true;
        initHostExtPersistence(b);
        try { await choose(mine, false); } finally { initHostExtPersistence(a); }
      }
      return cas(...args);
    });
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(withdrew).toBe(true);
    expect(writes, 'a refusal observed after reservation must stop before the blob provider').toBe(0);
    expect(await get(mine)).toBeNull();
    expect(await keys(mine)).toEqual([]);
    await expect(eraseSubjectReplays(tenantId, mine.subjectKey)).resolves.toEqual({ rowsTouched: expect.any(Number) });
  });

  it('a grant changed during a read cannot authorize bytes from the prior generation', async () => {
    const mine = row();
    await choose(mine, true);
    await putReplayChunk(mine, 0, CHUNK);
    failCleanupHook();
    const read = a.kvGet.bind(a);
    let injected = false;
    vi.spyOn(a, 'kvGet').mockImplementation(async key => {
      const raw = await read(key);
      if (key === consentKey(mine) && !injected) {
        injected = true;
        initHostExtPersistence(b);
        try { await choose(mine, false); await choose(mine, true); }
        finally { initHostExtPersistence(a); }
      }
      return raw;
    });
    expect(await get(mine)).toBeNull();
    expect(injected).toBe(true);
    expect(await keys(mine)).toHaveLength(1);
  });

  it('legacy recordings without a pinned generation stay unreadable and cannot be adopted by a fresh grant', async () => {
    const mine = row();
    await choose(mine, true);
    // The historical shape has no privacy/consent-generation receipt. Keep real
    // bytes to distinguish denied visibility from a fixture with no recording.
    await putReplayChunk(mine, 0, CHUNK);
    await b.kvSet(rawKey(mine), JSON.stringify({ ...mine, bytes: 15, chunkCount: 1 }));
    expect(await get(mine)).toBeNull();
    await expect(putReplayChunk(mine, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await keys(mine)).toHaveLength(1);
    await eraseSubjectReplays(tenantId, mine.subjectKey);
    expect(await keys(mine)).toEqual([]);
  });

  it('withdrawal between the final consent read and replay CAS cannot publish a recording', async () => {
    const mine = row();
    await choose(mine, true);
    failCleanupHook();
    const cas = a.kvCompareAndSwap.bind(a);
    let withdrew = false;
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0] === rawKey(mine) && JSON.parse(args[2]).privacy?.committed === true && !withdrew) {
        withdrew = true;
        initHostExtPersistence(b);
        try { await choose(mine, false); } finally { initHostExtPersistence(a); }
      }
      return cas(...args);
    });
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(withdrew).toBe(true);
    expect(await get(mine)).toBeNull();
    expect(await keys(mine)).toEqual([]);
  });

  it('lost finalization acknowledgement cannot rescue a now-withdrawn grant as successful', async () => {
    const mine = row();
    await choose(mine, true);
    failCleanupHook();
    const cas = a.kvCompareAndSwap.bind(a);
    let injected = false;
    vi.spyOn(a, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      const result = await cas(...args);
      if (args[0] === rawKey(mine) && result.swapped && JSON.parse(args[2]).privacy?.committed === true && !injected) {
        injected = true;
        initHostExtPersistence(b);
        try { await choose(mine, false); } finally { initHostExtPersistence(a); }
        throw new Error('finalization response lost');
      }
      return result;
    });
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await get(mine)).toBeNull();
    expect(await keys(mine)).toEqual([]);
  });

  it.each(['subjectKey', 'sessionKey'] as const)('an erasure tombstone for %s denies existing bytes and later writes', async identity => {
    const mine = { ...row(), sessionKey: 'analytics-session' };
    await choose(mine, true);
    await putReplayChunk(mine, 0, CHUNK);
    initHostExtPersistence(b);
    await writeErasureTombstone(tenantId, mine[identity]);
    expect(await keys(mine)).toHaveLength(1);
    expect(await get(mine)).toBeNull();
    await expect(putReplayChunk(mine, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('consent-store failure refuses reads and new writes without deleting acknowledged content', async () => {
    const mine = row();
    await choose(mine, true);
    await putReplayChunk(mine, 0, CHUNK);
    const read = a.kvGet.bind(a);
    vi.spyOn(a, 'kvGet').mockImplementation(async key => {
      if (key === consentKey(mine)) throw new Error('consent store unavailable');
      return read(key);
    });
    await expect(get(mine)).rejects.toThrow('consent store unavailable');
    await expect(putReplayChunk(mine, 1, CHUNK)).rejects.toThrow('consent store unavailable');
    expect(await keys(mine)).toHaveLength(1);
  });
});
