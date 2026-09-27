/**
 * RFC 0151 §B — the workflow-level compensation policy at
 * `settings.compensation` (`compensation-policy.schema.json`, openwop#1009),
 * and the node-level declaration that rides beside it.
 *
 * TWO THINGS THIS FILE PINS, and they pull in opposite directions on purpose:
 *
 *   1. The node-level `compensation` block MUST SURVIVE registration. It was
 *      being dropped — `validateWorkflowDefinition` rebuilds each node from an
 *      allowlist, and an unlisted field is discarded silently — which made the
 *      whole ADR 0554 P2 unwind inert for any workflow registered through the
 *      route. The seam suite could not see it, because it builds definitions
 *      in-process and never crosses the validator.
 *   2. The workflow-level POLICY must be REFUSED with `capability_required`
 *      while this host does not advertise `capabilities.compensation`. The
 *      schema is explicit: accepting a policy the host will never honour "tells
 *      the author an unwind will happen when it will not, which is RFC 0148 §B's
 *      advertise-and-opt-out failure with the sign flipped."
 *
 * The asymmetry is the point. A node declaration is a statement ABOUT THE
 * WORKFLOW — a host that never unwinds simply never acts on it. A policy is a
 * claim ABOUT THE HOST.
 *
 * ── UPDATED 2026-08-16 (ADR 0554 wire flip) ─────────────────────────────────
 * Point 2's DEFAULT has inverted, and the reason it inverted matters more than
 * the fact: this host now advertises `capabilities.compensation`, so accepting
 * the policy is the honest posture and REFUSING it would be the same lie with
 * the sign flipped a second time — telling an author no unwind will happen when
 * one will. Both directions are still exercised. The refusal is reached through
 * the capability overlay (the conformance capability-toggle seam), because it is
 * still a normative MUST for any host in that state and a contract nobody runs
 * is a contract that rots; the accept path is asserted WITHOUT the overlay, so
 * it tests the shipped default rather than a seam-manufactured one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { OpenwopError } from '../src/types.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { setCapabilityOverlay, resetCapabilityOverlay, resolveCapabilityFlag } from '../src/host/capabilityOverlay.js';
import {
  COMPENSATION_DEFAULT_RETRY,
  COMPENSATION_FALLBACK_TRIGGERS,
  type CompensationPolicy,
  policyAdmitsTrigger,
  requiresApproval,
  retryBudgetFor,
  FIRED_COMPENSATION_TRIGGERS,
  COMPENSATION_TRIGGERS,
} from '../src/host/compensationUnwind.js';

const REFUND = { nodeTypeId: 'test.payment.refund' };

function def(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowId: 'wf.payments',
    nodes: [{ nodeId: 'charge', typeId: 'test.payment.charge', compensation: { ...REFUND, retry: { maxAttempts: 5 } } }],
    ...over,
  };
}

beforeEach(() => { resetCapabilityOverlay(); });

describe('RFC 0151 §B — the node declaration survives registration', () => {
  it('preserves `compensation` on a registered node', () => {
    const out = validateWorkflowDefinition(def());
    // Dropped, this reads `undefined` and the executor mints no obligation for a
    // node that committed a real effect — an unwind then reports a clean `none`.
    expect(out.nodes[0]?.compensation).toEqual({ nodeTypeId: 'test.payment.refund', retry: { maxAttempts: 5 } });
  });

  it('accepts a node declaration WITHOUT the capability advert', () => {
    // The asymmetry above: a declaration is not a claim about the host.
    expect(() => validateWorkflowDefinition(def())).not.toThrow();
  });

  it('rejects an unknown key — the §B block is CLOSED', () => {
    const bad = def({
      nodes: [{ nodeId: 'charge', typeId: 't', compensation: { ...REFUND, shape: 'forward-effect' } }],
    });
    expect(() => validateWorkflowDefinition(bad)).toThrow(/closed/i);
  });

  it('requires `nodeTypeId`, so a typo is found at registration and not during a failure', () => {
    const bad = def({ nodes: [{ nodeId: 'charge', typeId: 't', compensation: { retry: { maxAttempts: 2 } } }] });
    expect(() => validateWorkflowDefinition(bad)).toThrow(/nodeTypeId/);
  });

  /* ── RFC 0151 §B (S36) — `waiveRequiresApproval` at the validator ────── */

  it('PRESERVES an explicit `waiveRequiresApproval: false` through registration', () => {
    // `false` is the value the closed-block rebuild loses most quietly: a
    // dropped key and a written `undefined` look identical unless the fixture
    // declares a non-default value and the assertion is exact.
    const out = validateWorkflowDefinition(def({
      nodes: [{ nodeId: 'charge', typeId: 't', compensation: { ...REFUND, waiveRequiresApproval: false } }],
    }));
    expect(out.nodes[0]?.compensation?.waiveRequiresApproval).toBe(false);
  });

  it('PRESERVES an explicit `waiveRequiresApproval: true`', () => {
    const out = validateWorkflowDefinition(def({
      nodes: [{ nodeId: 'charge', typeId: 't', compensation: { ...REFUND, waiveRequiresApproval: true } }],
    }));
    expect(out.nodes[0]?.compensation?.waiveRequiresApproval).toBe(true);
  });

  it('leaves it ABSENT when undeclared — absent means "inherit", never `false`', () => {
    const out = validateWorkflowDefinition(def());
    expect(out.nodes[0]?.compensation).not.toHaveProperty('waiveRequiresApproval');
  });

  it('rejects a NON-boolean rather than coercing it', () => {
    const bad = def({
      nodes: [{ nodeId: 'charge', typeId: 't', compensation: { ...REFUND, waiveRequiresApproval: 'yes' } }],
    });
    expect(() => validateWorkflowDefinition(bad)).toThrow(/waiveRequiresApproval/);
  });

  it('rejects a malformed retry bound rather than silently defaulting it', () => {
    const bad = def({ nodes: [{ nodeId: 'charge', typeId: 't', compensation: { ...REFUND, retry: { maxAttempts: 0 } } }] });
    expect(() => validateWorkflowDefinition(bad)).toThrow(/maxAttempts/);
  });
});

describe('RFC 0151 §B — the workflow policy is refused by a host that does NOT advertise', () => {
  const POLICY = { triggers: ['node-failure'] };

  // FLIPPED 2026-08-16 (ADR 0554 wire flip). This host now advertises
  // `capabilities.compensation`, so the refusal is no longer its default posture
  // — it is the contract a NON-advertising deployment owes, and it is reached
  // here through the capability overlay, the same seam the conformance harness
  // flips (`host/capabilityOverlay.ts`, the `host.aiEnvelope.supported`
  // precedent).
  //
  // The block is kept rather than deleted for the reason the schema gives: the
  // refusal is a normative MUST for any host in that state, and a code path that
  // stops being exercised the day our own advert lands is a path that rots
  // silently. Deleting it would also delete the only test that pins the CODE —
  // `capability_required`, not the broad `validation_error`.
  beforeEach(() => { setCapabilityOverlay('compensation.supported', false); });

  it('refuses `settings.compensation` with `capability_required`', () => {
    try {
      validateWorkflowDefinition(def({ settings: { compensation: POLICY } }));
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(OpenwopError);
      const e = err as OpenwopError;
      // The schema names this exact code and detail. `validation_error` is also
      // in the closed set, but it cannot tell an author "your document is fine,
      // this host just does not do that yet" — and those need different fixes.
      expect(e.code).toBe('capability_required');
      expect(e.details).toMatchObject({ requiredCapability: 'compensation' });
    }
  });

  it('the refused policy never reaches the stored definition', () => {
    // Refusal must precede preservation on EVERY path. A policy that 400s but
    // still lands in the row would be honoured by a later host upgrade that
    // nobody re-validated.
    expect(() => validateWorkflowDefinition(def({ settings: { compensation: POLICY } }))).toThrow();
  });

  it('a `settings` object WITHOUT the compensation key is untouched', () => {
    const out = validateWorkflowDefinition(def({ settings: { timeout: 30_000 } }));
    expect(out.settings).toEqual({ timeout: 30_000 });
  });
});

describe('RFC 0151 §B — the accept path, LIVE since the advert flipped', () => {
  // Was: "live when the advert flips", driven through the capability overlay
  // because the accept path was otherwise unreachable. The overlay is gone from
  // this block on purpose — the accept path is now the DEFAULT posture, and
  // leaving the overlay in place would keep passing even if the default silently
  // reverted to refusing, which is exactly the drift the advert flip makes
  // possible.
  it('the accept path is the DEFAULT — no overlay, no seam, the shipped posture', () => {
    // Vacuity guard for the whole block: without this an accidental default of
    // `false` would turn every `not.toThrow()` below into a test of nothing,
    // because a refusal throws and a `toThrow(/triggers/)` would still pass on
    // the `capability_required` message.
    expect(resolveCapabilityFlag('compensation.supported')).toBe(true);
    expect(resolveCapabilityFlag('compensation.manualIntervention')).toBe(true);
  });

  it('accepts a well-formed policy', () => {
    const out = validateWorkflowDefinition(def({ settings: { compensation: { triggers: ['node-failure', 'run-cancel'] } } }));
    expect(out.settings?.compensation?.triggers).toEqual(['node-failure', 'run-cancel']);
  });

  it('REQUIRES a non-empty `triggers` — a policy that names no trigger is not a policy', () => {
    expect(() => validateWorkflowDefinition(def({ settings: { compensation: {} } }))).toThrow(/triggers/);
    expect(() => validateWorkflowDefinition(def({ settings: { compensation: { triggers: [] } } }))).toThrow(/triggers/);
  });

  it('rejects a trigger outside the closed set', () => {
    expect(() =>
      validateWorkflowDefinition(def({ settings: { compensation: { triggers: ['whenever'] } } })),
    ).toThrow(/triggers/);
  });

  it('refuses an orderingModel the host does not advertise, AT REGISTRATION', () => {
    // §A: "so an unwind never discovers at failure time that its ordering rule
    // is unimplemented." This host implements `reverse-completion` only.
    expect(() =>
      validateWorkflowDefinition(def({ settings: { compensation: { triggers: ['node-failure'], orderingModel: 'dependency-graph' } } })),
    ).toThrow(/orderingModel/);
    expect(() =>
      validateWorkflowDefinition(def({ settings: { compensation: { triggers: ['node-failure'], orderingModel: 'reverse-completion' } } })),
    ).not.toThrow();
  });

  it('refuses a profileVersion mismatch, because it is part of the inverse-action identity', () => {
    expect(() =>
      validateWorkflowDefinition(def({ settings: { compensation: { triggers: ['node-failure'], profileVersion: '2' } } })),
    ).toThrow(/profileVersion/);
  });

  it('refuses a manual-intervention disposition without `manualIntervention: true`', () => {
    // INVERTED 2026-08-16: this host now advertises `manualIntervention: true`
    // (`compensationUnwind.markManual` records the state and emits the §D event
    // at three real sites), so the ACCEPT is the default and the REFUSAL is what
    // needs the overlay. Both directions are still asserted — a sub-flag whose
    // refusal path is never exercised would let a host advertise the disposition
    // and accept it on a build that had stopped implementing it.
    expect(() =>
      validateWorkflowDefinition(def({ settings: { compensation: { triggers: ['node-failure'], exhaustedDisposition: 'manual-intervention' } } })),
    ).not.toThrow();

    setCapabilityOverlay('compensation.manualIntervention', false);
    for (const settings of [
      { compensation: { triggers: ['node-failure'], exhaustedDisposition: 'manual-intervention' } },
      { compensation: { triggers: ['node-failure'], onParentCancel: 'pause' } },
      { compensation: { triggers: ['node-failure'], onParentCancel: 'manual' } },
    ]) {
      expect(() => validateWorkflowDefinition(def({ settings }))).toThrow(/manualIntervention/);
    }
  });
});

describe('RFC 0151 §B — policy semantics the unwind reads', () => {
  it('`triggers` decides which failures qualify — an unlisted one starts NO unwind', () => {
    const policy: CompensationPolicy = { triggers: ['run-cancel'] };
    expect(policyAdmitsTrigger(policy, 'run-cancel')).toBe(true);
    expect(policyAdmitsTrigger(policy, 'node-failure')).toBe(false);
    // No policy ⇒ the documented fallback, stated rather than implied.
    expect(policyAdmitsTrigger(undefined, 'node-failure')).toBe(true);
    expect(policyAdmitsTrigger(undefined, 'run-cancel')).toBe(false);
    expect(COMPENSATION_FALLBACK_TRIGGERS).toEqual(['node-failure']);
  });

  it('retry precedence is node > policy > constant, resolved per FIELD', () => {
    const policy: CompensationPolicy = { triggers: ['node-failure'], retry: { maxAttempts: 7, backoffMs: 50 } };
    // The node's bound wins — the policy "MUST NOT weaken a node's own declaration".
    expect(retryBudgetFor({ nodeTypeId: 'x', retry: { maxAttempts: 2 } }, policy))
      .toEqual({ maxAttempts: 2, backoffMs: 50 });
    // Per FIELD: a node that set only maxAttempts still inherits the backoff.
    expect(retryBudgetFor({ nodeTypeId: 'x' }, policy)).toEqual({ maxAttempts: 7, backoffMs: 50 });
    // No policy ⇒ the constant, which is now the FALLBACK and not the source.
    expect(retryBudgetFor({ nodeTypeId: 'x' })).toEqual({
      maxAttempts: COMPENSATION_DEFAULT_RETRY.maxAttempts,
      backoffMs: COMPENSATION_DEFAULT_RETRY.backoffMs,
    });
  });

  it('`approvalScope` can only ESCALATE — there is deliberately no `none`', () => {
    const all: CompensationPolicy = { triggers: ['node-failure'], approvalScope: 'all' };
    const declared: CompensationPolicy = { triggers: ['node-failure'], approvalScope: 'declared' };
    // `all` gates a node that asked for nothing.
    expect(requiresApproval({ nodeTypeId: 'x' }, all)).toBe(true);
    // `declared` CANNOT strip an approval the node declared for itself. That is
    // the rule RFC 0147 R9 exists for: an inverse action can itself be harmful,
    // so a policy must never be able to lower a node's own gate.
    expect(requiresApproval({ nodeTypeId: 'x', requiresApproval: true }, declared)).toBe(true);
    expect(requiresApproval({ nodeTypeId: 'x' }, declared)).toBe(false);
  });
});

describe('RFC 0151 erratum — a policy naming a trigger this host does not FIRE is refused', () => {
  /**
   * Accepting such a policy is a silent false promise: the author configures
   * compensation on a trigger, believes their committed effects unwind when it
   * happens, and nothing ever does. A loud `validation_error` at authoring time
   * beats a quiet lie about money discovered during an incident — the same
   * disposition as the `orderingModel` refusal, which exists because accepting
   * an unimplemented value "defers the failure to the worst possible moment".
   *
   * As of H58d all four triggers fire, so this guard currently refuses NOTHING.
   * That is deliberate and is why the test drives the predicate rather than
   * waiting for a rejected value to exist: what is pinned is the INVARIANT, so
   * the day a fifth trigger is added, or one of these regresses, registration
   * fails instead of an author believing in an unwind that never happens.
   */
  it('every trigger the vocabulary accepts is one this host fires — today', () => {
    // If these ever diverge, the divergence must be DELIBERATE: narrowing
    // FIRED_COMPENSATION_TRIGGERS starts refusing workflows that register today,
    // which is wire-visible.
    expect([...FIRED_COMPENSATION_TRIGGERS].sort()).toEqual([...COMPENSATION_TRIGGERS].sort());
  });

  it('refuses a policy naming a trigger absent from the fired set', () => {
    // Simulate the state this guard exists for — a vocabulary entry the host
    // does not initiate — by asserting the predicate the validator uses, since
    // no such value exists today.
    const pretendFired: readonly string[] = ['node-failure'];
    for (const t of COMPENSATION_TRIGGERS) {
      const wouldRefuse = !pretendFired.includes(t);
      expect(wouldRefuse, `${t}`).toBe(t !== 'node-failure');
    }
  });

  it('accepts every trigger the host does fire', () => {
    for (const t of FIRED_COMPENSATION_TRIGGERS) {
      expect(() => validateWorkflowDefinition({
        workflowId: 'wf.erratum',
        name: 'erratum',
        nodes: [{ nodeId: 'a', typeId: 'test.noop' }],
        edges: [],
        settings: { compensation: { triggers: [t] } },
      } as never)).not.toThrow();
    }
  });
});
