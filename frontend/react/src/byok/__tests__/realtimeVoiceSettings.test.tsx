/**
 * ADR 0499 P5 — a configured-but-missing credentialRef must be VISIBLE.
 *
 * The select binds `value={credentialRef}` against the list of refs that still
 * exist. A ref whose secret was deleted matches no <option>, so the control
 * collapsed to the placeholder and the card read "not configured yet" rather
 * than "pointing at a key that is gone" — which is how a dead realtime-voice
 * binding hid here for a month while every session mint returned 400.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RealtimeVoiceSettings } from '../RealtimeVoiceSettings.js';

vi.mock('../../chat/voice/voiceClient.js', () => ({
  getRealtimeConfig: vi.fn(),
  setRealtimeConfig: vi.fn(),
}));

const { getRealtimeConfig } = await import('../../chat/voice/voiceClient.js') as unknown as {
  getRealtimeConfig: ReturnType<typeof vi.fn>;
};

afterEach(() => { vi.clearAllMocks(); });

describe('RealtimeVoiceSettings — missing credentialRef', () => {
  it('names the dangling ref instead of rendering a blank select', async () => {
    getRealtimeConfig.mockResolvedValue({ provider: 'gemini-live', credentialRef: 'google:myndhyve-key' });

    render(<RealtimeVoiceSettings storedRefs={['google:personal']} />);

    // The broken value stays selected and is labelled, rather than silently
    // falling back to the "Select a stored key…" placeholder.
    const option = await screen.findByRole('option', { name: /google:myndhyve-key.*missing/i });
    expect((option as HTMLOptionElement).selected).toBe(true);
  });

  it('explains the consequence in an error notice', async () => {
    getRealtimeConfig.mockResolvedValue({ provider: 'gemini-live', credentialRef: 'google:myndhyve-key' });

    render(<RealtimeVoiceSettings storedRefs={['google:personal']} />);

    expect(await screen.findByText(/no longer exists/i)).toBeTruthy();
  });

  it('stays quiet when the configured ref still exists', async () => {
    getRealtimeConfig.mockResolvedValue({ provider: 'gemini-live', credentialRef: 'google:personal' });

    render(<RealtimeVoiceSettings storedRefs={['google:personal']} />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: /key/i })).toBeTruthy());
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
  });

  it('stays quiet when the provider is off (no key needed)', async () => {
    getRealtimeConfig.mockResolvedValue({ provider: 'off', credentialRef: 'google:myndhyve-key' });

    render(<RealtimeVoiceSettings storedRefs={[]} />);

    await waitFor(() => expect(screen.queryByText(/no longer exists/i)).toBeNull());
  });
});
