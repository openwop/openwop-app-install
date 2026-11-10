/**
 * ADR 1034 D9 — the partner link is a credential an outsider uses, so issuing and revoking
 * it are manager acts (`host:dealers:manage`). An editor used to see "Issue partner link"
 * and could mint one; there was no revoke at all, and the link never expired.
 *
 * Red when: the issue or revoke control is shown without the manage scope; revoke fires
 * without a confirm, or is not the full call (org, dealer); the expiry is not shown with
 * a freshly issued link (the exact date, not just the sentence).
 * grade-tests w88: the expiry used to be matched by its prefix only, so a wrong date passed;
 * the editor case now waits for the access read to settle before asserting absence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Dealer } from '../dealersClient.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

type DealersApi = typeof import('../dealersClient.js');
type AccessApi = typeof import('../../../client/accessClient.js');
type ConfirmApi = typeof import('../../../ui/confirm.js');
const listDealers = vi.fn<DealersApi['listDealers']>();
const mintPortalToken = vi.fn<DealersApi['mintPortalToken']>();
const revokePortalToken = vi.fn<DealersApi['revokePortalToken']>();
const getEffectiveAccess = vi.fn<AccessApi['getEffectiveAccess']>();
const confirmMock = vi.fn<ConfirmApi['confirm']>();

vi.mock('../dealersClient.js', async (orig) => ({
  ...(await orig<DealersApi>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  listDealers: (orgId: string) => listDealers(orgId),
  listCompanies: vi.fn(async () => []),
  listOutlets: vi.fn(async () => []),
  listRegistrations: vi.fn(async () => []),
  mintPortalToken: (orgId: string, dealerId: string) => mintPortalToken(orgId, dealerId),
  revokePortalToken: (orgId: string, dealerId: string) => revokePortalToken(orgId, dealerId),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<AccessApi>()),
  getEffectiveAccess: (o: Parameters<AccessApi['getEffectiveAccess']>[0]) => getEffectiveAccess(o),
}));
vi.mock('../../../ui/confirm.js', async (orig) => ({
  ...(await orig<ConfirmApi>()),
  confirm: (o: Parameters<ConfirmApi['confirm']>[0]) => confirmMock(o),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess(),
}));

import { DealersPage } from '../DealersPage.js';

const DEALER: Dealer = { dealerId: 'd1', companyId: 'c1', name: 'North Motors', tier: 'gold', status: 'active', updatedAt: '2026-07-01T00:00:00.000Z' };
const view = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/dealers?org=org-1&dealer=d1']}><DealersPage /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(listDealers).toHaveBeenCalled());
  await screen.findByRole('heading', { name: 'North Motors' });
  await act(async () => {});
};
const scopes = (s: string[]) => getEffectiveAccess.mockResolvedValue({ roles: [], scopes: s, basis: 'member' });

beforeEach(() => {
  for (const m of [listDealers, mintPortalToken, revokePortalToken, getEffectiveAccess, confirmMock]) m.mockReset();
  listDealers.mockResolvedValue([DEALER]);
  mintPortalToken.mockResolvedValue({ token: 'ptoken:x', url: 'https://app.test/partner/ptoken:x', expiresAt: '2027-05-14T12:00:00.000Z' }); // mid-day UTC: the same calendar day in every runner zone
  revokePortalToken.mockResolvedValue();
  confirmMock.mockResolvedValue(true);
});
afterEach(cleanup);

describe('ADR 1034 D9 — partner link controls', () => {
  it('an editor (no manage scope) is offered neither issue nor revoke', async () => {
    scopes(['workspace:read', 'workspace:write']);
    await view();
    // The access read has SETTLED (has() is false while loading, so absence alone proves nothing).
    await waitFor(() => expect(getEffectiveAccess).toHaveBeenCalledWith({ orgId: 'org-1' }));
    await act(async () => {});
    // Positive anchor: the dealer's own controls rendered.
    expect(screen.getByRole('button', { name: /suspend/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /issue partner link/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /revoke partner link/i })).toBeNull();
  });

  it('a manager issues a link and sees when it stops working', async () => {
    scopes(['workspace:read', 'workspace:write', 'host:dealers:manage']);
    await view();
    fireEvent.click(await screen.findByRole('button', { name: /issue partner link/i }));
    await waitFor(() => expect(mintPortalToken).toHaveBeenCalledWith('org-1', 'd1'));
    expect(await screen.findByText(/It stops working on May 14, 2027\./)).toBeTruthy();
    expect(screen.getByText('https://app.test/partner/ptoken:x')).toBeTruthy();
  });

  it('revoke is confirmed, then revokes this dealer’s link in this org', async () => {
    scopes(['workspace:read', 'workspace:write', 'host:dealers:manage']);
    await view();
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByRole('button', { name: /revoke partner link/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(revokePortalToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /revoke partner link/i }));
    await waitFor(() => expect(revokePortalToken).toHaveBeenCalledWith('org-1', 'd1'));
    expect(revokePortalToken).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls.map((c) => c[0]?.danger)).toEqual([true, true]);
  });
});
