/**
 * The Sidebar's Admin entry and AdminLayout's page gate both read
 * `isAdminCaller`. A pure superadmin (env-bound tenant, no org role) resolves
 * `basis:'none'` from membership — and until `/access/effective` projected
 * `superadmin`, the predicate hid the entry from the one caller every admin
 * route would have admitted.
 */
import { describe, expect, it } from 'vitest';
import { canManageOrgs, isAdminCaller } from '../useEffectiveAccess.js';

const none = { roles: [] as string[], scopes: [] as string[], basis: 'none' as const };

describe('isAdminCaller — superadmin projection', () => {
  it('admits a pure superadmin with no membership at all', () => {
    expect(isAdminCaller(none)).toBe(false);
    expect(isAdminCaller({ ...none, superadmin: true })).toBe(true);
  });
  it('an explicit false, or an older backend that omits the field, changes nothing', () => {
    expect(isAdminCaller({ ...none, superadmin: false })).toBe(false);
    expect(isAdminCaller({ roles: ['admin'], scopes: [], basis: 'member' })).toBe(true);
    expect(isAdminCaller({ roles: [], scopes: [], basis: 'tenant-owner' })).toBe(true);
  });
  it('canManageOrgs stays NARROWER on purpose — superadmin is admin chrome, not org-creation authority', () => {
    // The org-create CTA is gated on host:org:manage; a superadmin who lacks a
    // membership would be routed to a control the backend still refuses.
    expect(canManageOrgs({ ...none, superadmin: true })).toBe(false);
  });
});
