/**
 * UX_UPGRADE-model-router MR-G1 — a failed config read must disable the writes,
 * not merely report itself.
 *
 * Every mutating control on this page sends the WHOLE config:
 * `persist(rules, fallback)` / `persist([...rules, rule], …)`. When
 * `getRouterConfig` failed, the page kept its initial `rules = []` and showed an
 * error — but "Add rule", "Save routing" and per-rule "Remove" all stayed
 * enabled. Clicking any of them wrote the empty list back, **silently replacing
 * every stored routing rule** and re-pointing live traffic at whatever fallback
 * happened to be on screen.
 *
 * The `enabled` toggle was ALREADY gated on `hasConfig`, so the not-configured
 * case had been considered — the destructive controls were the ones left open.
 *
 * Breaks if any of the three writes (Add rule, Save routing, Remove rule) is
 * enabled while the read has failed, or if the guard over-fires and disables a
 * page whose read succeeded (or found no config).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { StoredRouterConfig } from '../modelRouterClient.js';

const { getRouterConfig, setRouterConfig, listOrgs } = vi.hoisted(() => ({
  getRouterConfig: vi.fn(), setRouterConfig: vi.fn(), listOrgs: vi.fn(),
}));
vi.mock('../modelRouterClient.js', async (orig) => ({
  ...(await orig<typeof import('../modelRouterClient.js')>()),
  getRouterConfig, setRouterConfig, listOrgs,
}));

import { ModelRouterPage } from '../ModelRouterPage.js';

const STORED: StoredRouterConfig = {
  enabled: true,
  config: {
    // The real RoutingRule shape — `when: RuleCondition` (a tagged union with
    // `kind`), not a `match` object. A wrong fixture throws in render and every
    // assertion below fails for the wrong reason.
    rules: [{ when: { kind: 'always' }, target: { provider: 'anthropic', model: 'claude-3' } }],
    fallback: { provider: 'openai', model: 'gpt-4o' },
  },
};

const GUARD = 'saving now would replace every stored rule';
const RULE_CHIP = 'anthropic/claude-3';

/** Render and wait until the config READ has been issued and settled — never a
 *  single fixed flush, so a positive case cannot pass on the pre-load state
 *  (which also has every control enabled and no warning). */
const mount = async (): Promise<void> => {
  render(<ModelRouterPage />);
  await vi.waitFor(() => expect(getRouterConfig).toHaveBeenCalledWith('o1'));
  await act(async () => {});
};

/** A button by accessible name — `getByRole` also asserts it is present. */
const btn = (name: RegExp | string): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  getRouterConfig.mockResolvedValue(STORED);
  setRouterConfig.mockResolvedValue(STORED);
});

describe('MR-G1 — a failed read disables the writes', () => {
  it('disables Add rule and Save routing, and says why', async () => {
    getRouterConfig.mockRejectedValue(new Error('503 upstream'));
    await mount();
    expect(await screen.findByText(new RegExp(GUARD))).toBeTruthy();
    expect(btn(/Add rule/).disabled).toBe(true);
    expect(btn(/Save routing/).disabled).toBe(true);
  });

  it('no write reaches the server even if a control is driven directly', async () => {
    getRouterConfig.mockRejectedValue(new Error('503'));
    await mount();
    expect(await screen.findByText(new RegExp(GUARD))).toBeTruthy();
    // Fill a VALID fallback first: with the empty on-screen fallback, `persist()`
    // returns at its own fallback check before any write, so the click proved
    // nothing about the guard (this case passed with the guard removed).
    fireEvent.change(document.querySelector('#mr-fb-provider')!, { target: { value: 'openai' } });
    fireEvent.change(document.querySelector('#mr-fb-model')!, { target: { value: 'gpt-4o' } });
    await act(async () => { fireEvent.click(btn(/Save routing/)); });
    // The whole point: the empty in-memory rule list must never be persisted over
    // the real one.
    expect(setRouterConfig).not.toHaveBeenCalled();
  });

  it('the per-rule Remove is disabled when the read fails after rules are on screen', async () => {
    // Remove is only rendered when rules are listed, so reach it the one way a
    // failed read can coexist with rows: org o1 reads fine, then org o2's read fails
    // (the page keeps o1's rows on screen — see the APPLIED note in the verdicts).
    listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }, { orgId: 'o2', name: 'Beta' }]);
    getRouterConfig.mockImplementation(async (org: string) => {
      if (org === 'o2') throw new Error('503 upstream');
      return STORED;
    });
    await mount();
    expect(await screen.findByText(RULE_CHIP)).toBeTruthy();
    expect(btn('Remove rule').disabled).toBe(false); // positive control: enabled on a good read
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'o2' } });
    await vi.waitFor(() => expect(getRouterConfig).toHaveBeenCalledWith('o2'));
    expect(await screen.findByText(new RegExp(GUARD))).toBeTruthy();
    expect(btn('Remove rule').disabled).toBe(true);
    await act(async () => { fireEvent.click(btn('Remove rule')); });
    expect(setRouterConfig).not.toHaveBeenCalled();
  });

  it('a SUCCESSFUL read leaves the editor fully usable', async () => {
    // The failure mode of this fix is bricking the page for everyone.
    await mount();
    expect(await screen.findByText(RULE_CHIP)).toBeTruthy(); // the read LANDED
    expect(document.body.textContent).not.toContain(GUARD);
    expect(btn(/Add rule/).disabled).toBe(false);
    expect(btn(/Save routing/).disabled).toBe(false);
    expect(btn('Remove rule').disabled).toBe(false);
  });

  it('a tenant with NO config yet can still be edited', async () => {
    // `null` means "read fine, nothing stored" — writing there creates the
    // config and destroys nothing. It must not be confused with a failed read.
    getRouterConfig.mockResolvedValue(null);
    await mount();
    expect(screen.getByText('not configured')).toBeTruthy(); // the null read landed
    expect(document.body.textContent).not.toContain(GUARD);
    expect(btn(/Add rule/).disabled).toBe(false);
    expect(btn(/Save routing/).disabled).toBe(false);
  });

  it('the retry re-reads and restores editing', async () => {
    getRouterConfig.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(STORED);
    await mount();
    expect(await screen.findByText(new RegExp(GUARD))).toBeTruthy();
    await act(async () => { fireEvent.click(btn(/Try again/)); });
    expect(await screen.findByText(RULE_CHIP)).toBeTruthy(); // the RE-read landed
    expect(getRouterConfig).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(GUARD);
    expect(btn(/Add rule/).disabled).toBe(false);
  });
});
