/**
 * ADR 0135 Phase 1 — the pure composition evaluator.
 */
import { describe, it, expect } from 'vitest';
import { evaluateComposition, classesOf, classKey } from '../src/features/capability-firewall/compositionEvaluator.js';
import type { CapabilityRule, ToolCapabilityDescriptor } from '../src/features/capability-firewall/types.js';

// The seed exfil rule: a read happened (across the run OR in this call) AND the tool
// about to run egresses off-host ⇒ require approval.
const EXFIL: CapabilityRule = {
  id: 'read-then-egress', description: 'data left a read context and is about to leave the host',
  when: { anyOf: [{ safetyTier: 'read' }], with: [{ egress: 'host-mediated' }, { egress: 'host-owned' }] },
  verdict: 'require-approval', reason: 'reading external data then sending it off-host',
};
const DENY_EXEC_AFTER_WRITE: CapabilityRule = {
  id: 'no-exec-after-write', description: 'never run code after mutating external state',
  when: { anyOf: [{ safetyTier: 'write' }], with: [{ safetyTier: 'exec' }] },
  verdict: 'deny', reason: 'exec after a write is forbidden',
};

const keys = (d: ToolCapabilityDescriptor): string[] => classesOf(d);
const read: ToolCapabilityDescriptor = { safetyTier: 'read' };
const egress: ToolCapabilityDescriptor = { safetyTier: 'write', egress: 'host-mediated' };
const readEgress: ToolCapabilityDescriptor = { safetyTier: 'read', egress: 'host-owned' };
const safe: ToolCapabilityDescriptor = { safetyTier: 'read', egress: 'safe-fetch' };

describe('classKey / classesOf', () => {
  it('serializes classes + projects a descriptor', () => {
    expect(classKey({ safetyTier: 'read' })).toBe('safetyTier:read');
    expect(classKey({ egress: 'host-owned' })).toBe('egress:host-owned');
    expect(classKey({ scope: 'workspace:write' })).toBe('scope:workspace:write');
    expect(classesOf({ safetyTier: 'write', egress: 'host-mediated', scopes: ['workspace:write'] }))
      .toEqual(['safetyTier:write', 'egress:host-mediated', 'scope:workspace:write']);
  });
});

describe('evaluateComposition (ADR 0135 P1)', () => {
  it('CROSS-CALL: read earlier, egress now ⇒ require-approval', () => {
    const seen = new Set(keys(read));
    expect(evaluateComposition(seen, keys(egress), [EXFIL])).toMatchObject({ decision: 'require-approval', ruleId: 'read-then-egress' });
  });

  it('WITHIN-CALL: a single tool that both reads and egresses ⇒ require-approval (first use)', () => {
    expect(evaluateComposition(new Set(), keys(readEgress), [EXFIL])).toMatchObject({ decision: 'require-approval' });
  });

  it('read alone (no egress) ⇒ allow', () => {
    expect(evaluateComposition(new Set(keys(read)), keys(read), [EXFIL])).toEqual({ decision: 'allow' });
  });

  it('egress alone (no prior/current read) ⇒ allow', () => {
    expect(evaluateComposition(new Set(), keys({ safetyTier: 'write', egress: 'host-mediated' }), [EXFIL])).toEqual({ decision: 'allow' });
  });

  it('safe-fetch egress does not match the host-mediated/host-owned rule', () => {
    expect(evaluateComposition(new Set(keys(read)), keys(safe), [EXFIL])).toEqual({ decision: 'allow' });
  });

  it('deny verdict + first-match-wins', () => {
    const seen = new Set([...keys(read), ...keys({ safetyTier: 'write' })]);
    // write seen + exec now → DENY rule (listed first) wins over anything later
    expect(evaluateComposition(seen, keys({ safetyTier: 'exec' }), [DENY_EXEC_AFTER_WRITE, EXFIL]))
      .toMatchObject({ decision: 'deny', ruleId: 'no-exec-after-write' });
  });

  it('empty rules ⇒ allow', () => {
    expect(evaluateComposition(new Set(keys(readEgress)), keys(egress), [])).toEqual({ decision: 'allow' });
  });

  it('scope-class matching', () => {
    const rule: CapabilityRule = { id: 's', description: '', when: { with: [{ scope: 'workspace:write' }] }, verdict: 'deny', reason: 'r' };
    expect(evaluateComposition(new Set(), keys({ safetyTier: 'write', scopes: ['workspace:write'] }), [rule])).toMatchObject({ decision: 'deny' });
    expect(evaluateComposition(new Set(), keys({ safetyTier: 'read', scopes: ['workspace:read'] }), [rule])).toEqual({ decision: 'allow' });
  });
});

// ADR 0135 Phase 5 — the reserved fan-out class + the countAtLeast (composition-VOLUME) predicate.
describe('fan-out class round-trip (ADR 0135 P5)', () => {
  it('classKey / classesOf handle { kind: fan-out }', () => {
    expect(classKey({ kind: 'fan-out' })).toBe('kind:fan-out');
    expect(classesOf({ safetyTier: 'exec', kind: 'fan-out' })).toEqual(['safetyTier:exec', 'kind:fan-out']);
  });
});

describe('evaluateComposition — countAtLeast (ADR 0135 P5)', () => {
  const egKey = classKey({ egress: 'host-mediated' });
  const VOL: CapabilityRule = {
    id: 'egress-volume', description: '',
    when: { countAtLeast: { class: { egress: 'host-mediated' }, threshold: 3, window: 'turn' } },
    verdict: 'require-approval', reason: 'too many off-host sends this turn',
  };

  it('BELOW threshold (2 prior + this = would-be 3? no — 1 prior + this = 2) ⇒ allow', () => {
    const counts = new Map([[egKey, 1]]);
    expect(evaluateComposition(new Set([egKey]), [egKey], [VOL], counts)).toEqual({ decision: 'allow' });
  });

  it('AT threshold (2 prior + this call = 3) ⇒ require-approval', () => {
    const counts = new Map([[egKey, 2]]);
    expect(evaluateComposition(new Set([egKey]), [egKey], [VOL], counts)).toMatchObject({ decision: 'require-approval', ruleId: 'egress-volume' });
  });

  it('OVER threshold (5 prior + this = 6) ⇒ require-approval', () => {
    const counts = new Map([[egKey, 5]]);
    expect(evaluateComposition(new Set([egKey]), [egKey], [VOL], counts)).toMatchObject({ decision: 'require-approval' });
  });

  it('the about-to-run call itself counts (0 prior + this = 1, threshold 1) ⇒ fires', () => {
    const rule: CapabilityRule = { id: 'one', description: '', when: { countAtLeast: { class: { egress: 'host-mediated' }, threshold: 1, window: 'turn' } }, verdict: 'deny', reason: 'r' };
    expect(evaluateComposition(new Set(), [egKey], [rule])).toMatchObject({ decision: 'deny' });
  });

  it('a different class does not accrue toward the count', () => {
    const counts = new Map([[classKey({ safetyTier: 'read' }), 9]]);
    expect(evaluateComposition(new Set(), [egKey], [VOL], counts)).toEqual({ decision: 'allow' });
  });
});

describe('evaluateComposition — expression predicate (ADR 0135 P6)', () => {
  it('seed rule as an expression: seen.read && next.egress:host-mediated', () => {
    const rule: CapabilityRule = { id: 'e', description: '', when: { expression: 'seen.read && next.egress:host-mediated' }, verdict: 'require-approval', reason: 'r' };
    const seen = new Set(keys(read));
    expect(evaluateComposition(seen, keys(egress), [rule])).toMatchObject({ decision: 'require-approval', ruleId: 'e' });
    // no prior read ⇒ no match
    expect(evaluateComposition(new Set(), keys(egress), [rule])).toEqual({ decision: 'allow' });
  });

  it('count comparison as an expression: count.egress:host-mediated >= 3', () => {
    const rule: CapabilityRule = { id: 'c', description: '', when: { expression: 'count.egress:host-mediated >= 3' }, verdict: 'deny', reason: 'r' };
    const egKey = classKey({ egress: 'host-mediated' });
    // 2 prior + this call = 3 ⇒ fires
    expect(evaluateComposition(new Set([egKey]), [egKey], [rule], new Map([[egKey, 2]]))).toMatchObject({ decision: 'deny' });
    // 1 prior + this call = 2 ⇒ allow
    expect(evaluateComposition(new Set([egKey]), [egKey], [rule], new Map([[egKey, 1]]))).toEqual({ decision: 'allow' });
  });
});
