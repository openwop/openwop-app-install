/**
 * ADR 0554 / S36 — the EXECUTOR hands the compensation POLICY to the mint.
 *
 * ── WHY THIS FILE EXISTS: A GREEN SABOTAGE, TWICE OVER ────────────────────
 *
 * S25 broke `executor.ts`'s one-line `policy: definition.settings?.compensation`
 * pass-through and EVERY compensation suite stayed green — including the ones
 * added specifically for `waiveRequiresApproval`. They call
 * `recordForwardObligation` directly and supply the policy themselves, so they
 * exercise the mint faithfully while the CALLER that must feed it goes untested.
 *
 * That is the third instance of one failure shape in this ADR: UQ4's
 * "two correct halves, each with passing tests, and no test crossing the seam",
 * then S20/S21, now this. A `settings.compensation.approvalScope: 'all'`
 * workflow whose obligations minted an UNGATED waive would be a host accepting a
 * policy and then not enforcing it — invisible until an operator waived
 * something a workspace had insisted needed two humans.
 *
 * So this test starts where a production run starts: `executeRun`, a real node
 * that commits a real guarded effect, a definition carrying the policy — and
 * asserts the STAMP on the row the executor minted. Nothing here supplies the
 * policy to the mint by hand; that is the entire point.
 */
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRun } from '../src/executor/executor.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { unwindTerminatedRun, resumeUnwindForOperator, setCompensationDefinitionResolver } from '../src/host/compensationRuntime.js';
import { compensationTriggerFor } from '../src/host/compensationUnwind.js';
import { resolveCompensationInput, UnresolvableCompensationInputError } from '../src/host/compensationRuntime.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { getEventLog, setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { assertEffectAllowed } from '../src/host/runEffectContext.js';
import {
  _resetCompensationLedgerForTest,
  obligationsForRunTree,
  compensationStatusForRunTree,
  markPlanRequested,
} from '../src/host/compensationLedger.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const T = 'tenant-exec-policy';
const FORWARD = 'test.compensation.policy.charge';
const INVERSE = 'test.compensation.policy.refund';
const SLOW_FORWARD = 'test.payment.charge.slow';
const HOLD = 'test.compensation.policy.hold';
let releaseHold: (() => void) | null = null;

let storage: Storage;

beforeAll(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setSuspendBackend(storage);
  ensureNodesRegistered();
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-cmp-policy-')) });
  initHostExtPersistence(storage);

  const registry = getNodeRegistry();
  // A REAL guarded effect. `recordForwardObligation` only mints when the node
  // actually committed something (`observedEffectKinds` non-empty), so a node
  // that merely returned success would produce no row and this file would pass
  // vacuously — the failure mode it is written against.
  registry.register({
    typeId: FORWARD,
    version: '1.0.0',
    sideEffecting: true,
    async execute(ctx) {
      assertEffectAllowed('payment', `policy-stamp forward ${ctx.nodeId}`);
      return { status: 'success', outputs: { chargeId: 'ch_1' } };
    },
  });
  registry.register({
    typeId: SLOW_FORWARD,
    version: '1.0.0',
    sideEffecting: true,
    async execute(ctx) {
      // Deliberately slower than the 1 ms duration cap the breach test sets, so
      // "the deadline has passed by the next check" is a certainty rather than a
      // race with the machine.
      await new Promise((r) => setTimeout(r, 25));
      assertEffectAllowed('payment', `slow forward ${ctx.nodeId}`);
      return { status: 'success', outputs: { chargeId: 'ch_slow' } };
    },
  });
  // RFC 0194 — holds the run IN FLIGHT after the compensable step committed,
  // so a cancel lands on a live run (not on a completed one with a forged
  // `status: 'running'` snapshot, which appended a second terminal event).
  registry.register({
    typeId: HOLD,
    version: '1.0.0',
    async execute() {
      await new Promise<void>((r) => { releaseHold = r; });
      return { status: 'success', outputs: {} };
    },
  });
  registry.register({
    typeId: INVERSE,
    version: '1.0.0',
    sideEffecting: true,
    async execute() {
      assertEffectAllowed('payment', 'policy-stamp inverse');
      return { status: 'success', outputs: { refunded: true } };
    },
  });
});

beforeEach(async () => { await _resetCompensationLedgerForTest(); });

let n = 0;
async function newRun(workflowId: string): Promise<RunRecord> {
  const run: RunRecord = {
    runId: `run_exec_policy_${n++}`,
    tenantId: T,
    workflowId,
    status: 'pending',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as RunRecord;
  await storage.insertRun(run);
  return run;
}

/**
 * A one-node workflow whose node declares a BARE §B block — no
 * `requiresApproval`, no `waiveRequiresApproval`. Everything the assertion turns
 * on therefore has to arrive from `settings.compensation`, which is what makes
 * this a test of the executor's pass-through rather than of the declaration.
 */
function def(workflowId: string, policy?: Record<string, unknown>): WorkflowDefinition {
  return {
    workflowId,
    name: 'policy stamp',
    nodes: [{
      nodeId: 'charge',
      typeId: FORWARD,
      compensation: { nodeTypeId: INVERSE },
    }],
    edges: [],
    ...(policy ? { settings: { compensation: policy } } : {}),
  } as unknown as WorkflowDefinition;
}

describe('S36 — the executor threads settings.compensation into the mint', () => {
  /**
   * THE LEG S25 EXISTS FOR. Drop the executor's `policy:` line and this goes
   * red: the row mints with `waiveRequiresApproval: false` for a workflow whose
   * workspace policy escalated EVERY approval.
   */
  it('an approvalScope:"all" policy reaches the ROW, gating its waive', async () => {
    const run = await newRun('wf.policy.escalated');
    const result = await executeRun(
      storage, run,
      def('wf.policy.escalated', { triggers: ['node-failure'], approvalScope: 'all' }),
    );
    expect(result.status, 'the forward node must COMMIT, or nothing is minted').toBe('completed');

    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows, 'the executor must mint exactly one obligation for the committed effect').toHaveLength(1);
    // `toBe(true)` — not `toBeTruthy`. A dropped policy yields `false`, and the
    // two must not be able to look alike.
    expect(
      rows[0]?.waiveRequiresApproval,
      'settings.compensation.approvalScope="all" escalates the WAIVE gate too (RFC 0151 §B); '
        + 'a `false` here means the executor never handed the policy to the mint',
    ).toBe(true);
  });

  /**
   * THE NON-VACUITY HALF. Identical run, no policy — the stamp must be `false`.
   * Without this, the leg above would pass just as happily against a mint that
   * hardcoded `true`, and the file would be asserting a constant.
   */
  it('...and WITHOUT that policy the same workflow mints an UNGATED waive', async () => {
    const run = await newRun('wf.policy.none');
    const result = await executeRun(storage, run, def('wf.policy.none'));
    expect(result.status).toBe('completed');

    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waiveRequiresApproval).toBe(false);
  });

  /**
   * A policy that does NOT escalate must not gate either — so the leg above is
   * discriminating on `approvalScope`, not merely on "a policy object exists".
   */
  it('a policy WITHOUT approvalScope:"all" does not gate the waive', async () => {
    const run = await newRun('wf.policy.plain');
    const result = await executeRun(
      storage, run, def('wf.policy.plain', { triggers: ['node-failure'] }),
    );
    expect(result.status).toBe('completed');

    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waiveRequiresApproval).toBe(false);
  });
});

describe('RFC 0151 §D — a healthy run does not advertise an unwind it will never start', () => {
  /**
   * The end-to-end form of the fold fix, at the level a client sees.
   *
   * Obligations are minted when a forward effect COMMITS, so a run that
   * executed a compensable node and then SUCCEEDED owns a full set of
   * `requested` rows and always will. The rollup folded that to `pending`,
   * so every such run reported an unwind "about to start" that would never
   * come — on the deployed origin, on an advertised capability, for the
   * ordinary success path.
   *
   * §D's table: `none` = "No `compensation.requested` has been recorded for
   * the run."
   */
  it('a COMPLETED run whose node declared a compensator reports `none`, not `pending`', async () => {
    const run = await newRun('wf.healthy.compensable');
    const result = await executeRun(
      storage, run,
      def('wf.healthy.compensable', { triggers: ['node-failure'] }),
    );
    expect(result.status, 'the forward node must COMMIT, or there is nothing to mint').toBe('completed');

    // The obligation exists — this is not "nothing was recorded".
    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('requested');

    // …and the run still says no compensation was ever requested, because none
    // was. Revert the `planRequestedAt` guard in `foldCompensationStatus` and
    // this reads `pending`.
    expect(await compensationStatusForRunTree(T, run.runId)).toBe('none');
  });
});

describe('RFC 0151 §C — the unwind invokes what was RECORDED, not what the definition says now', () => {
  /**
   * `compensation.md:212-215`: "a host MUST NOT rebuild the plan from the
   * workflow definition on resume". The plan's inverse action is a recorded
   * fact — the row's `compensationNodeTypeId` — and the definition is mutable
   * between the forward commit and the unwind.
   *
   * Before this leg the unwind resolved the node type from the CURRENT
   * definition (`collectDeclarations` at unwind time) and merely REPORTED the
   * recorded one in the §21 projection. So a workflow edited in between would
   * undo something other than what was recorded, while the report claimed
   * otherwise — the invariant and the behaviour describing different worlds.
   */
  it('a compensator swapped in the definition after the commit does NOT run; the recorded one does', async () => {
    const RECORDED = INVERSE;
    const SWAPPED = 'test.compensation.swapped-in-later';
    let swappedRan = false;
    getNodeRegistry().register({
      typeId: SWAPPED,
      version: '1.0.0',
      sideEffecting: true,
      async execute() {
        swappedRan = true;
        assertEffectAllowed('payment', 'swapped inverse');
        return { status: 'success', outputs: { refunded: 'by-the-WRONG-node' } };
      },
    });

    // 1. Forward effect commits under the ORIGINAL definition, minting a row
    //    that records `RECORDED` as its inverse.
    const run = await newRun('wf.swap.after.commit');
    const forward = await executeRun(storage, run, def('wf.swap.after.commit', { triggers: ['node-failure'] }));
    expect(forward.status).toBe('completed');
    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.compensationNodeTypeId).toBe(RECORDED);

    // 2. The workflow is edited: the same node now declares a DIFFERENT
    //    compensator. This is the definition an unwind would resolve today.
    const edited = def('wf.swap.after.commit', { triggers: ['node-failure'] }) as unknown as {
      nodes: { compensation?: { nodeTypeId: string } }[];
    };
    for (const node of edited.nodes) {
      if (node.compensation) node.compensation.nodeTypeId = SWAPPED;
    }

    // 3. Unwind against the EDITED definition.
    await unwindTerminatedRun({
      storage,
      run: { ...run, status: 'failed' } as RunRecord,
      definition: edited as unknown as WorkflowDefinition,
    });

    // The recorded compensator ran; the swapped-in one never did. Read the row's
    // final state rather than a report, so this cannot pass on the projection
    // alone — which is exactly how the defect stayed invisible.
    const after = await obligationsForRunTree(T, run.runId);
    expect(after[0]!.state, 'the recorded inverse must have executed').toBe('completed');
    expect(swappedRan, 'the compensator swapped into the definition must NOT have run').toBe(false);
  });
});

describe('RFC 0151 §E — an operator START is a start, not a resume', () => {
  /**
   * `resumeUnwindForOperator` deliberately skips `policyAdmitsTrigger`, and the
   * reasoning is sound FOR A RESUME: the same policy authorized the plan into
   * existence, so refusing to let an operator finish it would be perverse.
   *
   * But obligations mint when a forward effect COMMITS, so every run that ever
   * executed a compensable node owns `requested` rows whether or not an unwind
   * was asked for. Reaching that function with only those rows is a START
   * wearing a resume's clothes — and it bypassed both the run's state and the
   * workflow's `triggers`. An operator with `host:compensation:start` could fire
   * every inverse of a RUNNING run, undoing effects underneath a run still
   * producing them, or of a healthy COMPLETED one; a policy that deliberately
   * omitted `operator-request` could prevent neither. RBAC bounded WHO, nothing
   * bounded WHAT IT APPLIED TO.
   */
  async function runToCompletion(workflowId: string, triggers: string[]) {
    const run = await newRun(workflowId);
    const result = await executeRun(storage, run, def(workflowId, { triggers } as never));
    expect(result.status).toBe('completed');
    return run;
  }

  it('refuses to start against a RUNNING run', async () => {
    const run = await runToCompletion('wf.start.running', ['node-failure', 'operator-request']);
    // The run row still says `running` — the case that matters, because the
    // forward effects are still being produced.
    const out = await resumeUnwindForOperator({
      storage,
      run: { ...run, status: 'running' } as RunRecord,
      definition: def('wf.start.running', { triggers: ['node-failure', 'operator-request'] } as never),
    });
    expect(out, 'a start against a live run must be refused').toBeNull();
    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows[0]!.state, 'and no inverse may have fired').toBe('requested');
  });

  it('refuses to start when the policy does not name operator-request', async () => {
    const run = await runToCompletion('wf.start.notrigger', ['node-failure']);
    const out = await resumeUnwindForOperator({
      storage,
      run: { ...run, status: 'failed' } as RunRecord,
      definition: def('wf.start.notrigger', { triggers: ['node-failure'] } as never),
    });
    expect(out, 'a policy that omits operator-request must be able to prevent this').toBeNull();
    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows[0]!.state).toBe('requested');
  });

  it('ALLOWS a start on a terminal run whose policy names operator-request', async () => {
    // The positive fence. Without it the guard above could be satisfied by
    // refusing everything, which would break the operator surface entirely.
    const run = await runToCompletion('wf.start.allowed', ['node-failure', 'operator-request']);
    const out = await resumeUnwindForOperator({
      storage,
      run: { ...run, status: 'failed' } as RunRecord,
      definition: def('wf.start.allowed', { triggers: ['node-failure', 'operator-request'] } as never),
    });
    expect(out, 'an authorized start on a terminal run must proceed').not.toBeNull();
    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows[0]!.state).toBe('completed');
  });

  it('still RESUMES an existing plan even when the policy omits operator-request', async () => {
    // The documented bypass, preserved. Once a plan has been requested, the
    // trigger gate has already had its say; re-asking it would strand a held
    // plan that the same policy authorized.
    const run = await runToCompletion('wf.resume.existing', ['node-failure']);
    await markPlanRequested(T, run.runId, new Date().toISOString());
    const out = await resumeUnwindForOperator({
      storage,
      run: { ...run, status: 'failed' } as RunRecord,
      definition: def('wf.resume.existing', { triggers: ['node-failure'] } as never),
    });
    expect(out, 'a requested plan must still be resumable by an operator').not.toBeNull();
  });
});

describe('RFC 0151 §B — a mint that FAILS after a committed effect cannot read as a clean run', () => {
  /**
   * The forward effect committed and the obligation could not be recorded. The
   * handler caught, logged and dropped it, so the plan omitted a committed
   * effect and the rollup reported `none` — a wrong answer that looks right,
   * announced through a log line nobody reads during an incident.
   *
   * Rethrowing is the WRONG remedy, and the reason is worth stating: `markCompleted`
   * has already run, so failing the node hands the executor a failed node whose
   * effect committed, and a retry re-runs the forward action. Turning a
   * bookkeeping failure into a duplicate payment is the one outcome worse than
   * the bug.
   *
   * Instead the ledger is told the truth in its own vocabulary — an
   * `irreversible` entry, which `compensation.md` says exists "so the plan, and
   * therefore the rollup, tells the truth about what was not undone".
   */
  it('marks the run irreversible instead of reporting `none`', async () => {
    const ledger = await import('../src/host/compensationLedger.js');
    const real = ledger.recordObligation;
    let calls = 0;
    const spy = vi.spyOn(ledger, 'recordObligation').mockImplementation(async (arg: Parameters<typeof real>[0]) => {
      calls += 1;
      // Fail ONLY the first mint — the marker write must still be able to land,
      // which is the difference between "degraded honestly" and "silent".
      if (calls === 1) throw new Error('ledger write failed (simulated)');
      return real(arg);
    });

    try {
      const run = await newRun('wf.mint.fails');
      const result = await executeRun(storage, run, def('wf.mint.fails', { triggers: ['node-failure'] }));
      // The node still succeeded: the effect committed, and failing it here
      // would risk a duplicate on retry.
      expect(result.status).toBe('completed');

      const rows = await obligationsForRunTree(T, run.runId);
      expect(rows, 'the failure must leave a durable trace, not just a log line').toHaveLength(1);
      expect(rows[0]!.shape).toBe('irreversible');

      // The rollup can no longer claim the run owes nothing. `none` was the old
      // answer and is the one this test exists to make unreachable.
      const status = await compensationStatusForRunTree(T, run.runId);
      expect(status).not.toBe('none');
      expect(status).not.toBe('completed');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('RFC 0151 §B — the triggers beyond node-failure actually fire', () => {
  /**
   * Three of the four accepted triggers never fired. `unwindTerminatedRun` was
   * called from exactly ONE place — `finalizeRun`'s failed branch — with no
   * trigger argument, so every unwind was labelled `node-failure` and every
   * other terminal path stranded its obligations at `requested` forever.
   *
   * A workflow could therefore declare `triggers: ['cap-breach']`, blow its
   * duration cap, and unwind nothing — while its author believed committed
   * effects were being undone. Silent, and about money.
   *
   * EVERY leg below names ONLY the trigger under test. A policy listing
   * `node-failure` too would be satisfied by the one path that already worked,
   * which is how a vacuous version of this test would read identically.
   */
  it('a NODE-EXECUTIONS cap breach unwinds under `cap-breach`, not `node-failure`', async () => {
    // Deterministic by construction: `recursionLimit: 1` means the SECOND node's
    // pre-execution check breaches, after the first has committed and minted.
    //
    // The run-duration cap is the same fix at a different call site, and it is
    // NOT covered by an executed test here — deliberately. Every attempt was
    // itself timing-dependent (a 1 ms cap breaches before anything mints; a
    // longer one races the machine), and a timing-dependent test for a timing
    // bug is what this session keeps finding. Recorded as residue in ADR 0554
    // rather than papered over with a test that passes on a fast box.
    const run = await newRun('wf.trigger.nodecap');
    await storage.updateRun(run.runId, { configurable: { recursionLimit: 1 } } as never);
    const live = (await storage.getRun(run.runId))!;
    const definition = {
      workflowId: 'wf.trigger.nodecap',
      name: 'node cap',
      nodes: [
        { nodeId: 'charge', typeId: FORWARD, compensation: { nodeTypeId: INVERSE } },
        { nodeId: 'second', typeId: FORWARD },
      ],
      edges: [{ from: 'charge', to: 'second' }],
      // ONLY cap-breach. Before the trigger was threaded this unwind was
      // labelled `node-failure`, so this policy matched nothing and every
      // obligation stayed at mint state.
      settings: { compensation: { triggers: ['cap-breach'] } },
    } as unknown as WorkflowDefinition;
    await executeRun(storage, live, definition);

    const rows = await obligationsForRunTree(T, run.runId);
    expect(rows.length, 'the first node must have committed and minted').toBeGreaterThan(0);
    expect(
      rows.every((r) => r.state === 'requested'),
      'a cap breach with cap-breach declared must not strand every obligation',
    ).toBe(false);
  });

  it('a CANCEL unwinds under `run-cancel`, and a policy that omits it does not', async () => {
    const { cancelRunAndCascade } = await import('../src/host/runCancel.js');

    // Cancel a run that is genuinely IN FLIGHT: `charge` has committed (its
    // obligation minted) and `hold` is still executing.
    const heldDef = (id: string, triggers: string[]) => ({
      ...def(id, { triggers }),
      nodes: [...def(id).nodes, { nodeId: 'hold', typeId: HOLD }],
      edges: [{ from: 'charge', to: 'hold' }],
    } as unknown as WorkflowDefinition);
    const cancelInFlight = async (run: RunRecord, d: WorkflowDefinition) => {
      releaseHold = null;
      const execution = executeRun(storage, run, d);
      for (let i = 0; i < 400 && !releaseHold; i++) await new Promise((r) => setTimeout(r, 5));
      expect(releaseHold, 'the run must be parked in `hold`').not.toBeNull();
      setCompensationDefinitionResolver(async () => d);
      const fresh = (await storage.getRun(run.runId))!;
      expect(await cancelRunAndCascade(storage, fresh, 'operator asked')).toBe('cancelled');
      releaseHold!();
      const settled = await execution;
      expect(settled.status, 'the execution reports the run it ended in').toBe('cancelled');
      const log = (await getEventLog().list(run.runId, { fromSeq: -1, limit: 200 })).map((e) => e.type);
      const at = log.indexOf('run.cancelled');
      expect(log.slice(at + 1).every((ty) => ty.startsWith('compensation.') || ty === 'run.dead_lettered'), `nothing forward after run.cancelled: ${log.join(' ')}`).toBe(true);
    };

    // (a) policy NAMES run-cancel -> the inverse runs.
    const wanted = await newRun('wf.trigger.cancel.yes');
    await cancelInFlight(wanted, heldDef('wf.trigger.cancel.yes', ['run-cancel']));
    const after = await obligationsForRunTree(T, wanted.runId);
    expect(after[0]!.state, 'a cancel with run-cancel declared must unwind').toBe('completed');

    // (b) policy OMITS run-cancel -> nothing fires. The trigger list is the
    //     author's statement about which failures are worth undoing.
    const notWanted = await newRun('wf.trigger.cancel.no');
    await cancelInFlight(notWanted, heldDef('wf.trigger.cancel.no', ['node-failure']));
    const untouched = await obligationsForRunTree(T, notWanted.runId);
    expect(untouched[0]!.state, 'a policy omitting run-cancel must NOT unwind on cancel').toBe('requested');

    setCompensationDefinitionResolver(null);
  });
});

describe('RFC 0151 §B — the terminal-cause → trigger mapping, verified by execution', () => {
  /**
   * The run-duration cap's unwind cannot be driven deterministically from a test
   * (four attempts each raced the machine, passing in isolation and failing in
   * the full file). Rather than leave that call site "verified by inspection" —
   * a claim that silently stops being true the first time an argument is
   * reordered, with nothing going red — the DECISION is extracted and tested
   * directly. The clock is untestable; the mapping is not.
   */
  it('both caps map to cap-breach, and nothing else does', () => {
    expect(compensationTriggerFor('run-duration-cap')).toBe('cap-breach');
    expect(compensationTriggerFor('node-executions-cap')).toBe('cap-breach');
    // The substance of the fix: before it, the node-executions cap unwound under
    // `node-failure`, so a policy naming `cap-breach` never fired on the breach
    // it named — and one naming `node-failure` fired on a breach nobody asked
    // about. Collapsing these two apart again reds here.
    expect(compensationTriggerFor('node-failure')).toBe('node-failure');
    expect(compensationTriggerFor('run-cancel')).toBe('run-cancel');
  });

  it('every trigger it can return is one the policy schema accepts', () => {
    // A mapping that returned a trigger outside the closed vocabulary would be
    // refused at registration and silently never fire — the failure this whole
    // card is about, reintroduced one layer down.
    const ACCEPTED = new Set(['node-failure', 'run-cancel', 'cap-breach', 'operator-request']);
    for (const cause of ['node-failure', 'run-duration-cap', 'node-executions-cap', 'run-cancel'] as const) {
      expect(ACCEPTED.has(compensationTriggerFor(cause)), `${cause} maps outside the vocabulary`).toBe(true);
    }
  });
});

describe('RFC 0151 §B — the dispatch chokes do not strand a plan', () => {
  /**
   * `runDispatchSweeper` (`dispatch_abandoned`) and `runDispatch`
   * (`dispatch_failed`) both call `emitTerminalFailure` directly, so neither
   * ever reached the executor's single unwind call. For a run that never
   * started that is harmless — nothing is minted. For a RESUMED run that had
   * already committed effects, every obligation sat at `requested` forever and
   * §D reported a plan perpetually about to start.
   *
   * `dispatch-abandoned` maps to `cap-breach`: an age ceiling IS a cap, and it
   * is the one terminal cause that is literally "we waited too long". The
   * closed §B vocabulary offers nothing nearer, and inventing a fifth trigger
   * would be a wire change for a host-internal path.
   */
  it('a swept orphan with committed effects unwinds instead of stranding', async () => {
    const { unwindOnDispatchTerminal } = await import('../src/host/compensationRuntime.js');

    const run = await newRun('wf.dispatch.abandoned');
    await executeRun(storage, run, def('wf.dispatch.abandoned', { triggers: ['cap-breach'] }));
    const before = await obligationsForRunTree(T, run.runId);
    expect(before, 'the forward node must have minted').toHaveLength(1);
    expect(before[0]!.state).toBe('requested');

    setCompensationDefinitionResolver(async () => def('wf.dispatch.abandoned', { triggers: ['cap-breach'] }));
    await unwindOnDispatchTerminal(storage, run.runId, 'dispatch-abandoned');
    setCompensationDefinitionResolver(null);

    const after = await obligationsForRunTree(T, run.runId);
    expect(after[0]!.state, 'the sweeper giving up must not leave the inverse owed forever').toBe('completed');
  });

  it('is a no-op for a run that never minted anything', async () => {
    // The common case by far — a run abandoned before it executed. This must
    // not resolve a definition or touch the ledger, or every swept orphan pays
    // for a lookup it does not need.
    const { unwindOnDispatchTerminal } = await import('../src/host/compensationRuntime.js');
    const run = await newRun('wf.dispatch.nothing');
    let resolverCalls = 0;
    setCompensationDefinitionResolver(async () => { resolverCalls += 1; return null; });
    await unwindOnDispatchTerminal(storage, run.runId, 'dispatch-failed');
    setCompensationDefinitionResolver(null);
    expect(resolverCalls, 'no obligations means no definition lookup').toBe(0);
  });
});

describe('RFC 0151 §B — inputMapping is RESOLVED at plan time, not handed over verbatim', () => {
  /**
   * The mapping was recorded and later passed to the compensator unchanged, so a
   * declaration of `{ chargeId: '${nodes.charge.output.id}' }` handed the
   * compensator that LITERAL STRING — RFC 0151 §B's own example did not work on
   * this host. The failure surfaced at unwind time, during an incident, as a
   * compensator refunding a charge id that never existed rather than as an error
   * anyone could act on.
   */
  const ctx = { nodeId: 'charge', outputs: { id: 'ch_1', amount: 4200, meta: { k: 'v' } }, runInputs: { orderId: 'o-9' } };

  it('a WHOLE-value token resolves to the raw typed value, not its string form', () => {
    const out = resolveCompensationInput({ amount: '${nodes.charge.output.amount}' }, ctx);
    // 4200, not "4200". Coercing here is how a compensator ends up comparing
    // "4200" to 4200 downstream and refunding nothing.
    expect(out.amount).toBe(4200);
    expect(resolveCompensationInput({ meta: '${nodes.charge.output.meta}' }, ctx).meta).toEqual({ k: 'v' });
  });

  it('an EMBEDDED token is substituted textually, and run inputs resolve too', () => {
    expect(resolveCompensationInput({ note: 'refund for ${inputs.orderId}' }, ctx).note)
      .toBe('refund for o-9');
  });

  it('walks nested objects and arrays', () => {
    const out = resolveCompensationInput({ a: [{ b: '${nodes.charge.output.id}' }] }, ctx);
    expect(out).toEqual({ a: [{ b: 'ch_1' }] });
  });

  it('FAILS the mint on anything unresolvable, rather than passing a literal through', () => {
    for (const bad of [
      { x: '${nodes.charge.output.nope}' },      // port the node never emitted
      { x: '${inputs.missing}' },                 // input the run never had
      { x: '${nodes.other.output.id}' },          // another node — not in hand at mint
      { x: '${totally.unknown}' },                // not a recognised reference
    ]) {
      expect(() => resolveCompensationInput(bad, ctx), JSON.stringify(bad))
        .toThrow(UnresolvableCompensationInputError);
    }
  });

  it('an unresolvable mapping leaves the run visibly owing, not silently clean', async () => {
    // The pairing with H58c: a mapping that cannot be built means the declared
    // inverse cannot be built, so the effect is un-undoable by this host — which
    // is exactly the state the mint-failure marker exists to make visible.
    const run = await newRun('wf.inputmapping.bad');
    const definition = {
      workflowId: 'wf.inputmapping.bad',
      name: 'bad mapping',
      nodes: [{
        nodeId: 'charge',
        typeId: FORWARD,
        compensation: { nodeTypeId: INVERSE, inputMapping: { chargeId: '${nodes.charge.output.nope}' } },
      }],
      edges: [],
      settings: { compensation: { triggers: ['node-failure'] } },
    } as unknown as WorkflowDefinition;
    const result = await executeRun(storage, run, definition);
    // The forward effect still committed — failing the node here would risk a
    // duplicate on retry, the same reasoning as H58c.
    expect(result.status).toBe('completed');
    const status = await compensationStatusForRunTree(T, run.runId);
    expect(status).not.toBe('none');
    expect(status).not.toBe('completed');
  });
});
