/** ADR 0951 P2.3 admission (David, 2026-10-28): a 10% sample of consented
 * visits, at most 2,000 recorded sessions per client org per UTC day, and 30
 * minutes per session. The daily counter is a durable CAS row, so the ceiling
 * holds across instances. Real SQLite rows and real memory-blob bytes; the
 * toggles resolve through the real service. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildHostSurfaceBundle, initInMemorySurfaces, type BlobSurface } from '../src/host/inMemorySurfaces.js';
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, REPLAY_MAX_SESSIONS_PER_ORG_DAY, REPLAY_MAX_SESSION_MS, REPLAY_SAMPLE_PERCENT,
  getReplaySession, putReplayChunk, replayChunkPrefix, replaySamplePercent, replaySampled, sweepExpiredReplays, type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let b: Storage;
let dir: string;
let blob: BlobSurface;
let saved: Record<string, string | undefined>;
let tenantId: string;
const CHUNK = Buffer.from('masked geometry').toString('base64');
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB', 'OPENWOP_REPLAY_SAMPLE_PERCENT'] as const;
const DAY = '2026-10-28';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-admission-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-admission-${randomUUID()}`;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true';
  process.env.OPENWOP_REPLAY_SAMPLE_PERCENT = '100';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  await setReplayToggles('on');
  await attestReplayOrg(tenantId, 'client-a');
  await mergeConsentCategories({ tenantId, subjectKey: 'visitor:admit', categories: { 'analytics.replay': true }, source: 'public:client-a' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${DAY}T12:00:00.000Z`));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(sessionId: string = randomUUID()): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId, subjectKey: 'visitor:admit',
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100, bytes: 0, chunkCount: 0, flags: {} };
}
const counterKey = (day = DAY) => `hostext:analytics:replay-admission:${tenantId}:client-a:${day}`;
const counted = async (day = DAY) => { const raw = await b.kvGet(counterKey(day)); return raw ? (JSON.parse(raw) as { sessions: number }).sessions : 0; };
const keys = async (r: ReplaySession) =>
  ((await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) })) as { entries: unknown[] }).entries.length;
/** A visit the default 10% sample keeps (or drops), found by the real predicate. */
function visit(kept: boolean): ReplaySession {
  for (let i = 0; i < 10_000; i++) {
    const r = row();
    if (replaySampled(r) === kept) return r;
  }
  throw new Error('no such visit');
}

describe('ADR 0951 P2.3 — replay admission', () => {
  it('records the approved 10% sample: an unsampled visit stores nothing and is not counted; the answer is stable', async () => {
    process.env.OPENWOP_REPLAY_SAMPLE_PERCENT = '';
    expect(replaySamplePercent()).toBe(REPLAY_SAMPLE_PERCENT);
    const dropped = visit(false);
    const kept = visit(true);
    for (let i = 0; i < 2; i++) {
      await expect(putReplayChunk(dropped, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'not_sampled' } });
    }
    expect(await keys(dropped)).toBe(0);
    expect(await b.kvGet(`hostext:analytics:replay:${tenantId}:client-a:${dropped.sessionId}`)).toBeNull();
    expect(await counted()).toBe(0);
    await putReplayChunk(kept, 0, CHUNK);
    expect(await counted()).toBe(1);
    let share = 0;
    for (let i = 0; i < 4_000; i++) if (replaySampled(row())) share++;
    expect(share / 4_000).toBeGreaterThan(0.08);
    expect(share / 4_000).toBeLessThan(0.12);
  });

  it('the operator sample is an integer 0-100, anything else is the approved default', () => {
    for (const [raw, want] of [['0', 0], ['100', 100], ['25', 25], ['150', 10], ['-1', 10], ['12.5', 10], ['abc', 10], [' ', 10]] as const) {
      process.env.OPENWOP_REPLAY_SAMPLE_PERCENT = raw;
      expect(replaySamplePercent(), raw).toBe(want);
    }
  });

  it('counts each new session once, never its later chunks', async () => {
    const r = row();
    await putReplayChunk(r, 0, CHUNK);
    await putReplayChunk(r, 1, CHUNK);
    await putReplayChunk(r, 1, CHUNK);
    expect(await counted()).toBe(1);
  });

  it('holds the daily ceiling for racing new sessions, and the next UTC day starts again', async () => {
    await b.kvSet(counterKey(), JSON.stringify({ tenantId, orgId: 'client-a', day: DAY, sessions: REPLAY_MAX_SESSIONS_PER_ORG_DAY - 1 }));
    const racers = [row(), row(), row()];
    const results = await Promise.allSettled(racers.map((r) => putReplayChunk(r, 0, CHUNK)));
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of results.filter((y): y is PromiseRejectedResult => y.status === 'rejected')) {
      expect(x.reason).toMatchObject({ httpStatus: 429, details: { reason: 'daily_limit' } });
    }
    expect(await counted()).toBe(REPLAY_MAX_SESSIONS_PER_ORG_DAY);
    const refused = racers.filter((_, i) => results[i]!.status === 'rejected');
    for (const r of refused) expect(await keys(r)).toBe(0);
    vi.setSystemTime(new Date('2026-10-29T00:00:01.000Z'));
    await putReplayChunk(row(), 0, CHUNK);
    expect(await counted('2026-10-29')).toBe(1);
    // The sweep keeps two days of counters for clock skew, then drops them.
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
    await sweepExpiredReplays();
    expect(await counted(DAY)).toBe(REPLAY_MAX_SESSIONS_PER_ORG_DAY);
    vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
    await sweepExpiredReplays();
    expect(await b.kvGet(counterKey(DAY))).toBeNull();
    expect(await counted('2026-10-29')).toBe(1);
  });

  it('ends a session at 30 minutes of server time, whatever the client claims', async () => {
    const r = { ...row(), startedAt: '2099-01-01T00:00:00.000Z' };
    await putReplayChunk(r, 0, CHUNK);
    vi.setSystemTime(new Date(Date.parse(`${DAY}T12:00:00.000Z`) + REPLAY_MAX_SESSION_MS));
    await putReplayChunk(r, 1, CHUNK);
    vi.setSystemTime(new Date(Date.parse(`${DAY}T12:00:00.000Z`) + REPLAY_MAX_SESSION_MS + 1));
    await expect(putReplayChunk(r, 2, CHUNK)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'session_length' } });
    expect(await getReplaySession(tenantId, 'client-a', r.sessionId)).toMatchObject({ chunkCount: 2 });
  });
});
