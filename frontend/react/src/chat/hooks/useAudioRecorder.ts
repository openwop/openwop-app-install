/**
 * Audio recorder for multi-modal chat input.
 *
 * Captures mic audio via MediaRecorder, exposes the recorded blob +
 * duration on stop. Caller bundles into a ContentPart and sends it as
 * part of the next chat message — bypassing the Web Speech API entirely
 * (which fails when `*.googleapis.com` is blocked).
 *
 * Works in any browser that supports MediaRecorder + getUserMedia
 * (i.e., everything modern except Safari < 14). No external service
 * is required for capture itself; transcription happens on the model
 * server-side when the audio part lands in the chat turn.
 *
 * Format note: Chrome produces `audio/webm;codecs=opus` by default,
 * Firefox `audio/ogg;codecs=opus`, Safari `audio/mp4`. We probe
 * MediaRecorder.isTypeSupported for the best provider-compatible
 * format. Gemini accepts ogg/opus + webm/opus + mp4; we go with
 * webm/opus on Chromium, falling back to whatever the browser does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from '../../i18n/index.js';

export interface RecordedAudio {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

/** Options for `start`. Default = record-to-blob (existing behavior). Passing `onChunk`
 *  + a `timeslice` switches on STREAMING mode (ADR 0138 voice mode): the recorder emits a
 *  chunk every `timeslice` ms so the caller can stream the utterance live, while `stop()`
 *  still returns the full blob. One mic abstraction — no second MediaRecorder. */
export interface StartRecordingOpts {
  onChunk?: (chunk: Blob) => void;
  timeslice?: number;
}

export interface UseAudioRecorderResult {
  isSupported: boolean;
  isRecording: boolean;
  /** Last error from getUserMedia or MediaRecorder. */
  error: string | null;
  /** Start a new recording. Resolves once the mic stream is live. */
  start: (opts?: StartRecordingOpts) => Promise<void>;
  /** Stop the in-flight recording. Resolves with the captured audio. */
  stop: () => Promise<RecordedAudio | null>;
  /** Abort + discard any in-flight recording. */
  cancel: () => void;
  /** RT-8 (clip variant) — analysis-only mic tap for the recording waveform; null when
   *  not recording or where AudioContext is unavailable (recording itself unaffected). */
  inputAnalyser: AnalyserNode | null;
}

/** The MIME type this host's recorder will capture — exported so a streaming caller can
 *  open its host session with the matching `mimeType`. */
export function recorderMimeType(): string {
  return pickMimeType();
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return 'audio/webm';
}

export function useAudioRecorder(): UseAudioRecorderResult {
  const isSupported =
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices !== 'undefined' &&
    typeof MediaRecorder !== 'undefined';

  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputAnalyser, setInputAnalyser] = useState<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analysisCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  const stopResolveRef = useRef<((value: RecordedAudio | null) => void) | null>(null);

  // RT-8 (clip variant): tear the analysis tap down with the recording.
  const closeAnalysis = useCallback(() => {
    const ctx = analysisCtxRef.current;
    analysisCtxRef.current = null;
    if (ctx) { try { void ctx.close(); } catch { /* already closed */ } }
    setInputAnalyser(null);
  }, []);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    const ctx = analysisCtxRef.current;
    if (ctx) { try { void ctx.close(); } catch { /* already closed */ } }
  }, []);

  const start = useCallback(async (opts?: StartRecordingOpts) => {
    if (!isSupported || isRecording) return;
    setError(null);
    chunksRef.current = [];
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(i18n.t('chat:micAccessDenied', { reason }));
      return;
    }
    streamRef.current = stream;
    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunksRef.current.push(e.data);
        opts?.onChunk?.(e.data); // STREAMING mode — emit each chunk live
      }
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const durationSeconds = Math.max(0.1, (Date.now() - startedAtRef.current) / 1000);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      closeAnalysis();
      setIsRecording(false);
      stopResolveRef.current?.({ blob, mimeType, durationSeconds });
      stopResolveRef.current = null;
    };
    rec.onerror = (e) => {
      const reason = (e as ErrorEvent).message ?? i18n.t('chat:unknownRecorderError');
      setError(reason);
    };
    recorderRef.current = rec;
    startedAtRef.current = Date.now();
    // Streaming mode emits a chunk every `timeslice` ms (default 250ms); record-to-blob
    // mode (no onChunk) emits one chunk on stop.
    if (opts?.onChunk) rec.start(opts.timeslice ?? 250);
    else rec.start();
    // RT-8 (clip variant) — analysis-only tap for the recording waveform. Guarded:
    // where AudioContext is unavailable (jsdom, exotic embeds) there is simply no
    // waveform; the recording itself is unaffected.
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      analysisCtxRef.current = ctx;
      setInputAnalyser(analyser);
    } catch { /* no analyser → no waveform */ }
    setIsRecording(true);
  }, [isSupported, isRecording, closeAnalysis]);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return null;
    return new Promise<RecordedAudio | null>((resolve) => {
      stopResolveRef.current = resolve;
      rec.stop();
    });
  }, []);

  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (rec && rec.state !== 'inactive') {
      stopResolveRef.current = () => {/* discard */};
      try { rec.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    chunksRef.current = [];
    closeAnalysis();
    setIsRecording(false);
  }, [closeAnalysis]);

  return { isSupported, isRecording, error, start, stop, cancel, inputAnalyser };
}

/**
 * Re-exported from `client/blobToBase64.ts`, which is the real home.
 *
 * That module's docblock already claimed "The hook re-exports it" — it did not.
 * The hook carried its own copy, and `features/{profiles,media}` still imported
 * THIS path, so the entry-chunk split that module was created to perform had
 * silently regressed. Keeping the named export here so the chat call sites and
 * the two suites that `vi.mock` this module are unaffected.
 */
export { blobToBase64 } from '../../client/blobToBase64.js';
