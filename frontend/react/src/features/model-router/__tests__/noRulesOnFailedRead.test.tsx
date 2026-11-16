/**
 * MR-R2-1 — an unreadable config must not assert what routing is doing.
 *
 * `rules` is `useState<RoutingRule[]>([])` — NOT nullable — so a failed
 * `getRouterConfig` left it `[]` and the page rendered
 * "No rules — every turn uses the fallback target." (ADR 1016 reworded it to
 * "every message uses its conversation's own model".) That is a claim about LIVE
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
 *
 * Breaks if a failed read renders the zero-rule sentence, leaves the Rules section blank, or if a SUCCESSFUL zero-rule read
 * loses the (then true) sentence.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { RouterConfigView, StoredRouterConfig, ModelRouterConfig } from '../modelRouterClient.js';

const { getRouterConfig, setRouterConfig } = vi.hoisted(() => ({
  getRouterConfig: vi.fn<() => Promise<RouterConfigView>>(),
  setRouterConfig: vi.fn<(cfg: ModelRouterConfig) => Promise<StoredRouterConfig>>(),
}));
vi.mock('../modelRouterClient.js', async (orig) => ({
  ...(await orig<typeof import('../modelRouterClient.js')>()),
  getRouterConfig, setRouterConfig,
}));

import { ModelRouterPage } from '../ModelRouterPage.js';

const NO_RULES: StoredRouterConfig = {
  enabled: true,
  config: { rules: [], fallback: { provider: 'openai', model: 'gpt-5.5' } },
};

const ZERO_RULES_READ: RouterConfigView = { stored: NO_RULES, canManage: true };

/** Render and wait until the config read SETTLED. Before it settles the page is
 *  a skeleton with no Rules section, so the section's heading appearing is the
 *  settle signal for both the success and the failure branch; every assertion
 *  after it is synchronous and fails on the value, not on a timeout. */
const mount = async (): Promise<void> => {
  render(<ModelRouterPage />);
  await vi.waitFor(() => expect(getRouterConfig).toHaveBeenCalledTimes(1));
  await screen.findByRole('heading', { name: 'Rules, checked in order' });
  await act(async () => {});
};

// ADR 1016 — the zero-rule claim now names what happens with no rules: every
// message keeps its conversation's own model (the fallback only catches messages
// that rules exist to judge).
const NO_RULES_LINE = /No rules yet\. Until you add one, every message uses its conversation.s own model/i;

afterEach(cleanup);
beforeEach(() => {
  // mockReset, not clearAllMocks: each case sets its own read outcome.
  getRouterConfig.mockReset();
  setRouterConfig.mockReset();
  setRouterConfig.mockResolvedValue(NO_RULES);
});

describe('MR-R2-1 — "no rules" is a claim, and a failed read may not make it', () => {
  it('read FAILS: the unreadable-config warning, and NOT the routing claim', async () => {
    getRouterConfig.mockRejectedValue(new Error('503 upstream'));
    await mount();

    // The honest signal stays — the guard sentence specifically.
    expect(screen.getByText(/Editing is disabled because the current routing config could not be read/)).toBeTruthy();
    // THE DEFECT: this sentence rendered underneath that warning.
    expect(screen.queryByText(NO_RULES_LINE)).toBeNull();
  });

  it('read SUCCEEDS with zero rules: the claim is TRUE and survives (other polarity)', async () => {
    getRouterConfig.mockResolvedValue(ZERO_RULES_READ);
    await mount();

    // The read landed with a stored config: no "not configured" chip, and the
    // zero-rule sentence is the Rules section's own text.
    expect(screen.queryByText('not configured')).toBeNull();
    const section = document.querySelector('section[aria-labelledby="mr-rules-h"]');
    expect(section?.textContent).toMatch(NO_RULES_LINE);
    // Nothing failed, so nothing may say it did.
    expect(screen.queryByText(/rules could not be read/i)).toBeNull();
    expect(screen.queryByText(/Editing is disabled because/)).toBeNull();
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
    expect(section?.textContent).toMatch(/The current rules could not be read, so what routing is doing right now is unknown\./);
  });
});
