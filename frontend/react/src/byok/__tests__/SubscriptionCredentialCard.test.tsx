/**
 * RFC 0121 AT-OWN-RISK subscription-credential card (ADR 0180).
 *
 * Covers the two guarantees:
 *   1. The surface is HIDDEN when the host does not advertise the `subscription`
 *      auth mode (dark by default).
 *   2. When advertised, the bind is BLOCKED until the risk is acknowledged, and
 *      the FE sends `acknowledgedRisk:true` only after the checkbox is checked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../lib/byokClient.js', () => ({
  bindSubscriptionCredential: vi.fn().mockResolvedValue({ bound: true, scope: 'user', credentialRef: 'subscription:openai' }),
  connectCopilot: vi.fn().mockResolvedValue({ authorizeUrl: 'https://github.com/login/oauth/authorize?client_id=x' }),
  disconnectCopilot: vi.fn().mockResolvedValue({ disconnected: true }),
}));
vi.mock('../../client/runsClient.js', () => ({
  getCapabilities: vi.fn(),
}));
import { bindSubscriptionCredential, connectCopilot } from '../lib/byokClient.js';
import { getCapabilities } from '../../client/runsClient.js';
import { SubscriptionCredentialCard } from '../SubscriptionCredentialCard.js';

const DARK = { aiProviders: { byok: ['openai'], authModes: { openai: ['apiKey'] } } };
const LIT = { aiProviders: { byok: ['openai'], authModes: { openai: ['apiKey', 'subscription'] } } };
const COPILOT_ONLY = { aiProviders: { byok: ['openai', 'github.copilot'], authModes: { openai: ['apiKey'], 'github.copilot': ['subscription'] } } };

beforeEach(() => {
  vi.mocked(bindSubscriptionCredential).mockClear();
  vi.mocked(getCapabilities).mockReset();
});
afterEach(cleanup);

describe('SubscriptionCredentialCard (RFC 0121 at-own-risk)', () => {
  it('renders nothing when the host advertises no subscription mode (dark)', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(DARK as never);
    const { container } = render(<SubscriptionCredentialCard />);
    // Give the effect a tick; the card must stay hidden.
    await waitFor(() => expect(getCapabilities).toHaveBeenCalled());
    expect(container.querySelector('.surface-card')).toBeNull();
    expect(screen.queryByText('Bind subscription')).toBeNull();
  });

  it('blocks bind until the risk is acknowledged, then sends acknowledgedRisk:true', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(LIT as never);
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
    vi.mocked(getCapabilities).mockResolvedValue(COPILOT_ONLY as never);
    render(<SubscriptionCredentialCard />);
    await screen.findByText('Connect GitHub Copilot');
    expect(screen.queryByText('Bind subscription')).toBeNull();
    expect(screen.queryByLabelText(/I understand reusing my personal subscription/i)).toBeNull();
    expect(screen.getByText(/no permission scopes/i)).toBeTruthy();
  });

  it('Connect asks the host for the consent URL and navigates the browser there', async () => {
    vi.mocked(getCapabilities).mockResolvedValue(COPILOT_ONLY as never);
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
    const BOTH = { aiProviders: { byok: ['openai', 'github.copilot'], authModes: { openai: ['apiKey', 'subscription'], 'github.copilot': ['subscription'] } } };
    vi.mocked(getCapabilities).mockResolvedValue(BOTH as never);
    render(<SubscriptionCredentialCard />);
    await screen.findByText('Bind subscription');
    const options = [...document.querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['openai']);
    expect(screen.getByText('Connect GitHub Copilot')).toBeTruthy();
  });
});
