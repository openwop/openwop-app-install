/**
 * ADR 0990 D3 — the free-tier settings page.
 *
 * What it must do: a failed read offers a retry, never a form (a save is a full
 * replacement, the heartbeat page's #2683 lesson); the form is filled from the
 * stored setting; a provider with no key can't be chosen and points at the
 * Secrets Vault; switching provider resets the model to that provider's default
 * (a model id belongs to one provider); the test message sends the CANDIDATE on
 * screen; save sends exactly the fields shown.
 *
 * The read is a typed module mock; save and test are stubbed at the FETCH level,
 * so the route, method and whole body are asserted.
 *
 * Sabotage that turns it red (witnessed, wave 78): render the form on a failed
 * read; fill the provider, model or cap from anything but the stored setting;
 * enable a no-key option, or drop the vault notice; keep the old model on a
 * provider switch; test or save anything but the fields, or by another method.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { config } from '../../client/config.js';
import type { ManagedTierView } from '../../client/managedTierAdminClient.js';

type Client = typeof import('../../client/managedTierAdminClient.js');
const { getManagedTierSettings } = vi.hoisted(() => ({
  getManagedTierSettings: vi.fn<Client['getManagedTierSettings']>(),
}));
vi.mock('../../client/managedTierAdminClient.js', async (orig) => ({
  ...(await orig<Client>()),
  getManagedTierSettings,
}));

import { FreeTierSettingsPage } from '../FreeTierSettingsPage.js';

const SETTINGS_URL = `${config.baseUrl}/host/openwop-app/managed-tier/settings`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const requests = (): Array<[string, string | undefined, unknown]> =>
  fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined]);

const PROVIDERS: ManagedTierView['providers'] = [
  { provider: 'minimax', ready: true, keySource: 'env', vaultRef: 'free-tier:minimax', envKeyName: 'MINIMAX_API_KEY', defaultModel: 'MiniMax-M3' },
  { provider: 'anthropic', ready: false, keySource: null, vaultRef: 'free-tier:anthropic', envKeyName: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5-5' },
  { provider: 'openai', ready: true, keySource: 'vault', vaultRef: 'free-tier:openai', envKeyName: 'OPENAI_API_KEY', defaultModel: 'gpt-5.6-terra' },
  { provider: 'google', ready: false, keySource: null, vaultRef: 'free-tier:google', envKeyName: 'GOOGLE_API_KEY', defaultModel: 'gemini-3.8-flash' },
];
const VIEW: ManagedTierView = {
  config: null,
  effective: { provider: 'minimax', model: 'MiniMax-M3', source: 'default', ready: true },
  providers: PROVIDERS,
  vaultUsable: true,
};
/** A stored setting that differs from the env default in provider, model AND cap. */
const STORED: ManagedTierView = {
  config: { id: 'default', provider: 'openai', model: 'gpt-5.6-luna', dailyTokenCap: 1234 },
  effective: { provider: 'openai', model: 'gpt-5.6-luna', source: 'setting', ready: true },
  providers: PROVIDERS,
  vaultUsable: true,
};
/** What is serving has no key: the form opens on a provider that cannot run. */
const NO_KEY: ManagedTierView = {
  config: null,
  effective: { provider: 'anthropic', model: 'claude-sonnet-5-5', source: 'env', ready: false },
  providers: PROVIDERS,
  vaultUsable: true,
};

/** Mount and wait for the read to settle into the form (or its failure card). */
const mount = async (): Promise<void> => {
  render(<MemoryRouter><FreeTierSettingsPage /></MemoryRouter>);
  await waitFor(() => expect(getManagedTierSettings).toHaveBeenCalled());
  await screen.findByText(/Serving:|Could not load the free-tier setting/);
};
const providerSelect = (): HTMLSelectElement => screen.getByLabelText(/^Provider/) as HTMLSelectElement;
const modelInput = (): HTMLInputElement => screen.getByLabelText(/^Model/) as HTMLInputElement;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.resetAllMocks();
  getManagedTierSettings.mockResolvedValue(VIEW);
  vi.stubGlobal('fetch', fetchMock);
});

describe('free-tier settings page (ADR 0990)', () => {
  it('a failed read offers a retry, never a form', async () => {
    getManagedTierSettings.mockRejectedValueOnce(new Error('503'));
    await mount();
    expect(document.querySelector('form')).toBeNull();
    expect(document.body.textContent).toContain('Could not load the free-tier setting');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText(/^Provider/)).toBeTruthy();
    expect(document.querySelector('form')).not.toBeNull();
  });

  it('shows what is serving and fills the form from the read', async () => {
    getManagedTierSettings.mockResolvedValue(STORED);
    await mount();
    expect(document.body.textContent).toContain('Serving: OpenAI, model gpt-5.6-luna. Set on this page.');
    expect(providerSelect().value).toBe('openai');
    expect(modelInput().value).toBe('gpt-5.6-luna');
    expect((screen.getByLabelText(/^Daily allowance/) as HTMLInputElement).value).toBe('1234');
  });

  it('a provider with no key cannot be chosen', async () => {
    await mount();
    const options = Array.from(providerSelect().options);
    expect(options.find((o) => o.value === 'anthropic')).toMatchObject({ disabled: true, text: 'Anthropic (Claude) (no key)' });
    expect(options.find((o) => o.value === 'openai')).toMatchObject({ disabled: false, text: 'OpenAI (key in the Secrets Vault)' });
    expect(screen.queryByText(/has no key yet/)).toBeNull();
    // When what is serving has no key, the page points at the Secrets Vault and the exact name to use.
    cleanup();
    getManagedTierSettings.mockResolvedValue(NO_KEY);
    await mount();
    expect(screen.getByText(/Anthropic \(Claude\) has no key yet\. Add it in the Secrets Vault under Host-global scope, named free-tier:anthropic\./)).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Open the Secrets Vault' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/access?tab=connections', '/access?tab=connections']);
  });

  it('switching provider resets the model to that provider\'s default', async () => {
    await mount();
    fireEvent.change(providerSelect(), { target: { value: 'openai' } });
    expect(modelInput().value).toBe('gpt-5.6-terra');
  });

  it('the test message sends the candidate on screen and shows the reply', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true, provider: 'openai', model: 'gpt-5.6-luna', latencyMs: 420, reply: 'ready' }));
    await mount();
    fireEvent.change(providerSelect(), { target: { value: 'openai' } });
    fireEvent.change(modelInput(), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send a test message' }));
    expect(await screen.findByText(/OpenAI \(gpt-5\.6-luna\) replied in 420 ms/)).toBeTruthy();
    expect(requests()).toEqual([[`${SETTINGS_URL}/test`, 'POST', { provider: 'openai', model: 'gpt-5.6-luna' }]]);
  });

  it('save sends exactly the fields shown', async () => {
    fetchMock.mockResolvedValueOnce(json(200, VIEW));
    await mount();
    fireEvent.change(providerSelect(), { target: { value: 'openai' } });
    fireEvent.change(screen.getByLabelText(/^Daily allowance/), { target: { value: '50000' } });
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(requests()).toEqual([[SETTINGS_URL, 'PUT', { provider: 'openai', model: 'gpt-5.6-terra', dailyTokenCap: 50000 }]]);
  });
});
