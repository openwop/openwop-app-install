/** ADR 0954 P0 recovery: model content/selection survive DSAR, attribution does
 * not. File-backed primary rows and physical CAS barriers witness late writers,
 * missing secondary markers, >200 versions and restart after an uncertain write. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import type { Storage } from '../src/storage/storage.js';
import { DurableCollection, initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import { registerCrmErasure } from '../src/features/crm/erasure.js';
import { isErasureTombstoned, readmitSubject } from '../src/features/consent/consentService.js';
import { contentHashOf, V0_CONTENT, type LeadScoringModel } from '../src/features/crm/leadIntel/model.js';
import { activateModel, eraseModelAttribution, getModelVersion, listModelVersions, resolveActiveModel, saveModelVersion, type ActiveModelPointer } from '../src/features/crm/leadIntel/modelStore.js';

const tenantId = 'lead-model-erasure';
const orgId = 'client';
const actor = 'model-member-private-canary';
const modelKey = `${tenantId}::${orgId}::standard::1`;
const pointerKey = `${tenantId}::${orgId}`;
const models = new DurableCollection<LeadScoringModel>('crm:lead-model', (m) => `${m.tenantId}::${m.orgId}::${m.modelId}::${m.version}`, undefined, (m) => m.tenantId);
const pointers = new DurableCollection<ActiveModelPointer>('crm:lead-model-active', (p) => `${p.tenantId}::${p.orgId}`, undefined, (p) => p.tenantId);
const save = (expectedVersion = 0, who = actor) => saveModelVersion({ tenantId, orgId, modelId: 'standard', expectedVersion, content: V0_CONTENT, actor: who });

describe('lead-model attribution publication and erasure', () => {
  let storage: Storage;
  let directory: string;
  let database: string;
  beforeAll(registerCrmErasure);
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'owp-model-erasure-'));
    database = join(directory, 'store.sqlite');
    storage = openSqliteStorage(database);
    initHostExtPersistence(storage);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await storage.close();
    __resetHostExtPersistence();
    rmSync(directory, { recursive: true });
  });

  it('the actual fan-out erases every version beyond the display cap without secondary markers, preserving hashes and selection', async () => {
    const contentHash = contentHashOf(V0_CONTENT);
    // Complete adoption before planting omissions; otherwise an indexed eraser
    // could backfill the missing markers and accidentally pass this witness.
    await models.ensureTenantIndex();
    await pointers.ensureTenantIndex();
    for (let version = 1; version <= 205; version++) {
      await models.put({ tenantId, orgId, modelId: 'standard', version, ...V0_CONTENT, contentHash, createdBy: actor, createdAt: '2026-10-20T00:00:00Z' });
      await storage.kvDelete(`hostextidx:crm:lead-model:${tenantId}:${tenantId}::${orgId}::standard::${version}`);
    }
    await pointers.put({ tenantId, orgId, modelId: 'standard', version: 205, activatedBy: actor, activatedAt: '2026-10-20T00:00:00Z' });
    await storage.kvDelete(`hostextidx:crm:lead-model-active:${tenantId}:${pointerKey}`);
    await models.put({ tenantId: 'foreign', orgId, modelId: 'standard', version: 1, ...V0_CONTENT, contentHash, createdBy: actor, createdAt: '2026-10-20T00:00:00Z' });
    expect(await listModelVersions(tenantId, orgId, 'standard')).toHaveLength(200);
    // This focused file registers CRM, not a complete host boot. Keep the real
    // fan-out and its missing-registration failures visible; the registered CRM
    // erasers must run successfully. Full registration is the manifest suite's job.
    const report = await eraseSubject(tenantId, `user:${actor}`);
    expect(report.missing).not.toContain('eraseCrmTaskAssignees');
    expect(report.failedFeatures.filter((name) => !name.endsWith(' (never registered)'))).toEqual([]);
    expect(report.failed).toBe(report.missing.length);
    const all = await models.listByPrefix(`${tenantId}::`);
    expect(all).toHaveLength(205);
    expect(all.every((m) => m.createdBy === ERASED && m.contentHash === contentHash && m.createdAt === '2026-10-20T00:00:00Z')).toBe(true);
    expect(await pointers.get(pointerKey)).toMatchObject({ version: 205, activatedBy: ERASED, activatedAt: '2026-10-20T00:00:00Z' });
    expect(await resolveActiveModel(tenantId, orgId)).toMatchObject({ modelId: 'standard', version: 205 });
    expect((await models.get(`foreign::${orgId}::standard::1`))?.createdBy).toBe(actor);
  });

  it('a save paused at the physical attribution CAS cannot restore the erased actor', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === `hostext:crm:lead-model:${modelKey}` && JSON.parse(next).createdBy === actor) {
        crossed = true;
        await eraseModelAttribution(tenantId, `user:${actor}`);
      }
      return cas(key, expected, next);
    });
    expect(await save()).toMatchObject({ version: 1, createdBy: ERASED, contentHash: contentHashOf(V0_CONTENT) });
    expect(crossed).toBe(true);
    expect(await getModelVersion(tenantId, orgId, 'standard', 1)).toMatchObject({ createdBy: ERASED });
    expect(await storage.kvGet(`hostext:crm:lead-model:${modelKey}`)).not.toContain(actor);
  });

  it('erasure before initial publication is also a barrier, without deleting the saved content', async () => {
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (!crossed && key === `hostext:crm:lead-model:${modelKey}` && expected === null) {
        crossed = true;
        await eraseModelAttribution(tenantId, actor);
      }
      return cas(key, expected, next);
    });
    expect(await save()).toMatchObject({ version: 1, createdBy: ERASED });
    expect(crossed).toBe(true);
    expect((await getModelVersion(tenantId, orgId, 'standard', 1))?.contentHash).toBe(contentHashOf(V0_CONTENT));
  });

  it('a delayed activation attribution never replaces the newer selected version or its actor', async () => {
    await save(); await save(1);
    const cas = storage.kvCompareAndSwap.bind(storage);
    let crossed = false;
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      const row = JSON.parse(next);
      if (!crossed && key === `hostext:crm:lead-model-active:${pointerKey}` && row.activatedBy === actor) {
        crossed = true;
        await activateModel({ tenantId, orgId, modelId: 'standard', version: 2, actor: 'next-admin', expected: { modelId: 'standard', version: 1 } });
        await eraseModelAttribution(tenantId, actor);
      }
      return cas(key, expected, next);
    });
    // The first activation committed; returning its safe receipt is successful
    // even though the newer activation won while it filled in attribution.
    expect(await activateModel({ tenantId, orgId, modelId: 'standard', version: 1, actor, expected: null })).toMatchObject({ version: 1, activatedBy: ERASED });
    expect(crossed).toBe(true);
    expect(await pointers.get(pointerKey)).toMatchObject({ version: 2, activatedBy: 'next-admin' });
    expect(await resolveActiveModel(tenantId, orgId)).toMatchObject({ version: 2 });
  });

  it('barrier failure persists no raw actor; reopening storage retains a resumable erasure receipt', async () => {
    const get = storage.kvGet.bind(storage);
    const fault = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      if (key.startsWith('hostext:consent:erasure-tombstone:')) throw new Error('barrier unavailable');
      return get(key);
    });
    const saved = await save();
    expect(saved.createdBy).toBe(ERASED);
    expect(saved).not.toHaveProperty('attributionPending');
    fault.mockRestore();
    await storage.close();
    storage = openSqliteStorage(database);
    initHostExtPersistence(storage);
    const before = await storage.kvGet(`hostext:crm:lead-model:${modelKey}`);
    expect(before).not.toContain(actor);
    expect(JSON.parse(before!).attributionPending.subjectHashes.length).toBeGreaterThan(0);
    await eraseModelAttribution(tenantId, actor);
    const after = JSON.parse((await storage.kvGet(`hostext:crm:lead-model:${modelKey}`))!);
    expect(after).not.toHaveProperty('attributionPending');
    expect(after).toMatchObject({ createdBy: ERASED, contentHash: contentHashOf(V0_CONTENT), version: 1 });
  });

  it('persistent attribution CAS contention is reported as incomplete erasure', async () => {
    await save();
    const cas = storage.kvCompareAndSwap.bind(storage);
    vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === `hostext:crm:lead-model:${modelKey}` && JSON.parse(next).createdBy === ERASED) return { swapped: false, actual: expected };
      return cas(key, expected, next);
    });
    await expect(eraseModelAttribution(tenantId, actor)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'model_attribution_contended' } });
    expect((await models.get(modelKey))?.createdBy).toBe(actor);
  });

  it('a user erasure preserves a different scoped agent, its pending receipt and subsequent attribution', async () => {
    await save(0, 'user:alice');
    await save(1, 'agent:alice');
    const get = storage.kvGet.bind(storage);
    const fault = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      if (key.startsWith('hostext:consent:erasure-tombstone:')) throw new Error('barrier unavailable');
      return get(key);
    });
    await save(2, 'agent:alice');
    await save(3, 'user:alice');
    fault.mockRestore();
    const pendingAgentKey = `hostext:crm:lead-model:${tenantId}::${orgId}::standard::3`;
    const pendingUserKey = `hostext:crm:lead-model:${tenantId}::${orgId}::standard::4`;
    const before = await storage.kvGet(pendingAgentKey);
    expect(JSON.parse(before!)).toHaveProperty('attributionPending');
    await eraseModelAttribution(tenantId, 'user:alice');
    expect((await getModelVersion(tenantId, orgId, 'standard', 1))?.createdBy).toBe(ERASED);
    expect((await getModelVersion(tenantId, orgId, 'standard', 2))?.createdBy).toBe('agent:alice');
    expect(await storage.kvGet(pendingAgentKey)).toBe(before);
    expect(JSON.parse((await storage.kvGet(pendingUserKey))!)).not.toHaveProperty('attributionPending');
    expect((await save(4, 'agent:alice')).createdBy).toBe('agent:alice');
    expect((await save(5, 'user:alice')).createdBy).toBe(ERASED);
  });

  it('a direct owner erasure groups all forms for sanctioned readmission', async () => {
    await save();
    await eraseModelAttribution(tenantId, actor);
    expect(await isErasureTombstoned(tenantId, actor)).toBe(true);
    expect(await isErasureTombstoned(tenantId, `user:${actor}`)).toBe(true);
    // ADR 0464 correction (DSAR-DBL): the key forms include the `userRef()` spelling, so the
    // doubled `user:user:` form is tombstoned in the same group and readmitted with it.
    expect(await isErasureTombstoned(tenantId, `user:user:${actor}`)).toBe(true);
    expect(await readmitSubject(tenantId, actor, 'The subject explicitly asked to return after erasure.')).toMatchObject({ readmitted: true, tombstonesCleared: 3 });
    expect(await isErasureTombstoned(tenantId, actor)).toBe(false);
    expect(await isErasureTombstoned(tenantId, `user:${actor}`)).toBe(false);
    expect(await isErasureTombstoned(tenantId, `user:user:${actor}`)).toBe(false);
    expect((await save(1)).createdBy).toBe(actor);
  });
});
