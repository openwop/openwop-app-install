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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { useRef } from 'react';
const { fetchAssignments, fetchEntitlements } = vi.hoisted(() => ({ fetchAssignments: vi.fn(), fetchEntitlements: vi.fn() }));
vi.mock('../../client/featureTogglesClient.js', () => ({ fetchAssignments, fetchEntitlements }));
vi.mock('../../client/config.js', () => ({ onAuthChange: () => () => {} }));
vi.mock('../../platform/telemetry.js', () => ({ telemetry: { reportError: vi.fn() } }));
import { FeatureAccessProvider, useFeatureAccess } from '../FeatureAccessContext.js';
// The provider registers its own reloader on mount, so this test drives the real
// wiring end to end — it never registers a stub.
import { noteRequestStatus, __resetEntitlementRefreshForTest } from '../../client/entitlementRefresh.js';

/** Counts its own mounts via a ref that survives re-render but not remount. */
function MountCounter(): JSX.Element {
  const mounts = useRef(0);
  const a = useFeatureAccess('crm');
  if (mounts.current === 0) mounts.current = 1;
  // Mirrors EntitlementGuard: a busy placeholder replaces children while loading.
  if (a.loading) return <div>busy</div>;
  return <div>content</div>;
}

beforeEach(() => {
  fetchAssignments.mockReset();
  fetchEntitlements.mockReset();
  __resetEntitlementRefreshForTest();
  fetchAssignments.mockResolvedValue([{ id: 'crm', status: 'on', enabled: true, variant: null }]);
  fetchEntitlements.mockResolvedValue('*');
});
afterEach(() => cleanup());

describe('entitlement refresh does not unmount the page (UI-ENT-1b regression)', () => {
  it('a 403-triggered reload never flips back to the busy placeholder', async () => {
    render(<FeatureAccessProvider><MountCounter /></FeatureAccessProvider>);
    await waitFor(() => expect(screen.getByText('content')).toBeTruthy());

    // Make the REFRESH hang, so the window where `loading` would be true is
    // observable. With immediately-resolving mocks the transient busy state is
    // gone before any assertion runs — which made an earlier version of this
    // test pass with AND without the fix. Verified by sabotage.
    let releaseRefresh: (v: unknown) => void = () => {};
    fetchEntitlements.mockReturnValue(new Promise((r) => { releaseRefresh = r; }));

    // A 403 lands mid-session (this is what #2651 wired up).
    await act(async () => { noteRequestStatus(403); });

    // The load-bearing assertion, made WHILE the refresh is still in flight:
    // content STAYS. If the provider flips `loading` true on refresh, this is
    // 'busy' and the real guard would have unmounted the user's work.
    expect(screen.queryByText('busy')).toBeNull();
    expect(screen.getByText('content')).toBeTruthy();

    await act(async () => { releaseRefresh('*'); });
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('still shows busy on the FIRST resolution — the initial load is not silent', async () => {
    let resolveIt: (v: unknown) => void = () => {};
    fetchEntitlements.mockReturnValue(new Promise((r) => { resolveIt = r; }));
    render(<FeatureAccessProvider><MountCounter /></FeatureAccessProvider>);
    // Before the first resolution settles, busy is correct — there is no prior
    // answer to serve, so this is not the stale-while-revalidate case.
    expect(screen.getByText('busy')).toBeTruthy();
    await act(async () => { resolveIt('*'); });
    await waitFor(() => expect(screen.getByText('content')).toBeTruthy());
  });
});
