/**
 * Voice-clip transcription for the exchange pipeline (ADR 0327 P1, RT-10).
 *
 * A voice-clip turn (audio parts, no typed text) is transcribed host-side
 * FIRST, so the user's spoken words become part of THEIR turn: the bubble
 * shows the transcript (+ the audio player), routing/knowledge/channel
 * mirrors get real text, and the model ANSWERS the words instead of
 * parroting them back as its reply. Rides the SAME provider/key/budget path
 * as the reply (`dispatchReply`). Fail-soft: any failure ⇒ the turn stays
 * audio-only and the model still hears the raw audio.
 */

import type { ChatMessage, ContentPart } from '../../providers/dispatch.js';
import type { RunRecord } from '../../types.js';
import { AUDIO_TRANSCRIPTION_SYSTEM_PROMPT, AUDIO_TRANSCRIPTION_USER_PROMPT } from '../../aiProviders/mediaTranscriptionPrompts.js';
import { dispatchReply } from './dispatchTurn.js';
import { isContentParts } from './contentParts.js';

/** RT-10 — transcribe a voice-clip turn's audio through the SAME provider/key/budget
 *  path as the reply (`dispatchReply`), using the host's shared transcription prompt
 *  (the one KB ingestion + `callTranscriber` use, so transcripts never drift). The
 *  transcript becomes a text part of the USER's turn. Fail-soft: any failure — a
 *  provider without audio-in, a missing key, a mock run — returns null and the turn
 *  stays audio-only (the model still receives the raw audio parts). */
async function transcribeTurnAudio(run: RunRecord, audioParts: ReadonlyArray<Extract<ContentPart, { type: 'audio' }>>): Promise<string | null> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: AUDIO_TRANSCRIPTION_SYSTEM_PROMPT },
      { role: 'user', content: [{ type: 'text', text: AUDIO_TRANSCRIPTION_USER_PROMPT }, ...audioParts] },
    ];
    const { completion } = await dispatchReply(run, messages);
    const transcript = completion.trim();
    return transcript.length > 0 ? transcript : null;
  } catch {
    return null;
  }
}

/** Fold a voice-clip turn's transcript into its content: when the turn has audio
 *  parts and NO typed text, prepend the host-side transcript as a text part.
 *  Any other shape (typed text present, no audio, transcription failure) returns
 *  the content unchanged. */
export async function foldVoiceClipTranscript(run: RunRecord, rawContent: unknown): Promise<unknown> {
  if (!isContentParts(rawContent)) return rawContent;
  const hasTypedText = rawContent.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const audioParts = rawContent.filter((p): p is Extract<ContentPart, { type: 'audio' }> => p.type === 'audio' && p.dataBase64.length > 0);
  if (hasTypedText || audioParts.length === 0) return rawContent;
  const transcript = await transcribeTurnAudio(run, audioParts);
  return transcript ? [{ type: 'text', text: transcript }, ...rawContent] : rawContent;
}
