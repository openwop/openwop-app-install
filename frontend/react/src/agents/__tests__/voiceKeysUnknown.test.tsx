/**
 * FRGATE-5 — a failed key read must not tell you to go create a key you have.
 *
 * `listStoredRefs().catch(() => [])` fed the BYOK credential-ref picker, and an
 * empty list rendered:
 *
 *     voiceNoKeys: "No keys stored yet — add one on the Keys page, then pick it here."
 *
 * On a FAILED read that is an instructive positive claim — the exact shape
 * `check-failed-read-sentinels.mjs` names by example ("create one first") — and
 * it sends the user off to duplicate a key they may already have stored.
 *
 * The read still fails SOFT on purpose: the rest of the panel (provider, voice
 * id, save) works without it. What changed is that the claim now knows the
 * difference between "none" and "unknown".
 *
 * The select stays ENABLED deliberately. Its placeholder option ("no key") is a
 * legitimate choice that does not depend on this read, so disabling it would
 * remove a working option because a DIFFERENT read failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { getAgentProfile, putAgentProfile, listStoredRefs } = vi.hoisted(() => ({
  getAgentProfile: vi.fn(), putAgentProfile: vi.fn(), listStoredRefs: vi.fn(),
}));
vi.mock('../rosterClient.js', async (orig) => ({
  ...(await orig<typeof import('../rosterClient.js')>()),
  getAgentProfile, putAgentProfile,
}));
vi.mock('../../byok/lib/byokClient.js', async (orig) => ({
  ...(await orig<typeof import('../../byok/lib/byokClient.js')>()),
  listStoredRefs,
}));

import { AgentVoicePanel } from '../AgentVoicePanel.js';

// A BYOK provider, so the credential-ref picker actually renders.
const PROFILE = { configParameters: { voice: { provider: 'elevenlabs', voiceId: 'v1', credentialRef: '' } } };

const mount = async (): Promise<void> => {
  render(<AgentVoicePanel rosterId="agent-1" />);
  await act(async () => {});
};

const UNKNOWN = /couldn.t be read|it is unknown/i;
const NO_KEYS = /No keys stored yet/i;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  getAgentProfile.mockResolvedValue(PROFILE);
});

describe('FRGATE-5 — "no keys" vs "keys unknown"', () => {
  it('read FAILS: says UNKNOWN with a retry, and NEVER the go-create-one line', async () => {
    listStoredRefs.mockRejectedValue(new Error('503'));
    await mount();

    expect(screen.getByText(UNKNOWN)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeTruthy();
    // THE DEFECT: this told the user to create a key they may already have.
    expect(screen.queryByText(NO_KEYS)).toBeNull();
  });

  it('read SUCCEEDS with []: the genuine "none yet" instruction SURVIVES', async () => {
    listStoredRefs.mockResolvedValue([]);
    await mount();

    expect(screen.getByText(NO_KEYS)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN)).toBeNull();
  });

  it('the select stays ENABLED on failure — the placeholder is still a valid choice', async () => {
    listStoredRefs.mockRejectedValue(new Error('503'));
    await mount();

    const select = screen.getAllByRole('combobox').at(-1) as HTMLSelectElement | undefined;
    expect(select).toBeTruthy();
    expect(select?.disabled).toBe(false);
  });

  it('retry RE-RUNS only the key read and recovers', async () => {
    listStoredRefs.mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(['byok:eleven']);
    await mount();

    expect(screen.getByText(UNKNOWN)).toBeTruthy();
    const profileCalls = getAgentProfile.mock.calls.length;

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /try again|retry/i })); });

    expect(screen.queryByText(UNKNOWN)).toBeNull();
    // Only the refs read re-runs: re-reading the profile would discard edits the
    // user made to provider/voiceId since load.
    expect(getAgentProfile.mock.calls.length).toBe(profileCalls);
  });
});
