/**
 * UX_UPGRADE-model-router MR-G1 — a failed config read must disable the writes,
 * not merely report itself. ADR 1016 D2 — a caller without the write authority
 * gets a read-only page, not writes the server will refuse.
 *
 * Every mutating control on this page sends the WHOLE config:
 * `persist(rules, fallback)` / `persist([...rules, rule], …)`. When
 * `getRouterConfig` failed, the page kept its initial `rules = []` and showed an
 * error — but "Add rule", "Save" and per-rule "Remove" all stayed enabled.
 * Clicking any of them wrote the empty list back, **silently replacing every
 * stored routing rule**.
 *
 * (The pre-1016 case "Remove is disabled when a second org's read fails with the
 * first org's rows on screen" is gone with the org picker: the config is the
 * workspace's, read once, and a failed read never leaves rows on screen.)
 *
 * Breaks if any write (Add rule, Save) is enabled while the read has failed, if
 * the guard over-fires and disables a page whose read succeeded (or found no
 * config), if a non-admin is offered Add/Remove/Save, or if a read-only page
 * stops saying why.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { StoredRouterConfig } from '../modelRouterClient.js';

const { getRouterConfig, setRouterConfig } = vi.hoisted(() => ({
  getRouterConfig: vi.fn(), setRouterConfig: vi.fn(),
}));
vi.mock('../modelRouterClient.js', async (orig) => ({
  ...(await orig<typeof import('../modelRouterClient.js')>()),
  getRouterConfig, setRouterConfig,
}));

import { ModelRouterPage } from '../ModelRouterPage.js';

const STORED: StoredRouterConfig = {
  enabled: true,
  config: {
    rules: [{ when: { kind: 'always' }, target: { provider: 'anthropic', model: 'claude-opus-5-5' } }],
    fallback: { provider: 'openai', model: 'gpt-5.5' },
  },
};

const GUARD = 'saving now would replace every stored rule';
/** The catalog label the rule chip renders for `claude-opus-5-5`. */
const RULE_CHIP = /Claude Opus 5\.5/;

/** Render and wait until the config READ has been issued and settled. */
const mount = async (): Promise<void> => {
  render(<ModelRouterPage />);
  await vi.waitFor(() => expect(getRouterConfig).toHaveBeenCalled());
  await act(async () => {});
};

const btn = (name: RegExp | string): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name });

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getRouterConfig.mockResolvedValue({ stored: STORED, canManage: true });
  setRouterConfig.mockResolvedValue(STORED);
});

describe('MR-G1 — a failed read disables the writes', () => {
  it('offers no write at all, and says why', async () => {
    getRouterConfig.mockRejectedValue(new Error('503 upstream'));
    await mount();
    expect(await screen.findByText(new RegExp(GUARD))).toBeTruthy();
    // A failed read cannot know the caller's authority, so the editor is not offered.
    expect(screen.queryByRole('button', { name: /Add rule/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    expect(setRouterConfig).not.toHaveBeenCalled();
  });

  it('a SUCCESSFUL read leaves the editor fully usable', async () => {
    await mount();
    expect((await screen.findAllByText(RULE_CHIP)).length).toBeGreaterThan(0); // the read LANDED
    expect(document.body.textContent).not.toContain(GUARD);
    expect(btn(/Add rule/).disabled).toBe(false);
    expect(btn('Remove rule 1').disabled).toBe(false);
    // The fallback's Save is enabled only once there is something to save (MR66UX-6).
    expect(btn(/^Save$/).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Send these messages to a fallback model/ }));
    expect(btn(/^Save$/).disabled).toBe(false);
    expect(screen.getByText('unsaved')).toBeTruthy();
  });

  it('an unsaved fallback edit survives a rule save (MR66UX-6)', async () => {
    // A FRESH object per save, as the network gives: the defect keyed on identity.
    setRouterConfig.mockImplementation(async () => structuredClone(STORED));
    await mount();
    fireEvent.click(screen.getByRole('checkbox', { name: /Send these messages to a fallback model/ })); // untick: unsaved
    await act(async () => { fireEvent.click(btn(/Add rule/)); });
    expect(setRouterConfig).toHaveBeenCalledTimes(1);
    // The rule save handed back a NEW fallback object with the same values; the
    // unsaved untick must still be on screen.
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Send these messages to a fallback model/ }).checked).toBe(false);
    expect(screen.getByText('unsaved')).toBeTruthy();
  });

  it('Add rule writes the stored rules PLUS the new one (never a partial list)', async () => {
    await mount();
    await act(async () => { fireEvent.click(btn(/Add rule/)); });
    expect(setRouterConfig).toHaveBeenCalledTimes(1);
    const sent = setRouterConfig.mock.calls[0]![0] as StoredRouterConfig['config'];
    expect(sent.rules).toHaveLength(2);
    expect(sent.rules[0]).toEqual(STORED.config.rules[0]);
    expect(sent.fallback).toEqual(STORED.config.fallback);
  });

  it('a workspace with NO config yet can still be edited', async () => {
    getRouterConfig.mockResolvedValue({ stored: null, canManage: true });
    await mount();
    expect(screen.getByText('not configured')).toBeTruthy(); // the null read landed
    expect(document.body.textContent).not.toContain(GUARD);
    expect(btn(/Add rule/).disabled).toBe(false);
  });

  it('the retry re-reads and restores editing', async () => {
    getRouterConfig.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce({ stored: STORED, canManage: true });
    await mount();
    expect(await screen.findByText(new RegExp(GUARD))).toBeTruthy();
    await act(async () => { fireEvent.click(btn(/Try again/)); });
    expect((await screen.findAllByText(RULE_CHIP)).length).toBeGreaterThan(0); // the RE-read landed
    expect(getRouterConfig).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(GUARD);
    expect(btn(/Add rule/).disabled).toBe(false);
  });
});

describe('ADR 1016 D2 — a caller who cannot manage keys sees routing read-only', () => {
  it('no Add / Remove / Save, the rules and fallback still shown, and the reason given', async () => {
    getRouterConfig.mockResolvedValue({ stored: STORED, canManage: false });
    await mount();
    expect((await screen.findAllByText(RULE_CHIP)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Only people who manage this workspace.s API keys can change routing/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add rule/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove rule/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    expect(screen.getByText(/Use OpenAI/)).toBeTruthy(); // the fallback, read-only
    // The on/off switch is disabled, not hidden: members can see whether it is on.
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Use routing in this workspace/ }).disabled).toBe(true);
  });
});

describe('MR66UX-1 — a preview answer never outlives the question it answered', () => {
  it('changing the provider after Test clears the answer instead of relabelling it', async () => {
    const spy = vi.spyOn(await import('../modelRouterClient.js'), 'previewRoute');
    spy.mockResolvedValue({ enabled: true, why: 'routed', decision: { reason: 'rule', ruleIndex: 0, target: { provider: 'anthropic', model: 'claude-opus-5-5' } } });
    await mount();
    await act(async () => { fireEvent.click(btn(/^Test$/)); });
    expect(await screen.findByText(/Rule 1 sends it to/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/The conversation.s key is for/), { target: { value: 'openai' } });
    expect(screen.queryByText(/Rule 1 sends it to/)).toBeNull();
    spy.mockRestore();
  });
});
