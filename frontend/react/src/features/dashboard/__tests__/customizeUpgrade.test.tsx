/**
 * UX_UPGRADE-dashboard — the customize-mode upgrades (D-G1..D-G3).
 *
 * Customize mode was already keyboard-operable and already announced REORDER.
 * These pin the two things missing from that otherwise-good pattern: every
 * action announces (a screen-reader user pressing resize or remove previously
 * got silence), and there is a route back to the default arrangement.
 */
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type DashClient = typeof import('../dashboardClient.js');
const getLayout = vi.fn<DashClient['getLayout']>();
const putLayout = vi.fn<DashClient['putLayout']>();
vi.mock('../dashboardClient.js', () => ({
  getLayout: (signal?: AbortSignal) => getLayout(signal),
  putLayout: (tiles: Parameters<DashClient['putLayout']>[0]) => putLayout(tiles),
}));

type ConfirmFn = typeof import('../../../ui/confirm.js')['confirm'];
const confirmFn = vi.fn<ConfirmFn>();
vi.mock('../../../ui/confirm.js', () => ({ confirm: (opts: Parameters<ConfirmFn>[0]) => confirmFn(opts) }));

vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  // ADR 0419 — DashboardPage now drops tiles whose owning feature is LOCKED
  // (toggle on, plan not entitled). Nothing is locked in these fixtures.
  useFeatureLocked: () => () => false,
  useAllFeatureAccess: () => ({ loading: false }),

  // Every export the page's tiles import (continue-working reads per-type access);
  // without it that tile threw into its ErrorBoundary on every render.
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: {}, resolved: true }),
  isAdminCaller: () => true,
}));

const { DashboardPage } = await import('../DashboardPage.js');

/** The live region customize actions write into. */
const announced = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

// mockReset: clearAllMocks keeps a case's confirm/put implementation for the next case.
afterEach(() => { cleanup(); getLayout.mockReset(); putLayout.mockReset(); confirmFn.mockReset(); });

async function renderCustomizing() {
  getLayout.mockResolvedValue(null); // no saved layout ⇒ registry defaults
  putLayout.mockImplementation(async (tiles) => ({ tenantId: 't1', subject: 'u1', tiles, updatedAt: '2026-08-01T00:00:00.000Z' }));
  const view = render(<MemoryRouter><DashboardPage /></MemoryRouter>);
  await screen.findByRole('button', { name: /customize/i });
  fireEvent.click(screen.getByRole('button', { name: /customize/i }));
  return view;
}

describe('dashboard customize — every action announces (D-G2/D-G3)', () => {
  it('announces a RESIZE, which used to be silent', async () => {
    await renderCustomizing();
    const resize = screen.getAllByRole('button', { name: /make wide|make compact/i })[0]!;
    fireEvent.click(resize);
    await waitFor(() => expect(announced()).toMatch(/now (wide|compact)/i));
  });

  it('announces a REMOVE and says where the tile went', async () => {
    await renderCustomizing();
    const remove = screen.getAllByRole('button', { name: /remove tile/i })[0]!;
    fireEvent.click(remove);
    // Removal is recoverable — but only if you know that. Silence was the bug.
    await waitFor(() => expect(announced()).toMatch(/removed/i));
    expect(announced()).toMatch(/add tiles/i);
  });

  it('announces an ADD from the picker', async () => {
    await renderCustomizing();
    fireEvent.click(screen.getAllByRole('button', { name: /remove tile/i })[0]!);
    const picker = await screen.findByLabelText(/add tiles/i);
    fireEvent.click(within(picker).getAllByRole('button', { name: /^add/i })[0]!);
    await waitFor(() => expect(announced()).toMatch(/added to the end/i));
  });
});

describe('dashboard customize — reset to defaults (D-G1)', () => {
  it('is offered ONLY while customizing', async () => {
    getLayout.mockResolvedValue(null);
    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    await screen.findByRole('button', { name: /customize/i });
    expect(screen.queryByRole('button', { name: /reset to defaults/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeTruthy();
  });

  it('CONFIRMS first — it discards an arrangement and cannot be undone', async () => {
    await renderCustomizing();
    // Make the arrangement differ from the default, so a reset that ignored the
    // decline would be VISIBLE (the removed tile would come back).
    const before = screen.getAllByRole('button', { name: /remove tile/i }).length;
    fireEvent.click(screen.getAllByRole('button', { name: /remove tile/i })[0]!);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /remove tile/i }).length).toBe(before - 1));

    confirmFn.mockResolvedValue(false);
    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    // Let the post-confirm continuation run BEFORE asserting absence (a negative
    // inside waitFor passes on its first synchronous check).
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Declining changes nothing: the removed tile stays removed, nothing announces a reset.
    expect(screen.getAllByRole('button', { name: /remove tile/i })).toHaveLength(before - 1);
    expect(announced()).toMatch(/removed/i);
    expect(announced()).not.toMatch(/reset to the default/i);
  });

  it('restores the DEFAULT layout and persists it', async () => {
    await renderCustomizing();
    // Remove a tile so the current arrangement differs from the default.
    const before = screen.getAllByRole('button', { name: /remove tile/i }).length;
    const removeBtn = screen.getAllByRole('button', { name: /remove tile/i })[0]!;
    const removedId = removeBtn.closest('[data-tile-id]')!.getAttribute('data-tile-id')!;
    fireEvent.click(removeBtn);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /remove tile/i }).length).toBe(before - 1));

    confirmFn.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

    await waitFor(() => expect(announced()).toMatch(/reset to the default/i));
    // The removed tile is back — defaults are re-derived from the registry, not
    // reconstructed by hand in the page.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /remove tile/i }).length).toBe(before));
    // …and PERSISTED: the (debounced, 600 ms) save carries the removed tile enabled again.
    await waitFor(() => expect(putLayout).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: removedId, enabled: true })]),
    ), { timeout: 3000 });
  });
});
