/**
 * ADR 0366 P3/P4 + ADR 0419 P2 — BundleShopPage: the tenant feature STORE
 * (buy / owned / price, billing-gated) AND the demoted white-label composer
 * (three tiers, dependsOn closure, manifest export). Honest empty/not-enabled states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const { fetchFeatureBundles, fetchBundleCommerce, buyBundle } = vi.hoisted(() => ({
  fetchFeatureBundles: vi.fn(), fetchBundleCommerce: vi.fn(), buyBundle: vi.fn(),
}));
vi.mock('../marketplaceClient.js', () => ({ fetchFeatureBundles, fetchBundleCommerce, buyBundle }));
let enabled = true;
let billingEnabled = false;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: (id: string) => {
    const on = id === 'billing' ? billingEnabled : enabled;
    return { enabled: on, loading: false, status: on ? 'on' : 'off', isBeta: false, variant: null };
  },
}));
import { BundleShopPage } from '../BundleShopPage.js';

const CATALOG = {
  available: true,
  bundles: [
    { id: 'sales', label: 'Sales', features: [{ id: 'territories', label: 'Territories', dependsOn: ['crm'], registered: true }] },
    { id: 'commerce', label: 'Commerce', features: [{ id: 'commerce', label: 'Storefront', dependsOn: [], registered: true }, { id: 'ghost', dependsOn: [], registered: false }] },
    { id: 'crm', label: 'CRM', features: [{ id: 'crm', label: 'Accounts', dependsOn: [], registered: true }] },
  ],
  standalone: [{ id: 'kb', label: 'Knowledge Base', category: 'Content', dependsOn: [], registered: true }],
  core: [{ id: 'orgs', label: 'Organizations', category: 'Platform', dependsOn: [], registered: true }],
};

const page = () => render(<MemoryRouter><BundleShopPage /></MemoryRouter>);

beforeEach(() => {
  enabled = true; billingEnabled = false;
  fetchFeatureBundles.mockReset(); fetchFeatureBundles.mockResolvedValue(CATALOG);
  fetchBundleCommerce.mockReset(); fetchBundleCommerce.mockResolvedValue([]);
  buyBundle.mockReset(); buyBundle.mockResolvedValue({ url: 'demo:x', mode: 'demo' });
});
afterEach(cleanup);

describe('white-label composer (ADR 0366)', () => {
  it('renders bundles and marks a feature missing from this build', async () => {
    page();
    expect(await screen.findByText('Sales')).toBeTruthy();
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.getAllByText('not in this build').length).toBeGreaterThan(0);
  });

  it('renders the standalone tier and the read-only core tier', async () => {
    page();
    expect(await screen.findByText('Individual features')).toBeTruthy();
    expect(screen.getByText('Knowledge Base')).toBeTruthy();
    expect(screen.getByText('Always included')).toBeTruthy();
    expect(screen.getByText('Organizations')).toBeTruthy();
  });

  it('selecting bundles drives the include-mode manifest preview', async () => {
    page();
    const commerce = (await screen.findByText('Commerce')).closest('label') as HTMLElement;
    fireEvent.click(commerce.querySelector('input') as HTMLInputElement);
    const pre = document.querySelector('.bundle-manifest-preview') as HTMLElement;
    expect(pre.textContent).toContain('"bundles"');
    expect(pre.textContent).toContain('"commerce"');
    expect(pre.textContent).not.toContain('"sales"');
  });

  it('closes the dependsOn graph — picking sales auto-includes crm', async () => {
    page();
    const sales = (await screen.findByText('Sales')).closest('label') as HTMLElement;
    fireEvent.click(sales.querySelector('input') as HTMLInputElement);
    const pre = document.querySelector('.bundle-manifest-preview') as HTMLElement;
    expect(pre.textContent).toContain('"crm"');
    expect(screen.getByText(/required by your selection/i)).toBeTruthy();
  });

  it('an invalid distribution name disables download with a visible message', async () => {
    page();
    await screen.findByText('Sales');
    const input = screen.getByLabelText(/Distribution name/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bad Name!' } });
    expect(screen.getByText(/kebab-case/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Download manifest' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('no catalog → the designed empty state', async () => {
    fetchFeatureBundles.mockResolvedValue({ available: false, bundles: [] });
    page();
    expect(await screen.findByText('No bundle catalog')).toBeTruthy();
  });
});

describe('feature store (ADR 0419)', () => {
  beforeEach(() => {
    billingEnabled = true;
    fetchBundleCommerce.mockResolvedValue([
      { bundleId: 'commerce', forSale: true, owned: false, priceDisplay: { price: '$29', cadence: '/mo', blurb: 'Sell online' } },
      { bundleId: 'crm', forSale: true, owned: true },
      { bundleId: 'sales', forSale: false, owned: false }, // not for sale → composer-only
    ]);
  });

  it('shows for-sale bundles with price + Buy, and an Owned bundle with Manage', async () => {
    page();
    expect(await screen.findByText('Feature store')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Buy the Commerce bundle/i })).toBeTruthy();
    expect(screen.getByText('$29')).toBeTruthy();
    expect(screen.getByText('Sell online')).toBeTruthy();
    expect(screen.getByText('Owned')).toBeTruthy(); // the crm bundle
    expect(screen.getByRole('link', { name: 'Manage' })).toBeTruthy();
  });

  it('buying calls the checkout for that bundle', async () => {
    page();
    fireEvent.click(await screen.findByRole('button', { name: /Buy the Commerce bundle/i }));
    await waitFor(() => expect(buyBundle).toHaveBeenCalledWith('commerce'));
  });

  it('billing off → no store section (composer is the whole page)', async () => {
    billingEnabled = false;
    page();
    await screen.findByText('Sales');
    expect(screen.queryByText('Feature store')).toBeNull();
  });

  it('billing on but nothing priced → the designed empty store state', async () => {
    fetchBundleCommerce.mockResolvedValue([{ bundleId: 'commerce', forSale: false, owned: false }]);
    page();
    expect(await screen.findByText('Nothing for sale yet')).toBeTruthy();
  });
});

describe('MKT-G1 — a failed commerce read must not render as "nothing for sale"', () => {
  it('a thrown commerce read shows the warning + retry; healed retry restores the store', async () => {
    billingEnabled = true;
    fetchBundleCommerce.mockRejectedValue(new Error('503'));
    page();
    await screen.findByText(/store pricing couldn’t be loaded/i);
    fetchBundleCommerce.mockResolvedValue([{ bundleId: 'sales', forSale: true, owned: false, priceUsd: 19 }]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/store pricing couldn’t be loaded/i)).toBeNull());
  });

  it('billing-off keeps the legitimate no-store shape with NO warning', async () => {
    billingEnabled = false;
    page();
    await screen.findByText('Sales');
    expect(screen.queryByText(/store pricing couldn’t be loaded/i)).toBeNull();
  });
});
