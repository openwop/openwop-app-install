/**
 * ADR 0889 P1 — the pure eval graders (RFC 0244 §A/§B/§C/§E/§F).
 *
 * The §B formulas are normative on the wire, so they are pinned against a hand-
 * computed table rather than against themselves. The match-mode cases are the
 * RFC's own table, one row per mode, each with a control that flips it.
 */
import { describe, expect, it } from 'vitest';
import { binomial, passAtK, passHatK, summarizeTrials, suiteTrialStats, taskPassed } from '../src/host/evals/trialStats.js';
import { gradeTrajectory, observedFor, jsonSubset, type ObservedCall } from '../src/host/evals/trajectory.js';
import { pairedRegressionVerdict, signTestPValue } from '../src/host/evals/regressionVerdict.js';
import { countTrialEfficiency, meanEfficiency } from '../src/host/evals/efficiency.js';
import { gradeGolden, gradeOutput, gradeRubric } from '../src/host/evals/outputGrade.js';

describe('RFC 0244 §B — pass@k / pass^k / stderr', () => {
  it('binomial is exact, including past 2^53', () => {
    expect(binomial(5, 3)).toBe(10n);
    expect(binomial(10, 0)).toBe(1n);
    expect(binomial(3, 5)).toBe(0n);
    expect(binomial(100, 50)).toBe(100891344545564193334812497256n);
  });

  // (n, c, k) → [passAtK, passHatK], computed by hand from the RFC formulas.
  const table: Array<[number, number, number, number, number]> = [
    [5, 4, 3, 1, 0.4], // the RFC's own worked example
    [5, 0, 1, 0, 0],
    [5, 5, 5, 1, 1],
    [10, 5, 1, 0.5, 0.5],
    [10, 5, 3, 1 - 10 / 120, 10 / 120],
    [3, 1, 2, 1 - 1 / 3, 0],
  ];
  it.each(table)('n=%i c=%i k=%i', (n, c, k, at, hat) => {
    expect(passAtK(n, c, k)).toBeCloseTo(at, 12);
    expect(passHatK(n, c, k)).toBeCloseTo(hat, 12);
  });

  it('stays in [0,1] for large n (no overflow, no NaN)', () => {
    const at = passAtK(200, 100, 50);
    const hat = passHatK(200, 100, 50);
    expect(at).toBeGreaterThan(0.999999);
    expect(at).toBeLessThanOrEqual(1);
    expect(hat).toBeGreaterThan(0);
    expect(hat).toBeLessThan(1e-15);
    // C(100,50)/C(200,50), checked to 12 significant digits against exact rationals.
    expect(hat / Number(binomial(100, 50)) * Number(binomial(200, 50))).toBeCloseTo(1, 12);
  });

  it('refuses k outside [1, n]', () => {
    expect(() => passAtK(5, 4, 6)).toThrow(RangeError);
    expect(() => passHatK(5, 4, 0)).toThrow(RangeError);
  });

  it('summarizes trials and applies passRule', () => {
    const t = summarizeTrials([1, 1, 1, 1, 0].map((s) => ({ score: s, passed: s === 1 })), 3);
    expect(t).toMatchObject({ n: 5, passedCount: 4, meanScore: 0.8 });
    expect(taskPassed(t, 'all', undefined)).toBe(false);
    expect(taskPassed(t, 'any', undefined)).toBe(true);
    expect(taskPassed(t, 'mean', 0.8)).toBe(true);
    expect(taskPassed(t, 'mean', 0.9)).toBe(false);
  });

  it('scoreStderr is sd(per-task means)/√T, omitted for one task', () => {
    const mk = (m: number) => ({ n: 1, passedCount: 0, meanScore: m, passAtK: 0, passHatK: 0 });
    const s = suiteTrialStats([mk(0), mk(1)], 1);
    // sample sd of {0,1} = √0.5; / √2 = 0.5
    expect(s.scoreStderr).toBeCloseTo(0.5, 12);
    expect(suiteTrialStats([mk(1)], 1).scoreStderr).toBeUndefined();
  });
});

describe('RFC 0244 §A — trajectory match modes', () => {
  const call = (tool: string, input: unknown = {}, agentId?: string): ObservedCall => ({ tool, input, ...(agentId ? { agentId } : {}) });
  const A = call('crm:lookup', { id: 1 });
  const B = call('billing:refund', { amountMinor: 4200, reason: 'late' });
  const C = call('mail:send');

  it('exact: same length, position by position', () => {
    const exp = { match: 'exact' as const, calls: [{ tool: 'crm:lookup' }, { tool: 'billing:refund' }] };
    expect(gradeTrajectory(exp, [A, B]).matched).toBe(true);
    expect(gradeTrajectory(exp, [A, B, C]).matched).toBe(false); // control: an extra call
    expect(gradeTrajectory(exp, [B, A]).matched).toBe(false); // control: order
  });

  it('in-order: a subsequence, extras allowed', () => {
    const exp = { match: 'in-order' as const, calls: [{ tool: 'crm:lookup' }, { tool: 'billing:refund' }] };
    expect(gradeTrajectory(exp, [A, C, B]).matched).toBe(true);
    const wrong = gradeTrajectory(exp, [B, A]);
    expect(wrong.matched).toBe(false);
    // matchedCount ignores order in every mode (RFC 0244 §A): both calls are present.
    expect(wrong.matchedCount).toBe(2);
  });

  it('any-order: distinct observed call per expected call', () => {
    const exp = { match: 'any-order' as const, calls: [{ tool: 'crm:lookup' }, { tool: 'crm:lookup' }] };
    expect(gradeTrajectory(exp, [A, C]).matched).toBe(false); // one lookup cannot satisfy two
    expect(gradeTrajectory(exp, [A, C, A]).matched).toBe(true);
  });

  it('subset: no tool outside the expected set', () => {
    const exp = { match: 'subset' as const, calls: [{ tool: 'crm:lookup' }, { tool: 'billing:refund' }] };
    expect(gradeTrajectory(exp, [A, A]).matched).toBe(true); // repeats allowed
    expect(gradeTrajectory(exp, []).matched).toBe(true);
    expect(gradeTrajectory(exp, [A, C]).matched).toBe(false); // control: mail:send is outside
  });

  it('forbidden fails the trajectory in every mode', () => {
    for (const match of ['exact', 'in-order', 'any-order', 'subset'] as const) {
      const r = gradeTrajectory({ match, calls: [{ tool: 'crm:lookup' }], forbidden: ['crm:lookup'] }, [A]);
      expect(r.matched).toBe(false);
      expect(r.forbiddenCount).toBe(1);
    }
  });

  it('argsMatch exact / subset / ignore', () => {
    const mk = (argsMatch: 'exact' | 'subset' | 'ignore', args: unknown) =>
      gradeTrajectory({ match: 'in-order', calls: [{ tool: 'billing:refund', args, argsMatch }] }, [B]).matched;
    expect(mk('subset', { amountMinor: 4200 })).toBe(true);
    expect(mk('subset', { amountMinor: 999 })).toBe(false);
    expect(mk('exact', { amountMinor: 4200 })).toBe(false); // missing `reason`
    expect(mk('exact', { reason: 'late', amountMinor: 4200 })).toBe(true); // key order insensitive
    expect(mk('ignore', { anything: true })).toBe(true);
    expect(jsonSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 })).toBe(true);
  });

  it('the counts block carries no tool names or arguments', () => {
    const r = gradeTrajectory({ match: 'in-order', calls: [{ tool: 'crm:lookup' }] }, [A, B]);
    expect(Object.keys(r).sort()).toEqual(['expectedCount', 'forbiddenCount', 'matched', 'matchedCount', 'mode', 'observedCount']);
    expect(JSON.stringify(r)).not.toMatch(/crm|billing|4200/);
  });

  it('own calls by default, delegates on request', () => {
    const calls = [call('crm:lookup', {}, 'target'), call('mail:send', {}, 'delegate'), call('x:y')];
    expect(observedFor(calls, 'target', false).map((c) => c.tool)).toEqual(['crm:lookup', 'x:y']);
    expect(observedFor(calls, 'target', true)).toHaveLength(3);
  });
});

describe('RFC 0244 §F — paired regression verdict (sign test)', () => {
  const tasks = (scores: number[]) => scores.map((s, i) => ({ taskId: `t${i}`, meanScore: s }));

  it('identical runs are unchanged, never improved/regressed', () => {
    const r = pairedRegressionVerdict(tasks([1, 0, 0.5]), tasks([1, 0, 0.5]));
    expect(r).toMatchObject({ verdict: 'unchanged', pairedTaskCount: 3, method: 'sign-test', scoreDelta: 0 });
  });

  it('ten of ten improved is significant (p = 2/1024)', () => {
    expect(signTestPValue(10, 10)).toBeCloseTo(2 / 1024, 12);
    expect(pairedRegressionVerdict(tasks(Array(10).fill(0)), tasks(Array(10).fill(1))).verdict).toBe('improved');
    expect(pairedRegressionVerdict(tasks(Array(10).fill(1)), tasks(Array(10).fill(0))).verdict).toBe('regressed');
  });

  it('three of three is inconclusive at alpha 0.05 (p = 0.25)', () => {
    expect(pairedRegressionVerdict(tasks([0, 0, 0]), tasks([1, 1, 1])).verdict).toBe('inconclusive');
  });

  it('pairs only tasks present in both runs', () => {
    const base = [{ taskId: 'a', meanScore: 1 }, { taskId: 'gone', meanScore: 0 }];
    const cand = [{ taskId: 'a', meanScore: 1 }, { taskId: 'new', meanScore: 0 }];
    expect(pairedRegressionVerdict(base, cand).pairedTaskCount).toBe(1);
  });
});

describe('RFC 0244 §C — efficiency', () => {
  it('counts tool calls, model calls and tokens; ignores everything else', () => {
    const e = countTrialEfficiency([
      { type: 'agent.toolCalled' },
      { type: 'agent.tool-called' },
      { type: 'provider.usage', payload: { inputTokens: 100, outputTokens: 20 } },
      { type: 'provider.usage', payload: { inputTokens: 'bad' } },
      { type: 'agent.decided' },
    ]);
    expect(e).toEqual({ toolCallCount: 2, modelCallCount: 2, inputTokens: 100, outputTokens: 20 });
    expect(meanEfficiency([e, { toolCallCount: 0, modelCallCount: 0, inputTokens: 0, outputTokens: 0 }]).toolCallCount).toBe(1);
  });
});

describe('RFC 0081 output grading + RFC 0244 §E labels', () => {
  it('golden strategies', () => {
    expect(gradeGolden('  refund   approved ', { strategy: 'exact', value: 'refund approved' }).passed).toBe(true);
    expect(gradeGolden({ content: 'the refund was approved' }, { strategy: 'contains', value: 'approved' }).passed).toBe(true);
    expect(gradeGolden('{"b":2,"a":1}', { strategy: 'json-match', value: { a: 1, b: 2 } }).passed).toBe(true);
    expect(gradeGolden({ a: 1 }, { strategy: 'json-match', value: { a: 2 } })).toMatchObject({ passed: false, scoreLabel: 'fail', evaluatorType: 'deterministic' });
  });

  it('rubric scores weighted criteria, one judge call each', async () => {
    const judged: string[] = [];
    const judge = async ({ criteria }: { criteria: string }) => {
      judged.push(criteria);
      return { pass: criteria === 'cites the window', detail: 'judge: ok' };
    };
    const g = await gradeRubric('x', [{ criterion: 'cites the window', weight: 0.75 }, { criterion: 'is polite', weight: 0.25 }], judge, 0.7);
    expect(judged).toEqual(['cites the window', 'is polite']);
    expect(g).toMatchObject({ score: 0.75, passed: true, scoreLabel: 'partial', evaluatorType: 'llm_judge' });
  });

  it('a judge failure is a typed failed trial, never a pass', async () => {
    const down = async () => ({ pass: false, failure: 'unavailable' as const, detail: 'no provider' });
    const g = await gradeRubric('x', [{ criterion: 'c', weight: 1 }], down, 0.5);
    expect(g).toMatchObject({ passed: false, scoreLabel: 'judge_unavailable' });
    const none = await gradeRubric('x', [{ criterion: 'c', weight: 1 }], undefined, 0.5);
    expect(none.passed).toBe(false);
  });

  it('every label matches the RFC 0244 §E pattern', async () => {
    const labels = [
      gradeGolden('a', { strategy: 'exact', value: 'a' }).scoreLabel,
      gradeGolden('a', { strategy: 'exact', value: 'b' }).scoreLabel,
      (await gradeRubric('x', [{ criterion: 'c', weight: 0 }], async () => ({ pass: true, detail: '' }), 0.5)).scoreLabel,
      (await gradeOutput('x', { kind: 'golden' }, { passScore: 1 }))!.scoreLabel,
    ];
    for (const l of labels) expect(l).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
    expect(await gradeOutput('x', { kind: 'trajectory' }, { passScore: 1 })).toBeNull();
  });
});

describe('ADR 0889 D7 — the RFC 0244 wire switch reads the vendored schemas', () => {
  it('is ON with the vendored v2 schemas (suite >= 2.46.8), and the advert carries the facets', async () => {
    const { rfc0244WireAvailable, resetRfc0244WireCache, evalSuiteCapability } = await import('../src/host/evals/evalCapability.js');
    resetRfc0244WireCache();
    // A swallowed error here once read as "no wire" and silently withheld every facet.
    expect(rfc0244WireAvailable()).toBe(true);
    expect(evalSuiteCapability()).toMatchObject({ trajectory: true, trials: { maxTrials: 10 }, fixtureMatching: true, regressionVerdict: true });
  });
});

describe('ADR 0889 D1 — the eval run workflowId obeys the v2 grammar', () => {
  it('maps suite refs and fixture URIs onto ^[A-Za-z0-9._~:-]{1,128}$, deterministically', async () => {
    const { evalWorkflowId } = await import('../src/host/evals/suiteStore.js');
    const RE = /^[A-Za-z0-9._~:-]{1,128}$/;
    const refs = ['core.acme.evals.support@1.2.0', 'https://conformance.openwop.dev/eval-suites/conformance-eval-trials', `x.evals.${'a'.repeat(200)}@1.0.0`];
    for (const r of refs) {
      expect(evalWorkflowId(r)).toMatch(RE);
      expect(evalWorkflowId(r)).toBe(evalWorkflowId(r));
    }
    expect(evalWorkflowId(refs[0]!)).toBe('eval:core.acme.evals.support~1.2.0');
  });
});
