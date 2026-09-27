/**
 * MKT-UX-3 / MKT-UX-7 / MKT-UX-12 — the operator gate the operator could not
 * reach, the refusal with no reason and no exit, and the retry window that lied.
 *
 * MKT-UX-3. `ApprovalQueueCard` and `AdminConsoleCard` mounted only PAST
 * `CommerceConnectPage`'s `if (!seller) return`, so a host superadmin whose own
 * tenant had never onboarded as a Stripe Express seller saw only "Become a
 * seller" and had NO path to the approval queue, the cross-tenant order list,
 * the refund action, the dispute ledger or the realized platform loss. The
 * generic approvals inbox is not a fallback by design (`host/reviewProjection.ts`
 * routes this kind to the dedicated queue and `ApprovalsInbox` has no branch for
 * it). Net effect on a host whose operator is not also a seller: every
 * native-paid listing sat at "Awaiting approval" forever.
 *
 * The refusal half matters as much as the reach half — mounting the cards must
 * not expose them to a non-operator. The backend 403 is the authority; the cards
 * self-hide on it. Both directions are asserted.
 *
 * MKT-UX-7. The decide route parsed `{ decision }` only, so "Rejected" was the
 * entire feedback and no reason existed ANYWHERE in the system. The seller's only
 * exit was retyping the exact pack id into a free-text field.
 *
 * MKT-UX-12. `SellerListingsCard.load` cleared `rowsFailed` synchronously while
 * `rows` still held the `[]` from the previous `catch`, so between a Retry click
 * and the settle the seller's own inventory read "No listings yet" over stale
 * failed data. The existing pinning test cannot discriminate it — `findByText`
 * awaits past the window — so this one holds the promise open instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

/** `CommerceConnectPage` reads `?onboarding=…` via `useSearchParams`. */
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const api = vi.hoisted(() => ({
  getSellerAccount: vi.fn(),
  getSellerStats: vi.fn(),
  syncSellerAccount: vi.fn(),
  listApprovals: vi.fn(),
  decideApproval: vi.fn(),
  listAdminOrders: vi.fn(),
  listAdminDisputes: vi.fn(),
  listOwnListings: vi.fn(),
}));
vi.mock('../commerceConnectClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

import { ApiError } from '../commerceConnectClient.js';
import { CommerceConnectPage } from '../CommerceConnectPage.js';
import { SellerListingsCard } from '../SellerListingsCard.js';

const APPROVAL = {
  approvalId: 'apr_1', packName: 'vendor.acme.nodes', lane: 'native-paid' as const,
  proposal: 'Approve marketplace listing', createdAt: '2026-01-01T00:00:00Z',
  priceMajorUnits: 99, currency: 'usd', sellerTenantId: 'ws:acme', packMissing: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listOwnListings.mockResolvedValue([]);
  api.listAdminOrders.mockResolvedValue([]);
  api.listAdminDisputes.mockResolvedValue({ disputes: [], platformLossMajorUnitsByCurrency: {} });
});
afterEach(cleanup);

describe('MKT-UX-3 — the operator can reach the approval gate without being a seller', () => {
  it('a NON-SELLER superadmin sees the approval queue and the operator console', async () => {
    api.getSellerAccount.mockResolvedValue(null); // never onboarded
    api.listApprovals.mockResolvedValue([APPROVAL]);

    render(<CommerceConnectPage />);

    // The onboarding CTA is still there — that is correct for their own tenant.
    expect(await screen.findByText(/become a seller/i)).toBeTruthy();
    // And so is the gate they are the only person who can operate.
    expect(await screen.findByText(/vendor\.acme\.nodes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeTruthy();
  });

  it('a superadmin whose ACCOUNT READ FAILED still reaches the queue', async () => {
    // The other early return. A network blip on an unrelated read must not take
    // the platform's only approval surface down with it.
    api.getSellerAccount.mockRejectedValue(new Error('seller_500'));
    api.listApprovals.mockResolvedValue([APPROVAL]);
    render(<CommerceConnectPage />);
    expect(await screen.findByText(/could not load your seller account/i)).toBeTruthy();
    expect(await screen.findByText(/vendor\.acme\.nodes/)).toBeTruthy();
  });

  it('a NON-OPERATOR sees nothing extra — the backend 403 is still the authority', async () => {
    // The refusal direction. Mounting the cards must not widen who can see them.
    api.getSellerAccount.mockResolvedValue(null);
    api.listApprovals.mockRejectedValue(new ApiError('forbidden', 403));
    api.listAdminOrders.mockRejectedValue(new ApiError('forbidden', 403));
    api.listAdminDisputes.mockRejectedValue(new ApiError('forbidden', 403));

    render(<CommerceConnectPage />);
    expect(await screen.findByText(/become a seller/i)).toBeTruthy();
    await waitFor(() => expect(api.listApprovals).toHaveBeenCalled());
    expect(screen.queryByText(/approval queue/i)).toBeNull();
    expect(screen.queryByText(/operator console/i)).toBeNull();
  });
});

describe('MKT-UX-7 — a rejection carries a reason, and the seller gets an exit', () => {
  it('Reject opens a required-reason field; the decision cannot be sent without one', async () => {
    api.getSellerAccount.mockResolvedValue(null);
    api.listApprovals.mockResolvedValue([APPROVAL]);
    render(<CommerceConnectPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    const box = await screen.findByRole('textbox');
    // The affirmative is disabled while the reason is empty — and, critically,
    // NOTHING was sent by opening the form.
    expect(screen.getByRole('button', { name: /reject listing/i }).hasAttribute('disabled')).toBe(true);
    expect(api.decideApproval).not.toHaveBeenCalled();

    api.decideApproval.mockResolvedValue(undefined);
    fireEvent.change(box, { target: { value: 'The payout URL is not on your verified domain.' } });
    fireEvent.click(screen.getByRole('button', { name: /reject listing/i }));

    await waitFor(() => expect(api.decideApproval).toHaveBeenCalledWith(
      'apr_1', 'rejected', 'The payout URL is not on your verified domain.',
    ));
  });

  it('the SELLER reads the reason on their own row, and can revise and resubmit', async () => {
    api.listOwnListings.mockResolvedValue([{
      packName: 'vendor.acme.nodes', sellerTenantId: 'ws:acme', lane: 'native-paid',
      priceMajorUnits: 99, currency: 'usd', approvalState: 'rejected',
      approvalNote: 'The payout URL is not on your verified domain.',
      createdAt: 'x', updatedAt: 'x',
    }]);
    render(<SellerListingsCard />);

    expect(await screen.findByText(/payout URL is not on your verified domain/i)).toBeTruthy();
    // The exit: the editor is pre-filled rather than requiring the pack id retyped.
    fireEvent.click(screen.getByRole('button', { name: /revise and resubmit/i }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText('vendor.example.nodes') as HTMLInputElement).value).toBe('vendor.acme.nodes');
    });
  });

  it('a rejection with NO reason still says so, rather than showing a bare word', async () => {
    // Pre-fix rows carry no note. "Rejected" alone was the whole defect, so the
    // absent case must not silently degrade back to it.
    api.listOwnListings.mockResolvedValue([{
      packName: 'vendor.old.nodes', sellerTenantId: 'ws:acme', lane: 'native-paid',
      priceMajorUnits: 10, currency: 'usd', approvalState: 'rejected', createdAt: 'x', updatedAt: 'x',
    }]);
    render(<SellerListingsCard />);
    expect(await screen.findByText(/without recording a reason/i)).toBeTruthy();
  });
});

describe('MPL-11 — a SUSPENDED listing is visible to its own seller as suspended', () => {
  it('renders the hold chip and the operator reason', async () => {
    api.listOwnListings.mockResolvedValue([{
      packName: 'vendor.held.nodes', sellerTenantId: 'ws:acme', lane: 'native-paid',
      priceMajorUnits: 20, currency: 'usd', approvalState: 'approved',
      state: 'suspended', stateMeta: { by: 'op', at: 'x', reason: 'Dispute under review' },
      createdAt: 'x', updatedAt: 'x',
    }]);
    render(<SellerListingsCard />);
    expect(await screen.findByText(/on hold/i)).toBeTruthy();
    expect(screen.getByText(/dispute under review/i)).toBeTruthy();
  });
});

describe('MKT-UX-12 — the retry window never claims "no listings yet" over stale data', () => {
  it('shows the loading state, not the empty claim, WHILE the refetch is in flight', async () => {
    api.listOwnListings.mockRejectedValue(new Error('listings_500'));
    render(<SellerListingsCard />);
    expect(await screen.findByText(/couldn.t be loaded/i)).toBeTruthy();

    // Hold the retry open — this is the window the existing pinning test awaits
    // past, and therefore cannot see.
    let settle: (v: unknown[]) => void = () => {};
    api.listOwnListings.mockReturnValue(new Promise((r) => { settle = r as (v: unknown[]) => void; }));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.queryByText(/couldn.t be loaded/i)).toBeNull());
    expect(
      screen.queryByText(/no listings yet/i),
      'a seller mid-retry must never be told their inventory is empty',
    ).toBeNull();

    settle([]);
    expect(await screen.findByText(/no listings yet/i)).toBeTruthy();
  });
});
