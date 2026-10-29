/**
 * ADR 0945 P2 — the judge check: the known-bad edits of `judgeEvalFixture.ts`
 * sent to a REAL vision model, through the same stage A, judge prompt, schema
 * repair and outcome rule production uses. The caller supplies the dispatch,
 * which is the tenant's own BYOK key and model (`resolveHeadlessAiForSpec` or
 * the headless ladder), so nothing here holds a key.
 *
 * Spend is bounded: cases run one at a time, the dispatch refuses past two
 * calls per case (one answer plus at most the judge's single repair), and the
 * first provider failure stops the run without retrying the next case. Only
 * the synthetic fixture images leave the host.
 */
import { Resvg } from '@resvg/resvg-js';
import type { HeadlessDispatch } from '../headlessAi.js';
import { OpenwopError } from '../../types.js';
import { scrubSecretShaped } from '../redactSecrets.js';
import { providerErrorCodes, type ProviderHttpError } from '../../providers/dispatch.js';
import { JUDGE_EVAL_FIXTURE, type JudgeEvalCase } from './judgeEvalFixture.js';
import { STAGE_A_RULES } from './rules.js';
import { rasteriseFull } from './raster.js';
import { productMask, runStageA } from './stageA.js';
import { runFidelityJudge } from './judge.js';
import { judgeOutcome, combineOutcome } from './decide.js';
import type { FidelityCheck, FidelityOutcome } from './types.js';
import type { JudgeAttributeResult } from './judgeSchema.js';

export interface JudgeEvalRow {
  id: string;
  expected: JudgeEvalCase['expect'];
  /** The judge's answer on its own, and the combined production outcome. */
  judged?: FidelityOutcome;
  outcome?: FidelityOutcome;
  passed: boolean;
  repaired?: boolean;
  checks?: FidelityCheck[];
  results?: JudgeAttributeResult[];
  /** Set when the case did not get an answer; the run stopped there. */
  error?: 'judge_invalid' | 'provider_unavailable';
  /** What the provider said when `error` is `provider_unavailable`: only the
   *  HTTP status and the provider's own error codes, never its message. */
  providerError?: ProviderErrorSummary;
}

export interface ProviderErrorSummary {
  status?: number;
  codes: string[];
}

/** Codes a provider puts in its error body: Google's `status`/`reason`
 *  (`RESOURCE_EXHAUSTED`, `API_KEY_INVALID`), OpenAI's and Anthropic's
 *  `type`/`code` (`model_not_found`, `invalid_request_error`). */
const PROVIDER_CODE = /^(?:[A-Z][A-Z0-9_]{2,63}|[a-z][a-z0-9_]{2,63})$/;

/**
 * Reduce a dispatch failure to its HTTP status and error codes. A provider's
 * message text can echo the request (Google repeats the key in some errors), so
 * only values that look like a code are kept, and those are scrubbed again.
 */
export function summariseProviderError(err: unknown): ProviderErrorSummary {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { codes: ['timeout'] };
  if (err instanceof OpenwopError) return { codes: [err.code] };
  const message = err instanceof Error ? err.message : '';
  const head = /^([a-z]+)_(\d{3}):/.exec(message);
  if (!head) {
    const bare = /^([a-z]+_[a-z_]+)\b/.exec(message)?.[1];
    return { codes: bare && PROVIDER_CODE.test(bare) ? [bare] : [] };
  }
  // Prefer the codes the dispatcher read from the WHOLE body: the message is
  // truncated, and Google's 429 states its code after a long quota message.
  const attached = (err as ProviderHttpError).providerCodes;
  const candidates = Array.isArray(attached) ? attached : providerErrorCodes(message);
  const codes = candidates.filter(v => typeof v === 'string' && PROVIDER_CODE.test(v) && scrubSecretShaped(v) === v).slice(0, 4);
  return { status: Number(head[2]), codes };
}

export interface JudgeEvalReport {
  cases: JudgeEvalRow[];
  calls: number;
  maxCalls: number;
  /** Every case got an answer. */
  completed: boolean;
  /** Completed, and every case held for the judge alone AND the combined outcome. */
  passed: boolean;
}

/** The cases a real model is asked about (`ciOnly` ones need a scripted judge). */
export const LIVE_JUDGE_EVAL_CASES: readonly JudgeEvalCase[] = JUDGE_EVAL_FIXTURE.cases.filter((c) => !c.ciOnly);

const png = (body: string, backdrop?: string): string => Buffer.from(new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">${backdrop ? `<rect width="200" height="200" fill="${backdrop}"/>` : ''}${body}</svg>`,
  { font: { loadSystemFonts: false } },
).render().asPng()).toString('base64');

export async function runJudgeEval(dispatch: HeadlessDispatch, opts: { signal?: AbortSignal } = {}): Promise<JudgeEvalReport> {
  const cases = LIVE_JUDGE_EVAL_CASES;
  const maxCalls = cases.length * 2;
  let calls = 0;
  const bounded: HeadlessDispatch = async (messages, o) => {
    if (calls >= maxCalls) throw new Error('judge_eval_budget_exhausted');
    calls += 1;
    return dispatch(messages, o);
  };

  const f = JUDGE_EVAL_FIXTURE;
  const source = png(f.product, f.sourceBackdrop);
  const grid = STAGE_A_RULES.grid;
  const sourceGrid = rasteriseFull('image/png', source, grid);
  const mask = productMask(rasteriseFull('image/png', png(f.product), grid), { w: grid, h: grid });
  const matches = (expect: JudgeEvalCase['expect'], actual: FidelityOutcome): boolean => (expect === 'not_pass' ? actual !== 'pass' : actual === expect);

  const rows: JudgeEvalRow[] = [];
  for (const c of cases) {
    const candidate = png(c.candidate, f.sceneBackdrop);
    const checks = runStageA(sourceGrid, rasteriseFull('image/png', candidate, grid), mask);
    const stage: FidelityOutcome = checks.some((x) => x.status === 'fail') ? 'fail' : 'pass';
    try {
      const out = await runFidelityJudge(bounded, { sources: [{ mimeType: 'image/png', dataBase64: source }], candidate: { mimeType: 'image/png', dataBase64: candidate }, ...(opts.signal ? { signal: opts.signal } : {}) });
      const judged = judgeOutcome(out.results).outcome;
      const outcome = combineOutcome(stage, judged, 'edit');
      rows.push({ id: c.id, expected: c.expect, judged, outcome, passed: matches(c.expect, judged) && matches(c.expect, outcome), repaired: out.repaired, checks, results: out.results });
    } catch (err) {
      const invalid = err instanceof OpenwopError && err.code === 'fidelity_judge_invalid';
      rows.push(invalid
        ? { id: c.id, expected: c.expect, passed: false, error: 'judge_invalid' }
        : { id: c.id, expected: c.expect, passed: false, error: 'provider_unavailable', providerError: summariseProviderError(err) });
      break;
    }
  }
  const completed = rows.length === cases.length && rows.every((r) => !r.error);
  return { cases: rows, calls, maxCalls, completed, passed: completed && rows.every((r) => r.passed) };
}
