/**
 * ADR 0916 (Book AI P8) — a key pasted under the wrong vendor's card is caught
 * before it saves. Red under: matching the SHORTER prefix (`sk-` beats
 * `sk-ant-`), saving the mismatched key without a choice, or the switch losing
 * the pasted key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type * as ByokClient from '../lib/byokClient.js';
import { detectProviderByKeyPrefix } from '../keyPrefix.js';

const access = { current: { access: { basis: 'tenant-owner', scopes: [] as string[] }, resolved: true } };
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<object>()),
  useEffectiveAccessState: () => access.current,
}));
const listStoredRefs = vi.fn<typeof ByokClient.listStoredRefs>();
const storeKey = vi.fn<typeof ByokClient.storeKey>();
vi.mock('../lib/byokClient.js', async (orig) => ({
  ...(await orig<object>()),
  listStoredRefs: () => listStoredRefs(),
  storeKey: (...a: Parameters<typeof ByokClient.storeKey>) => storeKey(...a),
  getActiveConfig: () => Promise.resolve({ config: null, valid: false, anonymous: false }),
  getAiDefault: () => Promise.resolve(null),
}));
vi.mock('../../chrome/hubContext.js', () => ({ useHub: () => ({ embedded: true }) }));
vi.mock('../SubscriptionCredentialCard.js', () => ({ SubscriptionCredentialCard: () => null }));

const { KeysPage } = await import('../KeysPage.js');

beforeEach(() => {
  storeKey.mockReset().mockResolvedValue({ credentialRef: 'x:y', masked: '••••' } as never);
  listStoredRefs.mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

describe('detectProviderByKeyPrefix', () => {
  const P = [{ id: 'openai', apiKeyPrefix: 'sk-' }, { id: 'anthropic', apiKeyPrefix: 'sk-ant-' }, { id: 'google', apiKeyPrefix: 'AIza' }, { id: 'compat' }];
  it('the longest prefix wins, and an unknown key matches nothing', () => {
    expect(detectProviderByKeyPrefix('sk-ant-abc', P)?.id).toBe('anthropic');
    expect(detectProviderByKeyPrefix('sk-proj-abc', P)?.id).toBe('openai');
    expect(detectProviderByKeyPrefix('  AIzaXYZ ', P)?.id).toBe('google');
    expect(detectProviderByKeyPrefix('org-key-123', P)).toBeNull();
    expect(detectProviderByKeyPrefix('', P)).toBeNull();
  });
});

async function openAnthropicForm() {
  render(<KeysPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Add Anthropic key/ }));
  // The label field is the form's only textbox (the key input is a password field).
  fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'my key' } });
}
const keyInput = () => document.querySelector('input[type="password"]') as HTMLInputElement;

describe('KeysPage — a key under the wrong card (ADR 0916)', () => {
  it('a Google key on the Anthropic card is not saved without a choice', async () => {
    await openAnthropicForm();
    fireEvent.change(keyInput(), { target: { value: 'AIzaSyTESTKEY' } });
    expect(screen.getByText(/looks like a Google/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }));
    await waitFor(() => expect(screen.getByText(/Add it under Google, or choose to keep it under Anthropic/)).toBeTruthy());
    expect(storeKey).not.toHaveBeenCalled();
  });

  it('switching carries the pasted key to the Google card', async () => {
    await openAnthropicForm();
    fireEvent.change(keyInput(), { target: { value: 'AIzaSyTESTKEY' } });
    fireEvent.click(screen.getByRole('button', { name: /Add it under Google/ }));
    await waitFor(() => expect(keyInput().value).toBe('AIzaSyTESTKEY'));
    expect(screen.queryByText(/looks like a/)).toBeNull();
  });

  it('keeping it here is an explicit choice, then it saves under this card', async () => {
    await openAnthropicForm();
    fireEvent.change(keyInput(), { target: { value: 'AIzaSyTESTKEY' } });
    fireEvent.click(screen.getByRole('button', { name: /Keep it under Anthropic/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }));
    await waitFor(() => expect(storeKey).toHaveBeenCalledTimes(1));
    expect(storeKey.mock.calls[0]![0]).toMatch(/^anthropic:/);
  });

  it('an Anthropic key on the Anthropic card saves directly (no false alarm from the shorter sk-)', async () => {
    await openAnthropicForm();
    fireEvent.change(keyInput(), { target: { value: 'sk-ant-TESTKEY' } });
    expect(screen.queryByText(/looks like a/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }));
    await waitFor(() => expect(storeKey).toHaveBeenCalledTimes(1));
  });
});
