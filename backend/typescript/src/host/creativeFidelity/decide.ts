/**
 * ADR 0945 D3 — the outcome rule, ONE place (the service and the live eval
 * gate both call it). `fail` = a stage-A fail or a judge mismatch on a
 * critical attribute. `needs_review` = a stage that could not decide, a judge
 * `not_visible` on a critical attribute or a mismatch on a non-critical one,
 * or an edit/animate result no judge looked at. The judge can add failures,
 * never remove one; a missing judge never yields `pass` in edit or animate.
 */
import { CRITICAL_ATTRIBUTES, type JudgeAttributeResult } from './judgeSchema.js';
import type { FidelityOutcome } from './types.js';

export function judgeOutcome(results: readonly JudgeAttributeResult[]): { outcome: FidelityOutcome; critical: string[]; review: string[] } {
  const critical = results.filter((r) => r.answer === 'mismatch' && CRITICAL_ATTRIBUTES.includes(r.attribute)).map((r) => r.attribute);
  const review = results.filter((r) => (r.answer === 'not_visible' && CRITICAL_ATTRIBUTES.includes(r.attribute)) || (r.answer === 'mismatch' && !CRITICAL_ATTRIBUTES.includes(r.attribute))).map((r) => r.attribute);
  return { outcome: critical.length ? 'fail' : review.length ? 'needs_review' : 'pass', critical, review };
}

export function combineOutcome(stage: FidelityOutcome, judge: FidelityOutcome | 'absent', mode: 'none' | 'composite' | 'edit' | 'animate'): FidelityOutcome {
  if (stage === 'fail' || judge === 'fail') return 'fail';
  if (stage === 'needs_review' || judge === 'needs_review') return 'needs_review';
  if (judge === 'absent' && (mode === 'edit' || mode === 'animate')) return 'needs_review';
  return 'pass';
}
