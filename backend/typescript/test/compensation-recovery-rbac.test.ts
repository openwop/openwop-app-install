/**
 * ADR 0554 P3 — RBAC + separation of duties on compensation recovery
 * (boundaries row 8: "start/retry/waive are separate permissions; waives
 * require reason and audit").
 *
 * ── WHAT THIS FILE IS BUILT TO CATCH ─────────────────────────────────────
 *
 * Three scope IDS are trivially assertable and prove nothing: a suite that only
 * checks `MANAGEMENT_SCOPES.includes('host:compensation:waive')` passes just as
 * happily if all three are granted to the same role, which is a naming
 * convention wearing a control's clothes. So the load-bearing leg here asserts
 * the LADDER — that an ADMIN role resolves `:retry` and does NOT resolve
 * `:waive` — because that is the only fact that makes the three distinct.
 *
 * The scope constants are read from `BUILT_IN_ROLES` / `scopesForRoles`, i.e.
 * DERIVED from the registration rather than restated, so a copied predicate
 * cannot agree with a bug for as long as the bug exists.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

/**
 * Makes the LEDGER READ throw, so the separation-of-duties catch-all arm can be
 * reached deliberately instead of only by accident. Everything else stays real.
 */
const ledgerFault = vi.hoisted(() => ({ throwOnGet: false }));
vi.mock('../src/host/compensationLedger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/host/compensationLedger.js')>();
  return {
    ...orig,
    getObligation: async (tenantId: string, id: string) => {
      if (ledgerFault.throwOnGet) throw new Error('storage unavailable');
      return orig.getObligation(tenantId, id);
    },
  };
});
import {
  BUILT_IN_ROLES,
  MANAGEMENT_SCOPES,
  PROTOCOL_SCOPES,
  isProtocolScope,
  scopesForRoles,
  type Scope,
} from '../src/host/accessControlService.js';
import { effectiveWaiveRequiresApproval } from '../src/host/compensationUnwind.js';
import {
  applyRecoveryAction,
  isHighRiskWaive,
  requiresJustification,
  scopeForRecoveryAction,
} from '../src/host/compensationRecovery.js';
import {
  COMPENSATION_RECOVERY_ACTIONS,
  type CompensationRecoveryAction,
} from '../src/host/compensationRecoveryAudit.js';
import {
  _resetCompensationLedgerForTest,
  digestOf,
  getObligation,
  recordObligation,
  resolveObligation,
  WAIVE_APPROVAL_SUFFIX,
} from '../src/host/compensationLedger.js';
import {
  assertApprovalEligibility,
  createCompensationApproval,
} from '../src/host/approvalService.js';
import { registerCompensationApprovalEligibility } from '../src/host/compensationRuntime.js';
import { __resetAuditChain } from '../src/host/auditChainService.js';

const T = 'tenant-p3-rbac';
const R = 'run-p3-rbac';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerCompensationApprovalEligibility();
});

beforeEach(async () => {
  await _resetCompensationLedgerForTest();
  await __resetAuditChain();
  ledgerFault.throwOnGet = false;
  registerCompensationApprovalEligibility();
});

async function commit(over: Parameters<typeof recordObligation>[0] extends infer P
  ? Partial<P> : never = {}) {
  return recordObligation({
    tenantId: T,
    runId: R,
    forwardLogicalInvocationId: 'inv-1',
    compensationOrdinal: 1,
    effectKind: 'payment',
    shape: 'forward-effect',
    resultDigest: digestOf({ charge: 1 }),
    contractDigest: digestOf({ refund: 'v1' }),
    ...over,
  });
}

describe('ADR 0554 P3 — the three permissions are registered and DISTINCT', () => {
  it('registers exactly three compensation scopes, all host-managed', () => {
    const compensation = MANAGEMENT_SCOPES.filter((s) => s.startsWith('host:compensation:'));
    expect([...compensation].sort()).toEqual([
      'host:compensation:retry',
      'host:compensation:start',
      'host:compensation:waive',
    ]);
  });

  it('keeps them OUT of PROTOCOL_SCOPES — that set is wire-facing (ADR 0078 §Phase-1)', () => {
    for (const s of MANAGEMENT_SCOPES.filter((x) => x.startsWith('host:compensation:'))) {
      expect(PROTOCOL_SCOPES as readonly string[]).not.toContain(s);
      // A custom role may carry ONLY protocol scopes, so this is also what stops
      // a tenant minting a role that can waive.
      expect(isProtocolScope(s)).toBe(false);
    }
  });

  /**
   * THE LADDER LEG. Without this, all three scope ids could be granted to the
   * same role and every other assertion in this file would still pass — which
   * is the "gate that cannot fail" shape.
   */
  it('ADMIN may start and retry but may NOT waive; OWNER may waive', () => {
    const admin = scopesForRoles(['admin']);
    const owner = scopesForRoles(['owner']);

    expect(admin).toContain('host:compensation:start');
    expect(admin).toContain('host:compensation:retry');
    expect(admin).not.toContain('host:compensation:waive');

    expect(owner).toContain('host:compensation:waive');
    // Owner is a superset of admin, so the weaker two ride along.
    expect(owner).toContain('host:compensation:retry');
  });

  it('the ladder is DERIVED from BUILT_IN_ROLES, not from a copied list', () => {
    // Restating the predicate from the registration itself: whichever role holds
    // `host:org:manage` (the established owner-only rung) must be exactly the
    // set of roles that hold the waive scope.
    const ownerOnly = (s: Scope) =>
      Object.values(BUILT_IN_ROLES).filter((r) => r.scopes.includes(s)).map((r) => r.id).sort();
    expect(ownerOnly('host:compensation:waive')).toEqual(ownerOnly('host:org:manage'));
  });
});

describe('ADR 0554 P3 — the action -> scope map', () => {
  it('is exhaustive over every recovery action', () => {
    for (const a of COMPENSATION_RECOVERY_ACTIONS) {
      expect(scopeForRecoveryAction(a)).toMatch(/^host:compensation:(start|retry|waive)$/);
    }
  });

  it('files every AUTHORED-CONTRACT OVERRIDE under :waive — including substitute', () => {
    expect(scopeForRecoveryAction('start')).toBe('host:compensation:start');
    expect(scopeForRecoveryAction('retry')).toBe('host:compensation:retry');
    expect(scopeForRecoveryAction('skip')).toBe('host:compensation:waive');
    expect(scopeForRecoveryAction('terminate')).toBe('host:compensation:waive');
    // substitute runs an ARBITRARY registered nodeTypeId under the obligation's
    // §C identity. Under :retry that is a privilege escalation on the admin rung.
    expect(scopeForRecoveryAction('substitute')).toBe('host:compensation:waive');
  });

  it('derives "needs a justification" from the SAME map, so the two cannot disagree', () => {
    for (const a of COMPENSATION_RECOVERY_ACTIONS) {
      expect(requiresJustification(a)).toBe(scopeForRecoveryAction(a) === 'host:compensation:waive');
    }
  });
});

describe('ADR 0554 P3 — a waive REQUIRES a reason', () => {
  it.each<CompensationRecoveryAction>(['skip', 'terminate', 'substitute'])(
    'refuses %s with no reason, before touching the ledger',
    async (action) => {
      const o = await commit();
      await expect(applyRecoveryAction({
        tenantId: T, runId: R, obligationId: o.inverseActionId,
        action, actor: 'user:alice', expectedState: 'requested',
      })).rejects.toMatchObject({ code: 'validation_error', httpStatus: 400 });

      // Nothing moved: the refusal is BEFORE the critical section's writes.
      expect((await getObligation(T, o.inverseActionId))?.state).toBe('requested');
    },
  );

  it('refuses a whitespace-only reason (the empty-string-with-extra-steps arm)', async () => {
    const o = await commit();
    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:alice', expectedState: 'requested', reason: '   ',
    })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('does NOT demand one for start/retry — they run the AUTHORED inverse', () => {
    expect(requiresJustification('start')).toBe(false);
    expect(requiresJustification('retry')).toBe(false);
  });
});

describe('ADR 0554 P3 — high-risk waive derivation', () => {
  it('is TRUE only for a waive of an obligation the AUTHOR declared approval-gated', async () => {
    const gated = await commit({ requiresApproval: true, compensationOrdinal: 10, forwardLogicalInvocationId: 'inv-10' });
    const plain = await commit({ compensationOrdinal: 11, forwardLogicalInvocationId: 'inv-11' });

    expect(isHighRiskWaive(gated, 'skip')).toBe(true);
    expect(isHighRiskWaive(gated, 'terminate')).toBe(true);
    expect(isHighRiskWaive(plain, 'skip')).toBe(false);
  });

  it('does NOT gate substitute — that would demand sign-off to do MORE undoing', async () => {
    const gated = await commit({ requiresApproval: true });
    expect(isHighRiskWaive(gated, 'substitute')).toBe(false);
  });

  /**
   * The rejected alternative, pinned so a later reader does not "fix" the gap by
   * adding the heuristic back. `effectKind: 'payment'` with
   * `requiresApproval` unset must NOT be high-risk: ADR 0554's own rule is that
   * WHICH cases qualify is read from the authored declaration, never inferred by
   * the host. The residue (an owner can waive a payment inverse without an
   * approval) is named in the ADR with the RFC 0151 §B ask that would close it.
   */
  it('is NOT inferred from effectKind — a payment alone is not "high risk"', async () => {
    const payment = await commit({ effectKind: 'payment' });
    expect(payment.effectKind).toBe('payment');
    expect(payment.requiresApproval).toBeUndefined();
    expect(isHighRiskWaive(payment, 'skip')).toBe(false);
  });
});

describe('RFC 0151 §B (S36) — waiveRequiresApproval', () => {
  /**
   * S37 DECIDED (A) ESCALATE-ONLY, merged as openwop#1064: "Escalation is a
   * floor. An explicit `waiveRequiresApproval: false` MUST NOT lower a value
   * that policy escalation has raised."
   *
   * The two halves settle DIFFERENTLY and both are pinned below: an explicit
   * `false` still beats the node's own `requiresApproval`, and never beats
   * workspace escalation. A test that only covered one half would pass under
   * either reading, which is exactly what the isolated choke exists to prevent.
   */
  it('explicit TRUE gates a waive whose requiresApproval is FALSE', async () => {
    const o = await commit({ requiresApproval: false, waiveRequiresApproval: true });
    expect(isHighRiskWaive(o, 'skip')).toBe(true);
    expect(isHighRiskWaive(o, 'terminate')).toBe(true);
  });

  it('explicit FALSE beats the NODE\'s own requiresApproval (the half S37 (A) kept)', async () => {
    // No workspace escalation in play, so the author's "declining is an ops
    // call" stands. The row's stamp was resolved at mint.
    const o = await commit({ requiresApproval: true, waiveRequiresApproval: false });
    expect(isHighRiskWaive(o, 'skip')).toBe(false);
  });

  it('ABSENT inherits requiresApproval — in BOTH directions, so it is not one-sided', async () => {
    // DISTINCT identity tuples. `commit()` hardcodes `inv-1`/ordinal 1, and the
    // §C id is hashed from that tuple — so two bare `commit()` calls in one test
    // address the SAME row and the second silently reads back the first. Caught
    // by this leg failing "expected true to be false" on what looked like a
    // precedence bug.
    const gated = await commit({ requiresApproval: true, forwardLogicalInvocationId: 'inv-g', compensationOrdinal: 91 });
    const plain = await commit({ requiresApproval: false, forwardLogicalInvocationId: 'inv-p', compensationOrdinal: 92 });
    expect(gated.waiveRequiresApproval).toBeUndefined();
    expect(plain.waiveRequiresApproval).toBeUndefined();
    expect(isHighRiskWaive(gated, 'skip')).toBe(true);
    expect(isHighRiskWaive(plain, 'skip')).toBe(false);
  });

  /**
   * A row minted before S36 carries NO stamp. Falling back to `requiresApproval`
   * is the pre-S36 behaviour; the alternative (`?? false`) would silently
   * UN-GATE every obligation already in the ledger the moment this shipped.
   */
  it('a PRE-S36 row (no stamp) falls back to requiresApproval rather than un-gating', async () => {
    const o = await commit({ requiresApproval: true });
    // Exactly the shape of a durable row written before the field existed.
    const legacy = { ...o } as Record<string, unknown>;
    delete legacy['waiveRequiresApproval'];
    expect(legacy['waiveRequiresApproval']).toBeUndefined();
    expect(isHighRiskWaive(legacy as unknown as typeof o, 'skip')).toBe(true);
  });

  it('never gates SUBSTITUTE, whatever the field says — it is still an attempt to UNDO', async () => {
    const o = await commit({ requiresApproval: true, waiveRequiresApproval: true });
    expect(isHighRiskWaive(o, 'substitute')).toBe(false);
    expect(isHighRiskWaive(o, 'retry')).toBe(false);
    expect(isHighRiskWaive(o, 'start')).toBe(false);
  });

  it('resolves the EFFECTIVE value against the policy, not the raw declaration', () => {
    const bare = { nodeTypeId: 'core.payment.refund' };
    // No policy: nothing gates.
    expect(effectiveWaiveRequiresApproval(bare)).toBe(false);
    // §E `approvalScope: 'all'` escalates requiresApproval — and §B routes that
    // escalation to waives THROUGH the default, so it must reach here.
    expect(effectiveWaiveRequiresApproval(bare, { triggers: ['node-failure'], approvalScope: 'all' })).toBe(true);
    // S37 (A) / openwop#1064 — ESCALATION IS A FLOOR. An explicit `false` must
    // NOT lower what the workspace policy raised. This is the leg that reds if
    // the choke is ever flipped back to reading (B).
    expect(effectiveWaiveRequiresApproval(
      { ...bare, waiveRequiresApproval: false },
      { triggers: ['node-failure'], approvalScope: 'all' },
    )).toBe(true);
    // ...while WITHOUT escalation the same explicit `false` still wins over the
    // node's own `requiresApproval`. Both halves, or the leg proves nothing.
    expect(effectiveWaiveRequiresApproval({ ...bare, requiresApproval: true, waiveRequiresApproval: false })).toBe(false);
  });
});

describe('RFC 0151 §E — separation of duties on a WAIVE approval', () => {
  async function waiveApprovalFor(obligationId: string, requestedBy: string) {
    return createCompensationApproval({
      tenantId: T,
      runId: R,
      workflowId: '',
      compensationId: `${obligationId}${WAIVE_APPROVAL_SUFFIX}`,
      compensationNodeTypeId: 'test.payment.refund',
      requestedBy,
      proposal: 'Waive it.',
    });
  }

  it('REFUSES the operator who STARTED the compensation — the second excluded principal', async () => {
    const o = await commit();
    // Carol started the unwind; Alice asked to waive it. The pre-P3 rule only
    // excluded Alice, leaving Carol free to bless abandoning her own unwind.
    await resolveObligation({
      tenantId: T, inverseActionId: o.inverseActionId, to: 'started',
      reason: 'operator retry', startedBy: 'user:carol',
    });
    const approval = await waiveApprovalFor(o.inverseActionId, 'user:alice');

    await expect(assertApprovalEligibility(T, 'user:carol', approval))
      .rejects.toThrow(/started this compensation/i);
  });

  it('still REFUSES the requester (the P2 rule, unchanged)', async () => {
    const o = await commit();
    const approval = await waiveApprovalFor(o.inverseActionId, 'user:alice');
    await expect(assertApprovalEligibility(T, 'user:alice', approval))
      .rejects.toThrow(/separation of duties/i);
  });

  it('ALLOWS a third human who neither started nor requested', async () => {
    const o = await commit();
    await resolveObligation({
      tenantId: T, inverseActionId: o.inverseActionId, to: 'started',
      reason: 'operator retry', startedBy: 'user:carol',
    });
    const approval = await waiveApprovalFor(o.inverseActionId, 'user:alice');
    await expect(assertApprovalEligibility(T, 'user:dora', approval)).resolves.toBeUndefined();
  });

  /**
   * FAIL CLOSED. An unreadable row means separation of duties cannot be
   * evaluated at all — and permitting the decision there makes the control
   * vacuous in exactly the case where something has already gone wrong.
   *
   * THE ASSERTION IS ARM-SPECIFIC, AND THAT MATTERS. Both fail-closed arms open
   * "Separation of duties cannot be evaluated", so a regex on that phrase passes
   * whichever one fires. MEASURED (sabotage S8): deleting the explicit
   * missing-row guard makes the code dereference `null`, the catch-all converts
   * the TypeError into the OTHER 403, and a phrase-level assertion stays GREEN —
   * a guard indistinguishable from a crash that happened to land safely. Pinning
   * the arm's own words is what makes S8 red.
   */
  it('REFUSES when the referenced obligation is MISSING (the explicit guard)', async () => {
    const approval = await waiveApprovalFor('cmp_does_not_exist', 'user:alice');
    await expect(assertApprovalEligibility(T, 'user:bob', approval))
      .rejects.toThrow(/references an obligation this host cannot read/i);
  });

  it('REFUSES when the ledger READ ITSELF throws (the catch-all arm)', async () => {
    const o = await commit();
    const approval = await waiveApprovalFor(o.inverseActionId, 'user:alice');
    ledgerFault.throwOnGet = true;
    try {
      await expect(assertApprovalEligibility(T, 'user:bob', approval))
        .rejects.toThrow(/ledger is unreadable/i);
    } finally {
      ledgerFault.throwOnGet = false;
    }
  });

  it('and ALLOWS the same approver once the ledger reads again — not stuck-closed', async () => {
    const o = await commit();
    const approval = await waiveApprovalFor(o.inverseActionId, 'user:alice');
    await expect(assertApprovalEligibility(T, 'user:bob', approval)).resolves.toBeUndefined();
  });

  /**
   * The suffix is what keeps the two decisions apart. An approval WITHOUT it is
   * the unwind's own §B gate, where `startedBy` is not an excluded principal —
   * the operator who started an unwind may perfectly well approve continuing it.
   */
  it('does NOT apply the startedBy exclusion to the UNWIND gate (no #waive suffix)', async () => {
    const o = await commit();
    await resolveObligation({
      tenantId: T, inverseActionId: o.inverseActionId, to: 'started',
      reason: 'operator retry', startedBy: 'user:carol',
    });
    const unwindGate = await createCompensationApproval({
      tenantId: T, runId: R, workflowId: 'wf.payments',
      compensationId: o.inverseActionId, // NO suffix
      compensationNodeTypeId: 'test.payment.refund',
      requestedBy: 'user:alice',
      proposal: 'Run the refund.',
    });
    await expect(assertApprovalEligibility(T, 'user:carol', unwindGate)).resolves.toBeUndefined();
  });

  /**
   * A personal-workspace owner passes the ROUTE gate (`requireTenantScope`
   * short-circuits on `isOwnPersonalWorkspace`) and is then refused HERE. The
   * two gates answer different questions and the composition is the control —
   * `registerCompensationApprovalEligibility` refuses `isPersonalOwner`
   * deliberately, "a personal workspace has exactly one human, so accepting it
   * would make the rule vacuous precisely where it is the only control".
   */
  it('does NOT honour isPersonalOwner — one human cannot be two duties', async () => {
    const o = await commit();
    const approval = await waiveApprovalFor(o.inverseActionId, 'user:solo');
    await expect(
      assertApprovalEligibility(T, 'user:solo', approval, { isPersonalOwner: true }),
    ).rejects.toThrow(/separation of duties/i);
  });
});
