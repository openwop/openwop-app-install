/** ADR 0951 P2.2 reconciliation: a recording whose consent generation is no
 * longer current is unreadable, but its bytes survive a failed withdrawal
 * callback. The default-window sweep must find and delete those rows, within a
 * bounded window per sweep, and must never delete on an unconfirmed read. Two
 * SQLite clients share real rows and real blob bytes; no store is mocked except
 * the one consent read the outage witness fails. */
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
import { clearRetentionHold, setRetentionHold } from '../src/host/retentionHold.js';
import { mergeConsentCategories, registerConsentWithdrawalHook } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, REPLAY_RECONCILE_MAX_PER_SWEEP, __resetReplayReconcileCursorForTests, eraseSubjectReplays,
  getReplaySession, putReplayChunk, replayChunkPrefix, sweepExpiredReplays, type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let b: Storage;
let dir: string;
let blob: BlobSurface;
let originalBackend: string | undefined;
let tenantId: string;
const CHUNK = Buffer.from('masked geometry').toString('base64');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-reconcile-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  b = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-reconcile-${randomUUID()}`;
  originalBackend = process.env.OPENWOP_SURFACE_BLOB;
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  registerSurfaceAdapter<BlobSurface>('blob', 'replay-reconcile-witness', () => blob);
  process.env.OPENWOP_SURFACE_BLOB = 'replay-reconcile-witness';
  __resetReplayReconcileCursorForTests();
});
// ADR 0951 P2.5: recordings need both replay toggles ON (helpers/replayToggles.ts).
beforeEach(async () => { await setReplayToggles('on'); await attestReplayOrg(tenantId, 'client-a'); });
afterEach(async () => {
  vi.restoreAllMocks();
  registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', eraseSubjectReplays);
  await clearRetentionHold(tenantId);
  if (originalBackend === undefined) delete process.env.OPENWOP_SURFACE_BLOB;
  else process.env.OPENWOP_SURFACE_BLOB = originalBackend;
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(subjectKey = 'visitor:recording'): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey,
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100, bytes: 0, chunkCount: 0, flags: {} };
}
const rawKey = (r: ReplaySession) => `hostext:analytics:replay:${r.tenantId}:${r.orgId}:${r.sessionId}`;
const consentKey = (r: ReplaySession) => `hostext:consent:record:${r.tenantId}:${r.subjectKey}`;
const choose = (r: ReplaySession, granted: boolean) => mergeConsentCategories({
  tenantId: r.tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': granted }, source: `public:${r.orgId}`,
});
async function keys(r: ReplaySession): Promise<string[]> {
  const result = await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) }) as { entries: Array<{ key: string }> };
  return result.entries.map(entry => entry.key);
}
const state = async (r: ReplaySession) => (JSON.parse((await b.kvGet(rawKey(r)))!) as { privacy?: { state?: string } }).privacy?.state;
/** Record, then withdraw while the deletion callback fails: the stranded state. */
async function strandedRecording(r: ReplaySession): Promise<void> {
  await choose(r, true);
  await putReplayChunk(r, 0, CHUNK);
  registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', async () => { throw new Error('cleanup unavailable'); });
  await choose(r, false);
  registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', eraseSubjectReplays);
  expect(await keys(r), 'bytes really remain after the failed callback').toHaveLength(1);
}

describe('ADR 0951 P2.2 — revoked-generation reconciliation', () => {
  it('deletes the bytes of a withdrawn recording whose deletion callback failed, inside the retention window', async () => {
    const mine = row();
    await strandedRecording(mine);
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
    expect(await state(mine)).toBe('erased');
  });

  it('a re-grant mints a new generation and does not shield the old recording', async () => {
    const mine = row();
    await strandedRecording(mine);
    await choose(mine, true);
    const fresh = { ...mine, sessionId: randomUUID() };
    await putReplayChunk(fresh, 0, CHUNK);
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
    expect(await getReplaySession(tenantId, fresh.orgId, fresh.sessionId)).toMatchObject({ sessionId: fresh.sessionId });
    expect(await keys(fresh)).toHaveLength(1);
  });

  it('leaves a recording under its current generation alone', async () => {
    const mine = row();
    await choose(mine, true);
    await putReplayChunk(mine, 0, CHUNK);
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await keys(mine)).toHaveLength(1);
    expect(await getReplaySession(tenantId, mine.orgId, mine.sessionId)).toMatchObject({ sessionId: mine.sessionId });
  });

  it('a consent-store outage deletes nothing and the next sweep reconciles', async () => {
    const mine = row();
    await strandedRecording(mine);
    const read = a.kvGet.bind(a);
    const outage = vi.spyOn(a, 'kvGet').mockImplementation(async key => {
      if (key === consentKey(mine)) throw new Error('consent store unavailable');
      return read(key);
    });
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await keys(mine)).toHaveLength(1);
    expect(await state(mine)).toBe('active');
    outage.mockRestore();
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
  });

  it('a legal hold retains a withdrawn recording, still unreadable, until the hold lifts', async () => {
    const mine = row();
    await strandedRecording(mine);
    await setRetentionHold(tenantId, 'litigation');
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await keys(mine)).toHaveLength(1);
    expect(await getReplaySession(tenantId, mine.orgId, mine.sessionId)).toBeNull();
    await clearRetentionHold(tenantId);
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
  });

  it('reads at most the bounded window per sweep and rotates to the rest on the next', async () => {
    const live = row('visitor:live');
    await choose(live, true);
    await putReplayChunk(live, 0, CHUNK);
    const subject = row('visitor:revoked');
    await choose(subject, true);
    await choose(subject, false);
    const total = REPLAY_RECONCILE_MAX_PER_SWEEP + 5;
    for (let i = 0; i < total; i++) {
      const r = row('visitor:revoked');
      await b.kvSet(rawKey(r), JSON.stringify({ ...r, privacy: {
        state: 'active', committed: true, pending: [], chunks: {}, consentGeneration: 'revoked-generation',
        eligibilityId: `test-${tenantId}-client-a` } }));
    }
    const read = a.kvGet.bind(a);
    let consentReads = 0;
    vi.spyOn(a, 'kvGet').mockImplementation(async key => {
      if (key.startsWith('hostext:consent:record:')) consentReads++;
      return read(key);
    });
    const first = await sweepExpiredReplays();
    // One generation read per subject (it reads the consent row twice), not per row.
    expect(consentReads).toBeLessThanOrEqual(4);
    const second = await sweepExpiredReplays();
    expect(first.deleted).toBeLessThanOrEqual(REPLAY_RECONCILE_MAX_PER_SWEEP);
    expect(first.deleted + second.deleted).toBe(total);
    expect(await keys(live)).toHaveLength(1);
    expect(await getReplaySession(tenantId, live.orgId, live.sessionId)).toMatchObject({ sessionId: live.sessionId });
  });
});
