/**
 * ADR 0555 P1 — tamper tests for the per-dispatch capability contract.
 *
 * The threat model these pin is the one the P1 grounding survey settled on:
 * signing the envelope the HOST sends detects a worker tampering with its own
 * inputs, which is weak, because a compromised worker can simply lie about the
 * RESULT instead. So the binding runs the other way — every host-call and the
 * result present a per-dispatch bearer, and the host reads tenant / run / node /
 * pack / grant / authority from ITS OWN record.
 *
 * Each test therefore attacks the host's decision, not the worker's honesty:
 * a wrong token, a reused one, a cancelled or expired dispatch, a call outside
 * the grant, a result forged for a different dispatch, an oversized result, a
 * replayed envelope. Every one of them must be a TYPED refusal, and the two
 * that touch a seam must additionally prove the seam was never reached.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  __resetPackDispatchRegistryForTests,
  cancelDispatch,
  issueDispatch,
  peekDispatch,
  verifyDispatch,
} from '../src/host/packDispatchRegistry.js';
import { createPackHostCallBroker, enumerateCtxGrant, grantKey } from '../src/host/packHostCallBroker.js';
import { clearRunVariables, snapshotRunVariables } from '../src/host/variablesRuntime.js';
import type { DispatchBudget, DispatchResult } from '../src/host/packWorkerContract.js';
import type { NodeContext } from '../src/executor/types.js';

const RUN_ID = 'run-tamper';
const BUDGET: DispatchBudget = { wallClockMs: 30_000, maxHostCalls: 10, maxResultBytes: 4096 };

/** Calls the seams recorded; the tamper tests assert this stays EMPTY. */
let seamCalls: string[] = [];

/** A stand-in for the executor-built ctx: two real, callable host surfaces. */
function makeCtx(): NodeContext {
  return {
    runId: RUN_ID,
    nodeId: 'n1',
    tenantId: 't1',
    inputs: { value: 1 },
    configurable: {},
    attempt: 1,
    secrets: { 'byok:openai': 'sk-should-never-cross' },
    emit: async (type: string) => {
      seamCalls.push(`emit:${type}`);
      return { eventId: 'e1', sequence: 1 };
    },
    storage: {
      kv: {
        put: async (args: Record<string, unknown>) => {
          seamCalls.push(`storage.kv.put:${String(args.key)}`);
          return { ok: true };
        },
      },
    },
  };
}

function issue(overrides: Partial<Parameters<typeof issueDispatch>[0]> = {}) {
  const ctx = makeCtx();
  const grant = enumerateCtxGrant(ctx);
  const issued = issueDispatch({
    runId: RUN_ID,
    nodeId: 'n1',
    tenantId: 't1',
    typeId: 'community.test.tamper.echo',
    packName: 'community.test.tamper',
    packVersion: '1.0.0',
    effectCtx: { runId: RUN_ID, replaying: false },
    authority: null,
    grant,
    budget: BUDGET,
    ...overrides,
  });
  const broker = createPackHostCallBroker({ dispatchId: issued.dispatchId, ctx, grant });
  return { ctx, grant, issued, broker };
}

function successResult(): DispatchResult {
  return { status: 'success', outputs: { ok: true }, variablesWrites: [] };
}

beforeEach(() => {
  __resetPackDispatchRegistryForTests();
  clearRunVariables(RUN_ID);
  seamCalls = [];
});

describe('the grant is enumerated from the LIVE ctx', () => {
  it('names the callable surfaces and NEVER the data members or the never-brokered ones', () => {
    const grant = enumerateCtxGrant(makeCtx());
    expect(grant.has('emit')).toBe(true);
    expect(grant.has('storage.kv.put')).toBe(true);
    // `secrets` is a data member AND never-brokered; `inputs`/`configurable` are
    // data. None of them may appear as a callable grant key.
    expect([...grant].some((k) => k.startsWith('secrets'))).toBe(false);
    expect([...grant].some((k) => k.startsWith('inputs'))).toBe(false);
    expect([...grant].some((k) => k.startsWith('configurable'))).toBe(false);
  });
});

describe('token binding', () => {
  it('refuses a WRONG token, and the seam is never reached', async () => {
    const { issued, broker } = issue();
    const res = await broker.hostCall({
      dispatchId: issued.dispatchId,
      token: 'not-the-token',
      seq: 1,
      surface: '',
      method: 'emit',
      args: ['probe', {}],
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.code).toBe('dispatch_token_invalid');
    expect(seamCalls).toEqual([]);
  });

  it('refuses an UNKNOWN dispatch id', async () => {
    const { broker } = issue();
    const res = await broker.hostCall({
      dispatchId: 'pd_nope',
      token: 'anything',
      seq: 1,
      surface: '',
      method: 'emit',
      args: ['probe', {}],
    });
    expect(res.ok === false && res.error.code).toBe('dispatch_unknown');
    expect(seamCalls).toEqual([]);
  });

  it("refuses a VALID token presented to a DIFFERENT dispatch's broker", async () => {
    const a = issue();
    const b = issue();
    // b's token is genuine — it just does not belong to a's broker.
    const res = await a.broker.hostCall({
      dispatchId: b.issued.dispatchId,
      token: b.issued.token,
      seq: 1,
      surface: '',
      method: 'emit',
      args: ['probe', {}],
    });
    expect(res.ok === false && res.error.code).toBe('dispatch_unknown');
    expect(seamCalls).toEqual([]);
  });
});

describe('single use', () => {
  it('refuses a host-call after the result has been submitted', async () => {
    const { issued, broker } = issue();
    expect(broker.submitResult({ dispatchId: issued.dispatchId, token: issued.token, result: successResult() }).accepted).toBe(true);

    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 2, surface: '', method: 'emit', args: ['late', {}],
    });
    expect(res.ok === false && res.error.code).toBe('dispatch_completed');
    expect(seamCalls).toEqual([]);
  });

  it('refuses a SECOND result for the same dispatch — the CAS is not last-write-wins', () => {
    const { issued, broker } = issue();
    expect(broker.submitResult({ dispatchId: issued.dispatchId, token: issued.token, result: successResult() }).accepted).toBe(true);
    const second = broker.submitResult({
      dispatchId: issued.dispatchId,
      token: issued.token,
      result: { status: 'success', outputs: { ok: 'rewritten' }, variablesWrites: [] },
    });
    expect(second.accepted).toBe(false);
    expect(second.accepted === false && second.refusal).toBe('dispatch_completed');
  });

  it('makes a REPLAYED envelope inert: the same dispatch id + token cannot be used again', () => {
    const { issued, broker } = issue();
    broker.submitResult({ dispatchId: issued.dispatchId, token: issued.token, result: successResult() });
    // A worker that kept the envelope and "re-dispatched" it presents exactly
    // this pair. The record is no longer pending.
    const replay = verifyDispatch(issued.dispatchId, issued.token);
    expect(replay.ok).toBe(false);
    expect(replay.ok === false && replay.refusal).toBe('dispatch_completed');
  });
});

describe('lifecycle refusals', () => {
  it('refuses a host-call after cancel', async () => {
    const { issued, broker } = issue();
    cancelDispatch(issued.dispatchId);
    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1, surface: 'storage.kv', method: 'put', args: [{ key: 'k' }],
    });
    expect(res.ok === false && res.error.code).toBe('dispatch_cancelled');
    expect(seamCalls).toEqual([]);
  });

  it('refuses a host-call after the wall-clock budget expired', async () => {
    const { issued, broker } = issue({ nowMs: Date.now() - 10 * 60_000 });
    expect(peekDispatch(issued.dispatchId)?.expiresAtMs).toBeLessThan(Date.now());
    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1, surface: '', method: 'emit', args: ['late', {}],
    });
    expect(res.ok === false && res.error.code).toBe('dispatch_expired');
    expect(seamCalls).toEqual([]);
  });

  it('refuses host-calls past the budget ceiling', async () => {
    const { issued, broker } = issue({ budget: { ...BUDGET, maxHostCalls: 2 } });
    const call = (seq: number) => broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq, surface: '', method: 'emit', args: [`p${seq}`, {}],
    });
    expect((await call(1)).ok).toBe(true);
    expect((await call(2)).ok).toBe(true);
    const third = await call(3);
    expect(third.ok === false && third.error.code).toBe('dispatch_budget_exceeded');
    expect(seamCalls).toHaveLength(2);
  });
});

describe('the capability grant', () => {
  it('denies a call outside the grant WITHOUT touching the underlying seam', async () => {
    const ctx = makeCtx();
    // A grant that names `emit` only. `storage.kv.put` is present on the ctx and
    // fully callable — the ONLY thing standing between the worker and it is the
    // grant check, which is exactly what this asserts.
    const grant = new Set([grantKey('', 'emit')]);
    const issued = issueDispatch({
      runId: RUN_ID, nodeId: 'n1', tenantId: 't1',
      typeId: 'community.test.tamper.echo', packName: 'community.test.tamper', packVersion: '1.0.0',
      effectCtx: { runId: RUN_ID, replaying: false }, authority: null, grant, budget: BUDGET,
    });
    const broker = createPackHostCallBroker({ dispatchId: issued.dispatchId, ctx, grant });

    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1, surface: 'storage.kv', method: 'put', args: [{ key: 'k' }],
    });
    expect(res.ok === false && res.error.code).toBe('host_capability_denied');
    expect(seamCalls).toEqual([]);

    // Positive control: the granted member DOES reach its seam, so the denial
    // above cannot be passing because the harness is inert.
    const allowed = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 2, surface: '', method: 'emit', args: ['probe', {}],
    });
    expect(allowed.ok).toBe(true);
    expect(seamCalls).toEqual(['emit:probe']);
  });

  it('reports a granted-but-unwired surface as MISSING, not denied', async () => {
    const ctx = makeCtx();
    const grant = new Set(['knowledge.search']);
    const issued = issueDispatch({
      runId: RUN_ID, nodeId: 'n1', tenantId: 't1',
      typeId: 'community.test.tamper.echo', packName: 'community.test.tamper', packVersion: '1.0.0',
      effectCtx: { runId: RUN_ID, replaying: false }, authority: null, grant, budget: BUDGET,
    });
    const broker = createPackHostCallBroker({ dispatchId: issued.dispatchId, ctx, grant });
    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1, surface: 'knowledge', method: 'search', args: [{}],
    });
    expect(res.ok === false && res.error.code).toBe('host_capability_missing');
  });
});

describe('result validation', () => {
  it('refuses a result FORGED for another dispatch id', () => {
    const a = issue();
    const b = issue();
    const forged = a.broker.submitResult({
      dispatchId: b.issued.dispatchId,
      token: b.issued.token,
      result: successResult(),
    });
    expect(forged.accepted).toBe(false);
    expect(forged.accepted === false && forged.refusal).toBe('dispatch_unknown');
    // And b's own dispatch is untouched — the forgery did not consume it.
    expect(verifyDispatch(b.issued.dispatchId, b.issued.token).ok).toBe(true);
  });

  it('refuses an OVERSIZED result', () => {
    const { issued, broker } = issue({ budget: { ...BUDGET, maxResultBytes: 200 } });
    const out = broker.submitResult({
      dispatchId: issued.dispatchId,
      token: issued.token,
      result: { status: 'success', outputs: { blob: 'x'.repeat(500) }, variablesWrites: [] },
    });
    expect(out.accepted).toBe(false);
    expect(out.accepted === false && out.refusal).toBe('result_too_large');
    // The dispatch is NOT consumed by a refused result — it stays pending for
    // the dispatcher to cancel, rather than silently reading as completed.
    expect(peekDispatch(issued.dispatchId)?.state).toBe('pending');
  });

  it('preserves a pack failure CODE and rejects one outside the grammar', () => {
    const kept = issue();
    const a = kept.broker.submitResult({
      dispatchId: kept.issued.dispatchId,
      token: kept.issued.token,
      result: { status: 'failure', error: { code: 'policy_denied', message: 'nope' }, variablesWrites: [] },
    });
    expect(a.accepted).toBe(true);
    expect(a.accepted === true && a.result.status === 'failure' && a.result.error.code).toBe('policy_denied');

    const bad = issue();
    const b = bad.broker.submitResult({
      dispatchId: bad.issued.dispatchId,
      token: bad.issued.token,
      result: { status: 'failure', error: { code: 'Not A Code!!', message: 'nope' }, variablesWrites: [] },
    });
    expect(b.accepted).toBe(false);
    expect(b.accepted === false && b.refusal).toBe('result_error_code_invalid');
  });

  it("normalises a pack's SCREAMING_SNAKE code the way the in-process loader does", () => {
    const { issued, broker } = issue();
    const out = broker.submitResult({
      dispatchId: issued.dispatchId,
      token: issued.token,
      result: { status: 'failure', error: { code: 'HOST_CAPABILITY_MISSING', message: 'x' }, variablesWrites: [] },
    });
    expect(out.accepted === true && out.result.status === 'failure' && out.result.error.code).toBe('host_capability_missing');
  });
});

describe('variables write-behind', () => {
  it('applies writes on SUCCESS', () => {
    const { issued, broker } = issue();
    broker.submitResult({
      dispatchId: issued.dispatchId,
      token: issued.token,
      result: { status: 'success', outputs: {}, variablesWrites: [{ name: 'marker', value: 'written' }] },
    });
    expect(snapshotRunVariables(RUN_ID)?.marker).toBe('written');
  });

  it('does NOT apply writes on FAILURE — an isolated node contributes atomically or not at all', () => {
    const { issued, broker } = issue();
    broker.submitResult({
      dispatchId: issued.dispatchId,
      token: issued.token,
      result: { status: 'failure', error: { code: 'pack_node_error', message: 'x' }, variablesWrites: [{ name: 'marker', value: 'leaked' }] },
    });
    expect(snapshotRunVariables(RUN_ID)?.marker).toBeUndefined();
  });
});
