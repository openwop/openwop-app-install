/**
 * ADR 0120 Phase 2c — the LLM fact-extractor `extractConversationMemory` (Phase 2b)
 * injects. `parseFactLines` is PURE + unit-tested; `llmExtractFacts` wraps it around
 * a host-side dispatch (key never on the wire). Kept separate from the binding so
 * the brittle parse is covered without the dispatch coupling.
 *
 * WHICH KEY (ADR 0821 D5 follow-up): the dispatch comes from the ONE headless
 * resolver (`host/headlessAi.ts` `resolveHeadlessAi`, text modality), never a
 * direct `dispatchManagedChat`, so the tenant's BYOK `preferForText` opt-in is
 * honoured like every other headless text caller. Opt-in OFF (default): managed,
 * attributed to `memory-auto-extract` and metered to the acting subject (ADR 0821
 * D4, ADR 0721) — unchanged. Opt-in ON: the tenant's key on its bound model (fact
 * quality matters more than for a title); an unresolvable key falls back to
 * managed; a provider error yields no facts and no managed retry. The turn is
 * never affected: the caller races this against a bound and ignores failures.
 * Non-replay: runs after the exchange is persisted, outside any recorded run.
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import { resolveHeadlessAi } from '../../host/headlessAi.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.memory-auto-extract');
const MAX_INPUT_CHARS = 8000;
const MAX_FACTS = 10;

const EXTRACT_PROMPT =
  'You extract DURABLE, factual statements about the user from a conversation — stable ' +
  'preferences, role, location, ongoing goals, named entities they own. Output ONE fact ' +
  'per line, terse third-person ("Prefers dark mode", "Works at Acme as a designer"). Do ' +
  'NOT include ephemeral chatter, questions, the assistant\'s words, or speculation. If ' +
  'there are no durable facts, output exactly "NONE".';

/** Parse the model's line-per-fact output into clean, bounded facts. Strips bullet/
 *  number prefixes, drops too-short/too-long lines + "none/n/a" sentinels, caps the
 *  count. Pure + deterministic. */
export function parseFactLines(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (raw ?? '').split('\n')) {
    const cleaned = line.replace(/^[-*•\d.)\s]+/, '').trim();
    if (cleaned.length < 4 || cleaned.length > 280) continue;
    if (/^(none|no\s+facts?|n\/?a)\.?$/i.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

/** LLM fact extraction (managed, or the tenant's key when opted in). The key is resolved host-side; the conversation text
 *  is capped. Returns [] on any provider error (extraction is best-effort, never
 *  blocks the turn). */
export async function llmExtractFacts(tenantId: string, conversationText: string, actingSubject?: string): Promise<string[]> {
  try {
    const dispatch = await resolveHeadlessAi(tenantId, 'text', {
      featureId: 'memory-auto-extract', // ADR 0821 D4
      // ADR 0721 — extraction is work done FOR a person and must meter to them.
      // The caller already has the subject in the same expression.
      ...(actingSubject ? { actingSubject } : {}),
    });
    if (!dispatch) return []; // unreachable for text today (managed always qualifies); honest no-op
    const completion = await dispatch(
      [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: conversationText.slice(0, MAX_INPUT_CHARS) },
      ],
      { maxTokens: 512 },
    );
    return parseFactLines(completion);
  } catch (err) {
    // CONV-2: fail-soft (no facts), but surface the failure (no PII — provider error only).
    log.warn('memory_extract_failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
