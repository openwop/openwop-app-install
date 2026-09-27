/**
 * ADR 0555 P2 — the CONTRACT still holds through a real process boundary.
 *
 * The escape suite (`pack-isolation-escape.test.ts`) proves the adapter
 * contains. This one proves it did not break anything P1 established while
 * doing so — which is the failure mode a containment change most easily hides,
 * because a broken suspend or a flattened `Date` looks like a pack bug.
 *
 * Everything here runs in a REAL forked isolate. The four properties P1 could
 * only demonstrate against an in-process fake are re-proved where they now have
 * to survive serialization and a process boundary:
 *
 *   - `SuspendSignal` becomes the `suspended` arm, and a resume re-invoke is
 *     seeded (HITL interrupts must PAUSE the run, not fail it)
 *   - a thrown error's `.code` survives, so `policy_denied` does not flatten to
 *     `pack_node_error`
 *   - the ADR 0531 effect guard and the ADR 0556 P3 authority record fire at the
 *     brokered seam — `runEffectContext.ts` names this exact boundary as where
 *     AsyncLocalStorage stops and the guard would degrade SILENTLY
 *   - `ctx.variables` reads its snapshot and its writes come back
 *
 * Plus the two things only P2 introduces: the transport's serialization
 * fidelity, and the guarantee/tier comparison that refuses rather than
 * downgrades.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { __resetPackDispatchRegistryForTests, peekDispatch } from '../src/host/packDispatchRegistry.js';
import { createFakeIsolationAdapter } from '../src/host/isolationAdapter.js';
import {
  CHILD_ADAPTER_ID,
  childAdapterGuarantees,
  createChildProcessIsolationAdapter,
} from '../src/host/isolation/childProcessAdapter.js';
import { admitAdapterForTier } from '../src/host/packIsolationPolicy.js';
import { unmetGuarantees, NO_GUARANTEES, TIER_REQUIRED_GUARANTEES } from '../src/host/isolationGuarantees.js';
import { isolationAdapterId, __resetIsolationAdaptersForTests, adapterFor, dispatchPackNodeIsolated } from '../src/host/packIsolationDispatch.js';
import { ISOLATION_ADAPTER_UNAVAILABLE_CODE, ISOLATION_GUARANTEE_UNMET_CODE } from '../src/host/packWorkerContract.js';
import { assertEffectAllowed, type RunEffectContext } from '../src/host/runEffectContext.js';
import { currentAuthority, type AuthorityFacts } from '../src/host/authorityContext.js';
import { runProbe, writeProbePack } from './support/isolatedPack.js';

const entryBroken = vi.hoisted(() => ({ value: false }));
vi.mock('../src/host/isolation/workerEntry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/isolation/workerEntry.js')>();
  return {
    ...actual,
    resolveWorkerEntry: () =>
      entryBroken.value
        ? Promise.resolve({ ok: false as const, reason: 'forced unavailable (test)' })
        : actual.resolveWorkerEntry(),
  };
});

const FACTS: AuthorityFacts = {
  actor: 'workload:test:p2',
  actorKind: 'workload',
  workload: 'workload:test:p2',
  senderConstraint: 'none',
  delegationDepth: 0,
  scopes: [],
  recorded: false,
  correlationId: 'corr-p2',
};

beforeEach(() => {
  __resetPackDispatchRegistryForTests();
  __resetIsolationAdaptersForTests();
  entryBroken.value = false;
});

/* ── transport fidelity ───────────────────────────────────────────────────── */

describe('SERIALIZATION: the transport implements the contract, it does not approximate it', () => {
  it('Date, Map, Set and Buffer survive the boundary with their types intact', async () => {
    // `fork()` defaults to JSON serialization, under which ALL FOUR of these are
    // silently mangled (Date → String, Map/Set/Buffer → {}). P1's contract is
    // defined by `structuredClone`, so the default would have corrupted every
    // typed host-call value with nothing anywhere to notice.
    //
    // SABOTAGE: change `serialization` in `childProcessAdapter.ts` to 'json' and
    // this is the test that goes red.
    const dir = writeProbePack(`
      const v = await ctx.typed.get();
      await ctx.report({
        d: Object.prototype.toString.call(v.d),
        m: Object.prototype.toString.call(v.m),
        s: Object.prototype.toString.call(v.s),
        b: Object.prototype.toString.call(v.b),
        mapValue: v.m instanceof Map ? v.m.get('a') : null,
        setSize: v.s instanceof Set ? v.s.size : null,
      });
      return { status: 'success', outputs: {} };`);
    const run = await runProbe(dir, {
      grant: ['typed.get'],
      ctx: {
        typed: {
          get: async () => ({ d: new Date(0), m: new Map([['a', 1]]), s: new Set([1, 2]), b: Buffer.from('hi') }),
        },
      } as never,
    });
    expect(run.result.status).toBe('success');
    expect(run.reported[0]).toEqual({
      d: '[object Date]',
      m: '[object Map]',
      s: '[object Set]',
      // `structuredClone` narrows a Buffer to its Uint8Array view; the BYTES
      // survive, which is the property that matters, and the prototype does not.
      b: '[object Uint8Array]',
      mapValue: 1,
      setSize: 2,
    });
  }, 30_000);
});

/* ── suspend ──────────────────────────────────────────────────────────────── */

describe('SUSPEND: a HITL interrupt PAUSES the run across the boundary', () => {
  const SUSPENDING = `
    const answer = await ctx.suspend({ reason: 'approval', resumeKey: 'k1', question: 'may I?' });
    return { status: 'success', outputs: { answer } };`;

  it('a thrown SuspendSignal becomes the `suspended` arm, not a failure', async () => {
    // Across a boundary an exception is just a serialized value; without the
    // explicit arm this would arrive as `pack_node_error` and the run would FAIL
    // where it must PAUSE.
    const run = await runProbe(writeProbePack(SUSPENDING));
    expect(run.result.status).toBe('suspended');
    if (run.result.status !== 'suspended') throw new Error('unreachable');
    expect(run.result.interrupt.kind).toBe('approval');
    expect(run.result.interrupt.resumeKey).toBe('k1');
    expect(run.result.interrupt.data).toMatchObject({ reason: 'approval', question: 'may I?' });
  }, 30_000);

  it('a resume re-invoke is SEEDED, so the pack short-circuits instead of suspending again', async () => {
    const run = await runProbe(writeProbePack(SUSPENDING), {
      suspendResolution: { resumeKey: 'k1', value: { approved: true } },
    });
    expect(run.result.status).toBe('success');
    expect(run.result.status === 'success' && run.result.outputs).toEqual({ answer: { approved: true } });
  }, 30_000);
});

/* ── error codes ──────────────────────────────────────────────────────────── */

describe('ERROR CODES: policy meaning survives the boundary', () => {
  it("a thrown error's own `.code` reaches the result verbatim", async () => {
    const run = await runProbe(writeProbePack(`
      throw Object.assign(new Error('not allowed here'), { code: 'policy_denied' });`));
    expect(run.result.status).toBe('failure');
    if (run.result.status !== 'failure') throw new Error('unreachable');
    expect(run.result.error.code).toBe('policy_denied');
    expect(run.result.error.message).toContain('not allowed here');
  }, 30_000);

  it('an un-coded throw becomes `pack_node_error`, exactly as in-process', async () => {
    const run = await runProbe(writeProbePack(`throw new Error('plain boom');`));
    expect(run.result.status === 'failure' && run.result.error.code).toBe('pack_node_error');
  }, 30_000);

  it("the HOST's grant is authoritative — a widened envelope buys the isolate nothing", async () => {
    // A member the grant does not name is simply ABSENT from the worker's ctx,
    // so an ordinary out-of-grant call fails as a TypeError inside the pack and
    // never reaches the host at all. That is P1's design and it is not what this
    // test is for.
    //
    // What matters here is the case where the two disagree: the ENVELOPE claims
    // a capability the host's dispatch record does not grant. The worker then
    // really does build `ctx.forbidden.act` and really does call the host — and
    // the broker refuses it, because it reads the grant from ITS OWN record and
    // never from the message the worker sent.
    let touched = 0;
    const run = await runProbe(
      writeProbePack(`
        try { await ctx.forbidden.act(); return { status: 'success', outputs: { called: 'allowed' } }; }
        catch (err) { return { status: 'success', outputs: { called: 'denied', code: String(err && err.code) } }; }`),
      {
        ctx: { forbidden: { act: async () => { touched += 1; return 1; } } } as never,
        tamper: (e) => ({ ...e, capabilityGrant: [...e.capabilityGrant, 'forbidden.act'] }),
      },
    );
    expect(run.result.status === 'success' && run.result.outputs).toEqual({
      called: 'denied',
      code: 'host_capability_denied',
    });
    // Refused BEFORE resolution, so the live seam was never invoked.
    expect(touched).toBe(0);
  }, 30_000);
});

/* ── guards through the real boundary ─────────────────────────────────────── */

describe('GUARDS: the effect guard and the authority record survive the process boundary', () => {
  /** A ctx surface that behaves like a real guarded effect seam. */
  function guardedCtx(): { ctx: Record<string, unknown>; state: { fired: number; authority: AuthorityFacts | undefined } } {
    const state = { fired: 0, authority: undefined as AuthorityFacts | undefined };
    return {
      state,
      ctx: {
        storage: {
          kv: {
            put: async () => {
              state.authority = currentAuthority();
              // Guard FIRST, effect second — the seam ordering the guard relies on.
              assertEffectAllowed('notification', 'p2 isolation probe');
              state.fired += 1;
              return { ok: true };
            },
          },
        },
      },
    };
  }

  const CALLER = `
    try { await ctx.storage.kv.put({}); return { status: 'success', outputs: { call: 'ok' } }; }
    catch (err) { return { status: 'success', outputs: { call: 'denied', code: String(err && err.code) } }; }`;

  it('LIVE: the effect fires and the authority is recorded at the brokered seam', async () => {
    const { ctx, state } = guardedCtx();
    const run = await runProbe(writeProbePack(CALLER), {
      grant: ['storage.kv.put'],
      ctx: ctx as never,
      authority: FACTS,
    });
    expect(run.result.status === 'success' && run.result.outputs).toEqual({ call: 'ok' });
    expect(state.fired).toBe(1);
    // Without `runWithAuthority` in the broker this is `undefined` — the record
    // no-ops silently when there is no ambient authority, which is why it is
    // asserted rather than assumed.
    expect(state.authority?.actor).toBe('workload:test:p2');
  }, 30_000);

  it('REPLAY: the effect is refused across the boundary and the seam never runs', async () => {
    // The load-bearing one. `runEffectContext.ts`'s header: AsyncLocalStorage
    // does NOT cross a process boundary, so if the broker stopped
    // re-establishing the context this would degrade to NO GUARD — silently,
    // with every other test still green, and the symptom would be duplicate
    // real-world side effects on replayed runs.
    //
    // SABOTAGE: drop `runWithEffectContext` from `packHostCallBroker.ts`'s
    // `invokeUnderGuards` and this test goes red (the effect is ALLOWED).
    const { ctx, state } = guardedCtx();
    const effectCtx: RunEffectContext = { runId: 'run-iso-probe', replaying: true };
    const run = await runProbe(writeProbePack(CALLER), {
      grant: ['storage.kv.put'],
      ctx: ctx as never,
      effectCtx,
      authority: FACTS,
    });
    expect(run.result.status === 'success' && run.result.outputs).toEqual({
      call: 'denied',
      code: 'replay_source_missing',
    });
    expect(state.fired).toBe(0);
  }, 30_000);
});

/* ── variables ────────────────────────────────────────────────────────────── */

describe('VARIABLES: snapshot in, writes out, synchronous throughout', () => {
  it('reads the snapshot, sees its own write, and returns the write set', async () => {
    const run = await runProbe(
      writeProbePack(`
        const before = ctx.variables.get('seeded');
        ctx.variables.set('made', before + '-plus');
        const after = ctx.variables.get('made');
        return { status: 'success', outputs: { before, after } };`),
      { variablesSnapshot: { seeded: 'from-host' } },
    );
    expect(run.result.status === 'success' && run.result.outputs).toEqual({
      before: 'from-host',
      after: 'from-host-plus',
    });
    expect(run.result.variablesWrites).toEqual([{ name: 'made', value: 'from-host-plus' }]);
  }, 30_000);
});

/* ── the guarantee comparison ─────────────────────────────────────────────── */

describe('GUARANTEES: a tier is REFUSED, never downgraded, when the adapter is too weak', () => {
  it('the child adapter satisfies the untrusted tier on this runtime', () => {
    const admitted = admitAdapterForTier('untrusted', createChildProcessIsolationAdapter());
    expect(admitted.ok, JSON.stringify(admitted)).toBe(true);
  });

  it('the FAKE adapter is refused for the untrusted tier — it enforces nothing', () => {
    // The whole reason the record is a total `Record` rather than an optional
    // set: the fake cannot become the thing containing community code because
    // an operator set one env var.
    const admitted = admitAdapterForTier('untrusted', createFakeIsolationAdapter());
    expect(admitted.ok).toBe(false);
    expect(admitted.ok === false && admitted.code).toBe(ISOLATION_GUARANTEE_UNMET_CODE);
    expect(admitted.ok === false && admitted.message).toContain('separate-process');
  });

  it('trusted tiers require nothing, so an ineligible-but-trusted pack is never blocked by this', () => {
    expect(admitAdapterForTier('steward', createFakeIsolationAdapter()).ok).toBe(true);
    expect(admitAdapterForTier('operator-trusted', createFakeIsolationAdapter()).ok).toBe(true);
  });

  it('the comparison is NON-VACUOUS: a requirement no adapter provides refuses the strongest adapter', () => {
    // `network-denied` is unreachable on this platform. Requiring it must refuse
    // even the child adapter — otherwise the comparison would be a formality
    // that every adapter passes and could never be observed to bite.
    const demanding = { ...TIER_REQUIRED_GUARANTEES, untrusted: ['network-denied'] as const };
    expect(unmetGuarantees('untrusted', childAdapterGuarantees(), demanding)).toEqual(['network-denied']);
    expect(unmetGuarantees('untrusted', NO_GUARANTEES, demanding)).toEqual(['network-denied']);
  });

  it('an adapter with NO guarantees fails every untrusted requirement, not just the first', () => {
    expect(unmetGuarantees('untrusted', NO_GUARANTEES)).toEqual([...TIER_REQUIRED_GUARANTEES.untrusted]);
  });

  it('WIRED: the gate runs inside `dispatchPackNodeIsolated`, before anything is issued', async () => {
    // The tests above prove the FUNCTION refuses. This one proves the dispatch
    // path CALLS it — without which the comparison could be deleted from the
    // only place it matters and every assertion above would stay green.
    const outcome = await dispatchPackNodeIsolated({
      ctx: {
        runId: 'run-gate', nodeId: 'n-gate', tenantId: 't-gate',
        inputs: {}, configurable: {}, attempt: 1, secrets: {},
      } as never,
      module: { execute: async () => ({ status: 'success', outputs: {} }) } as never,
      origin: {
        packName: 'community.test.gate', packVersion: '1.0.0', packDir: '/x',
        entryUrl: 'file:///x/index.mjs', typeId: 'community.test.gate.node',
        tier: 'untrusted', isolation: { eligible: true },
      },
      effectCtx: { runId: 'run-gate', replaying: false },
      // Enforces nothing — so the untrusted tier must be refused rather than run.
      adapter: createFakeIsolationAdapter(),
    });
    expect(outcome.status).toBe('failure');
    expect(outcome.status === 'failure' && outcome.error.code).toBe(ISOLATION_GUARANTEE_UNMET_CODE);
    // Refused BEFORE a dispatch record exists, so a rejected pack leaves no
    // half-built state behind: nothing to leak, nothing to sweep.
    expect(peekDispatch('any')).toBeNull();
  });
});

/* ── adapter selection + unavailability ───────────────────────────────────── */

describe('SELECTION: `child` is the default, and an unavailable adapter REFUSES', () => {
  it('defaults to the child adapter, and an unrecognised value does not fall back to the fake', () => {
    expect(isolationAdapterId({})).toBe('child');
    expect(isolationAdapterId({ OPENWOP_PACK_ISOLATION_ADAPTER: 'nonsense' })).toBe('child');
    expect(isolationAdapterId({ OPENWOP_PACK_ISOLATION_ADAPTER: 'fake' })).toBe('fake');
    expect(adapterFor(undefined, {}).id).toBe(CHILD_ADAPTER_ID);
    expect(adapterFor(undefined, { OPENWOP_PACK_ISOLATION_ADAPTER: 'fake' }).id).toBe('fake-in-process');
  });

  it('a host with no worker artifact REFUSES the dispatch instead of running it somewhere weaker', async () => {
    entryBroken.value = true;
    const run = await runProbe(writeProbePack('return { status: "success", outputs: {} };'));
    expect(run.result.status).toBe('failure');
    expect(run.result.status === 'failure' && run.result.error.code).toBe(ISOLATION_ADAPTER_UNAVAILABLE_CODE);
    // …and nothing ran. There is no in-process fallback on this path, which is
    // the property the whole phase exists to make true.
    expect(run.reported).toEqual([]);
  }, 30_000);
});
