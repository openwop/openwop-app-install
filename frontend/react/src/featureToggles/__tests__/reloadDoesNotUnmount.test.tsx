/**
 * UI-ENT-1b regression — a mid-session entitlement REFRESH must not unmount the
 * page the user is on.
 *
 * `EntitlementGuard` renders a busy placeholder while `loading`, which unmounts
 * its children. The provider used to set `loading = true` on EVERY resolution,
 * including a background refresh — so after #2651 wired a 403 to `reload()`, any
 * 403 anywhere in the app (a legitimately-forbidden superadmin route, not just an
 * entitlement one) destroyed and remounted the user's current page, losing form
 * input, editor content, scroll position and open modals.
 *
 * That is worse than the generic error Notice it replaced, which at least left
 * the user's work on screen. Stale-while-revalidate: keep serving the previous
 * answer until the new one lands.
 *
 * Runs the REAL provider and the REAL `EntitlementGuard` (wave 50: an earlier
 * version re-implemented the guard in the test, and never checked that the
 * reload actually fired — so an unwired reloader passed). The page counts its
 * own mounts in an effect, so a remount is a number, not an inference.
 *
 * Sabotage that turns it red: `if (!settledOnce.current) setLoading(true)` →
 * unconditional (case 1); never setting `settledOnce` (case 1); not registering
 * the reloader (case 1, via the in-flight call count); the hook's fallback
 * answering `loading: false` before the first resolution (case 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { useEffect } from 'react';
const { fetchAssignments, fetchEntitlements } = vi.hoisted(() => ({ fetchAssignments: vi.fn(), fetchEntitlements: vi.fn() }));
vi.mock('../../client/featureTogglesClient.js', () => ({ fetchAssignments, fetchEntitlements }));
vi.mock('../../client/config.js', () => ({ onAuthChange: () => () => {} }));
vi.mock('../../platform/telemetry.js', () => ({ telemetry: { reportError: vi.fn(), reportEvent: vi.fn() } }));
import { FeatureAccessProvider } from '../FeatureAccessContext.js';
import { EntitlementGuard } from '../EntitlementGuard.js';
// The provider registers its own reloader on mount, so this test drives the real
// wiring end to end — it never registers a stub.
import { noteRequestStatus, __resetEntitlementRefreshForTest } from '../../client/entitlementRefresh.js';

/** How many times the guarded page has MOUNTED (an unmount + remount adds one). */
let mounts = 0;
function Page(): JSX.Element {
  useEffect(() => { mounts += 1; }, []);
  return <div>content</div>;
}
const view = () => render(
  <FeatureAccessProvider><EntitlementGuard featureId="crm"><Page /></EntitlementGuard></FeatureAccessProvider>,
);

beforeEach(() => {
  mounts = 0;
  fetchAssignments.mockReset();
  fetchEntitlements.mockReset();
  __resetEntitlementRefreshForTest();
  fetchAssignments.mockResolvedValue({ assignments: [{ id: 'crm', status: 'on', enabled: true, variant: null }] });
  fetchEntitlements.mockResolvedValue('*');
});
afterEach(() => cleanup());

describe('entitlement refresh does not unmount the page (UI-ENT-1b regression)', () => {
  it('a 403-triggered reload never flips back to the busy placeholder', async () => {
    view();
    await waitFor(() => expect(screen.getByText('content')).toBeTruthy());
    expect(mounts).toBe(1);

    // Make the REFRESH hang, so the window where `loading` would be true is
    // observable. With immediately-resolving mocks the transient busy state is
    // gone before any assertion runs — which made an earlier version of this
    // test pass with AND without the fix. Verified by sabotage.
    let releaseRefresh: (v: '*') => void = () => {};
    fetchEntitlements.mockReturnValue(new Promise<'*'>((r) => { releaseRefresh = r; }));

    // A 403 lands mid-session (this is what #2651 wired up).
    await act(async () => { noteRequestStatus(403); });
    // The refresh IS in flight — otherwise everything below passes by default.
    expect(fetchEntitlements).toHaveBeenCalledTimes(2);

    // The load-bearing assertions, made WHILE the refresh is still in flight:
    // no busy placeholder, the page is still the one that mounted first.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('content')).toBeTruthy();
    expect(mounts).toBe(1);

    await act(async () => { releaseRefresh('*'); });
    expect(screen.getByText('content')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  it('still shows busy on the FIRST resolution — the initial load is not silent', async () => {
    let resolveIt: (v: '*') => void = () => {};
    fetchEntitlements.mockReturnValue(new Promise<'*'>((r) => { resolveIt = r; }));
    view();
    // Before the first resolution settles, busy is correct — there is no prior
    // answer to serve, so this is not the stale-while-revalidate case.
    expect(screen.getByRole('status')).toBeTruthy();
    expect(mounts).toBe(0);
    await act(async () => { resolveIt('*'); });
    await waitFor(() => expect(screen.getByText('content')).toBeTruthy());
    expect(mounts).toBe(1);
  });
});
