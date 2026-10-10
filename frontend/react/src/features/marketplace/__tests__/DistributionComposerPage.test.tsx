/**
 * ADR 0366 P3/P4 — the white-label distribution composer, MOVED off the store to
 * `/marketplace/distribution` by the ADR 0820 §7 UI redesign. Same behaviour as
 * before the move (three tiers, dependsOn closure, manifest export) and the SAME
 * gate (the route table's `admin` tier + the `marketplace` toggle). The route-table
 * half (admin tier, no nav entry) is pinned by `marketplaceHub.test.tsx` ("every tab
 * keeps today's gate", "exactly one nav entry") — the same sabotage reds both files.
 *
 * Sabotage-witnessed (/grade-tests wave 10): loading with the toggle off, the anchor,
 * the not-in-build chip, the standalone tier, the manifest `bundles` key, the
 * dependsOn closure, the name rule and the failed-read card each red their case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
const { fetchFeatureBundles } = vi.hoisted(() => ({ fetchFeatureBundles: vi.fn() }));
vi.mock('../marketplaceClient.js', () => ({ fetchFeatureBundles }));
let enabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', async () => {
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return { useFeatureAccess: () => makeFeatureAccess({ enabled, loading: false }) };
});
import { DistributionComposerPage } from '../DistributionComposerPage.js';
import type { FeatureBundleCatalog } from '../marketplaceClient.js';

const CATALOG: FeatureBundleCatalog = {
  available: true,
  groups: [],
  bundles: [
    { id: 'sales', label: 'Sales', features: [{ id: 'territories', label: 'Territories', dependsOn: ['crm'], registered: true }] },
    { id: 'commerce', label: 'Commerce', features: [{ id: 'commerce', label: 'Storefront', dependsOn: [], registered: true }, { id: 'ghost', dependsOn: [], registered: false }] },
    { id: 'crm', label: 'CRM', features: [{ id: 'crm', label: 'Accounts', dependsOn: [], registered: true }] },
  ],
  standalone: [{ id: 'kb', label: 'Knowledge Base', category: 'Content', dependsOn: [], registered: true }],
  core: [{ id: 'orgs', label: 'Organizations', category: 'Platform', dependsOn: [], registered: true }],
};

const page = () => render(<MemoryRouter><DistributionComposerPage /></MemoryRouter>);

beforeEach(() => { enabled = true; fetchFeatureBundles.mockReset(); fetchFeatureBundles.mockResolvedValue(CATALOG); });
afterEach(cleanup);

describe('the composer has its own route, with the gate it had on the store', () => {
  it('marketplace off → the not-enabled state and no catalog read (control: on → the composer)', async () => {
    enabled = false;
    page();
    expect(screen.getByText('Marketplace is not enabled')).toBeTruthy();
    expect(fetchFeatureBundles).not.toHaveBeenCalled();
    cleanup();
    enabled = true;
    page();
    expect(await screen.findByText('Sales')).toBeTruthy();
  });

  it('carries its own walkthrough anchor; the store is the hub\'s first tab, not an inline back link', async () => {
    page();
    await screen.findByText('Sales');
    expect(document.querySelector('[data-walkthrough="marketplace-distribution.page"]')).not.toBeNull();
    expect(document.querySelector('a[href="/marketplace/bundles"]')).toBeNull();
  });
});

describe('white-label composer (ADR 0366)', () => {
  it('renders bundles and marks a feature missing from this build', async () => {
    page();
    expect(await screen.findByText('Sales')).toBeTruthy();
    expect(screen.getByText('ghost')).toBeTruthy();
    // Exactly the one unregistered feature (ghost) carries the chip.
    expect(screen.getAllByText('not in this build')).toHaveLength(1);
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

  it('no catalog → the designed empty state; a failed read → the retry card', async () => {
    fetchFeatureBundles.mockResolvedValue({ available: false, groups: [], bundles: [], standalone: [], core: [] });
    page();
    expect(await screen.findByText('No bundle catalog')).toBeTruthy();
    cleanup();
    fetchFeatureBundles.mockRejectedValueOnce(new Error('down'));
    page();
    expect(await screen.findByText(/bundles could not be loaded/i)).toBeTruthy();
  });
});
