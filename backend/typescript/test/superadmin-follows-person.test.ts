/**
 * `isSuperadmin` follows the PERSON, not the active workspace (owner's decision,
 * 2026-09-23 — reported against production rev 00737-vkq by a peer session).
 *
 * `req.tenantId` is the ACTIVE workspace (`middleware/auth.ts`): it starts as the
 * caller's own personal tenant and becomes `ws:<uuid>` after a switch. When the
 * allowlist was matched against that alone, an operator listed in
 * `OPENWOP_SUPERADMIN_TENANTS` SILENTLY lost superadmin by switching into a
 * shared workspace — every host-global admin surface 403'd with no explanation,
 * and the SPA hid the nav entry because `/access/effective` projects this same
 * predicate (`routes/accessControl.ts`).
 *
 * The widening is guarded BY SHAPE, and that guard is the security-relevant half:
 * `personalTenant` is a claim the MINT SITE makes, and the SAML ACS mints ONE
 * host-global `OPENWOP_SAML_TENANT` shared by every SAML user (USERS-19 /
 * ADR 0617 D2). Honouring it unguarded would hand superadmin to every member of
 * that tenant the moment the value appeared in the allowlist. So the SAML-shaped
 * case below is the sabotage target: drop `isPersonalTenantId` from
 * `host/superadmin.ts` and it must go red.
 *
 * Tested at the predicate rather than through HTTP deliberately: this ONE
 * function is the shared gate every admin route and the SPA projection call
 * (ADR 0028 extracted it precisely so there is no per-route copy to drift), so
 * the predicate IS the authorization boundary. The route-level projection is
 * covered in `access-control.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { isSuperadmin, isSuperadminTenant } from '../src/host/superadmin.js';

/** A session: an active workspace plus the caller's own personal tenant. */
const req = (tenantId: string, personalTenant?: string): Request =>
  ({ tenantId, personalTenant } as unknown as Request);

const OPERATOR = 'user:abc123';
const SAML_TENANT = 'saml:acme'; // what OPENWOP_SAML_TENANT mints — many humans, one id

afterEach(() => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
});

describe('isSuperadmin — the allowlist follows the person', () => {
  it('a listed operator KEEPS superadmin after switching into a shared ws: workspace', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    // The reported defect: identical session, only the active workspace differs.
    expect(isSuperadmin(req(OPERATOR, OPERATOR))).toBe(true);
    expect(isSuperadmin(req('ws:7f3a9c10-0000-4000-8000-000000000001', OPERATOR))).toBe(true);
  });

  it('still accepts a listed ACTIVE tenant with no personal tenant at all (API-key sessions)', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'tenant-a';
    expect(isSuperadmin(req('tenant-a'))).toBe(true);
  });

  it('SABOTAGE TARGET — a SAML-shaped personalTenant is NOT honoured even when listed', () => {
    // The SAML ACS mints ONE tenant for every SAML user. If the shape guard is
    // removed, listing it grants superadmin to the whole workforce.
    process.env.OPENWOP_SUPERADMIN_TENANTS = SAML_TENANT;
    expect(isSuperadmin(req('ws:7f3a9c10-0000-4000-8000-000000000001', SAML_TENANT))).toBe(false);
    // `default` is the other shape a SAML/self-host deploy can mint.
    process.env.OPENWOP_SUPERADMIN_TENANTS = 'default';
    expect(isSuperadmin(req('ws:7f3a9c10-0000-4000-8000-000000000001', 'default'))).toBe(false);
  });

  it('an UNLISTED personal tenant grants nothing, and a listed one grants nothing to a different person', () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    expect(isSuperadmin(req('ws:7f3a9c10-0000-4000-8000-000000000001', 'user:someone-else'))).toBe(false);
    expect(isSuperadmin(req('ws:7f3a9c10-0000-4000-8000-000000000001'))).toBe(false);
  });

  it('fails closed with an empty/absent allowlist, whatever the session looks like', () => {
    expect(isSuperadmin(req(OPERATOR, OPERATOR))).toBe(false);
    process.env.OPENWOP_SUPERADMIN_TENANTS = '';
    expect(isSuperadmin(req(OPERATOR, OPERATOR))).toBe(false);
    process.env.OPENWOP_SUPERADMIN_TENANTS = ' , ';
    expect(isSuperadmin(req(OPERATOR, OPERATOR))).toBe(false);
  });
});

describe('the two branches the personal-tenant change did NOT touch', () => {
  // Reported by the reviewing session as the one sabotage of four that nothing
  // covered: the fix above added a branch to `isSuperadmin`, and the wildcard
  // bearer and dev-open branches were asserted to be unchanged by reading the
  // diff rather than by a test. Reading a diff does not survive the NEXT edit.
  // These pin the other two doors so a later change to this function cannot
  // quietly widen or close either without a red test.

  it('a wildcard bearer principal is superadmin with NO allowlist and NO personal tenant', () => {
    // The conformance/admin key. It must not depend on the allowlist at all —
    // if a future refactor folds it into the tenant match, this reds.
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    const wildcard = { principal: { tenants: ['*'] } } as unknown as Request;
    expect(isSuperadmin(wildcard)).toBe(true);
  });

  it('a NON-wildcard bearer principal gets nothing from the principal branch alone', () => {
    // The other half, and the one that matters: `tenants: ['acme']` is a scoped
    // key (ADR 0561 made scoped the default). If the check ever loosens from
    // `includes('*')` to a truthy-tenants test, this reds and that one does not.
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    const scoped = { principal: { tenants: ['acme'] }, tenantId: 'acme' } as unknown as Request;
    expect(isSuperadmin(scoped)).toBe(false);
  });

  it('dev-open grants superadmin to any caller, and ONLY on the exact string "true"', () => {
    delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    expect(isSuperadmin(req('ws:7f3a9c10-0000-4000-8000-000000000001'))).toBe(true);
    // Not truthiness: a deploy that sets it to `1` or `yes` must stay closed,
    // because this switch is the one an operator audits by grepping for `true`.
    for (const v of ['1', 'yes', 'TRUE', '']) {
      process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = v;
      expect(isSuperadmin(req('ws:7f3a9c10-0000-4000-8000-000000000001')), `dev-open must not fire on ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('dev-open also widens the tenant-only check, which is where its blast radius is', () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    expect(isSuperadminTenant('ws:7f3a9c10-0000-4000-8000-000000000001')).toBe(true);
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'false';
    expect(isSuperadminTenant('ws:7f3a9c10-0000-4000-8000-000000000001')).toBe(false);
  });
});

describe('isSuperadminTenant — deliberately NOT widened', () => {
  it('answers about the tenant it is handed, with no personal-tenant branch', () => {
    // Its one caller (`host/approvalAudience.ts`) asks "is THIS tenant a
    // superadmin tenant" about a ROW's tenant — it has no caller identity to
    // guard by shape, so widening it would answer a different question.
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    expect(isSuperadminTenant(OPERATOR)).toBe(true);
    expect(isSuperadminTenant('ws:7f3a9c10-0000-4000-8000-000000000001')).toBe(false);
  });
});
