/**
 * CGOV-2 — drift guard for the capability-classification table (ADR 0135). Every known
 * egress/integration namespace MUST resolve to a non-null descriptor whose `egress` is
 * off-host (host-mediated/host-owned), so a configured read-then-egress rule fires on it.
 * It guards the LISTED namespaces below: a listed namespace that loses its row or is
 * re-classified as non-egress was, with a fail-OPEN default, the CGOV-2 bypass. It cannot
 * see a brand-new namespace that nobody adds to this list — that gap is covered by the
 * fail-CLOSED `unknownToolPolicy: 'treat-as-risky'` default (capability-firewall-loop
 * "treat-as-risky defers after a read").
 *
 * Tracker TST-CBF-1 (security, CGOV-2). Red when: a listed egress row (a2a, mcp, the
 * integration base, destination-sync) is deleted or downgraded; a child name stops
 * resolving through its namespace prefix; the knowledge read row is re-tiered; an
 * unclassified tool gets a descriptor instead of null (w67g1-cls-* probes, wave 67).
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
    // A CHILD name resolves through its namespace prefix (`<prefix>.` match).
    'core.openwop.messaging.post',
    // ADR 0834 D7 — the one AGENT tool id in the table (POSTs records to a peer host).
    'openwop:destination-sync.run',
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
