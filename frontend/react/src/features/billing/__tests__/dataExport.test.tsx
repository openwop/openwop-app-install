/**
 * ADR 0820 §7 — "your data stays, paid features pause": the export UI.
 *   - the locked page's "Export your data" button shows ONLY for an admin/owner
 *     (`host:billing:manage`) and only when the door lists the feature as
 *     plan-lapsed; a member never even asks the door;
 *   - Billing's "Your data" lists the exportable features (admin only) and a
 *     click downloads one through the client.
 *
 * DOUBLE GUARD (named, by design): ExportDataButton hides from a non-manager
 * twice — its effect never asks the door, AND its render returns null. Removing
 * either alone stays green (wave 52 `de-lockedmember`); the shared piece both read,
 * `useScopeWriteAccess(BILLING_MANAGE_SCOPE)`, is what the member cases witness.
 * Absence is asserted only after a settle signal (a positive control rendered from
 * the same list, the lock prompt's own copy, the page's member text plus the lazy
 * chunk) — never while a read or chunk is still pending.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { ExportableFeature, listExportableFeatures, downloadFeatureExport } from '../dataExportClient.js';
import type { Subscription, TokenBalance, AiCreditMeter } from '../billingClient.js';

const access = vi.hoisted(() => ({ current: { access: { basis: 'member', scopes: [] as string[] }, resolved: true } }));
const api = vi.hoisted(() => ({ listExportableFeatures: vi.fn<typeof listExportableFeatures>(), downloadFeatureExport: vi.fn<typeof downloadFeatureExport>() }));
vi.mock('../dataExportClient.js', () => api);
vi.mock('../billingClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSubscription: vi.fn(async (): Promise<Subscription> => ({ tenantId: 't', planTier: 'free', status: 'none' })),
  getBalance: vi.fn(async (): Promise<TokenBalance> => ({ tenantId: 't', purchasedTokensTotal: 0, totalAvailable: 0 })),
  getAiCredits: vi.fn(async (): Promise<AiCreditMeter> => ({ freeDaily: null, monthly: null, balanceCredits: 0, windowDays: 30, topFeatures: [], otherCredits: 0 })),
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
const LIST: ExportableFeature[] = [
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

/** Let a synchronous mount effect (and anything it started) settle. */
const drain = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); });
};

describe('locked page — Export your data', () => {
  it('an ADMIN on a plan-lapsed feature with an exporter sees the button, and it downloads', async () => {
    render(<ExportDataButton featureId="funnels" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export your data' }));
    await waitFor(() => expect(api.downloadFeatureExport).toHaveBeenCalledWith('funnels'));
  });

  it('a MEMBER (no host:billing:manage) never sees it and the door is never asked', async () => {
    access.current = EDITOR;
    render(<ExportDataButton featureId="funnels" />);
    await drain();
    expect(screen.queryByRole('button', { name: 'Export your data' })).toBeNull();
    expect(api.listExportableFeatures).not.toHaveBeenCalled();
  });

  it('a feature with no registered exporter shows nothing', async () => {
    // Positive control from the SAME list: funnels shows once the list has resolved.
    render(<><ExportDataButton featureId="funnels" /><ExportDataButton featureId="slides" /></>);
    expect(await screen.findAllByRole('button', { name: 'Export your data' })).toHaveLength(1);
    await drain();
    expect(screen.getAllByRole('button', { name: 'Export your data' })).toHaveLength(1);
  });

  it('a feature that is not plan-lapsed (entitled) shows nothing on a lock page', async () => {
    render(<><ExportDataButton featureId="funnels" /><ExportDataButton featureId="crm" /></>);
    expect(await screen.findAllByRole('button', { name: 'Export your data' })).toHaveLength(1);
    await drain();
    expect(screen.getAllByRole('button', { name: 'Export your data' })).toHaveLength(1);
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
    // The lock prompt (same lazy module as the button) has rendered the bundle name.
    expect((await screen.findAllByText(/Marketing/)).length).toBeGreaterThan(0);
    await drain();
    expect(screen.queryByRole('button', { name: 'Export your data' })).toBeNull();
  });
});

describe('Billing — Your data', () => {
  const at = () => render(<MemoryRouter initialEntries={['/billing']}><BillingPage /></MemoryRouter>);

  it('an ADMIN sees the exportable features, the paused one marked, and each downloads', async () => {
    at();
    expect(await screen.findByRole('heading', { name: 'Your data' })).toBeTruthy();
    // The paused marker sits on the plan-lapsed row (Funnels), not the entitled one (CRM).
    const funnelsRow = screen.getByText('Funnels').closest('li')!;
    const crmRow = screen.getByText('CRM').closest('li')!;
    expect(within(funnelsRow).getByText('Paused — plan')).toBeTruthy();
    expect(within(crmRow).queryByText('Paused — plan')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export your CRM data' }));
    await waitFor(() => expect(api.downloadFeatureExport).toHaveBeenCalledWith('crm'));
  });

  it('a MEMBER gets no "Your data" panel', async () => {
    access.current = EDITOR;
    at();
    expect(await screen.findByText('Only workspace owners and admins can manage billing.')).toBeTruthy();
    await act(async () => {
      await import('../YourDataPanel.js');
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    });
    expect(screen.queryByRole('heading', { name: 'Your data' })).toBeNull();
    expect(api.listExportableFeatures).not.toHaveBeenCalled();
  });
});
