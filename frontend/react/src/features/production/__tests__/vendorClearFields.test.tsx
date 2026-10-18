/**
 * UX_UPGRADE-production ROUND 3 — PROD2-M3.
 *
 * Clearing Region (or Notes) on the vendor EDIT form used to be a silent no-op
 * behind a "Vendor updated" toast: the client omitted emptied fields from the
 * patch, and the route only patches keys that are present. The server's clear
 * signal is `null` (`optField` deletes on null — verified at the service).
 * The edit form now sends `null` for a cleared field; CREATE still omits.
 *
 * w32 (grade-tests): the CREATE-omits half and the Notes field were never
 * exercised (both probes vacuous); each now has a case. The fixture is a typed
 * `Vendor` (it was `as never`, carrying a `tenantId` the client type does not have
 * and missing `portfolioAssetTokens`), and feature access comes from
 * `makeFeatureAccess()`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { Vendor } from '../productionClient.js';

const { listOrgs, listVendors, listPlans, updateVendor, createVendor, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listVendors: vi.fn(), listPlans: vi.fn(), updateVendor: vi.fn(), createVendor: vi.fn(), useFeatureAccess: vi.fn(),
}));

vi.mock('../productionClient.js', async (orig) => ({
  ...(await orig<typeof import('../productionClient.js')>()),
  listOrgs, listVendors, listPlans, updateVendor, createVendor,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess,
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MemoryRouter } from 'react-router-dom';
import { ProductionPage } from '../ProductionPage.js';

const VENDOR: Vendor = {
  vendorId: 'v1', orgId: 'org1', type: 'agency', name: 'Acme Films',
  region: 'EMEA', notes: 'Fast turnaround', contractStatus: 'active',
  capabilities: [], priceRanges: [], pastProjects: [], portfolioAssetTokens: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureAccess.mockReturnValue(makeFeatureAccess());
  listOrgs.mockResolvedValue([{ orgId: 'org1', name: 'Org One' }]);
  listVendors.mockResolvedValue([VENDOR]);
  listPlans.mockResolvedValue([]);
  updateVendor.mockResolvedValue(VENDOR);
  createVendor.mockResolvedValue(VENDOR);
});
afterEach(cleanup);

const openEdit = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/production']}><ProductionPage /></MemoryRouter>);
  await act(async () => {});
  await screen.findByText('Acme Films');
  fireEvent.click(screen.getByRole('button', { name: /edit/i }));
  await screen.findByDisplayValue('EMEA');
};

describe('PROD2-M3 — clearing a field on edit CLEARS it, and keeping it keeps it', () => {
  it('a cleared Region reaches the server as null (the clear signal), not as an omission', async () => {
    await openEdit();
    fireEvent.change(screen.getByDisplayValue('EMEA'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updateVendor).toHaveBeenCalledTimes(1));
    expect(updateVendor.mock.calls[0]!.slice(0, 2)).toEqual(['org1', 'v1']);
    const payload = updateVendor.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload.region).toBeNull();          // cleared ⇒ null (server deletes)
    expect(payload.notes).toBe('Fast turnaround'); // untouched ⇒ still sent with its value
  });

  it('an untouched edit keeps both fields verbatim — no accidental clears', async () => {
    await openEdit();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updateVendor).toHaveBeenCalled());
    const payload = updateVendor.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload.region).toBe('EMEA');
    expect(payload.notes).toBe('Fast turnaround');
  });

  it('a cleared Notes reaches the server as null too', async () => {
    await openEdit();
    fireEvent.change(screen.getByDisplayValue('Fast turnaround'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(updateVendor).toHaveBeenCalledTimes(1));
    const payload = updateVendor.mock.calls[0]![2] as Record<string, unknown>;
    expect(payload.notes).toBeNull();
    expect(payload.region).toBe('EMEA');
  });

  it('CREATE omits empty Region/Notes — null is the EDIT-only clear signal', async () => {
    render(<MemoryRouter initialEntries={['/production']}><ProductionPage /></MemoryRouter>);
    await act(async () => {});
    await screen.findByText('Acme Films');
    fireEvent.click(screen.getByRole('button', { name: /add vendor/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Brand New Co' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(createVendor).toHaveBeenCalledTimes(1));
    expect(createVendor.mock.calls[0]![0]).toBe('org1');
    const payload = createVendor.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.name).toBe('Brand New Co');
    expect('region' in payload, 'no region key on create').toBe(false);
    expect('notes' in payload, 'no notes key on create').toBe(false);
    expect(updateVendor).not.toHaveBeenCalled();
  });
});
