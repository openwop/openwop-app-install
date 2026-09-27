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

/** Policy knob for the ONE budget algorithm below. See `budgetByChars`. */
export interface BudgetByCharsOptions {
  /**
   * Whether a lone first item that ALONE exceeds `maxChars` is kept anyway.
   *
   * `true` (the default, ADR 0148 A4 semantics) — a SOFT budget: never emit an
   * empty context when items exist, because starving a turn of all retrieved
   * context is worse for the product than overshooting a soft cap.
   *
   * `false` (RFC 0113 §"Injection budget" clause 1) — a HARD budget: *"A single
   * entry exceeding the budget on its own MUST be omitted (not truncated
   * mid-entry)."* A host advertising `memory.injectionBudget.supported` MUST
   * honour this, so the RFC 0004 memory read passes `false`.
   */
  readonly keepAtLeastOne?: boolean;
}

/**
 * Keep the highest-priority items (input order is priority order) whose
 * cumulative `sizeOf` stays within `maxChars`. Pure + non-mutating.
 *
 * ONE algorithm, TWO named policies — see `BudgetByCharsOptions.keepAtLeastOne`.
 * The policies are genuinely different requirements over the same computation
 * (ADR 0148 A4 wants a soft cap that never starves a turn; RFC 0113 mandates a
 * hard cap), so they are expressed as a named option rather than as two budget
 * models or as a post-filter at one call site. Defaulted so every pre-existing
 * caller is byte-identical.
 *
 * CORRECTION (H49, 2026-08-17): this helper previously kept the first item
 * unconditionally, with no way to opt out — and `listMemoryEntries` consumed it
 * on the path this host advertises as `memory.injectionBudget.supported: true`.
 * So `GET /v1/host/openwop-app/memory?tokenBudget=N` could return a set whose
 * cumulative size EXCEEDED `N` whenever the most-recent entry was over-budget:
 * a live over-claim on the wire, reachable with no fixture involved. The old
 * `test/rfc0113-memory-budget.test.ts` case *"always keeps ≥1 entry even when
 * the first alone exceeds the budget"* PINNED that violation — it had been
 * written from this primitive's contract rather than from RFC 0113, so it
 * agreed with the bug. It is inverted there now.
 */
export function budgetByChars<T>(
  items: readonly T[],
  maxChars: number,
  sizeOf: (item: T) => number,
  options: BudgetByCharsOptions = {},
): T[] {
  if (items.length === 0) return [];
  const keepAtLeastOne = options.keepAtLeastOne ?? true;
  const kept: T[] = [];
  let chars = 0;
  for (const item of items) {
    const size = Math.max(0, sizeOf(item));
    // The first item is exempt from the cap ONLY under the soft policy. Under
    // the hard policy an over-budget lone entry is dropped whole, and an empty
    // result is the correct, conformant answer.
    if ((kept.length > 0 || !keepAtLeastOne) && chars + size > maxChars) break;
    kept.push(item);
    chars += size;
  }
  return kept;
}
