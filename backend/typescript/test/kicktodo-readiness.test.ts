/**
 * ADR 0690 — the KickTodo readiness report says whether THIS deployment can run
 * the participant loop, naming each blocker in the order a stranger hits it.
 *
 *  - a default workspace provisioned in the pre-correction shape (org row's
 *    tenant ≠ declared id) is reported provisioned-but-NOT-enterable — the exact
 *    production defect of 2026-09-15, as one field;
 *  - the correct shape is enterable;
 *  - feature toggles are resolved WHERE THE DEFAULT LIVES, not only for the
 *    caller — the auto-join gate's view;
 *  - a pinned pack that is not on disk is a blocker; a present one is not;
 *  - the schedule daemon not having ticked is a blocker; a tick clears it;
 *  - web search and blob are reported and fold into `factory.ready`, never
 *    into `status`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createOrg } from '../src/host/accessControlService.js';
import { ensureFeatureDefaultOrgs } from '../src/host/featureDefaultOrgs.js';
import { setDefaultWorkspaceTargets } from '../src/host/workspaceJoinLedger.js';
import { registerToggleDefault, registerFeaturePacks, __resetFeaturePacks } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __noteScheduleDaemonTickForTest, __resetScheduleDaemonLivenessForTest } from '../src/host/scheduleDaemon.js';
import { buildKicktodoReadiness, KICKTODO_FEATURE_IDS } from '../src/features/kicktodo-core/readinessService.js';

// One declared default per CASE (the org store is module-level and outlives a
// host-ext reset), so a row created in one case can never satisfy another.
let n = 0;
// Pack presence reads OPENWOP_PACK_DIR (default ~/.openwop-packs); point it at the
// repo's vendored packs so a real pin reads present and a fake one reads missing.
const REPO_PACKS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'packs');
const PRIOR_PACK_DIR = process.env.OPENWOP_PACK_DIR;
let TARGET = { featureId: 'kicktodo-core', orgId: 'host-kicktodo', tenantId: 'host-kicktodo', name: 'KickTodo' };

beforeEach(async () => {
  process.env.OPENWOP_PACK_DIR = REPO_PACKS;
  initHostExtPersistence(await openStorage('memory://'));
  await __clearToggleStore();
  __resetScheduleDaemonLivenessForTest();
  registerToggleDefault({ id: 'kicktodo-core', status: 'off', bucketUnit: 'user', salt: 'kicktodo-core' });
  registerToggleDefault({ id: 'kicktodo-creator', status: 'off', bucketUnit: 'tenant', salt: 'kicktodo-creator' });
  n += 1;
  TARGET = { featureId: 'kicktodo-core', orgId: `host-kicktodo-${n}`, tenantId: `host-kicktodo-${n}`, name: 'KickTodo' };
  setDefaultWorkspaceTargets([TARGET]);
});

afterEach(() => {
  if (PRIOR_PACK_DIR === undefined) delete process.env.OPENWOP_PACK_DIR; else process.env.OPENWOP_PACK_DIR = PRIOR_PACK_DIR;
  setDefaultWorkspaceTargets([]);
  // ADR 0734: the pack-blocker case pins a FAKE `feature.kicktodo.never-shipped`
  // on the REAL kicktodo-core, and the next it() would read that poisoned blocker
  // list — passing only because every assertion here is a loose `.some()`. This IS
  // load-bearing (it() to it(), same process), unlike the cross-file afterAll cases.
  // NOTE it is a GLOBAL clear: `registry.ts` implements it as `featurePacks.clear()`,
  // dropping every feature's requiredPacks, not just the fake pin, and nothing
  // re-registers them. Later cases here run against an empty pack registry, which is
  // fine only because they assert blockers are ABSENT. An assertion on a real pack row
  // must re-register first.
  __resetFeaturePacks();
  __resetHostExtPersistence();
});

describe('KickTodo readiness (ADR 0690)', () => {
  it('reports the pre-correction default workspace as provisioned but NOT enterable, and names it as a blocker', async () => {
    await createOrg({ orgId: TARGET.orgId, tenantId: `host:kicktodo-${n}`, createdBy: 'system', name: 'KickTodo' });
    const r = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    expect(r.status).toBe('degraded');
    expect(r.checks.defaultWorkspaces).toEqual([
      { featureId: 'kicktodo-core', orgId: TARGET.orgId, tenantId: TARGET.tenantId, provisioned: true, enterable: false, storedTenantId: `host:kicktodo-${n}` },
    ]);
    expect(r.blockers.some((b) => new RegExp(`${TARGET.orgId} is provisioned but not enterable \\(stored tenant host:kicktodo-${n}`).test(b))).toBe(true);
  });

  it('the corrected shape is enterable; an unprovisioned declaration is its own blocker', async () => {
    const before = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    expect(before.checks.defaultWorkspaces[0]?.provisioned).toBe(false);
    expect(before.blockers.some((b) => /is not provisioned/.test(b))).toBe(true);
    await ensureFeatureDefaultOrgs([TARGET]);
    const after = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    expect(after.checks.defaultWorkspaces[0]).toMatchObject({ provisioned: true, enterable: true, storedTenantId: TARGET.tenantId });
    expect(after.blockers.some((b) => /^default workspace host-kicktodo-\d+ /.test(b))).toBe(false);
  });

  it('resolves toggles where the default lives — a caller-tenant override does not make a stranger’s auto-join live', async () => {
    await ensureFeatureDefaultOrgs([TARGET]);
    // Global OFF, override ON for the operator's tenant only — what the 2026-09 deploy had.
    await saveConfig({ id: 'kicktodo-core', status: 'off', bucketUnit: 'user', salt: 'kicktodo-core', tenantOverrides: { 'user:operator': { status: 'on' } } }, 'test');
    const r = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    const core = r.checks.features.find((f) => f.id === 'kicktodo-core')!;
    expect(core).toMatchObject({ registered: true, global: 'off', callerTenant: true, defaultWorkspace: false });
    expect(r.blockers.some((b) => /kicktodo-core resolves OFF where the default workspace lives/.test(b))).toBe(true);
    // Global ON — the stranger's view goes live and the blocker clears.
    await saveConfig({ id: 'kicktodo-core', status: 'on', bucketUnit: 'user', salt: 'kicktodo-core' }, 'test');
    const r2 = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    expect(r2.checks.features.find((f) => f.id === 'kicktodo-core')).toMatchObject({ global: 'on', callerTenant: true, defaultWorkspace: true });
    expect(r2.blockers.some((b) => /resolves OFF where the default workspace lives/.test(b))).toBe(false);
    // Every KickTodo feature is listed, registered or not.
    expect(r2.checks.features.map((f) => f.id)).toEqual([...KICKTODO_FEATURE_IDS]);
    expect(r2.checks.features.find((f) => f.id === 'kicktodo-metrics')?.registered).toBe(false);
  });

  it('a pinned pack that is not on disk is a blocker; a present pin is reported, not blocked', async () => {
    registerFeaturePacks('kicktodo-core', [
      { name: 'feature.kicktodo.nodes', version: '1.27.0' },
      { name: 'feature.kicktodo.never-shipped', version: '9.9.9' },
    ]);
    const r = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    const rows = r.checks.packs.filter((p) => p.feature === 'kicktodo-core');
    expect(rows.map((p) => p.name).sort()).toEqual(['feature.kicktodo.never-shipped', 'feature.kicktodo.nodes']);
    expect(rows.find((p) => p.name === 'feature.kicktodo.never-shipped')?.status).toBe('missing');
    expect(['installed', 'mounted']).toContain(rows.find((p) => p.name === 'feature.kicktodo.nodes')?.status);
    expect(r.blockers.some((b) => /feature\.kicktodo\.never-shipped@9\.9\.9 pinned by kicktodo-core is missing/.test(b))).toBe(true);
    expect(r.blockers.some((b) => /feature\.kicktodo\.nodes@1\.27\.0/.test(b))).toBe(false);
  });

  it('the schedule daemon must have ticked; web search and blob fold into factory.ready, never status', async () => {
    await ensureFeatureDefaultOrgs([TARGET]);
    const r = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    expect(r.checks.scheduler.started).toBe(false);
    expect(r.blockers.some((b) => /schedule daemon has not started/.test(b))).toBe(true);
    __noteScheduleDaemonTickForTest();
    const r2 = await buildKicktodoReadiness({ tenantId: 'user:operator' });
    expect(r2.checks.scheduler.started).toBe(true);
    expect(r2.checks.scheduler.ageMs).not.toBeNull();
    expect(r2.blockers.some((b) => /schedule daemon/.test(b))).toBe(false);
    // Reported, never gating: no web-search key in a unit test, so the Factory
    // is not ready — and that is NOT among the status blockers.
    expect(r2.checks.webSearch.configured).toBe(false);
    expect(r2.checks.factory.ready).toBe(false);
    expect(r2.checks.factory.reasons.some((x) => /web search is not configured/.test(x))).toBe(true);
    expect(r2.blockers.some((b) => /web search/.test(b))).toBe(false);
    expect(typeof r2.checks.surfaces.implementation['blob']).toBe('string');
    // The envelope a smoke script reads.
    expect(r2).toMatchObject({ version: expect.any(String), build: expect.any(Object), posture: expect.any(String) });
  });
});
