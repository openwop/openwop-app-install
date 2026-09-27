/**
 * ADR 0135 Phase 6 — the bounded expression parser/evaluator + Phase 5/6 rule-store
 * validation (exactly-one-predicate + fail-closed on a bad expression / fan-out class).
 */
import { describe, it, expect } from 'vitest';
import { parseExpression, evalExpression } from '../src/features/capability-firewall/expressionEvaluator.js';
import { validateRules } from '../src/features/capability-firewall/ruleStore.js';
import { OpenwopError } from '../src/types.js';

const ctx = (opts: { seen?: string[]; next?: string[]; counts?: [string, number][] } = {}) => ({
  seen: new Set(opts.seen ?? []),
  next: new Set(opts.next ?? []),
  counts: new Map(opts.counts ?? []),
});

function evalOk(src: string, c: ReturnType<typeof ctx>): boolean {
  const p = parseExpression(src);
  if (!p.ok) throw new Error(`parse failed: ${p.error}`);
  return evalExpression(p.ast, c);
}

describe('parseExpression — valid grammar', () => {
  it('accepts the two documented example expressions', () => {
    expect(parseExpression('seen.read && next.egress:host-mediated').ok).toBe(true);
    expect(parseExpression('count.egress:host-mediated >= 3').ok).toBe(true);
  });
  it('accepts all fact namespaces + class-key bodies', () => {
    for (const s of ['seen.write', 'next.exec', 'count.kind:fan-out', 'seen.scope:workspace:write', '!seen.read', 'next.egress:host-owned']) {
      expect(parseExpression(s).ok).toBe(true);
    }
  });
  it('accepts every comparison operator', () => {
    for (const op of ['>=', '<=', '>', '<', '==', '!=']) {
      expect(parseExpression(`count.egress:host-mediated ${op} 2`).ok).toBe(true);
    }
  });
});

describe('parseExpression — invalid grammar (fail-closed)', () => {
  const bad = [
    '',                                   // empty
    'seen.read &&',                       // dangling operator
    '&& seen.read',                       // leading operator
    'seen.read next.exec',                // missing operator between terms
    'count.egress:host-mediated >=',      // comparison without a number
    'seen.bogus',                         // unknown fact namespace class body
    'seen.egress:not-a-thing',            // unknown egress value
    'unknown.read',                       // unknown fact prefix
    'seen.read >= foo',                   // non-numeric comparison operand
    'seen.kind:whatever',                 // unknown kind
  ];
  for (const src of bad) {
    it(`rejects ${JSON.stringify(src)}`, () => {
      expect(parseExpression(src).ok).toBe(false);
    });
  }
});

describe('evalExpression — semantics', () => {
  it('membership (seen/next) bare truthiness', () => {
    expect(evalOk('seen.read', ctx({ seen: ['safetyTier:read'] }))).toBe(true);
    expect(evalOk('seen.read', ctx({}))).toBe(false);
    expect(evalOk('next.egress:host-mediated', ctx({ next: ['egress:host-mediated'] }))).toBe(true);
  });
  it('count bare is truthy when > 0; comparisons work', () => {
    expect(evalOk('count.kind:fan-out', ctx({ counts: [['kind:fan-out', 0]] }))).toBe(false);
    expect(evalOk('count.kind:fan-out', ctx({ counts: [['kind:fan-out', 2]] }))).toBe(true);
    expect(evalOk('count.egress:host-mediated >= 3', ctx({ counts: [['egress:host-mediated', 3]] }))).toBe(true);
    expect(evalOk('count.egress:host-mediated >= 3', ctx({ counts: [['egress:host-mediated', 2]] }))).toBe(false);
    expect(evalOk('count.egress:host-mediated < 3', ctx({ counts: [['egress:host-mediated', 2]] }))).toBe(true);
    expect(evalOk('count.egress:host-mediated == 0', ctx({}))).toBe(true);
    expect(evalOk('count.egress:host-mediated != 0', ctx({ counts: [['egress:host-mediated', 1]] }))).toBe(true);
  });
  it('NOT negates a term', () => {
    expect(evalOk('!seen.read', ctx({}))).toBe(true);
    expect(evalOk('!seen.read', ctx({ seen: ['safetyTier:read'] }))).toBe(false);
  });
  it('the seed rule expression matches read-then-egress', () => {
    const src = 'seen.read && next.egress:host-mediated';
    expect(evalOk(src, ctx({ seen: ['safetyTier:read'], next: ['egress:host-mediated'] }))).toBe(true);
    expect(evalOk(src, ctx({ next: ['egress:host-mediated'] }))).toBe(false);
    expect(evalOk(src, ctx({ seen: ['safetyTier:read'] }))).toBe(false);
  });
  it('&& and || fold left-to-right over the flat term sequence', () => {
    // false || true && false  ==  ((false || true) && false)  ==  false
    expect(evalOk('seen.read || next.exec && seen.write', ctx({ next: ['safetyTier:exec'] }))).toBe(false);
    // true || anything (first two) then && true
    expect(evalOk('seen.read || next.exec && seen.write', ctx({ seen: ['safetyTier:read', 'safetyTier:write'] }))).toBe(true);
  });
});

describe('validateRules — Phase 5/6', () => {
  const base = { id: 'r', verdict: 'deny', reason: '' };

  it('accepts a countAtLeast rule with a fan-out class', () => {
    const [rule] = validateRules([{ ...base, when: { countAtLeast: { class: { kind: 'fan-out' }, threshold: 5, window: 'turn' } } }]);
    expect(rule.when.countAtLeast).toEqual({ class: { kind: 'fan-out' }, threshold: 5, window: 'turn' });
  });

  it('the fan-out class round-trips through validateClass inside anyOf/with', () => {
    const [rule] = validateRules([{ ...base, when: { with: [{ kind: 'fan-out' }] } }]);
    expect(rule.when.with).toEqual([{ kind: 'fan-out' }]);
  });

  it('rejects a non-positive / non-integer threshold', () => {
    expect(() => validateRules([{ ...base, when: { countAtLeast: { class: { kind: 'fan-out' }, threshold: 0, window: 'turn' } } }])).toThrow(OpenwopError);
    expect(() => validateRules([{ ...base, when: { countAtLeast: { class: { kind: 'fan-out' }, threshold: 1.5, window: 'turn' } } }])).toThrow(OpenwopError);
  });

  it('rejects a window other than turn', () => {
    expect(() => validateRules([{ ...base, when: { countAtLeast: { class: { kind: 'fan-out' }, threshold: 2, window: 'run' } } }])).toThrow(OpenwopError);
  });

  it('accepts a valid expression rule', () => {
    const [rule] = validateRules([{ ...base, when: { expression: 'count.egress:host-mediated >= 3' } }]);
    expect(rule.when.expression).toBe('count.egress:host-mediated >= 3');
  });

  it('fails CLOSED on an unparseable expression', () => {
    expect(() => validateRules([{ ...base, when: { expression: 'seen.bogus &&' } }])).toThrow(OpenwopError);
  });

  it('enforces exactly-one-predicate-kind (rejects presence + countAtLeast)', () => {
    expect(() => validateRules([{ ...base, when: { with: [{ egress: 'host-mediated' }], countAtLeast: { class: { kind: 'fan-out' }, threshold: 2, window: 'turn' } } }])).toThrow(/exactly one predicate/i);
  });

  it('enforces exactly-one-predicate-kind (rejects countAtLeast + expression)', () => {
    expect(() => validateRules([{ ...base, when: { expression: 'seen.read', countAtLeast: { class: { kind: 'fan-out' }, threshold: 2, window: 'turn' } } }])).toThrow(/exactly one predicate/i);
  });

  it('still accepts a plain presence rule (backward compatible)', () => {
    const [rule] = validateRules([{ ...base, verdict: 'require-approval', when: { anyOf: [{ safetyTier: 'read' }], with: [{ egress: 'host-mediated' }] } }]);
    expect(rule.when.anyOf).toEqual([{ safetyTier: 'read' }]);
  });
});
