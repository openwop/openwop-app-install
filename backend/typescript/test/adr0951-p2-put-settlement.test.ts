/** ADR 0951 P2.5: a replay upload whose outcome is unknown leaves a durable
 * receipt. The upload is aborted at `REPLAY_PUT_DEADLINE_MS`, so after
 * `REPLAY_SETTLE_AFTER_MS` it cannot land: erasure and the sweep may then delete
 * what it stored and drop the receipt. Before that, or on a backend that cannot
 * enforce the deadline, the receipt stays and erasure still reports it. Two
 * SQLite clients share real rows; blob bytes are real (memory backend). */
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
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, REPLAY_PUT_DEADLINE_MS, REPLAY_SETTLE_AFTER_MS, deleteReplaySession, putReplayChunk,
  replayChunkPrefix, sweepExpiredReplays, type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let b: Storage;
let dir: string;
let blob: BlobSurface;
let saved: Record<string, string | undefined>;
let tenantId: string;
const CHUNK = Buffer.from('masked geometry').toString('base64');
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB'] as const;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-settle-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-settle-${randomUUID()}`;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
});
// ADR 0951 P2.5: recordings need both replay toggles ON (helpers/replayToggles.ts).
beforeEach(async () => { await setReplayToggles('on'); await attestReplayOrg(tenantId, 'client-a'); });
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey: 'visitor:settle',
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100, bytes: 0, chunkCount: 0, flags: {} };
}
const rawKey = (r: ReplaySession) => `hostext:analytics:replay:${r.tenantId}:${r.orgId}:${r.sessionId}`;
const chunkKey = (r: ReplaySession, i: number) => `${replayChunkPrefix(r.tenantId, r.orgId, r.sessionId)}${i}`;
type Receipt = { id: string; chunkIndex: number; digest: string; bytes: number; reservedAt?: string; observedAt?: string };
const receipt = (chunkIndex: number, reservedAt?: string): Receipt =>
  ({ id: randomUUID(), chunkIndex, digest: 'unknown', bytes: 15, ...(reservedAt ? { reservedAt } : {}) });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** An active recording whose writer died mid-upload, and the bytes that upload landed. */
async function stranded(r: ReplaySession, pending: Receipt[], state: 'active' | 'erasing' = 'active'): Promise<void> {
  await b.kvSet(rawKey(r), JSON.stringify({ ...r, privacy: { state, committed: false, pending, chunks: {}, consentGeneration: 'g' } }));
  for (const p of pending) await blob.put({ key: chunkKey(r, p.chunkIndex), contentBase64: CHUNK });
}
const stored = async (r: ReplaySession) => JSON.parse((await b.kvGet(rawKey(r)))!) as { privacy: { state: string; pending?: Receipt[] } };
const present = async (r: ReplaySession, i: number) => ((await blob.get({ key: chunkKey(r, i) })) as { found: boolean }).found;

describe('ADR 0951 P2.5 — unknown-PUT settlement', () => {
  it('bounds every replay upload with an abort deadline the adapter receives', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let seen: unknown;
    registerSurfaceAdapter<BlobSurface>('blob', 'replay-settle-deadline', () => ({
      ...blob, put: async (args) => { seen = args.signal; return blob.put(args); },
    }));
    process.env.OPENWOP_SURFACE_BLOB = 'replay-settle-deadline';
    const mine = row();
    await mergeConsentCategories({ tenantId, subjectKey: mine.subjectKey, categories: { 'analytics.replay': true }, source: 'public:client-a' });
    await putReplayChunk(mine, 0, CHUNK);
    expect(timeout).toHaveBeenCalledWith(REPLAY_PUT_DEADLINE_MS);
    expect(seen).toBe(controller.signal);
  });

  it('erasure settles a receipt older than the window: late bytes deleted, recording erased', async () => {
    const mine = row();
    await stranded(mine, [receipt(0, ago(REPLAY_SETTLE_AFTER_MS + 1000))]);
    await deleteReplaySession(mine);
    expect(await present(mine, 0)).toBe(false);
    expect((await stored(mine)).privacy.state).toBe('erased');
  });

  it('a receipt inside the window is not settled: erasure still reports it and keeps the receipt', async () => {
    const mine = row();
    const fresh = receipt(0, ago(REPLAY_SETTLE_AFTER_MS - 60_000));
    await stranded(mine, [fresh]);
    await expect(deleteReplaySession(mine)).rejects.toThrow(/awaits unsettled blob writes/);
    const after = await stored(mine);
    expect(after.privacy.state).toBe('erasing');
    expect(after.privacy.pending?.map((p) => p.id)).toEqual([fresh.id]);
  });

  it('a receipt from before P2.5 (no reservedAt) is stamped first and settled one window later', async () => {
    const mine = row();
    await stranded(mine, [receipt(0)]);
    await expect(deleteReplaySession(mine)).rejects.toThrow(/awaits unsettled blob writes/);
    const observedAt = (await stored(mine)).privacy.pending?.[0]?.observedAt;
    expect(observedAt).toBeTypeOf('string');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(observedAt!) + REPLAY_SETTLE_AFTER_MS - 1000);
    await expect(deleteReplaySession(mine)).rejects.toThrow(/awaits unsettled blob writes/);
    vi.setSystemTime(Date.parse(observedAt!) + REPLAY_SETTLE_AFTER_MS);
    await deleteReplaySession(mine);
    expect((await stored(mine)).privacy.state).toBe('erased');
  });

  it('a backend that cannot enforce the deadline never settles, however old the receipt', async () => {
    registerSurfaceAdapter<BlobSurface>('blob', 'replay-settle-unbounded', () => blob);
    process.env.OPENWOP_SURFACE_BLOB = 'replay-settle-unbounded';
    const mine = row();
    const old = receipt(0, ago(30 * REPLAY_SETTLE_AFTER_MS));
    await stranded(mine, [old]);
    await expect(deleteReplaySession(mine)).rejects.toThrow(/awaits unsettled blob writes/);
    expect((await stored(mine)).privacy.pending?.map((p) => p.id)).toEqual([old.id]);
  });

  it('the sweep settles a live recording, freeing the capacity its stale receipts held', async () => {
    const mine = row();
    await mergeConsentCategories({ tenantId, subjectKey: mine.subjectKey, categories: { 'analytics.replay': true }, source: 'public:client-a' });
    const generation = await (await import('../src/features/consent/consentService.js'))
      .getStrictGrantGeneration(tenantId, mine.subjectKey, 'analytics.replay');
    const full = Array.from({ length: 32 }, (_, i) => receipt(i + 1, ago(REPLAY_SETTLE_AFTER_MS + 1000)));
    await b.kvSet(rawKey(mine), JSON.stringify({ ...mine, privacy: {
      state: 'active', committed: true, pending: full, chunks: {}, consentGeneration: generation, eligibilityId: `test-${tenantId}-client-a` } }));
    await blob.put({ key: chunkKey(mine, 5), contentBase64: CHUNK });
    await expect(putReplayChunk(mine, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    await sweepExpiredReplays();
    expect((await stored(mine)).privacy.pending).toEqual([]);
    expect(await present(mine, 5)).toBe(false);
    await putReplayChunk(mine, 0, CHUNK);
    expect(await present(mine, 0)).toBe(true);
  });
});
