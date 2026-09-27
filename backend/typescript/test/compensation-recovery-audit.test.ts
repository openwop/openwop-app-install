/**
 * ADR 0554 P3 — the recovery audit chain (RFC 0151 §E/§G).
 *
 * ── TWO GUARDS, PROVEN SEPARATELY, BECAUSE THEY CATCH DIFFERENT THINGS ────
 *
 * 1. THE TENANT CHAIN (`auditChainService.verifyChain`) is the tamper evidence.
 *    It recomputes every entry hash and every linkage, so a mutated or deleted
 *    persisted entry is detected there — whether or not the per-obligation
 *    pointers exist.
 *
 * 2. THE OBLIGATION SLICE (`verifyRecoverySlice`) catches what `verifyChain`
 *    structurally cannot: a SERVING-SIDE OMISSION, i.e. the read model handing a
 *    client a slice with a hole while the store is perfectly intact.
 *
 * Asserting only (1) would credit the prev pointers with coverage they do not
 * have; asserting only (2) would claim tamper evidence they do not provide. The
 * honest record is that they are two guards, so there are two sets of legs.
 *
 * ── AND THE ORDERING ─────────────────────────────────────────────────────
 *
 * The applier appends the audit entry BEFORE the ledger write and feeds its seq
 * into that write, so an applied action with no audit record is unreachable. The
 * crash-window legs below drive the reverse case and assert it renders as
 * `recorded, not applied` rather than as an applied action.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  __resetAuditChain,
  __tamperEntryForTest,
  listChain,
  verifyChain,
} from '../src/host/auditChainService.js';
import {
  AUDIT_KIND_COMPENSATION_RECOVERY,
  appendRecoveryAudit,
  recoveryHistory,
  verifyRecoverySlice,
  type CompensationRecoveryAuditPayload,
} from '../src/host/compensationRecoveryAudit.js';
import { applyRecoveryAction } from '../src/host/compensationRecovery.js';
import {
  _resetCompensationLedgerForTest,
  digestOf,
  getObligation,
  recordObligation,
} from '../src/host/compensationLedger.js';

const T = 'tenant-p3-audit';
const R = 'run-p3-audit';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => {
  await _resetCompensationLedgerForTest();
  await __resetAuditChain();
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

/** Every `compensation.recovery` entry for one obligation, straight from the chain. */
async function slice(obligationId: string) {
  return (await listChain(T))
    .filter((e) => e.kind === AUDIT_KIND_COMPENSATION_RECOVERY
      && (e.payload as CompensationRecoveryAuditPayload).obligationId === obligationId)
    .map((e) => ({
      seq: e.seq,
      entryHash: e.entryHash,
      payload: e.payload as CompensationRecoveryAuditPayload,
    }));
}

describe('the obligation-scoped chain', () => {
  it('anchors the first entry at a NULL prev and links each later one to its predecessor', async () => {
    const o = await commit();
    for (const n of [1, 2, 3]) {
      await appendRecoveryAudit({
        tenantId: T, obligationId: o.inverseActionId, runId: R,
        action: 'skip', actor: `user:a${n}`, requiredScope: 'host:compensation:waive',
        reason: `r${n}`, priorState: 'requested', requestedState: 'failed',
      });
    }
    const s = await slice(o.inverseActionId);
    expect(s).toHaveLength(3);
    expect(s[0]!.payload.prevSeq).toBeNull();
    expect(s[0]!.payload.prevEntryHash).toBeNull();
    expect(s[1]!.payload.prevSeq).toBe(s[0]!.seq);
    expect(s[1]!.payload.prevEntryHash).toBe(s[0]!.entryHash);
    expect(s[2]!.payload.prevSeq).toBe(s[1]!.seq);
    expect(verifyRecoverySlice(s)).toEqual({ ok: true });
  });

  /**
   * Two obligations INTERLEAVED in one tenant. Each slice is a subsequence of
   * the tenant chain whose pointers skip the other's entries, so both verify —
   * this is what makes the per-obligation chain usable at all under real traffic.
   */
  it('verifies both slices when two obligations interleave in one tenant', async () => {
    const a = await commit();
    const b = await commit();
    for (const o of [a, b, a, b, a]) {
      await appendRecoveryAudit({
        tenantId: T, obligationId: o.inverseActionId, runId: R,
        action: 'retry', actor: 'user:x', requiredScope: 'host:compensation:retry',
        priorState: 'failed', requestedState: 'started',
      });
    }
    const sa = await slice(a.inverseActionId);
    const sb = await slice(b.inverseActionId);
    expect(sa).toHaveLength(3);
    expect(sb).toHaveLength(2);
    // Their seqs interleave in the tenant chain...
    expect(sa[1]!.seq).toBeGreaterThan(sb[0]!.seq);
    // ...and each slice still links cleanly.
    expect(verifyRecoverySlice(sa)).toEqual({ ok: true });
    expect(verifyRecoverySlice(sb)).toEqual({ ok: true });
  });

  /**
   * GUARD 2. The store is INTACT here — `verifyChain` is asserted `ok` in the
   * same test — and the only thing wrong is the slice the caller was handed.
   * That is the failure a timeline endpoint can produce and the whole reason the
   * pointers exist.
   */
  it('detects a SERVING-SIDE omission that verifyChain cannot see', async () => {
    const o = await commit();
    for (const n of [1, 2, 3]) {
      await appendRecoveryAudit({
        tenantId: T, obligationId: o.inverseActionId, runId: R,
        action: 'skip', actor: `user:a${n}`, requiredScope: 'host:compensation:waive',
        reason: `r${n}`, priorState: 'requested', requestedState: 'failed',
      });
    }
    const full = await slice(o.inverseActionId);
    const served = [full[0]!, full[2]!]; // the middle record silently dropped

    // The STORE is fine. This is the half that proves the two guards are distinct.
    expect(await verifyChain(T)).toEqual({ ok: true });

    const verdict = verifyRecoverySlice(served);
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ brokenAt: full[2]!.seq });
  });

  it('accepts the complete slice, so the omission leg is not vacuously red', async () => {
    const o = await commit();
    for (const n of [1, 2]) {
      await appendRecoveryAudit({
        tenantId: T, obligationId: o.inverseActionId, runId: R,
        action: 'skip', actor: `user:a${n}`, requiredScope: 'host:compensation:waive',
        reason: `r${n}`, priorState: 'requested', requestedState: 'failed',
      });
    }
    expect(verifyRecoverySlice(await slice(o.inverseActionId))).toEqual({ ok: true });
  });
});

describe('the tenant chain is the TAMPER guard', () => {
  it('detects a mutated persisted recovery entry', async () => {
    const o = await commit();
    await appendRecoveryAudit({
      tenantId: T, obligationId: o.inverseActionId, runId: R,
      action: 'terminate', actor: 'user:mallory', requiredScope: 'host:compensation:waive',
      reason: 'the original reason', priorState: 'requested', requestedState: 'failed',
    });
    const [entry] = await slice(o.inverseActionId);
    expect(await verifyChain(T)).toEqual({ ok: true });

    // Rewrite the recorded justification WITHOUT re-hashing — the shape of a
    // real after-the-fact edit.
    await __tamperEntryForTest(T, entry!.seq, (e) => ({
      ...e,
      payload: { ...e.payload, reason: 'a reason nobody gave' },
    }));

    expect(await verifyChain(T)).toEqual({ ok: false, brokenAt: entry!.seq });
  });

  it('detects a DELETED link', async () => {
    const o = await commit();
    await appendRecoveryAudit({
      tenantId: T, obligationId: o.inverseActionId, runId: R,
      action: 'skip', actor: 'user:a', requiredScope: 'host:compensation:waive',
      reason: 'r', priorState: 'requested', requestedState: 'failed',
    });
    const [entry] = await slice(o.inverseActionId);
    // Blank the actor: a removal-by-emptying, still hash-detectable.
    await __tamperEntryForTest(T, entry!.seq, (e) => ({ ...e, payload: {} }));
    expect((await verifyChain(T)).ok).toBe(false);
  });
});

describe('the entry is a REQUEST; the ledger row is the witness of application', () => {
  it('records requestedState, never a claim that the state was reached', async () => {
    const o = await commit();
    await appendRecoveryAudit({
      tenantId: T, obligationId: o.inverseActionId, runId: R,
      action: 'skip', actor: 'user:a', requiredScope: 'host:compensation:waive',
      reason: 'r', priorState: 'requested', requestedState: 'failed',
    });
    const [entry] = await slice(o.inverseActionId);
    expect(entry!.payload).toMatchObject({ priorState: 'requested', requestedState: 'failed' });
    // The word that would turn an over-record into a fabricated outcome.
    expect(entry!.payload).not.toHaveProperty('nextState');
  });

  it('an APPLIED action is witnessed on the row and reads back applied', async () => {
    const o = await commit();
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'accepted the loss',
    });
    const row = await getObligation(T, o.inverseActionId);
    expect(row?.state).toBe('failed');
    expect(row?.recoveryAuditSeqs).toHaveLength(1);

    const history = await recoveryHistory(T, o.inverseActionId, row!.recoveryAuditSeqs ?? []);
    expect(history).toHaveLength(1);
    expect(history[0]!.applied).toBe(true);
    expect(history[0]!.payload.actor).toBe('user:owner');
    expect(history[0]!.payload.reason).toBe('accepted the loss');
    expect(history[0]!.payload.requiredScope).toBe('host:compensation:waive');
  });

  /**
   * THE CRASH WINDOW. An entry appended whose ledger write never landed is what
   * a crash between the two steps leaves behind. It must read `applied: false`.
   */
  it('renders an unapplied entry as recorded-NOT-applied', async () => {
    const o = await commit();
    // Simulate the crash: the append happened, the write did not.
    await appendRecoveryAudit({
      tenantId: T, obligationId: o.inverseActionId, runId: R,
      action: 'terminate', actor: 'user:owner', requiredScope: 'host:compensation:waive',
      reason: 'crashed here', priorState: 'requested', requestedState: 'failed',
    });
    const row = await getObligation(T, o.inverseActionId);
    expect(row?.state).toBe('requested');           // nothing moved
    expect(row?.recoveryAuditSeqs ?? []).toEqual([]); // nothing witnessed

    const history = await recoveryHistory(T, o.inverseActionId, row!.recoveryAuditSeqs ?? []);
    expect(history[0]!.applied).toBe(false);
  });

  /**
   * THE REASON `recoveryAuditSeqs` IS A SET AND NOT A LATEST-SEQ.
   *
   * Sequence: entry 1 applies, entry 2 crashes mid-apply, entry 3 applies. A
   * `applied = seq <= latest` join reports entry 2 as APPLIED the moment entry 3
   * lands — a false positive on exactly the record an incident review reads.
   * Membership is exact.
   */
  it('does NOT report a crashed MIDDLE entry as applied once a later one succeeds', async () => {
    const o = await commit();

    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'retry', actor: 'user:admin', expectedState: 'requested',
    });
    // The crash: appended, never applied.
    const crashed = await appendRecoveryAudit({
      tenantId: T, obligationId: o.inverseActionId, runId: R,
      action: 'terminate', actor: 'user:owner', requiredScope: 'host:compensation:waive',
      reason: 'crashed here', priorState: 'started', requestedState: 'failed',
    });
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'started', reason: 'gave up',
    });

    const row = await getObligation(T, o.inverseActionId);
    const history = await recoveryHistory(T, o.inverseActionId, row!.recoveryAuditSeqs ?? []);
    expect(history).toHaveLength(3);

    const byCrashed = history.find((h) => h.seq === crashed.seq);
    expect(byCrashed?.applied).toBe(false);
    // And the two real ones still read applied — so the leg is not passing by
    // reporting everything false.
    expect(history.filter((h) => h.applied)).toHaveLength(2);
    // The crashed seq is BELOW the latest witnessed one, which is precisely the
    // case a `<=` join would get wrong.
    expect(crashed.seq).toBeLessThan(Math.max(...(row!.recoveryAuditSeqs ?? [])));
  });

  it('carries no effect payload — §G keeps provider bodies off the durable path', async () => {
    const o = await commit();
    await applyRecoveryAction({
      tenantId: T, runId: R, obligationId: o.inverseActionId,
      action: 'skip', actor: 'user:owner', expectedState: 'requested', reason: 'r',
    });
    const [entry] = await slice(o.inverseActionId);
    expect(Object.keys(entry!.payload).sort()).toEqual([
      'action', 'actor', 'obligationId', 'prevEntryHash', 'prevSeq',
      'priorState', 'reason', 'requestedState', 'requiredScope', 'runId',
    ]);
  });
});
