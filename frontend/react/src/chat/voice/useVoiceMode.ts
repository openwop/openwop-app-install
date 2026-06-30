/**
 * useVoiceMode (ADR 0138 P2/W2) — the full-duplex voice turn loop, as the audio ADAPTER
 * on the ONE chat. Reply GENERATION stays in the existing chat (the real chat-responder);
 * this hook only does audio in/out + turn-taking:
 *
 *   idle ──tap──▶ listening (stream mic → host) ──tap/endpoint──▶ transcribing
 *        ▲                                                              │ commit → transcript
 *        │                                                              ▼
 *        └── speaking (play reply) ◀── thinking (chat generates reply) ─┘
 *                 │  tap during playback = barge-in (cancel + listen again)
 *
 * Reuses the ONE mic (`useAudioRecorder` streaming mode — no second MediaRecorder, W3).
 * The reply is observed via the chat's own signals (`isSending` + the last assistant text)
 * and voiced through the host `/speak` (which resolves the agent's per-agent voice + BYOK).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioRecorder, blobToBase64, recorderMimeType } from '../hooks/useAudioRecorder.js';
import { appendVoiceAudio, bargeIn, commitVoiceTurn, endVoiceSession, openVoiceSession, speakReply } from './voiceClient.js';

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface UseVoiceModeArgs {
  agentId?: string;
  conversationId?: string;
  /** Submit the committed transcript as a normal chat turn (the chat generates the reply). */
  onSend: (text: string) => void;
  /** The chat's in-flight flag — its false-edge after a send marks the reply complete. */
  isSending: boolean;
  /** The text of the most recent assistant message (the reply to voice). */
  lastAssistantText: string | null;
}

export interface UseVoiceModeResult {
  supported: boolean;
  phase: VoicePhase;
  active: boolean;
  error: string | null;
  /** Tap-to-talk: starts listening, commits + sends, or barges in during playback. */
  toggle: () => void;
}

export function useVoiceMode({ agentId, conversationId, onSend, isSending, lastAssistantText }: UseVoiceModeArgs): UseVoiceModeResult {
  const recorder = useAudioRecorder();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const awaitingReplyRef = useRef(false);
  const lastSpokenRef = useRef<string | null>(null);
  // Latest reply text, mirrored to a ref so `commitAndSend` can baseline it without a stale
  // closure (closes the race where the PREVIOUS turn's reply is spoken before isSending flips).
  const latestReplyRef = useRef<string | null>(lastAssistantText);
  latestReplyRef.current = lastAssistantText;

  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
  }, []);

  // Release everything on unmount.
  useEffect(() => () => {
    recorder.cancel();
    stopAudio();
    if (sessionRef.current) void endVoiceSession(sessionRef.current);
  }, [recorder, stopAudio]);

  const startListening = useCallback(async () => {
    setError(null);
    try {
      if (!sessionRef.current) {
        const { session } = await openVoiceSession({
          ...(agentId ? { agentId } : {}),
          ...(conversationId ? { conversationId } : {}),
          mimeType: recorderMimeType(),
        });
        sessionRef.current = session.sessionId;
      }
      const sid = sessionRef.current;
      await recorder.start({
        timeslice: 250,
        onChunk: (chunk) => { void (async () => {
          if (!sid) return;
          try { await appendVoiceAudio(sid, await blobToBase64(chunk)); } catch { /* a dropped chunk is non-fatal */ }
        })(); },
      });
      setPhase('listening');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start voice.');
      setPhase('idle');
    }
  }, [agentId, conversationId, recorder]);

  const commitAndSend = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid) { setPhase('idle'); return; }
    setPhase('transcribing');
    await recorder.stop();
    try {
      const turn = await commitVoiceTurn(sid);
      const text = turn.finalText.trim();
      if (text) {
        // Baseline the spoken text to the CURRENT reply so we only voice the NEXT one.
        lastSpokenRef.current = latestReplyRef.current;
        awaitingReplyRef.current = true;
        onSend(text);
        setPhase('thinking');
      } else setPhase('idle'); // nothing heard
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed.');
      setPhase('idle');
    }
  }, [recorder, onSend]);

  const onBargeIn = useCallback(async () => {
    const sid = sessionRef.current;
    stopAudio();
    if (sid) { try { await bargeIn(sid); } catch { /* best-effort */ } }
    void startListening();
  }, [stopAudio, startListening]);

  const toggle = useCallback(() => {
    if (phase === 'idle') void startListening();
    else if (phase === 'listening') void commitAndSend();
    else if (phase === 'speaking') void onBargeIn();
    // 'transcribing' / 'thinking' are transient — ignore taps.
  }, [phase, startListening, commitAndSend, onBargeIn]);

  // Reply-complete edge: we sent a voice turn, the chat finished generating, and there's a
  // new assistant message → voice it. Guarded against re-speaking the same text.
  useEffect(() => {
    if (phase !== 'thinking' || isSending || !awaitingReplyRef.current) return;
    const reply = lastAssistantText?.trim();
    if (!reply || reply === lastSpokenRef.current) return;
    awaitingReplyRef.current = false;
    lastSpokenRef.current = reply;
    const sid = sessionRef.current;
    if (!sid) { setPhase('idle'); return; }
    void (async () => {
      try {
        const result = await speakReply(sid, reply);
        if (result.cancelled || !result.audio?.url || typeof window === 'undefined') { setPhase('idle'); return; }
        const audio = new Audio(result.audio.url);
        audioRef.current = audio;
        audio.onended = () => { audioRef.current = null; setPhase((p) => (p === 'speaking' ? 'idle' : p)); };
        audio.onerror = () => { audioRef.current = null; setPhase('idle'); };
        setPhase('speaking');
        await audio.play().catch(() => { /* autoplay may be blocked; the text reply still shows */ });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not play the reply.');
        setPhase('idle');
      }
    })();
  }, [phase, isSending, lastAssistantText]);

  return { supported: recorder.isSupported, phase, active: phase !== 'idle', error, toggle };
}
