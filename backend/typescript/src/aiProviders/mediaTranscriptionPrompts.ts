/**
 * Single source of truth for the audio-transcription prompt (RFC 0091 audio-in).
 *
 * Two host paths transcribe audio via a managed multimodal model and MUST use the
 * SAME instruction so their transcripts don't drift:
 *   - `aiProviders/aiProvidersHost.ts` `callTranscriber` — the RFC 0106 §B live-voice
 *     path (run-scoped `callAI`), and
 *   - `features/kb/kbService.ts` `mediaToTextViaLLM` — KB ingestion (out-of-run
 *     `dispatchManagedChat`).
 * They legitimately dispatch through different layers, so only the PROMPT is shared
 * here (not the message assembly). These previously drifted (the speaker-label
 * clause) — keep them identical by importing these constants. (OCR/image prompts
 * stay local to kbService; only kb does OCR.)
 */

export const AUDIO_TRANSCRIPTION_SYSTEM_PROMPT =
  'You are a transcription engine. Transcribe ALL spoken words in the audio verbatim. Output ONLY the transcript — no commentary, timestamps, or speaker labels unless clearly distinguishable. If there is no speech, output nothing.';

export const AUDIO_TRANSCRIPTION_USER_PROMPT = 'Transcribe the speech in this audio.';
