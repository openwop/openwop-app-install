/**
 * ADR 0148 Phase 3 (lever A1) — token-budgeted transcript.
 *
 * The chat path re-folds the FULL conversation history into the model prompt on
 * every exchange (conversationExchange.ts), so cumulative cost grows ~O(turns²).
 * This bounds it: keep the most-recent `keepLastTurns` turns verbatim AND within
 * a `maxChars` text budget; older turns are elided (the caller appends a
 * deterministic marker so the model knows context was truncated).
 *
 * SCOPE / HONESTY (architect review, ADR 0148 Phase 3):
 *  - This bounds the CHAT history fold — a host-internal, presentation-only
 *    transform. The conversation EVENT LOG stays full-fidelity; turns are
 *    re-folded from the log each exchange, so windowing is deterministic and
 *    replay/fork-safe (nothing windowed is persisted or stamped on the run).
 *  - It is NOT the RFC 0061 `multiAgentExecution.transcriptWindow` (that
 *    describes the ORCHESTRATOR's per-turn event-log window; this app's
 *    orchestrator runs no real model turns, so that capability is deliberately
 *    NOT advertised — advertising it would be a dishonest wire claim). See the
 *    ADR 0148 Phase 3 correction note. The same condition governs RFC 0111
 *    `multiAgentExecution.contextBudget`.
 *
 *    THAT NON-ADVERT IS NOW ENFORCED, NOT JUST DOCUMENTED (ADR 0537). On
 *    2026-08-09 this paragraph was correct, current, and still failed to prevent
 *    `contextBudget` being claimed as in-flight host work — it is prose, so it
 *    cannot go red. `test/rfc0111-context-budget-non-advert.test.ts` now pins
 *    both halves: that no `contextBudget`/`transcriptWindow` is advertised on any
 *    surface, AND the premise (the supervisor reaches no model turn). Change the
 *    orchestrator and that test tells you to revisit the advert.
 *  - NO model-summarization here: an LLM rolling-summary in the hot path carries
 *    replay + cost risk and must pair with the verifier (deferred).
 *
 * @see docs/adr/0148-context-economy-token-budgeted-host-assembly.md
 */

export interface TranscriptBudgetConfig {
  /** Hard cap on the number of most-recent turns kept verbatim. */
  readonly keepLastTurns: number;
  /** Soft cap on the total TEXT characters of kept turns (newest-first); a turn
   *  that would exceed it is elided. Measured on text only so a single
   *  multimodal turn (image/file bytes) can't evict all text history. */
  readonly maxChars: number;
  /** ADR 1003 D2 — the first kept turn moves only in steps of this many turns,
   *  counted from turn 0 of the conversation. Absent ⇒ 1 (the original
   *  slide-by-one window). */
  readonly stepTurns?: number;
}

const DEFAULT_KEEP_LAST_TURNS = 20;
const DEFAULT_MAX_CHARS = 24_000; // ~6k tokens at chars/4

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve the transcript-budget knobs from env (used when
 *  `contextEconomy().transcriptBudget` is on). */
export function transcriptBudgetConfig(): TranscriptBudgetConfig {
  const keepLastTurns = envInt('OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_KEEP_TURNS', DEFAULT_KEEP_LAST_TURNS);
  return {
    keepLastTurns,
    maxChars: envInt('OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_MAX_CHARS', DEFAULT_MAX_CHARS),
    stepTurns: envInt('OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_STEP_TURNS', Math.max(1, Math.floor(keepLastTurns / 2))),
  };
}

/** ADR 1003 D2 — the voice-session seed's budget: the same caps, NO stepping.
 *  A seed is composed once per session, so a cache-stable window buys nothing
 *  there and stepping would only drop turns the caps allow. */
export function voiceSeedBudgetConfig(): TranscriptBudgetConfig {
  return { ...transcriptBudgetConfig(), stepTurns: 1 };
}

export interface WindowedTranscript<T> {
  /** The kept turns, in original chronological order. */
  readonly kept: T[];
  /** How many leading turns were elided (0 ⇒ nothing dropped). */
  readonly omittedCount: number;
}

/**
 * Window a chronological turn list to the budget: keep the most-recent turns up
 * to `keepLastTurns` AND within `maxChars` of text (accumulated newest-first),
 * then move the first kept turn only in steps of `stepTurns` (ADR 1003 D2),
 * preserving chronological order in the result. Pure + non-mutating.
 *
 * @param turns   chronological prior turns (oldest first)
 * @param cfg     the budget knobs
 * @param sizeOf  TEXT length of a turn (NOT serialized bytes — keeps media turns
 *                from distorting the budget)
 */
export function windowTranscript<T>(
  turns: readonly T[],
  cfg: TranscriptBudgetConfig,
  sizeOf: (turn: T) => number,
): WindowedTranscript<T> {
  if (turns.length === 0) return { kept: [], omittedCount: 0 };
  const kept: T[] = [];
  let chars = 0;
  // Walk newest → oldest, admitting turns until either cap is hit.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (kept.length >= cfg.keepLastTurns) break;
    const size = Math.max(0, sizeOf(turns[i]));
    // Always admit at least the single most-recent turn even if it alone exceeds
    // maxChars (never send an empty history when there is a turn to send).
    if (kept.length > 0 && chars + size > cfg.maxChars) break;
    kept.push(turns[i]);
    chars += size;
  }
  // ADR 1003 D2 — hold the window still between steps. A window that slides by
  // one turn on every exchange changes the first kept turn (and the elision
  // count the caller writes into the system message) every time, so no provider
  // prefix cache ever hits. Rounding the first kept index UP to a multiple of
  // `stepTurns`, counted from turn 0, keeps the kept prefix byte-identical until
  // the caps push it past the next multiple. Rounding up only ever drops more
  // (≤ stepTurns − 1 turns), so both caps still hold; the newest turn is always
  // kept. Pure in (turns, cfg, sizeOf): the same conversation windows the same
  // way on every run.
  const step = Math.max(1, Math.floor(cfg.stepTurns ?? 1));
  const firstByCaps = turns.length - kept.length;
  if (firstByCaps === 0 || step === 1) {
    kept.reverse(); // restore chronological order
    return { kept, omittedCount: firstByCaps };
  }
  const first = Math.min(Math.ceil(firstByCaps / step) * step, turns.length - 1);
  return { kept: turns.slice(first), omittedCount: first };
}
