/**
 * Auto-resizing textarea + send / stop / mic buttons + pending-audio
 * attachment chip.
 *
 * Voice input uses MediaRecorder (multi-modal). The recorded audio
 * blob is attached to the next send() as a ContentPart, and the
 * model (Gemini today; Anthropic/OpenAI Phase 4 v2) transcribes
 * implicitly as part of its response. Bypasses the Web Speech API
 * entirely — no Google-cloud dependency, works in Firefox.
 *
 * Keyboard contract:
 *   - Enter (no modifier) → send
 *   - Shift+Enter → newline
 *   - Esc (while streaming) → cancel
 */

import { Button } from '../ui/Button.js';
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioRecorder, blobToBase64, type RecordedAudio } from './hooks/useAudioRecorder.js';
import { formatDurationSeconds } from '../i18n/format.js';
import { SlashAutocomplete } from './SlashAutocomplete.js';
import { refreshWorkflowMentionCache } from './lib/workflowMentions.js';
import { voicePhaseKey } from './lib/voicePhaseWords.js';
import { voiceCtxBlockLabels } from './voiceCtxLabels.js';
import { subscribeLiveComposer, takeStagedComposerDraft } from './composerSeed.js';
import { AgentMentionAutocomplete } from './AgentMentionAutocomplete.js';
import type { AgentMentionEntry } from './lib/agentMentions.js';
import { BoardMentionAutocomplete } from './BoardMentionAutocomplete.js';
import { MicIcon, ActivityIcon, SendIcon, StopIcon, PaperclipIcon, PlusIcon, XIcon, AlertIcon, SkipForwardIcon, Volume2Icon, VolumeOffIcon } from '../ui/icons/index.js';
import { Menu } from '../ui/Menu.js';
import { announce } from '../ui/announce.js';
import {
  fileToContentPart,
  attachmentRejectionReason,
  isImageMime,
  mimeOf,
  ATTACHMENT_ACCEPT,
} from '../client/mediaClient.js';
import type { ContentPart } from './hooks/useChatSession.js';

// RT-8 — the live-conversation waveform. LAZY: ChatInput sits in the entry chunk
// (bundle budget is tight) and the canvas animation is only needed while a live
// voice session is actually running. The dynamic import keeps the composer
// voice-feature-agnostic at module-graph level (nothing loads until live starts).
const VoiceWaveform = lazy(() => import('./voice/VoiceWaveform.js').then((m) => ({ default: m.VoiceWaveform })));

/** Draft persistence (crash/refresh safety). The composer's in-progress text is
 *  mirrored to localStorage under a caller-supplied, surface-stable key so a tab
 *  refresh or a browser crash restores exactly what the user was typing. This is
 *  DISTINCT from chat history — a draft never creates a conversation; history is
 *  only written once a prompt is actually sent. */
function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* quota / disabled — drafts are best-effort */
  }
}

interface PendingAudio {
  id: string;
  audio: RecordedAudio;
}

interface PendingFile {
  id: string;
  file: File;
  isImage: boolean;
  /** Object URL for an image thumbnail; revoked on remove/submit. */
  previewUrl?: string;
}

interface Props {
  onSend: (text: string, attachments?: readonly ContentPart[]) => void;
  /** When provided AND `disabled` is true (turn in flight), Send morphs into Stop. */
  onCancel?: (() => void | Promise<void>) | null;
  disabled?: boolean;
  placeholder?: string;
  /** ADR 0192 D8 — channel-scoped `@` entries; absent ⇒ the tenant-wide list. */
  mentionEntries?: readonly AgentMentionEntry[];
  /** Reason the send button is disabled, shown in title tooltip. */
  disabledReason?: string | undefined;
  /** Hint that the active provider supports audio input. When false, the
   *  "Send audio" option is hidden (a clip can't be read by this model). */
  supportsAudioInput?: boolean;
  /** Live-conversation mode (ADR 0147), injected by the composer owner so this
   *  generic input stays voice-feature-agnostic (structural type — no
   *  `chat/voice/` import). Absent ⇒ no live mode here (e.g. embeds). */
  liveVoice?: {
    degraded?: readonly string[];
    available: boolean;
    active: boolean;
    phase: string;
    onToggle: () => void;
    /** RT-8: live analyser taps (mic + model speech) driving the waveform;
     *  absent/null on the walkie fallback or before the session's graph exists. */
    audioGraph?: { input: AnalyserNode | null; output: AnalyserNode | null } | null;
    /** ADR 0304 — live-boardroom floor controls (board voice mode only):
     *  skip the current spoken turn / mute the voices without ending the call. */
    boardVoice?: {
      queued: number;
      muted: boolean;
      speakingAgentId: string | null;
      onSkip: () => void;
      onToggleMute: () => void;
    };
  };
  /** Hint that the active model accepts image input (vision). When false,
   *  an attached image is flagged with a "switch models" warning. */
  supportsImageInput?: boolean;
  /** Hint that the active model accepts PDF documents (Anthropic / Gemini).
   *  Text files (.txt/.md/.json/.csv) inline as text and work everywhere. */
  supportsPdfInput?: boolean;
  /** Next-message modifiers (web search, workflow tools) rendered as a slim chip
   *  row above the input bar — they change the message you're about to send, so
   *  they live with the composer, not in the header. Omitted in surfaces (e.g.
   *  embeds) that expose no modifiers → the row doesn't render. */
  leadingControls?: ReactNode;
  /** Optional localStorage key under which the in-progress text is mirrored so a
   *  refresh / crash restores it (and re-loaded when the key changes, e.g. on a
   *  conversation switch). Omit it (embeds) for a non-persisted, ephemeral
   *  composer. A draft is never chat history — it's cleared the moment the
   *  message is sent. */
  draftKey?: string;
}

export function ChatInput({
  onSend,
  onCancel,
  disabled,
  placeholder,
  mentionEntries,
  disabledReason,
  supportsAudioInput,
  supportsImageInput,
  supportsPdfInput,
  leadingControls,
  liveVoice,
  draftKey,
}: Props): JSX.Element {
  const { t } = useTranslation('chat');
  // CHAT-7/A11Y-8 — surface the live-voice PHASE. The visible word rides the
  // placeholder (and the pill while connecting); announcements go through ONE
  // sr-only role=status region below. The textarea's aria-label stays FROZEN —
  // churning the field's accessible NAME per phase would re-announce the whole
  // field identity on every transition.
  const voicePhase = liveVoice?.phase ?? 'idle';
  const phaseWord = t(voicePhaseKey(voicePhase));
  const [phaseAnnounce, setPhaseAnnounce] = useState('');
  const prevPhaseRef = useRef(voicePhase); // init to current: mount announces nothing
  useEffect(() => {
    if (prevPhaseRef.current === voicePhase) return undefined;
    prevPhaseRef.current = voicePhase;
    setPhaseAnnounce(t(voicePhaseKey(voicePhase)));
    const id = setTimeout(() => setPhaseAnnounce(''), 3000);
    return () => clearTimeout(id);
  }, [voicePhase, t]);
  // RCL-UX-4 — ANNOUNCE the reduced-context state. The chip below carries its
  // detail in `title` (mouse-only) + an `sr-only` span inside a conditionally
  // mounted element — which, per the repo's own live-region doctrine, announces
  // NOTHING when the session opens degraded. A voice session is an eyes-busy
  // context, so route the same localized sentence through the global announcer
  // once per degraded session (keyed on the ledger, not the render).
  const degradedAnnounceKey = liveVoice?.active && (liveVoice.degraded?.length ?? 0) > 0
    ? (liveVoice.degraded ?? []).join(',')
    : null;
  const prevDegradedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!degradedAnnounceKey || prevDegradedKeyRef.current === degradedAnnounceKey) return;
    prevDegradedKeyRef.current = degradedAnnounceKey;
    announce(t('voiceReducedContextTitle', { blocks: voiceCtxBlockLabels(t, degradedAnnounceKey.split(',')) }));
  }, [degradedAnnounceKey, t]);
  // Seed from a one-shot staged draft (ADR 0334 5b — another surface opened the
  // chat with a pre-filled composer, e.g. "improve this selection with AI"), else
  // from the persisted draft on first mount (no flash) so a refresh/crash restores
  // in-progress text. The effects below keep it in sync as the user types and
  // re-load it when `draftKey` changes (conversation switch).
  const [text, setText] = useState(() => takeStagedComposerDraft() ?? (draftKey ? readDraft(draftKey) : ''));
  const [pendingAudio, setPendingAudio] = useState<PendingAudio | null>(null);
  const [pendingFiles, setPendingFiles] = useState<readonly PendingFile[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracked for the @-mention popover. Synced from onChange / onSelect
  // / onClick / onKeyUp on the textarea so the popover sees the live
  // caret position.
  const [cursorPos, setCursorPos] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  function syncCursor(): void {
    const el = taRef.current;
    if (!el) return;
    setCursorPos(el.selectionStart ?? 0);
  }

  const recorder = useAudioRecorder();

  // Re-load the draft when the key changes (e.g. switching conversations swaps
  // in that conversation's own in-progress text). Skips the initial mount —
  // useState already seeded from the same key — so it never clobbers what the
  // user is actively typing.
  const lastDraftKey = useRef(draftKey);
  useEffect(() => {
    if (lastDraftKey.current === draftKey) return;
    lastDraftKey.current = draftKey;
    // A staged draft (5b) wins over the switched-in conversation's persisted
    // draft — the deep-link that staged it is the reason for this switch.
    setText(takeStagedComposerDraft() ?? (draftKey ? readDraft(draftKey) : ''));
  }, [draftKey]);

  // ADR 0565 — live-seed lane: the selection-rewrite affordance seeds THIS
  // already-mounted composer (no navigation, so the mount-time stage above
  // never fires). Appends below any in-progress text rather than clobbering
  // it, then moves focus so the user can edit/send the quoted draft.
  useEffect(() => subscribeLiveComposer((seeded) => {
    setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${seeded}` : seeded));
    taRef.current?.focus();
    return true;
  }), []);

  // Mirror the live text to localStorage (debounced) so a refresh / crash
  // restores it. No-op when no key is supplied (ephemeral embeds).
  useEffect(() => {
    if (!draftKey) return;
    const id = setTimeout(() => writeDraft(draftKey, text), 250);
    return () => clearTimeout(id);
  }, [draftKey, text]);

  // Warm the workflow @-mention cache from the backend ownership index on
  // mount (ADR 0163 follow-on) so the caller's REAL owned workflows are
  // available to the `/` picker AND the LLM tool list before the first send.
  // Best-effort: failure leaves the demo + localStorage sources untouched.
  useEffect(() => {
    void refreshWorkflowMentionCache();
  }, []);

  // Auto-resize: clamp scrollHeight to var(--chat-input-height-max) (120px).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  // Revoke any outstanding image-thumbnail object URLs on unmount.
  useEffect(() => () => {
    for (const f of pendingFiles) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
  }, [pendingFiles]);

  function addFiles(files: FileList | null): void {
    if (!files || files.length === 0) return;
    const accepted: PendingFile[] = [];
    let firstReason: string | null = null;
    for (const file of Array.from(files)) {
      const reason = attachmentRejectionReason(file);
      if (reason) { firstReason ??= reason; continue; }
      const isImage = isImageMime(mimeOf(file));
      accepted.push({
        id: crypto.randomUUID(),
        file,
        isImage,
        ...(isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
      });
    }
    setAttachError(firstReason);
    if (accepted.length > 0) setPendingFiles((prev) => [...prev, ...accepted]);
  }

  function removeFile(id: string): void {
    setPendingFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.id !== id);
    });
  }

  function clearPendingFiles(files: readonly PendingFile[]): void {
    for (const f of files) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setPendingFiles([]);
  }

  async function submit(): Promise<void> {
    if (disabled) return;
    if (!text.trim() && !pendingAudio && pendingFiles.length === 0) return;
    const attachments: ContentPart[] = [];
    if (pendingAudio) {
      const dataBase64 = await blobToBase64(pendingAudio.audio.blob);
      attachments.push({
        type: 'audio',
        mimeType: pendingAudio.audio.mimeType,
        dataBase64,
        durationSeconds: pendingAudio.audio.durationSeconds,
      });
    }
    // Convert pending files (inline small / upload large). If any fail, abort
    // the send and surface the error rather than silently dropping the file.
    try {
      for (const pf of pendingFiles) {
        attachments.push(await fileToContentPart(pf.file));
      }
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : t('attachmentFailed'));
      return;
    }
    onSend(text.trim(), attachments.length > 0 ? attachments : undefined);
    setText('');
    // A sent message is no longer a draft — drop it immediately so a refresh
    // right after sending doesn't resurrect the just-sent text.
    if (draftKey) writeDraft(draftKey, '');
    setPendingAudio(null);
    clearPendingFiles(pendingFiles);
    setAttachError(null);
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Belt-and-braces: any popover (SlashAutocomplete, the @-mention
    // popover, future popovers) should stopPropagation on the native
    // event so React's synthetic handler never sees the key — but if
    // a future popover forgets, the `defaultPrevented` check here is
    // a backstop that prevents submitting a half-typed command/mention.
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape' && disabled && onCancel) {
      e.preventDefault();
      void onCancel();
    }
  }

  async function toggleVoice(): Promise<void> {
    if (recorder.isRecording) {
      const audio = await recorder.stop();
      if (audio) {
        setPendingAudio({ id: crypto.randomUUID(), audio });
      }
    } else {
      await recorder.start();
    }
  }

  const canSend = !disabled && (text.trim().length > 0 || pendingAudio !== null || pendingFiles.length > 0);

  return (
    <div className="u-relative">
      {/* Unified slash picker — shows built-in commands AND
          registered workflows in one menu, grouped under subheads.
          Replaces the prior CommandAutocomplete after the 2026-05-28
          mention-symbol swap (`@` is now agents, `/` is unified). */}
      <SlashAutocomplete
        text={text}
        onPick={(newText) => { setText(newText); taRef.current?.focus(); }}
        onDismiss={() => { /* dismiss is implicit on text change */ }}
      />
      {/* `@` picker — agents only (was workflows pre-2026-05-28).
          Workflows live under `/` in SlashAutocomplete above. In a CHANNEL the
          entries are the channel's agent MEMBERS (server mention slugs) instead
          of the tenant-wide list (ADR 0192 D8). */}
      <AgentMentionAutocomplete
        text={text}
        cursorPos={cursorPos}
        {...(mentionEntries ? { entriesOverride: mentionEntries } : {})}
        onPick={(newText, newCursorPos) => {
          setText(newText);
          // Restore the cursor after React commits the new value.
          requestAnimationFrame(() => {
            const el = taRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(newCursorPos, newCursorPos);
            setCursorPos(newCursorPos);
          });
        }}
        onDismiss={() => { /* dismiss is implicit on text/cursor change */ }}
      />
      {/* `@@` picker — Boards of Advisors. Mutually exclusive with the `@`
          agent picker above (single `@` vs `@@` triggers never overlap). */}
      <BoardMentionAutocomplete
        text={text}
        cursorPos={cursorPos}
        onPick={(newText, newCursorPos) => {
          setText(newText);
          requestAnimationFrame(() => {
            const el = taRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(newCursorPos, newCursorPos);
            setCursorPos(newCursorPos);
          });
        }}
        onDismiss={() => { /* dismiss is implicit on text/cursor change */ }}
      />
      {pendingAudio && (
        <div className="u-flex u-items-center u-gap-2 u-pad-6x10 u-mb-1-5 u-bg-surface-2 u-border u-radius u-fs-12">
          <MicIcon size={14} />
          <span className="u-flex-1">
            {t('voiceAttachmentLabel', {
              duration: formatDurationSeconds(pendingAudio.audio.durationSeconds),
              mimeType: pendingAudio.audio.mimeType.split(';')[0],
            })}
            {supportsAudioInput === false && (
              <span
                className="u-text-warning u-ml-1-5"
                title={t('voiceModelUnsupported')}
              >
                {t('voiceModelUnsupportedShort')}
              </span>
            )}
          </span>
          <Button
            variant="secondary" className="u-pad-2x8 u-fs-11 u-minh-0"
            onClick={() => setPendingAudio(null)}
            aria-label={t('removeVoiceAttachment')}
          >
            {t('common:remove')}
          </Button>
        </div>
      )}
      {pendingFiles.length > 0 && (
        <div className="u-flex u-wrap u-gap-1-5 u-mb-1-5">
          {pendingFiles.map((pf) => {
            const isPdf = pf.file.type === 'application/pdf';
            const cantSend =
              (pf.isImage && supportsImageInput === false) ||
              (isPdf && supportsPdfInput === false);
            return (
              <div
                key={pf.id}
                className="chatinput-file-chip"
                style={{
                  border: `1px solid ${cantSend ? 'var(--color-warning)' : 'var(--rule)'}`,
                }}
                title={cantSend ? t('cantReadAttachment') : pf.file.name}
              >
                {pf.isImage && pf.previewUrl ? (
                  <img
                    src={pf.previewUrl}
                    alt={pf.file.name}
                    className="chatinput-file-thumb"
                  />
                ) : (
                  <PaperclipIcon size={14} />
                )}
                <span className="u-flex-1 u-truncate">
                  {pf.file.name}
                </span>
                {cantSend && (
                  <span className="u-text-warning u-iflex" title={t('unsupportedByModel')}>
                    <AlertIcon size={12} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeFile(pf.id)}
                  aria-label={t('removeNamed', { name: pf.file.name })}
                  className="chatinput-file-remove"
                >
                  <XIcon size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {attachError && (
        <div role="alert" className="alert error u-mb-1-5 u-fs-11">{attachError}</div>
      )}
      {/* Voice-phase announcements (CHAT-7/A11Y-8): one polite status region;
          latest phase word wins, cleared after 3s. */}
      {liveVoice ? <span className="sr-only" role="status">{phaseAnnounce}</span> : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
        className="u-hidden"
        aria-hidden="true"
        tabIndex={-1}
      />
      {leadingControls && (
        <div className="chatinput-modifiers">{leadingControls}</div>
      )}
      <div className="chatinput-bar">
        <textarea
          ref={taRef}
          data-walkthrough="chat.composer"
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); setCursorPos(e.target.selectionStart ?? 0); }}
          onKeyDown={onKey}
          onKeyUp={syncCursor}
          onSelect={syncCursor}
          onClick={syncCursor}
          placeholder={liveVoice?.active ? phaseWord : recorder.isRecording ? t('recordingPlaceholder') : (placeholder ?? t('askAnythingPlaceholder'))}
          aria-label={t('composerAriaLabel')}
          disabled={disabled}
          spellCheck={false}
          className="chatinput-textarea"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title={t('attachFileTitle')}
          aria-label={t('attachFile')}
          className="chatinput-attach-btn"
        >
          <PlusIcon size={18} />
        </button>
        {(() => {
          // ADR 0147 — ONE mic. A clip needs a multimodal model; live needs the
          // voice feature. Active session → a hot stop button (clay=live,
          // danger=clip). Idle → a menu when both modes apply, else direct, else
          // nothing (which subsumes "hide the mic when audio is unsupported").
          const canSendAudio = recorder.isSupported && supportsAudioInput !== false;
          const canLive = liveVoice?.available === true;
          if (liveVoice?.active) {
            // RT-8 — the live pill: the real-audio waveform (mic = clay, model = azure)
            // beside the hot stop button. The waveform only renders once the session's
            // analyser graph exists (realtime path); the walkie fallback keeps the
            // plain hot button. Canvas is decorative — the button carries the state.
            return (
              <span className="chatinput-live-pill">
                {(liveVoice.degraded?.length ?? 0) > 0 ? (
                  /* ADR 0277 OQ-1 — the quiet degraded-context signal: the session
                     opened with reduced context (persona/knowledge/identity block
                     failed to compose). Names enumerated in the title only. */
                  <span
                    className="chip chip--muted"
                    title={t('voiceReducedContextTitle', { blocks: voiceCtxBlockLabels(t, liveVoice.degraded ?? []) })}
                  >
                    {t('voiceReducedContext')}
                    {/* SR users get the block detail inline (the title attribute is
                        mouse-only — the STRATUX-5 a11y precedent). */}
                    <span className="sr-only">{t('voiceReducedContextTitle', { blocks: voiceCtxBlockLabels(t, liveVoice.degraded ?? []) })}</span>
                  </span>
                ) : null}
                {liveVoice.audioGraph ? (
                  <Suspense fallback={null}>
                    <VoiceWaveform graph={liveVoice.audioGraph} />
                  </Suspense>
                ) : (
                  /* CHAT-7: while the session is being established (no audio
                     graph yet) the waveform slot carries the phase word, so
                     "Connecting…" is visible instead of dead air — same width
                     as the wave, zero layout shift when the canvas takes over. */
                  <span className="chatinput-live-phase" aria-hidden>{phaseWord}</span>
                )}
                {liveVoice.boardVoice ? (
                  /* ADR 0304 — the boardroom floor: skip the current speaker /
                     mute the voices (transcription keeps running either way). */
                  <>
                    <button type="button" onClick={() => liveVoice.boardVoice?.onSkip()}
                      disabled={voicePhase !== 'speaking'}
                      title={t('voiceSkipTurnTitle')} aria-label={t('voiceSkipTurnAria')}
                      className="chatinput-mic-btn">
                      <SkipForwardIcon size={16} />
                    </button>
                    <button type="button" onClick={() => liveVoice.boardVoice?.onToggleMute()}
                      title={liveVoice.boardVoice.muted ? t('voiceUnmuteTitle') : t('voiceMuteTitle')}
                      aria-label={liveVoice.boardVoice.muted ? t('voiceUnmuteTitle') : t('voiceMuteTitle')}
                      aria-pressed={liveVoice.boardVoice.muted}
                      className="chatinput-mic-btn">
                      {liveVoice.boardVoice.muted ? <VolumeOffIcon size={16} /> : <Volume2Icon size={16} />}
                    </button>
                  </>
                ) : null}
                <button type="button" onClick={() => liveVoice.onToggle()}
                  title={t('voiceLiveStopTitle')} aria-label={t('voiceLiveStopAria')} aria-pressed
                  className="chatinput-mic-btn is-live">
                  <MicIcon size={18} />
                </button>
              </span>
            );
          }
          if (recorder.isRecording) {
            // RT-8 (clip variant) — the recording pill: the same real-audio waveform
            // (danger tone, input-only) beside the hot stop button. Falls back to the
            // plain button when no analyser exists (AudioContext unavailable) — no
            // fake bars, no empty pill chrome.
            const stopBtn = (
              <button type="button" onClick={() => { void toggleVoice(); }}
                title={t('stopRecordingTitle')} aria-label={t('stopVoiceRecording')} aria-pressed
                className="chatinput-mic-btn is-recording">
                <MicIcon size={18} />
              </button>
            );
            return recorder.inputAnalyser ? (
              <span className="chatinput-live-pill is-rec">
                <Suspense fallback={null}>
                  <VoiceWaveform graph={{ input: recorder.inputAnalyser, output: null }} tone="recording" />
                </Suspense>
                {stopBtn}
              </span>
            ) : stopBtn;
          }
          const liveItem = {
            id: 'live',
            label: (
              <span className="u-flex u-items-center u-gap-2">
                <ActivityIcon size={16} />
                <span className="u-grid"><span>{t('voiceMenuLive')}</span><span className="u-fs-11 u-text-muted">{t('voiceMenuLiveHint')}</span></span>
              </span>
            ),
            onSelect: () => liveVoice?.onToggle(),
          };
          const audioItem = {
            id: 'audio',
            label: (
              <span className="u-flex u-items-center u-gap-2">
                <MicIcon size={16} />
                <span className="u-grid"><span>{t('voiceMenuAudio')}</span><span className="u-fs-11 u-text-muted">{t('voiceMenuAudioHint')}</span></span>
              </span>
            ),
            onSelect: () => { void toggleVoice(); },
          };
          if (canSendAudio && canLive) {
            return (
              <Menu label={t('voiceMenuLabel')} triggerTitle={t('voiceMenuLabel')}
                triggerClassName="chatinput-mic-btn" triggerContent={<MicIcon size={18} />}
                items={[liveItem, audioItem]} disabled={disabled ?? false} dropUp />
            );
          }
          if (canSendAudio) {
            return (
              <button type="button" onClick={() => { void toggleVoice(); }} disabled={disabled}
                title={t('recordVoiceTitle')} aria-label={t('startVoiceRecording')} className="chatinput-mic-btn">
                <MicIcon size={18} />
              </button>
            );
          }
          if (canLive) {
            return (
              <button type="button" onClick={() => liveVoice?.onToggle()} disabled={disabled}
                title={t('voiceLiveStartTitle')} aria-label={t('voiceLiveStartAria')} className="chatinput-mic-btn">
                <MicIcon size={18} />
              </button>
            );
          }
          return null;
        })()}
        {disabled && onCancel ? (
          <button
            type="button"
            onClick={() => { void onCancel(); }}
            title={t('stopGeneratingTitle')}
            aria-label={t('stopGenerating')}
            className="chatinput-stop-btn"
          >
            <StopIcon size={12} />
          </button>
        ) : (
          <Button
            variant="accent-solid" className="chatinput-send-btn"
            data-walkthrough="chat.send"
            onClick={() => { void submit(); }}
            disabled={!canSend}
            title={!canSend && disabledReason ? disabledReason : t('sendTitle')}
            aria-label={t('send')}
          >
            <SendIcon size={16} />
          </Button>
        )}
      </div>
      {recorder.error && (
        <div role="alert" className="alert error u-mt-1-5 u-fs-11">{recorder.error}</div>
      )}
    </div>
  );
}
