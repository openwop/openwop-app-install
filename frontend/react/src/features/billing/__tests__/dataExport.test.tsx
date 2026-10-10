/**
 * ADR 0820 §7 — "your data stays, paid features pause": the export UI.
 *   - the locked page's "Export your data" button shows ONLY for an admin/owner
 *     (`host:billing:manage`) and only when the door lists the feature as
 *     plan-lapsed; a member never even asks the door;
 *   - Billing's "Your data" lists the exportable features (admin only) and a
 *     click downloads one through the client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const access = vi.hoisted(() => ({ current: { access: { basis: 'member', scopes: [] as string[] }, resolved: true } }));
const api = vi.hoisted(() => ({ listExportableFeatures: vi.fn(), downloadFeatureExport: vi.fn() }));
vi.mock('../dataExportClient.js', () => api);
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn(async () => ({ tenantId: 't', planTier: 'free', status: 'none' })),
  getBalance: vi.fn(async () => ({ tenantId: 't', purchasedTokensTotal: 0, totalAvailable: 0 })),
  getAiCredits: vi.fn(async () => ({ freeDaily: null, monthly: null, balanceCredits: 0, windowDays: 30, topFeatures: [], otherCredits: 0 })),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useEffectiveAccessState: () => access.current,
}));

// The lock page names the bundle (not for sale here, so no buy CTA): the export
// button rides the prompt module LockedState already loads (zero entry bytes).
vi.mock('../../marketplace/lockedUpsell.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadUpsellData: vi.fn(async () => ({})),
  resolveUpsell: vi.fn(() => ({ bundle: { id: 'marketing', label: 'Marketing', features: [] }, purchasable: false })),
}));
vi.mock('../../../platform/telemetry.js', () => ({ telemetry: { reportEvent: vi.fn() } }));

import { ExportDataButton } from '../ExportDataButton.js';
import { LockedState } from '../../../featureToggles/LockedState.js';
import { BillingPage } from '../BillingPage.js';

const ADMIN = { access: { basis: 'member', scopes: ['workspace:write', 'host:billing:manage'] }, resolved: true };
const EDITOR = { access: { basis: 'member', scopes: ['workspace:read', 'workspace:write'] }, resolved: true };
const LIST = [
  { featureId: 'funnels', label: 'Funnels', access: 'plan-lapsed' },
  { featureId: 'crm', label: 'CRM', access: 'entitled' },
];

beforeEach(() => {
  vi.clearAllMocks();
  access.current = ADMIN;
  api.listExportableFeatures.mockResolvedValue(LIST);
  api.downloadFeatureExport.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('locked page — Export your data', () => {
  it('an ADMIN on a plan-lapsed feature with an exporter sees the button, and it downloads', async () => {
    render(<ExportDataButton featureId="funnels" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export your data' }));
    await waitFor(() => expect(api.downloadFeatureExport).toHaveBeenCalledWith('funnels'));
  });

  it('a MEMBER (no host:billing:manage) never sees it and the door is never asked', async () => {
    access.current = EDITOR;
    render(<ExportDataButton featureId="funnels" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Export your data' })).toBeNull();
    expect(api.listExportableFeatures).not.toHaveBeenCalled();
  });

  it('a feature with no registered exporter shows nothing', async () => {
    render(<ExportDataButton featureId="slides" />);
    await waitFor(() => expect(api.listExportableFeatures).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Export your data' })).toBeNull();
  });

  it('a feature that is not plan-lapsed (entitled) shows nothing on a lock page', async () => {
    render(<ExportDataButton featureId="crm" />);
    await waitFor(() => expect(api.listExportableFeatures).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Export your data' })).toBeNull();
  });
});

describe('LockedState (the plan-lock page) mounts the export button', () => {
  it('an ADMIN on a plan-locked feature with an exporter gets "Export your data"', async () => {
    render(<MemoryRouter><LockedState featureId="funnels" /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: 'Export your data' })).toBeTruthy();
  });

  it('a MEMBER on the same lock gets no button', async () => {
    access.current = EDITOR;
    render(<MemoryRouter><LockedState featureId="funnels" /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('button', { name: 'Export your data' })).toBeNull();
  });
});

describe('Billing — Your data', () => {
  const at = () => render(<MemoryRouter initialEntries={['/billing']}><BillingPage /></MemoryRouter>);

  it('an ADMIN sees the exportable features, the paused one marked, and each downloads', async () => {
    at();
    expect(await screen.findByRole('heading', { name: 'Your data' })).toBeTruthy();
    expect(screen.getByText('Funnels')).toBeTruthy();
    expect(screen.getByText('Paused — plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export your CRM data' }));
    await waitFor(() => expect(api.downloadFeatureExport).toHaveBeenCalledWith('crm'));
  });

  it('a MEMBER gets no "Your data" panel', async () => {
    access.current = EDITOR;
    at();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: 'Your data' })).toBeNull();
    expect(api.listExportableFeatures).not.toHaveBeenCalled();
  });
});
