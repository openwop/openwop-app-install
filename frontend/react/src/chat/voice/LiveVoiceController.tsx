/**
 * Headless live-voice controller (ADR 0147) — the state-owning half of the
 * unified composer mic. It replaces `VoiceModeButton`: it probes the realtime
 * config, mounts the ONE applicable hook (realtime S2S — ADR 0141 — or the
 * walkie record→transcript loop — ADR 0138), and lifts `{available, active,
 * phase, onToggle}` to its parent via `onState`. It renders no button — the
 * trigger is the single mic inside `ChatInput`, which stays voice-agnostic and
 * receives this state as a plain `liveVoice` prop. (It still hosts the first-run
 * realtime onboarding modal.)
 *
 * `onToggle` is kept STABLE (a ref indirection) so pushing state up doesn't churn
 * the parent every render.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceMode } from './useVoiceMode.js';
import { useRealtimeVoice } from './useRealtimeVoice.js';
import { getRealtimeConfig } from './voiceClient.js';
import { RealtimeVoiceOnboarding, realtimeOnboardingSeen, markRealtimeOnboardingSeen } from './RealtimeVoiceOnboarding.js';
import type { ChatMessage } from '../types.js';

/** Union of the walkie + realtime phase vocabularies. `'idle'` ⇒ not active. */
export type LiveVoicePhase =
  | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' // walkie (ADR 0138)
  | 'connecting' | 'live' | 'error'; // realtime (ADR 0141)

export interface LiveVoiceState {
  /** The live-conversation mode can be started for this caller. */
  available: boolean;
  /** A session is currently running (mic is hot). */
  active: boolean;
  /** Fine-grained phase, for the placeholder/aria word. */
  phase: LiveVoicePhase;
  /** Start (or, while active, end) the live conversation. Stable identity. */
  onToggle: () => void;
}

interface ControllerProps {
  agentId?: string;
  conversationId?: string;
  onSend: (text: string) => void;
  isSending: boolean;
  messages: readonly ChatMessage[];
  /** Push the latest live-voice state up to the composer owner. */
  onState: (state: LiveVoiceState) => void;
}

function lastAssistantText(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    return typeof m.content === 'string'
      ? m.content
      : m.content.filter((p) => p.type === 'text').map((p) => (p as { text?: string }).text ?? '').join(' ').trim();
  }
  return null;
}

export function LiveVoiceController(props: ControllerProps): JSX.Element {
  const [realtime, setRealtime] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void getRealtimeConfig()
      .then((c) => { if (live) setRealtime(c.provider !== 'off'); })
      .catch(() => { if (live) setRealtime(false); });
    return () => { live = false; };
  }, []);
  if (realtime === null) {
    // Still probing — report "unavailable" so the mic falls back to send-audio
    // (or hides) until we know; flips to available a tick later if configured.
    return <ProbePending onState={props.onState} />;
  }
  return realtime ? <RealtimeController {...props} /> : <WalkieController {...props} />;
}

/** During the realtime probe, report not-yet-available exactly once. */
function ProbePending({ onState }: { onState: (s: LiveVoiceState) => void }): JSX.Element {
  const noop = useCallback(() => { /* not ready */ }, []);
  useEffect(() => {
    onState({ available: false, active: false, phase: 'idle', onToggle: noop });
  }, [onState, noop]);
  return <></>;
}

function WalkieController({ agentId, conversationId, onSend, isSending, messages, onState }: ControllerProps): JSX.Element {
  const [onboarding, setOnboarding] = useState(false);
  const { supported, phase, active, toggle } = useVoiceMode({
    ...(agentId ? { agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    onSend, isSending, lastAssistantText: lastAssistantText(messages),
  });

  // Stable onToggle (reads the live phase/toggle via refs) so lifting state up
  // doesn't recreate the callback every render → no parent churn.
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  const onToggle = useCallback(() => {
    // First idle start while realtime is unconfigured → explain realtime setup;
    // thereafter use recorded voice directly (the ADR 0141 onboarding).
    if (phaseRef.current === 'idle' && !realtimeOnboardingSeen()) {
      markRealtimeOnboardingSeen();
      setOnboarding(true);
      return;
    }
    toggleRef.current();
  }, []);

  useEffect(() => {
    onState({ available: supported, active, phase, onToggle });
  }, [supported, active, phase, onToggle, onState]);

  return onboarding
    ? <RealtimeVoiceOnboarding onClose={() => setOnboarding(false)} onUseRecorded={() => toggleRef.current()} />
    : <></>;
}

function RealtimeController({ agentId, conversationId, onState }: ControllerProps): JSX.Element {
  const { phase, toggle } = useRealtimeVoice({
    ...(agentId ? { agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
  });
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  const onToggle = useCallback(() => toggleRef.current(), []);
  const active = phase === 'live' || phase === 'connecting';
  useEffect(() => {
    onState({ available: true, active, phase: phase as LiveVoicePhase, onToggle });
  }, [active, phase, onToggle, onState]);
  return <></>;
}
