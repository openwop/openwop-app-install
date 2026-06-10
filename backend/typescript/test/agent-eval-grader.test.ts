/**
 * A8 — real deterministic eval grader (RFC 0081). Golden / rubric / schema
 * scoring + a content-free EvalSummary aggregate.
 */

import { describe, expect, it } from 'vitest';
import { gradeSuite, scoreCriterion, type EvalTask } from '../src/host/agentEvalGrader.js';

describe('agent eval grader (A8)', () => {
  it('golden: normalized exact match', () => {
    expect(scoreCriterion('  Hello  World ', { kind: 'golden', expected: 'hello world' })).toBe(1);
    expect(scoreCriterion('nope', { kind: 'golden', expected: 'hello world' })).toBe(0);
  });

  it('rubric: fraction of include/exclude checks satisfied', () => {
    const c = { kind: 'rubric' as const, mustInclude: ['workflow', 'engine'], mustExclude: ['error'] };
    expect(scoreCriterion('the workflow engine works', c)).toBe(1); // 3/3
    expect(scoreCriterion('the workflow had an error', c)).toBeCloseTo(1 / 3, 5); // include workflow only
  });

  it('schema: validity 1/0', () => {
    const c = { kind: 'schema' as const, schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } };
    expect(scoreCriterion({ ok: true }, c)).toBe(1);
    expect(scoreCriterion({ nope: 1 }, c)).toBe(0);
  });

  it('gradeSuite aggregates to a content-free EvalSummary', () => {
    const tasks: EvalTask[] = [
      { taskId: 't1', criterion: { kind: 'golden', expected: 'a' } },
      { taskId: 't2', criterion: { kind: 'rubric', mustInclude: ['x'] } },
    ];
    const summary = gradeSuite(tasks, ['a', 'no match']);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.passRate).toBe(0.5);
    expect(summary.tasks.map((t) => t.taskId)).toEqual(['t1', 't2']);
    // content-free: only ids + scalars
    expect(Object.keys(summary.tasks[0]!).sort()).toEqual(['passed', 'score', 'taskId']);
  });
});
