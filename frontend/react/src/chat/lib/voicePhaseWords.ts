/**
 * Voice-phase → user-facing word map (UX CHAT-7/A11Y-8).
 *
 * The composer receives `liveVoice.phase` as a STRUCTURAL string (its prop
 * contract deliberately avoids importing `chat/voice/` so embeds stay
 * voice-agnostic — see ChatInput's prop doc), so this map is keyed by string
 * with a safe fallback: an unknown/future phase renders the generic
 * in-conversation word rather than breaking or leaking a raw enum.
 *
 * Words are i18n KEYS in the `chat` namespace; ChatInput resolves them. The
 * union covers both vocabularies (walkie ADR 0138 + realtime ADR 0141):
 *   connecting → "Connecting…"      (realtime: session being established)
 *   live       → "In conversation"  (full-duplex — NOT "listening"; the model
 *                                    listens while it speaks, so a turn-taking
 *                                    word would misrepresent the mode)
 *   listening  → "Listening…"       (walkie: capturing your utterance)
 *   transcribing → "Transcribing…"
 *   thinking   → "Thinking…"
 *   speaking   → "Speaking…"
 *   error      → "Voice error"      (the toast, role=alert, is the detail channel)
 *   idle       → "Voice off"        (announced on session end; the composer
 *                                    placeholder reverts to its default)
 */

const PHASE_KEY: Record<string, string> = {
  connecting: 'voicePhaseConnecting',
  live: 'voicePhaseLive',
  listening: 'voicePhaseListening',
  transcribing: 'voicePhaseTranscribing',
  thinking: 'voicePhaseThinking',
  speaking: 'voicePhaseSpeaking',
  error: 'voicePhaseError',
  idle: 'voicePhaseIdle',
};

/** i18n key for an ACTIVE phase's word; unknown phases fall back to the
 *  in-conversation word (never a raw enum on screen). */
export function voicePhaseKey(phase: string): string {
  return PHASE_KEY[phase] ?? 'voicePhaseLive';
}
