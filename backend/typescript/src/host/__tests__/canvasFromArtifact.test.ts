/**
 * Seed-from-artifact (ADR 0153 §R1/§R6) — opening a run's immutable canvas artifact
 * into an editable host.canvas working copy. Verifies: a canvas.* artifact seeds a
 * working copy carrying the payload as live state + the owning Subject; re-opening the
 * SAME artifact is idempotent (one canvas); cross-tenant / non-canvas / absent → null
 * (no existence leak, no spurious canvas).
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant } from '../canvasSurface.js';
import { seedCanvasFromArtifact } from '../canvasFromArtifact.js';
import { persistRunArtifact, __resetRunArtifactStore } from '../runArtifactStore.js';
import { registerAppBuilderArtifactType } from '../../features/app-builder/artifactTypes.js';
import { initHostExtPersistence } from '../hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';

const TENANT = 'tenant-a';

// DurableCollection needs host-ext persistence; the typed-artifact path stamps
// `artifactTypeId` only for a REGISTERED, VALID payload.
beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerAppBuilderArtifactType();
});

async function emitCanvasArtifact(runId: string, nodeId: string, tenantId = TENANT) {
  // A node emitting the typed { artifact } envelope (ADR 0083 producer path).
  return persistRunArtifact({
    tenantId, runId, nodeId, role: 'deliverable', now: new Date().toISOString(),
    output: { artifact: { artifactTypeId: 'canvas.app-builder', payload: { name: 'Todo', screens: [{ id: 'home', name: 'Home' }] }, title: 'Todo' } },
  });
}

describe('host.canvas ownerSubject (additive, R6)', () => {
  it('round-trips an owning project Subject; absent ⇒ tenant-scoped as before', async () => {
    const owned = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', name: 'A', ownerSubject: { kind: 'project', id: 'proj-1' }, initialState: { x: 1 } });
    const back = await getCanvasForTenant(TENANT, owned.canvasId);
    expect(back?.ownerSubject).toEqual({ kind: 'project', id: 'proj-1' });

    const plain = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.slides', initialState: {} });
    const backPlain = await getCanvasForTenant(TENANT, plain.canvasId);
    expect(backPlain?.ownerSubject).toBeUndefined();
  });
});

describe('seedCanvasFromArtifact (R1)', () => {
  beforeEach(async () => { await __resetRunArtifactStore(); });

  it('seeds an editable working copy from a canvas.* artifact, carrying payload + owner', async () => {
    const res = await emitCanvasArtifact('run-1', 'node-1');
    expect(res?.artifactId).toBeTruthy();
    const canvas = await seedCanvasFromArtifact(TENANT, 'run-1:node-1', { ownerSubject: { kind: 'user', id: 'u-1' } });
    expect(canvas).not.toBeNull();
    expect(canvas?.canvasTypeId).toBe('canvas.app-builder');
    expect((canvas?.state as { name?: string }).name).toBe('Todo');
    expect(canvas?.ownerSubject).toEqual({ kind: 'user', id: 'u-1' });
  });

  it('is idempotent — re-opening the same artifact returns the same canvas', async () => {
    await emitCanvasArtifact('run-2', 'node-1');
    const a = await seedCanvasFromArtifact(TENANT, 'run-2:node-1');
    const b = await seedCanvasFromArtifact(TENANT, 'run-2:node-1');
    expect(a?.canvasId).toBe(b?.canvasId);
  });

  it('returns null cross-tenant (no existence leak)', async () => {
    await emitCanvasArtifact('run-3', 'node-1', TENANT);
    expect(await seedCanvasFromArtifact('tenant-other', 'run-3:node-1')).toBeNull();
  });

  it('returns null for an absent artifact', async () => {
    expect(await seedCanvasFromArtifact(TENANT, 'nope:nope')).toBeNull();
  });
});

describe('updateCanvasForTenant (Phase 2b editor save)', () => {
  it('replaces state and bumps the version', async () => {
    const c = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', initialState: { name: 'A', screens: [] } });
    const r = await updateCanvasForTenant(TENANT, c.canvasId, { name: 'B', screens: [{ id: 's', name: 'S' }] });
    expect(r?.newVersion).toBe(2);
    const back = await getCanvasForTenant(TENANT, c.canvasId);
    expect((back?.state as { name?: string }).name).toBe('B');
  });

  it('enforces optimistic concurrency (expectedVersion)', async () => {
    const c = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', initialState: {} });
    await expect(updateCanvasForTenant(TENANT, c.canvasId, { x: 1 }, { expectedVersion: 99 }))
      .rejects.toMatchObject({ code: 'canvas_version_conflict' });
  });

  it('returns null cross-tenant / absent (no existence leak)', async () => {
    const c = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', initialState: {} });
    expect(await updateCanvasForTenant('tenant-other', c.canvasId, { x: 1 })).toBeNull();
    expect(await updateCanvasForTenant(TENANT, 'canvas-absent', { x: 1 })).toBeNull();
  });
});
