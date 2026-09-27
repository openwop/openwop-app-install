/**
 * ADR 0458 grade-pass I2/I4 — candidate-death cleanup + lesson-media retry-leak.
 *
 * When a candidate is killed (terminal `withdrawn`), the factory's sidecar rows must
 * die with it: the `challenge-outline` canvas (+ its version snapshots, via the
 * sanctioned `deleteCanvasForTenant` cascade) and every `kicktodo-lesson-media`
 * pointer + its referenced Media asset. And a re-generated lesson day that supersedes
 * a pointer with a NEW assetId must free the old asset instead of orphaning it.
 *
 * This pins:
 *  - kill → outline canvas gone, its version snapshots gone, pointers gone, assets gone;
 *  - the seam fires from the single withdraw owner (`__setCandidateWithdrawn`) too, and
 *    is idempotent (a re-kill neither re-fires nor throws);
 *  - `setLessonMedia` overwrite with a CHANGED assetId deletes the superseded asset,
 *    while an identical re-put deletes nothing;
 *  - a THROWING subscriber never breaks the kill or the other subscribers.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createCandidate,
  __setCandidateWithdrawn,
} from '../src/features/kicktodo-creator/creatorService.js';
import { killSwitch } from '../src/features/kicktodo-creator/monitorService.js';
import {
  setLessonMedia,
  listLessonMedia,
  purgeLessonMediaForCandidate,
} from '../src/features/kicktodo-creator/lessonAssembly.js';
import { outlineCanvasId, CHALLENGE_OUTLINE_CANVAS_TYPE, type OutlineDoc } from '../src/features/kicktodo-creator/outlineDoc.js';
import { registerCandidateDeathSubscribers } from '../src/features/kicktodo-creator/candidateDeathSubscribers.js';
import { onCandidateDeath, __resetCandidateLifecycleHooks } from '../src/features/kicktodo-creator/candidateLifecycle.js';
import { ensureCanvasForTenant, getCanvasForTenant, updateCanvasForTenant, listCanvasVersions } from '../src/host/canvasSurface.js';
import { createAsset, getAssetByIdForTenant } from '../src/features/media/mediaService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';

const TENANT = 'tenant-candidate-death';
const ORG = 'org-cd';
const ACTOR = 'user:killer';

async function newCandidate(topic = 'daily focus practice'): Promise<string> {
  const c = await createCandidate({ tenantId: TENANT, createdBy: ACTOR, topic, audience: 'busy pros', transformation: 'a reliable habit', durationDaysTarget: 7, dailyMinutesTarget: 15 });
  return c.id;
}

/** A real Media asset + its lesson-media pointer for a candidate/day. Returns the assetId. */
async function seedLessonAsset(candidateId: string, day: number): Promise<string> {
  const stored = await storeMediaAsset(TENANT, { contentBase64: Buffer.alloc(64, day).toString('base64'), contentType: 'image/png' });
  const asset = await createAsset({
    tenantId: TENANT, orgId: ORG, name: `day-${day}`, contentType: 'image/png',
    sizeBytes: stored.bytes, storageRef: stored.token, serveToken: stored.token, uploadedBy: ACTOR,
  });
  await setLessonMedia({ tenantId: TENANT, candidateId, day, assetId: asset.assetId, kind: 'image' });
  return asset.assetId;
}

async function seedOutlineCanvas(candidateId: string): Promise<string> {
  const canvasId = outlineCanvasId(TENANT, candidateId);
  const skeleton: OutlineDoc = { meta: { title: 'T', promise: 'P', audience: 'A', durationDays: 7, dailyMinutesBudget: 15 }, outcomes: [], achievements: [], frames: [{ id: 'outline', name: 'T', days: [] }] };
  await ensureCanvasForTenant(TENANT, canvasId, { canvasTypeId: CHALLENGE_OUTLINE_CANVAS_TYPE, initialState: skeleton });
  // Force a version snapshot so the cascade has something to remove.
  const edited: OutlineDoc = { ...skeleton, meta: { ...skeleton.meta, title: 'Edited' } };
  await updateCanvasForTenant(TENANT, canvasId, edited, { merge: 'replace', snapshot: { capturedBy: ACTOR, force: true } });
  return canvasId;
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
beforeEach(() => {
  __resetCandidateLifecycleHooks();
  registerCandidateDeathSubscribers();
});
afterEach(() => {
  __resetCandidateLifecycleHooks();
});

describe('candidate death purges the outline canvas + lesson media (I2)', () => {
  it('killSwitch → canvas gone, version snapshots gone, pointers gone, assets gone', async () => {
    const candidateId = await newCandidate();
    const canvasId = await seedOutlineCanvas(candidateId);
    const assetA = await seedLessonAsset(candidateId, 1);
    const assetB = await seedLessonAsset(candidateId, 2);

    // Preconditions: everything exists.
    expect(await getCanvasForTenant(TENANT, canvasId)).not.toBeNull();
    expect((await listCanvasVersions(TENANT, canvasId)).length).toBeGreaterThan(0);
    expect((await listLessonMedia(TENANT, candidateId)).length).toBe(2);
    expect(await getAssetByIdForTenant(TENANT, assetA)).not.toBeNull();
    expect(await getAssetByIdForTenant(TENANT, assetB)).not.toBeNull();

    const withdrawn = await killSwitch(TENANT, candidateId, 'harmful content', ACTOR);
    expect(withdrawn.state).toBe('withdrawn');

    // Everything is gone.
    expect(await getCanvasForTenant(TENANT, canvasId)).toBeNull();
    expect(await listCanvasVersions(TENANT, canvasId)).toEqual([]);
    expect(await listLessonMedia(TENANT, candidateId)).toEqual([]);
    expect(await getAssetByIdForTenant(TENANT, assetA)).toBeNull();
    expect(await getAssetByIdForTenant(TENANT, assetB)).toBeNull();
  });

  it('fires from the direct withdraw owner (__setCandidateWithdrawn) and is idempotent', async () => {
    const candidateId = await newCandidate();
    const canvasId = await seedOutlineCanvas(candidateId);

    const first = await __setCandidateWithdrawn(TENANT, candidateId, 'reason', ACTOR);
    expect(first?.state).toBe('withdrawn');
    expect(await getCanvasForTenant(TENANT, canvasId)).toBeNull();

    // A re-withdraw of an already-terminal candidate must not throw (nothing to re-fire).
    const again = await __setCandidateWithdrawn(TENANT, candidateId, 'reason again', ACTOR);
    expect(again?.state).toBe('withdrawn');
  });

  it('a THROWING subscriber never breaks the kill or the other subscribers', async () => {
    // A hostile/broken subscriber registered ahead of the real ones.
    onCandidateDeath('test.explode', async () => { throw new Error('boom'); });
    const candidateId = await newCandidate();
    const canvasId = await seedOutlineCanvas(candidateId);
    const assetA = await seedLessonAsset(candidateId, 1);

    const withdrawn = await killSwitch(TENANT, candidateId, 'reason', ACTOR);
    expect(withdrawn.state).toBe('withdrawn'); // the kill still committed
    // …and the real subscribers still ran.
    expect(await getCanvasForTenant(TENANT, canvasId)).toBeNull();
    expect(await getAssetByIdForTenant(TENANT, assetA)).toBeNull();
  });
});

describe('setLessonMedia frees a superseded asset on retry (I4)', () => {
  it('overwrite with a CHANGED assetId deletes the old asset; the new one survives', async () => {
    const candidateId = await newCandidate('overwrite-case');
    const oldAsset = await seedLessonAsset(candidateId, 1); // day 1 → oldAsset

    // Re-generate day 1 with a brand-new asset.
    const stored = await storeMediaAsset(TENANT, { contentBase64: Buffer.alloc(64, 99).toString('base64'), contentType: 'image/png' });
    const newAsset = await createAsset({ tenantId: TENANT, orgId: ORG, name: 'day-1-v2', contentType: 'image/png', sizeBytes: stored.bytes, storageRef: stored.token, serveToken: stored.token, uploadedBy: ACTOR });
    await setLessonMedia({ tenantId: TENANT, candidateId, day: 1, assetId: newAsset.assetId, kind: 'image' });

    expect(await getAssetByIdForTenant(TENANT, oldAsset)).toBeNull(); // superseded → freed
    expect(await getAssetByIdForTenant(TENANT, newAsset.assetId)).not.toBeNull();
    const pointers = await listLessonMedia(TENANT, candidateId);
    expect(pointers).toHaveLength(1);
    expect(pointers[0]!.assetId).toBe(newAsset.assetId);
  });

  it('an identical re-put (same assetId) deletes nothing', async () => {
    const candidateId = await newCandidate('same-asset-case');
    const asset = await seedLessonAsset(candidateId, 1);
    // Re-put the SAME assetId — a plain idempotent retry.
    await setLessonMedia({ tenantId: TENANT, candidateId, day: 1, assetId: asset, kind: 'image' });
    expect(await getAssetByIdForTenant(TENANT, asset)).not.toBeNull();
  });

  it('purgeLessonMediaForCandidate removes every pointer + asset and returns the count', async () => {
    const candidateId = await newCandidate('purge-case');
    const a1 = await seedLessonAsset(candidateId, 1);
    const a2 = await seedLessonAsset(candidateId, 2);
    const removed = await purgeLessonMediaForCandidate(TENANT, candidateId);
    expect(removed).toBe(2);
    expect(await listLessonMedia(TENANT, candidateId)).toEqual([]);
    expect(await getAssetByIdForTenant(TENANT, a1)).toBeNull();
    expect(await getAssetByIdForTenant(TENANT, a2)).toBeNull();
  });
});
