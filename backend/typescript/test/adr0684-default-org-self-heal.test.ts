/**
 * ADR 0684 correction, migration half — an org provisioned under the OLD id
 * shape must be repaired at boot, not skipped forever.
 *
 * THE BUG THIS PINS is one the correction itself introduced, and it would have
 * shipped silently. The correction changed the declared tenant id
 * (`host:<f>` → `host-<f>`), but `ensureFeatureDefaultOrgs` keyed idempotence on
 * the ORG id, which did not change. So on any host that had already booted the
 * old code, `getOrg` found the stale row, the create was skipped, and the org
 * kept a tenant id that makes it not-a-workspace.
 *
 * That end state is WORSE than the bug it replaced: auto-join now writes
 * workspace-root-shaped member rows, so `isWorkspaceMember` passes while
 * `getWorkspace` still returns null — half-working instead of cleanly broken.
 * Caught by checking `app.openwop.dev` before deploying, which already had the
 * org provisioned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureFeatureDefaultOrgs, type FeatureDefaultOrg } from '../src/host/featureDefaultOrgs.js';
import {
  createOrg, getOrg, getWorkspace, isWorkspaceOrg, ensureWorkspaceRootOrg, listMembers, createMember,
} from '../src/host/accessControlService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('a stale pre-correction org is repaired, not skipped', () => {
  it('rebinds an org whose tenant id is the old colon form', async () => {
    // Exactly what a host running the pre-correction code left behind.
    await createOrg({ tenantId: 'host:stale', orgId: 'host-stale', createdBy: 'system', name: 'Stale' });
    expect(isWorkspaceOrg((await getOrg('host-stale'))!), 'precondition: the stale row is NOT a workspace root').toBe(false);
    expect(await getWorkspace('host-stale'), 'precondition: it does not resolve as a workspace').toBeNull();

    const decl: FeatureDefaultOrg = {
      featureId: 'f-stale', orgId: 'host-stale', tenantId: 'host-stale', name: 'Stale',
    };
    await ensureFeatureDefaultOrgs([decl]);

    const after = await getOrg('host-stale');
    expect(isWorkspaceOrg(after!), 'boot must repair it').toBe(true);
    expect(after!.tenantId).toBe('host-stale');
    expect(await getWorkspace('host-stale'), 'and it now resolves as a workspace').not.toBeNull();
  });

  it('reports the repair distinctly from a create, naming the prior tenant', async () => {
    await createOrg({ tenantId: 'host:rep', orgId: 'host-rep', createdBy: 'system', name: 'Rep' });
    const r = await ensureWorkspaceRootOrg({ orgId: 'host-rep', tenantId: 'host-rep', name: 'Rep', createdBy: 'system' });
    expect(r).toEqual({ action: 'repaired', priorTenantId: 'host:rep' });
  });

  it('a HEALTHY org is left completely alone — repair is not a rewrite-every-boot', async () => {
    const first = await ensureWorkspaceRootOrg({ orgId: 'host-ok', tenantId: 'host-ok', name: 'OK', createdBy: 'system' });
    expect(first.action).toBe('created');
    const created = await getOrg('host-ok');

    const second = await ensureWorkspaceRootOrg({ orgId: 'host-ok', tenantId: 'host-ok', name: 'OK', createdBy: 'system' });
    expect(second).toEqual({ action: 'unchanged' });
    // Identity, not just shape: a repair that re-created the row every boot
    // would churn createdAt and look identical to this assertion's shape.
    expect((await getOrg('host-ok'))!.createdAt).toBe(created!.createdAt);
  });

  it('member rows under the PRIOR tenant are left in place — inert, not deleted', async () => {
    await createOrg({ tenantId: 'host:keep', orgId: 'host-keep', createdBy: 'system', name: 'Keep' });
    await createMember({ orgId: 'host-keep', tenantId: 'host:keep', subject: 'user:ghost', displayName: 'Ghost' });
    expect(await listMembers('host:keep', 'host-keep')).toHaveLength(1);

    await ensureWorkspaceRootOrg({ orgId: 'host-keep', tenantId: 'host-keep', name: 'Keep', createdBy: 'system' });

    // The boot repair must not destroy production rows unattended. These were
    // never functional, so leaving them costs nothing; deleting them silently
    // would be a data-loss decision taken by a startup path.
    expect(await listMembers('host:keep', 'host-keep'), 'the repair must not cascade into members').toHaveLength(1);
  });

  it('REFUSES to "ensure" a pair that is not a workspace root — the guard is not bypassable', async () => {
    await expect(ensureWorkspaceRootOrg({ orgId: 'host-bad', tenantId: 'host:bad', name: 'Bad', createdBy: 'system' }))
      .rejects.toThrow(/EQUAL/i);
  });
});
