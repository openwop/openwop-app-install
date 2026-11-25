/**
 * ADR 1160 P3 (D4) — placing a tenant-shared canvas in an org, and the backfill
 * plan that decides which ones are certain.
 *
 *  1. `claimCanvasOrg` sets an unset org and leaves content, version and
 *     `updatedAt` untouched; it is audited;
 *  2. it never re-homes: a placed canvas answers `already` (same org) or
 *     `conflict` (another);
 *  3. it refuses an org of another tenant, and a project-owned canvas outside
 *     its project's org (`wrong_org`); an absent canvas is `not_found`;
 *  4. the plan places a one-org tenant's canvases in that org and a project-owned
 *     canvas in its project's org, and LEAVES every other canvas of a multi-org
 *     tenant shared (no guess from the creator);
 *  5. applying the plan claims exactly what it planned; a second plan is empty.
 *
 * Sabotage notes: dropping the `if (c.orgId)` guard reds 2; dropping the tenant
 * check on the org reds 3; placing multi-org canvases by any rule reds 4.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { applyCanvasOrgPlan, claimCanvasOrg, createCanvasForTenant, getCanvasForTenant, listCanvasesForTenant, planCanvasOrgBackfill } from '../canvasSurface.js';
import { createOrg } from '../accessControlService.js';
import { setSubjectOrgResolver } from '../subjectOrgScope.js';
import { verifyChain } from '../auditChainService.js';
import { initHostExtPersistence } from '../hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';

const projectOrg = new Map<string, string>();
beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  setSubjectOrgResolver(async (_t, s) => (s.kind === 'project' ? projectOrg.get(s.id) ?? null : null));
});

let n = 0;
const shared = (tenantId: string, extra: Record<string, unknown> = {}) =>
  createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.slides', orgId: null, orgWhy: 'system:test-legacy', initialState: { v: n++ }, ...extra });
const org = async (tenantId: string, name: string): Promise<string> => (await createOrg({ tenantId, createdBy: 'own', name, ownerSubject: 'own' })).orgId;

describe('ADR 1160 P3 — claimCanvasOrg and the backfill plan', () => {
  it('1. places an unset canvas, leaving its content and version, and audits it', async () => {
    const T = `t-claim-1-${n++}`; const A = await org(T, 'A');
    const c = await shared(T);
    const before = (await listCanvasesForTenant(T)).find((r) => r.canvasId === c.canvasId)!;
    expect(await claimCanvasOrg(T, c.canvasId, A, 'system:test')).toBe('claimed');
    const after = await getCanvasForTenant(T, c.canvasId);
    expect(after?.orgId).toBe(A);
    expect(after?.version).toBe(c.version);
    expect(after?.state).toEqual(c.state);
    expect((await listCanvasesForTenant(T)).find((r) => r.canvasId === c.canvasId)).toMatchObject({ orgId: A, updatedAt: before.updatedAt });
    expect((await verifyChain(T)).ok).toBe(true);
  });

  it('2. never re-homes a placed canvas', async () => {
    const T = `t-claim-2-${n++}`; const A = await org(T, 'A'); const B = await org(T, 'B');
    const c = await shared(T);
    expect(await claimCanvasOrg(T, c.canvasId, A, 'system:test')).toBe('claimed');
    expect(await claimCanvasOrg(T, c.canvasId, A, 'system:test')).toBe('already');
    expect(await claimCanvasOrg(T, c.canvasId, B, 'system:test')).toBe('conflict');
    expect((await getCanvasForTenant(T, c.canvasId))?.orgId).toBe(A);
  });

  it('3. refuses another tenant’s org and a project canvas outside its project’s org', async () => {
    const T = `t-claim-3-${n++}`; const A = await org(T, 'A'); const B = await org(T, 'B');
    const other = await org(`t-claim-3-other-${n++}`, 'X');
    const c = await shared(T);
    expect(await claimCanvasOrg(T, c.canvasId, other, 'system:test')).toBe('wrong_org');
    projectOrg.set('proj-3', A);
    const p = await shared(T, { ownerSubject: { kind: 'project', id: 'proj-3' } });
    expect(await claimCanvasOrg(T, p.canvasId, B, 'system:test')).toBe('wrong_org');
    expect(await claimCanvasOrg(T, p.canvasId, A, 'system:test')).toBe('claimed');
    expect(await claimCanvasOrg(T, 'canvas-absent', A, 'system:test')).toBe('not_found');
    expect((await getCanvasForTenant(T, c.canvasId))?.orgId).toBeUndefined();
  });

  it('4. plans only what is certain', async () => {
    const one = `t-plan-one-${n++}`; const O = await org(one, 'Only');
    const a = await shared(one); const b = await shared(one);
    const planOne = await planCanvasOrgBackfill(one);
    expect(planOne.unstamped).toBe(2);
    expect(planOne.place.map((p) => [p.canvasId, p.orgId, p.why]).sort()).toEqual([[a.canvasId, O, 'one-org-tenant'], [b.canvasId, O, 'one-org-tenant']].sort());
    expect(planOne.leftShared).toBe(0);

    const multi = `t-plan-multi-${n++}`; const A = await org(multi, 'A'); await org(multi, 'B');
    projectOrg.set('proj-4', A);
    const owned = await shared(multi, { ownerSubject: { kind: 'project', id: 'proj-4' } });
    await shared(multi, { ownerSubject: { kind: 'user', id: 'u-1' } }); // a creator is never a guess
    await shared(multi);
    const planMulti = await planCanvasOrgBackfill(multi);
    expect(planMulti.unstamped).toBe(3);
    expect(planMulti.place).toEqual([{ canvasId: owned.canvasId, orgId: A, why: 'project-owned' }]);
    expect(planMulti.leftShared).toBe(2);
  });

  it('5. applying the plan claims what it planned; a second plan is empty', async () => {
    const T = `t-plan-apply-${n++}`; const O = await org(T, 'Only');
    await shared(T); await shared(T);
    expect(await applyCanvasOrgPlan(await planCanvasOrgBackfill(T), 'system:adr1160-backfill-test')).toMatchObject({ claimed: 2, conflict: 0 });
    const again = await planCanvasOrgBackfill(T);
    expect(again).toMatchObject({ unstamped: 0, place: [], leftShared: 0 });
    for (const r of await listCanvasesForTenant(T)) expect(r.orgId).toBe(O);
  });
});
