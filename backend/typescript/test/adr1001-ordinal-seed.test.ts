/**
 * ADR 1001 D3.3 — a node body that RESUMES from a checkpoint continues at the
 * ordinal it paused at.
 *
 * Why it exists: the source run's continuation is a re-entry (rewound to 0 by
 * `beginNodeActivity`), while a replay fork can reach the same continuation in
 * one invocation (still counting). The provider-call identity includes the
 * ordinal, so the two must be seeded to the same cursor or the fork misses the
 * source's invocation log and calls the provider live. The end-to-end witness
 * (a two-round BYOK replay fork makes zero live calls) lands with P1's wiring;
 * this pins the allocator contract it relies on.
 *
 * Case 3 pins the opt-in condition: with no seed call, the allocator is
 * byte-identical to main (`peek` never allocates; a re-entry still rewinds to 0;
 * a new attempt still rewinds), so nothing that never seeds can move.
 *
 * ADR 1002's visit partition (cases 4-7): each VISIT of a node owns a disjoint
 * ordinal range, so two identical requests on two loop visits at the same
 * attempt stop sharing one invocation-log record. Visit 0's range starts at 0,
 * so every record written before this keeps its identity. A visit is folded
 * from the log and is NOT the ADR 0772 execution ordinal: a retry opens a new
 * execution but stays in its visit (RFC 0150 §B retry-stability).
 *
 * Sabotage: making `seedNodeActivity` reset the attempt reds case 2; making it
 * a no-op reds case 1; making `peek` allocate (or create state) reds case 3;
 * ignoring the visit in `beginNodeActivity` reds case 5; rewinding a new
 * attempt to 0 instead of the visit base reds case 6; counting a retry as a new
 * visit in `visitOf` reds case 7.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionOrdinals } from '../src/executor/sideEffects.js';
import {
  VISIT_ORDINAL_STRIDE,
  beginNodeActivity,
  nextLogicalInvocationOrdinal,
  peekNodeActivityOrdinal,
  resetLogicalInvocationOrdinals,
  seedNodeActivity,
} from '../src/host/effectIdentity.js';

afterEach(() => resetLogicalInvocationOrdinals());

describe('effect ordinal seeding (ADR 1001 D3.3)', () => {
  it('a re-entry seeded to the paused cursor allocates what an uninterrupted body would', () => {
    beginNodeActivity('r', 'n', 1);
    for (let i = 0; i < 3; i += 1) nextLogicalInvocationOrdinal('r', 'n', 1);
    const cursor = peekNodeActivityOrdinal('r', 'n');
    expect(cursor).toBe(3);
    const uninterrupted = nextLogicalInvocationOrdinal('r', 'n', 1);

    beginNodeActivity('r', 'n', 1); // the resume re-enters the body
    expect(peekNodeActivityOrdinal('r', 'n')).toBe(0);
    seedNodeActivity('r', 'n', cursor);
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(uninterrupted);
  });

  it('keeps the attempt, so a later attempt still rewinds to 0', () => {
    beginNodeActivity('r', 'n', 2);
    seedNodeActivity('r', 'n', 5);
    expect(nextLogicalInvocationOrdinal('r', 'n', 2)).toBe(5);
    expect(nextLogicalInvocationOrdinal('r', 'n', 3)).toBe(0);
  });

  it('without a seed call, allocation is unchanged and peek is read-only', () => {
    expect(peekNodeActivityOrdinal('r', 'n')).toBe(0);
    beginNodeActivity('r', 'n', 1);
    expect(peekNodeActivityOrdinal('r', 'n')).toBe(0);
    expect(peekNodeActivityOrdinal('r', 'n')).toBe(0);
    expect([0, 1, 2].map(() => nextLogicalInvocationOrdinal('r', 'n', 1))).toEqual([0, 1, 2]);
    expect(peekNodeActivityOrdinal('r', 'n')).toBe(3);
    beginNodeActivity('r', 'n', 1); // a HITL re-entry, unseeded
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(0);
    expect(nextLogicalInvocationOrdinal('r', 'n', 2)).toBe(0);
    expect(peekNodeActivityOrdinal('r', 'other')).toBe(0);
    expect(nextLogicalInvocationOrdinal('r', 'other', 1)).toBe(0);
  });

  it('visit 0 allocates exactly what main did (existing records keep their identity)', () => {
    beginNodeActivity('r', 'n', 1, 0);
    expect([0, 1, 2].map(() => nextLogicalInvocationOrdinal('r', 'n', 1))).toEqual([0, 1, 2]);
    beginNodeActivity('r', 'n', 1); // the visit defaults to 0
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(0);
  });

  it('two visits at the same attempt get disjoint ordinals; a same-visit resume rewinds to that visit\'s base', () => {
    beginNodeActivity('r', 'n', 1, 0);
    const first = [nextLogicalInvocationOrdinal('r', 'n', 1), nextLogicalInvocationOrdinal('r', 'n', 1)];
    beginNodeActivity('r', 'n', 1, 1);
    const second = [nextLogicalInvocationOrdinal('r', 'n', 1), nextLogicalInvocationOrdinal('r', 'n', 1)];
    expect(first).toEqual([0, 1]);
    expect(second).toEqual([VISIT_ORDINAL_STRIDE, VISIT_ORDINAL_STRIDE + 1]);
    beginNodeActivity('r', 'n', 1, 1); // visit 1 resumed after a suspend
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(VISIT_ORDINAL_STRIDE);
    const cursor = peekNodeActivityOrdinal('r', 'n');
    beginNodeActivity('r', 'n', 1, 1);
    seedNodeActivity('r', 'n', cursor); // a checkpoint continuation keeps the visit
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(VISIT_ORDINAL_STRIDE + 1);
  });

  it('a retry inside a visit rewinds to that visit\'s base (RFC 0150 §B retry-stability)', () => {
    beginNodeActivity('r', 'n', 1, 2);
    expect(nextLogicalInvocationOrdinal('r', 'n', 1)).toBe(2 * VISIT_ORDINAL_STRIDE);
    expect(nextLogicalInvocationOrdinal('r', 'n', 2)).toBe(2 * VISIT_ORDINAL_STRIDE);
    beginNodeActivity('r', 'n', 2, 2);
    expect(nextLogicalInvocationOrdinal('r', 'n', 2)).toBe(2 * VISIT_ORDINAL_STRIDE);
  });

  it('folds the visit from the log: a retry stays, a revisit advances, a re-entry keeps', () => {
    const ev = (type: string) => ({ type, nodeId: 'n', payload: {} });
    expect(ExecutionOrdinals.fold([]).visitOf('n')).toBe(0);
    // started → suspended (no terminal) → re-entered: the same open execution and visit
    expect(ExecutionOrdinals.fold([ev('node.started'), ev('node.suspended'), ev('node.started')]).visitOf('n')).toBe(0);
    // a failed execution then its retry: execution 2, still visit 0
    const retried = ExecutionOrdinals.fold([ev('node.started'), ev('node.failed'), ev('node.started')]);
    expect(retried.highest('n')).toBe(2);
    expect(retried.visitOf('n')).toBe(0);
    // completed then started again (a loop revisit): visit 1; and the NEXT after it completes: 2
    const revisited = ExecutionOrdinals.fold([ev('node.started'), ev('node.completed'), ev('node.started')]);
    expect(revisited.visitOf('n')).toBe(1);
    revisited.terminal('n', 'completed');
    expect(revisited.visitOf('n')).toBe(2);
    // a pre-start refusal (an orphan node.failed) does not count as anything
    expect(ExecutionOrdinals.fold([ev('node.failed')]).visitOf('n')).toBe(0);
  });
});
