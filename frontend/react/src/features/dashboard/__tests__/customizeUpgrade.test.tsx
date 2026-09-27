/**
 * UX_UPGRADE-dashboard — the customize-mode upgrades (D-G1..D-G3).
 *
 * Customize mode was already keyboard-operable and already announced REORDER.
 * These pin the two things missing from that otherwise-good pattern: every
 * action announces (a screen-reader user pressing resize or remove previously
 * got silence), and there is a route back to the default arrangement.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

const getLayout = vi.fn();
const putLayout = vi.fn();
vi.mock('../dashboardClient.js', () => ({
  getLayout: () => getLayout(),
  putLayout: (...a: unknown[]) => putLayout(...a),
}));

const confirmFn = vi.fn();
vi.mock('../../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmFn(...a) }));

vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureVisible: () => () => true,
  // ADR 0419 — DashboardPage now drops tiles whose owning feature is LOCKED
  // (toggle on, plan not entitled). Nothing is locked in these fixtures.
  useFeatureLocked: () => () => false,
  useAllFeatureAccess: () => ({ loading: false }),
}));
vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: {}, resolved: true }),
  isAdminCaller: () => true,
}));

const { DashboardPage } = await import('../DashboardPage.js');

/** The live region customize actions write into. */
const announced = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderCustomizing() {
  getLayout.mockResolvedValue(null); // no saved layout ⇒ registry defaults
  putLayout.mockResolvedValue({});
  const view = render(<DashboardPage />);
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
    render(<DashboardPage />);
    await screen.findByRole('button', { name: /customize/i });
    expect(screen.queryByRole('button', { name: /reset to defaults/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /customize/i }));
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeTruthy();
  });

  it('CONFIRMS first — it discards an arrangement and cannot be undone', async () => {
    await renderCustomizing();
    confirmFn.mockResolvedValue(false);
    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    // Declining must not write anything.
    await waitFor(() => expect(announced()).not.toMatch(/reset to the default/i));
  });

  it('restores the DEFAULT layout and persists it', async () => {
    await renderCustomizing();
    // Remove a tile so the current arrangement differs from the default.
    const before = screen.getAllByRole('button', { name: /remove tile/i }).length;
    fireEvent.click(screen.getAllByRole('button', { name: /remove tile/i })[0]!);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /remove tile/i }).length).toBe(before - 1));

    confirmFn.mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: /reset to defaults/i }));

    await waitFor(() => expect(announced()).toMatch(/reset to the default/i));
    // The removed tile is back — defaults are re-derived from the registry, not
    // reconstructed by hand in the page.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /remove tile/i }).length).toBe(before));
  });
});
