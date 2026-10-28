/**
 * ADR 0990 D3 — the free-tier settings page.
 *
 * What it must do: a failed read offers a retry, never a form (a save is a full
 * replacement, the heartbeat page's #2683 lesson); a provider with no key can't
 * be chosen and points at the Secrets Vault; switching provider resets the model
 * to that provider's default (a model id belongs to one provider); the test
 * message sends the CANDIDATE on screen; save sends exactly the fields shown.
 *
 * Sabotage that turns it red: render the form on a failed read; enable a no-key
 * option; keep the old model on a provider switch; test or save anything but
 * the fields.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ManagedTierView } from '../../client/managedTierAdminClient.js';

type Client = typeof import('../../client/managedTierAdminClient.js');
const { getManagedTierSettings, saveManagedTierSettings, testManagedTierCandidate, clearManagedTierSettings } = vi.hoisted(() => ({
  getManagedTierSettings: vi.fn<Client['getManagedTierSettings']>(),
  saveManagedTierSettings: vi.fn<Client['saveManagedTierSettings']>(),
  testManagedTierCandidate: vi.fn<Client['testManagedTierCandidate']>(),
  clearManagedTierSettings: vi.fn<Client['clearManagedTierSettings']>(),
}));
vi.mock('../../client/managedTierAdminClient.js', async (orig) => ({
  ...(await orig<Client>()),
  getManagedTierSettings, saveManagedTierSettings, testManagedTierCandidate, clearManagedTierSettings,
}));

import { FreeTierSettingsPage } from '../FreeTierSettingsPage.js';

const VIEW: ManagedTierView = {
  config: null,
  effective: { provider: 'minimax', model: 'MiniMax-M3', source: 'default', ready: true },
  providers: [
    { provider: 'minimax', ready: true, keySource: 'env', vaultRef: 'free-tier:minimax', envKeyName: 'MINIMAX_API_KEY', defaultModel: 'MiniMax-M3' },
    { provider: 'anthropic', ready: false, keySource: null, vaultRef: 'free-tier:anthropic', envKeyName: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5-5' },
    { provider: 'openai', ready: true, keySource: 'vault', vaultRef: 'free-tier:openai', envKeyName: 'OPENAI_API_KEY', defaultModel: 'gpt-5.6-terra' },
    { provider: 'google', ready: false, keySource: null, vaultRef: 'free-tier:google', envKeyName: 'GOOGLE_API_KEY', defaultModel: 'gemini-3.8-flash' },
  ],
  vaultUsable: true,
};

const mount = async (): Promise<void> => {
  render(<MemoryRouter><FreeTierSettingsPage /></MemoryRouter>);
  await act(async () => {});
};
const providerSelect = (): HTMLSelectElement => screen.getByLabelText(/^Provider/) as HTMLSelectElement;
const modelInput = (): HTMLInputElement => screen.getByLabelText(/^Model/) as HTMLInputElement;

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  getManagedTierSettings.mockResolvedValue(VIEW);
  saveManagedTierSettings.mockResolvedValue(VIEW);
});

describe('free-tier settings page (ADR 0990)', () => {
  it('a failed read offers a retry, never a form', async () => {
    getManagedTierSettings.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.querySelector('form')).toBeNull();
    expect(document.body.textContent).toContain('Could not load the free-tier setting');
  });

  it('shows what is serving and fills the form from the read', async () => {
    await mount();
    expect(document.body.textContent).toContain('Serving: MiniMax, model MiniMax-M3.');
    expect(providerSelect().value).toBe('minimax');
    expect(modelInput().value).toBe('MiniMax-M3');
  });

  it('a provider with no key cannot be chosen', async () => {
    await mount();
    const options = Array.from(providerSelect().options);
    expect(options.find((o) => o.value === 'anthropic')).toMatchObject({ disabled: true, text: 'Anthropic (Claude) (no key)' });
    expect(options.find((o) => o.value === 'openai')).toMatchObject({ disabled: false, text: 'OpenAI (key in the Secrets Vault)' });
  });

  it('switching provider resets the model to that provider\'s default', async () => {
    await mount();
    fireEvent.change(providerSelect(), { target: { value: 'openai' } });
    expect(modelInput().value).toBe('gpt-5.6-terra');
  });

  it('the test message sends the candidate on screen and shows the reply', async () => {
    testManagedTierCandidate.mockResolvedValue({ ok: true, provider: 'openai', model: 'gpt-5.6-luna', latencyMs: 420, reply: 'ready' });
    await mount();
    fireEvent.change(providerSelect(), { target: { value: 'openai' } });
    fireEvent.change(modelInput(), { target: { value: 'gpt-5.6-luna' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send a test message' })); });
    expect(testManagedTierCandidate).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6-luna' });
    expect(document.body.textContent).toContain('OpenAI (gpt-5.6-luna) replied in 420 ms');
    expect(saveManagedTierSettings).not.toHaveBeenCalled();
  });

  it('save sends exactly the fields shown', async () => {
    await mount();
    fireEvent.change(providerSelect(), { target: { value: 'openai' } });
    fireEvent.change(screen.getByLabelText(/^Daily allowance/), { target: { value: '50000' } });
    await act(async () => { fireEvent.submit(document.querySelector('form')!); });
    expect(saveManagedTierSettings).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6-terra', dailyTokenCap: 50000 });
  });
});
