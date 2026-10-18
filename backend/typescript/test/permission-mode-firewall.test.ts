/**
 * ADR 0150 — permission mode (safe / bypass) over the capability-firewall hook.
 * safe gates the SENSITIVE tools (require-approval card); bypass downgrades require-approval to
 * allow; a hard `deny` rule still wins in BOTH modes; an already-approved tool short-circuits.
 */
import { describe, it, expect } from 'vitest';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../src/features/capability-firewall/firewallHook.js';
import type { CapabilityRule } from '../src/features/capability-firewall/types.js';

const CODE_EXEC = 'openwop:feature.code-exec.nodes.run';

describe('ADR 0150 — permission mode firewall gating', () => {
  // ADR 0834 D4 — `openwop:core.files.write` is gone: no agent tool ever registered it.
  // New asks are declared on the tool (`safeModeApproval`); the census pins the live set.
  it('SENSITIVE_APPROVAL_TOOLS includes code-exec and egress, and no dead file-write id', () => {
    expect(SENSITIVE_APPROVAL_TOOLS.has(CODE_EXEC)).toBe(true);
    expect(SENSITIVE_APPROVAL_TOOLS.has('openwop:core.openwop.http.fetch')).toBe(true);
    expect(SENSITIVE_APPROVAL_TOOLS.has('openwop:core.files.write')).toBe(false);
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

  it('a hard deny rule wins in BOTH modes — bypass only ever downgrades require-approval', () => {
    // The header claim: the bypass / already-approved downgrade fires ONLY on
    // `require-approval` (firewallHook.ts), so a tenant `deny` survives safe, bypass AND an
    // approval. (Before grade-tests w28 this case asserted only "not require-approval", which a
    // deny→allow downgrade also satisfied.)
    const deny: CapabilityRule = { id: 'deny-writes', description: '', when: { with: [{ safetyTier: 'write' }] }, verdict: 'deny', reason: 'no writes' };
    for (const extra of [{ bypassApproval: false }, { bypassApproval: true }, { approvedTools: new Set([CODE_EXEC]) }, { bypassApproval: true, approvedTools: new Set([CODE_EXEC]) }]) {
      const hook = buildFirewallHook({ rules: [deny], unknownToolPolicy: 'treat-as-risky', requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, ...extra });
      expect(hook.evaluate([], CODE_EXEC).decision, JSON.stringify(Object.keys(extra))).toBe('deny');
    }
    // …and on the rule-less hook, bypass never introduces a require-approval.
    const open = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, bypassApproval: true });
    for (const t of [CODE_EXEC, 'openwop:knowledge.search']) {
      expect(open.evaluate([], t).decision).not.toBe('require-approval');
    }
  });

  // ADR 0610 D5 / PMC-1 — safe mode gates the host-mediated egress CLASS, not just the
  // hard-coded name set. `core.openwop.integration.email-send` is a classified
  // `egress:'host-mediated'` tool that is NOT in SENSITIVE_APPROVAL_TOOLS — before this it
  // proceeded UNASKED in safe mode (email/slack/sms/a2a/mcp sends did too).
  // ADR 0834 D7 — this witness used `core.openwop.integration.email-send`, a NODE id no
  // agent tool can carry, so it proved the gate on a population the agent lanes never
  // present (a gate that could not fail). It now uses a REAL agent tool the classifier
  // keys on; deleting that classifier row turns the safe-mode case red (sabotage-witnessed).
  const EMAIL_SEND = 'openwop:destination-sync.run'; // a registered agent tool, classified write+host-mediated egress
  describe('PMC-1 — the egress CLASS is gated, not a name set', () => {
    it('control: the egress tool is NOT in the hard-coded name set', () => {
      expect(SENSITIVE_APPROVAL_TOOLS.has(EMAIL_SEND)).toBe(false);
    });
    it('SAFE mode: a host-mediated egress tool needs approval even absent from the name set', () => {
      const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, gateHostMediatedEgress: true, bypassApproval: false });
      expect(hook.evaluate([], EMAIL_SEND).decision).toBe('require-approval');
    });
    it('BYPASS mode: the same egress tool is allowed (the downgrade still applies)', () => {
      const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, gateHostMediatedEgress: true, bypassApproval: true });
      expect(hook.evaluate([], EMAIL_SEND).decision).toBe('allow');
    });
    it('SAFE + already-approved: the egress tool is allowed (no re-defer)', () => {
      const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, gateHostMediatedEgress: true, approvedTools: new Set([EMAIL_SEND]) });
      expect(hook.evaluate([], EMAIL_SEND).decision).toBe('allow');
    });
    it('a NON-egress read tool is NOT class-gated in safe mode (non-vacuous)', () => {
      const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, gateHostMediatedEgress: true });
      expect(hook.evaluate([], 'openwop:knowledge.search').decision).toBe('allow');
    });
    // Adversarial-review catch: the gate MUST read the REAL classification, not the
    // `treat-as-risky` fallback (RISKY_FALLBACK is egress:'host-mediated'). Under the
    // PRODUCTION default `unknownToolPolicy:'treat-as-risky'`, an UNCLASSIFIED read
    // (documents.get / get-design / get-brief — "agents read before they write") must
    // stay `allow`, NOT be mass-deferred for approval.
    it('an UNCLASSIFIED read is NOT class-gated even under treat-as-risky (no mass over-block)', () => {
      const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, gateHostMediatedEgress: true, unknownToolPolicy: 'treat-as-risky' });
      expect(hook.evaluate([], 'openwop:documents.get').decision).toBe('allow');
      expect(hook.evaluate([], 'openwop:app-builder.get-design').decision).toBe('allow');
    });
    it('a classified host-mediated egress tool IS still gated under treat-as-risky', () => {
      const hook = buildFirewallHook({ rules: [], requireApprovalTools: SENSITIVE_APPROVAL_TOOLS, gateHostMediatedEgress: true, unknownToolPolicy: 'treat-as-risky' });
      expect(hook.evaluate([], EMAIL_SEND).decision).toBe('require-approval');
    });
  });
});
