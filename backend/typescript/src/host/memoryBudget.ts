/**
 * ADR 0148 Phase 4 (lever A4) — memory injection budget.
 *
 * Knowledge retrieval (`agentKnowledgeComposition.ts`) caps results by COUNT
 * (`topK`), but a few large KB chunks can still dump a lot of text into every
 * turn. This adds an orthogonal SIZE cap: keep the highest-priority retrieved
 * items (relevance order — KB first, then memory) up to a total-char budget,
 * dropping the overflow.
 *
 * NOTES (architect review, ADR 0148 Phase 4):
 *  - Applies to the RELEVANCE-RETRIEVED items only; caller-curated `extraContext`
 *    (ADR 0084 T1 summaries that replace excluded chunks) is exempt — it is
 *    bounded by the binding author and semantically load-bearing.
 *  - Budgets on `content.length` — a directional approximation that ignores
 *    title + fence-wrapper overhead. Fine for a soft budget.
 *  - NON-MUTATING; always keeps ≥1 item (never emit empty when items exist).
 *  - NO LLM summarization here (replay + cost risk; deferred per the ADR
 *    guardrails — must pair with the verifier).
 *
 * @see docs/adr/0148-context-economy-token-budgeted-host-assembly.md
 */

const DEFAULT_MEMORY_MAX_CHARS = 8_000; // ~2k tokens at chars/4

export interface MemoryBudgetConfig {
  /** Soft cap on total content chars of the relevance-retrieved items. */
  readonly maxChars: number;
}

/** Resolve the memory-budget knob from env (used when
 *  `contextEconomy().memoryBudget` is on). */
export function memoryBudgetConfig(): MemoryBudgetConfig {
  const n = parseInt(process.env.OPENWOP_CONTEXT_ECONOMY_MEMORY_MAX_CHARS ?? '', 10);
  return { maxChars: Number.isFinite(n) && n > 0 ? n : DEFAULT_MEMORY_MAX_CHARS };
}

/**
 * Keep the highest-priority items (input order is priority order) whose
 * cumulative `sizeOf` stays within `maxChars`. Always keeps the first item even
 * if it alone exceeds the budget (never drop everything). Pure + non-mutating.
 */
export function budgetByChars<T>(items: readonly T[], maxChars: number, sizeOf: (item: T) => number): T[] {
  if (items.length === 0) return [];
  const kept: T[] = [];
  let chars = 0;
  for (const item of items) {
    const size = Math.max(0, sizeOf(item));
    if (kept.length > 0 && chars + size > maxChars) break;
    kept.push(item);
    chars += size;
  }
  return kept;
}
