/**
 * Seed-from-artifact (ADR 0153 §R1/§R6) — opening a run's immutable canvas artifact
 * into an editable host.canvas working copy. Verifies: a canvas.* artifact seeds a
 * working copy carrying the payload as live state + the owning Subject; re-opening the
 * SAME artifact is idempotent (one canvas); cross-tenant / non-canvas / absent → null
 * (no existence leak, no spurious canvas). The working copy records the artifact key in
 * `metadata.seededFromArtifactKey` — the delete cascade reads it to drop the reopen row.
 * A caller-scoped open (`idempotencyScope`, the private editor copy the canvas editor
 * routes pass for a `defaultOwnerToCaller` door, 21340e8f31) gives each caller their
 * OWN copy, and re-opening within one scope still returns that copy.
 *
 * Red when: the cross-tenant check in `seedCanvasFromArtifact` is dropped; the
 * `canvas.` prefix check is dropped; `metadata` is not stamped; the idempotency key
 * ignores `idempotencyScope` (two callers share one copy) or stops being stable
 * (a re-open mints a second copy); `updateCanvasForTenant` merges instead of
 * replacing, skips `expectedVersion`, or skips its tenant check.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant } from '../canvasSurface.js';
import { seedCanvasFromArtifact } from '../canvasFromArtifact.js';
import { persistRunArtifact, getRunArtifact, __resetRunArtifactStore } from '../runArtifactStore.js';
import { registerAppBuilderArtifactType } from '../../features/app-builder/artifactTypes.js';
import { registerCodeExecArtifactType } from '../../features/code-exec/artifactTypes.js';
import { initHostExtPersistence } from '../hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';

const TENANT = 'tenant-a';

// DurableCollection needs host-ext persistence; the typed-artifact path stamps
// `artifactTypeId` only for a REGISTERED, VALID payload.
beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerAppBuilderArtifactType();
  registerCodeExecArtifactType(); // a registered NON-canvas type (the non-canvas case)
});

async function emitCanvasArtifact(runId: string, nodeId: string, tenantId = TENANT) {
  // A node emitting the typed { artifact } envelope (ADR 0083 producer path).
  return persistRunArtifact({
    tenantId, runId, nodeId, role: 'deliverable', now: new Date().toISOString(),
    output: { artifact: { artifactTypeId: 'canvas.app-builder', payload: { name: 'Todo', screens: [{ id: 'home', name: 'Home' }] }, title: 'Todo' } },
  });
}

describe('host.canvas ownerSubject (additive, R6)', () => {
  it('scopes private artifact copies by caller and preserves repeat opening within that scope', async () => {
    const artifact = await emitCanvasArtifact('film-scope-run', 'deliver');
    expect(artifact?.artifactId).toEqual(expect.any(String));
    const a = { canvasTypeId: 'canvas.app-builder', ownerSubject: { kind: 'user' as const, id: 'user:a' }, idempotencyScope: 'org-1:user:a' };
    const b = { ...a, ownerSubject: { kind: 'user' as const, id: 'user:b' }, idempotencyScope: 'org-1:user:b' };
    const first = await seedCanvasFromArtifact(TENANT, 'film-scope-run:deliver', a);
    expect(first?.ownerSubject).toEqual(a.ownerSubject);
    expect((await seedCanvasFromArtifact(TENANT, 'film-scope-run:deliver', a))?.canvasId).toBe(first?.canvasId);
    const other = await seedCanvasFromArtifact(TENANT, 'film-scope-run:deliver', b);
    expect(other?.ownerSubject).toEqual(b.ownerSubject);
    expect(other?.canvasId).not.toBe(first?.canvasId);
  });
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
    expect(canvas?.state).toEqual({ name: 'Todo', screens: [{ id: 'home', name: 'Home' }] });
    expect(canvas?.ownerSubject).toEqual({ kind: 'user', id: 'u-1' });
    expect(canvas?.metadata).toEqual({ seededFromArtifactKey: 'run-1:node-1' });
    expect(canvas?.version).toBe(1);
  });

  it('is idempotent — re-opening the same artifact returns the same canvas', async () => {
    await emitCanvasArtifact('run-2', 'node-1');
    const a = await seedCanvasFromArtifact(TENANT, 'run-2:node-1');
    const b = await seedCanvasFromArtifact(TENANT, 'run-2:node-1');
    expect(a).not.toBeNull();
    expect(a?.canvasId).toMatch(/^canvas-/);
    expect(b?.canvasId).toBe(a?.canvasId);
  });

  it('returns null cross-tenant (no existence leak)', async () => {
    await emitCanvasArtifact('run-3', 'node-1', TENANT);
    expect(await seedCanvasFromArtifact('tenant-other', 'run-3:node-1')).toBeNull();
    // Owner control: the artifact is real and seeds in its own tenant.
    expect((await seedCanvasFromArtifact(TENANT, 'run-3:node-1'))?.canvasTypeId).toBe('canvas.app-builder');
  });

  it('returns null for a non-canvas artifact (no spurious canvas)', async () => {
    const res = await persistRunArtifact({ tenantId: TENANT, runId: 'run-4', nodeId: 'node-1', role: 'deliverable', now: new Date().toISOString(), output: { text: 'plain prose' } });
    expect(res?.artifactId).toBeTruthy();
    expect(await seedCanvasFromArtifact(TENANT, 'run-4:node-1')).toBeNull();
    // A TYPED non-canvas artifact with a JSON-object body: here the `canvas.` prefix
    // check is the only guard standing (an untyped row also fails `!artifactTypeId`).
    await persistRunArtifact({
      tenantId: TENANT, runId: 'run-4', nodeId: 'node-2', role: 'deliverable', now: new Date().toISOString(),
      output: { artifact: { artifactTypeId: 'code.execution-result', payload: { exitCode: 0, stdout: 'ok', stderr: '' } } },
    });
    expect((await getRunArtifact('run-4:node-2'))?.artifactTypeId).toBe('code.execution-result');
    expect(await seedCanvasFromArtifact(TENANT, 'run-4:node-2')).toBeNull();
  });

  it('returns null for an absent artifact', async () => {
    expect(await seedCanvasFromArtifact(TENANT, 'nope:nope')).toBeNull();
  });
});

describe('updateCanvasForTenant (Phase 2b editor save)', () => {
  it('replaces state and bumps the version', async () => {
    // `legacy` is absent from the mutation: replace drops it, a merge would keep it.
    const c = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', initialState: { name: 'A', screens: [], legacy: true } });
    const r = await updateCanvasForTenant(TENANT, c.canvasId, { name: 'B', screens: [{ id: 's', name: 'S' }] });
    expect(r).toEqual({ canvasId: c.canvasId, newVersion: 2 });
    const back = await getCanvasForTenant(TENANT, c.canvasId);
    expect(back?.state).toEqual({ name: 'B', screens: [{ id: 's', name: 'S' }] });
    expect(back?.version).toBe(2);
  });

  it('enforces optimistic concurrency (expectedVersion)', async () => {
    const c = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', initialState: {} });
    await expect(updateCanvasForTenant(TENANT, c.canvasId, { x: 1 }, { expectedVersion: 99 }))
      .rejects.toMatchObject({ code: 'canvas_version_conflict', httpStatus: 409 });
    expect((await getCanvasForTenant(TENANT, c.canvasId))?.version).toBe(1);
  });

  it('returns null cross-tenant / absent (no existence leak)', async () => {
    const c = await createCanvasForTenant(TENANT, { canvasTypeId: 'canvas.app-builder', initialState: {} });
    expect(await updateCanvasForTenant('tenant-other', c.canvasId, { x: 1 })).toBeNull();
    expect(await updateCanvasForTenant(TENANT, 'canvas-absent', { x: 1 })).toBeNull();
    expect((await getCanvasForTenant(TENANT, c.canvasId))?.state).toEqual({});
    // Owner control: the same canvas IS writable in its own tenant.
    expect(await updateCanvasForTenant(TENANT, c.canvasId, { x: 1 })).toEqual({ canvasId: c.canvasId, newVersion: 2 });
  });
});
