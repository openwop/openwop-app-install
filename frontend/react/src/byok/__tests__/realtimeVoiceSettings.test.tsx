/**
 * ADR 0499 P5 — a configured-but-missing credentialRef must be VISIBLE.
 *
 * The select binds `value={credentialRef}` against the list of refs that still
 * exist. A ref whose secret was deleted matches no <option>, so the control
 * collapsed to the placeholder and the card read "not configured yet" rather
 * than "pointing at a key that is gone" — which is how a dead realtime-voice
 * binding hid here for a month while every session mint returned 400.
 *
 * Every "stays quiet" case waits for the config read to SETTLE before asserting
 * absence. The settle signal is the Save button: it is enabled only once
 * `load === 'ready'`. An absence check made earlier passes on the loading state
 * whatever the missing-ref rule does (grade-tests w48: the "provider off" case did).
 *
 * Sabotage that turns these red (RealtimeVoiceSettings.tsx): dropping either
 * `refIsMissing` render, dropping `!storedRefs.includes(credentialRef)` or
 * `needsKey` from `refIsMissing`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { RealtimeConfig } from '../../chat/voice/voiceClient.js';
import { getRealtimeConfig } from '../../chat/voice/voiceClient.js';
import { RealtimeVoiceSettings } from '../RealtimeVoiceSettings.js';

vi.mock('../../chat/voice/voiceClient.js', () => ({
  getRealtimeConfig: vi.fn(),
  setRealtimeConfig: vi.fn(),
}));

const mockGet = vi.mocked(getRealtimeConfig);
const answer = (c: RealtimeConfig): void => { mockGet.mockResolvedValue(c); };

/** The config read has landed: Save is enabled only when `load === 'ready'` and,
 *  for a provider that needs one, a key is selected. */
const settled = async (): Promise<void> => {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false));
};

beforeEach(() => { mockGet.mockReset(); });

describe('RealtimeVoiceSettings — missing credentialRef', () => {
  it('names the dangling ref instead of rendering a blank select', async () => {
    answer({ provider: 'gemini-live', credentialRef: 'google:myndhyve-key' });

    render(<RealtimeVoiceSettings storedRefs={['google:personal']} />);

    // The broken value stays selected and is labelled, rather than silently
    // falling back to the "Select a stored key…" placeholder.
    const option = await screen.findByRole('option', { name: 'google:myndhyve-key — missing' });
    expect((option as HTMLOptionElement).selected).toBe(true);
  });

  it('explains the consequence in an error notice', async () => {
    answer({ provider: 'gemini-live', credentialRef: 'google:myndhyve-key' });

    render(<RealtimeVoiceSettings storedRefs={['google:personal']} />);

    expect(await screen.findByText(/"google:myndhyve-key", but that key no longer exists/)).toBeTruthy();
  });

  it('stays quiet when the configured ref still exists', async () => {
    answer({ provider: 'gemini-live', credentialRef: 'google:personal' });

    render(<RealtimeVoiceSettings storedRefs={['google:personal']} />);

    await settled();
    expect((screen.getByRole('combobox', { name: 'API key' }) as HTMLSelectElement).value).toBe('google:personal');
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
    expect(screen.queryByRole('option', { name: /missing/ })).toBeNull();
  });

  it('stays quiet when the provider is off (no key needed)', async () => {
    answer({ provider: 'off', credentialRef: 'google:myndhyve-key' });

    render(<RealtimeVoiceSettings storedRefs={[]} />);

    await settled();
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
  });
});
