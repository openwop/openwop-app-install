/**
 * CGOV-2 — drift guard for the capability-classification table (ADR 0135). Every known
 * egress/integration namespace MUST resolve to a non-null descriptor whose `egress` is
 * off-host (host-mediated/host-owned), so a configured read-then-egress rule fires on it.
 * This catches a future namespace added to the tool surface but not classified here — the
 * gap that, combined with a fail-OPEN default, was the CGOV-2 bypass. (The fail-CLOSED
 * default unknownToolPolicy is the backstop; this keeps precision high so legit read-only
 * tools aren't over-classified as risky.)
 */
import { describe, it, expect } from 'vitest';
import { resolveToolCapability } from '../src/features/capability-firewall/toolCapabilityResolver.js';

const OFF_HOST_EGRESS = ['host-mediated', 'host-owned'];

describe('capability classification drift guard (CGOV-2)', () => {
  // Known off-host egress namespaces (the "send" side of an exfil combination).
  const EGRESS_NAMESPACES: readonly string[] = [
    'core.openwop.integration',
    'core.openwop.integration.email-send',
    'core.openwop.integration.slack-message',
    'core.openwop.integration.sms-send',
    'core.openwop.messaging',
    'core.openwop.a2a',
    'core.openwop.mcp',
  ];
  for (const name of EGRESS_NAMESPACES) {
    it(`classifies ${name} as an off-host egress write`, () => {
      const d = resolveToolCapability(name);
      expect(d).not.toBeNull();
      expect(OFF_HOST_EGRESS).toContain(d!.egress);
    });
  }

  it('classifies a read namespace as a non-egress read', () => {
    const d = resolveToolCapability('openwop:knowledge.search');
    expect(d).toMatchObject({ safetyTier: 'read', egress: 'none' });
  });

  it('returns null for an unclassified tool (so the unknownToolPolicy applies)', () => {
    expect(resolveToolCapability('custom.mystery.tool')).toBeNull();
  });
});
