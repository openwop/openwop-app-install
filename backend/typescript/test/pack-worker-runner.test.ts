/**
 * ADR 0555 P1 — the WORKER side of the contract.
 *
 * These pin the split: which `NodeContext` members became serializable DATA,
 * which became RPC, and which are deliberately UNSUPPORTED. The P1 grounding
 * survey named the hazard exactly — "anything left neither serialized nor
 * brokered is silently unavailable inside the worker, and a pack that relies on
 * it fails only in isolation, which is the worst place to discover it" — so the
 * absences below are asserted as hard as the presences.
 *
 * Two invariants here are the survey's own two constraints, and both are
 * asserted end-to-end rather than by inspection:
 *
 *   - `SuspendSignal` is CONTROL FLOW, not an error. Without an explicit
 *     `suspended` arm a HITL interrupt degrades into `pack_node_error` and the
 *     run FAILS where it should PAUSE.
 *   - Error CODES survive the boundary. A naive `{ message }` serialization
 *     would erase exactly the codes that carry policy meaning.
 */

import { describe, it, expect } from 'vitest';

import { runIsolatedPackNode, type PackNodeFn } from '../src/host/packWorkerRunner.js';
import { mapSuspendKind } from '../src/executor/suspendSignal.js';
import {
  DISPATCH_PROTOCOL_VERSION,
  FAILURE_CODE_PATTERN,
  NotSerializableError,
  assertStructuredCloneSafe,
  normalizeFailureCode,
  type DispatchEnvelope,
  type HostCallResponse,
} from '../src/host/packWorkerContract.js';

function envelope(overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    protocol: DISPATCH_PROTOCOL_VERSION,
    dispatchId: 'pd_test',
    token: 'tok_test',
    typeId: 'community.test.runner.node',
    packName: 'community.test.runner',
    packVersion: '1.0.0',
    entryUrl: 'file:///unused',
    runId: 'run-runner',
    nodeId: 'n1',
    tenantId: 't1',
    inputs: { value: 42 },
    configurable: { flag: true },
    attempt: 1,
    trustBoundary: 'untrusted',
    budget: { wallClockMs: 5000, maxHostCalls: 10, maxResultBytes: 65_536 },
    capabilityGrant: ['emit', 'storage.kv.put'],
    variablesSnapshot: { seeded: 'from-host' },
    ...overrides,
  };
}

async function run(fn: PackNodeFn, env: DispatchEnvelope = envelope(), hostCall?: (surface: string, method: string, args: readonly unknown[]) => HostCallResponse) {
  return runIsolatedPackNode({
    envelope: env,
    loadNode: async () => fn,
    hostCall: async (req) => hostCall?.(req.surface, req.method, req.args) ?? { ok: true, value: { eventId: 'e', sequence: 1 } },
  });
}

describe('the envelope carries DATA, and never `secrets`', () => {
  it('a pack sees the run/node/tenant/inputs/config data members verbatim', async () => {
    let seen: Record<string, unknown> = {};
    const result = await run(async (ctx) => {
      seen = { ...(ctx as Record<string, unknown>) };
      return { status: 'success', outputs: {} };
    });
    expect(result.status).toBe('success');
    expect(seen.runId).toBe('run-runner');
    expect(seen.nodeId).toBe('n1');
    expect(seen.tenantId).toBe('t1');
    expect(seen.inputs).toEqual({ value: 42 });
    expect(seen.configurable).toEqual({ flag: true });
    expect(seen.attempt).toBe(1);
    // Always widened under isolation — never inherited from the run.
    expect(seen.trustBoundary).toBe('untrusted');
  });

  it('`secrets` is ABSENT — not an empty bag, not a stub', async () => {
    let hasKey = true;
    let value: unknown = 'unset';
    await run(async (ctx) => {
      hasKey = 'secrets' in (ctx as object);
      value = (ctx as { secrets?: unknown }).secrets;
      return { status: 'success', outputs: {} };
    });
    // `in` and not `!== undefined`: an empty `{}` reads to a pack as "the host
    // has no secrets for me", which is a different (and wrong) statement from
    // "this capability does not exist in isolation".
    expect(hasKey).toBe(false);
    expect(value).toBeUndefined();
  });

  it('the envelope OBJECT itself never carries a secrets key', () => {
    // Structural, so a future edit that "helpfully" threads secrets through the
    // envelope type fails here rather than at a pack.
    expect(Object.keys(envelope())).not.toContain('secrets');
  });
});

describe('granted capabilities become RPC', () => {
  it('a granted top-level member and a granted nested surface both reach the transport', async () => {
    const calls: Array<{ surface: string; method: string; args: readonly unknown[] }> = [];
    await run(
      async (ctx) => {
        const c = ctx as {
          emit(t: string, p: unknown): Promise<unknown>;
          storage: { kv: { put(a: unknown): Promise<unknown> } };
        };
        await c.emit('probe', { a: 1 });
        await c.storage.kv.put({ key: 'k', value: 'v' });
        return { status: 'success', outputs: {} };
      },
      envelope(),
      (surface, method, args) => {
        calls.push({ surface, method, args });
        return { ok: true, value: { ok: true } };
      },
    );
    expect(calls).toEqual([
      { surface: '', method: 'emit', args: ['probe', { a: 1 }] },
      { surface: 'storage.kv', method: 'put', args: [{ key: 'k', value: 'v' }] },
    ]);
  });

  it('a member OUTSIDE the grant is simply absent — the shape packs already handle', async () => {
    let shape = 'unset';
    await run(async (ctx) => {
      const c = ctx as { knowledge?: { search?: unknown } };
      shape = typeof c.knowledge?.search;
      return { status: 'success', outputs: {} };
    });
    expect(shape).toBe('undefined');
  });

  it('a host refusal arrives as a THROWN error carrying the code', async () => {
    const result = await run(
      async (ctx) => {
        await (ctx as { emit(t: string, p: unknown): Promise<unknown> }).emit('x', {});
        return { status: 'success', outputs: {} };
      },
      envelope(),
      () => ({ ok: false, error: { code: 'host_capability_denied', message: 'not granted' } }),
    );
    expect(result.status).toBe('failure');
    expect(result.status === 'failure' && result.error.code).toBe('host_capability_denied');
  });
});

describe('variables keep SYNCHRONOUS semantics', () => {
  it('reads the host snapshot, sees its own writes, and returns the write set', async () => {
    let readBack: unknown = 'unset';
    let seeded: unknown = 'unset';
    const result = await run(async (ctx) => {
      const v = (ctx as { variables: { get(n: string): unknown; set(n: string, x: unknown): void } }).variables;
      seeded = v.get('seeded');
      // SYNChronous by contract: no await, and the value must be readable back
      // immediately — a Promise-returning RPC could not preserve either.
      v.set('written', 'by-pack');
      readBack = v.get('written');
      return { status: 'success', outputs: {} };
    });
    expect(seeded).toBe('from-host');
    expect(readBack).toBe('by-pack');
    expect(result.variablesWrites).toEqual([{ name: 'written', value: 'by-pack' }]);
  });

  it('carries the writes made before a FAILURE too — the host decides whether to apply them', async () => {
    const result = await run(async (ctx) => {
      (ctx as { variables: { set(n: string, x: unknown): void } }).variables.set('partial', 1);
      throw Object.assign(new Error('boom'), { code: 'policy_denied' });
    });
    expect(result.status).toBe('failure');
    expect(result.variablesWrites).toEqual([{ name: 'partial', value: 1 }]);
  });
});

describe('suspend is a first-class RESULT ARM, not an error', () => {
  it('an un-resolved suspend becomes `suspended`, carrying kind + resumeKey + data', async () => {
    const result = await run(async (ctx) => {
      await (ctx as { suspend(p: Record<string, unknown>): Promise<unknown> }).suspend({
        reason: 'approval', resumeKey: 'gate-1', prompt: 'ok?',
      });
      return { status: 'success', outputs: { unreachable: true } };
    });
    expect(result.status).toBe('suspended');
    if (result.status !== 'suspended') return;
    expect(result.interrupt.kind).toBe('approval');
    expect(result.interrupt.resumeKey).toBe('gate-1');
    expect(result.interrupt.data.prompt).toBe('ok?');
  });

  it('a matching `suspendResolution` SHORT-CIRCUITS inline — the spec resume semantics', async () => {
    const result = await run(
      async (ctx) => {
        const answer = await (ctx as { interrupt(p: Record<string, unknown>): Promise<unknown> }).interrupt({
          reason: 'approval', resumeKey: 'gate-1',
        });
        return { status: 'success', outputs: { answer } };
      },
      envelope({ suspendResolution: { resumeKey: 'gate-1', value: { approved: true } } }),
    );
    expect(result.status).toBe('success');
    expect(result.status === 'success' && result.outputs.answer).toEqual({ approved: true });
  });

  it('a NON-matching resolution still suspends — the short-circuit is keyed, not blanket', async () => {
    const result = await run(
      async (ctx) => {
        await (ctx as { suspend(p: Record<string, unknown>): Promise<unknown> }).suspend({ reason: 'approval', resumeKey: 'gate-2' });
        return { status: 'success', outputs: {} };
      },
      envelope({ suspendResolution: { resumeKey: 'gate-1', value: 'other' } }),
    );
    expect(result.status).toBe('suspended');
  });

  it('the worker\'s kind mapping MIRRORS the host `mapSuspendKind` — pinned, not copied', async () => {
    // The worker cannot import the host module (that would be a host dependency
    // the transport cannot carry), so the duplication is pinned HERE. A change
    // to `mapSuspendKind` that this file does not mirror goes red.
    const cases = [
      'approval', 'low-confidence', 'duration', 'until', 'timer', 'clarification',
      'conversation-input', 'refinement', 'cancellation', 'external-event',
      'conversation', 'conversation.start', 'something-unknown',
    ];
    for (const reason of cases) {
      const result = await run(async (ctx) => {
        await (ctx as { suspend(p: Record<string, unknown>): Promise<unknown> }).suspend({ reason, resumeKey: 'k' });
        return { status: 'success', outputs: {} };
      });
      expect(result.status).toBe('suspended');
      if (result.status !== 'suspended') return;
      expect(result.interrupt.kind, `reason '${reason}'`).toBe(mapSuspendKind(reason));
    }
  });
});

describe('error codes survive the boundary (the loader rule, verbatim)', () => {
  it('a THROWN error keeps its own `.code`', async () => {
    const result = await run(async () => {
      throw Object.assign(new Error('denied by policy'), { code: 'policy_denied' });
    });
    expect(result.status === 'failure' && result.error.code).toBe('policy_denied');
    expect(result.status === 'failure' && result.error.message).toBe('denied by policy');
  });

  it('a thrown error with NO code becomes `pack_node_error`', async () => {
    const result = await run(async () => { throw new Error('plain'); });
    expect(result.status === 'failure' && result.error.code).toBe('pack_node_error');
  });

  it('a RETURNED failure keeps its own code (the CHAINX-5 rule)', async () => {
    const result = await run(async () => ({ status: 'failed', error: { code: 'already_enrolled', message: 'dup' } }));
    expect(result.status === 'failure' && result.error.code).toBe('already_enrolled');
  });

  it('`host_capability_missing` keeps the loader\'s guide pointer', async () => {
    const result = await run(async () => {
      throw Object.assign(new Error('no ctx.fs'), { code: 'host_capability_missing' });
    });
    expect(result.status === 'failure' && result.error.message).toContain('.well-known/openwop');
  });
});

describe('protocol + serializability', () => {
  it('refuses an envelope whose protocol version it does not speak', async () => {
    const result = await run(
      async () => ({ status: 'success', outputs: {} }),
      { ...envelope(), protocol: 99 as unknown as typeof DISPATCH_PROTOCOL_VERSION },
    );
    expect(result.status === 'failure' && result.error.code).toBe('pack_isolation_protocol_unsupported');
  });

  it('`assertStructuredCloneSafe` rejects a function and a platform object like `Response`', () => {
    expect(() => assertStructuredCloneSafe({ f: () => 1 }, 'x', 'not_serializable')).toThrow(NotSerializableError);
    // This is why `http.safeFetch` is never brokered: it returns a live
    // `Response`, and a real `postMessage` transport rejects it outright.
    expect(() => assertStructuredCloneSafe({ r: new Response('x') }, 'x', 'not_serializable')).toThrow(NotSerializableError);
    // A plain data payload passes and comes back as a COPY, not the input.
    const input = { a: [1, 2], b: { c: 'd' } };
    const out = assertStructuredCloneSafe(input, 'x', 'not_serializable');
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('records the LOSSY case the predicate does NOT catch: an ordinary class instance', () => {
    // MEASURED, and recorded because it would otherwise read as a gap in the
    // guard. `structuredClone` does not throw on a plain class instance — it
    // drops the prototype and keeps the own data properties. So a host seam
    // returning a class with behaviour on its prototype crosses the boundary as
    // a plain object whose METHODS are gone, silently.
    //
    // That is a real limit of the predicate, not of the implementation: it is
    // exactly what a `postMessage` transport would do too, so the fake adapter
    // is being faithful. The mitigation is the same one P2 inherits — a surface
    // whose return value carries behaviour belongs in `NEVER_BROKERED`, and
    // this test exists so the next person adding one knows the failure is
    // silent rather than typed.
    class Live { constructor(readonly data = 1) {} m(): number { return 2; } }
    const cloned = assertStructuredCloneSafe({ r: new Live() }, 'x', 'not_serializable');
    expect(cloned.r.data).toBe(1);
    expect(typeof (cloned.r as { m?: unknown }).m).toBe('undefined');
  });

  it('the failure-code grammar admits the host error classes and rejects Node errno codes', () => {
    for (const ok of ['policy_denied', 'replay_source_missing', 'mcp_not_connected', 'model_not_allowed', 'host_capability_disabled']) {
      expect(FAILURE_CODE_PATTERN.test(ok), ok).toBe(true);
    }
    // The grammar IS the leak filter: Node's errno codes are SCREAMING_SNAKE.
    for (const bad of ['ENOENT', 'ECONNREFUSED', 'EPIPE', 'a', 'has spaces', 'Mixed_Case']) {
      expect(FAILURE_CODE_PATTERN.test(bad), bad).toBe(false);
    }
    // Pack casing is normalised (the loader already matches case-insensitively).
    expect(normalizeFailureCode('HOST_CAPABILITY_MISSING')).toBe('host_capability_missing');
    expect(normalizeFailureCode('not a code')).toBeNull();
    expect(normalizeFailureCode(undefined)).toBeNull();
  });
});

/**
 * H82 follow-up — a host call refused by the ADR 0531 REPLAY GUARD keeps its
 * code all the way out of the worker.
 *
 * WHY THIS EXISTS. H82 fixed a site where the guard's `ReplayEffectError` was
 * caught and re-wrapped, losing the TYPE — and `executor.ts`'s node-failure
 * allowlist is `instanceof`-based, so the code degraded to the wrapper's. The
 * obvious question is whether the PACK path has the same hole, since a refusal
 * crosses the sandbox boundary as DATA (`{ ok: false, error: { code } }`) and
 * is rebuilt worker-side as a plain `Error` — which is not an instance of
 * anything the executor allowlists.
 *
 * It does not, and the reason is worth pinning rather than re-deriving: every
 * hop on this path matches on the VALUE, not the class.
 *
 *   1. `packHostCallBroker.errorResponse` keeps any lowercase-snake `.code`
 *      (`FAILURE_CODE_PATTERN`) — a grammar, immune to re-wrapping;
 *   2. `packWorkerRunner`'s `call()` rebuilds `Error` + `.code` worker-side;
 *   3. the loader rule here keeps a thrown error's own `.code`, else
 *      `pack_node_error` — and returns a FAILURE OUTCOME, so it never reaches
 *      the `instanceof` allowlist that H82's site did.
 *
 * A type check would have broken at step 2, where the class cannot survive a
 * structured-clone boundary by construction. The grammar is what makes this
 * path immune, so this test asserts the OUTCOME CODE — the thing that would
 * change if any hop started reconstructing types instead of reading values.
 */
describe('H82 — a replay-guard refusal survives the sandbox boundary as itself', () => {
  it('keeps `replay_source_missing` rather than degrading to pack_node_error', async () => {
    const result = await run(
      async (ctx) => {
        const c = ctx as { emit(t: string, p: unknown): Promise<unknown> };
        // Deliberately NOT wrapped in try/catch: a pack that swallowed this
        // would report its own failure, and the question here is what the
        // runner does with an unhandled refusal.
        await c.emit('probe', { a: 1 });
        return { status: 'success', outputs: {} };
      },
      envelope(),
      () => ({
        ok: false,
        error: {
          code: 'replay_source_missing',
          message: "Replay fork: a 'network-egress' effect was attempted during replay",
        },
      }),
    );

    expect(result.status).toBe('failure');
    // The whole point: NOT 'pack_node_error', NOT 'internal_error'.
    expect((result as { error?: { code?: string } }).error?.code).toBe('replay_source_missing');
  });
});
