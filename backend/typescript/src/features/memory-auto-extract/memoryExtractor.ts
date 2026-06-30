/**
 * ADR 0120 Phase 2c — the LLM fact-extractor `extractConversationMemory` (Phase 2b)
 * injects. `parseFactLines` is PURE + unit-tested; `llmExtractFacts` wraps it around
 * a managed-provider dispatch (host-side key, never on the wire). Kept separate from
 * the binding so the brittle parse is covered without the dispatch coupling.
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import { dispatchManagedChat } from '../../providers/managedProvider.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.memory-auto-extract');
const MANAGED_PROVIDER = 'openwop-free';
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

/** Managed-LLM fact extraction. The key is resolved host-side; the conversation text
 *  is capped. Returns [] on any provider error (extraction is best-effort, never
 *  blocks the turn). */
export async function llmExtractFacts(tenantId: string, conversationText: string): Promise<string[]> {
  try {
    const r = await dispatchManagedChat({
      userFacingProvider: MANAGED_PROVIDER,
      tenantId,
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: conversationText.slice(0, MAX_INPUT_CHARS) },
      ],
      maxTokens: 512,
    });
    return parseFactLines(r.completion ?? '');
  } catch (err) {
    // CONV-2: fail-soft (no facts), but surface the failure (no PII — provider error only).
    log.warn('memory_extract_failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
