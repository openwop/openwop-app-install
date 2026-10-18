/**
 * ADR 0889 post-merge review H2 — what an eval trial costs, honestly.
 *
 * The host advertises `agents.evalSuite.maxCostUsdPerSuite`, so the ceiling is a
 * wire claim. It used to be a sum of `provider.usage.costEstimateUsd`, which is
 * ABSENT for any model the rate tables do not price (RFC 0026 §A says omit, not
 * 0) and which never saw the LLM-judge calls at all. Both holes let a suite run
 * uncapped. This module closes them:
 *
 *   - `trialUsageCost` reports a usage event that carried tokens but no price as
 *     UNPRICED. The runner fails the run closed (`eval_cost_unpriced`) instead of
 *     counting $0; the scripted mock (model `mock`) is the only exemption.
 *   - `meterJudge` charges each judge call a conservative UPPER-BOUND estimate
 *     (input chars / 4 tokens plus the judge's max output, at the most expensive
 *     catalog text rate), because the headless judge dispatch returns text only.
 *     Over-counting can only stop a suite early; under-counting is what H2 found.
 */
import { listProviders } from '../../providers/catalog.js';
import {
  excerptOutput,
  JUDGE_MAX_ATTEMPTS,
  JUDGE_MAX_TOKENS,
  JUDGE_PROMPT_OVERHEAD_CHARS,
  type JudgeSubject,
  type TypedEvalJudge,
} from '../workflowEvalJudge.js';

/** USD per 1K tokens, the dearest text model in the catalog (fallback: a high list price). */
function dearestCatalogRate(): { input: number; output: number } {
  let input = 0; let output = 0;
  try {
    for (const p of listProviders()) {
      for (const m of p.models) {
        if (!m.cost) continue;
        input = Math.max(input, m.cost.input);
        output = Math.max(output, m.cost.output);
      }
    }
  } catch { /* catalog unreadable: fall through to the fixed fallback */ }
  return input > 0 && output > 0 ? { input, output } : { input: 0.015, output: 0.075 };
}

/** Upper-bound USD for ONE judge call grading `output` against `criteria`. The
 *  excerpt is the judge's own (`excerptOutput`), so the meter prices what is sent. */
export function estimateJudgeCallUsd(criteria: string, output: unknown, subject: JudgeSubject = 'agent'): number {
  let outChars: number;
  try { outChars = excerptOutput(output, subject).text.length; } catch { outChars = 0; }
  const inputTokens = Math.ceil((criteria.length + outChars + JUDGE_PROMPT_OVERHEAD_CHARS) / 4);
  const rate = dearestCatalogRate();
  return JUDGE_MAX_ATTEMPTS * (inputTokens * rate.input + JUDGE_MAX_TOKENS * rate.output) / 1000;
}

/**
 * Wrap a judge so every call adds its estimate to `meter.usd`. `beforeCall` sees
 * the estimate FIRST and may throw to refuse the call (the runner's in-trial cost
 * ceiling, EVAL-5): a refused call is never charged and never dispatched.
 */
export function meterJudge(judge: TypedEvalJudge, meter: { usd: number }, beforeCall?: (estimateUsd: number) => void): TypedEvalJudge {
  return async (input) => {
    const estimate = estimateJudgeCallUsd(input.criteria, input.output, input.subject);
    beforeCall?.(estimate);
    meter.usd += estimate;
    return judge(input);
  };
}

/** The model the scripted mock reports when no model is pinned; it is never priced. */
export const UNPRICED_MOCK_MODEL = 'mock';

/** Sum `provider.usage` cost for a trial; `unpriced` when any call had tokens but no price. */
export function trialUsageCost(events: ReadonlyArray<{ type: string; payload?: unknown }>): { usd: number; unpriced: boolean } {
  let usd = 0;
  let unpriced = false;
  for (const e of events) {
    if (e.type !== 'provider.usage') continue;
    const p = (e.payload ?? {}) as { costEstimateUsd?: unknown; inputTokens?: unknown; outputTokens?: unknown; model?: unknown };
    const c = p.costEstimateUsd;
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) { usd += c; continue; }
    const tokens = (typeof p.inputTokens === 'number' ? p.inputTokens : 0) + (typeof p.outputTokens === 'number' ? p.outputTokens : 0);
    if (tokens > 0 && p.model !== UNPRICED_MOCK_MODEL) unpriced = true;
  }
  return { usd, unpriced };
}
