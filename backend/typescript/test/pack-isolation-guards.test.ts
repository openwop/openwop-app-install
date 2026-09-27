/**
 * ADR 0555 P1 — the load-bearing suite: the ADR 0531 effect guard and the
 * ADR 0556 P3 authority record SURVIVE the isolation boundary.
 *
 * `host/runEffectContext.ts` states the risk in its own header: AsyncLocalStorage
 * propagates through `await` but NOT across a process boundary, so "if pack
 * execution ever moves out-of-process … this backstop degrades SILENTLY to no
 * guard and the host side of that boundary must re-establish it."
 *
 * SILENTLY is the word that matters. A degraded guard has no symptom: effects
 * simply start firing during replays, every test stays green, and the failure
 * surfaces as duplicate real-world side effects. So these tests do not assert
 * that the guard exists — they assert it FIRES THROUGH THE BROKER, which is the
 * only place it can be re-established.
 *
 * SABOTAGE VERIFIED. Deleting the `runWithEffectContext` wrapper in
 * `packHostCallBroker.ts` makes the replay tests below go red (the effect is
 * ALLOWED, because `assertEffectAllowed` returns early when there is no ambient
 * context — the fail-OPEN branch). Deleting the `runWithAuthority` wrapper makes
 * the authority tests go red (`recordAuthorityAction` no-ops without ambient
 * authority, so nothing is recorded).
 *
 * The executor's isolated branch is deliberately NOT nested inside its own
 * `runWithEffectContext`; if it were, the fake in-process adapter would inherit
 * the ambient context and both sabotages would still pass.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  __resetPackDispatchRegistryForTests,
  issueDispatch,
} from '../src/host/packDispatchRegistry.js';
import { createPackHostCallBroker } from '../src/host/packHostCallBroker.js';
import {
  assertEffectAllowed,
  currentEffectContext,
  type EffectKind,
  type RunEffectContext,
} from '../src/host/runEffectContext.js';
import { currentAuthority, type AuthorityFacts } from '../src/host/authorityContext.js';
import { createFakeIsolationAdapter } from '../src/host/isolationAdapter.js';
import { runIsolatedPackNode } from '../src/host/packWorkerRunner.js';
import { DISPATCH_PROTOCOL_VERSION, type DispatchEnvelope } from '../src/host/packWorkerContract.js';
import type { NodeContext } from '../src/executor/types.js';

const RUN_ID = 'run-guards';

const FACTS: AuthorityFacts = {
  actor: 'workload:test:abcdef',
  actorKind: 'workload',
  workload: 'workload:test:abcdef',
  senderConstraint: 'none',
  delegationDepth: 0,
  scopes: [],
  recorded: false,
  correlationId: 'corr-guards',
};

/** What the seam observed when it ran. Empty ⇒ the seam never ran. */
let observed: Array<{ effect: RunEffectContext | undefined; authority: AuthorityFacts | undefined }> = [];
let effectFired = 0;

/**
 * A ctx whose one surface behaves like a REAL guarded effect seam: it calls
 * `assertEffectAllowed` before doing the deed, exactly as
 * `notifications/emitter.ts` and `host/brokeredEgress.ts` do.
 */
function makeCtx(kind: EffectKind = 'notification'): NodeContext {
  return {
    runId: RUN_ID,
    nodeId: 'n1',
    tenantId: 't1',
    inputs: {},
    configurable: {},
    attempt: 1,
    secrets: {},
    emit: async () => ({ eventId: 'e', sequence: 1 }),
    storage: {
      kv: {
        put: async () => {
          observed.push({ effect: currentEffectContext(), authority: currentAuthority() });
          // Guard FIRST, effect second — the seam ordering the guard relies on.
          assertEffectAllowed(kind, 'isolation guard probe');
          effectFired += 1;
          return { ok: true };
        },
      },
    },
  };
}

function brokerFor(opts: {
  replaying: boolean;
  authority: AuthorityFacts | null;
  observedEffectKinds?: Set<EffectKind>;
}) {
  const ctx = makeCtx();
  const grant = new Set(['storage.kv.put']);
  const effectCtx: RunEffectContext = {
    runId: RUN_ID,
    replaying: opts.replaying,
    ...(opts.observedEffectKinds ? { observedEffectKinds: opts.observedEffectKinds } : {}),
  };
  const issued = issueDispatch({
    runId: RUN_ID, nodeId: 'n1', tenantId: 't1',
    typeId: 'community.test.guards.effect', packName: 'community.test.guards', packVersion: '1.0.0',
    effectCtx, authority: opts.authority, grant,
    budget: { wallClockMs: 30_000, maxHostCalls: 10, maxResultBytes: 65_536 },
  });
  return { issued, broker: createPackHostCallBroker({ dispatchId: issued.dispatchId, ctx, grant }) };
}

beforeEach(() => {
  __resetPackDispatchRegistryForTests();
  observed = [];
  effectFired = 0;
});

describe('the harness is not vacuous', () => {
  it('the probe seam really fires an effect when nothing guards it', async () => {
    // No ambient context at all — `assertEffectAllowed` legitimately allows
    // (routes and daemons are not replays). If this ever stopped firing, every
    // "did NOT fire" assertion below would pass for the wrong reason.
    const ctx = makeCtx();
    await ctx.storage!.kv!.put({});
    expect(effectFired).toBe(1);
    expect(observed[0]?.effect).toBeUndefined();
  });
});

describe('ADR 0531 effect guard across the boundary', () => {
  it('a REPLAY effect attempted through the broker is refused, and the code round-trips', async () => {
    const { issued, broker } = brokerFor({ replaying: true, authority: null });
    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1,
      surface: 'storage.kv', method: 'put', args: [{ key: 'k' }],
    });

    expect(res.ok).toBe(false);
    // The SAME code the ADR 0341 fast path emits — one invariant, one code, on
    // both sides of the boundary.
    expect(res.ok === false && res.error.code).toBe('replay_source_missing');
    // The seam was entered (so the guard, not the grant, is what stopped it)…
    expect(observed).toHaveLength(1);
    // …and it saw the run's replay context, re-established host-side.
    expect(observed[0]?.effect?.replaying).toBe(true);
    expect(observed[0]?.effect?.runId).toBe(RUN_ID);
    // …and the effect did NOT happen.
    expect(effectFired).toBe(0);
  });

  it('a LIVE effect through the broker is allowed and is MEASURED into observedEffectKinds', async () => {
    const kinds = new Set<EffectKind>();
    const { issued, broker } = brokerFor({ replaying: false, authority: null, observedEffectKinds: kinds });
    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1,
      surface: 'storage.kv', method: 'put', args: [{ key: 'k' }],
    });

    expect(res.ok).toBe(true);
    expect(effectFired).toBe(1);
    // ADR 0554 P2's compensation classification is measured at the guard's allow
    // branch. If the context did not cross, the set would be empty and the
    // obligation would be classified from nothing.
    expect([...kinds]).toEqual(['notification']);
  });

  it('the guard survives an AWAIT inside the seam — propagation, not call-stack proximity', async () => {
    const ctx: NodeContext = {
      runId: RUN_ID, nodeId: 'n1', tenantId: 't1', inputs: {}, configurable: {}, attempt: 1, secrets: {},
      emit: async () => ({ eventId: 'e', sequence: 1 }),
      storage: {
        kv: {
          put: async () => {
            await new Promise((r) => setTimeout(r, 1));
            assertEffectAllowed('notification', 'after await');
            effectFired += 1;
            return { ok: true };
          },
        },
      },
    };
    const grant = new Set(['storage.kv.put']);
    const issued = issueDispatch({
      runId: RUN_ID, nodeId: 'n1', tenantId: 't1',
      typeId: 'community.test.guards.effect', packName: 'community.test.guards', packVersion: '1.0.0',
      effectCtx: { runId: RUN_ID, replaying: true }, authority: null, grant,
      budget: { wallClockMs: 30_000, maxHostCalls: 10, maxResultBytes: 65_536 },
    });
    const broker = createPackHostCallBroker({ dispatchId: issued.dispatchId, ctx, grant });
    const res = await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1, surface: 'storage.kv', method: 'put', args: [{}],
    });
    expect(res.ok === false && res.error.code).toBe('replay_source_missing');
    expect(effectFired).toBe(0);
  });

  it('reaches the pack as a THROWN error carrying the code, so pack logic can react', async () => {
    // Full round trip: the worker runner turns the broker's refusal back into a
    // worker-local Error with `.code`, which the loader rule then preserves into
    // the failure result. `replay_source_missing` must survive both hops.
    const { issued, broker } = brokerFor({ replaying: true, authority: null });
    const envelope: DispatchEnvelope = {
      protocol: DISPATCH_PROTOCOL_VERSION,
      dispatchId: issued.dispatchId,
      token: issued.token,
      typeId: 'community.test.guards.effect',
      packName: 'community.test.guards',
      packVersion: '1.0.0',
      entryUrl: 'file:///unused',
      runId: RUN_ID, nodeId: 'n1', tenantId: 't1',
      inputs: {}, configurable: {}, attempt: 1, trustBoundary: 'untrusted',
      budget: { wallClockMs: 30_000, maxHostCalls: 10, maxResultBytes: 65_536 },
      capabilityGrant: ['storage.kv.put'],
      variablesSnapshot: {},
    };
    const adapter = createFakeIsolationAdapter({
      loadNode: async () => async (ctx: unknown) => {
        const c = ctx as { storage: { kv: { put(a: unknown): Promise<unknown> } } };
        await c.storage.kv.put({ key: 'k' });
        return { status: 'success', outputs: {} };
      },
    });
    const result = await adapter.dispatch(envelope, broker);
    expect(result.status).toBe('failure');
    expect(result.status === 'failure' && result.error.code).toBe('replay_source_missing');
    expect(effectFired).toBe(0);
  });
});

describe('ADR 0556 P3 authority across the boundary', () => {
  it('the seam runs under the dispatch record\'s authority facts', async () => {
    const { issued, broker } = brokerFor({ replaying: false, authority: FACTS });
    await broker.hostCall({
      dispatchId: issued.dispatchId, token: issued.token, seq: 1,
      surface: 'storage.kv', method: 'put', args: [{}],
    });
    expect(observed[0]?.authority).toBeDefined();
    expect(observed[0]?.authority?.actor).toBe(FACTS.actor);
    expect(observed[0]?.authority?.correlationId).toBe('corr-guards');
  });

  it('recordAuthorityAction actually FIRES — the effect seam writes an authority.action record', async () => {
    // `recordAuthorityAction` no-ops without ambient authority, so its log line
    // is the direct evidence that `runWithAuthority` was re-established. The
    // allow branch of `assertEffectAllowed` is the call site.
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const { issued, broker } = brokerFor({ replaying: false, authority: FACTS });
      await broker.hostCall({
        dispatchId: issued.dispatchId, token: issued.token, seq: 1,
        surface: 'storage.kv', method: 'put', args: [{}],
      });
    } finally {
      spy.mockRestore();
    }
    const record = lines
      .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .find((o) => o?.msg === 'authority.action' && o?.seam === 'effect');
    expect(record).toBeDefined();
    expect(record?.['openwop.actor.principal']).toBe(FACTS.actor);
  });

  it('records NOTHING when the record carries no authority — an unconfigured host has one identity, not two', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const { issued, broker } = brokerFor({ replaying: false, authority: null });
      await broker.hostCall({
        dispatchId: issued.dispatchId, token: issued.token, seq: 1,
        surface: 'storage.kv', method: 'put', args: [{}],
      });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => l.includes('authority.action'))).toBe(false);
    expect(observed[0]?.authority).toBeUndefined();
  });
});

describe('the worker runner is transport-agnostic', () => {
  it('runs with nothing but an envelope, a loader and a hostCall function', async () => {
    // No registry, no broker, no host imports. If this ever needs one, the
    // boundary has been broken.
    const calls: string[] = [];
    const result = await runIsolatedPackNode({
      envelope: {
        protocol: DISPATCH_PROTOCOL_VERSION,
        dispatchId: 'pd_x', token: 'tok',
        typeId: 't', packName: 'p', packVersion: '1.0.0', entryUrl: 'file:///unused',
        runId: RUN_ID, nodeId: 'n1', tenantId: 't1',
        inputs: { a: 1 }, configurable: {}, attempt: 1, trustBoundary: 'untrusted',
        budget: { wallClockMs: 1000, maxHostCalls: 5, maxResultBytes: 4096 },
        capabilityGrant: ['emit'],
        variablesSnapshot: {},
      },
      loadNode: async () => async (ctx: unknown) => {
        await (ctx as { emit(t: string, p: unknown): Promise<unknown> }).emit('probe', {});
        return { status: 'success', outputs: { ok: true } };
      },
      hostCall: async (req) => { calls.push(`${req.surface}|${req.method}`); return { ok: true, value: { eventId: 'e', sequence: 1 } }; },
    });
    expect(result.status).toBe('success');
    expect(calls).toEqual(['|emit']);
  });
});
