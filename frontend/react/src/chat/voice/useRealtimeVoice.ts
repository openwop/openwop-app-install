/**
 * useRealtimeVoice (ADR 0141 RT-3) — drives a real-time speech-to-speech session via
 * `realtimeClient` (OpenAI WebRTC / Gemini WebSocket). The provider's model does the
 * listening, reasoning, and speaking; tool calls bridge back to the host. This is the REAL
 * real-time path; the walkie-talkie (`useVoiceMode`) is the no-realtime-provider fallback.
 *
 * Live audio/transport is verify-in-browser (cannot run headless).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openRealtimeSession, getRealtimeCapability } from './voiceClient.js';
import { toast } from '../../ui/toast.js';
import i18n from '../../i18n/index.js';
import { startOpenAiRealtime, startGeminiRealtime, type RealtimeHandle, type RealtimeCallbacks, type VoiceAudioGraph, type VoiceApprovalRequest } from './realtimeClient.js';

export type RealtimePhase = 'idle' | 'connecting' | 'live' | 'error';

export interface UseRealtimeVoiceResult {
  phase: RealtimePhase;
  error: string | null;
  toggle: () => void;
  /** RT-8: live analyser taps (mic + model speech) for the voice waveform; null when idle. */
  audioGraph: VoiceAudioGraph | null;
  /** ADR 0277 OQ-1 — context blocks that failed to compose for THIS session
   *  (names only); empty when composition was whole or the session is idle. */
  degraded: readonly string[];
  /** A7 — a SENSITIVE tool call awaiting the human's in-voice decision; null
   *  when none. The model is holding for the tool result while this is set. */
  pendingApproval: { name: string; reason?: string } | null;
  /** Resolve the pending approval: true executes with the one-shot user
   *  approval, false hands the model the honest refusal. No-op when none. */
  resolvePendingApproval: (approve: boolean) => void;
}

export function useRealtimeVoice({ agentId, conversationId, onTranscript }: { agentId?: string; conversationId?: string; onTranscript?: (text: string, role: 'user' | 'assistant', turnId: string, final: boolean) => void }): UseRealtimeVoiceResult {
  const [phase, setPhase] = useState<RealtimePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [audioGraph, setAudioGraph] = useState<VoiceAudioGraph | null>(null);
  const [degraded, setDegraded] = useState<readonly string[]>([]);
  const handleRef = useRef<RealtimeHandle | null>(null);
  const sessionIdRef = useRef<string>('');
  // A7 — the pending in-voice approval + its resolver (one at a time; the
  // relay awaits the decision, so a second SENSITIVE call queues behind it).
  const [pendingApproval, setPendingApproval] = useState<{ name: string; reason?: string } | null>(null);
  const approvalRef = useRef<VoiceApprovalRequest | null>(null);
  const approvalDoneRef = useRef<((text: string) => void) | null>(null);
  // RT-9: ref-backed so a re-render mid-session doesn't restart anything.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const stop = useCallback(() => {
    // A7 — a card open at hang-up resolves as the honest refusal (never leaves
    // the relay's promise dangling).
    if (approvalRef.current && approvalDoneRef.current) {
      approvalDoneRef.current(approvalRef.current.deny());
    }
    approvalRef.current = null; approvalDoneRef.current = null;
    setPendingApproval(null);
    handleRef.current?.stop();
    handleRef.current = null;
    setAudioGraph(null);
    setDegraded([]);
    setPhase('idle');
  }, []);

  useEffect(() => () => { handleRef.current?.stop(); }, []);

  // GRADE-1 — pin the live session to the conversation it STARTED in. The
  // singleton chat surface keeps this hook mounted across rail switches, so a
  // conversation change with a live handle previously kept streaming — and the
  // consumer (upsertTranscriptTurn) files transcripts into the CURRENT session,
  // permanently misfiling turns spoken about conversation A into B. End the
  // session instead; the user re-opens voice in the new conversation.
  const boundConversationRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (handleRef.current && boundConversationRef.current !== conversationId) {
      stop();
      // VOXUX-2 — ending the session silently is the same "silent degradation"
      // pattern this program exists to kill: the mic just dies mid-sentence.
      // Say why (quiet info toast, localized).
      toast.info(i18n.t('chat:voiceEndedOnSwitch'));
    }
  }, [conversationId, stop]);

  const start = useCallback(async () => {
    setError(null);
    setDegraded([]);
    setPhase('connecting');
    try {
      sessionIdRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      boundConversationRef.current = conversationId; // GRADE-1 — the session's home conversation
      const ctx = { ...(agentId ? { agentId } : {}), ...(conversationId ? { conversationId } : {}), sessionId: sessionIdRef.current };
      const cb: RealtimeCallbacks = {
        onStatus: (s) => setPhase(s === 'live' ? 'live' : s === 'connecting' ? 'connecting' : s === 'error' ? 'error' : 'idle'),
        onError: (m) => setError(m),
        onAudioGraph: (g) => setAudioGraph(g),
        onDegraded: (blocks) => setDegraded(blocks),
        // RT-9: whole spoken turns (accumulated client-side) surface into the chat thread.
        onTranscript: (text, role, turnId, final) => onTranscriptRef.current?.(text, role, turnId, final),
        // A7 — surface the in-voice approval card; the promise resolves with the
        // text handed back to the model once the human decides (or on hang-up).
        onApprovalRequired: (req) => new Promise<string>((resolve) => {
          approvalRef.current = req;
          approvalDoneRef.current = resolve;
          setPendingApproval({ name: req.name, ...(req.reason ? { reason: req.reason } : {}) });
        }),
      };
      const cfg = await getRealtimeCapability(); // GRADE-4 — member-safe probe
      if (cfg.provider === 'off') { setPhase('idle'); setError('Real-time voice is not configured.'); return; }
      if (cfg.provider === 'openai-realtime') {
        // OpenAI: host-mediated sideband — the browser never mints/holds a token (RT-4).
        handleRef.current = await startOpenAiRealtime(ctx, cb);
      } else {
        // Gemini: ephemeral token from /session (no host sideband yet — the lower-assurance path).
        const sessionConfig = await openRealtimeSession({ ...(agentId ? { agentId } : {}), ...(conversationId ? { conversationId } : {}) });
        if (!sessionConfig) { setPhase('idle'); setError('Real-time voice is not configured.'); return; }
        // RTV-2/RTV-3: relay tool calls under the HOST-issued session id (not the client UUID)
        // so the host binds the firewall seen-set + agent allowlist server-side.
        if (sessionConfig.degraded && sessionConfig.degraded.length > 0) setDegraded(sessionConfig.degraded);
        const geminiCtx = { ...ctx, sessionId: sessionConfig.hostSessionId ?? ctx.sessionId };
        handleRef.current = await startGeminiRealtime(sessionConfig, geminiCtx, cb);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start real-time voice.');
      setPhase('error');
    }
  }, [agentId, conversationId]);

  const toggle = useCallback(() => {
    if (phase === 'idle' || phase === 'error') void start();
    else stop();
  }, [phase, start, stop]);

  const resolvePendingApproval = useCallback((approve: boolean) => {
    const req = approvalRef.current;
    const done = approvalDoneRef.current;
    approvalRef.current = null; approvalDoneRef.current = null;
    setPendingApproval(null);
    if (!req || !done) return;
    if (approve) {
      void req.approve().then(done);
    } else {
      done(req.deny());
    }
  }, []);

  return { phase, error, toggle, audioGraph, degraded, pendingApproval, resolvePendingApproval };
}
