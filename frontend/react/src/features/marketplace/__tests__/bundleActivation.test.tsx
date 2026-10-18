/**
 * ADR 0892 Phase B D10 — the store card's state in THIS workspace and its Enable /
 * Turn off controls.
 *
 * The state comes from the catalog's `activation` and the controls from
 * `viewer.canManageBundles` — both the server's answers, never derived here. A
 * refusal is named by its typed reason; a 402 opens the bundle that sells what is
 * missing; success re-resolves the access map so the nav changes without a reload.
 *
 * Sabotage witnesses (run by hand, 2026-10-14): ignoring `canManageBundles` (always
 * true) reds "a member sees the state but no controls"; dropping the
 * `reloadEntitlementsNow()` call reds "Enable turns the bundle on".
 * Wave 52 (grade-tests): the Enable case's quiet re-read never settles, so "On in
 * this workspace" can only come from the WRITE's answer (dropping that
 * `setCatalog` reds it — w52g1-ba-optimistic-set-r2); the 402 fixture names a
 * feature (`territories`) and a seller bundle (`sales`) that differ, so picking the
 * seller from `e.ids` instead of `e.bundles` reds it (w52g1-ba-seller-field-r2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { FeatureBundleCatalog } from '../marketplaceClient.js';
import { messages as en } from '../i18n/en.js';
import { messages as es } from '../i18n/es.js';
import { messages as fr } from '../i18n/fr.js';
import { messages as ptBR } from '../i18n/pt-BR.js';

type Client = typeof import('../marketplaceClient.js');
const api = vi.hoisted(() => ({
  fetchFeatureBundles: vi.fn<Client['fetchFeatureBundles']>(),
  enableFeatureBundle: vi.fn<Client['enableFeatureBundle']>(),
  disableFeatureBundle: vi.fn<Client['disableFeatureBundle']>(),
  reload: vi.fn<typeof import('../../../client/entitlementRefresh.js')['reloadEntitlementsNow']>(),
}));
vi.mock('../marketplaceClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchFeatureBundles: api.fetchFeatureBundles,
  fetchBundleCommerce: vi.fn().mockResolvedValue([]),
  fetchPublicPricing: vi.fn().mockResolvedValue([]),
  enableFeatureBundle: api.enableFeatureBundle,
  disableFeatureBundle: api.disableFeatureBundle,
}));
vi.mock('../../../client/entitlementRefresh.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  reloadEntitlementsNow: api.reload,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts, Toaster: () => null }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  // Billing off: the catalog lists every bundle unpriced, isolating the activation row.
  useFeatureAccess: (id: string) => makeFeatureAccess({ enabled: id !== 'billing' }),
}));
import { BundleShopPage } from '../BundleShopPage.js';
import { BundleActivationError } from '../marketplaceClient.js';

const F = (id: string, label: string, dependsOn: string[] = []) => ({ id, label, dependsOn, registered: true });
const catalog = (canManageBundles: boolean): FeatureBundleCatalog => ({
  available: true,
  groups: [],
  bundles: [
    { id: 'crm', label: 'CRM', features: [F('crm', 'Accounts')] },
    { id: 'commerce', label: 'Commerce', features: [F('commerce', 'Storefront', ['crm'])] },
    { id: 'sales', label: 'Sales', features: [F('territories', 'Territories')] },
    { id: 'studio', label: 'Studio', features: [F('studio', 'Studio')] },
  ],
  standalone: [],
  core: [],
  activation: {
    crm: { status: 'enabled' },
    commerce: { status: 'available' },
    sales: { status: 'locked', missing: ['territories'] },
    studio: { status: 'locked', killed: ['studio'] },
  },
  viewer: { canManageBundles },
});

function LocationProbe(): JSX.Element {
  return <output data-testid="loc">{useLocation().search}</output>;
}
const page = () => render(
  <MemoryRouter initialEntries={['/marketplace/bundles']}>
    <Routes><Route path="/marketplace/bundles" element={<><BundleShopPage /><LocationProbe /></>} /></Routes>
  </MemoryRouter>,
);
const card = async (name: string): Promise<HTMLElement> =>
  (await screen.findByRole('heading', { level: 4, name })).closest('article') as HTMLElement;

beforeEach(() => {
  api.fetchFeatureBundles.mockReset().mockResolvedValue(catalog(true));
  api.enableFeatureBundle.mockReset();
  api.disableFeatureBundle.mockReset();
  api.reload.mockReset();
  toasts.success.mockReset(); toasts.error.mockReset();
});
afterEach(cleanup);

describe('ADR 0892 Phase B — bundle state + controls on the store card', () => {
  it('an admin sees each state with the matching control', async () => {
    page();
    const crm = await card('CRM');
    expect(within(crm).getByText('On in this workspace')).toBeTruthy();
    expect(within(crm).getByRole('button', { name: 'Turn off CRM for this workspace' })).toBeTruthy();
    const commerce = await card('Commerce');
    expect(within(commerce).getByText('Ready to turn on')).toBeTruthy();
    expect(within(commerce).getByRole('button', { name: 'Enable Commerce for this workspace' })).toBeTruthy();
    const sales = await card('Sales');
    expect(within(sales).getByText('Not in your plan yet')).toBeTruthy();
    expect(within(sales).queryByRole('button', { name: /Enable|Turn off/ })).toBeNull();
    const studio = await card('Studio');
    expect(within(studio).getByText('Switched off on this host')).toBeTruthy();
    expect(within(studio).queryByRole('button', { name: /Enable|Turn off/ })).toBeNull();
  });

  it('a member sees the state but no controls', async () => {
    api.fetchFeatureBundles.mockResolvedValue(catalog(false));
    page();
    const crm = await card('CRM');
    expect(within(crm).getByText('On in this workspace')).toBeTruthy();
    expect(within(crm).queryByRole('button', { name: /Turn off/ })).toBeNull();
    const commerce = await card('Commerce');
    expect(within(commerce).queryByRole('button', { name: /Enable/ })).toBeNull();
    expect(within(commerce).getByText('Ask a workspace owner or admin to turn it on.')).toBeTruthy();
  });

  it('Enable turns the bundle on, says so, and re-resolves the access map', async () => {
    api.enableFeatureBundle.mockResolvedValue({ bundleId: 'commerce', status: 'enabled' });
    // The quiet re-read after the write NEVER settles, so the card's "On" state can
    // only come from the write's own answer (round 1: a re-read that also said
    // "enabled" made dropping that update invisible).
    api.fetchFeatureBundles.mockResolvedValueOnce(catalog(true)).mockReturnValue(new Promise<FeatureBundleCatalog>(() => {}));
    page();
    fireEvent.click(within(await card('Commerce')).getByRole('button', { name: 'Enable Commerce for this workspace' }));
    await waitFor(() => expect(api.enableFeatureBundle).toHaveBeenCalledWith('commerce'));
    await waitFor(() => expect(within(screen.getByTestId('bundle-activation-commerce')).getByText('On in this workspace')).toBeTruthy());
    expect(toasts.success).toHaveBeenCalledWith('Commerce is on for this workspace.');
    expect(api.reload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.fetchFeatureBundles).toHaveBeenCalledTimes(2));
  });

  it('a 402 names the missing features by label and opens the bundle that sells them', async () => {
    // The missing FEATURE (territories) and the bundle that SELLS it (sales) differ,
    // so the label lookup and the seller pick each read their own field.
    api.enableFeatureBundle.mockRejectedValue(new BundleActivationError('x', 402, 'bundle_not_entitled', ['territories'], ['sales']));
    page();
    fireEvent.click(within(await card('Commerce')).getByRole('button', { name: 'Enable Commerce for this workspace' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Your plan does not include Territories yet.'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('?bundle=sales'));
    expect(api.reload).not.toHaveBeenCalled();
  });

  it('a 409 disable-lock names the features that still need the bundle', async () => {
    api.disableFeatureBundle.mockRejectedValue(new BundleActivationError('x', 409, 'disable_blocked', ['commerce'], []));
    page();
    fireEvent.click(within(await card('CRM')).getByRole('button', { name: 'Turn off CRM for this workspace' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Still needed by Storefront in this workspace. Turn those off first.'));
    expect(within(screen.getByTestId('bundle-activation-crm')).getByText('On in this workspace')).toBeTruthy();
  });

  it('a degraded state read is disclosed, not shown as "ready"', async () => {
    const c = catalog(true);
    delete c.activation;
    api.fetchFeatureBundles.mockResolvedValue({ ...c, activationDegraded: true });
    page();
    expect(await screen.findByText('Could not read which bundles are on in this workspace.')).toBeTruthy();
    expect(screen.queryByText('Ready to turn on')).toBeNull();
  });
});

describe('ADR 0892 Phase B — i18n parity', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('storeActivation'));
  const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  it.each([['es', es], ['fr', fr], ['pt-BR', ptBR]] as const)('%s has every activation key with the same placeholders', (_loc, msgs) => {
    // Measured 18 `storeActivation*` keys in en.ts at e3c2492be; the floor is that
    // measured count (a floor of 10 let 8 keys vanish unnoticed).
    expect(keys.length).toBeGreaterThanOrEqual(18);
    for (const k of keys) {
      const v = (msgs as Record<string, string | undefined>)[k];
      expect(v, k).toBeTruthy();
      expect(vars(v ?? ''), k).toEqual(vars((en as Record<string, string | undefined>)[k] ?? ''));
    }
  });
});
