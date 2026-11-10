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
 *
 * Overlaps, kept on purpose: leg 1 repeats at runtime what the
 * `Record<HostApprovalKind, Audience>` annotation already makes a tsc error (a
 * missing or extra key), so the ratchet holds even in a lane that skips
 * typecheck. Leg 4 is implied by leg 2's literal `toEqual`s (w66 aud-ref went
 * red in leg 2, not leg 4, because `claude-code-permission` still carries the
 * variant); it stays as the statement of WHY the type is discriminated.
 *
 * ADR 1031 P2 — the table covers HOST kinds only. A feature-owned kind registers its
 * audience with its decision recipe (`registerFeatureApprovalKind`), so it cannot
 * exist without one; leg 5 pins that a kind in NEITHER place fails closed instead of
 * reading as tenant-wide. KickTodo's six kinds (including branch 1,
 * `kicktodo-plan-proposal`) are pinned by their owner's test,
 * `kicktodo-approval-kinds.test.ts`.
 *
 * TST-BXF-1. Red when: a kind is added to or removed from the table without its
 * twin in APPROVAL_KINDS (w66 aud-extra, aud-missing), a scoped kind becomes
 * null or changes scope (aud-content, aud-dealer), `run-proposal` stops being
 * tenant-wide, or `assistant-action` loses its conditional variant (aud-runprop,
 * aud-assist).
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_KINDS } from '../src/host/approvalService.js';
import { APPROVAL_AUDIENCE, mayViewApproval, approvalRecipients } from '../src/host/approvalAudience.js';
import { featureApprovalKinds, registerFeatureApprovalKind } from '../src/host/approvalKindRegistry.js';

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
    // Branch 1 (`kicktodo-plan-proposal`, one ref, not a scope) is a FEATURE kind since
    // ADR 1031 P2 — pinned in kicktodo-approval-kinds.test.ts; ADR 0785 P4's
    // claude-code-permission carries the same variant here.
    expect(APPROVAL_AUDIENCE['claude-code-permission']).toEqual({ policyApproverRef: true });
  });

  it('leg 3: `null` is stated deliberately, and ONLY for kinds that are genuinely tenant-scoped', () => {
    // `run-proposal` is the precedent that null is a real value.
    // CORRECTED (ADR 0878 D6): this used to say the same of `assistant-action`. It is
    // tenant-wide only while a row carries no org: a drafted SUPPORT REPLY carries its
    // ticket's org, and as plain `null` it was readable and decidable by every editor in
    // the tenant (SD2-S6, proved red). It is now the conditional variant; its two
    // resolved answers are pinned in `adr0878-service-desk-security.test.ts` SD2-S6
    // (org-scoped) and by every pre-existing assistant-action test (tenant-wide).
    expect(APPROVAL_AUDIENCE['assistant-action']).toEqual({ orgScopeWhenOrg: 'workspace:write' });
    expect(APPROVAL_AUDIENCE['run-proposal']).toBeNull();
    // Every scoped branch must NOT be null — the failure mode this table exists to prevent is a
    // scoped kind silently reading as tenant-wide.
    for (const k of ['content-publish', 'anon-surface-write', 'claude-code-permission', 'commerce-listing-publish'] as const) {
      expect(APPROVAL_AUDIENCE[k], `${k} must never be tenant-wide`).not.toBeNull();
    }
  });

  it('leg 4: the shape is discriminated — a scope-or-null signature could not express three branches', () => {
    const kinds = Object.values(APPROVAL_AUDIENCE);
    expect(kinds.some((a) => a && 'policyApproverRef' in a), 'branch 1 needs a ref, not a scope').toBe(true);
    expect(kinds.some((a) => a && 'superadminTenant' in a), 'branch 7 needs a tenant test, not a scope').toBe(true);
    expect(kinds.some((a) => a && 'orgScope' in a)).toBe(true);
  });

  it('leg 5 (ADR 1031 P2): a kind in neither the host table nor the feature registry fails CLOSED', async () => {
    const orphan = { kind: 'retired-feature-kind' as never, policy: { requiredApprovals: 1, approverRefs: ['user:named'] } };
    expect(featureApprovalKinds()).not.toContain('retired-feature-kind');
    // Not tenant-wide: no ordinary tenant member — not even the named ref — sees it.
    expect(await mayViewApproval('ws:ordinary', 'user:named', orphan)).toBe(false);
    expect(await approvalRecipients('ws:ordinary', orphan)).toEqual({ addressed: true, refs: [] });
  });

  it('leg 6 (ADR 1031 P2): a feature cannot take over a host kind', () => {
    expect(() => registerFeatureApprovalKind('content-publish', { audience: null, decision: { getHandler: () => null, notComposedLabel: 'x', audit: () => ({ action: 'x', resource: 'x', payload: {} }) } }))
      .toThrow(/host kind/);
  });
});
