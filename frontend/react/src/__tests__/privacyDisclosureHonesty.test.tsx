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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

const caps = vi.hoisted(() => ({ getCapabilities: vi.fn() }));
vi.mock('../client/runsClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getCapabilities: caps.getCapabilities };
});

import { PrivacyPage } from '../PrivacyPage.js';

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
    expect(await screen.findByText(/couldn't confirm which deployment/i)).toBeTruthy();
  });

  it('CLEAN: a real non-demo answer renders the plain text with NO caveat', async () => {
    // The other arm — without it, "always warn" would pass the test above while
    // putting a permanent scary notice on every white-label install.
    caps.getCapabilities.mockResolvedValue({ demoMode: false });
    await freshRender();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/couldn't confirm which deployment/i)).toBeNull();
  });

  it('DEMO: a real demo answer renders the anon-cookie disclosure', async () => {
    caps.getCapabilities.mockResolvedValue({ demoMode: true });
    await freshRender();
    // The 24h session cookie block is the demo-only disclosure.
    expect(await screen.findByText(/openwop\.session/i)).toBeTruthy();
    expect(screen.queryByText(/couldn't confirm which deployment/i)).toBeNull();
  });

  it('the page always renders its heading, whatever the flag did', async () => {
    // A disclosure that renders nothing is worse than one that renders a caveat.
    caps.getCapabilities.mockRejectedValue(new Error('caps_500'));
    await freshRender();
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
  });
});

// Keep the static import referenced so lint doesn't flag it while the dynamic
// import above is what each case actually renders.
void PrivacyPage;
