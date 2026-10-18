/**
 * ADR 0517 fixes A + B — the key step is where duplicate secrets were actually
 * minted.
 *
 * It used to compute `byok:${provider}:${Date.now()}` on every submit and never
 * look at what the workspace already had. So each false "you need a key" prompt
 * produced ANOTHER secret row rather than re-binding the existing one; the reported
 * workspace collected seven Google keys over five weeks. Two properties now hold:
 * an existing key is OFFERED rather than re-asked, and a deliberate replacement
 * OVERWRITES the ref the chat is bound to.
 *
 * Sabotage that turns these red (KeyEntry.tsx): adopting by storing again; offering
 * a saved key when none exists; a timestamped ref; reporting a failed store as
 * success.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type * as ByokClient from '../lib/byokClient.js';
import { getProvider } from '../lib/providers.js';
import { ApiError } from '../../client/requestJson.js';

const storeKey = vi.fn<typeof ByokClient.storeKey>();
vi.mock('../lib/byokClient.js', () => ({ storeKey: (...a: Parameters<typeof ByokClient.storeKey>) => storeKey(...a) }));

const { KeyEntry } = await import('../KeyEntry.js');

const provider = getProvider('google');
const model = provider.models[0]!;

beforeEach(() => { storeKey.mockReset().mockResolvedValue({ credentialRef: 'byok:google', masked: '••' }); });
afterEach(cleanup);

describe('KeyEntry — reuse before re-ask (fix A)', () => {
  it('offers a saved key as the primary action, and binds it WITHOUT storing again', async () => {
    const onStored = vi.fn();
    render(
      <KeyEntry
        provider={provider} model={model} onBack={vi.fn()} onStored={onStored}
        targetRef="byok:google:1785358774187" existingRef="byok:google:1785358774187"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /use my saved key/i }));
    await waitFor(() => expect(onStored).toHaveBeenCalledWith('byok:google:1785358774187'));
    // The whole point: no new secret is written. This is the call that created
    // seven rows.
    expect(storeKey).not.toHaveBeenCalled();
  });

  it('does not mention a saved key when the workspace genuinely has none', () => {
    render(
      <KeyEntry
        provider={provider} model={model} onBack={vi.fn()} onStored={vi.fn()}
        targetRef="byok:google"
      />,
    );
    expect(screen.queryByRole('button', { name: /use my saved key/i })).toBeNull();
    expect(screen.getByRole('button', { name: /store key/i })).toBeTruthy();
  });
});

describe('KeyEntry — deterministic ref (fix B)', () => {
  it('stores under the given ref, never a fresh timestamped one', async () => {
    const onStored = vi.fn();
    render(
      <KeyEntry provider={provider} model={model} onBack={vi.fn()} onStored={onStored} targetRef="byok:google" />,
    );

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'AIza-fresh' } });
    fireEvent.click(screen.getByRole('button', { name: /store key/i }));

    await waitFor(() => expect(storeKey).toHaveBeenCalledWith('byok:google', 'AIza-fresh'));
    // The old shape. If this ever reappears, every re-entry orphans the last key.
    expect(storeKey.mock.calls[0]![0]).not.toMatch(/byok:google:\d{10,}/);
    expect(onStored).toHaveBeenCalledWith('byok:google');
  });

  it('a deliberate REPLACEMENT overwrites the bound ref rather than orphaning it', async () => {
    render(
      <KeyEntry
        provider={provider} model={model} onBack={vi.fn()} onStored={vi.fn()}
        targetRef="byok:google:1785358774187" existingRef="byok:google:1785358774187"
      />,
    );

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'AIza-replacement' } });
    fireEvent.click(screen.getByRole('button', { name: /replace key/i }));

    await waitFor(() => expect(storeKey).toHaveBeenCalledWith('byok:google:1785358774187', 'AIza-replacement'));
  });

  it('surfaces a store failure instead of reporting success', async () => {
    const onStored = vi.fn();
    // The shape `requestJson` actually throws: an ApiError carrying the server sentence.
    storeKey.mockRejectedValue(new ApiError({ status: 400, statusText: 'Bad Request', url: '/host/openwop-app/byok/secrets', body: { error: 'validation_error', message: 'provider rejected the key' } }));
    render(
      <KeyEntry provider={provider} model={model} onBack={vi.fn()} onStored={onStored} targetRef="byok:google" />,
    );

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /store key/i }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/provider rejected the key/));
    expect(onStored).not.toHaveBeenCalled();
  });
});
