/**
 * GC-6 / ADR 0508 — the demo de-facto-owner bypass must not apply to a SHARED
 * workspace.
 *
 * `resolveEffectiveAccess` (`host/accessControlService.ts`) returns full OWNER scopes
 * for a subject with no matching member row when `OPENWOP_DEMO_MODE=true` (LEAK-9).
 * Its stated rationale is that "the tenant is a one-principal sandbox (tenant ==
 * principal)". That is true for `anon:`/`user:`/`default`, and FALSE for a shared
 * `ws:` workspace, which ADR 0015 defines as multi-member — there, "no member row for
 * this org" means the caller is NOT a member, the case that must fail closed.
 * Unnarrowed, a workspace VIEWER querying a sub-org they do not belong to resolves to
 * OWNER.
 *
 * WHY THIS IS A SERVICE-LEVEL TEST, not a route test: the route path is currently
 * unreachable. `requireOrgScope` compares the org's tenant against the caller's HOME
 * tenant (ADR 0508 / GC-5) and 404s first, so no HTTP request can reach this branch
 * in a shared workspace today. Testing the MECHANISM here is the only honest proof
 * available, and it is exactly why this lands BEFORE GC-5: the moment that guard is
 * fixed, this branch becomes reachable, and it must already be closed.
 *
 * The wiring half — that a real HTTP viewer is refused — is the acceptance test in
 * `orgscope-shared-workspace.test.ts`, skipped until GC-5 lands. Mechanism and wiring
 * are tested separately and deliberately (ADR 0502).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  resolveEffectiveAccess,
  isSinglePrincipalTenant,
  createOrg,
  createMember,
} from '../src/host/accessControlService.js';

const PRIOR_DEMO = process.env.OPENWOP_DEMO_MODE;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_DEMO_MODE = 'true'; // as the live demo deploy runs
  initHostExtPersistence(await openStorage('memory://'));
});
afterAll(() => {
  if (PRIOR_DEMO === undefined) delete process.env.OPENWOP_DEMO_MODE;
  else process.env.OPENWOP_DEMO_MODE = PRIOR_DEMO;
});

describe('GC-6 — the demo owner bypass is scoped to single-principal tenants', () => {
  it('a SHARED ws: workspace fails CLOSED for an unknown subject, even in demo mode', async () => {
    const tenantId = 'ws:gc6-shared-0001';
    const org = await createOrg({ tenantId, createdBy: 'oidc:gc6-founder', name: 'Sub Org' });

    const access = await resolveEffectiveAccess(tenantId, {
      subject: 'user:gc6-outsider',
      orgId: org.orgId,
    });

    // The whole point: no member row in a MULTI-MEMBER workspace means "not a member".
    expect(access.roles, 'a non-member of a shared workspace must resolve to NO roles').toEqual([]);
    expect(access.scopes, 'and to NO scopes — fail-closed, RFC 0049').toEqual([]);
    expect(access.basis).toBe('none');
  });

  it('a workspace MEMBER querying a sub-org they do not belong to is not promoted to owner', async () => {
    // The concrete escalation ADR 0508 measured: the caller IS in the workspace (so
    // they pass the membership re-check and can hold this active tenant), but holds no
    // row in the sub-org they are asking about.
    const tenantId = 'ws:gc6-shared-0002';
    const viewer = 'user:gc6-viewer';
    await createMember({ orgId: tenantId, tenantId, displayName: 'V', subject: viewer, roles: ['viewer'] });
    const sub = await createOrg({ tenantId, createdBy: 'oidc:gc6-founder', name: 'Finance' });

    const access = await resolveEffectiveAccess(tenantId, { subject: viewer, orgId: sub.orgId });

    expect(access.scopes, 'a viewer must not inherit OWNER scopes in a sub-org').toEqual([]);
    expect(access.roles).toEqual([]);
  });

  it('the personal/anon demo path is UNCHANGED — the bypass still applies where it belongs', async () => {
    // The regression direction. Narrowing this must not break the demo experience it
    // exists for: an anonymous visitor who never set up RBAC members still reads.
    for (const tenantId of ['anon:gc6-session', 'user:gc6-personal', 'default']) {
      const org = await createOrg({ tenantId, createdBy: 'oidc:gc6-solo', name: `Solo ${tenantId}` });
      const access = await resolveEffectiveAccess(tenantId, {
        subject: 'user:gc6-solo-unknown',
        orgId: org.orgId,
      });
      expect(access.roles, `${tenantId} is single-principal — the demo bypass still applies`).toEqual(['owner']);
      expect(access.basis).toBe('tenant-owner');
    }
  });

  it('isSinglePrincipalTenant is an ALLOWLIST — an unrecognised shape fails closed', async () => {
    expect(isSinglePrincipalTenant('default')).toBe(true);
    expect(isSinglePrincipalTenant('anon:abc')).toBe(true);
    expect(isSinglePrincipalTenant('user:abc')).toBe(true);
    expect(isSinglePrincipalTenant('ws:abc')).toBe(false);
    // Not a denylist on `ws:` — anything unrecognised must also be false, so a future
    // tenant shape cannot silently inherit the single-principal assumption.
    expect(isSinglePrincipalTenant('org:abc')).toBe(false);
    expect(isSinglePrincipalTenant('team:abc')).toBe(false);
    expect(isSinglePrincipalTenant('')).toBe(false);
  });
});
