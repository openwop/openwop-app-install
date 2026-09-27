/**
 * UX_UPGRADE-production ROUND 3 — PROD2-M3.
 *
 * Clearing Region (or Notes) on the vendor EDIT form used to be a silent no-op
 * behind a "Vendor updated" toast: the client omitted emptied fields from the
 * patch, and the route only patches keys that are present. The server's clear
 * signal is `null` (`optField` deletes on null — verified at the service).
 * The edit form now sends `null` for a cleared field; CREATE still omits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

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

const ON = { status: 'on', enabled: true, isBeta: false, variant: null, entitled: true, locked: false, loading: false };
const VENDOR = {
  vendorId: 'v1', tenantId: 't', orgId: 'org1', type: 'agency', name: 'Acme Films',
  region: 'EMEA', notes: 'Fast turnaround', contractStatus: 'active',
  capabilities: [], priceRanges: [], pastProjects: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  useFeatureAccess.mockReturnValue(ON);
  listOrgs.mockResolvedValue([{ orgId: 'org1', name: 'Org One' }]);
  listVendors.mockResolvedValue([VENDOR]);
  listPlans.mockResolvedValue([]);
  updateVendor.mockResolvedValue(VENDOR);
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
    await waitFor(() => expect(updateVendor).toHaveBeenCalled());
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
});
