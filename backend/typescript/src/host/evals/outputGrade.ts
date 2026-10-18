/**
 * RFC 0081 §A / RFC 0244 §E — grade one trial's OUTPUT (ADR 0889 D4).
 *
 *   golden  — `exact` (normalized stringified equality), `contains`, `json-match`
 *             (key-order-insensitive deep equality). Deterministic.
 *   rubric  — one judge call PER CRITERION through ADR 0477's judge (one judge
 *             path, one LLM-EXCHANGE-AUDIT row). Isolated judges per dimension is
 *             the published practice; a single "score everything" call conflates
 *             them. Score = Σ weight·met / Σ weight. A judge that is unavailable or
 *             returns garbage FAILS the trial with a typed label — never a pass,
 *             never success-with-empty. The failure is read from the judge's
 *             typed `failure` field, never from the wording of its `detail`
 *             (ADR 0889 grade remediation AEV-10). A weight-0 criterion cannot move
 *             the score, so it is never sent to the judge (AEV-3).
 *
 * `scoreLabel` and `evaluatorType` are the OTel-aligned, content-free labels
 * RFC 0244 §E adds to `eval.scored`.
 */
import type { JudgeSubject, TypedEvalJudge } from '../workflowEvalJudge.js';
import { jsonEqual } from './trajectory.js';

export type GoldenStrategy = 'exact' | 'contains' | 'json-match';
export type EvaluatorType = 'deterministic' | 'llm_judge' | 'human';

export interface OutputExpectation {
  kind: 'golden' | 'rubric' | 'trajectory';
  match?: { strategy: GoldenStrategy; value: unknown };
  rubric?: Array<{ criterion: string; weight: number }>;
}

export interface OutputGrade {
  score: number;
  passed: boolean;
  /** Pattern `^[a-z0-9][a-z0-9_-]{0,63}$` (RFC 0244 §E) — never prose. */
  scoreLabel: string;
  evaluatorType: EvaluatorType;
  /** Host-internal reason (shown on the host's own UI, NEVER on an `eval.*` event). */
  detail?: string;
  /** Host-internal: the judge saw a truncated excerpt of the output (AEV-9). */
  judgeInputTruncated?: boolean;
}

/** Options for an LLM-judged grade. */
export interface JudgeOptions {
  judge?: TypedEvalJudge;
  /** What the judge is told it grades (default: an agent's answer). */
  subject?: JudgeSubject;
  /** The run's abort: a cancelled or timed-out run stops judging between criteria. */
  signal?: AbortSignal;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The agent's final output as text: a string as-is, `{content}` unwrapped, else JSON. */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && typeof (output as { content?: unknown }).content === 'string') {
    return (output as { content: string }).content;
  }
  return JSON.stringify(output ?? '');
}

function parseMaybeJson(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

export function gradeGolden(output: unknown, match: { strategy: GoldenStrategy; value: unknown }): OutputGrade {
  let ok: boolean;
  switch (match.strategy) {
    case 'exact':
      ok = normalize(outputText(output)) === normalize(typeof match.value === 'string' ? match.value : JSON.stringify(match.value));
      break;
    case 'contains':
      ok = outputText(output).includes(typeof match.value === 'string' ? match.value : JSON.stringify(match.value));
      break;
    case 'json-match': {
      const actual = parseMaybeJson(output && typeof output === 'object' && 'content' in (output as object) ? (output as { content: unknown }).content : output);
      ok = jsonEqual(actual, match.value);
      break;
    }
  }
  return { score: ok ? 1 : 0, passed: ok, scoreLabel: ok ? 'pass' : 'fail', evaluatorType: 'deterministic' };
}

export async function gradeRubric(
  output: unknown,
  rubric: ReadonlyArray<{ criterion: string; weight: number }>,
  judge: TypedEvalJudge | undefined,
  passScore: number,
  opts: Omit<JudgeOptions, 'judge'> = {},
): Promise<OutputGrade> {
  if (!judge) {
    return { score: 0, passed: false, scoreLabel: 'judge_unavailable', evaluatorType: 'llm_judge', detail: 'no judge is configured for this host' };
  }
  const weighted = rubric.filter((r) => r.weight > 0);
  const totalWeight = weighted.reduce((s, r) => s + r.weight, 0);
  if (totalWeight <= 0) {
    return { score: 0, passed: false, scoreLabel: 'invalid_rubric', evaluatorType: 'llm_judge', detail: 'rubric weights sum to zero' };
  }
  let met = 0;
  let truncated = false;
  const reasons: string[] = [];
  for (const r of weighted) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const verdict = await judge({ criteria: r.criterion, output, subject: opts.subject ?? 'agent', ...(opts.signal ? { signal: opts.signal } : {}) });
    if (verdict.truncated) truncated = true;
    // ADR 0477 §3 — a judge that could not judge FAILS the trial with a typed
    // label, so the scorecard can tell "the agent failed" from "the judge failed".
    if (verdict.failure) {
      const label = verdict.failure === 'unavailable' ? 'judge_unavailable' : 'judge_error';
      return { score: 0, passed: false, scoreLabel: label, evaluatorType: 'llm_judge', detail: verdict.detail, ...(truncated ? { judgeInputTruncated: true } : {}) };
    }
    if (verdict.pass) met += r.weight;
    reasons.push(verdict.detail);
  }
  const score = met / totalWeight;
  const passed = score >= passScore;
  const scoreLabel = score >= 1 ? 'pass' : score <= 0 ? 'fail' : 'partial';
  return { score, passed, scoreLabel, evaluatorType: 'llm_judge', detail: reasons.join(' | '), ...(truncated ? { judgeInputTruncated: true } : {}) };
}

/**
 * Grade one trial's output. `kind: "trajectory"` has no output criterion —
 * the caller grades it on the trajectory alone.
 */
export async function gradeOutput(
  output: unknown,
  expected: OutputExpectation,
  opts: JudgeOptions & { passScore: number },
): Promise<OutputGrade | null> {
  if (expected.kind === 'golden' && expected.match) return gradeGolden(output, expected.match);
  if (expected.kind === 'rubric' && expected.rubric) {
    return gradeRubric(output, expected.rubric, opts.judge, opts.passScore, {
      ...(opts.subject ? { subject: opts.subject } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }
  if (expected.kind === 'trajectory') return null;
  return { score: 0, passed: false, scoreLabel: 'invalid_expectation', evaluatorType: 'deterministic', detail: `expected.kind ${expected.kind} has no matching criterion` };
}
