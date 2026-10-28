/**
 * DATA-2 (docs/steward/CODEBASE-ASSESSMENT.md): the shared tenant-isolation primitives.
 * assertTenantOwned is a load-or-404 IDOR guard — a cross-tenant resource and
 * an absent resource are INDISTINGUISHABLE to the caller (both 404), so an id's
 * existence in another tenant never leaks. What breaks it: dropping the tenant
 * comparison (a cross-tenant row is returned), or a refusal whose code, message
 * or details differ between the two cases (an existence oracle).
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

  /** The refusal as the caller sees it: every field a response could carry. */
  function refusal(resource: { id: string; tenantId: string } | null): { code: string; message: string; httpStatus: number; details: unknown } {
    try {
      assertTenantOwned(resource, reqFor('tenant-a'), 'board');
    } catch (e) {
      expect(e).toBeInstanceOf(OpenwopError);
      if (e instanceof OpenwopError) return { code: e.code, message: e.message, httpStatus: e.httpStatus, details: e.details };
    }
    throw new Error('assertTenantOwned did not throw');
  }

  it('throws 404 for a cross-tenant resource (no existence leak)', () => {
    expect(refusal({ id: '1', tenantId: 'tenant-b' })).toEqual({ code: 'not_found', message: 'board not found', httpStatus: 404, details: {} });
  });

  it('throws the SAME 404 for an absent resource (indistinguishable)', () => {
    const absent = refusal(null);
    expect(absent).toEqual({ code: 'not_found', message: 'board not found', httpStatus: 404, details: {} });
    // Field by field the same as the cross-tenant refusal: no message, code or
    // detail tells "exists in another tenant" apart from "does not exist".
    expect(absent).toEqual(refusal({ id: '1', tenantId: 'tenant-b' }));
  });
});
