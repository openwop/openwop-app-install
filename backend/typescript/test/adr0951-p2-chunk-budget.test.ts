/** ADR 0951 P2.3: committed sequences are immutable and outstanding writes
 * consume durable capacity. The second SQLite connection sees the actual CAS
 * reservation while the first writer is paused before its real blob PUT.
 * This does not qualify public admission, consent generation or a cloud provider.
 */
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
  REPLAY_BLOB_ROOT, REPLAY_MAX_CHUNK_BYTES, REPLAY_MAX_SESSION_BYTES, REPLAY_MAX_SESSION_CHUNKS,
  getReplaySession, putReplayChunk, replayChunkPrefix, sweepExpiredReplays, type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let b: Storage;
let dir: string;
let blob: BlobSurface;
let originalBackend: string | undefined;
let beforePut: ((key: string) => Promise<void>) | undefined;
let writes: number;
let tenantId: string;
const SMALL = Buffer.from('masked geometry').toString('base64');
const LARGE = Buffer.alloc(256 * 1024, 7).toString('base64');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-budget-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-budget-${randomUUID()}`;
  originalBackend = process.env.OPENWOP_SURFACE_BLOB;
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  writes = 0;
  beforePut = undefined;
  registerSurfaceAdapter<BlobSurface>('blob', 'replay-budget-witness', () => ({
    ...blob,
    put: async args => { writes++; await beforePut?.(String(args.key)); return blob.put(args); },
  }));
  process.env.OPENWOP_SURFACE_BLOB = 'replay-budget-witness';
  await mergeConsentCategories({ tenantId, subjectKey: 'visitor:budget',
    categories: { 'analytics.replay': true }, source: 'public:client-a' });
});
// ADR 0951 P2.5: recordings need both replay toggles ON (helpers/replayToggles.ts).
beforeEach(async () => { await setReplayToggles('on'); await attestReplayOrg(tenantId, 'client-a'); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalBackend === undefined) delete process.env.OPENWOP_SURFACE_BLOB;
  else process.env.OPENWOP_SURFACE_BLOB = originalBackend;
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey: 'visitor:budget',
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100,
    bytes: 0, chunkCount: 0, flags: {} };
}
const read = (r: ReplaySession) => getReplaySession(r.tenantId, r.orgId, r.sessionId);
const stored = (r: ReplaySession, index: number) => blob.get({ key: `${replayChunkPrefix(r.tenantId, r.orgId, r.sessionId)}${index}` });
const rawKey = (r: ReplaySession) => `hostext:analytics:replay:${r.tenantId}:${r.orgId}:${r.sessionId}`;
const SERVER_START = '2026-10-01T12:00:00.000Z';
function serverTime(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

describe('ADR 0951 P2.3 — immutable replay chunks and durable byte ceilings', () => {
  it.each(['2099-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z'])(
    'uses server time instead of a supplied %s clock, including on later chunks', async supplied => {
      serverTime(SERVER_START);
      const r = { ...row(), startedAt: supplied, updatedAt: supplied };
      await putReplayChunk(r, 0, SMALL);
      expect(await read(r)).toMatchObject({ startedAt: SERVER_START, updatedAt: SERVER_START });
      initHostExtPersistence(b);
      vi.setSystemTime(new Date('2026-10-01T12:02:00.000Z'));
      await putReplayChunk({ ...r, startedAt: '2100-01-01T00:00:00.000Z', pageIds: ['page-a', 'page-b'] }, 1, SMALL);
      expect(await read(r)).toMatchObject({ startedAt: SERVER_START, updatedAt: '2026-10-01T12:02:00.000Z', pageIds: ['page-a', 'page-b'], chunkCount: 2 });
    },
  );

  it('preserves the first reservation and higher-sequence metadata when an earlier PUT finishes late', async () => {
    serverTime(SERVER_START);
    const r = { ...row(), startedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
    let release = (): void => {};
    let entered = (): void => {};
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    beforePut = async key => { if (key.endsWith('/0')) { entered(); await barrier; } };
    const first = putReplayChunk(r, 0, SMALL);
    await waiting;
    try {
      const pending = await b.kvGet(rawKey(r));
      expect(pending).not.toBeNull();
      expect(JSON.parse(pending!)).toMatchObject({ startedAt: SERVER_START, privacy: { committed: false } });
      initHostExtPersistence(b);
      vi.setSystemTime(new Date('2026-10-01T12:01:00.000Z'));
      await putReplayChunk({ ...r, updatedAt: '2000-01-01T00:00:00.000Z', pageIds: ['page-a', 'page-b'], durationMs: 200 }, 1, SMALL);
      expect(await read(r)).toMatchObject({ startedAt: SERVER_START, updatedAt: '2026-10-01T12:01:00.000Z', chunkCount: 1 });
      vi.setSystemTime(new Date('2026-10-01T12:02:00.000Z'));
    } finally { release(); await first; }
    expect(await read(r)).toMatchObject({ startedAt: SERVER_START, updatedAt: '2026-10-01T12:02:00.000Z', pageIds: ['page-a', 'page-b'], durationMs: 200, bytes: 30, chunkCount: 2 });
  });

  it('does not move either clock on retry or move updatedAt backwards on a new write', async () => {
    serverTime(SERVER_START);
    const r = row();
    await putReplayChunk(r, 0, SMALL);
    const first = await read(r);
    vi.setSystemTime(new Date('2026-10-01T12:05:00.000Z'));
    await putReplayChunk({ ...r, startedAt: '2100-01-01T00:00:00.000Z' }, 0, SMALL);
    expect(await read(r)).toEqual(first);
    vi.setSystemTime(new Date('2026-10-01T11:59:00.000Z'));
    await putReplayChunk(r, 1, SMALL);
    expect(await read(r)).toMatchObject({ startedAt: SERVER_START, updatedAt: SERVER_START, chunkCount: 2 });
    expect(writes).toBe(2);
  });

  it('expires actual blobs from the server start despite a later chunk and a forged future start', async () => {
    serverTime(SERVER_START);
    const r = { ...row(), startedAt: '2099-01-01T00:00:00.000Z', updatedAt: '2099-01-01T00:00:00.000Z' };
    await putReplayChunk(r, 0, SMALL);
    // 20 minutes in: inside the 30-minute session limit (P2.3 admission).
    vi.setSystemTime(new Date('2026-10-01T12:20:00.000Z'));
    await putReplayChunk(r, 1, SMALL);
    initHostExtPersistence(b);
    vi.setSystemTime(new Date('2026-10-31T11:59:00.000Z'));
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await stored(r, 0)).toMatchObject({ contentBase64: SMALL });
    expect(await stored(r, 1)).toMatchObject({ contentBase64: SMALL });
    // 30 days from the server start, but under 30 days from the later chunk.
    vi.setSystemTime(new Date('2026-10-31T12:10:00.000Z'));
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await read(r)).toBeNull();
    expect(await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) })).toMatchObject({ entries: [] });
  });

  it('retries the same bytes without another PUT, charge or metadata change', async () => {
    const r = row();
    await putReplayChunk(r, 0, SMALL);
    const before = await read(r);
    expect(before).toMatchObject({ bytes: 15, chunkCount: 1 });
    initHostExtPersistence(b);
    await putReplayChunk({ ...r, bytes: 123456, chunkCount: 999, updatedAt: '2099-01-01T00:00:00Z' }, 0, SMALL);
    expect(writes).toBe(1);
    expect(await read(r)).toEqual(before);
  });

  it('refuses different bytes at a committed sequence and preserves the original blob', async () => {
    const r = row();
    await putReplayChunk(r, 0, SMALL);
    const before = await stored(r, 0);
    expect(before).toMatchObject({ contentBase64: SMALL });
    initHostExtPersistence(b);
    await expect(putReplayChunk(r, 0, Buffer.from('replacement').toString('base64'))).rejects.toMatchObject({ httpStatus: 409 });
    expect(writes).toBe(1);
    expect(await stored(r, 0)).toEqual(before);
    expect(await read(r)).toMatchObject({ bytes: 15, chunkCount: 1 });
  });

  it('derives counts from finalized content instead of trusting supplied counters', async () => {
    const r = row();
    await putReplayChunk({ ...r, bytes: 1_000_000, chunkCount: 90 }, 0, SMALL);
    initHostExtPersistence(b);
    await putReplayChunk({ ...r, bytes: 0, chunkCount: 0 }, 1, Buffer.from('next').toString('base64'));
    expect(await read(r)).toMatchObject({ bytes: 19, chunkCount: 2 });
    expect(await stored(r, 0)).toMatchObject({ contentBase64: SMALL });
    expect(await stored(r, 1)).toMatchObject({ contentBase64: Buffer.from('next').toString('base64') });
  });

  it('keeps both receipts when the second writer finalizes before the first', async () => {
    const r = row();
    let release = (): void => {};
    let entered = (): void => {};
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    beforePut = async key => { if (key.endsWith('/0')) { entered(); await barrier; } };
    const first = putReplayChunk(r, 0, SMALL);
    await waiting;
    try {
      initHostExtPersistence(b);
      await putReplayChunk(r, 1, Buffer.from('next').toString('base64'));
      expect(await read(r)).toMatchObject({ bytes: 4, chunkCount: 1 });
    } finally { release(); await first; }
    expect(await read(r)).toMatchObject({ bytes: 19, chunkCount: 2 });
    const raw = await b.kvGet(rawKey(r));
    expect(raw).not.toBeNull();
    expect(Object.keys(JSON.parse(raw!).privacy.chunks).sort()).toEqual(['0', '1']);
    expect(await stored(r, 0)).toMatchObject({ contentBase64: SMALL });
    expect(await stored(r, 1)).toMatchObject({ contentBase64: Buffer.from('next').toString('base64') });
  });

  it('counts a pending last-slot PUT against the ceiling on a separate SQLite connection', async () => {
    const r = row();
    expect(REPLAY_MAX_CHUNK_BYTES).toBe(256 * 1024);
    expect(REPLAY_MAX_SESSION_BYTES).toBe(5 * 1024 * 1024);
    for (let i = 0; i < 19; i++) await putReplayChunk(r, i, LARGE);
    let release = (): void => {};
    let entered = (): void => {};
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    beforePut = async key => { if (key.endsWith('/19')) { entered(); await barrier; } };
    const pending = putReplayChunk(r, 19, LARGE);
    await waiting;
    try {
      // The second client observes the persisted reservation before there is a
      // twentieth blob. Removing reservedBytes from the cap must admit #20 RED.
      const raw = await b.kvGet(rawKey(r));
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).privacy.pending).toEqual([expect.objectContaining({ chunkIndex: 19, bytes: 256 * 1024 })]);
      initHostExtPersistence(b);
      await expect(putReplayChunk(r, 20, LARGE)).rejects.toMatchObject({ httpStatus: 409 });
      expect(writes).toBe(20);
    } finally { release(); await pending; }
    expect(await read(r)).toMatchObject({ bytes: 5 * 1024 * 1024, chunkCount: 20 });
    const keys = await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) }) as { entries: unknown[] };
    expect(keys.entries).toHaveLength(20);
  });

  it('refuses a new write when the finalized bytes already fill the budget', async () => {
    const r = row();
    for (let i = 0; i < 20; i++) await putReplayChunk(r, i, LARGE);
    initHostExtPersistence(b);
    await expect(putReplayChunk(r, 20, SMALL)).rejects.toMatchObject({ httpStatus: 409 });
    expect(writes).toBe(20);
    // An identical retry still succeeds at capacity; it is not a new charge.
    await putReplayChunk(r, 19, LARGE);
    expect(writes).toBe(20);
  });

  it.each([
    ['', 0], ['!bad!', 0], ['YQ=', 0], ['YR==', 0],
    [Buffer.alloc(256 * 1024 + 1).toString('base64'), 0], [SMALL, -1], [SMALL, 2048],
  ])('rejects malformed, oversized or out-of-range chunks before storage %#', async (content, index) => {
    const r = row();
    expect(REPLAY_MAX_SESSION_CHUNKS).toBe(2048);
    await expect(putReplayChunk(r, Number(index), String(content))).rejects.toMatchObject({ httpStatus: 400 });
    expect(writes).toBe(0);
    expect(await b.kvGet(rawKey(r))).toBeNull();
  });

  it('does not reinterpret a legacy row without sequence receipts as empty capacity', async () => {
    const r = { ...row(), bytes: 2048, chunkCount: 1 };
    await b.kvSet(rawKey(r), JSON.stringify(r));
    await expect(putReplayChunk(r, 0, SMALL)).rejects.toMatchObject({ httpStatus: 409 });
    expect(writes).toBe(0);
    // The row is left byte-identical. Read it raw: since the consent-generation
    // fence (de39cd21b) a row without a pinned generation is invisible to
    // getReplaySession, so the fenced reader would answer null either way.
    expect(JSON.parse((await b.kvGet(rawKey(r)))!)).toEqual(r);
    expect(await read(r)).toBeNull();
  });
});
