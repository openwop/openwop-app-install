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

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioRecorder, blobToBase64, type RecordedAudio } from './hooks/useAudioRecorder.js';
import { formatDurationSeconds } from '../i18n/format.js';
import { SlashAutocomplete } from './SlashAutocomplete.js';
import { refreshWorkflowMentionCache } from './lib/workflowMentions.js';
import { AgentMentionAutocomplete } from './AgentMentionAutocomplete.js';
import { BoardMentionAutocomplete } from './BoardMentionAutocomplete.js';
import { MicIcon, ActivityIcon, SendIcon, StopIcon, PaperclipIcon, PlusIcon, XIcon, AlertIcon } from '../ui/icons/index.js';
import { Menu } from '../ui/Menu.js';
import {
  fileToContentPart,
  attachmentRejectionReason,
  isImageMime,
  mimeOf,
  ATTACHMENT_ACCEPT,
} from '../client/mediaClient.js';
import type { ContentPart } from './hooks/useChatSession.js';

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
  /** Reason the send button is disabled, shown in title tooltip. */
  disabledReason?: string | undefined;
  /** Hint that the active provider supports audio input. When false, the
   *  "Send audio" option is hidden (a clip can't be read by this model). */
  supportsAudioInput?: boolean;
  /** Live-conversation mode (ADR 0147), injected by the composer owner so this
   *  generic input stays voice-feature-agnostic (structural type — no
   *  `chat/voice/` import). Absent ⇒ no live mode here (e.g. embeds). */
  liveVoice?: {
    available: boolean;
    active: boolean;
    phase: string;
    onToggle: () => void;
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
  disabledReason,
  supportsAudioInput,
  supportsImageInput,
  supportsPdfInput,
  leadingControls,
  liveVoice,
  draftKey,
}: Props): JSX.Element {
  const { t } = useTranslation('chat');
  // Seed from the persisted draft on first mount (no flash) so a refresh/crash
  // restores in-progress text. The effects below keep it in sync as the user
  // types and re-load it when `draftKey` changes (conversation switch).
  const [text, setText] = useState(() => (draftKey ? readDraft(draftKey) : ''));
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
    setText(draftKey ? readDraft(draftKey) : '');
  }, [draftKey]);

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
          Workflows live under `/` in SlashAutocomplete above. */}
      <AgentMentionAutocomplete
        text={text}
        cursorPos={cursorPos}
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
          <button
            type="button"
            className="secondary u-pad-2x8 u-fs-11 u-minh-0"
            onClick={() => setPendingAudio(null)}
            aria-label={t('removeVoiceAttachment')}
          >
            {t('common:remove')}
          </button>
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
                  border: `1px solid ${cantSend ? 'var(--color-warning)' : 'var(--color-border)'}`,
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
        <div className="alert error u-mb-1-5 u-fs-11">{attachError}</div>
      )}
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
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); setCursorPos(e.target.selectionStart ?? 0); }}
          onKeyDown={onKey}
          onKeyUp={syncCursor}
          onSelect={syncCursor}
          onClick={syncCursor}
          placeholder={liveVoice?.active ? t('voiceLivePlaceholder') : recorder.isRecording ? t('recordingPlaceholder') : (placeholder ?? t('askAnythingPlaceholder'))}
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
            return (
              <button type="button" onClick={() => liveVoice.onToggle()}
                title={t('voiceLiveStopTitle')} aria-label={t('voiceLiveStopAria')} aria-pressed
                className="chatinput-mic-btn is-live">
                <MicIcon size={18} />
              </button>
            );
          }
          if (recorder.isRecording) {
            return (
              <button type="button" onClick={() => { void toggleVoice(); }}
                title={t('stopRecordingTitle')} aria-label={t('stopVoiceRecording')} aria-pressed
                className="chatinput-mic-btn is-recording">
                <MicIcon size={18} />
              </button>
            );
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
          <button
            type="button"
            className="btn-accent-solid chatinput-send-btn"
            onClick={() => { void submit(); }}
            disabled={!canSend}
            title={!canSend && disabledReason ? disabledReason : t('sendTitle')}
            aria-label={t('send')}
          >
            <SendIcon size={16} />
          </button>
        )}
      </div>
      {recorder.error && (
        <div className="alert error u-mt-1-5 u-fs-11">{recorder.error}</div>
      )}
    </div>
  );
}
