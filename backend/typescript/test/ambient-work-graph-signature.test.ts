/**
 * ADR 0137 Phase 1 — the pure run-signature + recurrence clustering.
 */
import { describe, it, expect } from 'vitest';
import { computeRunSignature, clusterAndDetect, suggestionIdFor } from '../src/features/ambient-work-graph/runSignature.js';
import type { RunSignatureInput } from '../src/features/ambient-work-graph/types.js';

const run = (runId: string, toolNames: string[], extra: Partial<RunSignatureInput> = {}): RunSignatureInput =>
  ({ runId, toolNames, agentId: 'researcher', createdAt: '2026-06-24T00:00:00Z', ...extra });

describe('computeRunSignature', () => {
  it('agent + consecutive-deduped ordered tool names; deterministic', () => {
    const a = computeRunSignature(run('r1', ['kb.search', 'kb.search', 'email.send']));
    expect(a).toEqual({ signature: 'researcher|kb.search>email.send', toolSequence: ['kb.search', 'email.send'] });
    expect(computeRunSignature(run('r2', ['kb.search', 'kb.search', 'email.send']))?.signature).toBe(a!.signature);
  });
  it('order matters (read→write ≠ write→read)', () => {
    expect(computeRunSignature(run('r', ['a', 'b']))!.signature).not.toBe(computeRunSignature(run('r', ['b', 'a']))!.signature);
  });
  it('no-tool run ⇒ null (a chat turn is not a workflow)', () => {
    expect(computeRunSignature(run('r', []))).toBeNull();
    expect(computeRunSignature(run('r', ['']))).toBeNull();
  });
  it('agent is part of the key', () => {
    expect(computeRunSignature(run('r', ['a'], { agentId: 'x' }))!.signature)
      .not.toBe(computeRunSignature(run('r', ['a'], { agentId: 'y' }))!.signature);
  });
});

describe('clusterAndDetect', () => {
  const inputs: RunSignatureInput[] = [
    run('r1', ['kb.search', 'email.send'], { createdAt: '2026-06-20T00:00:00Z', goal: 'old' }),
    run('r2', ['kb.search', 'email.send'], { createdAt: '2026-06-22T00:00:00Z' }),
    run('r3', ['kb.search', 'email.send'], { createdAt: '2026-06-24T00:00:00Z', goal: 'latest goal' }),
    run('r4', ['kb.search']), // different pattern, only once
  ];

  it('emits a suggestion for a pattern at/over the threshold; not for rare ones', () => {
    const out = clusterAndDetect('t', inputs, { minCount: 3 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      signature: 'researcher|kb.search>email.send', count: 3, toolSequence: ['kb.search', 'email.send'],
      status: 'suggested', sampleGoal: 'latest goal', firstSeenAt: '2026-06-20T00:00:00Z', lastSeenAt: '2026-06-24T00:00:00Z',
    });
    expect(out[0]!.exampleRunIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('deterministic suggestionId (idempotent re-sweep)', () => {
    const a = clusterAndDetect('t', inputs, { minCount: 3 })[0]!;
    const b = clusterAndDetect('t', inputs, { minCount: 3 })[0]!;
    expect(a.suggestionId).toBe(b.suggestionId);
    expect(a.suggestionId).toBe(suggestionIdFor('t', a.signature));
    // tenant-separated
    expect(suggestionIdFor('other', a.signature)).not.toBe(a.suggestionId);
  });

  it('a lower threshold surfaces more patterns', () => {
    expect(clusterAndDetect('t', inputs, { minCount: 1 })).toHaveLength(2);
  });
});
