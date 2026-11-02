/** ADR 0951 P2.5 — turning replay off stops capture and playback at once and
 * deletes the tenant's recordings; turning it back on revives nothing (David,
 * 2026-10-28: "deletion on withdrawal or disable"). The fence is a per-tenant
 * epoch recorded on an observed OFF, reached through the toggle service's write
 * seam and re-observed by every read, write and sweep. Two SQLite clients share
 * real rows; blob bytes are real (memory backend). No resolver is mocked except
 * the one toggle read the outage witness fails. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { buildHostSurfaceBundle, initInMemorySurfaces, type BlobSurface } from '../src/host/inMemorySurfaces.js';
import * as toggles from '../src/host/featureToggles/service.js';
import { disableTenantOverride, registerToggleWriteListener } from '../src/host/featureToggles/service.js';
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, getReplaySession, onReplayToggleWrite, putReplayChunk, replayChunkPrefix, sweepExpiredReplays,
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
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-disable-'));
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
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close(); await b.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(tenantId = `replay-disable-${randomUUID()}`): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId: 'client-a', sessionId: randomUUID(), subjectKey: 'visitor:disable',
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100, bytes: 0, chunkCount: 0, flags: {} };
}
const rawKey = (r: ReplaySession) => `hostext:analytics:replay:${r.tenantId}:${r.orgId}:${r.sessionId}`;
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

describe('ADR 0951 P2.5 — replay disable fences and deletes', () => {
  it('turning replay off hides recordings and refuses writes at once, before any sweep', async () => {
    const mine = await recorded();
    await setReplayToggles('off');
    expect(await read(mine)).toBeNull();
    await expect(putReplayChunk(mine, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await keys(mine), 'the fence is not the deletion').toHaveLength(1);
  });

  it('turning it back on revives nothing; a new recording works under the new epoch', async () => {
    const mine = await recorded();
    await setReplayToggles('off');
    await setReplayToggles('on');
    expect(await read(mine)).toBeNull();
    await expect(putReplayChunk(mine, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    await recorded({ ...mine, sessionId: randomUUID() });
  });

  it('the sweep deletes the fenced recordings bytes and index', async () => {
    const mine = await recorded();
    await setReplayToggles('off');
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
    expect(JSON.parse((await b.kvGet(rawKey(mine)))!).privacy.state).toBe('erased');
  });

  it('a per-tenant override disable fences only that tenant', async () => {
    const mine = await recorded();
    const theirs = await recorded();
    expect(await disableTenantOverride('analytics.session-replay', mine.tenantId, 'test')).toBe('disabled');
    expect(await read(mine)).toBeNull();
    expect(await read(theirs)).toMatchObject({ sessionId: theirs.sessionId });
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(theirs)).toHaveLength(1);
  });

  it('a missed notification is caught by the sweep, and re-enabling still revives nothing', async () => {
    const mine = await recorded();
    registerToggleWriteListener('analytics-replay', async () => { throw new Error('listener unavailable'); });
    await setReplayToggles('off');
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    await setReplayToggles('on');
    expect(await read(mine)).toBeNull();
    expect(await keys(mine)).toEqual([]);
  });

  it('an unreadable toggle hides recordings but deletes nothing and moves no epoch', async () => {
    const mine = await recorded();
    const real = toggles.resolveOne;
    const outage = vi.spyOn(toggles, 'resolveOne').mockImplementation(async (id, subject) => {
      if (id === 'analytics.session-replay') throw new Error('toggle store unavailable');
      return real(id, subject);
    });
    expect(await read(mine)).toBeNull();
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await keys(mine)).toHaveLength(1);
    outage.mockRestore();
    expect(await read(mine)).toMatchObject({ sessionId: mine.sessionId });
  });
});

describe('ADR 0951 P2.5 — no orphan epoch rows', () => {
  it('an OFF observed for a tenant with no recordings writes no epoch row (account deletion order)', async () => {
    const tenant = `replay-deleted-${randomUUID()}`;
    expect(await disableTenantOverride('analytics.session-replay', tenant, 'test')).toBe('disabled');
    await setReplayToggles('off');
    expect(await read({ ...row(tenant) })).toBeNull();
    await sweepExpiredReplays();
    expect(await b.kvGet(`hostext:analytics:replay-enablement:${tenant}`)).toBeNull();
  });
});

describe('ADR 0951 P2.5 — outage is not OFF; consent is part of replay being on', () => {
  it('an entitlement read that FAILED (blockedBy unresolved) hides recordings but moves no epoch and deletes nothing', async () => {
    const mine = await recorded();
    const real = toggles.resolveOne;
    const outage = vi.spyOn(toggles, 'resolveOne').mockImplementation(async (id, subject) => {
      const r = await real(id, subject);
      return id === 'analytics' && r ? { ...r, enabled: false, variant: null, blockedBy: 'unresolved' as const } : r;
    });
    expect(await read(mine)).toBeNull();
    expect(await sweepExpiredReplays()).toEqual({ deleted: 0, failed: 0 });
    expect(await keys(mine)).toHaveLength(1);
    outage.mockRestore();
    expect(await read(mine)).toMatchObject({ sessionId: mine.sessionId });
  });

  it('turning consent management off fences recordings at once, and the sweep deletes them', async () => {
    const mine = await recorded();
    const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
    const consent = getToggleDefault('consent')!;
    await toggles.saveConfig({ ...consent, status: 'off' }, 'test');
    expect(await read(mine)).toBeNull();
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(mine)).toEqual([]);
  });
});
