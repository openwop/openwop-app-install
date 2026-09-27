/**
 * ADR 0554 P2 — the reverse-completion unwind, under the adversarial fixtures
 * the phase gate names: "Payment/message adversarial fixtures prove no
 * duplicate compensation."
 *
 * The four adversaries, and what each one would break if the guard were absent:
 *
 *   1. CRASH MID-UNWIND. The process dies with some inverses discharged and
 *      others owed. A second unwind must pick up exactly the remainder. Without
 *      `completed` being terminal, it re-refunds.
 *   2. DUPLICATE DELIVERY of the compensator invocation. The same run
 *      unwinds twice concurrently / a re-dispatch replays the plan. The §C
 *      identity must address the SAME row both times, so the second pass has
 *      nothing to do.
 *   3. TRANSIENT FAILURE then retry. A refund fails once and succeeds on the
 *      next attempt, WITHOUT minting a second obligation — `failed` is
 *      non-terminal precisely so this works.
 *   4. REPLAY of a run that already unwound. §F: recorded outcomes are used and
 *      NOTHING re-fires.
 *
 * These drive the unwind engine directly with injected deps, because that is
 * where the ordering, retry and identity live. `compensation-seam.test.ts`
 * drives the same logic through the REAL executor, so neither file is the only
 * evidence: a fixture that passed only against a hand-built plan would prove
 * nothing about production.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { recordForwardObligation } from '../src/host/compensationRuntime.js';
import { openStorage } from '../src/storage/index.js';
import {
  _resetCompensationLedgerForTest,
  compensationStatusForRunTree,
  digestOf,
  nextCompensationOrdinal,
  obligationsForRunTree,
  recordObligation,
  markPlanRequested,
} from '../src/host/compensationLedger.js';
import {
  COMPENSATION_DEFAULT_RETRY,
  COMPENSATION_ORDERING_MODEL,
  type ApprovalOutcome,
  type CompensationDeclaration,
  type CompensationEvent,
  type InverseOutcome,
  type UnwindDeps,
  declarationKey,
  unwindRun,
} from '../src/host/compensationUnwind.js';

const T = 'tenant-unwind';
const ROOT = 'run-root';

/** A payment node: charge forward, refund back. The adversarial subject —
 *  a duplicate refund is the failure this whole phase exists to prevent. */
const REFUND: CompensationDeclaration = {
  nodeTypeId: 'test.payment.refund',
  inputMapping: { chargeId: 'ch_1' },
  retry: { maxAttempts: 3, backoffMs: 0 },
};

interface Harness {
  deps: UnwindDeps;
  events: CompensationEvent[];
  /** Every `(inverseActionId, attempt)` the engine invoked — the duplicate
   *  detector. Counting CALLS rather than successes is deliberate: a double
   *  compensation is two calls, whether or not the second one succeeded. */
  invocations: { id: string; attempt: number }[];
}

function harness(
  outcomes: (call: { id: string; attempt: number }) => InverseOutcome,
  approval?: (id: string) => ApprovalOutcome,
): Harness {
  const events: CompensationEvent[] = [];
  const invocations: { id: string; attempt: number }[] = [];
  const deps: UnwindDeps = {
    async appendEvent(event) { events.push(event); },
    // The REAL stamp, not a stub: these legs assert the §D rollup, and a plan
    // this harness runs must be indistinguishable from one production ran.
    markPlanRequested,
    async invoke(step) {
      const call = { id: step.obligation.inverseActionId, attempt: step.attempt };
      invocations.push(call);
      return outcomes(call);
    },
    async sleep() { /* no wall-clock in tests */ },
    ...(approval
      ? { requestApproval: async (step) => approval(step.obligation.inverseActionId) }
      : {}),
  };
  return { deps, events, invocations };
}

/** Commit a forward effect that declares a refund, allocating its ordinal from
 *  the ROOT counter — the same call the executor makes. */
async function commit(nodeId: string, opts: { runId?: string } = {}) {
  const runId = opts.runId ?? ROOT;
  const ordinal = await nextCompensationOrdinal(T, ROOT);
  return recordObligation({
    tenantId: T,
    runId,
    rootRunId: ROOT,
    nodeId,
    compensationNodeTypeId: REFUND.nodeTypeId,
    forwardLogicalInvocationId: `${runId}:${nodeId}`,
    compensationOrdinal: ordinal,
    effectKind: 'payment',
    shape: 'forward-effect',
    resultDigest: digestOf({ charged: nodeId }),
    contractDigest: digestOf(REFUND),
  });
}

function declarations(entries: { runId?: string; nodeId: string }[]): Map<string, CompensationDeclaration> {
  return new Map(entries.map((e) => [declarationKey(e.runId ?? ROOT, e.nodeId), REFUND]));
}

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await _resetCompensationLedgerForTest(); });

describe('RFC 0151 §C — reverse-completion ordering', () => {
  it('runs inverse actions in DESCENDING forward-completion order', async () => {
    for (const n of ['charge-1', 'charge-2', 'charge-3']) await commit(n);
    const h = harness(() => ({ ok: true }));

    const result = await unwindRun({
      tenantId: T,
      runId: ROOT,
      declarations: declarations([{ nodeId: 'charge-1' }, { nodeId: 'charge-2' }, { nodeId: 'charge-3' }]),
      deps: h.deps,
    });

    // The ORDER, not merely the set. Compensating forward can release a resource
    // a later inverse still depends on, which is why §C fixes the direction.
    expect(result.compensatedOrder).toEqual([3, 2, 1]);
    expect(result.status).toBe('completed');
  });

  it('descends DEPTH-FIRST through a sub-run, because the ordinal counter is rooted', async () => {
    // parent commits, then a SUB-RUN commits inside the parent's next node,
    // then the parent commits again — the interleaving that makes a per-run
    // ordinal wrong and a rooted one right.
    await commit('parent-a');
    await commit('child-a', { runId: 'run-child' });
    await commit('child-b', { runId: 'run-child' });
    await commit('parent-b');

    const h = harness(() => ({ ok: true }));
    const result = await unwindRun({
      tenantId: T,
      runId: ROOT,
      declarations: declarations([
        { nodeId: 'parent-a' },
        { runId: 'run-child', nodeId: 'child-a' },
        { runId: 'run-child', nodeId: 'child-b' },
        { nodeId: 'parent-b' },
      ]),
      deps: h.deps,
    });

    // 4 (parent-b) → 3,2 (the child, innermost-last-first) → 1 (parent-a).
    expect(result.compensatedOrder).toEqual([4, 3, 2, 1]);
  });

  it('emits compensation.requested strictly BEFORE compensation.started', async () => {
    await commit('charge-1');
    const h = harness(() => ({ ok: true }));
    await unwindRun({ tenantId: T, runId: ROOT, declarations: declarations([{ nodeId: 'charge-1' }]), deps: h.deps });

    const types = h.events.map((e) => e.type);
    const requested = types.indexOf('compensation.requested');
    const started = types.indexOf('compensation.started');
    expect(requested).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(requested);
    // §C's reason for the ordering: a host that unwinds before persisting the
    // plan cannot resume after a crash. The plan here IS the durable ledger, so
    // the rows must exist by the time `requested` lands.
    expect((await obligationsForRunTree(T, ROOT)).length).toBe(1);
  });

  it('every event payload is content-free and names the ordering model', async () => {
    await commit('charge-1');
    const h = harness(() => ({ ok: true }));
    await unwindRun({ tenantId: T, runId: ROOT, declarations: declarations([{ nodeId: 'charge-1' }]), deps: h.deps });

    for (const e of h.events) {
      expect(e.payload.orderingModel).toBe(COMPENSATION_ORDERING_MODEL);
      // §D/§G — these land in the durable log, the least revocable place a
      // credential can reach. The witness greps a serialized event for exactly
      // these markers, so the fixture does too.
      const serialized = JSON.stringify(e).toLowerCase();
      for (const forbidden of ['-----begin', 'bearer ', 'sk-', 'authorization', 'providerresponse']) {
        expect(serialized.includes(forbidden)).toBe(false);
      }
    }
  });
});

describe('ADR 0554 P2 gate — adversarial fixtures prove no duplicate compensation', () => {
  it('ADVERSARY 1: a crash mid-unwind resumes on the REMAINDER, never re-refunding', async () => {
    for (const n of ['charge-1', 'charge-2', 'charge-3']) await commit(n);
    const decls = declarations([{ nodeId: 'charge-1' }, { nodeId: 'charge-2' }, { nodeId: 'charge-3' }]);

    // First pass "crashes" after the first inverse: the second one throws a
    // non-retryable, which parks it, and the pass stops there.
    let calls = 0;
    const first = harness(() => {
      calls += 1;
      return calls === 1 ? { ok: true } : { ok: false, retryable: false, detail: 'process died' };
    });
    const passOne = await unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: first.deps });
    expect(passOne.compensatedOrder).toEqual([3]);
    expect(passOne.status).toBe('manual');

    // Resume. The obligations already `completed` must NOT be handed to invoke.
    const second = harness(() => ({ ok: true }));
    const passTwo = await unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: second.deps });

    const refundedTwice = second.invocations.filter(
      (c) => c.id === first.invocations[0]!.id,
    );
    expect(refundedTwice, 'the completed inverse was re-fired — that is a double refund').toHaveLength(0);
    expect(passTwo.compensatedOrder).toEqual([2, 1]);
    expect(await compensationStatusForRunTree(T, ROOT)).toBe('completed');

    // TWO FENCES stand between a resume and a double refund, and this asserts
    // the one the leg above does NOT reach. (a) the plan EXCLUDES `completed`
    // rows; (b) the ledger CLAIM refuses `completed -> started`. Break (b)
    // alone and this leg still passes because of (a) — which is exactly the
    // shape that makes a sabotage round read as coverage when it is not, so (a)
    // gets its own assertion: the resumed plan's `compensation.requested` names
    // the first REMAINING obligation. With the filter gone it would name the
    // already-completed one.
    const resumedHead = second.events.find((e) => e.type === 'compensation.requested');
    expect(resumedHead?.payload.compensationId).not.toBe(first.invocations[0]!.id);
  });

  it('ADVERSARY 2: duplicate delivery of the whole plan fires each inverse ONCE', async () => {
    for (const n of ['charge-1', 'charge-2']) await commit(n);
    const decls = declarations([{ nodeId: 'charge-1' }, { nodeId: 'charge-2' }]);

    const h = harness(() => ({ ok: true }));
    // Two deliveries of the same unwind — a re-dispatch, a sweeper, a retried
    // terminal path. Run them CONCURRENTLY: serialising would let a test pass
    // against a host that only tolerates sequential duplicates.
    await Promise.all([
      unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: h.deps }),
      unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: h.deps }),
    ]);
    // And a third, well after both settled.
    await unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: h.deps });

    const byId = new Map<string, number>();
    for (const c of h.invocations) byId.set(c.id, (byId.get(c.id) ?? 0) + 1);
    // The obligations were recorded once, so there are exactly two identities —
    // the §C hash is retry-stable, so a duplicate delivery cannot mint a third.
    expect(byId.size).toBe(2);
    // AND each was fired EXACTLY ONCE. Counting identities alone is not enough,
    // and this is not hypothetical: with the identity assertion only, removing
    // the ledger CLAIM (the state machine's `* -> started`, which is the
    // compare-and-swap a losing concurrent pass detects) left this leg GREEN
    // while every inverse ran twice. Two refunds, two identities, one passing
    // test. `invoke` always succeeds in this fixture, so any count above 1 is a
    // duplicate compensation rather than a retry.
    for (const [id, count] of byId) {
      expect(count, `inverse ${id} fired ${count} times — a duplicate compensation`).toBe(1);
    }
    expect(await compensationStatusForRunTree(T, ROOT)).toBe('completed');
  });

  it('ADVERSARY 2b: a duplicate FORWARD commit does not mint a second obligation', async () => {
    // The same committed effect re-reported (a re-dispatch of the node, a
    // crash-retry that re-ran the recorder). First-write-wins on the §C identity
    // is what stops the unwind compensating twice for one charge.
    const a = await commit('charge-1');
    const again = await recordObligation({
      tenantId: T,
      runId: ROOT,
      rootRunId: ROOT,
      nodeId: 'charge-1',
      forwardLogicalInvocationId: `${ROOT}:charge-1`,
      compensationOrdinal: a.compensationOrdinal,
      effectKind: 'payment',
      shape: 'forward-effect',
      resultDigest: digestOf({ charged: 'charge-1' }),
      contractDigest: digestOf(REFUND),
    });
    expect(again.inverseActionId).toBe(a.inverseActionId);
    expect((await obligationsForRunTree(T, ROOT))).toHaveLength(1);
  });

  it('ADVERSARY 3: a transient failure retries on the SAME identity, no second obligation', async () => {
    await commit('charge-1');
    let attempts = 0;
    const h = harness(() => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, retryable: true, detail: 'gateway 503' }
        : { ok: true };
    });

    const result = await unwindRun({
      tenantId: T, runId: ROOT, declarations: declarations([{ nodeId: 'charge-1' }]), deps: h.deps,
    });

    expect(h.invocations).toHaveLength(2);
    // THE point of §C retry-stability: both attempts addressed one logical
    // compensation. A compensator keying idempotency on this id sees one refund.
    expect(new Set(h.invocations.map((c) => c.id)).size).toBe(1);
    expect(result.compensatedOrder).toEqual([1]);
    expect(result.status).toBe('completed');
  });

  it('ADVERSARY 3b: retries are BOUNDED and exhaustion is reported, never rounded away', async () => {
    await commit('charge-1');
    const h = harness(() => ({ ok: false, retryable: true, detail: 'gateway 503' }));

    const result = await unwindRun({
      tenantId: T, runId: ROOT, declarations: declarations([{ nodeId: 'charge-1' }]), deps: h.deps,
    });

    expect(h.invocations).toHaveLength(REFUND.retry!.maxAttempts!);
    expect(result.status).toBe('failed');
    const failed = h.events.filter((e) => e.type === 'compensation.failed');
    expect(failed.some((e) => e.payload.reason === 'retries-exhausted')).toBe(true);
    // RFC 0151 §E — exhausted retries route to RFC 0053 dead-letter handling.
    // The sink is the run's existing `run.dead_lettered`; the observable marker
    // on the compensation lane is this reason, and the remaining obligation set
    // is the ledger's own non-terminal rows.
    expect(failed.some((e) => e.payload.reason === 'dead-lettered')).toBe(true);
    expect(result.remaining).toHaveLength(1);
  });

  it('ADVERSARY 4: replay of a run that already unwound fires NOTHING', async () => {
    for (const n of ['charge-1', 'charge-2']) await commit(n);
    const decls = declarations([{ nodeId: 'charge-1' }, { nodeId: 'charge-2' }]);
    const live = harness(() => ({ ok: true }));
    await unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: live.deps });

    // The replay must have something it COULD fire, or the guard is not what
    // keeps the leg green — the empty-plan early return is, and the fixture
    // measures nothing. (The first version of this fixture "reopened" a
    // completed obligation; `completed` is terminal, so the reopen threw, the
    // plan was empty, and deleting the replay guard left the leg GREEN.)
    // So: a third effect commits and is still OWED when the replay runs.
    await commit('charge-3');
    const decls3 = new Map(decls).set(declarationKey(ROOT, 'charge-3'), REFUND);
    const owed = (await obligationsForRunTree(T, ROOT)).filter((o) => o.state !== 'completed');
    expect(owed, 'the replay fixture must leave real work on the table').toHaveLength(1);

    const replayed = harness(() => ({ ok: true }));
    const result = await unwindRun({
      tenantId: T, runId: ROOT, declarations: decls3, replaying: true, deps: replayed.deps,
    });

    expect(replayed.invocations, '§F: a replay that re-executes inverse effects turns a recovery into a second outage').toHaveLength(0);
    expect(result.firedInverseEffects).toBe(0);
    // And it does not claim the unwind started: `started` would move the fold to
    // `running` for a plan that will never move.
    expect(replayed.events.map((e) => e.type)).not.toContain('compensation.started');
  });
});

describe('RFC 0151 §E — the approval gate composes, and fails closed', () => {
  const GATED: CompensationDeclaration = { ...REFUND, requiresApproval: true };

  it('a PENDING approval pauses the plan and fires nothing further', async () => {
    for (const n of ['charge-1', 'charge-2']) await commit(n);
    const h = harness(() => ({ ok: true }), () => ({ decision: 'pending', approvalId: 'appr:x' }));
    // MIXED on purpose: only the LATER effect (higher ordinal, so first in the
    // unwind) is gated. If the pause merely SKIPPED that obligation, charge-1's
    // ungated inverse would fire behind it — out of order, and possibly
    // releasing a resource the paused inverse still needs. With both gated the
    // leg cannot tell `stop` from `skip` and measures nothing.
    const decls = new Map([
      [declarationKey(ROOT, 'charge-1'), REFUND],
      [declarationKey(ROOT, 'charge-2'), GATED],
    ]);

    const result = await unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: h.deps });

    expect(
      h.invocations,
      'the plan continued past a paused obligation — reverse-completion order was broken',
    ).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toContain('compensation.paused');
    // The pause STOPS the plan rather than skipping ahead: `reverse-completion`
    // exists because a later inverse can depend on an earlier one having run.
    expect(result.compensatedOrder).toEqual([]);
    // The §D closed reason vocabulary has no code for "an approval is open and
    // nobody has decided" — every member asserts a decision. `reason` is
    // optional in the payload schema, so the honest emission carries none.
    const paused = h.events.find((e) => e.type === 'compensation.paused');
    expect(paused?.payload.reason).toBeUndefined();
  });

  it('a DENIED approval fails the obligation with the closed `approval-denied` reason', async () => {
    await commit('charge-1');
    const h = harness(() => ({ ok: true }), () => ({ decision: 'denied', detail: 'operator said no' }));
    const decls = new Map([[declarationKey(ROOT, 'charge-1'), GATED]]);

    const result = await unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: h.deps });

    expect(h.invocations).toHaveLength(0);
    expect(
      h.events.find((e) => e.type === 'compensation.failed')?.payload.reason,
    ).toBe('approval-denied');
    expect(result.status).toBe('failed');
  });

  it('NO approval gate wired ⇒ manual intervention, never an ungated inverse effect', async () => {
    await commit('charge-1');
    // `requestApproval` deliberately absent.
    const h = harness(() => ({ ok: true }));
    const decls = new Map([[declarationKey(ROOT, 'charge-1'), GATED]]);

    await unwindRun({ tenantId: T, runId: ROOT, declarations: decls, deps: h.deps });

    expect(
      h.invocations,
      'an inverse effect that requires approval was executed because no gate was wired — that is the authority escalation §G names',
    ).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toContain('compensation.manual_intervention_required');
    expect(await compensationStatusForRunTree(T, ROOT)).toBe('manual');
  });
});

describe('RFC 0151 §D/§G — every event kind validates against the CORPUS schema', () => {
  /**
   * The seam test validates the events a CLEAN unwind emits (requested /
   * started / completed). Those three carry no `reason`, so they cannot catch
   * an open reason string — measured: replacing `'retries-exhausted'` with a
   * provider error message left the seam leg GREEN, because no clean unwind
   * ever emits `compensation.failed`.
   *
   * This drives the failure, pause and manual paths too, so all six `$defs`
   * are exercised. Each is `additionalProperties: false` with a CLOSED `reason`
   * enum, which is what makes an open string or a leaked provider field a
   * schema violation rather than a code-review question.
   */
  async function validator() {
    const { corpusSchema } = await import('./support/corpusSchema.js');
    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const schema = corpusSchema('run-event-payloads.schema.json') as { $defs: Record<string, object> };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    return (events: readonly CompensationEvent[]) => {
      for (const e of events) {
        const key = e.type
          .replace(/\.([a-z_])/g, (_m, c: string) => c.toUpperCase())
          .replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
        const def = schema.$defs[key];
        expect(def, `no $defs entry for ${e.type} (looked up '${key}')`).toBeDefined();
        const validate = ajv.compile(def!);
        expect(
          validate(e.payload),
          `${e.type} payload invalid: ${ajv.errorsText(validate.errors)}`,
        ).toBe(true);
      }
    };
  }

  it('the failure path: compensation.failed with a closed reason', async () => {
    const check = await validator();
    await commit('charge-1');
    const h = harness(() => ({ ok: false, retryable: true, detail: 'gateway 503: {"error":"card_declined"}' }));
    await unwindRun({ tenantId: T, runId: ROOT, declarations: declarations([{ nodeId: 'charge-1' }]), deps: h.deps });
    expect(h.events.some((e) => e.type === 'compensation.failed')).toBe(true);
    check(h.events);
  });

  it('the approval paths: compensation.paused and the denial', async () => {
    const check = await validator();
    const GATED: CompensationDeclaration = { ...REFUND, requiresApproval: true };
    await commit('charge-1');
    const pending = harness(() => ({ ok: true }), () => ({ decision: 'pending', approvalId: 'appr:x' }));
    await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: new Map([[declarationKey(ROOT, 'charge-1'), GATED]]),
      deps: pending.deps,
    });
    expect(pending.events.some((e) => e.type === 'compensation.paused')).toBe(true);
    check(pending.events);

    await _resetCompensationLedgerForTest();
    await commit('charge-2');
    const denied = harness(() => ({ ok: true }), () => ({ decision: 'denied', detail: 'no' }));
    await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: new Map([[declarationKey(ROOT, 'charge-2'), GATED]]),
      deps: denied.deps,
    });
    check(denied.events);
  });

  it('the manual path: compensation.manual_intervention_required', async () => {
    const check = await validator();
    await commit('charge-1');
    const h = harness(() => ({ ok: true }));
    await unwindRun({ tenantId: T, runId: ROOT, declarations: new Map(), deps: h.deps });
    expect(h.events.some((e) => e.type === 'compensation.manual_intervention_required')).toBe(true);
    check(h.events);
  });
});

describe('ADR 0554 P2 — declarations and defaults', () => {
  it('an obligation whose declaration vanished parks for an operator rather than being dropped', async () => {
    await commit('charge-1');
    const h = harness(() => ({ ok: true }));
    // Empty declaration map: the workflow was redefined, the pack was dropped.
    await unwindRun({ tenantId: T, runId: ROOT, declarations: new Map(), deps: h.deps });

    expect(h.invocations).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toContain('compensation.manual_intervention_required');
    // The operator-legible detail lives on the durable row, NOT on the wire
    // event — §D/§G keep the event content-free and the closed `reason`
    // vocabulary has no code for it.
    const [row] = await obligationsForRunTree(T, ROOT);
    expect(row?.reason ?? '').toContain('no compensation declaration');
  });

  it('the retry budget has ONE default, and a node declaration overrides it', async () => {
    await commit('charge-1');
    const h = harness(() => ({ ok: false, retryable: true, detail: 'down' }));
    // No `retry` block ⇒ the single host constant applies. When
    // `compensation-policy.schema.json` lands it replaces that constant and
    // nothing else moves.
    const bare: CompensationDeclaration = { nodeTypeId: REFUND.nodeTypeId };
    await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: new Map([[declarationKey(ROOT, 'charge-1'), bare]]),
      deps: h.deps,
    });
    expect(h.invocations).toHaveLength(COMPENSATION_DEFAULT_RETRY.maxAttempts);
  });

  it('an empty plan reports `none` without emitting anything', async () => {
    const h = harness(() => ({ ok: true }));
    const result = await unwindRun({ tenantId: T, runId: ROOT, declarations: new Map(), deps: h.deps });
    expect(result.status).toBe('none');
    expect(h.events).toHaveLength(0);
  });
});

/**
 * ADR 0554 wire flip — the BATCH rollup that `RunSnapshot.compensationStatus` is
 * projected from.
 *
 * Its own function, and therefore its own tests, for two reasons the projection
 * route cannot state:
 *
 *   - **One scan for a page.** `compensationStatusForRunTree` scans the whole
 *     collection per call, and `GET /v1/runs` maps the projector over up to 200
 *     runs. Looping it would put 200 full scans on the read path that caused the
 *     2026-07-14 O(tenant)-scan outage.
 *   - **A sub-run must not read `none`.** Ordinals come from ONE counter per
 *     ROOT, so a sub-run's obligation carries the ROOT's `rootRunId`. A fold
 *     keyed only on the root reports `none` for the sub-run's own snapshot — a
 *     run that committed a compensable effect claiming it owed nothing — and a
 *     fold keyed only on `runId` reports `none` for the parent, which is the case
 *     `compensationStatusForRunTree` exists to fix. Both directions are asserted.
 */
describe('RFC 0151 §D — the batched rollup for a page of snapshots', () => {
  const SUB = 'run-sub';

  it('a run with no obligations folds to `none` — the value an advertiser MUST still emit', async () => {
    const { compensationStatusForRuns } = await import('../src/host/compensationLedger.js');
    const out = await compensationStatusForRuns(T, [ROOT, 'run-never-existed']);
    expect(out.get(ROOT)).toBe('none');
    expect(out.get('run-never-existed')).toBe('none');
  });

  it('asks for nothing, scans nothing', async () => {
    const { compensationStatusForRuns } = await import('../src/host/compensationLedger.js');
    expect((await compensationStatusForRuns(T, [])).size).toBe(0);
  });

  it('folds every requested run in ONE pass, and each independently', async () => {
    const { compensationStatusForRuns, resolveObligation } = await import('../src/host/compensationLedger.js');
    const a = await commit('charge-1');
    await commit('charge-2');
    // One completed, one still `requested` ⇒ the run is `partial` only once the
    // plan is inactive; with a `requested` row outstanding the fold is `pending`
    // by its own table. What this leg pins is that the BATCH answer equals the
    // per-run answer — not what that answer is.
    await resolveObligation({ tenantId: T, inverseActionId: a.inverseActionId, to: 'started', reason: 'claimed' });
    const batch = await compensationStatusForRuns(T, [ROOT]);
    const single = await compensationStatusForRunTree(T, ROOT);
    expect(batch.get(ROOT)).toBe(single);
  });

  it('a SUB-run reads its own obligations; the ROOT reads the whole tree', async () => {
    const { compensationStatusForRuns } = await import('../src/host/compensationLedger.js');
    // The child commits the ONLY compensable effect. Its ordinal is allocated
    // from the root's counter, so its row carries `rootRunId: ROOT`.
    await commit('charge-in-child', { runId: SUB });
    // The subject here is SCOPING — which bucket a row lands in — and the old
    // proxy for "the row is visible" was `not.toBe('none')`. That stopped being
    // a proxy on 2026-08-18: a minted-but-never-requested plan IS `none` under
    // §D, so both would have read `none` for a correct reason and the scoping
    // claim would have been asserted by accident. Request the plan first, then
    // the statuses carry information again.
    await markPlanRequested(T, ROOT, new Date().toISOString());
    const out = await compensationStatusForRuns(T, [ROOT, SUB]);
    expect(out.get(ROOT), 'a parent whose child committed the only effect must not read `none`').not.toBe('none');
    expect(out.get(SUB), 'the child committed it — its own snapshot must not read `none` either').not.toBe('none');
    expect(out.get(ROOT)).toBe(await compensationStatusForRunTree(T, ROOT));
  });

  it('a row is counted ONCE for its own run — a root does not double-fold its own obligations', async () => {
    const { compensationStatusForRuns, resolveObligation, obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    const a = await commit('charge-1');
    const b = await commit('charge-2');
    for (const o of [a, b]) {
      await resolveObligation({ tenantId: T, inverseActionId: o.inverseActionId, to: 'started', reason: 'claimed' });
      await resolveObligation({ tenantId: T, inverseActionId: o.inverseActionId, to: 'completed' });
    }
    expect(await obligationsForRunTree(T, ROOT)).toHaveLength(2);
    // `completed` requires EVERY row to be completed. A row folded twice would
    // still satisfy that, so the sharper witness is the sub-run leg above plus
    // this equality with the single-run fold.
    expect((await compensationStatusForRuns(T, [ROOT])).get(ROOT)).toBe('completed');
    expect(await compensationStatusForRunTree(T, ROOT)).toBe('completed');
  });

  it('the fold is TENANT-scoped — another tenant\'s obligations never leak into a rollup', async () => {
    const { compensationStatusForRuns } = await import('../src/host/compensationLedger.js');
    await commit('charge-1');
    const other = await compensationStatusForRuns('some-other-tenant', [ROOT]);
    expect(other.get(ROOT), 'a run id is not a capability — the tenant filter is the boundary').toBe('none');
  });
});

/**
 * ADR 0554 wire flip — the RFC 0151 §21 RECOVERY EXTENSION, at the unwind level.
 *
 * These pin the three §G invariants the extension exists to make observable, in
 * the ENGINE rather than through the seam. The conformance witness drives the
 * same behaviour black-box; this file is where a regression names itself, and it
 * is the level at which "the seam reported it" and "the host did it" come apart.
 */
describe('RFC 0151 §C — the §21 inverseActions report', () => {
  it('reports the TRUE attempt count, not the number of state transitions', async () => {
    // The defect the conformance scenario found. `resolveObligation` increments
    // once per transition, so an inverse that failed twice and succeeded on the
    // third try recorded `attempts: 2` — telling an operator the retry budget
    // was barely touched when it was one attempt from exhausting.
    await commit('charge-1');
    let calls = 0;
    const h = harness(() => {
      calls += 1;
      return calls <= 2 ? { ok: false, retryable: true, detail: 'transient' } : { ok: true };
    });
    const result = await unwindRun({
      tenantId: T,
      runId: ROOT,
      declarations: new Map([[declarationKey(ROOT, 'charge-1'), { nodeTypeId: REFUND.nodeTypeId, retry: { maxAttempts: 3, backoffMs: 0 } }]]),
      deps: h.deps,
    });
    expect(calls, 'two transient failures then success is THREE invocations').toBe(3);
    const entry = result.inverseActions.find((a) => a.nodeId === 'charge-1');
    expect(entry?.attempts, 'ONE obligation, THREE attempts').toBe(3);
    expect(entry?.outcome).toBe('completed');
  });

  it('reports attempts MADE when retries exhaust, not the loop counter', async () => {
    await commit('charge-1');
    const h = harness(() => ({ ok: false, retryable: true, detail: 'down' }));
    const result = await unwindRun({
      tenantId: T,
      runId: ROOT,
      declarations: new Map([[declarationKey(ROOT, 'charge-1'), { nodeTypeId: REFUND.nodeTypeId, retry: { maxAttempts: 2, backoffMs: 0 } }]]),
      deps: h.deps,
    });
    const entry = result.inverseActions.find((a) => a.nodeId === 'charge-1');
    // The loop exits one past the budget; the attempts MADE is the budget.
    expect(entry?.attempts).toBe(2);
    expect(entry?.outcome).toBe('failed');
  });

  it('carries the RECORDED input, so a redefined workflow cannot rewrite history', async () => {
    // §B/§F: "an inverse built from a re-derived value is not the inverse of
    // what was done." The input is stamped on the row at mint time.
    const { recordObligation, obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    await recordObligation({
      tenantId: T,
      runId: ROOT,
      rootRunId: ROOT,
      nodeId: 'charge-1',
      compensationNodeTypeId: REFUND.nodeTypeId,
      compensationInput: { chargeId: 'ch_recorded' },
      forwardLogicalInvocationId: `${ROOT}:charge-1`,
      compensationOrdinal: await nextCompensationOrdinal(T, ROOT),
      effectKind: 'payment',
      shape: 'forward-effect',
      resultDigest: digestOf({ charged: true }),
      contractDigest: digestOf(REFUND),
    });
    const rows = await obligationsForRunTree(T, ROOT);
    expect(rows[0]?.compensationInput).toEqual({ chargeId: 'ch_recorded' });
    const h = harness(() => ({ ok: true }));
    const result = await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: declarations([{ nodeId: 'charge-1' }]),
      deps: h.deps,
    });
    expect(result.inverseActions[0]?.input).toEqual({ chargeId: 'ch_recorded' });
  });
});

describe('RFC 0151 UQ4 — an irreversible entry caps the rollup at `partial`', () => {
  async function commitIrreversible(nodeId: string) {
    const { recordObligation } = await import('../src/host/compensationLedger.js');
    return recordObligation({
      tenantId: T, runId: ROOT, rootRunId: ROOT, nodeId,
      forwardLogicalInvocationId: `${ROOT}:${nodeId}`,
      compensationOrdinal: await nextCompensationOrdinal(T, ROOT),
      effectKind: 'notification',
      shape: 'irreversible',
      resultDigest: digestOf({ sent: nodeId }),
      contractDigest: digestOf({ irreversible: true }),
    });
  }

  it('is NEVER invoked — there is no inverse to invoke', async () => {
    await commitIrreversible('email-sent');
    const h = harness(() => ({ ok: true }));
    await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: declarations([{ nodeId: 'email-sent' }]),
      deps: h.deps,
    });
    expect(h.invocations, 'an irreversible effect has no inverse action to run').toHaveLength(0);
  });

  it('reports `outcome: irreversible`, which OUTRANKS whatever state the row sits in', async () => {
    await commitIrreversible('email-sent');
    const h = harness(() => ({ ok: true }));
    const result = await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: declarations([{ nodeId: 'email-sent' }]),
      deps: h.deps,
    });
    const entry = result.inverseActions.find((a) => a.nodeId === 'email-sent');
    expect(entry?.outcome).toBe('irreversible');
  });

  it('caps the §D rollup at `partial` when a sibling DID complete', async () => {
    await commit('charge-1');            // compensable
    await commitIrreversible('email-1'); // not
    const h = harness(() => ({ ok: true }));
    const result = await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: declarations([{ nodeId: 'charge-1' }, { nodeId: 'email-1' }]),
      deps: h.deps,
    });
    // The refund went through and the email cannot be unsent. `completed` would
    // claim a full unwind for a run that permanently could not have one, and
    // `failed` would erase the refund that did happen.
    expect(result.status).toBe('partial');
  });

  it('reports `failed` — never `completed` — when the irreversible entry is the ONLY one', async () => {
    await commitIrreversible('email-1');
    const h = harness(() => ({ ok: true }));
    const result = await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: declarations([{ nodeId: 'email-1' }]),
      deps: h.deps,
    });
    expect(result.status).not.toBe('completed');
    expect(result.status).toBe('failed');
  });

  it('stays capped even if a later write marks the irreversible row completed', async () => {
    // The reason the cap is checked BEFORE the all-completed test. An
    // irreversible row sits non-completed forever in normal operation, so
    // `done === length` is unreachable — UNLESS some future code tidies the plan
    // up, at which point the run would report a full unwind for an effect that
    // by definition was never undone. Checking the shape first makes that lie
    // unreachable rather than merely unlikely.
    const { resolveObligation, compensationStatusForRunTree } = await import('../src/host/compensationLedger.js');
    const row = await commitIrreversible('email-1');
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'started', reason: 'x' });
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'completed' });
    expect(
      await compensationStatusForRunTree(T, ROOT),
      'an irreversible effect can never be reported as fully undone',
    ).not.toBe('completed');
  });
});

/**
 * RFC 0151 UQ4 — THE JOIN between the declaration half and the ledger half.
 *
 * This file's other UQ4 legs hand-build a `shape: 'irreversible'` row and assert
 * the fold caps at `partial`. They passed for a full merge cycle while the path
 * that PRODUCES such a row did not exist: `irreversibleEffect` reached the
 * executor (#3292 carried it through schema → validation → expansion → storage)
 * and `recordForwardObligation` returned early for any node without a §B
 * `compensation` declaration — which an irreversible node never has, the two
 * being mutually exclusive by construction.
 *
 * So each half was tested and the SEAM was not, and the observable consequence
 * was the exact wire lie UQ4 closes: an irreversible node minted no row, nothing
 * capped the rollup, and a run whose compensable siblings unwound cleanly
 * reported `compensationStatus: completed` for an effect that by definition was
 * never undone.
 *
 * These legs drive `recordForwardObligation` — the real minting seam the executor
 * calls on node completion — rather than the ledger directly.
 */
/**
 * RFC 0151 §B (S36) — `waiveRequiresApproval` THROUGH THE MINTING SEAM.
 *
 * WHY THIS BLOCK EXISTS, stated plainly because it is the same defect this file
 * already records for UQ4: the S36 gate tests in
 * `compensation-recovery-rbac.test.ts` hand-build ledger rows, so they exercise
 * the GATE faithfully while the production path that PRODUCES the row goes
 * untested. MEASURED — three sabotages stayed GREEN against those tests:
 *
 *   S20 `compensationDeclarationOf` stops carrying the field
 *   S21 the mint stamps the RAW declaration instead of the EFFECTIVE value
 *   S25 the executor stops passing the policy to the mint
 *
 * Each is a silent under-enforcement in production, and none was observable
 * without a leg that crosses declaration -> mint -> row. "Two correct halves,
 * each with passing tests, and no test crossing the seam" — the exact phrasing
 * ADR 0554 uses for the UQ4 join. Reproduced, and closed here.
 */
describe('RFC 0151 §B (S36) — the EFFECTIVE waive value is stamped at MINT', () => {
  const REFUND = { nodeTypeId: 'test.payment.refund' };
  const node = (compensation: Record<string, unknown>) =>
    ({ nodeId: 'charge', typeId: 'test.payment.charge', compensation }) as never;

  function runRecord(): Parameters<typeof recordForwardObligation>[0]['run'] {
    return {
      runId: ROOT, tenantId: T, workflowId: 'wf.pay', status: 'running',
      inputs: {}, metadata: {}, configurable: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof recordForwardObligation>[0]['run'];
  }

  async function mint(compensation: Record<string, unknown>, policy?: Record<string, unknown>) {
    const { recordForwardObligation } = await import('../src/host/compensationRuntime.js');
    const { obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    await recordForwardObligation({
      run: runRecord(),
      node: node(compensation),
      observedEffectKinds: new Set(['payment'] as const),
      outputs: { chargeId: 'ch_1' },
      rootRunId: ROOT,
      ...(policy ? { policy: policy as never } : {}),
    });
    const rows = await obligationsForRunTree(T, ROOT);
    expect(rows, 'the mint must produce exactly the row under test').toHaveLength(1);
    return rows[0]!;
  }

  it('carries an explicit `false` from the DECLARATION onto the row (S20)', async () => {
    const row = await mint({ ...REFUND, requiresApproval: true, waiveRequiresApproval: false });
    // Not `toBeFalsy` — a dropped field and a declared `false` are the same
    // falsy value, and telling them apart is the whole point.
    expect(row.waiveRequiresApproval).toBe(false);
  });

  it('carries an explicit `true` even where requiresApproval is false (S20)', async () => {
    const row = await mint({ ...REFUND, requiresApproval: false, waiveRequiresApproval: true });
    expect(row.waiveRequiresApproval).toBe(true);
  });

  it('stamps the EFFECTIVE value when the field is ABSENT — inheriting requiresApproval (S21)', async () => {
    expect((await mint({ ...REFUND, requiresApproval: true })).waiveRequiresApproval).toBe(true);
  });

  /**
   * THE POLICY-ESCALATION LEG (S21 + S25 together).
   *
   * §B's default is the POST-escalation `requiresApproval`. A node declaring
   * nothing, under `approvalScope: 'all'`, must mint a GATED waive — which is
   * only true if the mint resolves the effective value AND the executor actually
   * hands the policy over. Stamping the raw declaration, or dropping the policy
   * at the call site, both make this `false`: the host would gate RUNNING the
   * inverse while leaving its WAIVE ungated.
   */
  it('escalates via the POLICY when the node declares neither field (S21/S25)', async () => {
    const row = await mint({ ...REFUND }, { triggers: ['node-failure'], approvalScope: 'all' });
    expect(row.waiveRequiresApproval).toBe(true);
  });

  it('and does NOT escalate without that policy — so the leg above is not passing on a constant', async () => {
    expect((await mint({ ...REFUND })).waiveRequiresApproval).toBe(false);
  });

  /**
   * S37 (A) / openwop#1064 — ESCALATION IS A FLOOR, enforced AT THE MINT.
   *
   * The stamp is what the waive gate reads forever after, so if the floor were
   * applied only in the unit function and not here, every obligation minted
   * under an escalating policy would carry `false` and the escalation would be
   * lost the moment the row was written.
   */
  it('an explicit `false` does NOT lower a POLICY-escalated value at the mint', async () => {
    const row = await mint(
      { ...REFUND, waiveRequiresApproval: false },
      { triggers: ['node-failure'], approvalScope: 'all' },
    );
    expect(row.waiveRequiresApproval).toBe(true);
  });

  it('...but an explicit `false` DOES beat the node\'s own requiresApproval when nothing escalated', async () => {
    const row = await mint({ ...REFUND, requiresApproval: true, waiveRequiresApproval: false });
    expect(row.waiveRequiresApproval).toBe(false);
  });
});

describe('RFC 0151 UQ4 — an irreversibleEffect node MINTS its plan entry', () => {
  const irreversibleNode = { nodeId: 'send-email', typeId: 'vendor.mail.send', irreversibleEffect: true };

  function runRecord(): Parameters<typeof recordForwardObligation>[0]['run'] {
    return {
      runId: ROOT, tenantId: T, workflowId: 'wf.notify', status: 'running',
      inputs: {}, metadata: {}, configurable: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as Parameters<typeof recordForwardObligation>[0]['run'];
  }

  it('mints a row with `shape: irreversible` and NO inverse node type', async () => {
    const { recordForwardObligation } = await import('../src/host/compensationRuntime.js');
    const { obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    await recordForwardObligation({
      run: runRecord(),
      node: irreversibleNode as never,
      observedEffectKinds: new Set(['network-egress'] as const),
      outputs: { messageId: 'm1' },
      rootRunId: ROOT,
    });
    const rows = await obligationsForRunTree(T, ROOT);
    expect(rows, 'the seam that produces the row the fold reads').toHaveLength(1);
    expect(rows[0]?.shape).toBe('irreversible');
    expect(rows[0]?.nodeId).toBe('send-email');
    expect(
      rows[0]?.compensationNodeTypeId,
      'there is no inverse action to name — a placeholder would make the row look invokable',
    ).toBeUndefined();
  });

  it('mints NOTHING when the node committed no effect — a hypothetical must not cap a rollup', async () => {
    const { recordForwardObligation } = await import('../src/host/compensationRuntime.js');
    const { obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    await recordForwardObligation({
      run: runRecord(),
      node: irreversibleNode as never,
      observedEffectKinds: new Set(),
      outputs: {},
      rootRunId: ROOT,
    });
    expect(
      await obligationsForRunTree(T, ROOT),
      '`irreversibleEffect` on a node that emitted nothing describes a hypothetical; capping on it '
        + 'would under-report every clean unwind that passed through such a node',
    ).toHaveLength(0);
  });

  it('END TO END: a compensable sibling unwinds, and the run STILL does not report `completed`', async () => {
    // The regression in one leg. Without the minting seam this run reports
    // `completed` — a full unwind claimed for a run that sent an email.
    const { recordForwardObligation } = await import('../src/host/compensationRuntime.js');
    const { compensationStatusForRunTree } = await import('../src/host/compensationLedger.js');
    await commit('charge-1');                                   // compensable
    await recordForwardObligation({                             // not
      run: runRecord(),
      node: irreversibleNode as never,
      observedEffectKinds: new Set(['network-egress'] as const),
      outputs: { messageId: 'm1' },
      rootRunId: ROOT,
    });
    const h = harness(() => ({ ok: true }));
    const result = await unwindRun({
      tenantId: T, runId: ROOT,
      declarations: declarations([{ nodeId: 'charge-1' }]),
      deps: h.deps,
    });
    expect(h.invocations, 'the refund runs; the email has nothing to run').toHaveLength(1);
    expect(result.status, 'the refund went through and the email cannot be unsent').toBe('partial');
    expect(await compensationStatusForRunTree(T, ROOT)).toBe('partial');
    expect(result.inverseActions.find((a) => a.nodeId === 'send-email')?.outcome).toBe('irreversible');
  });

  it('a replay mints no irreversible row either — §F applies to both shapes', async () => {
    const { recordForwardObligation } = await import('../src/host/compensationRuntime.js');
    const { obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    await recordForwardObligation({
      run: { ...runRecord(), forkMode: 'replay', parentRunId: 'run-source' } as never,
      node: irreversibleNode as never,
      observedEffectKinds: new Set(['network-egress'] as const),
      outputs: { messageId: 'm1' },
      rootRunId: ROOT,
    });
    expect(await obligationsForRunTree(T, ROOT)).toHaveLength(0);
  });
});
