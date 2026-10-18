/**
 * Realtime instruction budget (ADR 0893 D8, architect H6/M7).
 *
 * Providers cap the system-instruction payload, so the composed instructions are
 * held under a ceiling. The old guard did `withoutTranscript.slice(0, MAX)`, a
 * character cut that could land inside an untrusted fence and leave an unclosed
 * data-only block in a live model session (the TOCC-4 class, ADR 0604).
 *
 * This sheds WHOLE blocks instead: the transcript digest first (oldest context,
 * already elision-tolerant), then the work-snapshot preamble. The transcript is
 * trimmed to its room BEFORE it is fenced, so its fence is always whole. Only if
 * the system prompt alone overflows is it cut, and that cut stops before any fence
 * it would leave open.
 */
import { truncateFencedContent, UNTRUSTED_FENCE_END } from '../../../host/untrustedContent.js';
import { wrapForLLMPrompt } from '../../../host/promptInjectionGuard.js';

export const MAX_INSTRUCTIONS_CHARS = 24_000;

/** The fence openers/closers the composed instructions can carry: the RFC 0021
 *  angle fence (`wrapForLLMPrompt`) and the BEGIN/END word fence. */
const FENCES: ReadonlyArray<{ open: string; close: string }> = [
  { open: '<UNTRUSTED', close: '</UNTRUSTED>' },
  { open: 'BEGIN UNTRUSTED CONTENT', close: UNTRUSTED_FENCE_END },
];

/** Cut `text` to at most `max` chars without leaving a fence open: when the cut
 *  falls inside a fenced block, the whole block (from its opener) is dropped. */
export function cutOutsideFences(text: string, max: number): string {
  // The shared fence-aware cut first (surrogate-safe, re-closes a trailing word
  // fence); then any fence the cut still leaves open is dropped from its opener.
  let out = truncateFencedContent(text, max);
  for (;;) {
    let openAt = -1;
    for (const f of FENCES) {
      const o = out.lastIndexOf(f.open);
      if (o > out.lastIndexOf(f.close) && o > openAt) openAt = o;
    }
    if (openAt < 0) return out;
    out = out.slice(0, openAt);
  }
}

/** Fence the (other members') transcript digest as untrusted conversation data. */
function fenceTranscript(text: string): string {
  return wrapForLLMPrompt({ contentTrust: 'untrusted', payload: text, source: 'voice-transcript-digest', eventType: 'conversation.history' });
}

export function budgetInstructions(parts: { systemPrompt: string; addendum: string; preamble: string; transcript: string }, max = MAX_INSTRUCTIONS_CHARS): string {
  const join = (blocks: string[]): string => blocks.filter((b) => b.length > 0).join('\n\n');
  const head = join([parts.systemPrompt, parts.addendum, parts.preamble]);
  if (parts.transcript.length > 0) {
    const whole = join([head, fenceTranscript(parts.transcript)]);
    if (whole.length <= max) return whole;
    // Trim the RAW transcript to the room its fence leaves, then fence it whole.
    const overhead = fenceTranscript('').length + 2;
    const room = max - head.length - overhead;
    if (room > 200) {
      // Defanging can lengthen the payload, so the result is re-measured, never assumed.
      const trimmed = join([head, fenceTranscript(parts.transcript.slice(-room))]);
      if (trimmed.length <= max) return trimmed;
    }
  }
  if (head.length <= max) return head;
  const withoutPreamble = join([parts.systemPrompt, parts.addendum]);
  if (withoutPreamble.length <= max) return withoutPreamble;
  return cutOutsideFences(parts.systemPrompt, max);
}
