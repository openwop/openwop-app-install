import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerEntitlementReloader, noteRequestStatus, __resetEntitlementRefreshForTest } from '../entitlementRefresh.js';

/**
 * UI-ENT-1b — a mid-session 403 re-resolves entitlements so the EXISTING
 * `EntitlementGuard` can render the locked state, instead of the page showing a
 * generic error Notice and looking broken.
 *
 * The row claimed this "cannot fire in the reference host (nothing priced)".
 * That stopped being true at OPS-6: the demo sells three bundles in Stripe test
 * mode, so an entitlement CAN narrow while a page is open.
 */
beforeEach(() => { registerEntitlementReloader(null); __resetEntitlementRefreshForTest(); });

describe('entitlement refresh on 403 (UI-ENT-1b)', () => {
  it('reloads on 403', () => {
    const reload = vi.fn();
    registerEntitlementReloader(reload);
    noteRequestStatus(403);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does NOT reload on other statuses — including 401', () => {
    const reload = vi.fn();
    registerEntitlementReloader(reload);
    // 401 is authentication, not entitlement; re-resolving would be noise on
    // every signed-out request. 200/404/429/500 likewise.
    for (const s of [200, 201, 401, 404, 429, 500]) noteRequestStatus(s);
    expect(reload).not.toHaveBeenCalled();
  });

  it('is a no-op when no provider is mounted', () => {
    // Public/marketing routes render above the provider. A 403 there must not
    // throw — the seam is optional by design.
    expect(() => noteRequestStatus(403)).not.toThrow();
  });

  it('unregisters cleanly so an unmounted provider is never called', () => {
    const reload = vi.fn();
    registerEntitlementReloader(reload);
    registerEntitlementReloader(null);
    noteRequestStatus(403);
    expect(reload).not.toHaveBeenCalled();
  });

  it('coalesces a 403 STORM into one reload — the rate-limit fan-out guard', () => {
    // A 403 is not necessarily an ENTITLEMENT 403 (a superadmin-gated route
    // refuses identically), and each reload costs TWO network reads. Without a
    // floor, a surface that 403s repeatedly turns every refusal into three
    // requests — the exact fan-out that blows the per-IP read budget.
    const reload = vi.fn();
    registerEntitlementReloader(reload);
    for (let i = 0; i < 50; i += 1) noteRequestStatus(403);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
