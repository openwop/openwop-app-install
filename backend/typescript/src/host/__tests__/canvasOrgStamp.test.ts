/**
 * ADR 1160 P0 (D1) — a canvas records the org it was created in. Nothing is
 * enforced yet (P1); this pins the stamp and the org-keyed seed.
 *
 *  1. `createCanvasForTenant` / `ensureCanvasForTenant` with an `orgId` stamp it
 *     on the row, the read view and the tenant list; `orgId: null` leaves the
 *     canvas tenant-shared, as every canvas was before.
 *  2. Updates keep the stamp (the row is spread, not rebuilt).
 *  3. Opening one run artifact from two orgs gives two working copies; opening
 *     it twice from one org gives one.
 *  4. A copy made before ADR 1160 (the tenant-wide key) is reused while it is
 *     tenant-shared, so the first open after the upgrade does not duplicate it.
 *     It is reused, not re-keyed: it stays unstamped (D4 places it) and every
 *     org reuses the one copy until then.
 *  5. Deleting a stamped copy clears its org-keyed seed row, so the next open
 *     seeds afresh instead of returning a deleted id.
 *  6. The idempotency TTL sweep keeps the org-keyed seed row, as it keeps the
 *     legacy one: re-opening an old artifact still returns its copy.
 *
 * Sabotage notes: dropping the `orgId` stamp in `createCanvasForTenant` reds 1
 * and 3; keying the seed by artifact alone reds 3; removing the legacy lookup
 * reds 4; dropping the org-keyed delete in `deleteCanvasForTenant` reds 5;
 * removing the sweep's `ct:from-artifact-org:` exemption reds 6.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createCanvasForTenant, deleteCanvasForTenant, ensureCanvasForTenant, getCanvasForTenant, listCanvasesForTenant, sweepExpiredCanvasIdem, updateCanvasForTenant,
} from '../canvasSurface.js';
import { seedCanvasFromArtifact } from '../canvasFromArtifact.js';
import { persistRunArtifact } from '../runArtifactStore.js';
import { registerAppBuilderArtifactType } from '../../features/app-builder/artifactTypes.js';
import { initHostExtPersistence } from '../hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';

const T = 'tenant-1160';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerAppBuilderArtifactType();
});

async function artifact(runId: string): Promise<string> {
  await persistRunArtifact({
    tenantId: T, runId, nodeId: 'n', role: 'deliverable', now: new Date().toISOString(),
    output: { artifact: { artifactTypeId: 'canvas.app-builder', payload: { name: 'Todo', screens: [{ id: 'home', name: 'Home' }] }, title: 'Todo' } },
  });
  return `${runId}:n`;
}

describe('ADR 1160 P0 — a canvas records its org', () => {
  it('1. stamps the org on the row, the view and the list; null stays tenant-shared', async () => {
    const a = await createCanvasForTenant(T, { canvasTypeId: 'canvas.slides', orgId: 'org-a', initialState: {} });
    expect(a.orgId).toBe('org-a');
    expect((await getCanvasForTenant(T, a.canvasId))?.orgId).toBe('org-a');
    expect((await listCanvasesForTenant(T)).find((r) => r.canvasId === a.canvasId)?.orgId).toBe('org-a');
    const shared = await createCanvasForTenant(T, { canvasTypeId: 'canvas.slides', orgId: null, orgWhy: 'system:test', initialState: {} });
    expect(shared.orgId).toBeUndefined();
    expect((await getCanvasForTenant(T, shared.canvasId))?.orgId).toBeUndefined();
    const fixed = await ensureCanvasForTenant(T, 'canvas-1160-fixed', { canvasTypeId: 'canvas.slides', orgId: 'org-a' });
    expect((await getCanvasForTenant(T, fixed.canvasId))?.orgId).toBe('org-a');
  });

  it('2. an update keeps the stamp', async () => {
    const a = await createCanvasForTenant(T, { canvasTypeId: 'canvas.slides', orgId: 'org-a', initialState: {} });
    await updateCanvasForTenant(T, a.canvasId, { x: 1 });
    expect((await getCanvasForTenant(T, a.canvasId))?.orgId).toBe('org-a');
  });

  it('3. one artifact opened from two orgs gives two copies; twice from one org, one', async () => {
    const key = await artifact('run-1160-3');
    const a1 = await seedCanvasFromArtifact(T, key, { orgId: 'org-a' });
    const a2 = await seedCanvasFromArtifact(T, key, { orgId: 'org-a' });
    const b1 = await seedCanvasFromArtifact(T, key, { orgId: 'org-b' });
    expect(a1?.orgId).toBe('org-a');
    expect(a2?.canvasId).toBe(a1?.canvasId);
    expect(b1?.orgId).toBe('org-b');
    expect(b1?.canvasId).not.toBe(a1?.canvasId);
  });

  it('4. a copy made before ADR 1160 is reused while it is tenant-shared', async () => {
    const key = await artifact('run-1160-4');
    const legacy = await seedCanvasFromArtifact(T, key); // no org: the pre-1160 tenant-wide key
    expect(legacy?.orgId).toBeUndefined();
    const reopened = await seedCanvasFromArtifact(T, key, { orgId: 'org-a' });
    expect(reopened?.canvasId).toBe(legacy?.canvasId);
    // Reused, not re-keyed in place: the legacy copy stays tenant-shared (only
    // the ADR 1160 D4 backfill places it), and a second org reuses it too.
    expect((await getCanvasForTenant(T, legacy!.canvasId))?.orgId).toBeUndefined();
    expect((await seedCanvasFromArtifact(T, key, { orgId: 'org-b' }))?.canvasId).toBe(legacy?.canvasId);
    expect((await listCanvasesForTenant(T)).filter((r) => r.canvasId === legacy?.canvasId)).toHaveLength(1);
  });

  it('5. deleting a stamped copy lets the next open seed afresh', async () => {
    const key = await artifact('run-1160-5');
    const first = await seedCanvasFromArtifact(T, key, { orgId: 'org-a' });
    expect(await deleteCanvasForTenant(T, first!.canvasId)).toBe(true);
    const again = await seedCanvasFromArtifact(T, key, { orgId: 'org-a' });
    expect(again?.canvasId).not.toBe(first?.canvasId);
    expect(await getCanvasForTenant(T, again!.canvasId)).not.toBeNull();
  });

  it('6. the idempotency sweep keeps the org-keyed seed row', async () => {
    const key = await artifact('run-1160-6');
    const first = await seedCanvasFromArtifact(T, key, { orgId: 'org-a' });
    await sweepExpiredCanvasIdem(Date.now() + 365 * 86_400_000);
    expect((await seedCanvasFromArtifact(T, key, { orgId: 'org-a' }))?.canvasId).toBe(first?.canvasId);
  });
});
