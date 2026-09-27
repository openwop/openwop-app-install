/**
 * ADR 0554 P3 — partial-failure and concurrency on the recovery path.
 *
 * ── THE VACUITY THIS FILE IS WRITTEN AGAINST ─────────────────────────────
 *
 * ADR 0554 P2's sabotage 2 is the measured precedent: a duplicate-compensation
 * fixture stayed GREEN when the CAS was removed, because it counted distinct
 * IDENTITIES rather than INVOCATIONS PER IDENTITY. Every concurrency leg below
 * therefore counts side effects per obligation — resumes fired, ledger
 * transitions applied, audit entries appended — and never "how many obligations
 * ended up in the right state".
 *
 * ── AND THE CLAIM THAT IS NOT MADE ───────────────────────────────────────
 *
 * "Exactly one wins" is scoped to WITHIN ONE INSTANCE. The ledger still has no
 * store-level conditional write — the limit `compensationLedger.ts` and ADR 0554
 * P2 already state. These tests run in one process, which is exactly the scope
 * of the claim; they are not evidence for a cross-instance guarantee and the
 * titles do not suggest they are.
 *
 * Note also WHY the precondition exists rather than the state machine: `LEGAL`
 * lists `failed -> failed`, so two concurrent waives are BOTH legal transitions
 * and the table would let both through. The first leg pins that fact directly,
 * so the reason for the design cannot quietly stop being true.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __resetAuditChain, listChain } from '../src/host/auditChainService.js';

/**
 * A switch that makes the AUDIT APPEND fail, leaving everything else real.
 *
 * This is the only way to test the ORDERING rather than merely restate it. With
 * the append first, a failing append aborts before the ledger write and the row
 * does not move. With the write first, the row moves and the audit fails — an
 * operator action observable with no record of it, which is the exact failure
 * "the action must not be observable without its audit record" names. A leg that
 * only counted entries after a SUCCESSFUL action cannot tell those two apart.
 */
const auditFault = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/host/compensationRecoveryAudit.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/host/compensationRecoveryAudit.js')>();
  return {
    ...orig,
    appendRecoveryAudit: async (input: Parameters<typeof orig.appendRecoveryAudit>[0]) => {
      if (auditFault.fail) throw new Error('audit sink unavailable');
      return orig.appendRecoveryAudit(input);
    },
  };
});
import { applyRecoveryAction } from '../src/host/compensationRecovery.js';
import {
  AUDIT_KIND_COMPENSATION_RECOVERY,
  type CompensationRecoveryAuditPayload,
} from '../src/host/compensationRecoveryAudit.js';
import {
  _resetCompensationLedgerForTest,
  canTransition,
  digestOf,
  getObligation,
  obligationsForRun,
  recordObligation,
  resolveObligation,
  CompensationStaleViewError,
} from '../src/host/compensationLedger.js';

const T = 'tenant-p3-partial';
const R = 'run-p3-partial';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => {
  await _resetCompensationLedgerForTest();
  await __resetAuditChain();
  auditFault.fail = false;
});

let ordinal = 0;
async function commit(over: Record<string, unknown> = {}) {
  ordinal += 1;
  return recordObligation({
    tenantId: T,
    runId: R,
    forwardLogicalInvocationId: `inv-${ordinal}`,
    compensationOrdinal: ordinal,
    effectKind: 'payment',
    shape: 'forward-effect',
    resultDigest: digestOf({ charge: ordinal }),
    contractDigest: digestOf({ refund: 'v1' }),
    ...over,
  });
}

/** Audit entries for ONE obligation — the per-identity counter. */
async function auditCount(obligationId: string): Promise<number> {
  return (await listChain(T)).filter(
    (e) => e.kind === AUDIT_KIND_COMPENSATION_RECOVERY
      && (e.payload as CompensationRecoveryAuditPayload).obligationId === obligationId,
  ).length;
}

describe('the state machine alone would NOT stop a duplicate waive', () => {
  /**
   * The premise the `expectedState` precondition rests on, pinned alongside the
   * conclusion. If a future change makes `failed -> failed` illegal, this leg
   * goes red and whoever reads it learns the design note above has drifted —
   * rather than the precondition quietly becoming redundant with nobody noticing.
   */
  it('permits failed -> failed, so two concurrent waives are both LEGAL transitions', () => {
    expect(canTransition('failed', 'failed')).toBe(true);
  });
});

describe('concurrent duplicate operator actions on ONE obligation', () => {
  it('applies EXACTLY ONE of two simultaneous waives; the loser gets version_conflict', async () => {
    const o = await commit();

    const results = await Promise.allSettled([
      applyRecoveryAction({
        tenantId: T, runId: R, obligationId: o.inverseActionId,
        action: 'skip', actor: 'user:owner-a', expectedState: 'requested', reason: 'a',
      }),
      applyRecoveryAction({
        tenantId: T, runId: R, obligationId: o.inverseActionId,
        action: 'skip', actor: 'user:owner-b', expectedState: 'requested', reason: 'b',
      }),
    ]);

    const applied = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(applied).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'version_conflict',
      httpStatus: 409,
    });

    // ── PER-IDENTITY counts, not per-obligation existence ──────────────────
    const row = await getObligation(T, o.inverseActionId);
    // ONE application witnessed. Two would mean both waives landed.
    expect(row?.recoveryAuditSeqs).toHaveLength(1);
    // ONE audit entry: the loser must fail BEFORE it appends, or the chain would
    // record two requests for one applied action.
    expect(await auditCount(o.inverseActionId)).toBe(1);
  });

  it('applies EXACTLY ONE resume when two retries race — counting INVOCATIONS, not rows', async () => {
    const o = await commit();
    let resumes = 0;

    const results = await Promise.allSettled([
      applyRecoveryAction({
        tenantId: T, runId: R, obligationId: o.inverseActionId,
        action: 'retry', actor: 'user:admin-a', expectedState: 'requested',
        resume: async () => { resumes += 1; },
      }),
      applyRecoveryAction({
        tenantId: T, runId: R, obligationId: o.inverseActionId,
        action: 'retry', actor: 'user:admin-b', expectedState: 'requested',
        resume: async () => { resumes += 1; },
      }),
    ]);

    // THE LEG THE P2 FIXTURE WAS MISSING. The row ends `started` either way; the
    // number that distinguishes one refund from two is how many times the
    // inverse was actually invoked.
    expect(resumes).toBe(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await auditCount(o.inverseActionId)).toBe(1);
  });

  it('refuses a SEQUENTIAL second action whose expectedState is stale', async () => {
    const o = await commit();
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'retry', actor: 'user:admin', expectedState: 'requested',
    });
    // The second operator's panel still says `requested`.
    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'stale view',
    })).rejects.toMatchObject({ code: 'version_conflict', httpStatus: 409 });

    expect(await auditCount(o.inverseActionId)).toBe(1);
  });

  it('ACCEPTS the same action once the operator re-reads — the conflict is not a wall', async () => {
    const o = await commit();
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'retry', actor: 'user:admin', expectedState: 'requested',
    });
    const fresh = await getObligation(T, o.inverseActionId);
    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: fresh!.state, reason: 'now with a fresh read',
    })).resolves.toMatchObject({ outcome: 'applied', state: 'failed' });
  });

  it('surfaces a stale view raised INSIDE the ledger as the same typed 409', async () => {
    // The precondition is enforced twice — once in the applier before the append,
    // once in `resolveObligation` — and the deeper one must not leak as a raw
    // CompensationStaleViewError to a route that maps typed envelopes.
    const o = await commit();
    await expect(resolveObligation({
      tenantId: T, inverseActionId: o.inverseActionId, to: 'failed',
      expectedState: 'started', reason: 'wrong expectation',
    })).rejects.toBeInstanceOf(CompensationStaleViewError);
    // ...and the row did not move.
    expect((await getObligation(T, o.inverseActionId))?.state).toBe('requested');
  });
});

describe('retry after a PARTIAL unwind (RFC 0151 §C identity rule)', () => {
  /**
   * Three obligations: one completed, two still owed. A retry must address only
   * the remaining set — a completed inverse re-fired is a second refund, which
   * is the exact failure the retry-stable §C identity exists to prevent.
   */
  it('retries ONLY the non-completed obligations; a completed one is never re-invoked', async () => {
    const done = await commit();
    const owedA = await commit();
    const owedB = await commit();

    await resolveObligation({ tenantId: T, inverseActionId: done.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: T, inverseActionId: done.inverseActionId, to: 'completed' });
    for (const o of [owedA, owedB]) {
      await resolveObligation({ tenantId: T, inverseActionId: o.inverseActionId, to: 'failed', reason: 'transient' });
    }

    const invoked: string[] = [];
    for (const o of [owedA, owedB]) {
      await applyRecoveryAction({
        tenantId: T, runId: R, obligationId: o.inverseActionId,
        action: 'retry', actor: 'user:admin', expectedState: 'failed',
        resume: async () => { invoked.push(o.inverseActionId); },
      });
    }

    expect(invoked.sort()).toEqual([owedA.inverseActionId, owedB.inverseActionId].sort());
    expect(invoked).not.toContain(done.inverseActionId);

    // `completed` is the ONLY terminal state, so the row is structurally
    // unreachable for a retry — asserted rather than assumed.
    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: done.inverseActionId,
      action: 'retry', actor: 'user:admin', expectedState: 'completed',
      resume: async () => { invoked.push(done.inverseActionId); },
    })).rejects.toBeTruthy();
    expect(invoked).not.toContain(done.inverseActionId);
  });

  it('a completed obligation REPLAYS from its recorded outcome, unchanged by the retry pass', async () => {
    const done = await commit();
    await resolveObligation({ tenantId: T, inverseActionId: done.inverseActionId, to: 'started', reason: 'go' });
    const completed = await resolveObligation({
      tenantId: T, inverseActionId: done.inverseActionId, to: 'completed',
    });
    const owed = await commit();
    await resolveObligation({ tenantId: T, inverseActionId: owed.inverseActionId, to: 'failed', reason: 'transient' });

    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: owed.inverseActionId,
      action: 'retry', actor: 'user:admin', expectedState: 'failed',
    });

    const after = await getObligation(T, done.inverseActionId);
    expect(after?.state).toBe('completed');
    expect(after?.attempts).toBe(completed.attempts);
    expect(after?.updatedAt).toBe(completed.updatedAt);   // untouched, not rewritten
    expect(after?.recoveryAuditSeqs ?? []).toEqual([]);    // no operator acted on it
  });
});

describe('waive with a REMAINING set', () => {
  it('waives one obligation and leaves its siblings owed', async () => {
    const waived = await commit();
    const owed = await commit();

    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: waived.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested',
      reason: 'the counterparty confirmed no charge was captured',
    });

    const rows = await obligationsForRun(T, R);
    const w = rows.find((r) => r.inverseActionId === waived.inverseActionId);
    const o = rows.find((r) => r.inverseActionId === owed.inverseActionId);

    expect(w?.state).toBe('failed');
    // The justification survives on the row, not only in the audit chain — an
    // operator reading the ledger must see WHY it was left undone.
    expect(w?.reason).toContain('counterparty confirmed');
    // The sibling is untouched: a waive is per-obligation, never per-plan.
    expect(o?.state).toBe('requested');
    expect(o?.recoveryAuditSeqs ?? []).toEqual([]);
  });

  it('does not mark the plan completed when an obligation was waived rather than undone', async () => {
    const waived = await commit();
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: waived.inverseActionId,
      action: 'terminate', actor: 'user:owner', expectedState: 'requested', reason: 'irrecoverable',
    });
    const rows = await obligationsForRun(T, R);
    // `failed` WITH a reason is RFC 0151 §E's "terminate as uncompensated" —
    // never `completed`, which would claim an unwind that did not happen.
    expect(rows.every((r) => r.state !== 'completed')).toBe(true);
  });
});

describe('the obligation must belong to the run it is acted on through', () => {
  /**
   * FOUND BY CODE REVIEW, not by the first round of tests.
   *
   * `getObligation` keys on (tenant, obligationId) alone, so nothing tied the
   * row to the run named in the route path. An operator could name run B — the
   * run the RFC 0049 `authorization.decided` record is written against — while
   * actually moving an obligation belonging to run A. Same tenant, so not a
   * tenant-isolation break; it is an ATTRIBUTION break, and an audit trail that
   * attributes an act to the wrong run is worse than one that is merely thin.
   *
   * The check is against the run TREE, not `row.runId`, because a sub-run's
   * obligation legitimately belongs to its ROOT's plan (ordinals come from one
   * counter per root) and an operator acts on the root.
   */
  it('REFUSES an obligation that belongs to a different run', async () => {
    const mine = await commit({ runId: 'run-A' });
    await expect(applyRecoveryAction({
      tenantId: T, runId: 'run-B', obligationId: mine.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'r',
    })).rejects.toMatchObject({ code: 'not_found', httpStatus: 404 });

    // Nothing moved, and nothing was audited against the wrong run.
    const row = await getObligation(T, mine.inverseActionId);
    expect(row?.state).toBe('requested');
    expect(await auditCount(mine.inverseActionId)).toBe(0);
  });

  it('ALLOWS it through its own run — so the leg above is not refusing everything', async () => {
    const mine = await commit({ runId: 'run-A' });
    await expect(applyRecoveryAction({
      tenantId: T, runId: 'run-A', obligationId: mine.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'r',
    })).resolves.toMatchObject({ outcome: 'applied' });
  });

  it('ALLOWS a SUB-RUN obligation to be acted on through its ROOT', async () => {
    const child = await commit({ runId: 'run-child', rootRunId: 'run-root' });
    await expect(applyRecoveryAction({
      tenantId: T, runId: 'run-root', obligationId: child.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'r',
    })).resolves.toMatchObject({ outcome: 'applied' });
  });
});

describe('the crash window between the action and the audit append', () => {
  /**
   * The ordering guarantee, asserted from the direction that matters: there is
   * no code path that moves the row through a recovery action without an audit
   * seq, because the seq is a REQUIRED input to that write. So for every applied
   * recovery action the witnessed seq count equals the audit-entry count.
   */
  it('every applied recovery action is witnessed by exactly one audit entry', async () => {
    const o = await commit();
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'retry', actor: 'user:admin', expectedState: 'requested',
    });
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'started', reason: 'gave up',
    });

    const row = await getObligation(T, o.inverseActionId);
    expect(row?.recoveryAuditSeqs).toHaveLength(2);
    expect(await auditCount(o.inverseActionId)).toBe(2);
    // And every witnessed seq is a real entry in the chain.
    const chainSeqs = new Set((await listChain(T)).map((e) => e.seq));
    for (const seq of row!.recoveryAuditSeqs ?? []) expect(chainSeqs.has(seq)).toBe(true);
  });

  /**
   * THE ORDERING LEG. Under audit-first this passes because the append aborts
   * the action; under write-first the row would be `failed` with no record of
   * who waived it or why. This is the only leg in the file that distinguishes
   * the two orderings, which is why it drives a real append FAILURE rather than
   * counting entries after a success.
   */
  it('an action whose audit append FAILS does not move the ledger', async () => {
    const o = await commit();
    auditFault.fail = true;

    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'would have waived',
    })).rejects.toThrow(/audit sink unavailable/);

    const row = await getObligation(T, o.inverseActionId);
    expect(row?.state).toBe('requested');            // NOT `failed`
    expect(row?.recoveryAuditSeqs ?? []).toEqual([]);
    expect(await auditCount(o.inverseActionId)).toBe(0);
  });

  it('and the same action succeeds once the sink recovers — the leg is not red for a stuck reason', async () => {
    const o = await commit();
    auditFault.fail = true;
    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'first try',
    })).rejects.toThrow();

    auditFault.fail = false;
    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'second try',
    })).resolves.toMatchObject({ outcome: 'applied', state: 'failed' });
    expect(await auditCount(o.inverseActionId)).toBe(1);
  });

  it('a resume that THROWS still leaves the action recorded and witnessed', async () => {
    const o = await commit();
    await expect(applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'retry', actor: 'user:admin', expectedState: 'requested',
      resume: async () => { throw new Error('the compensator is down'); },
    })).rejects.toThrow(/compensator is down/);

    // The action was authorized, recorded and BEGUN — reporting nothing would
    // make a started-and-failed resume indistinguishable from one never taken.
    const row = await getObligation(T, o.inverseActionId);
    expect(row?.state).toBe('started');
    expect(row?.startedBy).toBe('user:admin');
    expect(row?.recoveryAuditSeqs).toHaveLength(1);
    expect(await auditCount(o.inverseActionId)).toBe(1);
  });
});
