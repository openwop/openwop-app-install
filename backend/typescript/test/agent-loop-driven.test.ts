/**
 * A6 — the real driven agent loop. Drives a per-turn function, stops early on
 * `terminate`, collects outputs, and still honors the RFC 0058 bound + RFC 0061
 * iteration counter + stateful resume.
 */

import { describe, expect, it } from 'vitest';
import { runAgentLoopDriven } from '../src/host/agentLoop.js';

describe('runAgentLoopDriven (A6 / RFC 0061)', () => {
  it('drives real turns and stops early on terminate', async () => {
    const seen: number[] = [];
    const res = await runAgentLoopDriven({
      turns: 10,
      runTurn: ({ iteration }) => {
        seen.push(iteration);
        return iteration >= 3 ? { decision: 'terminate', output: `done@${iteration}` } : { decision: 'continue', output: `step@${iteration}` };
      },
    });
    expect(seen).toEqual([1, 2, 3]); // stopped early, not all 10
    expect(res.decisions.map((d) => d.decision)).toEqual(['continue', 'continue', 'terminate']);
    expect(res.decisions.map((d) => d.iteration)).toEqual([1, 2, 3]);
    expect(res.outputs).toEqual(['step@1', 'step@2', 'done@3']);
  });

  it('trips the maxLoopIterations bound when the driver never terminates', async () => {
    const res = await runAgentLoopDriven({
      turns: 100,
      maxLoopIterations: 3,
      runTurn: () => ({ decision: 'continue' }),
    });
    expect(res.bound?.kind).toBe('loop-iterations');
    expect(res.bound?.observed).toBe(4);
    expect(res.decisions).toHaveLength(3);
  });

  it('preserves the resume iteration', async () => {
    const res = await runAgentLoopDriven({
      turns: 5,
      suspendAtTurn: 2,
      resume: true,
      runTurn: ({ iteration }) => (iteration >= 4 ? { decision: 'terminate' } : { decision: 'continue' }),
    });
    expect(res.resumedIteration).toBe(2);
  });

  it('falls back to the counter seam without a driver', async () => {
    const res = await runAgentLoopDriven({ turns: 2 });
    expect(res.decisions.map((d) => d.decision)).toEqual(['continue', 'terminate']);
  });
});
