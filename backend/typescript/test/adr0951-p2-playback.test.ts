/** ADR 0951 P2.4 — playback releases a chunk only to an owner/admin of the
 * EXACT client org, only while the recording is visible and unexpired, only
 * after the view is on the tenant's hash chain, and only if every check still
 * holds once the bytes are in hand. Real orgs and memberships, real SQLite rows,
 * real memory-blob bytes, the real audit chain and toggle service. */
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
import { createMember, createOrg, updateMember } from '../src/host/accessControlService.js';
import * as chain from '../src/host/auditChainService.js';
import { mergeConsentCategories, registerConsentWithdrawalHook } from '../src/features/consent/consentService.js';
import {
  REPLAY_BLOB_ROOT, REPLAY_DEFAULT_RETENTION_DAYS, REPLAY_PLAYBACK_GRANT_MS, eraseSubjectReplays, putReplayChunk, readReplayChunkForViewer, replayChunkPrefix,
  type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let dir: string;
let blob: BlobSurface;
let saved: Record<string, string | undefined>;
let tenantId: string;
let adminMemberId: string;
let onGet: (() => Promise<void>) | undefined;
let gets: number;
const ORG = 'client-a';
const ADMIN = 'user:replay-admin';
const EDITOR = 'user:replay-editor';
const ADMIN_B = 'user:replay-admin-b';
const CHUNK = Buffer.from('masked geometry').toString('base64');
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB'] as const;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-playback-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-playback-${randomUUID()}`;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  gets = 0; onGet = undefined;
  registerSurfaceAdapter<BlobSurface>('blob', 'replay-playback-witness', () => ({
    ...blob, get: async (args) => { gets++; await onGet?.(); return blob.get(args); },
  }));
  process.env.OPENWOP_SURFACE_BLOB = 'replay-playback-witness';
  await setReplayToggles('on');
  await attestReplayOrg(tenantId, ORG);
  await attestReplayOrg(tenantId, 'client-b');
  await createOrg({ tenantId, orgId: ORG, name: 'Client A', createdBy: 'test' });
  await createOrg({ tenantId, orgId: 'client-b', name: 'Client B', createdBy: 'test' });
  adminMemberId = (await createMember({ tenantId, orgId: ORG, subject: ADMIN, displayName: 'Admin', roles: ['admin'] })).memberId;
  await createMember({ tenantId, orgId: ORG, subject: EDITOR, displayName: 'Editor', roles: ['editor'] });
  await createMember({ tenantId, orgId: 'client-b', subject: ADMIN_B, displayName: 'Admin B', roles: ['admin'] });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', eraseSubjectReplays);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close();
  rmSync(dir, { recursive: true, force: true });
});

async function recording(): Promise<ReplaySession> {
  const now = new Date().toISOString();
  const r: ReplaySession = { tenantId, orgId: ORG, sessionId: randomUUID(), subjectKey: 'visitor:seen',
    pageIds: ['page-a'], startedAt: now, updatedAt: now, durationMs: 100, bytes: 0, chunkCount: 0, flags: {} };
  await mergeConsentCategories({ tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': true }, source: `public:${ORG}` });
  await putReplayChunk(r, 0, CHUNK);
  return r;
}
const view = (r: ReplaySession, viewer: string, chunkIndex = 0, orgId = r.orgId) =>
  readReplayChunkForViewer({ tenantId, orgId, sessionId: r.sessionId, chunkIndex, viewer });
const views = async () => (await chain.listChain(tenantId)).filter((e) => e.kind === 'analytics.replay.viewed');

describe('ADR 0951 P2.4 — audited playback', () => {
  it('an admin of the exact org gets the bytes, and the view is on the hash chain first', async () => {
    const r = await recording();
    expect(await view(r, ADMIN)).toEqual({ contentBase64: CHUNK, chunkIndex: 0 });
    const logged = await views();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.payload).toMatchObject({ orgId: ORG, sessionId: r.sessionId, viewer: ADMIN, grantId: expect.any(String) });
    expect(await chain.verifyChain(tenantId)).toEqual({ ok: true });
  });

  it('a non-admin member, an admin of another client org, and nobody are refused before any audit or byte', async () => {
    const r = await recording();
    await expect(view(r, EDITOR)).rejects.toMatchObject({ httpStatus: 403 });
    await expect(view(r, ADMIN_B)).rejects.toMatchObject({ httpStatus: 403 });
    await expect(view(r, ADMIN_B, 0, 'client-b')).rejects.toMatchObject({ httpStatus: 404 });
    await expect(view(r, '')).rejects.toMatchObject({ httpStatus: 401 });
    expect(await views()).toEqual([]);
    expect(gets).toBe(0);
  });

  it('withdrawal, a disable, expiry and an uncommitted index all look like a missing recording', async () => {
    const withdrawn = await recording();
    await mergeConsentCategories({ tenantId, subjectKey: withdrawn.subjectKey, categories: { 'analytics.replay': false }, source: `public:${ORG}` });
    await expect(view(withdrawn, ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
    const disabled = await recording();
    await setReplayToggles('off');
    await expect(view(disabled, ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
    await setReplayToggles('on');
    const old = await recording();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + REPLAY_DEFAULT_RETENTION_DAYS * 86_400_000 + 60_000);
    await expect(view(old, ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
    vi.useRealTimers();
    const fresh = await recording();
    await expect(view(fresh, ADMIN, 7)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await views()).toEqual([]);
    expect(gets).toBe(0);
  });

  it('an audit failure refuses the content and reads no byte', async () => {
    const r = await recording();
    vi.spyOn(chain, 'appendAudit').mockRejectedValue(new Error('chain unavailable'));
    await expect(view(r, ADMIN)).rejects.toMatchObject({ httpStatus: 503 });
    expect(gets).toBe(0);
  });

  it('a demotion or a withdrawal that lands while the bytes are in flight still wins', async () => {
    const r = await recording();
    onGet = async () => { await updateMember(adminMemberId, { roles: ['viewer'] }); };
    await expect(view(r, ADMIN)).rejects.toMatchObject({ httpStatus: 403 });
    await updateMember(adminMemberId, { roles: ['admin'] });
    // The deletion callback fails, so the bytes are still there to read: only the
    // post-fetch visibility check can refuse them.
    registerConsentWithdrawalHook('analytics.replay', 'eraseSubjectReplays', async () => { throw new Error('cleanup unavailable'); });
    onGet = async () => {
      await mergeConsentCategories({ tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': false }, source: `public:${ORG}` });
    };
    await expect(view(r, ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('bytes that do not match their receipt are never released', async () => {
    const r = await recording();
    await blob.put({ key: `${replayChunkPrefix(tenantId, ORG, r.sessionId)}0`, contentBase64: Buffer.from('tampered bytes!').toString('base64') });
    await expect(view(r, ADMIN)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

/** ADR 0951 P2 review #4 — one audited grant per (viewer, recording), not one
 * hash-chain append per chunk. The grant is appended before the first byte,
 * expires, and is never a substitute for the per-chunk access and fence checks. */
describe('ADR 0951 P2 review #4 — playback grant', () => {
  it('two chunk reads by one viewer produce one audit entry', async () => {
    const r = await recording();
    await putReplayChunk(r, 1, CHUNK);
    await view(r, ADMIN, 0);
    await view(r, ADMIN, 1);
    expect(await views()).toHaveLength(1);
    expect(await chain.verifyChain(tenantId)).toEqual({ ok: true });
  });

  it('an expired grant audits again', async () => {
    const r = await recording();
    await view(r, ADMIN);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + REPLAY_PLAYBACK_GRANT_MS + 1_000);
    await view(r, ADMIN);
    vi.useRealTimers();
    expect(await views()).toHaveLength(2);
  });

  it('when the grant cannot be audited no byte is served, and the next read audits', async () => {
    const r = await recording();
    const append = vi.spyOn(chain, 'appendAudit').mockRejectedValueOnce(new Error('chain unavailable'));
    await expect(view(r, ADMIN)).rejects.toMatchObject({ httpStatus: 503 });
    expect(gets).toBe(0);
    append.mockRestore();
    expect(await view(r, ADMIN)).toEqual({ contentBase64: CHUNK, chunkIndex: 0 });
    expect(await views()).toHaveLength(1);
  });

  it('a grant is no substitute for access: a demoted viewer is refused on the next chunk', async () => {
    const r = await recording();
    await putReplayChunk(r, 1, CHUNK);
    await view(r, ADMIN, 0);
    await updateMember(adminMemberId, { roles: ['viewer'] });
    await expect(view(r, ADMIN, 1)).rejects.toMatchObject({ httpStatus: 403 });
  });
});
