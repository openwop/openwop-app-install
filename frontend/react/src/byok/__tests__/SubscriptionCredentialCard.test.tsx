/**
 * RFC 0121 AT-OWN-RISK subscription-credential card (ADR 0180).
 *
 * Covers the two guarantees:
 *   1. The surface is HIDDEN when the host does not advertise the `subscription`
 *      auth mode (dark by default).
 *   2. When advertised, the bind is BLOCKED until the risk is acknowledged, and
 *      the FE sends `acknowledgedRisk:true` only after the checkbox is checked.
 *
 * The dark case AWAITS discovery before asserting absence: the card starts hidden
 * while discovery is in flight, so an earlier read passes whatever the gate does.
 * `onSubmit`'s own `if (!acknowledged …) return` sits behind the disabled button
 * (a disabled button cannot be clicked), so it is a double guard that no UI case
 * can reach; the BUTTON's `canSubmit` gate is the one witnessed here.
 *
 * Sabotage that turns these red: `providers.length === 0` dropped from the hide
 * gate; `acknowledged` dropped from `canSubmit`; cleared providers not filtered out
 * of the at-own-risk list; `connectCopilot` path / `location.assign` changed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import type { HostCapabilities } from '../../client/capabilitiesV2Adapter.js';

vi.mock('../lib/byokClient.js', () => ({
  bindSubscriptionCredential: vi.fn().mockResolvedValue({ bound: true, scope: 'user', credentialRef: 'subscription:openai' }),
  connectCopilot: vi.fn().mockResolvedValue({ authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=x' }),
  disconnectCopilot: vi.fn().mockResolvedValue({ disconnected: true }),
}));
vi.mock('../../client/runsClient.js', () => ({
  getCapabilities: vi.fn(),
}));
import { bindSubscriptionCredential, connectCopilot, disconnectCopilot } from '../lib/byokClient.js';
import { getCapabilities } from '../../client/runsClient.js';
import { SubscriptionCredentialCard } from '../SubscriptionCredentialCard.js';

const DARK: HostCapabilities = { aiProviders: { byok: ['openai'], authModes: { openai: ['apiKey'] } } };
const LIT: HostCapabilities = { aiProviders: { byok: ['openai'], authModes: { openai: ['apiKey', 'subscription'] } } };
const COPILOT_ONLY: HostCapabilities = { aiProviders: { byok: ['openai', 'github.copilot'], authModes: { openai: ['apiKey'], 'github.copilot': ['subscription'] } } };

beforeEach(() => {
  vi.mocked(bindSubscriptionCredential).mockReset().mockResolvedValue({ bound: true, scope: 'user', credentialRef: 'subscription:openai' });
  vi.mocked(connectCopilot).mockReset().mockResolvedValue({ authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=x' });
  vi.mocked(disconnectCopilot).mockReset().mockResolvedValue({ disconnected: true });
  vi.mocked(getCapabilities).mockReset();
});
afterEach(cleanup);

describe('SubscriptionCredentialCard (RFC 0121 at-own-risk)', () => {
  it('renders nothing when the host advertises no subscription mode (dark)', async () => {
    const caps = Promise.resolve(DARK);
    vi.mocked(getCapabilities).mockReturnValue(caps);
    const { container } = render(<SubscriptionCredentialCard />);
    // Wait for discovery to SETTLE (not merely be called); the card must stay hidden.
    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    await act(async () => { await caps; });
    expect(container.querySelector('.surface-card')).toBeNull();
    expect(screen.queryByText('Bind subscription')).toBeNull();
  });

  it('blocks bind until the risk is acknowledged, then sends acknowledgedRisk:true', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(LIT);
    render(<SubscriptionCredentialCard />);
    const bind = await screen.findByText('Bind subscription') as HTMLButtonElement;

    // The mandatory risk disclosure is present (Notice + the checkbox label).
    expect(screen.getAllByText(/terms of service|account suspension/i).length).toBeGreaterThan(0);

    // Enter a value but do NOT acknowledge → still disabled.
    fireEvent.change(screen.getByLabelText(/Subscription credential/i), { target: { value: 'sk-personal' } });
    expect(bind.disabled).toBe(true);

    // Acknowledge the risk → enabled.
    fireEvent.click(screen.getByLabelText(/I understand reusing my personal subscription/i));
    expect(bind.disabled).toBe(false);

    fireEvent.click(bind);
    await waitFor(() => expect(bindSubscriptionCredential).toHaveBeenCalledWith({
      provider: 'openai',
      value: 'sk-personal',
      acknowledgedRisk: true,
    }));
  });
});

describe('CopilotConnectCard (RFC 0121 cleared provider, ADR 0757)', () => {
  it('a cleared provider gets a Connect button — no paste field, no ToS-risk checkbox', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(COPILOT_ONLY);
    render(<SubscriptionCredentialCard />);
    await screen.findByText('Connect GitHub Copilot');
    expect(screen.queryByText('Bind subscription')).toBeNull();
    expect(screen.queryByLabelText(/I understand reusing my personal subscription/i)).toBeNull();
    expect(screen.getByText(/no permission scopes/i)).toBeTruthy();
  });

  it('Connect asks the host for the consent URL and navigates the browser there', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(COPILOT_ONLY);
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign, pathname: '/keys', search: '', hash: '' } });
    try {
      render(<SubscriptionCredentialCard />);
      fireEvent.click(await screen.findByText('Connect GitHub Copilot'));
      await waitFor(() => expect(connectCopilot).toHaveBeenCalledWith('/keys'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=x'));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('the cleared provider never appears in the at-own-risk provider picker', async () => {
    const BOTH: HostCapabilities = { aiProviders: { byok: ['openai', 'github.copilot'], authModes: { openai: ['apiKey', 'subscription'], 'github.copilot': ['subscription'] } } };
    vi.mocked(getCapabilities).mockResolvedValue(BOTH);
    render(<SubscriptionCredentialCard />);
    await screen.findByText('Bind subscription');
    const options = [...document.querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['openai']);
    expect(screen.getByText('Connect GitHub Copilot')).toBeTruthy();
  });
});
