/** ADR 0951 P2 review, finding 1 — a replay OFF must be recorded from the WRITE,
 * not from a later re-read of live state. The listener used to re-resolve the
 * toggles when it ran, so a listener that outlived its 2 s budget, a process
 * that died before the listener ran, or an admin who turned replay back on
 * within seconds all meant the OFF was never recorded: the sweep then saw ON
 * and the recording came back. The fix records a durable "replay toggle
 * written" marker BEFORE the toggle write, resolves the write itself, and has
 * every read and sweep apply a pending marker before it trusts an ON.
 * Real SQLite rows, real toggle service, real blob bytes (memory backend). */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildHostSurfaceBundle, initInMemorySurfaces, type BlobSurface } from '../src/host/inMemorySurfaces.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerToggleWriteIntent, registerToggleWriteListener, saveConfig } from '../src/host/featureToggles/service.js';
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, getReplaySession, onReplayToggleWrite, putReplayChunk, recordReplayToggleIntent, replayChunkPrefix, sweepExpiredReplays,
  type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let b: Storage;
let dir: string;
let blob: BlobSurface;
let saved: Record<string, string | undefined>;
const CHUNK = Buffer.from('masked geometry').toString('base64');
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB'] as const;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-toggle-write-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  await setReplayToggles('on');
});
afterEach(async () => {
  vi.restoreAllMocks();
  registerToggleWriteListener('analytics-replay', onReplayToggleWrite);
  registerToggleWriteIntent('analytics-replay', recordReplayToggleIntent);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(tenantId = `replay-toggle-write-${randomUUID()}`): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey: 'visitor:toggle-write',
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100, bytes: 0, chunkCount: 0, flags: {} };
}
const read = (r: ReplaySession) => getReplaySession(r.tenantId, r.orgId, r.sessionId);
async function keys(r: ReplaySession): Promise<string[]> {
  const result = await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) }) as { entries: Array<{ key: string }> };
  return result.entries.map((e) => e.key);
}
async function recorded(r: ReplaySession = row()): Promise<ReplaySession> {
  await attestReplayOrg(r.tenantId, r.orgId);
  await mergeConsentCategories({ tenantId: r.tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': true }, source: `public:${r.orgId}` });
  await putReplayChunk(r, 0, CHUNK);
  expect(await read(r)).toMatchObject({ sessionId: r.sessionId });
  return r;
}
const replayToggle = () => getToggleDefault('analytics.session-replay')!;

describe('ADR 0951 P2 review #1 — an OFF write is recorded from the write itself', () => {
  it('a global OFF whose listener finishes only after replay is back ON still fences, and the sweep deletes', async () => {
    const mine = await recorded();
    // The listener outlives the write's budget: the write returns, the listener
    // runs later, after an admin has already turned replay back on.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const late: Promise<unknown>[] = [];
    registerToggleWriteListener('analytics-replay', (...args: Parameters<typeof onReplayToggleWrite>) => {
      late.push(gate.then(() => onReplayToggleWrite(...args)));
      return Promise.resolve();
    });
    await saveConfig({ ...replayToggle(), status: 'off' }, 'test');
    await saveConfig({ ...replayToggle(), status: 'on' }, 'test');
    release();
    await Promise.all(late);
    expect(await read(mine), 'an OFF that happened is never forgotten').toBeNull();
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
  });

  it('a listener that never runs (crash after the toggle write) is covered by the durable marker', async () => {
    const mine = await recorded();
    registerToggleWriteListener('analytics-replay', async () => {});
    await saveConfig({ ...replayToggle(), status: 'off' }, 'test');
    await saveConfig({ ...replayToggle(), status: 'on' }, 'test');
    expect(await read(mine), 'the pending marker fences on the next read').toBeNull();
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
    // A recording started after the re-enable is not fenced by the old write.
    const next = await recorded({ ...mine, sessionId: randomUUID() });
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await read(next)).toMatchObject({ sessionId: next.sessionId });
  });

  it('a tenant whose FIRST recording starts after an OFF-then-ON is not fenced by the old OFF', async () => {
    await saveConfig({ ...replayToggle(), status: 'off' }, 'test');
    await saveConfig({ ...replayToggle(), status: 'on' }, 'test');
    const first = await recorded();
    await putReplayChunk(first, 1, CHUNK);
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await read(first)).toMatchObject({ chunkCount: 2 });
  });

  it('an ON write and a rejected OFF write fence nothing', async () => {
    const mine = await recorded();
    await saveConfig({ ...replayToggle(), status: 'on', betaCohort: [] }, 'test');
    await expect(saveConfig({ ...replayToggle(), status: 'off' }, 'test', { expectedRevision: 'stale' })).rejects.toMatchObject({ httpStatus: 409 });
    expect(await read(mine)).toMatchObject({ sessionId: mine.sessionId });
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
  });
});

// Release review of #5398: an OFF whose toggle store write THROWS left the
// replay marker behind, so the tenant was fenced and its recordings swept
// although replay stayed ON. The seam now reads the row back and abandons.
describe('ADR 0951 P2 follow-up — an OFF whose store write throws', () => {
  it('a write that never landed fences nothing and deletes nothing', async () => {
    const mine = await recorded();
    const real = a.kvSet.bind(a);
    vi.spyOn(a, 'kvSet').mockImplementation(async (k, v) => {
      if (k.includes('feature-toggle') && k.endsWith('analytics.session-replay')) throw new Error('toggle store down');
      return real(k, v);
    });
    await expect(saveConfig({ ...replayToggle(), status: 'off' }, 'test')).rejects.toThrow('toggle store down');
    vi.restoreAllMocks();
    expect(await read(mine)).toMatchObject({ sessionId: mine.sessionId });
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await keys(mine)).toHaveLength(1);
  });

  it('a write that landed and then threw still fences, and the sweep deletes', async () => {
    const mine = await recorded();
    const real = a.kvSet.bind(a);
    vi.spyOn(a, 'kvSet').mockImplementation(async (k, v) => {
      await real(k, v);
      if (k.includes('feature-toggle') && k.endsWith('analytics.session-replay')) throw new Error('ack lost');
    });
    await expect(saveConfig({ ...replayToggle(), status: 'off' }, 'test')).rejects.toThrow('ack lost');
    vi.restoreAllMocks();
    expect(await read(mine)).toBeNull();
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
  });
});
