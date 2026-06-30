/**
 * DATA-2 (CODEBASE-ASSESSMENT.md): the shared tenant-isolation primitives.
 * assertTenantOwned is a load-or-404 IDOR guard — a cross-tenant resource and
 * an absent resource are INDISTINGUISHABLE to the caller (both 404), so an id's
 * existence in another tenant never leaks.
 */
import { describe, it, expect } from 'vitest';
import { tenantOf, assertTenantOwned, type TenantScopedRequest } from '../src/host/tenantGuard.js';
import { OpenwopError } from '../src/types.js';

const reqFor = (tenantId?: string): TenantScopedRequest => ({ tenantId });

describe('tenantOf', () => {
  it('returns the principal-derived tenant', () => {
    expect(tenantOf(reqFor('tenant-a'))).toBe('tenant-a');
  });
  it('defaults when unset', () => {
    expect(tenantOf(reqFor(undefined))).toBe('default');
  });
});

describe('assertTenantOwned', () => {
  it('returns the resource when it belongs to the caller tenant', () => {
    const res = { id: '1', tenantId: 'tenant-a', name: 'x' };
    expect(assertTenantOwned(res, reqFor('tenant-a'))).toBe(res);
  });

  it('throws 404 for a cross-tenant resource (no existence leak)', () => {
    const res = { id: '1', tenantId: 'tenant-b' };
    let err: unknown;
    try { assertTenantOwned(res, reqFor('tenant-a'), 'board'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OpenwopError);
    expect((err as OpenwopError).httpStatus).toBe(404);
  });

  it('throws the SAME 404 for an absent resource (indistinguishable)', () => {
    let err: unknown;
    try { assertTenantOwned(null, reqFor('tenant-a'), 'board'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OpenwopError);
    expect((err as OpenwopError).httpStatus).toBe(404);
  });
});
