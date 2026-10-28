/** ADR 0954 P1 recovery. Physical SQLite CAS barriers witness late writers,
 * durable binding ownership, exact model pins and monotonic failed starts.
 * Reverting the close-before-cleanup or snapshot-restoration fixes revives data
 * or authority in these interleavings; no sleeps or scheduler luck are involved. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import { createContact, deleteContact } from '../src/features/crm/contactsService.js';
import { registerCrmErasure } from '../src/features/crm/erasure.js';
import { contentHashOf, V0_CONTENT } from '../src/features/crm/leadIntel/model.js';
import { activateModel, saveModelVersion } from '../src/features/crm/leadIntel/modelStore.js';
import { gradeLeadForRun } from '../src/features/crm/leadIntel/grading.js';
import {
  bindLead, closeLeadBinding, eraseLeadAttribution, getLeadBindingId, getLeadGrade, getLeadProfile,
  getPendingGrade, listLeadProfiles, recordLeadGrade, restorePendingGrade, stampPendingGrade,
  type GradeReservationPin,
} from '../src/features/crm/leadIntel/leadStore.js';

const tenantId = 'lead-lifecycle';
const orgId = 'client-a';
const actor = 'lead-binder-private-canary';
let storage: Storage;
let directory: string;
let database: string;
let contactId: string;
const primary = (namespace: string, org = orgId) => `hostext:crm:${namespace}:${tenantId}::${org}::${contactId}`;
const ownerKey = () => `hostext:crm:lead-profile-of:${tenantId}::${contactId}`;
const bind = () => bindLead({ tenantId, orgId, contactId, source: 'manual', boundBy: actor });
const grade = { modelId: 'v0', modelVersion: 0, modelHash: contentHashOf(V0_CONTENT), score: 7, band: 'E' as const, parts: {}, inputsDigest: 'inputs', truncated: false };
const pin = async (): Promise<GradeReservationPin> => ({ bindingId: await getLeadBindingId(tenantId, orgId, contactId), modelId: 'v0', modelVersion: 0, modelHash: grade.modelHash, definitionHash: 'd'.repeat(64), requesterHash: 'e'.repeat(64) });
async function eraseContact(): Promise<void> {
  const report = await eraseSubject(tenantId, contactId);
  expect(report.failedFeatures.filter((name) => !name.endsWith(' (never registered)'))).toEqual([]);
}
async function reopen(): Promise<void> {
  await storage.close();
  storage = openSqliteStorage(database);
  initHostExtPersistence(storage);
}

beforeAll(registerCrmErasure);
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'owp-lead-lifecycle-'));
  database = join(directory, 'store.sqlite');
  storage = openSqliteStorage(database);
  initHostExtPersistence(storage);
  contactId = (await createContact({ tenantId, name: 'Lead', email: 'lead@example.test', silent: true })).contactId;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await storage.close();
  __resetHostExtPersistence();
  rmSync(directory, { recursive: true });
});

describe('lead lifecycle publication fences', () => {
  it.each(['reverse', 'profile'] as const)('a paused initial %s insert cannot publish after contact erasure', async (lane) => {
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next) as { closed?: boolean; attributionPending?: unknown };
      if (!crossed && !row.closed && key === (lane === 'reverse' ? ownerKey() : primary('lead-profile'))) {
        crossed = true;
        await eraseContact();
      }
      return cas(key, expected, next);
    });
    await expect(bind()).rejects.toMatchObject({ httpStatus: expect.any(Number) });
    expect(crossed).toBe(true);
    vi.restoreAllMocks();
    await reopen();
    expect(await getLeadProfile(tenantId, orgId, contactId)).toBeNull();
    expect(await listLeadProfiles(tenantId, orgId)).toEqual([]);
    await expect(bind()).rejects.toMatchObject({ httpStatus: 404 });
    expect(JSON.parse((await storage.kvGet(ownerKey()))!)).toMatchObject({ closed: true });
  });

  it.each(['pending', 'completed'] as const)('a paused %s grade write cannot survive contact erasure', async (lane) => {
    await bind();
    const frozen = await pin();
    if (lane === 'completed') await stampPendingGrade(tenantId, orgId, contactId, 'grade-run', frozen);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next) as { closed?: boolean; pendingRunId?: string; runId?: string };
      if (!crossed && key === primary('lead-grade') && !row.closed && (lane === 'pending' ? row.pendingRunId === 'grade-run' : row.runId === 'grade-run')) {
        crossed = true;
        await eraseContact();
      }
      return cas(key, expected, next);
    });
    if (lane === 'pending') await expect(stampPendingGrade(tenantId, orgId, contactId, 'grade-run', frozen)).rejects.toMatchObject({ httpStatus: 404 });
    else expect(await recordLeadGrade(tenantId, orgId, contactId, 'grade-run', grade, frozen.bindingId)).toBe('superseded');
    expect(crossed).toBe(true);
    vi.restoreAllMocks();
    await reopen();
    expect(await getLeadGrade(tenantId, orgId, contactId)).toBeNull();
    expect(await getPendingGrade(tenantId, orgId, contactId)).toBeNull();
    expect(JSON.parse((await storage.kvGet(primary('lead-grade')))!)).toEqual({ tenantId, orgId, contactId, closed: true });
  });

  it('the real CRM delete hook closes a paused grade, even when the contact id is recreated', async () => {
    await bind();
    const frozen = await pin();
    await stampPendingGrade(tenantId, orgId, contactId, 'grade-run', frozen);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next) as { runId?: string; closed?: boolean };
      if (!crossed && key === primary('lead-grade') && row.runId === 'grade-run' && !row.closed) {
        crossed = true;
        expect(await deleteContact(contactId, { silent: true })).toBe(true);
        await createContact({ tenantId, contactId, name: 'Restored contact', silent: true });
      }
      return cas(key, expected, next);
    });
    expect(await recordLeadGrade(tenantId, orgId, contactId, 'grade-run', grade, frozen.bindingId)).toBe('superseded');
    expect(crossed).toBe(true);
    expect(await getLeadGrade(tenantId, orgId, contactId)).toBeNull();
    await expect(bind()).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('a delayed binder attribution CAS loses to real DSAR, without touching another tenant', async () => {
    const foreign = (await createContact({ tenantId: 'foreign', name: 'Other', silent: true })).contactId;
    await bindLead({ tenantId: 'foreign', orgId, contactId: foreign, source: 'manual', boundBy: actor });
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next) as { boundBy?: string };
      if (!crossed && key === primary('lead-profile') && row.boundBy === actor) {
        crossed = true;
        await storage.kvDelete(`hostextidx:crm:lead-profile:${tenantId}:${tenantId}::${orgId}::${contactId}`);
        const report = await eraseSubject(tenantId, `user:${actor}`);
        expect(report.failedFeatures.filter((name) => !name.endsWith(' (never registered)'))).toEqual([]);
      }
      return cas(key, expected, next);
    });
    expect((await bind()).profile.boundBy).toBe(ERASED);
    expect(crossed).toBe(true);
    vi.restoreAllMocks();
    await reopen();
    expect((await getLeadProfile(tenantId, orgId, contactId))?.boundBy).toBe(ERASED);
    expect(await storage.kvGet(primary('lead-profile'))).not.toContain(actor);
    expect((await getLeadProfile('foreign', orgId, foreign))?.boundBy).toBe(actor);
  });

  it.each(['reverse', 'profile'] as const)('a lost %s CAS with no winner fails closed instead of returning an unstored candidate', async (lane) => {
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === (lane === 'reverse' ? ownerKey() : primary('lead-profile'))) {
        crossed = true;
        return cas(key, 'not-the-current-row', next);
      }
      return cas(key, expected, next);
    });
    await expect(bind()).rejects.toMatchObject({ httpStatus: 409 });
    expect(crossed).toBe(true);
    expect(await getLeadProfile(tenantId, orgId, contactId)).toBeNull();
  });

  it('a restart after reverse reservation resumes only the same client', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage);
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === primary('lead-profile')) throw new Error('process stopped before profile publication');
      return cas(key, expected, next);
    });
    await expect(bind()).rejects.toThrow('process stopped');
    const receipt = JSON.parse((await storage.kvGet(ownerKey()))!) as { bindingId: string };
    fault.mockRestore();
    await reopen();
    await expect(bindLead({ tenantId, orgId: 'client-b', contactId, source: 'manual', boundBy: actor })).rejects.toMatchObject({ httpStatus: 409 });
    expect((await bind()).created).toBe(true);
    expect(await getLeadBindingId(tenantId, orgId, contactId)).toBe(receipt.bindingId);
  });

  it('closing also fences absent companion rows, and survives a second close after restart', async () => {
    await bind();
    await closeLeadBinding(tenantId, contactId);
    await reopen();
    await closeLeadBinding(tenantId, contactId);
    expect(await getLeadGrade(tenantId, orgId, contactId)).toBeNull();
    expect(JSON.parse((await storage.kvGet(primary('lead-grade')))!)).toMatchObject({ closed: true });
    await expect(bind()).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('attribution erasure reports sustained CAS contention instead of claiming completion', async () => {
    await bind();
    const cas = storage.kvCompareAndSwap.bind(storage);
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation((key, expected, next) =>
      key === primary('lead-profile') ? cas(key, 'not-the-current-row', next) : cas(key, expected, next));
    await expect(eraseLeadAttribution(tenantId, actor)).rejects.toThrow('lead_attribution_erase_conflict');
  });

  it('an unreadable attribution barrier leaves a safe hashed receipt across restart', async () => {
    const get = storage.kvGet.bind(storage);
    const fault = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      if (key.startsWith('hostext:consent:erasure-tombstone:') && await get(primary('lead-profile'))) throw new Error('attribution barrier unavailable');
      return get(key);
    });
    await expect(bind()).rejects.toThrow('attribution barrier unavailable');
    fault.mockRestore();
    await reopen();
    expect((await getLeadProfile(tenantId, orgId, contactId))?.boundBy).toBe(ERASED);
    expect(await storage.kvGet(primary('lead-profile'))).not.toContain(actor);
    expect(JSON.parse((await storage.kvGet(primary('lead-profile')))!)).toHaveProperty('attributionPending');
    await eraseLeadAttribution(tenantId, actor);
    expect(JSON.parse((await storage.kvGet(primary('lead-profile')))!)).not.toHaveProperty('attributionPending');
  });

  it('a missing legacy reverse marker never permits another client to adopt the primary profile', async () => {
    await bind();
    const legacy = JSON.parse((await storage.kvGet(primary('lead-profile')))!) as Record<string, unknown>;
    delete legacy.bindingId;
    await storage.kvSet(primary('lead-profile'), JSON.stringify(legacy));
    await storage.kvDelete(ownerKey());
    await expect(bindLead({ tenantId, orgId: 'client-b', contactId, source: 'manual', boundBy: actor })).rejects.toMatchObject({ httpStatus: 409 });
    expect(await storage.kvGet(ownerKey())).toBeNull();
    expect((await bind()).created).toBe(false);
    expect(await getLeadBindingId(tenantId, orgId, contactId)).toEqual(expect.any(String));
  });

  it('the real DSAR reports a blocked closure as partial and its retry finishes the physical cleanup', async () => {
    await bind();
    const cas = storage.kvCompareAndSwap.bind(storage);
    const fault = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation((key, expected, next) =>
      key === primary('lead-profile') ? cas(key, 'not-the-current-row', next) : cas(key, expected, next));
    const report = await eraseSubject(tenantId, contactId);
    expect(report.failedFeatures).toContain('eraseCrmSubject');
    expect(await getLeadProfile(tenantId, orgId, contactId)).toBeNull();
    fault.mockRestore();
    await eraseContact();
    expect(JSON.parse((await storage.kvGet(primary('lead-profile')))!)).toMatchObject({ closed: true, boundBy: ERASED });
  });
});

describe('frozen grading authority', () => {
  it('two failed starts cannot restore an older pending run or overwrite a completed result', async () => {
    await bind();
    const frozen = await pin();
    await stampPendingGrade(tenantId, orgId, contactId, 'completed', frozen);
    await recordLeadGrade(tenantId, orgId, contactId, 'completed', grade, frozen.bindingId);
    const previousA = await stampPendingGrade(tenantId, orgId, contactId, 'start-a', frozen);
    const previousB = await stampPendingGrade(tenantId, orgId, contactId, 'start-b', frozen);
    await restorePendingGrade(tenantId, orgId, contactId, 'start-a', previousA);
    await restorePendingGrade(tenantId, orgId, contactId, 'start-b', previousB);
    expect(await getPendingGrade(tenantId, orgId, contactId)).toBeNull();
    expect(await getLeadGrade(tenantId, orgId, contactId)).toMatchObject({ runId: 'completed', score: 7 });
  });

  it('a change to the active model cannot change a previously reserved model or its recorded hash', async () => {
    await bind();
    const frozen = await pin();
    await stampPendingGrade(tenantId, orgId, contactId, 'grade-run', frozen);
    await saveModelVersion({ tenantId, orgId, modelId: 'replacement', expectedVersion: 0, content: V0_CONTENT, actor });
    await activateModel({ tenantId, orgId, modelId: 'replacement', version: 1, actor, expected: null });
    const out = await gradeLeadForRun({ tenantId, orgId, contactId, runId: 'grade-run', pinned: { bindingId: frozen.bindingId, modelId: frozen.modelId, version: frozen.modelVersion, contentHash: frozen.modelHash } });
    expect(out).toMatchObject({ outcome: 'recorded', grade: { modelId: 'v0', modelVersion: 0, modelHash: frozen.modelHash } });
    expect(await getLeadGrade(tenantId, orgId, contactId)).toMatchObject({ modelId: 'v0', modelVersion: 0, modelHash: frozen.modelHash });
  });
});
