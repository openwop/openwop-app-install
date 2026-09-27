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
 *
 * ADR 0304 P2 — BOARD VOICE MODE (`voiceAllTurns`): a live boardroom produces a stream of
 * attributed assistant turns (the FE cadence, ADR 0043 Phase 5A), not one awaited reply.
 * In this mode the hook voices EVERY new settled assistant turn, strictly sequentially
 * (one floor — cadence order is the SSoT), each in its own agent's voice (`/speak` with
 * the per-turn `agentId`). A `boardHandle` makes each committed utterance a `@@<handle>`
 * summon, so the spoken question runs the SAME board interceptor + cadence as typed text
 * — voice adds zero new orchestration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAudioRecorder, blobToBase64, recorderMimeType } from '../hooks/useAudioRecorder.js';
import { appendVoiceAudio, bargeIn, commitVoiceTurn, endVoiceSession, openVoiceSession, speakReply, VoiceApiError } from './voiceClient.js';
import { collectSpeakableTurns, type SpeakableTurn } from './turnQueue.js';
import type { VoiceAudioGraph } from './realtimeClient.js';
import { toast } from '../../ui/toast.js';
import i18n from '../../i18n/index.js';
import type { ChatMessage } from '../types.js';

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
  /** ADR 0304 P2 — board voice mode: voice every new settled assistant turn (per-agent
   *  voices), not just the awaited reply. Requires `messages`. */
  voiceAllTurns?: boolean;
  /** The live message list (board voice mode reads new turns + their `agentId` from it). */
  messages?: readonly ChatMessage[];
  /** When set, each committed utterance is submitted as a `@@<handle>` board summon —
   *  the same text path as a typed summon (interceptor + cadence own the flow). */
  boardHandle?: string;
}

export interface BoardVoiceControls {
  /** Turns waiting for the floor (not counting the one speaking). */
  queued: number;
  muted: boolean;
  /** The agent currently holding the spoken floor, for the lineup pulse. */
  speakingAgentId: string | null;
  /** Stop the current turn's audio and advance (the text stays in the transcript). */
  onSkip: () => void;
  /** Keep transcribing but stop voicing (and back). */
  onToggleMute: () => void;
}

export interface UseVoiceModeResult {
  supported: boolean;
  phase: VoicePhase;
  active: boolean;
  error: string | null;
  /** Tap-to-talk: starts listening, commits + sends, or barges in during playback. */
  toggle: () => void;
  /** RT-8 — the live mic analyser (input only; the walkie/board path has no
   *  model-audio tap), so the composer can draw the capture waveform for board +
   *  walkie voice the same way the realtime path does. Null when not recording. */
  audioGraph: VoiceAudioGraph | null;
  /** Present only in board voice mode (ADR 0304). */
  board?: BoardVoiceControls;
}

/** Map a voice API failure to an honest, localized message when the provider
 *  simply isn't configured (host STT / TTS), else null (a transient failure the
 *  caller reports generically). The boardroom + walkie loops both depend on the
 *  host transcriber + speech synthesizer; Gemini Live bypasses them, so a tenant
 *  can have working realtime voice while these are unset — in which case the loop
 *  must SAY so instead of dead-ending on a silent "Listening…". */
function voiceConfigMessage(err: unknown): string | null {
  if (!(err instanceof VoiceApiError)) return null;
  if (err.code === 'transcription_unsupported') return i18n.t('chat:voiceSttUnavailable');
  if (err.code === 'speech_synthesis_unsupported') return i18n.t('chat:voiceTtsUnavailable');
  return null;
}

export function useVoiceMode({ agentId, conversationId, onSend, isSending, lastAssistantText, voiceAllTurns, messages, boardHandle }: UseVoiceModeArgs): UseVoiceModeResult {
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

  // ── Board voice mode state (ADR 0304 P2) ──────────────────────────────────
  const phaseRef = useRef<VoicePhase>('idle');
  phaseRef.current = phase;
  const isSendingRef = useRef(isSending);
  isSendingRef.current = isSending;
  const messagesRef = useRef<readonly ChatMessage[] | undefined>(messages);
  messagesRef.current = messages;
  /** Turns already voiced or baselined — history is never re-voiced. */
  const seenRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<SpeakableTurn[]>([]);
  const drainingRef = useRef(false);
  /** Resolves the in-flight playback promise (skip / barge-in / stop). */
  const playResolveRef = useRef<(() => void) | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  /** True while a session is OPENING (openVoiceSession + recorder.start, ~1s).
   *  `phase` is still 'idle' during that window, so without this the controller
   *  reports `active:false` and the LiveVoiceController path latch can unmount it
   *  mid-open — tearing down the just-opened session before the mic streams a
   *  single chunk (the board-voice "nothing is captured" bug). Counts as active. */
  const [starting, setStarting] = useState(false);
  /** The "voice STT/TTS not configured" message is surfaced ONCE per session —
   *  a boardroom fans out many turns and would otherwise spam an identical toast. */
  const configErrNotifiedRef = useRef(false);

  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    const settle = playResolveRef.current;
    playResolveRef.current = null;
    settle?.();
  }, []);

  // The ONE full-stop: mic, playback, host session, loop state. Shared by the
  // unmount cleanup and the conversation-pinning effect below.
  // `useAudioRecorder()` returns a NEW object every render, so listing `recorder`
  // in an effect's deps re-fires that effect (and its cleanup) EVERY render. That
  // made the "unmount" release below cancel the live recording + DELETE the open
  // session on every render — the board-voice "session opens, no audio, repeated
  // DELETEs" bug. Reach the current recorder through a ref instead; keep deps to
  // the genuinely-stable `stopAudio` so cleanups run only when they should.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const fullStop = useCallback(() => {
    recorderRef.current.cancel();
    stopAudio();
    if (sessionRef.current) { void endVoiceSession(sessionRef.current); sessionRef.current = null; }
    awaitingReplyRef.current = false;
    queueRef.current = [];
    setQueuedCount(0);
    setSpeakingAgentId(null);
    setPhase('idle');
  }, [stopAudio]);

  // Release everything on TRUE unmount only (stable deps — NOT `recorder`).
  useEffect(() => () => {
    recorderRef.current.cancel();
    stopAudio();
    if (sessionRef.current) void endVoiceSession(sessionRef.current);
  }, [stopAudio]);

  // GRADE-D3/VOXUX-3 — pin the walkie loop to the conversation it started in
  // (parity with the realtime path, #1318/#1320 — and a CORRECTNESS fix here
  // too: `commitAndSend` submits via the surface's live send, so a turn
  // committed after a rail switch would file into the NEW conversation).
  const boundConversationRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (phaseRef.current !== 'idle' && boundConversationRef.current !== conversationId) {
      fullStop();
      toast.info(i18n.t('chat:voiceEndedOnSwitch'));
    }
    boundConversationRef.current = conversationId;
  }, [conversationId, fullStop]);

  const startListening = useCallback(async () => {
    setError(null);
    setStarting(true); // latch active NOW so the path isn't re-routed mid-open
    try {
      if (!sessionRef.current) {
        const { session } = await openVoiceSession({
          ...(agentId ? { agentId } : {}),
          ...(conversationId ? { conversationId } : {}),
          mimeType: recorderMimeType(),
        });
        sessionRef.current = session.sessionId;
        // Board voice mode — baseline the seen-set to the CURRENT thread so a
        // fresh session never re-voices history, only turns that arrive live.
        if (voiceAllTurns) {
          seenRef.current = new Set((messagesRef.current ?? []).map((m) => m.id));
          queueRef.current = [];
          setQueuedCount(0);
        }
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
    } finally {
      setStarting(false);
    }
  }, [agentId, conversationId, recorder, voiceAllTurns]);

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
        // ADR 0304 P2 — a board-targeted utterance is a `@@<handle>` summon, exactly
        // like typed text: each spoken question convenes a fresh board round (the
        // text `@@` semantics — the turn policy is the cost control).
        onSend(boardHandle ? `@@${boardHandle} ${text}` : text);
        setPhase('thinking');
      } else setPhase('idle'); // nothing heard
    } catch (err) {
      setError(voiceConfigMessage(err) ?? (err instanceof Error ? err.message : 'Transcription failed.'));
      setPhase('idle');
    }
  }, [recorder, onSend, boardHandle]);

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

  // Reply-complete edge (classic 1:1 walkie): we sent a voice turn, the chat finished
  // generating, and there's a new assistant message → voice it. Guarded against
  // re-speaking the same text. Board voice mode replaces this with the turn queue.
  useEffect(() => {
    if (voiceAllTurns) return;
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
        setError(voiceConfigMessage(err) ?? (err instanceof Error ? err.message : 'Could not play the reply.'));
        setPhase('idle');
      }
    })();
  }, [phase, isSending, lastAssistantText, voiceAllTurns]);

  // ── Board voice mode: the sequential floor (ADR 0304 P2) ──────────────────

  /** Play one audio URL; resolves on ended/error/skip/barge-in (never rejects). */
  const playUrl = useCallback((url: string): Promise<void> => new Promise<void>((resolve) => {
    if (typeof window === 'undefined') { resolve(); return; }
    const audio = new Audio(url);
    const settle = () => {
      if (playResolveRef.current === resolve) playResolveRef.current = null;
      if (audioRef.current === audio) audioRef.current = null;
      resolve();
    };
    audioRef.current = audio;
    playResolveRef.current = resolve;
    audio.onended = settle;
    audio.onerror = settle;
    void audio.play().catch(() => { settle(); /* autoplay blocked — the text turn still shows */ });
  }), []);

  /** Drain the queue one turn at a time. Holds while the mic is hot (listening /
   *  transcribing) and resumes on the next kick; skip/barge-in resolve the current
   *  playback so the loop advances without tearing the session down. */
  const drain = useCallback(async () => {
    if (drainingRef.current || !sessionRef.current) return;
    drainingRef.current = true;
    try {
      while (sessionRef.current && queueRef.current.length > 0) {
        if (phaseRef.current === 'listening' || phaseRef.current === 'transcribing') break;
        const turn = queueRef.current.shift();
        if (!turn) break;
        setQueuedCount(queueRef.current.length);
        if (mutedRef.current) continue;
        setSpeakingAgentId(turn.agentId ?? null);
        setPhase('speaking');
        try {
          const result = await speakReply(sessionRef.current, turn.text, turn.agentId);
          if (!result.cancelled && result.audio?.url) await playUrl(result.audio.url);
        } catch (err) {
          // TTS not configured → say so ONCE (a board fans out many turns); every
          // turn still lands as text, so the floor keeps moving either way.
          const cfg = voiceConfigMessage(err);
          if (cfg && !configErrNotifiedRef.current) { configErrNotifiedRef.current = true; setError(cfg); toast.info(cfg); }
        }
        setSpeakingAgentId(null);
      }
    } finally {
      drainingRef.current = false;
      setSpeakingAgentId(null);
      setPhase((p) => (p === 'speaking' ? (isSendingRef.current || queueRef.current.length > 0 ? 'thinking' : 'idle') : p));
    }
  }, [playUrl]);

  // Enqueue every NEW settled assistant turn while the session is live.
  useEffect(() => {
    if (!voiceAllTurns || !messages || !sessionRef.current) return;
    const fresh = collectSpeakableTurns(messages, seenRef.current);
    if (fresh.length === 0) return;
    for (const t of fresh) seenRef.current.add(t.messageId);
    queueRef.current.push(...fresh);
    setQueuedCount(queueRef.current.length);
    void drain();
  }, [messages, voiceAllTurns, drain]);

  // Resume the floor after the mic released it (post-commit 'thinking') or when
  // playback stopped with turns still queued.
  useEffect(() => {
    if (!voiceAllTurns) return;
    if ((phase === 'thinking' || phase === 'idle') && queueRef.current.length > 0) void drain();
  }, [phase, voiceAllTurns, drain]);

  // Board mode has no single awaited reply: settle 'thinking' → 'idle' once the
  // generation finished and everything speakable has been spoken.
  useEffect(() => {
    if (!voiceAllTurns) return;
    if (phase === 'thinking' && !isSending && !drainingRef.current && queueRef.current.length === 0) setPhase('idle');
  }, [voiceAllTurns, phase, isSending]);

  const onSkip = useCallback(() => { stopAudio(); }, [stopAudio]);
  const onToggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      if (next) stopAudio(); // silence the current turn too — mute means quiet NOW
      return next;
    });
  }, [stopAudio]);

  // Stable identity per real change — consumers lift this into onState effects.
  const board = useMemo<BoardVoiceControls | undefined>(
    () => (voiceAllTurns ? { queued: queuedCount, muted, speakingAgentId, onSkip, onToggleMute } : undefined),
    [voiceAllTurns, queuedCount, muted, speakingAgentId, onSkip, onToggleMute],
  );

  return {
    supported: recorder.isSupported,
    phase,
    active: phase !== 'idle' || starting,
    error,
    toggle,
    // RT-8 — surface the recorder's live mic analyser so the composer draws the
    // capture waveform for board + walkie voice (parity with the realtime path).
    audioGraph: recorder.inputAnalyser ? { input: recorder.inputAnalyser, output: null } : null,
    ...(board ? { board } : {}),
  };
}
