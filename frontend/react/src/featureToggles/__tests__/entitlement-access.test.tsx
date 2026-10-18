/**
 * ADR 0419 P3 — the feature-access `entitled` / `locked` signal. `enabled` stays
 * toggle-only; `locked` = toggle on AND the plan/bundles don't entitle it (a paid
 * feature not yet bought). Billing off / unrestricted plan ('*') ⇒ nothing locked.
 *
 * The first-load failure case is the ADR 0419 decision (lines 266-267): an HTTP
 * failure of the entitlement read degrades to '*' for PRESENTATION — the backend
 * paywall stays the authority. (A REFRESH failure is the D12 follow-up's concern,
 * pinned in offlineEntitlement.test.tsx.)
 *
 * Sabotage that turns it red: `locked: !entitled` (toggle-OFF case), dropping the
 * `'*'` arm of `isEntitled` (unrestricted case), `allowed.length > 0` for
 * `includes` (narrowed case), or degrading a failed read to `[]` (failure case).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
const { fetchAssignments, fetchEntitlements } = vi.hoisted(() => ({ fetchAssignments: vi.fn(), fetchEntitlements: vi.fn() }));
vi.mock('../../client/featureTogglesClient.js', () => ({ fetchAssignments, fetchEntitlements }));
vi.mock('../../client/config.js', () => ({ onAuthChange: () => () => {} }));
vi.mock('../../platform/telemetry.js', () => ({ telemetry: { reportError: vi.fn() } }));
import { FeatureAccessProvider, useFeatureAccess, useFeatureLocked } from '../FeatureAccessContext.js';

function Probe({ id }: { id: string }): JSX.Element {
  const a = useFeatureAccess(id);
  const isLocked = useFeatureLocked()(id);
  if (a.loading) return <div>loading</div>;
  return <div>{`enabled=${a.enabled} entitled=${a.entitled} locked=${a.locked} hook=${isLocked}`}</div>;
}
const view = (id: string) => render(<FeatureAccessProvider><Probe id={id} /></FeatureAccessProvider>);

beforeEach(() => {
  fetchAssignments.mockReset();
  fetchEntitlements.mockReset();
  // crm toggle ON by default
  fetchAssignments.mockResolvedValue({ assignments: [{ id: 'crm', status: 'on', enabled: true, variant: null }] });
});
afterEach(cleanup);

describe('feature-access entitlement signal (ADR 0419)', () => {
  it('unrestricted plan ("*") → entitled, never locked', async () => {
    fetchEntitlements.mockResolvedValue('*');
    view('crm');
    await waitFor(() => expect(screen.getByText(/enabled=true/)).toBeTruthy());
    expect(screen.getByText('enabled=true entitled=true locked=false hook=false')).toBeTruthy();
  });

  it('narrowed plan without the feature → LOCKED (toggle on, not entitled)', async () => {
    fetchEntitlements.mockResolvedValue(['billing']); // crm not entitled
    view('crm');
    await waitFor(() => expect(screen.getByText(/entitled=false/)).toBeTruthy());
    expect(screen.getByText('enabled=true entitled=false locked=true hook=true')).toBeTruthy();
  });

  it('toggle OFF → never locked even when not entitled', async () => {
    fetchAssignments.mockResolvedValue({ assignments: [{ id: 'crm', status: 'off', enabled: false, variant: null }] });
    fetchEntitlements.mockResolvedValue(['billing']);
    view('crm');
    await waitFor(() => expect(screen.getByText(/enabled=false/)).toBeTruthy());
    expect(screen.getByText('enabled=false entitled=false locked=false hook=false')).toBeTruthy();
  });

  it('entitlements failure degrades to unrestricted (never spuriously locks)', async () => {
    // The client's real failure shape (`ToggleAdminError` carries `status`).
    fetchEntitlements.mockRejectedValue(Object.assign(new Error('fetchEntitlements returned 503'), { status: 503 }));
    view('crm');
    await waitFor(() => expect(screen.getByText(/enabled=true/)).toBeTruthy());
    expect(screen.getByText('enabled=true entitled=true locked=false hook=false')).toBeTruthy();
  });
});
