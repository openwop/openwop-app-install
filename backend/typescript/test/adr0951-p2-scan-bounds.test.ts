/** ADR 0951 P2 review, finding 2 — no tenant-wide or cross-tenant scan of the
 * recordings on a public or hot path. A public "reject" (any explicit
 * `analytics.replay: false`, even from a visitor who never granted it) ran the
 * withdrawal hook, which listed every recording in the tenant; the viewer list
 * loaded the whole tenant per page; and the hourly sweep and every global
 * toggle write listed every recording in every tenant. Each lane must now read
 * only its own slice: the subject's pointers, the org's rows, the tenants with
 * an enablement row. The witnesses watch the storage calls themselves.
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
import { saveConfig } from '../src/host/featureToggles/service.js';
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, getReplaySession, listReplaySessionsForOrg, putReplayChunk, replayChunkPrefix, sweepExpiredReplays,
  type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let dir: string;
let blob: BlobSurface;
let saved: Record<string, string | undefined>;
const CHUNK = Buffer.from('masked geometry').toString('base64');
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB'] as const;
/** The recordings collection's own keyspace: rows and their tenant index. */
const RECORDINGS = 'hostext:analytics:replay:';
const RECORDINGS_INDEX = 'hostextidx:analytics:replay:';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-scan-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
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
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(tenantId: string, over: Partial<ReplaySession> = {}): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey: `visitor:${randomUUID()}`,
    pageIds: [], startedAt: now, updatedAt: now, durationMs: 0, bytes: 0, chunkCount: 0, flags: {}, ...over };
}
async function recorded(r: ReplaySession): Promise<ReplaySession> {
  await attestReplayOrg(r.tenantId, r.orgId);
  await mergeConsentCategories({ tenantId: r.tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': true }, source: `public:${r.orgId}` });
  await putReplayChunk(r, 0, CHUNK);
  return r;
}
async function keys(r: ReplaySession): Promise<string[]> {
  const result = await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) }) as { entries: Array<{ key: string }> };
  return result.entries.map((e) => e.key);
}
/** Every list prefix the storage was asked for while `fn` ran. */
async function listsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const prefixes: string[] = [];
  const real = a.kvList.bind(a);
  const spy = vi.spyOn(a, 'kvList').mockImplementation(async (prefix: string) => { prefixes.push(prefix); return real(prefix); });
  try { await fn(); } finally { spy.mockRestore(); }
  return prefixes;
}
const recordingScans = (prefixes: readonly string[]) => prefixes.filter((p) => p.startsWith(RECORDINGS) || p.startsWith(RECORDINGS_INDEX));

describe('ADR 0951 P2 review #2 — bounded reads', () => {
  it('a public reject from a visitor who never granted reads no recording of the tenant', async () => {
    const tenant = `replay-scan-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await recorded(row(tenant));
    const scans = await listsDuring(() => mergeConsentCategories({ tenantId: tenant, subjectKey: 'visitor:never-granted', categories: { 'analytics.replay': false }, source: 'public:client-a' }));
    expect(recordingScans(scans)).toEqual([]);
  });

  it('withdrawing deletes the subject\'s recording through its pointer, without a tenant scan', async () => {
    const tenant = `replay-scan-${randomUUID()}`;
    const others = [await recorded(row(tenant)), await recorded(row(tenant))];
    const mine = await recorded(row(tenant, { sessionKey: 'vk-mine' }));
    const scans = await listsDuring(() => mergeConsentCategories({ tenantId: tenant, subjectKey: mine.subjectKey, categories: { 'analytics.replay': false }, source: 'public:client-a' }));
    expect(recordingScans(scans)).toEqual([]);
    expect(await keys(mine)).toEqual([]);
    expect(await getReplaySession(tenant, mine.orgId, mine.sessionId)).toBeNull();
    for (const other of others) expect(await keys(other)).toHaveLength(1);
  });

  it('the viewer list reads only that organization\'s rows', async () => {
    const tenant = `replay-scan-${randomUUID()}`;
    const mine = [await recorded(row(tenant)), await recorded(row(tenant))];
    for (let i = 0; i < 3; i++) await recorded(row(tenant, { orgId: 'client-b' }));
    let page: Awaited<ReturnType<typeof listReplaySessionsForOrg>> | undefined;
    const scans = await listsDuring(async () => { page = await listReplaySessionsForOrg(tenant, 'client-a'); });
    expect(page!.sessions.map((s) => s.sessionId).sort()).toEqual(mine.map((s) => s.sessionId).sort());
    expect(recordingScans(scans)).toEqual([`${RECORDINGS}${tenant}:client-a:`]);
  });

  it('a global toggle write and the sweep never list every recording', async () => {
    const tenant = `replay-scan-${randomUUID()}`;
    await recorded(row(tenant));
    const def = getToggleDefault('analytics.session-replay')!;
    const writeScans = await listsDuring(() => saveConfig({ ...def, status: 'on' }, 'test'));
    expect(writeScans.filter((p) => p === RECORDINGS)).toEqual([]);
    expect(recordingScans(writeScans)).toEqual([]);
    await sweepExpiredReplays(); // the one-time backfill of pre-pointer rows is the only full list
    const sweepScans = await listsDuring(() => sweepExpiredReplays());
    expect(sweepScans.filter((p) => p === RECORDINGS), 'no cross-tenant list of recordings').toEqual([]);
  });
});
