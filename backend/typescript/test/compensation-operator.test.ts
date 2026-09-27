/**
 * RFC 0151 §E — operator authority over a held compensation plan
 * (ADR 0554 wire flip, the §21 "Recovery extension" half).
 *
 * WHY THIS FILE EXISTS BESIDE THE CONFORMANCE WITNESS. The suite's
 * `compensation-recovery.test.ts` drives the same decision black-box through the
 * §21 seam, which is the right level for "does the wire behave". It cannot see
 * the thing most likely to rot: that the seam and a future Operations route
 * share ONE decision function. A second implementation on the route would pass
 * the black-box witness on the seam's path and be wrong on the one that matters.
 *
 * The three arms are asserted for what they are, not just their status codes:
 *
 *   - cross-tenant is **404 and UNAUDITED on the plan**. RFC 0132 §A.2 says
 *     neutralize, do not reveal — and an audit record written into a run the
 *     actor must not know exists would leak that existence through the audit
 *     trail the refusal just protected. It would also let an unauthenticated
 *     prober append to another tenant's event log, one record per guess.
 *   - same-tenant-without-authority is **403 AND audited**, because the actor
 *     is already inside the tenant, so the record leaks nothing they could not
 *     see, and a refused override is exactly what an incident review needs.
 *   - the operator is **200 AND audited**, on the same event type.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getEventLog, setEventLogBackend } from '../src/executor/eventLog.js';
import {
  COMPENSATION_OPERATOR_ACTIONS,
  applyOperatorDisposition,
  decideCompensationOperatorAction,
} from '../src/host/compensationOperator.js';
import {
  _resetCompensationLedgerForTest,
  compensationStatusForRunTree,
  digestOf,
  nextCompensationOrdinal,
  recordObligation,
  resolveObligation,
} from '../src/host/compensationLedger.js';
import type { RunRecord } from '../src/types.js';

const T = 'tenant-operator';
/**
 * A FRESH run id per test. The event log is append-only and shared across the
 * file, so a fixed id would let one test's `authorization.decided` records be
 * counted by the next — which is how an assertion on "exactly one record" turns
 * into an assertion on test ordering.
 */
let RUN_ID = 'run-held-0';
let seq = 0;

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: RUN_ID,
    tenantId: T,
    workflowId: 'wf.payments',
    status: 'failed',
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as RunRecord;
}

/** A held obligation — the state an operator is asked to act on. */
async function held(nodeId = 'charge-1') {
  const row = await recordObligation({
    tenantId: T,
    runId: RUN_ID,
    rootRunId: RUN_ID,
    nodeId,
    compensationNodeTypeId: 'test.payment.refund',
    forwardLogicalInvocationId: `${RUN_ID}:${nodeId}`,
    compensationOrdinal: await nextCompensationOrdinal(T, RUN_ID),
    effectKind: 'payment',
    shape: 'forward-effect',
    resultDigest: digestOf({ charged: nodeId }),
    contractDigest: digestOf({ refund: true }),
  });
  await resolveObligation({
    tenantId: T,
    inverseActionId: row.inverseActionId,
    to: 'manual_intervention_required',
    reason: 'held for operator',
  });
  return row;
}

async function decisionEvents(): Promise<Array<Record<string, unknown>>> {
  const events = await getEventLog().list(RUN_ID, { fromSeq: -1, limit: 1000 });
  return events
    .filter((e) => e.type === 'authorization.decided')
    .map((e) => e.payload as Record<string, unknown>);
}

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setEventLogBackend(storage);
});

beforeEach(async () => {
  await _resetCompensationLedgerForTest();
  seq += 1;
  RUN_ID = `run-held-${seq}`;
});

describe('RFC 0151 §E — the authority decision', () => {
  it('a CROSS-TENANT actor gets 404 `not_found`, never 403', async () => {
    // A 403 would confirm the run id names a real plan, which is the single
    // thing the cross-tenant rule withholds. Operator authority in the WRONG
    // tenant buys nothing — the actor below has `operator: true`.
    const d = await decideCompensationOperatorAction({
      run: run(),
      actor: { tenantId: 'some-other-tenant', principalId: 'p1', operator: true },
      action: 'retry',
    });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.status).toBe(404);
    expect(d.allowed === false && d.code).toBe('not_found');
  });

  it('and writes NO audit record onto the plan — the refusal must not leak through the audit trail', async () => {
    await decideCompensationOperatorAction({
      run: run(),
      actor: { tenantId: 'some-other-tenant', principalId: 'prober', operator: true },
      action: 'retry',
    });
    expect(
      await decisionEvents(),
      'an audit record in a run the actor must not know exists reveals it exists — and lets a prober '
        + 'append to another tenant\'s event log, one record per guess',
    ).toEqual([]);
  });

  it('a SAME-TENANT non-operator gets 403 AND is audited', async () => {
    const d = await decideCompensationOperatorAction({
      run: run(),
      actor: { tenantId: T, principalId: 'bystander', operator: false },
      action: 'retry',
    });
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.status).toBe(403);
    const events = await decisionEvents();
    expect(events, '§21: "the refusal MUST also be audited"').toHaveLength(1);
    expect(events[0]).toMatchObject({
      principal: 'bystander',
      action: 'compensation:retry',
      resource: RUN_ID,
      allowed: false,
      reason: 'authority-denied',
    });
  });

  it('the OPERATOR is allowed AND audited, on the same event type', async () => {
    const d = await decideCompensationOperatorAction({
      run: run(),
      actor: { tenantId: T, principalId: 'op', operator: true },
      action: 'retry',
    });
    expect(d.allowed).toBe(true);
    const events = await decisionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ principal: 'op', allowed: true });
  });

  it('the audit payload carries ONLY the closed RFC 0049 keys', async () => {
    // `run-event-payloads.schema.json` `authorizationDecided` is
    // `additionalProperties: false`, so a fifth key is rejected by any peer
    // validating the event — and an actor's free text is the worst candidate
    // for the durable log.
    await decideCompensationOperatorAction({
      run: run(),
      actor: { tenantId: T, principalId: 'op', operator: true },
      action: 'terminate',
    });
    const [payload] = await decisionEvents();
    expect(Object.keys(payload ?? {}).sort()).toEqual(
      ['action', 'allowed', 'principal', 'reason', 'resource'],
    );
  });

  it('every §21 action is decided the same way — authority is not per-action', async () => {
    // A per-action allowlist would be a second role model. §21 defines
    // `operator: true` as "holds operator authority in `actor.tenantId`", full
    // stop, and the disposition's own preconditions are checked separately.
    for (const action of COMPENSATION_OPERATOR_ACTIONS) {
      const refused = await decideCompensationOperatorAction({
        run: run(), actor: { tenantId: T, principalId: 'b', operator: false }, action,
      });
      expect(refused.allowed, `${action} must be refused for a non-operator`).toBe(false);
      const allowed = await decideCompensationOperatorAction({
        run: run(), actor: { tenantId: T, principalId: 'op', operator: true }, action,
      });
      expect(allowed.allowed, `${action} must be allowed for an operator`).toBe(true);
    }
  });
});

describe('RFC 0151 §E — dispositions move the plan off `manual`', () => {
  it('`terminate` resolves the held entries so the rollup stops asking for a human', async () => {
    await held();
    expect(await compensationStatusForRunTree(T, RUN_ID)).toBe('manual');
    const moved = await applyOperatorDisposition({ run: run(), action: 'terminate' });
    expect(moved).toBe(1);
    const after = await compensationStatusForRunTree(T, RUN_ID);
    expect(after, 'a resolved hold must not still read `manual`').not.toBe('manual');
    expect(after).toBe('failed');
  });

  it('`skip` records the operator justification on the row, not on the wire', async () => {
    // §D's closed `reason` vocabulary has no code for "an operator chose to skip
    // this", so the justification lands on the ledger row's host-local free text
    // — the same call `compensation.paused` makes for the same reason.
    const row = await held();
    await applyOperatorDisposition({ run: run(), action: 'skip', justification: 'refunded out of band' });
    const { obligationsForRunTree } = await import('../src/host/compensationLedger.js');
    const after = (await obligationsForRunTree(T, RUN_ID)).find((o) => o.inverseActionId === row.inverseActionId);
    expect(after?.state).toBe('failed');
    expect(String(after?.reason)).toContain('refunded out of band');
  });

  it('leaves a COMPLETED entry alone — an operator disposition never re-opens a discharged inverse', async () => {
    const done = await held('charge-done');
    await resolveObligation({ tenantId: T, inverseActionId: done.inverseActionId, to: 'started', reason: 'x' });
    await resolveObligation({ tenantId: T, inverseActionId: done.inverseActionId, to: 'completed' });
    const moved = await applyOperatorDisposition({ run: run(), action: 'terminate' });
    expect(moved, 'nothing was held — a completed inverse is terminal').toBe(0);
    expect(await compensationStatusForRunTree(T, RUN_ID)).toBe('completed');
  });
});
