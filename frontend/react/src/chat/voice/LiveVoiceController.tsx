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
 * ADR 0304 D2 — a BOARD is a first-class voice target. Routing is by target:
 * a board (picked in the VoiceAgentPicker, or a board conversation already
 * live — `boardActive`) always runs the WALKIE multi-speaker loop, even when a
 * realtime provider is configured: the advisor replies are real chat runs (the
 * FE cadence) and the loop voices each settled turn in its own agent's voice.
 * The path is LATCHED while a session is active — a mid-session board summon
 * never tears down a live call; the next session starts in board mode.
 *
 * `onToggle` is kept STABLE (a ref indirection) so pushing state up doesn't churn
 * the parent every render.
 */
import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../../ui/Modal.js';
import { useVoiceMode, type BoardVoiceControls } from './useVoiceMode.js';
import { useRealtimeVoice } from './useRealtimeVoice.js';
import { getRealtimeCapability } from './voiceClient.js';
import { RealtimeVoiceOnboarding, realtimeOnboardingSeen, markRealtimeOnboardingSeen } from './RealtimeVoiceOnboarding.js';
import { VoiceAgentPicker, rememberedVoiceTarget, type VoiceTarget } from './VoiceAgentPicker.js';
import { listRoster } from '../../agents/rosterClient.js';
import { toast } from '../../ui/toast.js';
import type { VoiceAudioGraph } from './realtimeClient.js';
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
  /** RT-8: live analyser taps for the voice waveform. Realtime sessions only —
   *  null when idle or on the walkie fallback (which has no live audio graph). */
  audioGraph?: VoiceAudioGraph | null;
  /** ADR 0277 OQ-1 — context blocks that failed to compose for the live session
   *  (names only). The composer renders a quiet "Reduced context" chip. */
  degraded?: readonly string[];
  /** ADR 0304 — the live boardroom floor controls (board voice mode only). */
  boardVoice?: BoardVoiceControls;
}

interface ControllerProps {
  agentId?: string;
  conversationId?: string;
  onSend: (text: string) => void;
  isSending: boolean;
  messages: readonly ChatMessage[];
  /** Push the latest live-voice state up to the composer owner. */
  onState: (state: LiveVoiceState) => void;
  /** RT-9 — whole spoken turns from a REALTIME session, for display in the chat
   *  thread (the realtime model already answered by voice; these are transcripts,
   *  NOT sends). The walkie fallback never calls it (its loop already goes through
   *  onSend). Optional: surfaces without it simply show no transcript bubbles.
   *  ADR 0304 D4 — assistant turns carry the session's scoped agent as `agentId`
   *  (the Gemini client-persisted path's attribution parity with the OpenAI
   *  sideband's server-side stamp). */
  onLiveTranscript?: (text: string, role: 'user' | 'assistant', turnId: string, final: boolean, agentId?: string, agentPersona?: string) => void;
  /** ADR 0304 D3 auto-voice — the surface says a board conversation is live here
   *  (a board attached to the conversation or a cadence in flight), so the next
   *  voice session runs the board multi-speaker loop even without a picker choice. */
  boardActive?: boolean;
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

type VoicePath = 'probe' | 'realtime' | 'walkie' | 'board';

export function LiveVoiceController(props: ControllerProps): JSX.Element {
  const [realtime, setRealtime] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void getRealtimeCapability() // GRADE-4 — member-safe probe (GET /config is superadmin-only)
      .then((c) => { if (live) setRealtime(c.provider !== 'off'); })
      .catch(() => { if (live) setRealtime(false); });
    return () => { live = false; };
  }, []);

  // The session TARGET (who to talk to) is owned here, so a board pick can
  // reroute the PATH (realtime → board walkie). Remembered per conversation.
  const [target, setTarget] = useState<VoiceTarget | undefined>(() => rememberedVoiceTarget(props.conversationId));
  const [autoStartBoard, setAutoStartBoard] = useState(false);
  const activeRef = useRef(false);
  useEffect(() => {
    // Don't clobber the target while a session is LIVE. A board summon changes
    // props.conversationId (it convenes the canonical board conversation), and
    // re-reading the remembered target for that new id would drop the active
    // board target — losing the `@@handle` and flipping the path mid-call
    // (the board-voice teardown). Restore the remembered target only when idle.
    if (activeRef.current) return;
    setTarget(rememberedVoiceTarget(props.conversationId));
    setAutoStartBoard(false);
  }, [props.conversationId]);

  const boardMode = target?.kind === 'board' || props.boardActive === true;
  const desired: VoicePath = realtime === null ? 'probe' : boardMode ? 'board' : realtime ? 'realtime' : 'walkie';

  // Latch the path while a session is active — never tear down a live call
  // because the target changed; re-route the moment it goes idle.
  const [path, setPath] = useState<VoicePath>('probe');
  const pathRef = useRef(path); pathRef.current = path;
  const desiredRef = useRef(desired); desiredRef.current = desired;
  useEffect(() => {
    if (!activeRef.current && pathRef.current !== desired) setPath(desired);
  }, [desired]);
  const { onState } = props;
  const handleState = useCallback((s: LiveVoiceState) => {
    activeRef.current = s.active;
    if (!s.active && desiredRef.current !== pathRef.current) setPath(desiredRef.current);
    onState(s);
  }, [onState]);

  const handlePickTarget = useCallback((t: VoiceTarget) => {
    setTarget(t);
    if (t.kind === 'board') setAutoStartBoard(true); // mic tap → picker → board: start the boardroom now
  }, []);

  if (path === 'probe') {
    // Still probing — report "unavailable" so the mic falls back to send-audio
    // (or hides) until we know; flips to available a tick later if configured.
    return <ProbePending onState={handleState} />;
  }
  if (path === 'board') {
    return <BoardVoiceController {...props} onState={handleState} {...(target?.kind === 'board' ? { boardTarget: target } : {})} autoStart={autoStartBoard} />;
  }
  return path === 'realtime'
    ? <RealtimeController {...props} onState={handleState} {...(target ? { target } : {})} onPickTarget={handlePickTarget} />
    : <WalkieController {...props} onState={handleState} />;
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
  const { supported, phase, active, toggle, audioGraph } = useVoiceMode({
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
    onState({ available: supported, active, phase, onToggle, audioGraph });
  }, [supported, active, phase, onToggle, onState, audioGraph]);

  return onboarding
    ? <RealtimeVoiceOnboarding onClose={() => setOnboarding(false)} onUseRecorded={() => toggleRef.current()} />
    : <></>;
}

/** ADR 0304 D2/D3 — the live boardroom: the walkie loop in multi-speaker mode.
 *  Each committed utterance summons the board (`@@<handle>`, when targeted) and
 *  every settled attributed assistant turn is voiced in its own agent's voice. */
function BoardVoiceController({ agentId, conversationId, onSend, isSending, messages, onState, boardTarget, autoStart }: ControllerProps & { boardTarget?: VoiceTarget & { kind: 'board' }; autoStart?: boolean }): JSX.Element {
  const { supported, phase, active, toggle, board, audioGraph } = useVoiceMode({
    ...(agentId ? { agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    onSend, isSending, lastAssistantText: lastAssistantText(messages),
    voiceAllTurns: true,
    messages,
    ...(boardTarget ? { boardHandle: boardTarget.handle } : {}),
  });
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  const onToggle = useCallback(() => { toggleRef.current(); }, []);
  // An explicit board pick came from a mic tap — start the boardroom immediately.
  const startedRef = useRef(false);
  useEffect(() => {
    if (autoStart && !startedRef.current) { startedRef.current = true; toggleRef.current(); }
  }, [autoStart]);
  useEffect(() => {
    onState({ available: supported, active, phase, onToggle, audioGraph, ...(board ? { boardVoice: board } : {}) });
  }, [supported, active, phase, onToggle, onState, board, audioGraph]);
  return <></>;
}

/** Map the remembered/picked target to the realtime hook's single-agent choice. */
function agentChoiceOf(target: VoiceTarget | undefined): string | null | undefined {
  if (!target) return undefined;
  if (target.kind === 'agent') return target.rosterId;
  if (target.kind === 'generic') return null;
  return undefined; // a board target never reaches the realtime path (routed above)
}

function RealtimeController({ agentId, conversationId, onState, onLiveTranscript, target, onPickTarget }: ControllerProps & { target?: VoiceTarget; onPickTarget: (t: VoiceTarget) => void }): JSX.Element {
  const { t } = useTranslation('chat');
  // ADR 0199 P3 — an UNSCOPED chat asks who to talk to before starting (an
  // unscoped realtime session has no persona/memories and no tools). The
  // choice is remembered per conversation; scoped chats never see the picker.
  // `null` = the explicit workspace-assistant (generic) choice.
  const chosenAgent = agentChoiceOf(target);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [startAfterPick, setStartAfterPick] = useState(false);
  const effectiveAgentId = agentId ?? (chosenAgent ?? undefined);
  // Resolve the scoped agent's PERSONA display name so the transcript bubble reads
  // "Ava", not slugToName(rosterId) → "Host:ava Fdf5f7f0". Keyed by BOTH rosterId and
  // agentRef.agentId since effectiveAgentId can be either. Fail-soft: no map ⇒ the
  // bubble falls back to the id-derived name (prior behavior).
  const [personaByAgent, setPersonaByAgent] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let live = true;
    listRoster().then((entries) => {
      if (!live) return;
      const m = new Map<string, string>();
      for (const e of entries) {
        if (!e.persona) continue;
        m.set(e.rosterId, e.persona);
        if (e.agentRef?.agentId) m.set(e.agentRef.agentId, e.persona);
      }
      setPersonaByAgent(m);
    }).catch(() => { /* keep the id-derived fallback */ });
    return () => { live = false; };
  }, []);
  const speakerPersona = effectiveAgentId ? personaByAgent.get(effectiveAgentId) : undefined;
  // ADR 0304 D4 — stamp the session's scoped agent (+ its persona name) onto ASSISTANT
  // transcript turns (the Gemini client-persisted path; OpenAI stamps server-side).
  const onTranscript = useMemo(() => (
    onLiveTranscript
      ? (text: string, role: 'user' | 'assistant', turnId: string, final: boolean) =>
        onLiveTranscript(text, role, turnId, final,
          role === 'assistant' && effectiveAgentId ? effectiveAgentId : undefined,
          role === 'assistant' ? speakerPersona : undefined)
      : undefined
  ), [onLiveTranscript, effectiveAgentId, speakerPersona]);
  const { phase, toggle, audioGraph, error, degraded, pendingApproval, resolvePendingApproval } = useRealtimeVoice({
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(onTranscript ? { onTranscript } : {}),
  });
  const toggleRef = useRef(toggle); toggleRef.current = toggle;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const needsPickRef = useRef(false);
  needsPickRef.current = !agentId && chosenAgent === undefined;
  const onToggle = useCallback(() => {
    // Starting from idle in an unscoped chat with no remembered choice → ask.
    if ((phaseRef.current === 'idle' || phaseRef.current === 'error') && needsPickRef.current) {
      setPickerOpen(true);
      return;
    }
    toggleRef.current();
  }, []);
  // After a pick, start once the hook has re-bound to the chosen agent.
  useEffect(() => {
    if (!startAfterPick || chosenAgent === undefined) return;
    setStartAfterPick(false);
    toggleRef.current();
  }, [startAfterPick, chosenAgent]);
  const active = phase === 'live' || phase === 'connecting';
  // RT-9a — surface session errors. The hook captured them but nothing consumed
  // them, so a server-side close (bad model, quota, rejected audio) looked like
  // the session silently stopping the moment the user spoke.
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastErrorRef.current) {
      lastErrorRef.current = error;
      toast.error(error);
    }
  }, [error]);
  useEffect(() => {
    onState({ available: true, active, phase: phase as LiveVoicePhase, onToggle, audioGraph, degraded });
  }, [active, phase, onToggle, onState, audioGraph, degraded]);
  // ADR 0277 OQ-1 — a TOTAL composition collapse means the session opened with
  // no persona/context at all; that deserves a loud one-time error, not just
  // the quiet chip.
  const wholeWarnedRef = useRef(false);
  useEffect(() => {
    if (degraded.includes('whole') && !wholeWarnedRef.current) {
      wholeWarnedRef.current = true;
      toast.error(t('voiceContextCollapsed'));
    }
    if (degraded.length === 0) wholeWarnedRef.current = false;
  }, [degraded, t]);
  // A7 (ADR 0467 follow-on) — the in-voice approval card. The model is holding
  // for the tool result, so this is a modal decision: Approve executes with the
  // human's one-shot approval; Deny hands the model the honest refusal. Closing
  // the dialog IS a deny (never leaves the model hanging).
  if (pendingApproval) {
    return (
      <Modal label={t('voiceApprovalTitle')} onClose={() => resolvePendingApproval(false)} showClose>
        <h2 className="u-mt-0">{t('voiceApprovalTitle')}</h2>
        <p>{t('voiceApprovalBody', { tool: pendingApproval.name })}</p>
        {pendingApproval.reason ? <p className="muted u-fs-13">{pendingApproval.reason}</p> : null}
        <div className="action-bar">
          <Button variant="primary" onClick={() => resolvePendingApproval(true)}>
            {t('voiceApprovalApprove')}
          </Button>
          <Button variant="quiet" onClick={() => resolvePendingApproval(false)}>
            {t('voiceApprovalDeny')}
          </Button>
        </div>
      </Modal>
    );
  }
  return pickerOpen ? (
    <VoiceAgentPicker
      {...(conversationId ? { conversationId } : {})}
      onPick={(picked) => {
        setPickerOpen(false);
        onPickTarget(picked);
        // A board pick reroutes the PATH (the parent mounts the boardroom, which
        // auto-starts); an agent/generic pick starts here once the hook re-binds.
        if (picked.kind !== 'board') setStartAfterPick(true);
      }}
      onClose={() => setPickerOpen(false)}
    />
  ) : <></>;
}
