/**
 * ADR 0672 D1 (CMSAWF-11 / CMSAWF-18) — ONE audience owner for "who may learn this
 * approval row exists", seeded from all NINE branches of `reviewProjection.approvalVisible`.
 *
 * Born red: `host/approvalAudience.ts` did not exist; `routes/approvals.ts` implemented FOUR
 * of the nine audiences and returned every other kind UNFILTERED; and the SLA lane resolved
 * recipients from a field no CMS lane sets, so it emitted with no recipient at all.
 *
 * Leg 1 is the ratchet. It is the reason this table cannot decay the way
 * `routes/approvals.ts` did: a new approval kind fails the build until its audience is
 * stated. My own ADR enumerated 6 of the 14 tenant-scoped kinds — the prose undercounted
 * and the ratchet is what catches that.
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_KINDS } from '../src/host/approvalService.js';
import { APPROVAL_AUDIENCE } from '../src/host/approvalAudience.js';

describe('ADR 0672 D1 — the audience table is complete and correct', () => {
  it('leg 1 (the ratchet): EVERY approval kind has a stated audience', () => {
    const missing = APPROVAL_KINDS.filter((k) => !(k in APPROVAL_AUDIENCE));
    expect(missing, 'a kind with no stated audience defaults to a tenant-wide broadcast').toEqual([]);
    // ...and nothing is stated for a kind that does not exist (the table cannot drift ahead).
    const extra = Object.keys(APPROVAL_AUDIENCE).filter((k) => !(APPROVAL_KINDS as readonly string[]).includes(k));
    expect(extra).toEqual([]);
  });

  it('leg 2: the nine branches carry the audiences reviewProjection already enforced', () => {
    // Branch 9 — the rule this ADR started from.
    expect(APPROVAL_AUDIENCE['content-publish']).toEqual({ orgScope: 'host:members:manage' });
    expect(APPROVAL_AUDIENCE['strategy-activation']).toEqual({ orgScope: 'host:members:manage' });
    // Branches 2-4 — field sales, each its OWN scope (a single shared scope would widen three).
    expect(APPROVAL_AUDIENCE['dealer-registration']).toEqual({ orgScope: 'host:dealers:manage' });
    expect(APPROVAL_AUDIENCE['territory-model-transition']).toEqual({ orgScope: 'host:territories:manage' });
    expect(APPROVAL_AUDIENCE['commission-statement']).toEqual({ orgScope: 'host:commissions:manage' });
    // Branches 5-6.
    expect(APPROVAL_AUDIENCE['strategy-checkin']).toEqual({ orgScope: 'workspace:write' });
    expect(APPROVAL_AUDIENCE['pm-scenario-select']).toEqual({ orgScope: 'workspace:write' });
    // Branch 8 — the comment on this one says the fallthrough leaks a visitor's captured PII.
    expect(APPROVAL_AUDIENCE['anon-surface-write']).toEqual({ orgScope: 'workspace:write' });
    // Branch 7 — superadmin tenant, NOT an org scope.
    expect(APPROVAL_AUDIENCE['commerce-listing-publish']).toEqual({ superadminTenant: true });
    // Branch 1 — the note is free text ABOUT a participant; one ref, not a scope.
    expect(APPROVAL_AUDIENCE['kicktodo-plan-proposal']).toEqual({ policyApproverRef: true });
  });

  it('leg 3: `null` is stated deliberately, and ONLY for kinds that are genuinely tenant-scoped', () => {
    // `assistant-action` is the precedent that null is a real value: actionApproval.ts already
    // emits a create-time tenant-wide broadcast for it, on purpose.
    expect(APPROVAL_AUDIENCE['assistant-action']).toBeNull();
    expect(APPROVAL_AUDIENCE['run-proposal']).toBeNull();
    // Every scoped branch must NOT be null — the failure mode this table exists to prevent is a
    // scoped kind silently reading as tenant-wide.
    for (const k of ['content-publish', 'anon-surface-write', 'kicktodo-plan-proposal', 'commerce-listing-publish'] as const) {
      expect(APPROVAL_AUDIENCE[k], `${k} must never be tenant-wide`).not.toBeNull();
    }
  });

  it('leg 4: the shape is discriminated — a scope-or-null signature could not express three branches', () => {
    const kinds = Object.values(APPROVAL_AUDIENCE);
    expect(kinds.some((a) => a && 'policyApproverRef' in a), 'branch 1 needs a ref, not a scope').toBe(true);
    expect(kinds.some((a) => a && 'superadminTenant' in a), 'branch 7 needs a tenant test, not a scope').toBe(true);
    expect(kinds.some((a) => a && 'orgScope' in a)).toBe(true);
  });
});
