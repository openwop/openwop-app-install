/**
 * ADR 0397 Phase 1 — the `kind` filter + tenant isolation on the unified governance
 * decision log. The firewall decisions view (`GET .../capability-firewall/orgs/:orgId/
 * decisions`) reads `listGovernanceDecisions(tenantId, { kind: 'firewall' })`; this pins
 * that (a) only firewall-kind decisions come back when scoped, and (b) a decision from
 * another tenant never leaks (the audit store is global; the payload tenantId filters).
 *
 * The tenant filter is also asserted by `test/cdp-governance-decisions.test.ts` ('records
 * + queries decisions, tenant-filtered'); both protected, kept. The kind filter is only here.
 *
 * Red when (w74g4-gov-* probes, wave 74): the kind is dropped from the action prefix; the
 * payload tenantId filter is skipped; the decision `detail` or the `reason` is not written
 * into the payload.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../hostExtPersistence.js';
import { openStorage } from '../../storage/index.js';
import { recordGovernanceDecision, listGovernanceDecisions } from '../governanceDecisionLog.js';

const A = 'tenant-gov-a';
const B = 'tenant-gov-b';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // Tenant A: one firewall deny + one consent decision.
  await recordGovernanceDecision({ tenantId: A, kind: 'firewall', outcome: 'deny', reason: 'read-then-egress', resource: 'conv-1', detail: { toolName: 'openwop:core.openwop.http.fetch', decision: 'require-approval', ruleId: 'read-then-egress' } });
  await recordGovernanceDecision({ tenantId: A, kind: 'consent', outcome: 'deny', reason: 'no consent' });
  // Tenant B: a firewall deny that must NOT surface for tenant A.
  await recordGovernanceDecision({ tenantId: B, kind: 'firewall', outcome: 'deny', reason: 'other tenant', detail: { toolName: 'x', decision: 'deny' } });
});

describe('governance decision log — kind filter (ADR 0397 P1)', () => {
  it('kind:firewall returns only firewall decisions for the tenant', async () => {
    const rows = await listGovernanceDecisions(A, { kind: 'firewall' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'governance.decision.firewall',
      outcome: 'deny',
      resource: 'conv-1',
      payload: { tenantId: A, reason: 'read-then-egress', toolName: 'openwop:core.openwop.http.fetch', decision: 'require-approval', ruleId: 'read-then-egress' },
    });
  });

  it('no kind returns all governance decisions for the tenant (unchanged behavior)', async () => {
    const rows = await listGovernanceDecisions(A);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(['governance.decision.firewall', 'governance.decision.consent']));
  });

  it('does NOT leak another tenant\'s firewall decisions', async () => {
    // Exactly A's own firewall row (non-empty, so this cannot pass on an empty list).
    const rows = await listGovernanceDecisions(A, { kind: 'firewall' });
    expect(rows.map((r) => r.payload)).toEqual([expect.objectContaining({ tenantId: A, reason: 'read-then-egress' })]);
    // Positive control: B's row exists and is B's own.
    const bRows = await listGovernanceDecisions(B, { kind: 'firewall' });
    expect(bRows).toHaveLength(1);
    expect(bRows[0]).toMatchObject({ payload: { tenantId: B, reason: 'other tenant' } });
  });
});
