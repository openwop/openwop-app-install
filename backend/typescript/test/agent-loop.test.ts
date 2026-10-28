/**
 * RFC 0061 — stateful agent-loop lifecycle + RFC 0058 maxLoopIterations
 * (TST-BLA-1). Subject: `runAgentLoop`, the deterministic seam behind
 * `POST /v1/host/openwop-app/agentloop/run` (routes/testSeam.ts).
 *
 *   - §B: one runOrchestrator.decided per turn, monotonic 1-based iteration
 *   - final turn carries decision 'terminate'
 *   - §E / RFC 0058: the (max+1)th turn breaches loop-iterations + stops
 *   - §D: a suspend at turn K resumes at iteration K (counter intact)
 *
 * Red when: the counter starts at 0, the final turn stops terminating, the
 * bound fires one turn late, or resume reports iteration K+1 (w65 probes).
 * §C is a hard-coded seam answer (grade-code AGENTLOOP-WS-CONST-1): its case
 * reds only if that constant changes.
 *
 * @see RFCS/0061-agent-loop-lifecycle.md §B/§D/§E
 * @see RFCS/0058-run-execution-bounds.md §A
 */

import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/host/agentLoop.js';

describe('RFC 0061 §B — iteration counter', () => {
  it('emits one decision per turn, iteration monotonic 1-based', () => {
    const r = runAgentLoop({ turns: 3 });
    expect(r.decisions.map((d) => d.iteration)).toEqual([1, 2, 3]);
    expect(r.bound).toBeUndefined();
  });

  it('the final turn terminates, earlier turns continue', () => {
    const r = runAgentLoop({ turns: 3 });
    expect(r.decisions.map((d) => d.decision)).toEqual(['continue', 'continue', 'terminate']);
  });
});

describe('RFC 0058 §E — maxLoopIterations bound', () => {
  it('breaches loop-iterations on the (max+1)th turn and stops', () => {
    const r = runAgentLoop({ turns: 5, maxLoopIterations: 3 });
    // Fired turns 1..3, refused turn 4.
    expect(r.decisions.map((d) => d.iteration)).toEqual([1, 2, 3]);
    expect(r.bound).toEqual({ kind: 'loop-iterations', limit: 3, observed: 4, errorCode: 'loop_limit_exceeded' });
  });

  it('does not breach when turns are within the bound', () => {
    const r = runAgentLoop({ turns: 3, maxLoopIterations: 10 });
    expect(r.bound).toBeUndefined();
    expect(r.decisions).toHaveLength(3);
  });
});

describe('RFC 0061 §D — stateful resume', () => {
  it('a suspend at turn 2 resumes at iteration 2 (counter does not reset/skip)', () => {
    const r = runAgentLoop({ turns: 4, suspendAtTurn: 2, resume: true });
    expect(r.resumedIteration).toBe(2);
    // The full loop still produces a monotonic 1..4 sequence.
    expect(r.decisions.map((d) => d.iteration)).toEqual([1, 2, 3, 4]);
  });

  it('no resumedIteration when the loop is not resumed', () => {
    const r = runAgentLoop({ turns: 4, suspendAtTurn: 2 });
    expect(r.resumedIteration).toBeUndefined();
  });
});

describe('RFC 0061 §C — per-iteration workspace snapshot immutability', () => {
  it('a turn-i write is invisible to turn i, visible to turn i+1', () => {
    const r = runAgentLoop({ turns: 2, workspaceWriteAtTurn: 1 });
    expect(r.workspaceVisible).toEqual({ atWriteTurn: false, atNextTurn: true });
  });

  it('no workspaceVisible report when no write is requested', () => {
    expect(runAgentLoop({ turns: 2 }).workspaceVisible).toBeUndefined();
  });
});
