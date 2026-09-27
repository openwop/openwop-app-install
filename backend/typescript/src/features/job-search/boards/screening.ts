/**
 * ADR 0542 D3 — an injection attempt is a SKIPPED LISTING WITH A REASON, never a
 * stopped campaign.
 *
 * A posting is attacker-authored text that will reach a model holding tools and
 * credentials. The doctrine is not new; what matters here is that it is
 * MECHANISM rather than instruction. Three layers, and this module is only the
 * first:
 *
 *  1. **Screening (here).** A posting whose body is shaped like an instruction
 *     to the agent is skipped with a recorded reason, so it never enters the
 *     listing store at all.
 *  2. **Fencing.** Anything that does reach a model is `<UNTRUSTED>`-fenced at
 *     model-message construction, because the tool returning it declares
 *     `contentTrust: 'untrusted'` (RFC 0137 §F1, ratchet-enforced).
 *  3. **Egress.** A posting cannot cause a fetch: extraction is PURE and the one
 *     outbound call goes through the host egress guard with a declared origin.
 *
 * Screening alone would be a filter to evade; fencing alone would let hostile
 * text accumulate in the store. Neither is sufficient, which is why both exist.
 *
 * ## Why this is deliberately conservative
 *
 * A false positive costs ONE listing, recorded with a reason the user can read.
 * A false negative puts instruction text in front of a tool-holding model. The
 * asymmetry is large and one-directional, so the patterns below err toward
 * skipping — and every skip is attributable rather than silent.
 */

export type SkipReason =
  | 'instruction-to-agent'
  | 'credential-solicitation'
  | 'embedded-directive-markup';

export interface ScreenResult {
  ok: boolean;
  reason: SkipReason | null;
  /** The matched fragment, clipped — so a skip can be justified to the user
   *  rather than asserted. An unexplained skip is indistinguishable from a job
   *  that was never found. */
  evidence: string | null;
}

const PASS: ScreenResult = { ok: true, reason: null, evidence: null };

interface Pattern { reason: SkipReason; re: RegExp }

/**
 * The patterns. Each targets a SHAPE of instruction rather than a keyword, so
 * ordinary job copy ("we ignore no one", "system administrator") does not trip
 * them — the words alone are common in real postings; the imperative framing is
 * not.
 */
const PATTERNS: readonly Pattern[] = [
  // "ignore previous instructions", "disregard the above rules"
  { reason: 'instruction-to-agent', re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,40}\b(instruction|prompt|rule|direction|system)/i },
  // "you are now …", "act as …", "your new task is"
  { reason: 'instruction-to-agent', re: /\byou\s+are\s+now\b|\bact\s+as\s+(an?|the)\b[^.\n]{0,30}\b(assistant|agent|model|ai)\b|\byour\s+new\s+(task|instruction|goal)\b/i },
  // "fetch https://…", "send a request to …", "curl …"
  { reason: 'instruction-to-agent', re: /\b(fetch|retrieve|download|POST|send\s+(a\s+)?request)\b[^.\n]{0,30}https?:\/\//i },
  // env vars / secrets / keys — solicitation, not mention
  { reason: 'credential-solicitation', re: /\b(reveal|print|output|return|share|disclose|leak)\b[^.\n]{0,40}\b(env(ironment)?\s*var|api[_\s-]?key|secret|token|credential|password)/i },
  { reason: 'credential-solicitation', re: /\bprocess\.env\b|\bAWS_SECRET|\bOPENAI_API_KEY|\bBEARER\s+[A-Za-z0-9._-]{20,}/ },
  // Someone else's fence markers, i.e. an attempt to close ours and speak outside it
  { reason: 'embedded-directive-markup', re: /<\/?\s*(UNTRUSTED|SYSTEM|INSTRUCTIONS?)\s*>/i },
  { reason: 'embedded-directive-markup', re: /\[\/?\s*(SYSTEM|INST|INSTRUCTIONS?)\s*\]/i },
];

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

/**
 * Screen a posting's free text before it becomes a listing.
 *
 * PURE — no I/O of any kind. That is the structural half of "zero egress": a
 * posting cannot cause a network call here because this module has no way to
 * make one, which is a stronger guarantee than observing that it did not.
 */
export function screenPostingText(...parts: Array<string | null | undefined>): ScreenResult {
  const text = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
  if (text.length === 0) return PASS;
  for (const { reason, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) return { ok: false, reason, evidence: clip(m[0]) };
  }
  return PASS;
}
