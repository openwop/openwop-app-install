/**
 * ADR 0150 — permission mode (safe / bypass) over the capability-firewall hook.
 * safe gates the SENSITIVE tools (require-approval card); bypass downgrades require-approval to
 * allow; a hard `deny` rule still wins in BOTH modes; an already-approved tool short-circuits.
 */
import { describe, it, expect } from 'vitest';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';

const CODE_EXEC = 'openwop:feature.code-exec.nodes.run';

describe('ADR 0150 — permission mode firewall gating', () => {
  it('SENSITIVE_APPROVAL_TOOLS includes code-exec, file-write, egress', () => {
    expect(SENSITIVE_APPROVAL_TOOLS.has(CODE_EXEC)).toBe(true);
    expect(SENSITIVE_APPROVAL_TOOLS.has('openwop:core.files.write')).toBe(true);
    expect(SENSITIVE_APPROVAL_TOOLS.has('openwop:core.openwop.http.fetch')).toBe(true);
  });

  it('SAFE mode: a sensitive tool needs approval (even rule-less)', () => {
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: false });
    expect(hook.evaluate([], CODE_EXEC).decision).toBe('require-approval');
  });

  it('BYPASS mode: the same sensitive tool is allowed (no card)', () => {
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    expect(hook.evaluate([], CODE_EXEC).decision).toBe('allow');
  });

  it('SAFE + already-approved this conversation: allowed (short-circuit, no re-defer)', () => {
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, approvedTools: new Set([CODE_EXEC]) });
    expect(hook.evaluate([], CODE_EXEC).decision).toBe('allow');
  });

  it('a non-sensitive, unclassified tool stays allowed in safe mode', () => {
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS });
    expect(hook.evaluate([], 'openwop:knowledge.search').decision).toBe('allow');
  });

  it('bypass only ever downgrades require-approval — never produces a leaked `require-approval`', () => {
    // Structural invariant: the bypass/approved downgrade fires ONLY on `require-approval`
    // (firewallHook.ts), so a `deny` is never touched (deny-precedence is unit-tested in the
    // evaluator suite). Here we confirm bypass never *introduces* a require-approval.
    const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    for (const t of [CODE_EXEC, 'openwop:core.files.write', 'openwop:knowledge.search']) {
      expect(hook.evaluate([], t).decision).not.toBe('require-approval');
    }
  });
});
