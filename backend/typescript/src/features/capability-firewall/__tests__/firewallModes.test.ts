/**
 * ADR 0397 Phase 3 — mode flag + shadow, and the replay-provenance stamp fix.
 *
 * Pins the deny-mode semantics on the pure hook: default-allow is unchanged; shadow logs a
 * would-block but APPLIES allow (deduped per turn); enforce denies/holds an unmatched
 * action; an explicit `allow` rule carves an exception; bypass downgrades a fall-through
 * require-approval but NEVER a hard deny. Plus: `computeFirewallStamp` now writes under a
 * deny mode even with an EMPTY allow-list (so an enforce run isn't misrepresented as
 * ungoverned — the flagged provenance hazard).
 */
import { describe, it, expect } from 'vitest';
import { buildFirewallHook, computeFirewallStamp } from '../firewallHook.js';
import type { CapabilityRule } from '../types.js';

// A next tool that is a pure read (matches nothing risky) so it always "falls through".
const READ = 'openwop:knowledge.search';
const allowRead: CapabilityRule = { id: 'allow-read', description: '', verdict: 'allow', reason: 'ok', when: { with: [{ safetyTier: 'read' }] } };

describe('firewall modes (ADR 0397 P3)', () => {
  it('default-allow: an unmatched action is allowed (unchanged)', () => {
    const hook = buildFirewallHook({ rules: [], mode: 'default-allow', unknownToolPolicy: 'skip' });
    expect(hook.evaluate([], READ).decision).toBe('allow');
  });

  it('shadow: logs the would-block but APPLIES allow', () => {
    const seen: Array<[string, string]> = [];
    const hook = buildFirewallHook({ rules: [], mode: 'shadow', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip', onShadowWouldBlock: (t, w) => seen.push([t, w]) });
    expect(hook.evaluate([], READ).decision).toBe('allow'); // never blocks
    expect(seen).toEqual([[READ, 'deny']]);
  });

  it('shadow: dedups the would-block per turn (same tool twice → one record)', () => {
    const seen: Array<[string, string]> = [];
    const hook = buildFirewallHook({ rules: [], mode: 'shadow', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip', onShadowWouldBlock: (t, w) => seen.push([t, w]) });
    hook.evaluate([], READ);
    hook.evaluate([READ], READ);
    expect(seen).toHaveLength(1);
  });

  it('enforce + deny: an unmatched action is denied', () => {
    const hook = buildFirewallHook({ rules: [], mode: 'enforce', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip' });
    expect(hook.evaluate([], READ).decision).toBe('deny');
  });

  it('enforce: an explicit allow rule carves an exception (fall-through does not apply)', () => {
    const hook = buildFirewallHook({ rules: [allowRead], mode: 'enforce', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip' });
    expect(hook.evaluate([], READ).decision).toBe('allow');
  });

  it('enforce + require-approval: an unmatched action is held; bypass downgrades it to allow', () => {
    const enforce = buildFirewallHook({ rules: [], mode: 'enforce', defaultDenyVerdict: 'require-approval', unknownToolPolicy: 'skip' });
    expect(enforce.evaluate([], READ).decision).toBe('require-approval');
    const bypass = buildFirewallHook({ rules: [], mode: 'enforce', defaultDenyVerdict: 'require-approval', unknownToolPolicy: 'skip', bypassApproval: true });
    expect(bypass.evaluate([], READ).decision).toBe('allow');
  });

  it('enforce + deny: bypass does NOT downgrade a hard deny', () => {
    const hook = buildFirewallHook({ rules: [], mode: 'enforce', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip', bypassApproval: true });
    expect(hook.evaluate([], READ).decision).toBe('deny');
  });
});

const platformDenyRead: CapabilityRule = { id: 'plat-deny-read', description: '', verdict: 'deny', reason: 'platform floor', when: { with: [{ safetyTier: 'read' }] } };

describe('platform baseline (ADR 0397 P5) — most-restrictive floor', () => {
  it('a platform deny applies even when the tenant would allow', () => {
    const hook = buildFirewallHook({ rules: [], mode: 'default-allow', unknownToolPolicy: 'skip', platformRules: [platformDenyRead] });
    const v = hook.evaluate([], READ);
    expect(v.decision).toBe('deny');
    expect(v.reason).toBe('platform floor'); // the floor's reason surfaces
  });

  it('a tenant allow-rule CANNOT weaken a platform deny', () => {
    const hook = buildFirewallHook({ rules: [allowRead], mode: 'enforce', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip', platformRules: [platformDenyRead] });
    expect(hook.evaluate([], READ).decision).toBe('deny'); // platform floor wins over the tenant allow
  });

  it('no platform floor ⇒ the tenant verdict governs', () => {
    const hook = buildFirewallHook({ rules: [allowRead], mode: 'enforce', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip', platformRules: [] });
    expect(hook.evaluate([], READ).decision).toBe('allow');
  });

  // grade-code #1 — the floor must NOT be droppable by a tenant's skip policy.
  it('applies to an UNCLASSIFIED next under skip (risky fallback — floor not conditional on tenant classification)', () => {
    // The risky fallback is write+host-mediated; a platform rule on host-mediated egress catches it.
    const platDenyEgress: CapabilityRule = { id: 'plat-deny-egress', description: '', verdict: 'deny', reason: 'floor', when: { with: [{ egress: 'host-mediated' }] } };
    const hook = buildFirewallHook({ rules: [], mode: 'default-allow', unknownToolPolicy: 'skip', platformRules: [platDenyEgress] });
    expect(hook.evaluate([], 'openwop:custom.unknown-tool').decision).toBe('deny');
  });
});

describe('fail-closed on the firewall itself (ADR 0397 P5)', () => {
  // A rule whose access throws forces evaluateComposition to throw inside evaluate.
  const throwingRule = new Proxy({} as CapabilityRule, { get() { throw new Error('boom'); } });

  it('enforce: an evaluation error DENIES', () => {
    const hook = buildFirewallHook({ rules: [throwingRule], mode: 'enforce', unknownToolPolicy: 'skip' });
    const v = hook.evaluate([], READ);
    expect(v.decision).toBe('deny');
    expect(v.reason).toBe('firewall evaluation error');
  });

  it('default-allow / shadow: an evaluation error preserves non-blocking (allow)', () => {
    expect(buildFirewallHook({ rules: [throwingRule], mode: 'default-allow', unknownToolPolicy: 'skip' }).evaluate([], READ).decision).toBe('allow');
    expect(buildFirewallHook({ rules: [throwingRule], mode: 'shadow', unknownToolPolicy: 'skip' }).evaluate([], READ).decision).toBe('allow');
  });

  // grade-code #4 — a PLATFORM-floor eval error denies regardless of the (weaker) tenant mode.
  it('platform-baseline eval error DENIES even for a default-allow tenant', () => {
    const hook = buildFirewallHook({ rules: [], mode: 'default-allow', unknownToolPolicy: 'skip', platformRules: [throwingRule] });
    const v = hook.evaluate([], READ);
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('platform baseline');
  });
});

describe('shadow + platform floor honesty (ADR 0397 P5, grade-code #3)', () => {
  it('does NOT record a shadow would-block when the platform floor actually denies the call', () => {
    // Shadow tenant with an empty allow-list: a fall-through would-block is normally logged.
    // But the platform floor denies READ, so the call does NOT proceed — no shadow record.
    const platDenyRead: CapabilityRule = { id: 'plat-deny-read', description: '', verdict: 'deny', reason: 'floor', when: { with: [{ safetyTier: 'read' }] } };
    const seen: Array<[string, string]> = [];
    const hook = buildFirewallHook({ rules: [], mode: 'shadow', defaultDenyVerdict: 'deny', unknownToolPolicy: 'skip', platformRules: [platDenyRead], onShadowWouldBlock: (t, w) => seen.push([t, w]) });
    expect(hook.evaluate([], READ).decision).toBe('deny'); // platform floor blocks
    expect(seen).toHaveLength(0); // NOT recorded as "ran"
  });
});

describe('computeFirewallStamp provenance (ADR 0397 P3 hazard fix)', () => {
  it('writes a stamp under a deny mode even with an EMPTY allow-list', () => {
    const md = computeFirewallStamp({}, [], '2026-07-17T00:00:00Z', { mode: 'enforce', defaultDenyVerdict: 'deny' });
    expect(md).not.toBeNull();
    expect((md as Record<string, { mode: string }>).capabilityFirewall.mode).toBe('enforce');
  });

  it('stays a no-op under default-allow with no rules', () => {
    expect(computeFirewallStamp({}, [], '2026-07-17T00:00:00Z', { mode: 'default-allow' })).toBeNull();
  });

  it('does not overwrite an existing stamp', () => {
    expect(computeFirewallStamp({ capabilityFirewall: { rules: [] } }, [], undefined, { mode: 'enforce' })).toBeNull();
  });
});
