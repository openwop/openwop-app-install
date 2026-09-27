/**
 * CHAT-7/A11Y-8 — the voice-phase word map. Pins the full union of both
 * vocabularies (walkie ADR 0138 + realtime ADR 0141), the honest full-duplex
 * word for `live` (NOT a turn-taking "listening"), and the safe fallback
 * (an unknown/future phase never leaks a raw enum).
 */
import { describe, expect, it } from 'vitest';
import { voicePhaseKey } from '../voicePhaseWords.js';

describe('voicePhaseKey', () => {
  it('maps every phase in both vocabularies', () => {
    expect(voicePhaseKey('connecting')).toBe('voicePhaseConnecting');
    expect(voicePhaseKey('live')).toBe('voicePhaseLive');
    expect(voicePhaseKey('listening')).toBe('voicePhaseListening');
    expect(voicePhaseKey('transcribing')).toBe('voicePhaseTranscribing');
    expect(voicePhaseKey('thinking')).toBe('voicePhaseThinking');
    expect(voicePhaseKey('speaking')).toBe('voicePhaseSpeaking');
    expect(voicePhaseKey('error')).toBe('voicePhaseError');
    expect(voicePhaseKey('idle')).toBe('voicePhaseIdle');
  });

  it('falls back to the in-conversation word for unknown phases', () => {
    expect(voicePhaseKey('some-future-phase')).toBe('voicePhaseLive');
    expect(voicePhaseKey('')).toBe('voicePhaseLive');
  });
});
