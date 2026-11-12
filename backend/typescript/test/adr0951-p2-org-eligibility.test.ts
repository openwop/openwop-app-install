/** ADR 0951 — David, 2026-10-28: replay excludes health and finance clients.
 * Nothing can tell a client's category reliably, so a client org records only
 * after an owner/admin attests it is neither; the default is excluded. The
 * attestation in force when a recording started is what covers it: withdrawing
 * fences at once and the sweep deletes, and renewing never revives. Real SQLite
 * rows, real memory-blob bytes, the real toggle and consent services.
 *
 * Sabotage witnesses (w103; src/features/analytics/replayStore.ts): treating
 * every org as eligible, or recording without an attestation id, reds the
 * unattested case; offering replay without the org's attestation reds the
 * unattested and attested cases; dropping the attestation fence in
 * `fencesHold` reds the withdraw case, and dropping it from the sweep's
 * `disabledRecordings` reds it too (nothing deleted); a deterministic (not
 * minted) attestation id reds renewal; dropping the re-attest no-op reds the
 * re-attest and record-nothing cases; replacing the attestation CAS with a
 * blind put reds the concurrent case; dropping the reservation's pinned-id
 * check reds the forged-start case; swallowing an audit failure reds the
 * audit-failure case; dropping `supersedes` reds the evidence case; auditing a
 * no-op withdrawal reds the record-nothing case. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import * as chain from '../src/host/auditChainService.js';
import { createOrg, deleteOrg } from '../src/host/accessControlService.js';
import { buildHostSurfaceBundle, initInMemorySurfaces, type BlobSurface } from '../src/host/inMemorySurfaces.js';
import { mergeConsentCategories, offeredVisitorChoices } from '../src/features/consent/consentService.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { consentFeature } from '../src/features/consent/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  REPLAY_BLOB_ROOT, getReplaySession, isReplayOrgEligible, putReplayChunk, replayChunkPrefix, setReplayOrgEligibility,
  sweepExpiredReplays, type ReplaySession,
} from '../src/features/analytics/replayStore.js';
import { setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let dir: string;
let blob: BlobSurface;
let saved: Record<string, string | undefined>;
let tenantId: string;
const CHUNK = Buffer.from('masked geometry').toString('base64');
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB'] as const;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-eligibility-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-eligibility-${randomUUID()}`;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true';
  blob = buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob;
  await setReplayToggles('on');
  if (consentFeature.toggleDefault) registerToggleDefault(consentFeature.toggleDefault);
  const consent = getToggleDefault('consent');
  if (!consent) throw new Error('no consent toggle default');
  await saveConfig({ ...consent, status: 'on' }, 'test');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close();
  rmSync(dir, { recursive: true, force: true });
});

function row(orgId = 'client-a'): ReplaySession {
  const now = new Date().toISOString();
  return { tenantId, orgId, sessionId: randomUUID(), subjectKey: 'visitor:eligible',
    pageIds: [], startedAt: now, updatedAt: now, durationMs: 0, bytes: 0, chunkCount: 0, flags: {} };
}
const grant = (r: ReplaySession) => mergeConsentCategories({ tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': true }, source: `public:${r.orgId}` });
const keys = async (r: ReplaySession) =>
  ((await blob.list({ prefix: replayChunkPrefix(r.tenantId, r.orgId, r.sessionId) })) as { entries: unknown[] }).entries.length;

describe('ADR 0951 — health/finance exclusion by org attestation', () => {
  it('an unattested org is excluded: nothing offered, nothing stored', async () => {
    const r = row();
    await grant(r);
    expect(await isReplayOrgEligible(tenantId, 'client-a')).toBe(false);
    expect(await offeredVisitorChoices(tenantId, 'client-a')).not.toContain('analytics.replay');
    await expect(putReplayChunk(r, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await keys(r)).toBe(0);
  });

  it('an attested org is offered and records; the offer needs the org, and other orgs stay excluded', async () => {
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin');
    expect(await offeredVisitorChoices(tenantId, 'client-a')).toContain('analytics.replay');
    expect(await offeredVisitorChoices(tenantId)).not.toContain('analytics.replay');
    expect(await offeredVisitorChoices(tenantId, 'client-b')).not.toContain('analytics.replay');
    const r = row();
    await grant(r);
    await putReplayChunk(r, 0, CHUNK);
    expect(await getReplaySession(tenantId, 'client-a', r.sessionId)).toMatchObject({ sessionId: r.sessionId });
    const other = row('client-b');
    await expect(putReplayChunk(other, 0, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('withdrawing fences at once, the sweep deletes, and renewing revives nothing', async () => {
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin');
    const r = row();
    await grant(r);
    await putReplayChunk(r, 0, CHUNK);
    await setReplayOrgEligibility(tenantId, 'client-a', false, 'user:admin');
    expect(await getReplaySession(tenantId, 'client-a', r.sessionId)).toBeNull();
    await expect(putReplayChunk(r, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin');
    expect(await getReplaySession(tenantId, 'client-a', r.sessionId), 'renewal does not revive').toBeNull();
    await expect(putReplayChunk(r, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await sweepExpiredReplays()).toEqual({ deleted: 1, failed: 0 });
    expect(await keys(r)).toBe(0);
    const fresh = row();
    await putReplayChunk(fresh, 0, CHUNK);
    expect(await getReplaySession(tenantId, 'client-a', fresh.sessionId)).toMatchObject({ sessionId: fresh.sessionId });
  });

  it('re-attesting an eligible org keeps its attestation, so its recordings stay covered', async () => {
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin');
    const r = row();
    await grant(r);
    await putReplayChunk(r, 0, CHUNK);
    // Coverage is the pinned attestation id, never a clock comparison, so no wait is needed.
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:other-admin');
    expect(await getReplaySession(tenantId, 'client-a', r.sessionId)).toMatchObject({ sessionId: r.sessionId });
  });

  it('two concurrent attestations mint one id, so neither fences the other', async () => {
    // A deterministic interleaving: admin-1 has read "unattested" and is held at
    // its audit while admin-2 attests and a recording is reserved under admin-2's
    // id. Then admin-1 resumes: it must lose the CAS, not overwrite the id.
    const realAppend = chain.appendAudit;
    let reached!: () => void;
    const atAudit = new Promise<void>((res) => { reached = res; });
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    vi.spyOn(chain, 'appendAudit').mockImplementation(async (auditTenant, kind, payload) => {
      if (payload.actor === 'user:admin-1') { reached(); await gate; }
      return realAppend(auditTenant, kind, payload);
    });
    const first = setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin-1');
    await atAudit;
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin-2');
    const early = row();
    await grant(early);
    await putReplayChunk(early, 0, CHUNK);
    release();
    await first;
    expect(await getReplaySession(tenantId, 'client-a', early.sessionId), 'the late attestation did not fence it').toMatchObject({ sessionId: early.sessionId });
    const r = row();
    await grant(r);
    await putReplayChunk(r, 0, CHUNK);
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin-3');
    expect(await getReplaySession(tenantId, 'client-a', r.sessionId)).toMatchObject({ sessionId: r.sessionId });
  });

  it('a forged future start cannot outrun a renewed attestation', async () => {
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin');
    const r = row();
    await grant(r);
    await putReplayChunk(r, 0, CHUNK);
    await setReplayOrgEligibility(tenantId, 'client-a', false, 'user:admin');
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:admin');
    await expect(putReplayChunk({ ...r, startedAt: '2099-01-01T00:00:00.000Z' }, 1, CHUNK)).rejects.toMatchObject({ httpStatus: 409 });
  });
});

/** ADR 0951 P2 review #5 — an attestation decides whether a client's visitors
 * may be recorded, and withdrawing it deletes every recording of that client.
 * Both used to leave no durable evidence: withdraw deleted the row, losing who
 * attested and when. Each is now on the tenant's hash chain BEFORE it takes
 * effect, and the withdrawal entry carries the attestation it supersedes. */
describe('ADR 0951 P2 review #5 — eligibility evidence', () => {
  const entries = async () => (await chain.listChain(tenantId)).filter((e) => e.kind === 'analytics.replay.eligibility');

  it('attest and withdraw are on the hash chain, and the withdrawal keeps who attested and when', async () => {
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:owner');
    await setReplayOrgEligibility(tenantId, 'client-a', false, 'user:admin');
    const logged = await entries();
    expect(logged).toHaveLength(2);
    const [attested, withdrawn] = logged;
    expect(attested!.payload).toMatchObject({ orgId: 'client-a', eligible: true, actor: 'user:owner', attestationId: expect.any(String) });
    expect(withdrawn!.payload).toMatchObject({ orgId: 'client-a', eligible: false, actor: 'user:admin',
      supersedes: { attestationId: (attested!.payload as { attestationId: string }).attestationId, attestedBy: 'user:owner', attestedAt: expect.any(String) } });
    expect(await chain.verifyChain(tenantId)).toEqual({ ok: true });
  });

  it('an attestation or withdrawal whose audit fails does not take effect', async () => {
    vi.spyOn(chain, 'appendAudit').mockRejectedValueOnce(new Error('chain unavailable'));
    await expect(setReplayOrgEligibility(tenantId, 'client-a', true, 'user:owner')).rejects.toMatchObject({ httpStatus: 503 });
    expect(await isReplayOrgEligible(tenantId, 'client-a')).toBe(false);
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:owner');
    vi.spyOn(chain, 'appendAudit').mockRejectedValueOnce(new Error('chain unavailable'));
    await expect(setReplayOrgEligibility(tenantId, 'client-a', false, 'user:owner')).rejects.toMatchObject({ httpStatus: 503 });
    expect(await isReplayOrgEligible(tenantId, 'client-a')).toBe(true);
  });

  it('re-attesting an attested org and withdrawing an unattested one record nothing', async () => {
    await setReplayOrgEligibility(tenantId, 'client-a', false, 'user:owner');
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:owner');
    await setReplayOrgEligibility(tenantId, 'client-a', true, 'user:owner');
    expect((await entries()).map((e) => (e.payload as { eligible: boolean }).eligible)).toEqual([true]);
  });
});

/** ADR 0951 P2 review #10 — there is no org-delete cascade seam to register
 * with: `deleteOrg` refuses while ANY org-scoped host row exists (RI-7). So an
 * org that still has replay rows (an attestation, recordings, counters) cannot
 * be deleted out from under them, and none is orphaned. */
describe('ADR 0951 P2 review #10 — org deletion', () => {
  it('an org with a replay attestation or recording is not deleted; once they are gone it is', async () => {
    await createOrg({ tenantId, orgId: 'client-z', name: 'Client Z', createdBy: 'test' });
    await setReplayOrgEligibility(tenantId, 'client-z', true, 'user:owner');
    expect((await deleteOrg('client-z')).blocked?.rows).toBeGreaterThan(0);
    await setReplayOrgEligibility(tenantId, 'client-z', false, 'user:owner');
    expect(await deleteOrg('client-z')).toMatchObject({ org: true });
  });
});
