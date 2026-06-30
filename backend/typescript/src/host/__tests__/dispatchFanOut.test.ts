/**
 * RFC 0118 parallel fan-out — the join-fold semantics, the bounded-concurrency coordinator,
 * the registration cross-field validator, and the advertised capability. The fold is the
 * normative core (joinOutcome × counts × mergeOrder per joinPolicy mode/onChildFailure).
 *
 * @see RFCS/0118-parallel-subworkflow-fan-out-and-join.md
 */
import { describe, it, expect } from 'vitest';
import {
  foldJoin,
  runParallelFanOut,
  effectiveConcurrency,
  validateDispatchFanOutConfig,
  dispatchCapability,
  HOST_MAX_FAN_OUT,
  type ChildTerminal,
} from '../dispatchFanOut.js';

const t = (id: string, status: ChildTerminal['status'] = 'completed'): ChildTerminal => ({ childRunId: id, status });

describe('foldJoin — join outcomes (RFC 0118 §D)', () => {
  it('wait-all/collect over all-completed → satisfied + mergeOrder in observed order', () => {
    const r = foldJoin([t('a'), t('b'), t('c')], { mode: 'wait-all', onChildFailure: 'collect' });
    expect(r).toMatchObject({ joinOutcome: 'satisfied', completedCount: 3, failedCount: 0, cancelledCount: 0 });
    expect(r.mergeOrder).toEqual(['a', 'b', 'c']);
  });

  it('wait-all/collect with one failed → partial (node succeeds, non-completed recorded)', () => {
    const r = foldJoin([t('a'), t('b', 'failed'), t('c')], { mode: 'wait-all', onChildFailure: 'collect' });
    expect(r).toMatchObject({ joinOutcome: 'partial', completedCount: 2, failedCount: 1 });
  });

  it('fail-fast with a failed child → failed', () => {
    const r = foldJoin([t('a'), t('b', 'failed')], { mode: 'wait-all', onChildFailure: 'fail-fast' });
    expect(r.joinOutcome).toBe('failed');
  });

  it("quorum: satisfied at quorum completed, failed when unreachable", () => {
    expect(foldJoin([t('a'), t('b'), t('c', 'failed')], { mode: 'quorum', quorum: 2 }).joinOutcome).toBe('partial');
    expect(foldJoin([t('a'), t('b', 'failed'), t('c', 'failed')], { mode: 'quorum', quorum: 2 }).joinOutcome).toBe('failed');
  });

  it("first → satisfied at ≥1 completed; race → satisfied at first terminal of any kind", () => {
    expect(foldJoin([t('a')], { mode: 'first' }).joinOutcome).toBe('satisfied');
    expect(foldJoin([t('a', 'failed')], { mode: 'race' }).joinOutcome).toBe('partial'); // terminal reached, but non-completed
  });
});

describe('effectiveConcurrency — min(maxConcurrency, maxFanOut)', () => {
  it('takes the smaller bound; defaults to the host cap when unset', () => {
    expect(effectiveConcurrency(3, 16)).toBe(3);
    expect(effectiveConcurrency(50, 16)).toBe(16);
    expect(effectiveConcurrency(undefined, 16)).toBe(16);
    expect(effectiveConcurrency(0, 16)).toBe(16); // non-positive ignored
  });
});

describe('runParallelFanOut — coordinator', () => {
  it('dispatches every child (bounded), folds wait-all/collect → satisfied + emits events', async () => {
    const events: string[] = [];
    const out = await runParallelFanOut({
      nextWorkerIds: ['w1', 'w2', 'w3'],
      config: { fanOutPolicy: 'parallel', maxConcurrency: 2, joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } },
      dispatchChild: async (workerId, i) => ({ childRunId: `r-${i}-${workerId}`, status: 'completed' }),
      events: {
        fanOut: (e) => events.push(`fanOut:${e.childCount}:${e.maxConcurrency}:${e.joinMode}`),
        join: (e) => events.push(`join:${e.joinOutcome}:${e.mergeOrder.length}`),
      },
    });
    expect(out.joinOutcome).toBe('satisfied');
    expect(out.children).toHaveLength(3);
    expect(out.mergeOrder).toHaveLength(3);
    expect(events).toEqual(['fanOut:3:2:wait-all', 'join:satisfied:3']);
  });

  it('does not drop children above the concurrency ceiling', async () => {
    const out = await runParallelFanOut({
      nextWorkerIds: ['a', 'b', 'c', 'd', 'e'],
      config: { fanOutPolicy: 'parallel', maxConcurrency: 2 },
      dispatchChild: async (w, i) => ({ childRunId: `${i}-${w}`, status: 'completed' }),
    });
    expect(out.children).toHaveLength(5);
    expect(out.completedCount).toBe(5);
  });
});

describe('validateDispatchFanOutConfig — registration cross-field MUSTs', () => {
  it('rejects joinPolicy without fanOutPolicy:parallel', () => {
    expect(validateDispatchFanOutConfig({ joinPolicy: { mode: 'wait-all' } }, true)?.code).toBe('validation_error');
  });
  it('rejects quorum mode without a quorum field', () => {
    expect(validateDispatchFanOutConfig({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'quorum' } }, true)?.code).toBe('validation_error');
  });
  it("rejects fanOutPolicy:'parallel' on a host advertising fanOutSupported:false", () => {
    expect(validateDispatchFanOutConfig({ fanOutPolicy: 'parallel' }, false)?.code).toBe('validation_error');
  });
  it('accepts a well-formed parallel config on a supporting host', () => {
    expect(validateDispatchFanOutConfig({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'wait-all', onChildFailure: 'collect' } }, true)).toBeNull();
    expect(validateDispatchFanOutConfig({ fanOutPolicy: 'parallel', joinPolicy: { mode: 'quorum', quorum: 2 } }, true)).toBeNull();
  });
  it('leaves a pre-RFC-0118 config (no fan-out fields) valid', () => {
    expect(validateDispatchFanOutConfig({}, true)).toBeNull();
  });
});

describe('dispatchCapability — advertised shape', () => {
  it('advertises fanOutSupported + parallel + the join modes + maxFanOut', () => {
    const c = dispatchCapability();
    expect(c).toMatchObject({ supported: true, fanOutSupported: true, maxFanOut: HOST_MAX_FAN_OUT });
    expect(c.fanOutPolicies).toContain('parallel');
    // Honesty: only `wait-all` is advertised — the short-circuit modes need child
    // cancellation the executor can't do yet (foldJoin still implements all four).
    expect(c.joinModes).toEqual(['wait-all']);
    // RFC 0118 §seam amendment (openwop#789): the second join axis is gated by
    // `onChildFailureModes`. We honor collect+absorb (neither needs cancellation); fail-fast
    // is omitted — so its rejection at registration is DISCOVERABLE, not an undiscoverable footgun.
    expect(c.onChildFailureModes).toEqual(['collect', 'absorb']);
  });
});
