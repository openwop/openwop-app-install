/**
 * ADR 0397 Phase 2 — the policy simulator.
 *
 * Pins: (a) a simulated verdict equals the live verdict for the same input (via the
 * shared matcher), (b) tool NAMES resolve through the same classification the loop uses,
 * (c) an unclassified tool participates as risky under `treat-as-risky`, (d) `modeOverride`
 * previews a deny mode, and (e) the simulator writes NOTHING (no decision-log entry).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../../../host/hostExtPersistence.js';
import { openStorage } from '../../../storage/index.js';
import { simulateFirewall } from '../simulator.js';
import { setCapabilityRules, setPlatformRules } from '../ruleStore.js';
import { recommendedExfilRule } from '../firewallHook.js';
import { listGovernanceDecisions } from '../../../host/governanceDecisionLog.js';
import type { CapabilityRule } from '../types.js';

const TENANT = 'tenant-sim';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await setCapabilityRules(TENANT, [recommendedExfilRule()], 'treat-as-risky', 'tester');
});

describe('simulateFirewall (ADR 0397 P2)', () => {
  it('fires the read→egress rule for a class-based seen+next', async () => {
    const r = await simulateFirewall(TENANT, { seen: [{ safetyTier: 'read' }], next: { egress: 'host-mediated' } });
    expect(r.decision).toBe('require-approval');
    expect(r.matchedRuleId).toBe('read-then-egress');
    expect(r.mode).toBe('default-allow');
    expect(r.fellThroughToDefault).toBe(false);
  });

  it('resolves tool NAMES through the same classification (knowledge read → email send)', async () => {
    const r = await simulateFirewall(TENANT, {
      seen: [{ toolName: 'openwop:knowledge.search' }],
      next: { toolName: 'core.openwop.integration.email-send' },
    });
    expect(r.decision).toBe('require-approval'); // read (knowledge) then host-mediated egress (email)
  });

  it('an unclassified tool participates as risky (treat-as-risky) — read+egress in one', async () => {
    // An un-classed next tool becomes write+host-mediated; with a prior read it is still
    // caught by the rule (the seen read + the risky next egress).
    const r = await simulateFirewall(TENANT, { seen: [{ safetyTier: 'read' }], next: { toolName: 'openwop:custom.unknown-tool' } });
    expect(r.decision).toBe('require-approval');
  });

  it('modeOverride enforce previews a fall-through deny for an unmatched safe action', async () => {
    const r = await simulateFirewall(TENANT, { next: { safetyTier: 'pure' }, modeOverride: 'enforce' });
    expect(r.decision).toBe('deny');
    expect(r.mode).toBe('enforce');
    expect(r.fellThroughToDefault).toBe(true);
  });

  it('writes NOTHING — no decision-log entry after simulating', async () => {
    const before = (await listGovernanceDecisions(TENANT, { kind: 'firewall' })).length;
    await simulateFirewall(TENANT, { seen: [{ safetyTier: 'read' }], next: { egress: 'host-mediated' } });
    const after = (await listGovernanceDecisions(TENANT, { kind: 'firewall' })).length;
    expect(after).toBe(before);
  });

  // grade-code #2 — sim MUST match live for an unclassified next under skip: an anyOf-only
  // rule that matches on `seen` must NOT fire (the live loop short-circuits to allow).
  it('unclassified next under skip: an anyOf-only rule does NOT fire (matches live short-circuit)', async () => {
    // A rule that fires whenever a run has READ (wildcard `with`). With a classified read next
    // it would fire; with an UNCLASSIFIED next under skip, the live hook skips rule eval.
    const anyReadRule: CapabilityRule = { id: 'seen-read', description: '', verdict: 'deny', reason: 'x', when: { anyOf: [{ safetyTier: 'read' }] } };
    await setCapabilityRules(TENANT, [anyReadRule], 'skip', 'tester');
    try {
      const r = await simulateFirewall(TENANT, { seen: [{ safetyTier: 'read' }], next: { toolName: 'openwop:custom.unclassified' } });
      expect(r.decision).toBe('allow'); // short-circuit: unclassified-skip next skips rule eval
      expect(r.trace).toHaveLength(0);
    } finally {
      await setCapabilityRules(TENANT, [recommendedExfilRule()], 'treat-as-risky', 'tester'); // restore
    }
  });

  // ADR 0397 P5 — the platform baseline surfaces read-only and applies as a floor.
  it('surfaces the platform baseline trace and the floor wins (deny read)', async () => {
    const platDenyRead: CapabilityRule = { id: 'plat-deny-read', description: '', verdict: 'deny', reason: 'platform floor', when: { with: [{ safetyTier: 'read' }] } };
    await setPlatformRules([platDenyRead], 'root');
    try {
      // A pure read the tenant rules would allow, but the platform floor denies.
      const r = await simulateFirewall(TENANT, { next: { safetyTier: 'read' } });
      expect(r.decision).toBe('deny');
      expect(r.platformBaseline?.some((t) => t.ruleId === 'plat-deny-read' && t.matched)).toBe(true);
    } finally {
      await setPlatformRules([], 'root'); // clear the global floor so other tests aren't affected
    }
  });
});
