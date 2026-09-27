/**
 * ADR 0554 P1 — the compensation obligation ledger and its state machine.
 *
 * P1's gate is "state-machine/property tests", so the transition legs below are
 * EXHAUSTIVE over the state matrix rather than a sample of happy paths: for
 * every (from, to) pair, the runtime must agree with `canTransition`. A
 * hand-picked set of transitions would pass while some unlisted pair silently
 * became legal.
 *
 * Built against RFC 0151, not ADR 0554's Decision section, which predates the
 * RFC and disagrees with it (see the module docblock). The identity tuple and
 * the state vocabulary below are the RFC's, and that is asserted directly — if
 * someone "fixes" the code back toward the ADR's wording, these fail.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  COMPENSATION_PROFILE_VERSION,
  CompensationTransitionError,
  _resetCompensationLedgerForTest,
  eraseCompensationSubject,
  canTransition,
  compensationStatusForRun,
  digestOf,
  inverseActionId,
  isTerminal,
  nextClaimable,
  obligationsForRun,
  recordObligation,
  resolveObligation,
  type CompensationState,
  markPlanRequested,
} from '../src/host/compensationLedger.js';

const T = 'tenant-a';
const R = 'run-1';

const ALL_STATES: CompensationState[] = [
  'requested', 'started', 'completed', 'failed', 'paused', 'manual_intervention_required',
];

async function commit(ordinal: number, over: Partial<Parameters<typeof recordObligation>[0]> = {}) {
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

// The ledger is DURABLE by design (ADR 0554: obligations are never
// process-local), so the tests exercise the real persistence layer rather than
// a stub — a stubbed store would not prove the rows survive at all.
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });
beforeEach(async () => { await _resetCompensationLedgerForTest(); });

describe('ADR 0554 P1 — inverse-action identity is RETRY-STABLE (RFC 0151 §C)', () => {
  it('the id is derived from the RFC tuple, and the attempt is NOT in it', () => {
    const a = inverseActionId({ tenantId: T, runId: R, forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 0 });
    const b = inverseActionId({ tenantId: T, runId: R, forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 0 });
    expect(a).toBe(b);
    // Every tuple component must actually participate — otherwise two distinct
    // obligations alias onto one id and one inverse silently never runs.
    expect(a).not.toBe(inverseActionId({ tenantId: 'other', runId: R, forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 0 }));
    expect(a).not.toBe(inverseActionId({ tenantId: T, runId: 'run-2', forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 0 }));
    expect(a).not.toBe(inverseActionId({ tenantId: T, runId: R, forwardLogicalInvocationId: 'inv-2', compensationOrdinal: 0 }));
    expect(a).not.toBe(inverseActionId({ tenantId: T, runId: R, forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 1 }));
    expect(a).not.toBe(inverseActionId({ tenantId: T, runId: R, forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 0, profileVersion: '2' }));
  });

  it('a delimiter in a component cannot alias two obligations', () => {
    // The reason the id is hashed from a JSON tuple rather than concatenated:
    // caller-supplied components can contain any separator.
    const a = inverseActionId({ tenantId: 'a::b', runId: 'c', forwardLogicalInvocationId: 'x', compensationOrdinal: 0 });
    const b = inverseActionId({ tenantId: 'a', runId: 'b::c', forwardLogicalInvocationId: 'x', compensationOrdinal: 0 });
    expect(a).not.toBe(b);
  });

  it('recording twice is FIRST-WRITE-WINS — a replay does not owe two inverses', async () => {
    const first = await commit(0);
    await resolveObligation({ tenantId: T, inverseActionId: first.inverseActionId, to: 'started', reason: 'unwinding' });
    // Same forward effect recorded again (a re-dispatch or replay).
    const again = await commit(0);
    expect(again.inverseActionId).toBe(first.inverseActionId);
    // Crucially it did NOT reset to `requested` — the in-flight state survives.
    expect(again.state).toBe('started');
    expect((await obligationsForRun(T, R))).toHaveLength(1);
  });
});

describe('ADR 0554 P1 — the state machine, exhaustively', () => {
  it('every (from,to) pair behaves as canTransition says', async () => {
    // The property: the runtime and the declared machine agree on ALL 36 pairs.
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        await _resetCompensationLedgerForTest();
        const row = await commit(0);
        // Walk to `from` if it isn't the initial state.
        if (from !== 'requested') {
          const path: CompensationState[] = from === 'completed' ? ['started', 'completed'] : [from];
          let ok = true;
          let cur: CompensationState = 'requested';
          for (const step of path) {
            if (!canTransition(cur, step)) { ok = false; break; }
            await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: step, reason: 'setup' });
            cur = step;
          }
          if (!ok) continue; // unreachable `from`; nothing to assert
        }
        const expected = canTransition(from, to);
        const attempt = resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to, reason: 'x' });
        if (expected) await expect(attempt).resolves.toMatchObject({ state: to });
        else await expect(attempt).rejects.toBeInstanceOf(CompensationTransitionError);
      }
    }
  });

  it('`completed` is the ONLY terminal state', () => {
    // `failed` must stay retryable (P0 finding 2: compensation is itself an
    // effect that can fail). If this flips, a transient refund failure becomes
    // permanent and an operator cannot retry.
    expect(isTerminal('completed')).toBe(true);
    for (const s of ALL_STATES.filter((x) => x !== 'completed')) expect(isTerminal(s)).toBe(false);
  });

  it('a completed inverse cannot be re-run — that is a double refund', async () => {
    const row = await commit(0);
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'completed' });
    await expect(resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'started', reason: 'again' }))
      .rejects.toBeInstanceOf(CompensationTransitionError);
  });
});

describe('ADR 0554 P1 — the reason rule', () => {
  it('every state except `completed` demands a reason', async () => {
    const row = await commit(0);
    for (const to of ['started', 'failed', 'paused', 'manual_intervention_required'] as CompensationState[]) {
      await expect(resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to }))
        .rejects.toThrow(/requires a reason/);
      await expect(resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to, reason: '   ' }))
        .rejects.toThrow(/requires a reason/);
    }
  });

  it('`completed` needs none — success explains itself', async () => {
    const row = await commit(0);
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'started', reason: 'go' });
    await expect(resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'completed' }))
      .resolves.toMatchObject({ state: 'completed' });
  });

  it('attempts accumulate across retries, from the durable row', async () => {
    // P2's retry budget must survive a restart, so it cannot live in memory.
    const row = await commit(0);
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'failed', reason: 'peer 500' });
    const third = await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'started', reason: 'retry' });
    expect(third.attempts).toBe(3);
  });
});

describe('ADR 0554 P1 — reverse-completion ordering (RFC 0151 §A)', () => {
  it('obligations unwind in DESCENDING commit order', async () => {
    await commit(0); await commit(1); await commit(2);
    expect((await obligationsForRun(T, R)).map((r) => r.compensationOrdinal)).toEqual([2, 1, 0]);
    // The last effect committed is the first undone.
    expect((await nextClaimable(T, R))?.compensationOrdinal).toBe(2);
  });

  it('a completed inverse is skipped; the rest keep their order', async () => {
    await commit(0); const mid = await commit(1); await commit(2);
    const top = (await nextClaimable(T, R))!;
    await resolveObligation({ tenantId: T, inverseActionId: top.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: T, inverseActionId: top.inverseActionId, to: 'completed' });
    expect((await nextClaimable(T, R))?.inverseActionId).toBe(mid.inverseActionId);
  });

  it('a FAILED inverse is still claimable — it is retryable, not skipped', async () => {
    const row = await commit(0);
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: T, inverseActionId: row.inverseActionId, to: 'failed', reason: 'peer 500' });
    expect((await nextClaimable(T, R))?.inverseActionId).toBe(row.inverseActionId);
  });

  it('another run\'s obligations never leak in', async () => {
    await commit(0);
    await recordObligation({
      tenantId: T, runId: 'run-2', forwardLogicalInvocationId: 'inv-x', compensationOrdinal: 9,
      effectKind: 'email', shape: 'irreversible', resultDigest: 'd', contractDigest: 'c',
    });
    expect((await obligationsForRun(T, R)).map((r) => r.runId)).toEqual([R]);
  });

  it('another TENANT\'s obligations never leak in', async () => {
    await commit(0);
    await recordObligation({
      tenantId: 'tenant-b', runId: R, forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 0,
      effectKind: 'payment', shape: 'forward-effect', resultDigest: 'd', contractDigest: 'c',
    });
    expect(await obligationsForRun(T, R)).toHaveLength(1);
  });
});

describe('ADR 0554 P1 — the run-level rollup (RFC 0151 §D)', () => {
  it('a run with no obligations owes nothing', async () => {
    expect(await compensationStatusForRun(T, 'never-ran')).toBe('none');
  });

  it('PARTIAL is reported honestly when some inverses completed and others did not', async () => {
    // The cell that matters. Rounding this to `failed` erases that a refund DID
    // go through; rounding it to `completed` claims an unwind that half-happened.
    const a = await commit(0); await commit(1);
    await resolveObligation({ tenantId: T, inverseActionId: a.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: T, inverseActionId: a.inverseActionId, to: 'completed' });
    expect(await compensationStatusForRun(T, R)).toBe('partial');
  });

  it('minted but never requested ⇒ none; requested-not-started ⇒ pending; all completed ⇒ completed', async () => {
    // CORRECTED 2026-08-18. This test used to assert `pending` immediately after
    // the mint, and that reading was the defect: `commit()` means a FORWARD
    // effect committed, which is when obligations are recorded — not that an
    // unwind was ever asked for. §D's table says `none` = "No
    // `compensation.requested` has been recorded for the run", so every healthy
    // run that executed a compensable node was advertising an unwind that would
    // never come, on the deployed wire, on an advertised capability.
    const a = await commit(0);
    expect(await compensationStatusForRun(T, R)).toBe('none');

    // Now the plan is requested — the moment §C calls "read and frozen" — and
    // nothing has started yet. THAT is `pending`.
    await markPlanRequested(T, R, new Date().toISOString());
    expect(await compensationStatusForRun(T, R)).toBe('pending');

    await resolveObligation({ tenantId: T, inverseActionId: a.inverseActionId, to: 'started', reason: 'go' });
    await resolveObligation({ tenantId: T, inverseActionId: a.inverseActionId, to: 'completed' });
    expect(await compensationStatusForRun(T, R)).toBe('completed');
  });

  it('a plan that has MOVED reads correctly even without the stamp (pre-field rows)', async () => {
    // Migration leg. Rows minted before `planRequestedAt` existed carry no
    // stamp; if "no stamp" alone meant `none`, every in-flight unwind in
    // production would have re-read as "never started" the moment this shipped.
    // Progress is proof of request, so those rows fall through to the state
    // machine.
    const a = await commit(0);
    await resolveObligation({ tenantId: T, inverseActionId: a.inverseActionId, to: 'started', reason: 'go' });
    expect(await compensationStatusForRun(T, R)).toBe('running');
  });

  it('manual intervention outranks the rest — an operator is blocking', async () => {
    const a = await commit(0); await commit(1);
    await resolveObligation({ tenantId: T, inverseActionId: a.inverseActionId, to: 'manual_intervention_required', reason: 'ambiguous refund' });
    expect(await compensationStatusForRun(T, R)).toBe('manual');
  });
});

describe('ADR 0554 P1 — the P0 findings are representable', () => {
  it('an IRREVERSIBLE effect still records an obligation', async () => {
    // Omitting it would make the ledger read fully compensated when an email
    // went out. The obligation exists and is resolved `failed` WITH a reason.
    const row = await commit(0, { effectKind: 'email', shape: 'irreversible' });
    expect(row.shape).toBe('irreversible');
    const done = await resolveObligation({
      tenantId: T, inverseActionId: row.inverseActionId, to: 'failed',
      reason: 'email delivered; no inverse exists',
    });
    expect(done.reason).toMatch(/no inverse/);
    expect(await compensationStatusForRun(T, R)).toBe('failed');
  });

  it('author-declared exists so an UNKNOWN compensability is not defaulted to undoable', async () => {
    const row = await commit(0, { effectKind: 'network-egress', shape: 'author-declared' });
    expect(row.shape).toBe('author-declared');
  });

  it('the profile version is pinned and participates in identity', () => {
    expect(COMPENSATION_PROFILE_VERSION).toBe('1');
  });
});

describe('ADR 0554 P1 / ADR 0464 — subject erasure REDACTS, it does not delete', () => {
  it('clears the free-text reason and KEEPS the row', async () => {
    const row = await commit(0);
    await resolveObligation({
      tenantId: T, inverseActionId: row.inverseActionId, to: 'failed',
      reason: 'refund for jane@example.com bounced',
    });

    const n = await eraseCompensationSubject(T, 'subject-jane');
    expect(n).toBe(1);

    const after = await obligationsForRun(T, R);
    expect(after).toHaveLength(1);                       // the audit fact survives
    expect(after[0]!.reason).not.toMatch(/jane@/);       // the subject data does not
    expect(after[0]!.state).toBe('failed');              // and the outcome is intact
  });

  it('an UNRESOLVED obligation survives erasure — deleting it would fake a finished unwind', async () => {
    // The reason this eraser redacts. `compensationStatusForRun` answers "is
    // anything still owed?" by looking for non-terminal rows; deleting one on a
    // DSAR would flip a half-finished unwind to `completed`.
    const row = await commit(0);
    // It must carry a reason, or the eraser SKIPS it and this leg passes for the
    // wrong reason — it would survive whether the eraser redacted or deleted.
    // (Caught by sabotage: deleting instead of redacting left this green.)
    await resolveObligation({
      tenantId: T, inverseActionId: row.inverseActionId, to: 'paused',
      reason: 'awaiting approval from jane@example.com',
    });

    const n = await eraseCompensationSubject(T, 'subject-jane');
    expect(n).toBe(1);                                    // the eraser DID touch it

    expect(await compensationStatusForRun(T, R)).not.toBe('none');
    expect(await nextClaimable(T, R)).not.toBeNull();     // still owed, still claimable
  });

  it('does not touch another tenant\'s rows', async () => {
    const mine = await commit(0);
    await resolveObligation({ tenantId: T, inverseActionId: mine.inverseActionId, to: 'failed', reason: 'mine' });
    const theirs = await recordObligation({
      tenantId: 'tenant-b', runId: R, forwardLogicalInvocationId: 'inv-1', compensationOrdinal: 0,
      effectKind: 'payment', shape: 'forward-effect', resultDigest: 'd', contractDigest: 'c',
    });
    await resolveObligation({ tenantId: 'tenant-b', inverseActionId: theirs.inverseActionId, to: 'failed', reason: 'theirs' });

    await eraseCompensationSubject(T, 'subject-jane');
    expect((await obligationsForRun('tenant-b', R))[0]!.reason).toBe('theirs');
  });
});
