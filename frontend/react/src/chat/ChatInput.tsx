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

import { useEffect, useRef, useState } from 'react';
import { useAudioRecorder, blobToBase64, type RecordedAudio } from './hooks/useAudioRecorder.js';
import { SlashAutocomplete } from './SlashAutocomplete.js';
import { AgentMentionAutocomplete } from './AgentMentionAutocomplete.js';
import { MicIcon, SendIcon, StopIcon, PaperclipIcon, PlusIcon, XIcon, AlertIcon } from '../ui/icons/index.js';
import {
  fileToContentPart,
  attachmentRejectionReason,
  isImageMime,
  mimeOf,
  ATTACHMENT_ACCEPT,
} from '../client/mediaClient.js';
import type { ContentPart } from './hooks/useChatSession.js';

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
  /** Hint that the active provider supports audio input. When false,
   *  the mic still records, but on send we'll surface a clear error
   *  rather than ship audio to an incompatible model. */
  supportsAudioInput?: boolean;
  /** Hint that the active model accepts image input (vision). When false,
   *  an attached image is flagged with a "switch models" warning. */
  supportsImageInput?: boolean;
  /** Hint that the active model accepts PDF documents (Anthropic / Gemini).
   *  Text files (.txt/.md/.json/.csv) inline as text and work everywhere. */
  supportsPdfInput?: boolean;
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
}: Props): JSX.Element {
  const [text, setText] = useState('');
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
      setAttachError(err instanceof Error ? err.message : 'Attachment failed.');
      return;
    }
    onSend(text.trim(), attachments.length > 0 ? attachments : undefined);
    setText('');
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
      {pendingAudio && (
        <div className="u-flex u-items-center u-gap-2 u-pad-6x10 u-mb-1-5 u-bg-surface-2 u-border u-radius u-fs-12">
          <MicIcon size={14} />
          <span className="u-flex-1">
            Voice attachment ({pendingAudio.audio.durationSeconds.toFixed(1)}s, {pendingAudio.audio.mimeType.split(';')[0]})
            {supportsAudioInput === false && (
              <span className="u-text-warning u-ml-1-5">
                — current model doesn't accept audio. Switch to a Gemini model or remove the attachment.
              </span>
            )}
          </span>
          <button
            type="button"
            className="secondary u-pad-2x8 u-fs-11 u-minh-0"
            onClick={() => setPendingAudio(null)}
            aria-label="Remove voice attachment"
          >
            Remove
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
                title={cantSend ? "The current model can't read this attachment — switch to a vision/PDF-capable model." : pf.file.name}
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
                  <span className="u-text-warning u-iflex" title="Unsupported by the current model">
                    <AlertIcon size={12} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeFile(pf.id)}
                  aria-label={`Remove ${pf.file.name}`}
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
          placeholder={recorder.isRecording ? 'Recording…' : (placeholder ?? 'Ask anything…')}
          disabled={disabled}
          spellCheck={false}
          className="chatinput-textarea"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="Attach a file (images, PDF, .txt/.md/.json/.csv)"
          aria-label="Attach a file"
          className="chatinput-attach-btn"
        >
          <PlusIcon size={18} />
        </button>
        {recorder.isSupported && (
          <button
            type="button"
            onClick={() => { void toggleVoice(); }}
            disabled={disabled && !recorder.isRecording}
            title={recorder.isRecording ? 'Stop recording' : 'Record voice attachment'}
            aria-label={recorder.isRecording ? 'Stop voice recording' : 'Start voice recording'}
            aria-pressed={recorder.isRecording}
            className="chatinput-mic-btn"
            style={{
              background: recorder.isRecording ? 'var(--color-danger)' : 'var(--color-surface-2)',
              color: recorder.isRecording ? 'white' : 'var(--color-text)',
              animation: recorder.isRecording ? 'openwop-mic-pulse 1.2s ease-in-out infinite' : 'none',
            }}
          >
            <MicIcon size={18} />
          </button>
        )}
        {disabled && onCancel ? (
          <button
            type="button"
            onClick={() => { void onCancel(); }}
            title="Stop generating (Esc)"
            aria-label="Stop generating"
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
            title={!canSend && disabledReason ? disabledReason : 'Send (Enter)'}
            aria-label="Send"
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
