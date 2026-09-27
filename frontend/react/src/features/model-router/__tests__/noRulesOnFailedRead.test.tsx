/**
 * MR-R2-1 — an unreadable config must not assert what routing is doing.
 *
 * `rules` is `useState<RoutingRule[]>([])` — NOT nullable — so a failed
 * `getRouterConfig` left it `[]` and the page rendered
 * "No rules — every turn uses the fallback target." That is a claim about LIVE
 * ROUTING BEHAVIOUR made from a read that never arrived, and it contradicted the
 * `loadFailed` warning sitting two lines above it.
 *
 * MR-G1 (see `loadFailedGuard.test.tsx`) already stopped the dangerous half —
 * every save is disabled while `loadFailed`, so the empty list cannot be written
 * back. What survived was the sentence. Found by the 2026-08-10 audit of the
 * render-time `?? []` failed-read class; 2 of 61 candidate files were real and
 * this was one.
 *
 * Both polarities, because asserting only the ABSENCE of a sentence is vacuous —
 * a page that rendered nothing would satisfy it.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

const { getRouterConfig, setRouterConfig, listOrgs } = vi.hoisted(() => ({
  getRouterConfig: vi.fn(), setRouterConfig: vi.fn(), listOrgs: vi.fn(),
}));
vi.mock('../modelRouterClient.js', async (orig) => ({
  ...(await orig<typeof import('../modelRouterClient.js')>()),
  getRouterConfig, setRouterConfig, listOrgs,
}));

import { ModelRouterPage } from '../ModelRouterPage.js';

const NO_RULES = {
  enabled: true,
  config: { rules: [], fallback: { provider: 'openai', model: 'gpt-4o' } },
};

const mount = async (): Promise<void> => {
  render(<ModelRouterPage />);
  await act(async () => {});
};

const NO_RULES_LINE = /every turn uses the fallback target/i;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  setRouterConfig.mockResolvedValue(NO_RULES);
});

describe('MR-R2-1 — "no rules" is a claim, and a failed read may not make it', () => {
  it('read FAILS: the unreadable-config warning, and NOT the routing claim', async () => {
    getRouterConfig.mockRejectedValue(new Error('503 upstream'));
    await mount();

    // The honest signal stays.
    expect(document.body.textContent).toContain('could not be read');
    // THE DEFECT: this sentence rendered underneath that warning.
    expect(screen.queryByText(NO_RULES_LINE)).toBeNull();
  });

  it('read SUCCEEDS with zero rules: the claim is TRUE and survives (other polarity)', async () => {
    getRouterConfig.mockResolvedValue(NO_RULES);
    await mount();

    expect(screen.getByText(NO_RULES_LINE)).toBeTruthy();
    // Nothing failed, so nothing may say it did.
    expect(screen.queryByText(/rules could not be read/i)).toBeNull();
  });

  it('the failed read leaves no BLANK section — the heading is explained', async () => {
    // Code-review caught this against the first cut, which merely suppressed the
    // "no rules" line and left a bare "Rules" heading with nothing under it. The
    // loadFailed warning is at the TOP of the page, ~34 lines and two <section>s
    // away, so an empty heading here reads as "no rules" — the same false
    // impression the gate was supposed to remove. Same standard as
    // CreatorInsightsPage: a failed read gets a sentence, not a blank.
    getRouterConfig.mockRejectedValue(new Error('503 upstream'));
    await mount();

    const section = document.querySelector('section[aria-labelledby="mr-rules-h"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toMatch(/could not be read/i);
  });
});
