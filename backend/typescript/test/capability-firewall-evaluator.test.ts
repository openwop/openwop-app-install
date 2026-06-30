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
