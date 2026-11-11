/**
 * ADR 1025 D5/D8 — merch rules and collections can be paused and activated from the
 * console. An agent's merch rule now arrives INACTIVE (a proposal); without an
 * Activate control it could never go live, and a live rule could only be deleted.
 *
 * Sabotages that turn it red: the status chip removed; the toggle sending the current
 * state instead of its inverse.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { MerchRule, Collection, Org } from '../discoveryClient.js';

const setRuleActive = vi.fn<(orgId: string, ruleId: string, active: boolean) => Promise<MerchRule>>();
const setCollectionActive = vi.fn<(orgId: string, collectionId: string, active: boolean) => Promise<Collection>>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../discoveryClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async (): Promise<Org[]> => [{ orgId: 'org-1', name: 'Acme' }]),
  listCollections: vi.fn(async (): Promise<Collection[]> => [{ collectionId: 'col-1', orgId: 'org-1', name: 'Staff picks', slug: 'staff-picks', type: 'manual', productIds: [], active: true, createdAt: '2026-07-09T00:00:00.000Z' }]),
  listRules: vi.fn(async (): Promise<MerchRule[]> => [{ ruleId: 'mrl-1', orgId: 'org-1', name: 'Hide clearance', scope: 'all', actions: [{ kind: 'hide', predicate: { categories: ['clearance'] } }], active: false, proposed: true }]),
  search: vi.fn(),
  createCollection: vi.fn(),
  deleteCollection: vi.fn(async () => {}),
  createRule: vi.fn(),
  deleteRule: vi.fn(async () => {}),
  setRuleActive: (o: string, r: string, a: boolean) => setRuleActive(o, r, a),
  setCollectionActive: (o: string, c: string, a: boolean) => setCollectionActive(o, c, a),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const confirmMock = vi.fn(async (_opts: unknown) => true);
vi.mock('../../../ui/confirm.js', () => ({ confirm: (o: unknown) => confirmMock(o) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }) }));

import { DiscoveryPage } from '../DiscoveryPage.js';

beforeEach(() => { setRuleActive.mockReset(); setCollectionActive.mockReset(); confirmMock.mockReset(); confirmMock.mockResolvedValue(true); });
afterEach(cleanup);

describe('ADR 1025 D5/D8 — activate and pause', () => {
  it('an agent proposal reads "Proposed by an agent", shows what it does, and activating a hide rule asks first', async () => {
    render(<DiscoveryPage />);
    await act(async () => {});
    expect(await screen.findByText('Proposed by an agent')).toBeTruthy();
    expect(screen.getByText('Hides clearance')).toBeTruthy();
    // Declined → nothing is sent.
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Activate Hide clearance' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(setRuleActive).not.toHaveBeenCalled();
    // Confirmed → active:true.
    fireEvent.click(screen.getByRole('button', { name: 'Activate Hide clearance' }));
    await waitFor(() => expect(setRuleActive).toHaveBeenCalledWith('org-1', 'mrl-1', true));
  });

  it('a live collection reads Active and Pause sends active:false', async () => {
    render(<DiscoveryPage />);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Staff picks' }));
    await waitFor(() => expect(setCollectionActive).toHaveBeenCalledWith('org-1', 'col-1', false));
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
  });
});
