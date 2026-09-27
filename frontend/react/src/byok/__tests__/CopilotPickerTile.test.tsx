/**
 * ADR 0757 follow-up — the chat provider picker offers GitHub Copilot, the
 * RFC 0121 cleared subscription provider, ONLY when the host serves it
 * (discovery advertises `github.copilot` with the subscription mode) AND the
 * user has connected it (`subscription:github.copilot` is a stored ref).
 * Picking it binds without a model or key step; removing the chat binding
 * unbinds it WITHOUT deleting the user's GitHub connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../client/runsClient.js', () => ({ getCapabilities: vi.fn() }));
const deleteKey = vi.fn();
const clearActiveConfig = vi.fn();
vi.mock('../lib/byokClient.js', () => ({
  deleteKey: (...a: unknown[]) => deleteKey(...a),
  clearActiveConfig: (...a: unknown[]) => clearActiveConfig(...a),
}));
const confirmSpy = vi.fn(() => Promise.resolve(true));
vi.mock('../../ui/confirm.js', () => ({ confirm: () => confirmSpy() }));

import { getCapabilities } from '../../client/runsClient.js';
const { ProviderGrid } = await import('../ProviderGrid.js');
const { ConfiguredProviderCard } = await import('../ConfiguredProviderCard.js');

const LIT = { aiProviders: { byok: ['openai', 'github.copilot'], authModes: { openai: ['apiKey'], 'github.copilot': ['subscription'] } } };
const DARK = { aiProviders: { byok: ['openai'], authModes: { openai: ['apiKey'] } } };
const REF = 'subscription:github.copilot';

beforeEach(() => {
  vi.mocked(getCapabilities).mockReset();
  deleteKey.mockReset().mockResolvedValue(undefined);
  clearActiveConfig.mockReset().mockResolvedValue(undefined);
  confirmSpy.mockClear();
});
afterEach(cleanup);

describe('ProviderGrid — GitHub Copilot tile', () => {
  it('offers Copilot when the host advertises it and the user has connected it; picking hands back the subscription provider', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(LIT as never);
    const onPick = vi.fn();
    render(<ProviderGrid isAuthed onPick={onPick} storedRefs={[REF]} />);
    const tile = await screen.findByRole('button', { name: /GitHub Copilot/ });
    fireEvent.click(tile);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'github.copilot', subscription: true }));
  });

  it('hides the tile when the user has not connected Copilot', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(LIT as never);
    render(<ProviderGrid isAuthed onPick={vi.fn()} storedRefs={['byok:openai']} />);
    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /GitHub Copilot/ })).toBeNull();
  });

  it('hides the tile when the host does not serve Copilot, even if a token is stored', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(DARK as never);
    render(<ProviderGrid isAuthed onPick={vi.fn()} storedRefs={[REF]} />);
    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /GitHub Copilot/ })).toBeNull();
  });

  it('hides the tile when discovery fails', async () => {
    vi.mocked(getCapabilities).mockRejectedValue(new Error('offline'));
    render(<ProviderGrid isAuthed onPick={vi.fn()} storedRefs={[REF]} />);
    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /GitHub Copilot/ })).toBeNull();
  });
});

describe('ConfiguredProviderCard — a Copilot binding', () => {
  const config = { provider: 'github.copilot', model: 'default', credentialRef: REF } as never;

  it('renders without the internal credentialRef, and "stop using" unbinds without deleting the connection', async () => {
    const onRemoved = vi.fn();
    render(<ConfiguredProviderCard config={config} stored onChange={vi.fn()} onRemoved={onRemoved} />);
    expect(screen.getByRole('heading', { name: 'GitHub Copilot' })).toBeTruthy();
    expect(screen.queryByText(REF)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /stop using/i }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(clearActiveConfig).toHaveBeenCalledTimes(1);
    expect(deleteKey).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
