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
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { getRouterConfig, setRouterConfig, listOrgs } = vi.hoisted(() => ({
  getRouterConfig: vi.fn(), setRouterConfig: vi.fn(), listOrgs: vi.fn(),
}));
vi.mock('../modelRouterClient.js', async (orig) => ({
  ...(await orig<typeof import('../modelRouterClient.js')>()),
  getRouterConfig, setRouterConfig, listOrgs,
}));

import { ModelRouterPage } from '../ModelRouterPage.js';

const STORED = {
  enabled: true,
  config: {
    // The real RoutingRule shape — `when: RuleCondition` (a tagged union with
    // `kind`), not a `match` object. A wrong fixture throws in render and every
    // assertion below fails for the wrong reason.
    rules: [{ when: { kind: 'always' as const }, target: { provider: 'anthropic', model: 'claude-3' } }],
    fallback: { provider: 'openai', model: 'gpt-4o' },
  },
};

const mount = async (): Promise<void> => {
  render(<ModelRouterPage />);
  await act(async () => {});
};

const btn = (re: RegExp): HTMLButtonElement | undefined =>
  screen.queryAllByRole('button').find((b) => re.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

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
    expect(document.body.textContent).toContain('saving now would replace every stored rule');
    expect(btn(/Add rule/)?.disabled).toBe(true);
    expect(btn(/Save routing/)?.disabled).toBe(true);
  });

  it('no write reaches the server even if a control is driven directly', async () => {
    getRouterConfig.mockRejectedValue(new Error('503'));
    await mount();
    const save = btn(/Save routing/);
    if (save) await act(async () => { fireEvent.click(save); });
    // The whole point: the empty in-memory config must never be persisted over
    // the real one.
    expect(setRouterConfig).not.toHaveBeenCalled();
  });

  it('a SUCCESSFUL read leaves the editor fully usable', async () => {
    // The failure mode of this fix is bricking the page for everyone.
    await mount();
    expect(document.body.textContent).not.toContain('saving now would replace every stored rule');
    expect(btn(/Add rule/)?.disabled).toBe(false);
    expect(btn(/Save routing/)?.disabled).toBe(false);
  });

  it('a tenant with NO config yet can still be edited', async () => {
    // `null` means "read fine, nothing stored" — writing there creates the
    // config and destroys nothing. It must not be confused with a failed read.
    getRouterConfig.mockResolvedValue(null);
    await mount();
    expect(document.body.textContent).not.toContain('saving now would replace every stored rule');
    expect(btn(/Add rule/)?.disabled).toBe(false);
  });

  it('the retry re-reads and restores editing', async () => {
    getRouterConfig.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(STORED);
    await mount();
    await act(async () => { fireEvent.click(btn(/Try again/)!); });
    expect(document.body.textContent).not.toContain('saving now would replace every stored rule');
    expect(btn(/Add rule/)?.disabled).toBe(false);
  });
});
