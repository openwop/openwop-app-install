/**
 * ADR 0397 Phase 1 — the `kind` filter + tenant isolation on the unified governance
 * decision log. The firewall decisions view (`GET .../capability-firewall/orgs/:orgId/
 * decisions`) reads `listGovernanceDecisions(tenantId, { kind: 'firewall' })`; this pins
 * that (a) only firewall-kind decisions come back when scoped, and (b) a decision from
 * another tenant never leaks (the audit store is global; the payload tenantId filters).
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
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe('governance.decision.firewall');
    expect((rows[0]?.payload as { decision?: string }).decision).toBe('require-approval');
    expect((rows[0]?.payload as { ruleId?: string }).ruleId).toBe('read-then-egress');
  });

  it('no kind returns all governance decisions for the tenant (unchanged behavior)', async () => {
    const rows = await listGovernanceDecisions(A);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(['governance.decision.firewall', 'governance.decision.consent']));
  });

  it('does NOT leak another tenant\'s firewall decisions', async () => {
    const rows = await listGovernanceDecisions(A, { kind: 'firewall' });
    expect(rows.every((r) => (r.payload as { tenantId?: string }).tenantId === A)).toBe(true);
    const bRows = await listGovernanceDecisions(B, { kind: 'firewall' });
    expect(bRows.length).toBe(1);
    expect((bRows[0]?.payload as { reason?: string }).reason).toBe('other tenant');
  });
});
