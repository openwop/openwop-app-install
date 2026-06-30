/**
 * useRealtimeVoice (ADR 0141 RT-3) — drives a real-time speech-to-speech session via
 * `realtimeClient` (OpenAI WebRTC / Gemini WebSocket). The provider's model does the
 * listening, reasoning, and speaking; tool calls bridge back to the host. This is the REAL
 * real-time path; the walkie-talkie (`useVoiceMode`) is the no-realtime-provider fallback.
 *
 * Live audio/transport is verify-in-browser (cannot run headless).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openRealtimeSession, getRealtimeConfig } from './voiceClient.js';
import { startOpenAiRealtime, startGeminiRealtime, type RealtimeHandle, type RealtimeCallbacks } from './realtimeClient.js';

export type RealtimePhase = 'idle' | 'connecting' | 'live' | 'error';

export interface UseRealtimeVoiceResult {
  phase: RealtimePhase;
  error: string | null;
  toggle: () => void;
}

export function useRealtimeVoice({ agentId, conversationId }: { agentId?: string; conversationId?: string }): UseRealtimeVoiceResult {
  const [phase, setPhase] = useState<RealtimePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<RealtimeHandle | null>(null);
  const sessionIdRef = useRef<string>('');

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setPhase('idle');
  }, []);

  useEffect(() => () => { handleRef.current?.stop(); }, []);

  const start = useCallback(async () => {
    setError(null);
    setPhase('connecting');
    try {
      sessionIdRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      const ctx = { ...(agentId ? { agentId } : {}), ...(conversationId ? { conversationId } : {}), sessionId: sessionIdRef.current };
      const cb: RealtimeCallbacks = {
        onStatus: (s) => setPhase(s === 'live' ? 'live' : s === 'connecting' ? 'connecting' : s === 'error' ? 'error' : 'idle'),
        onError: (m) => setError(m),
      };
      const cfg = await getRealtimeConfig();
      if (cfg.provider === 'off') { setPhase('idle'); setError('Real-time voice is not configured.'); return; }
      if (cfg.provider === 'openai-realtime') {
        // OpenAI: host-mediated sideband — the browser never mints/holds a token (RT-4).
        handleRef.current = await startOpenAiRealtime(ctx, cb);
      } else {
        // Gemini: ephemeral token from /session (no host sideband yet — the lower-assurance path).
        const sessionConfig = await openRealtimeSession(agentId ? { agentId } : {});
        if (!sessionConfig) { setPhase('idle'); setError('Real-time voice is not configured.'); return; }
        // RTV-2/RTV-3: relay tool calls under the HOST-issued session id (not the client UUID)
        // so the host binds the firewall seen-set + agent allowlist server-side.
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

  return { phase, error, toggle };
}
