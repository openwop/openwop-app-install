/**
 * ADR 0397 Phase 2 — explainComposition parity + trace.
 *
 * The load-bearing invariant: `explainComposition` shares `matchRule` with the live
 * `evaluateComposition`, so for the SAME input under `default-allow` it MUST return the
 * identical decision + matched rule. We fuzz across every predicate kind (presence,
 * countAtLeast, expression) and pin the mode-aware fall-through + trace attribution.
 */
import { describe, it, expect } from 'vitest';
import { evaluateComposition, explainComposition } from '../compositionEvaluator.js';
import type { CapabilityRule } from '../types.js';

const presence: CapabilityRule = {
  id: 'read-then-egress', description: '', verdict: 'require-approval', reason: 'exfil',
  when: { anyOf: [{ safetyTier: 'read' }], with: [{ egress: 'host-mediated' }] },
};
const volume: CapabilityRule = {
  id: 'egress-volume', description: '', verdict: 'deny', reason: 'burst',
  when: { countAtLeast: { class: { egress: 'host-mediated' }, threshold: 2, window: 'turn' } },
};
const expr: CapabilityRule = {
  id: 'expr', description: '', verdict: 'deny', reason: 'e',
  when: { expression: 'seen.read && next.egress:host-mediated' },
};

const RULE_SETS: CapabilityRule[][] = [[presence], [volume], [expr], [presence, volume], [volume, presence, expr]];
const SEEN_KEYS = [new Set<string>(), new Set(['safetyTier:read']), new Set(['egress:host-mediated'])];
const NEXT_KEYS = [['egress:host-mediated'], ['safetyTier:read'], ['safetyTier:pure']];

describe('explainComposition — parity with evaluateComposition (default-allow)', () => {
  it('returns the identical decision + matched rule for every input', () => {
    for (const rules of RULE_SETS) {
      for (const seen of SEEN_KEYS) {
        for (const next of NEXT_KEYS) {
          const counts = new Map([...seen].map((k) => [k, 1] as const));
          const live = evaluateComposition(seen, next, rules, counts);
          const explained = explainComposition(seen, next, rules, { seenCounts: counts, mode: 'default-allow' });
          expect(explained.decision).toBe(live.decision);
          expect(explained.matchedRuleId).toBe(live.ruleId); // both undefined on fall-through
        }
      }
    }
  });
});

describe('explainComposition — trace + mode-aware default', () => {
  it('a matched rule attributes the ruleId, clause, and is NOT a fall-through', () => {
    const r = explainComposition(new Set(['safetyTier:read']), ['egress:host-mediated'], [presence], { mode: 'default-allow' });
    expect(r.decision).toBe('require-approval');
    expect(r.matchedRuleId).toBe('read-then-egress');
    expect(r.fellThroughToDefault).toBe(false);
    expect(r.trace).toHaveLength(1);
    expect(r.trace[0]?.matched).toBe(true);
    expect(r.trace[0]?.why).toContain('matched');
  });

  it('an unmatched action under default-allow falls through to allow', () => {
    const r = explainComposition(new Set(), ['safetyTier:pure'], [presence], { mode: 'default-allow' });
    expect(r.decision).toBe('allow');
    expect(r.fellThroughToDefault).toBe(true);
  });

  it('modeOverride enforce reports fall-through → deny (default) when no rule matches', () => {
    const r = explainComposition(new Set(), ['safetyTier:pure'], [presence], { mode: 'enforce' });
    expect(r.decision).toBe('deny');
    expect(r.fellThroughToDefault).toBe(true);
    expect(r.reason).toContain('default-deny');
  });

  it('enforce + defaultDenyVerdict require-approval holds an unmatched action', () => {
    const r = explainComposition(new Set(), ['safetyTier:pure'], [presence], { mode: 'enforce', defaultDenyVerdict: 'require-approval' });
    expect(r.decision).toBe('require-approval');
    expect(r.fellThroughToDefault).toBe(true);
  });

  it('first-match-wins: a later matching rule is marked superseded in the trace', () => {
    // Both `presence` and `expr` match seen.read + next.egress:host-mediated; presence is first.
    const seen = new Set(['safetyTier:read']);
    const r = explainComposition(seen, ['egress:host-mediated'], [presence, expr], { seenCounts: new Map([['safetyTier:read', 1]]), mode: 'default-allow' });
    expect(r.matchedRuleId).toBe('read-then-egress');
    const exprRow = r.trace.find((t) => t.ruleId === 'expr');
    expect(exprRow?.matched).toBe(false);
    expect(exprRow?.why).toContain('earlier rule already decided');
  });
});
