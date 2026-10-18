/**
 * UX_UPGRADE-privacy P1 — a disclosure page must not be derived from a
 * deployment type it never established.
 *
 * `/privacy` forks its ENTIRE text on `demoMode`. The clean/white-label arm
 * deliberately makes no deployment-specific claims, so it omits the 24-hour
 * `openwop.session` anon-cookie section. But `loadDemoMode()` catches a failed
 * `getCapabilities()` and sets `cached = false; loaded = true` — permanently, no
 * retry. On the real demo host a transient failure therefore landed a visitor who
 * HAS that cookie on the arm that never mentions it, forever.
 *
 * The boolean's fail-safe direction is correct for SHOWCASE content and is left
 * untouched (six consumers depend on it). This adds a tri-state read used only
 * here, so the disclosure can distinguish resolved-clean from we-couldn't-ask.
 *
 * Both arms asserted throughout: an unknown deployment discloses the caveat, and
 * a genuinely-clean install still renders the plain enterprise text with no
 * spurious warning.
 *
 * Every absence is asserted AFTER the read settles. The `<h1>` also renders in
 * the `unresolved` (loading) branch, so waiting for it proves nothing: until
 * /grade-tests w50 the CLEAN and heading cases asserted on the loading skeleton
 * and stayed green with clean → 'unknown' (probe `pv-clean`) and with an
 * `unknown` arm that renders nothing (`pv-heading`). The settle signal is the
 * enterprise lede, which only the resolved non-demo arm renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const caps = vi.hoisted(() => ({ getCapabilities: vi.fn() }));
vi.mock('../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getCapabilities: caps.getCapabilities };
});

/** Rendered only by the RESOLVED non-demo arm (literal en copy: an expectation
 *  imported from the catalog would move with it). */
const ENTERPRISE_LEDE = /How this workspace handles your data\./;
const CAVEAT = /couldn't confirm which deployment/i;

/** demoMode caches module-level, so each case needs a fresh module graph. */
async function freshRender(): Promise<void> {
  vi.resetModules();
  const { PrivacyPage: Page } = await import('../PrivacyPage.js');
  render(<Page />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});
afterEach(cleanup);

describe('UX-PRIV-1 — an unread deployment flag never silently picks a disclosure', () => {
  it('UNKNOWN: a failed capabilities read discloses that the deployment is unconfirmed', async () => {
    caps.getCapabilities.mockRejectedValue(new Error('caps_500'));
    await freshRender();
    expect(await screen.findByText(CAVEAT)).toBeTruthy();
  });

  it('CLEAN: a real non-demo answer renders the plain text with NO caveat', async () => {
    // The other arm — without it, "always warn" would pass the test above while
    // putting a permanent scary notice on every white-label install.
    caps.getCapabilities.mockResolvedValue({ demoMode: false });
    await freshRender();
    // Settled: the resolved arm is on screen and the loading status is gone.
    expect(await screen.findByText(ENTERPRISE_LEDE)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(CAVEAT)).toBeNull();
  });

  it('DEMO: a real demo answer renders the anon-cookie disclosure', async () => {
    caps.getCapabilities.mockResolvedValue({ demoMode: true });
    await freshRender();
    // The 24h session cookie block is the demo-only disclosure.
    expect(await screen.findByText(/openwop\.session/i)).toBeTruthy();
    expect(screen.queryByText(CAVEAT)).toBeNull();
  });

  it('the page always renders its heading, whatever the flag did', async () => {
    // A disclosure that renders nothing is worse than one that renders a caveat.
    caps.getCapabilities.mockRejectedValue(new Error('caps_500'));
    await freshRender();
    // Wait for the read to SETTLE (the caveat), then the page must still carry
    // its heading and its body — not a bare caveat, not nothing.
    expect(await screen.findByText(CAVEAT)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Privacy & cookies');
    expect(screen.getByText(ENTERPRISE_LEDE)).toBeTruthy();
  });
});
