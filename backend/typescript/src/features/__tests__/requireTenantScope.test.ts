/**
 * requireTenantScope — the tenant-level authority gate (2026-07 vuln-scan Phase 2).
 *
 * Closes the "authority defaults to owner / missing sub-tenant RBAC" cluster: the
 * users lifecycle, capability-firewall, and assistant management routes are
 * TENANT-scoped (no :orgId) yet gated only on requireSignedIn/tenant, so in a shared
 * SSO/SCIM tenant any member acted with owner authority. The gate:
 *   1. implicit personal-workspace owner short-circuits (solo user + anon demo),
 *   2. else the caller's tenant-wide scope UNION (all org memberships) must include
 *      the scope; a non-member / no-subject is denied (fail-closed).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Request } from 'express';
import { requireTenantScope } from '../featureRoute.js';
import { assertTenantScope, createMember, __resetAccessStores } from '../../host/accessControlService.js';
import { isOwnPersonalWorkspace } from '../../host/requestSubject.js';
import { OpenwopError } from '../../types.js';
import { initHostExtPersistence } from '../../host/hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';

const TENANT = 'ws:shared-1';
const EDITOR = 'oidc:editor-sub';
const ADMIN = 'oidc:admin-sub';

/** Minimal Request stand-in — the gate reads tenantId/personalTenant/principal/userId. */
function req(opts: { tenantId?: string; personalTenant?: string; subject?: string; wildcard?: boolean }): Request {
  const tenants = opts.wildcard ? ['*'] : [opts.tenantId ?? TENANT];
  return {
    tenantId: opts.tenantId ?? TENANT,
    personalTenant: opts.personalTenant,
    principal: (opts.subject || opts.wildcard) ? { principalId: opts.subject ?? 'op', tenants, token: '' } : undefined,
  } as unknown as Request;
}

async function expectForbidden(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: 'forbidden_scope', httpStatus: 403 });
  await expect(p).rejects.toBeInstanceOf(OpenwopError);
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  await __resetAccessStores();
  await createMember({ orgId: 'org-a', tenantId: TENANT, displayName: 'Ed', subject: EDITOR, roles: ['editor'] });
  await createMember({ orgId: 'org-a', tenantId: TENANT, displayName: 'Ad', subject: ADMIN, roles: ['admin'] });
});

describe('requireTenantScope', () => {
  it('short-circuits the wildcard operator principal (env key / admin / conformance)', async () => {
    await expect(requireTenantScope(req({ wildcard: true }), 'host:members:manage')).resolves.toBeUndefined();
  });

  it('short-circuits the implicit personal-workspace owner (any scope)', async () => {
    // active tenant === personal tenant → owner by construction, no membership needed.
    await expect(
      requireTenantScope(req({ tenantId: 'user:solo', personalTenant: 'user:solo', subject: 'oidc:solo' }), 'host:members:manage'),
    ).resolves.toBeUndefined();
  });

  it('allows a member whose union includes the scope (admin → host:members:manage)', async () => {
    await expect(requireTenantScope(req({ subject: ADMIN }), 'host:members:manage')).resolves.toBeUndefined();
  });

  it('allows an editor for workspace:write', async () => {
    await expect(requireTenantScope(req({ subject: EDITOR }), 'workspace:write')).resolves.toBeUndefined();
  });

  it('DENIES an editor for host:members:manage (the privesc it closes)', async () => {
    await expectForbidden(requireTenantScope(req({ subject: EDITOR }), 'host:members:manage'));
  });

  it('DENIES a non-member subject (fail-closed)', async () => {
    await expectForbidden(requireTenantScope(req({ subject: 'oidc:stranger' }), 'workspace:write'));
  });

  it('DENIES when there is no subject at all', async () => {
    await expectForbidden(requireTenantScope(req({}), 'workspace:write'));
  });

  // USERS-19 (ADR 0617 D2) — the implicit-owner short-circuit fires ONLY for a
  // personal-SHAPED tenant. The SAML ACS mints `personalTenant` as the single
  // host-global SAML tenant, so "personal === active" used to be true for every
  // SAML member. A revert makes the three DENY cases below resolve.
  describe('USERS-19 — personal-owner short-circuit is shape-gated', () => {
    it('DENIES "personal === active" when the tenant is a deployment-named / default tenant (the SAML shape)', async () => {
      for (const t of ['default', 'acme-corp', 'ws:shared-1']) {
        await expectForbidden(requireTenantScope(req({ tenantId: t, personalTenant: t, subject: 'oidc:saml-member' }), 'host:members:manage'));
        await expectForbidden(assertTenantScope(t, 'oidc:saml-member', 'host:members:manage', { personalTenant: t }));
        expect(isOwnPersonalWorkspace(req({ tenantId: t, personalTenant: t, subject: 'oidc:saml-member' }))).toBe(false);
      }
    });

    it('still short-circuits a `user:` AND an `anon:` personal owner (no membership row)', async () => {
      for (const t of ['user:solo', 'anon:sid-1']) {
        await expect(assertTenantScope(t, 'oidc:solo', 'host:members:manage', { personalTenant: t })).resolves.toBeUndefined();
        expect(isOwnPersonalWorkspace(req({ tenantId: t, personalTenant: t, subject: 'oidc:solo' }))).toBe(true);
      }
    });

    it('an ADMIN member of the SAML-shaped tenant still passes (membership, not ownership)', async () => {
      await createMember({ orgId: 'default', tenantId: 'default', displayName: 'Ad', subject: ADMIN, roles: ['admin'] });
      await expect(assertTenantScope('default', ADMIN, 'host:members:manage', { personalTenant: 'default' })).resolves.toBeUndefined();
      await expect(requireTenantScope(req({ tenantId: 'default', personalTenant: 'default', subject: ADMIN }), 'host:members:manage')).resolves.toBeUndefined();
    });

    it('the wildcard operator is threaded, never inferred', async () => {
      await expect(assertTenantScope('ws:shared-1', undefined, 'host:members:manage', { wildcardOperator: true })).resolves.toBeUndefined();
      await expectForbidden(assertTenantScope('ws:shared-1', undefined, 'host:members:manage', {}));
    });
  });
});
