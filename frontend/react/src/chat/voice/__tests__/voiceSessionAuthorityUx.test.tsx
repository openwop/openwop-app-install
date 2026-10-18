/**
 * ADR 0893 — the user-visible half of voice session authority (feature loop row 47,
 * grade-ux VOX2UX-1/3/6).
 *
 *  - VOX2UX-3: a call ended because its opener lost access renders as a WARNING with
 *    role=alert and its localized string, not as a benign info note.
 *  - VOX2UX-6: a 403 on a held approval is "you may not answer this", not "gone" —
 *    the card stays pending for the person who may.
 *  - VOX2UX-1: an OpenAI call the host hangs up ends on the client too (mic released,
 *    the hook is told), instead of "In conversation" with a live mic.
 *  - VOX2UX-9: a failed realtime-settings read never offers Save over a guessed "Off";
 *    Retry re-reads, and Save returns only over a config that was actually read.
 *
 * Sabotage-witnessed (wave 51): drop `voice-revoked` from the warning kinds or its
 * localized string → VOX2UX-3 red; map 403 to an error/"gone" → VOX2UX-6 red; stop
 * ending on `failed`, releasing the mic or calling onRemoteEnded → VOX2UX-1 red; enable
 * Save on a failed load, or make Retry a no-op → VOX2UX-9 red.
 *
 * Honest ceiling: jsdom has no WebRTC/WebAudio, so VOX2UX-1 runs against structural
 * stubs (FakePc / FakeAudioCtx / navigator.mediaDevices) — they implement only what
 * `startOpenAiRealtime` calls and are not typed as the DOM interfaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const toastError = vi.fn();
vi.mock('../../../ui/toast.js', () => ({ toast: { error: (m: string) => toastError(m), info: vi.fn(), success: vi.fn() } }));

import { MessageFeed } from '../../MessageFeed.js';
import type { ChatMessage } from '../../types.js';
import { VoiceApprovalNotice } from '../VoiceApprovalNotice.js';
import { startOpenAiRealtime } from '../realtimeClient.js';
import { RealtimeVoiceSettings } from '../../../byok/RealtimeVoiceSettings.js';

const FEED = { tenantId: 't-test', onResolveInterrupt: async () => {}, onOpenWorkflowProgress: () => {}, focusedWorkflowMessageId: null };

beforeEach(() => {
  cleanup();
  toastError.mockReset();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('VOX2UX-3 — the revoked-call notice is a warning', () => {
  it('renders role=alert with the localized revoked string', () => {
    const msg: ChatMessage = { id: 'r1', role: 'system', content: 'Voice call ended: …', createdAt: '2026-10-15T00:00:00.000Z', meta: { kind: 'voice-revoked' } };
    render(<MessageFeed {...FEED} messages={[msg]} />);
    const el = screen.getByRole('alert');
    expect(el.textContent).toContain('voiceRevokedNotice');
    expect(el.className).toContain('warning');
  });
});

describe('VOX2UX-6 — a 403 keeps the held approval pending', () => {
  it('shows "you may not answer this" and keeps Approve/Deny', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 })));
    render(<VoiceApprovalNotice toolName="email.send" callId="c1" fcId="f1" />);
    fireEvent.click(screen.getByText('voiceApprovalApprove'));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('voiceHeldApprovalForbidden'));
    expect(screen.queryByText('voiceHeldApprovalGone')).toBeNull();
    expect(screen.getByText('voiceApprovalApprove')).toBeTruthy();
  });
});

describe('VOX2UX-1 — a host hang-up ends the OpenAI call on the client', () => {
  it('releases the mic and reports a remote end when the peer connection fails', async () => {
    const trackStop = vi.fn();
    const mic = { getTracks: () => [{ stop: trackStop }] };
    const made: { pc: { connectionState: string; onconnectionstatechange: (() => void) | null } | null } = { pc: null };
    class FakePc {
      connectionState = 'connected';
      onconnectionstatechange: (() => void) | null = null;
      ontrack: unknown = null;
      constructor() { made.pc = this; }
      addTrack(): void { /* audio leg */ }
      async createOffer(): Promise<{ sdp: string }> { return { sdp: 'v=0' }; }
      async setLocalDescription(): Promise<void> { /* no-op */ }
      async setRemoteDescription(): Promise<void> { /* no-op */ }
      close(): void { this.connectionState = 'closed'; }
    }
    class FakeAudioCtx { createAnalyser() { return { fftSize: 0 }; } createMediaStreamSource() { return { connect: () => {} }; } async close() { /* no-op */ } }
    vi.stubGlobal('RTCPeerConnection', FakePc);
    vi.stubGlobal('AudioContext', FakeAudioCtx);
    vi.stubGlobal('Audio', class { autoplay = false; srcObject: unknown = null; });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => mic } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessionId: 'rtc_1', sdp: 'v=0' }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const onRemoteEnded = vi.fn();
    const statuses: string[] = [];
    await startOpenAiRealtime({ sessionId: 's' }, { onRemoteEnded, onStatus: (s) => statuses.push(s) });
    expect(statuses.at(-1)).toBe('live');
    const pc = made.pc;
    if (!pc) throw new Error('no RTCPeerConnection was constructed');
    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.();
    expect(onRemoteEnded).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalled();
    expect(statuses.at(-1)).toBe('ended');
  });
});

describe('VOX2UX-9 — a failed settings read never offers Save over a guessed "Off"', () => {
  it('shows the load failure + retry and keeps Save disabled; Retry re-reads and only then enables Save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"internal_error"}', { status: 500 })));
    render(<RealtimeVoiceSettings storedRefs={['k1']} />);
    await waitFor(() => expect(screen.getByText('rtLoadFailed')).toBeTruthy());
    const save = screen.getByText('rtSave').closest('button');
    if (!(save instanceof HTMLButtonElement)) throw new Error('rtSave is not inside a <button>');
    expect(save.disabled).toBe(true);

    // The read now succeeds: Retry must re-read it, and Save returns over a REAL config.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ provider: 'off' }), { status: 200, headers: { 'content-type': 'application/json' } })));
    fireEvent.click(screen.getByText('rtRetry'));
    await waitFor(() => expect(screen.queryByText('rtLoadFailed')).toBeNull());
    await waitFor(() => expect(save.disabled).toBe(false));
  });
});
