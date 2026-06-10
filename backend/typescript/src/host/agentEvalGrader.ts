/**
 * A8 — a real, deterministic agent-eval grader (RFC 0081 intent).
 *
 * The deep-dive flagged the eval suite as demo-only with no grader. This is a
 * genuine, self-contained grader: it scores an agent's result against typed
 * criteria — `golden` (normalized exact match), `rubric` (required/forbidden
 * substrings), `schema` (JSON-Schema validity) — and aggregates to a content-
 * free `EvalSummary` (per-task scores + pass count, no result text), matching
 * the `eval-summary-no-content-leak` posture. Deterministic ⇒ replay-safe and
 * suitable as a real grader for a reference host; an ML/LLM-judge grader is a
 * drop-in alternative behind the same `GradedTask` shape.
 */

import Ajv2020 from 'ajv/dist/2020.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });

export type EvalCriterion =
  | { kind: 'golden'; expected: string }
  | { kind: 'rubric'; mustInclude?: string[]; mustExclude?: string[] }
  | { kind: 'schema'; schema: Record<string, unknown> };

export interface EvalTask {
  taskId: string;
  criterion: EvalCriterion;
  /** Pass threshold in [0,1]; default 1 (exact). */
  threshold?: number;
}

export interface GradedTask {
  taskId: string;
  score: number; // [0,1]
  passed: boolean;
}

/** Content-free aggregate (RFC 0081 `EvalSummary` shape — scalars only). */
export interface EvalSummary {
  total: number;
  passed: number;
  passRate: number;
  meanScore: number;
  tasks: GradedTask[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'content' in result && typeof (result as { content: unknown }).content === 'string') {
    return (result as { content: string }).content;
  }
  return JSON.stringify(result ?? '');
}

/** Score one result against one criterion → [0,1]. */
export function scoreCriterion(result: unknown, criterion: EvalCriterion): number {
  switch (criterion.kind) {
    case 'golden':
      return normalize(resultText(result)) === normalize(criterion.expected) ? 1 : 0;
    case 'rubric': {
      const text = normalize(resultText(result));
      const inc = criterion.mustInclude ?? [];
      const exc = criterion.mustExclude ?? [];
      const checks = inc.length + exc.length;
      if (checks === 0) return 1;
      let ok = 0;
      for (const s of inc) if (text.includes(normalize(s))) ok += 1;
      for (const s of exc) if (!text.includes(normalize(s))) ok += 1;
      return ok / checks;
    }
    case 'schema': {
      try {
        const { $id: _drop, ...rest } = criterion.schema as Record<string, unknown>;
        const validate = ajv.compile(rest);
        return validate(result) ? 1 : 0;
      } catch {
        return 0;
      }
    }
    default:
      return 0;
  }
}

export function gradeTask(result: unknown, task: EvalTask): GradedTask {
  const score = scoreCriterion(result, task.criterion);
  const threshold = typeof task.threshold === 'number' ? task.threshold : 1;
  return { taskId: task.taskId, score, passed: score >= threshold };
}

/** Grade a suite: each task is graded against the result the runner produced
 *  for it (parallel arrays). Returns the content-free EvalSummary. */
export function gradeSuite(tasks: EvalTask[], results: unknown[]): EvalSummary {
  const graded = tasks.map((t, i) => gradeTask(results[i], t));
  const passed = graded.filter((g) => g.passed).length;
  const meanScore = graded.length ? graded.reduce((a, g) => a + g.score, 0) / graded.length : 0;
  return {
    total: graded.length,
    passed,
    passRate: graded.length ? passed / graded.length : 0,
    meanScore,
    tasks: graded,
  };
}
