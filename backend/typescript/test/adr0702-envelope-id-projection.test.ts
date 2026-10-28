import { describe, expect, it } from 'vitest';

import { projectEnvelopeIds, typesRequiringEnvelopeIds } from '../src/storage/envelopeIdProjection.js';

/**
 * ADR 0702 — the corpus validates a payload OBJECT ALONE, so a def whose
 * `required` names `nodeId`/`runId` is not satisfied by the envelope carrying
 * them. These are the unit legs.
 *
 * Tracker TST-BGF-12. Red when the required-id sets stop being derived from the
 * schema (or shrink below the measured 22 nodeId / 3 runId types), when an
 * existing id is overwritten, when an id is added to a def that does not declare
 * it, when an absent nodeId becomes a present-but-undefined key, or when a
 * non-object payload is spread.
 */
describe('envelope-id projection', () => {
  it('derives the type sets FROM the schema, and they are not empty', () => {
    // Non-vacuity, and the tripwire on the corpus pin: a projection driven by an
    // empty set is a no-op that passes every "does not corrupt" leg below.
    const { nodeId, runId } = typesRequiringEnvelopeIds();
    expect(nodeId.size, 'defs requiring nodeId (measured 22 at the 2026-10-23 corpus pin)').toBeGreaterThanOrEqual(22);
    expect(runId.size, 'defs requiring runId (measured 3)').toBeGreaterThanOrEqual(3);
    expect(nodeId.has('output.chunk')).toBe(true);
    expect(runId.has('output.chunk')).toBe(true);
    expect(nodeId.has('interrupt.resolved')).toBe(true);
  });

  it('supplies the ids the def asks for', () => {
    expect(
      projectEnvelopeIds('output.chunk', { chunk: 'hi', isLast: false }, { runId: 'r1', nodeId: 'n1' }),
    ).toEqual({ chunk: 'hi', isLast: false, nodeId: 'n1', runId: 'r1' });
    expect(
      projectEnvelopeIds('interrupt.resolved', { interruptId: 'i1', kind: 'approval' }, { runId: 'r1', nodeId: 'n1' }),
    ).toEqual({ interruptId: 'i1', kind: 'approval', nodeId: 'n1' });
  });

  it('does NOT add an id to a type whose def does not declare it', () => {
    // The mirror of the defect being fixed, and the reason the sets are derived
    // rather than hand-listed: every def is `additionalProperties: false`, so
    // injecting `nodeId` into a type that does not declare it turns a VALID
    // payload into an invalid one.
    const before = { workflowId: 'wf' };
    expect(projectEnvelopeIds('run.started', before, { runId: 'r1', nodeId: 'n1' })).toBe(before);
  });

  it('never overwrites an id the producer already set', () => {
    const p = { chunk: 'x', isLast: true, nodeId: 'PRODUCER', runId: 'PRODUCER' };
    expect(projectEnvelopeIds('output.chunk', p, { runId: 'r1', nodeId: 'n1' })).toBe(p);
  });

  it('leaves a non-object payload alone rather than masking it', () => {
    // A null or scalar payload is a different defect; returning it untouched
    // lets the validator report it honestly instead of silently becoming
    // `{nodeId}` and validating for the wrong reason.
    for (const p of [null, 'str', 42, ['a']]) {
      expect(projectEnvelopeIds('output.chunk', p, { runId: 'r1', nodeId: 'n1' })).toBe(p);
    }
  });

  it('omits nodeId when the envelope has none', () => {
    // A run-scoped event of a node-scoped type: adding `nodeId: undefined` would
    // satisfy nothing and would make the key present-but-void.
    const out = projectEnvelopeIds('output.chunk', { chunk: 'x', isLast: true }, { runId: 'r1' }) as Record<string, unknown>;
    expect(Object.keys(out).includes('nodeId')).toBe(false);
    expect(out['runId']).toBe('r1');
  });
});
