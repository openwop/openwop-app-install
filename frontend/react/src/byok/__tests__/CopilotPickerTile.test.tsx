/**
 * ADR 0757 follow-up — the chat provider picker offers GitHub Copilot, the
 * RFC 0121 cleared subscription provider, ONLY when the host serves it
 * (discovery advertises `github.copilot` with the subscription mode) AND the
 * user has connected it (`subscription:github.copilot` is a stored ref).
 * Picking it binds without a model or key step; removing the chat binding
 * unbinds it WITHOUT deleting the user's GitHub connection.
 *
 * Every "hides" case AWAITS the discovery promise before asserting absence: the tile
 * starts hidden while discovery is in flight, so an absence read before it settles
 * passes whatever the gate does (grade-tests w48).
 *
 * Sabotage that turns these red: dropping `storedRefs.includes(COPILOT_CREDENTIAL_REF)`
 * (ProviderGrid), `setAdvertised(true)` on a failed or dark discovery
 * (subscriptionProviders.ts), reading a mode other than `subscription`, confirming /
 * deleting the key / printing the ref on a subscription binding (ConfiguredProviderCard).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { HostCapabilities } from '../../client/capabilitiesV2Adapter.js';
import type { BYOKActiveConfig } from '../lib/useBYOKConfig.js';

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

const LIT: HostCapabilities = { aiProviders: { byok: ['openai', 'github.copilot'], authModes: { openai: ['apiKey'], 'github.copilot': ['subscription'] } } };
/** The v2 shape (ADR 0730 C.3): the per-provider map lives in this host's extension record. */
const LIT_V2: HostCapabilities = { extensions: { 'openwop-app.ai-providers': { subscriptionProviders: ['github.copilot'] } } };
const DARK: HostCapabilities = { aiProviders: { byok: ['openai'], authModes: { openai: ['apiKey'] } } };
const REF = 'subscription:github.copilot';

/** Answer discovery with `caps` and return a settle function that waits for the
 *  hook's `.then`/`.catch` to have run, so an absence check is made AFTER it. */
const discovery = (caps: Promise<HostCapabilities>) => {
  void caps.catch(() => undefined); // a rejected fixture is handled, not an unhandled rejection
  vi.mocked(getCapabilities).mockReturnValue(caps);
  return async () => {
    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    await act(async () => { await caps.catch(() => undefined); });
  };
};

beforeEach(() => {
  vi.mocked(getCapabilities).mockReset();
  deleteKey.mockReset().mockResolvedValue(undefined);
  clearActiveConfig.mockReset().mockResolvedValue(undefined);
  confirmSpy.mockClear();
});
afterEach(cleanup);

describe('ProviderGrid — GitHub Copilot tile', () => {
  it('offers Copilot when the host advertises it and the user has connected it; picking hands back the subscription provider', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(LIT);
    const onPick = vi.fn();
    render(<ProviderGrid isAuthed onPick={onPick} storedRefs={[REF]} />);
    const tile = await screen.findByRole('button', { name: /GitHub Copilot/ });
    fireEvent.click(tile);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'github.copilot', subscription: true }));
  });

  it('offers Copilot from the v2 extension record too (the shape a major-2 host serves)', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(LIT_V2);
    render(<ProviderGrid isAuthed onPick={vi.fn()} storedRefs={[REF]} />);
    expect(await screen.findByRole('button', { name: /GitHub Copilot/ })).toBeTruthy();
  });

  it('hides the tile when the user has not connected Copilot', async () => {
    const settled = discovery(Promise.resolve(LIT));
    render(<ProviderGrid isAuthed onPick={vi.fn()} storedRefs={['byok:openai']} />);
    await settled();
    expect(screen.queryByRole('button', { name: /GitHub Copilot/ })).toBeNull();
  });

  it('hides the tile when the host does not serve Copilot, even if a token is stored', async () => {
    const settled = discovery(Promise.resolve(DARK));
    render(<ProviderGrid isAuthed onPick={vi.fn()} storedRefs={[REF]} />);
    await settled();
    expect(screen.queryByRole('button', { name: /GitHub Copilot/ })).toBeNull();
  });

  it('hides the tile when discovery fails', async () => {
    const settled = discovery(Promise.reject(new Error('offline')));
    render(<ProviderGrid isAuthed onPick={vi.fn()} storedRefs={[REF]} />);
    await settled();
    expect(screen.queryByRole('button', { name: /GitHub Copilot/ })).toBeNull();
  });
});

describe('ConfiguredProviderCard — a Copilot binding', () => {
  const config: BYOKActiveConfig = { provider: 'github.copilot', model: 'default', credentialRef: REF };

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
