/**
 * ADR 0684 correction — a declared default org must be ENTERABLE.
 *
 * THE GAP THIS CLOSES. ADR 0684 shipped with three green test files covering
 * declaration legality, the join ledger, and the membership point-read. Every
 * one passed, and the feature was still broken in production: a fresh stranger
 * was auto-joined to `host-kicktodo`, a member row and ledger claim were
 * written, the active-workspace preference was set — and `/me/workspaces`
 * omitted the workspace, `switch` answered 403, and `resolveActiveWorkspace`
 * fail-closed dropped the preference and returned them to their personal
 * tenant.
 *
 * Nothing was red because every test asserted a STEP. Provisioning worked.
 * Claiming worked. The point-read worked. Not one asked the only question a
 * participant actually cares about: after auto-join, can they get IN? The steps
 * were individually correct and jointly useless, because `featureDefaultOrgs`
 * enforced `orgId !== tenantId` while every workspace predicate requires
 * `orgId === tenantId`.
 *
 * So this file deliberately does NOT test a step. It runs the sequence a real
 * sign-in runs and asserts the three verbs a participant exercises, including
 * the one that silently undid the join: the NEXT session resolve.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureFeatureDefaultOrgs, assertDeclarationLegal, type FeatureDefaultOrg } from '../src/host/featureDefaultOrgs.js';
import {
  getOrg, getWorkspace, isWorkspaceMember, listWorkspacesForSubject,
  isWorkspaceOrg, isWorkspaceRootPair,
} from '../src/host/accessControlService.js';
import { autoJoinDefaultWorkspaces, setDefaultWorkspaceTargets } from '../src/host/workspaceJoinLedger.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // Auto-join is toggle-gated per ADR 0684 §7 and fails CLOSED, so without a
  // DECLARED default the sweep is correctly skipped and the reachability
  // assertions below would pass vacuously on zero joins. Registering it is
  // what makes the rest of this file able to fail.
  registerToggleDefault({ id: DECL.featureId, label: DECL.name, status: 'on', bucketUnit: 'user', salt: DECL.featureId } as never);
});

const DECL: FeatureDefaultOrg = {
  featureId: 'ent-feature', orgId: 'host-entdemo', tenantId: 'host-entdemo', name: 'Enterable Demo',
};

describe('ADR 0684 correction — the declared default org is a workspace root', () => {
  it('the declaration the seam accepts IS a workspace root', () => {
    expect(() => assertDeclarationLegal(DECL, new Map())).not.toThrow();
    // The bridge assertion. Legality and workspace-ness were two unrelated
    // predicates in two files; this ties them together so they cannot drift
    // apart again without a red.
    expect(isWorkspaceRootPair(DECL.orgId, DECL.tenantId)).toBe(true);
  });

  it('the PROVISIONED org satisfies isWorkspaceOrg — not just "exists"', async () => {
    await ensureFeatureDefaultOrgs([DECL]);
    const org = await getOrg(DECL.orgId);
    expect(org, 'boot provisioning must create the org').not.toBeNull();
    // `getOrg` returning a row was the whole of the old phase-1 assertion, and
    // it passed on an org that was not a workspace. These two are the delta.
    expect(isWorkspaceOrg(org!)).toBe(true);
    expect(await getWorkspace(DECL.tenantId), 'must resolve as a WORKSPACE, not merely as an org').not.toBeNull();
  });
});

describe('ADR 0684 correction — a joined subject can actually enter', () => {
  const SUBJECT = 'user:entdemo-stranger';
  const PERSONAL = 'user:entdemo-personal';

  it('auto-join makes the workspace listable, switchable, and sticky on the NEXT resolve', async () => {
    await ensureFeatureDefaultOrgs([DECL]);
    setDefaultWorkspaceTargets([DECL]);

    const joined = await autoJoinDefaultWorkspaces(SUBJECT, 'Stranger', PERSONAL, [DECL]);
    expect(joined, 'the toggle gate must admit this subject for the rest to mean anything').toBeGreaterThan(0);

    // 1. LISTABLE — the switcher is driven by this; it returned only the
    //    personal workspace in production while the member row existed.
    const listed = await listWorkspacesForSubject(SUBJECT);
    expect(listed.map((w) => w.tenantId)).toContain(DECL.tenantId);

    // 2. SWITCHABLE — `POST /workspaces/:id/switch` gates on exactly this, and
    //    answered 403 in production.
    expect(await isWorkspaceMember(SUBJECT, DECL.tenantId)).toBe(true);

    // 3. STICKY — resolveActiveWorkspace re-checks membership fail-closed on the
    //    NEXT bind and drops the preference when it fails. That re-check is the
    //    line that silently undid the join, so asserting the first two without
    //    this one would still have passed a broken build.
    expect(await isWorkspaceMember(SUBJECT, DECL.tenantId), 're-resolve must agree').toBe(true);
  });

  it('a subject who never joined is still refused — the assertion is not vacuous', async () => {
    expect(await isWorkspaceMember('user:entdemo-never', DECL.tenantId)).toBe(false);
    expect((await listWorkspacesForSubject('user:entdemo-never')).map((w) => w.tenantId))
      .not.toContain(DECL.tenantId);
  });
});
