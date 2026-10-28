/**
 * ADR 0969 D3 — the MFA requirement removes admin SURFACES, never FEATURES.
 *
 * With `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`, a single-factor operator is not
 * `isSuperadmin`, but the plan-paywall exemption reads `isListedSuperadmin` on
 * purpose (ADR 0419: the operator has every feature on their own host, in any
 * workspace they act in). A refactor that routed `requireEntitledFeature`
 * through `isSuperadmin` would silently paywall the operator whenever their
 * session lacks a second factor.
 *
 * Billing is forced ON here and the plan is forced to allow NOTHING, so the
 * superadmin early return is the only way the call can succeed.
 *
 * Sabotage-witnessed (2026-10-23): swapping `isListedSuperadmin` for
 * `isSuperadmin` in `entitlementGuard.ts` turns this red.
 */
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/featureToggles/service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/host/featureToggles/service.js')>()),
  resolveToggle: vi.fn(async () => ({ enabled: true })),
}));
vi.mock('../src/features/billing/billingService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/billing/billingService.js')>()),
  resolveEntitlements: vi.fn(async () => ({ plan: 'free', allowedFeatures: [], limits: {} })),
}));

const { requireEntitledFeature } = await import('../src/features/billing/entitlementGuard.js');
const { isSuperadmin } = await import('../src/host/superadmin.js');

const OPERATOR = 'user:abc123';
/** A single-factor person session for the operator, acting in a CUSTOMER's workspace. */
const singleFactorOperator = {
  tenantId: 'ws:7f3a9c10-0000-4000-8000-000000000001',
  personalTenant: OPERATOR,
  principal: { principalId: 'user:u1', tenants: ['ws:7f3a9c10-0000-4000-8000-000000000001'], token: '', auth: { kind: 'subject' } },
} as unknown as Request;
const customer = {
  tenantId: 't-customer', personalTenant: 't-customer',
  principal: { principalId: 'user:c1', tenants: ['t-customer'], token: '', auth: { kind: 'subject' } },
} as unknown as Request;

afterEach(() => {
  delete process.env.OPENWOP_SUPERADMIN_TENANTS;
  delete process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA;
});

describe('ADR 0969 — the paywall exemption ignores the MFA requirement', () => {
  it('a single-factor operator is not superadmin, yet keeps every feature', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    expect(isSuperadmin(singleFactorOperator)).toBe(false);
    await expect(requireEntitledFeature(singleFactorOperator, 'webinars')).resolves.toBeUndefined();
  });

  it('control: the same forced-closed plan refuses an ordinary customer (the mock really paywalls)', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = OPERATOR;
    process.env.OPENWOP_SUPERADMIN_REQUIRE_MFA = 'true';
    await expect(requireEntitledFeature(customer, 'webinars')).rejects.toMatchObject({ httpStatus: 403 });
  });
});
