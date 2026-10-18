/**
 * ADR 0419 R3 + §8 follow-on — a LOCKED ⌘K command upsells to the bundle that sells
 * it: the lock names that bundle, and activating it opens the store's detail panel
 * (`/marketplace/bundles?bundle=<id>`) instead of the bare store. The feature →
 * bundle lookup is data (the catalog read), loaded once.
 *
 * No `useEffectiveAccess` mock: the palette's lock comes from `useFeatureLocked`
 * (mocked below), and nothing on the rendered path calls the access hook.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BoxesIcon } from '../icons/index.js';

const fetchFeatureBundles = vi.hoisted(() => vi.fn(async () => ({
  available: true,
  bundles: [{ id: 'crm', label: 'CRM Suite', features: [{ id: 'crm', registered: true, dependsOn: [] }] }],
  standalone: [],
  core: [],
})));
vi.mock('../../features/marketplace/marketplaceClient.js', () => ({
  fetchFeatureBundles, fetchBundleCommerce: vi.fn(async () => []), fetchPublicPricing: vi.fn(async () => []),
}));
vi.mock('../../chrome/navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({
    workspace: [{ id: 'g', label: 'Group', items: [
      { to: '/crm', icon: BoxesIcon, label: 'CRM', hint: 'Contacts', featureId: 'crm' },
      { to: '/okrs', icon: BoxesIcon, label: 'OKRs', hint: 'Goals', featureId: 'okrs' },
    ] }],
    admin: [], site: [], degraded: false,
  }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  useFeatureBadge: () => () => null,
  // `okrs` is locked but no bundle sells it in this catalog.
  useFeatureLocked: () => (id?: string) => id === 'crm' || id === 'okrs',
}));

import { CommandPalette } from '../CommandPalette.js';

Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
afterEach(cleanup);

function Where(): JSX.Element {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.search}</output>;
}

describe('CommandPalette — locked command (ADR 0419)', () => {
  it('names the unlocking bundle and opens its store panel', async () => {
    render(
      <MemoryRouter>
        <CommandPalette openSignal={1} />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
    // The lock label names the bundle once the catalog lands.
    await waitFor(() => expect(screen.getByRole('img', { name: 'Locked — unlock with CRM Suite' })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: /CRM/ }));
    expect(screen.getByTestId('where').textContent).toBe('/marketplace/bundles?bundle=crm');
    // One catalog read for the whole list. The count is CUMULATIVE for this file
    // (the lookup is cached per session in module state), so it stays 1 in either
    // case order. It is a DOUBLE guard: `pending ??=` (featureToggles/lockedTargets.ts)
    // and `catalogP ??=` (features/marketplace/lockedUpsell.ts) each keep it at 1
    // alone, so breaking either one alone stays green here (w49 probe locked-once was
    // vacuous for exactly this reason). The shared session cache is witnessed by
    // lockedUpsell.test.ts "N callers share one read of each endpoint".
    expect(fetchFeatureBundles).toHaveBeenCalledTimes(1);
  });

  it('a locked command whose feature no bundle sells links to the store for that feature', async () => {
    render(
      <MemoryRouter>
        <CommandPalette openSignal={1} />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('img', { name: 'Locked — unlock with CRM Suite' })).toBeTruthy());
    expect(screen.getByRole('img', { name: 'Locked — unlock in the feature store' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /OKRs/ }));
    expect(screen.getByTestId('where').textContent).toBe('/marketplace/bundles?feature=okrs');
  });
});
