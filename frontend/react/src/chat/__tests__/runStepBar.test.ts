/**
 * ADR 0768 follow-up C3 — the run bubble's step bar.
 *
 * The bubble knows step COUNTS, not graph order, so the bar is a count bar:
 * done, failed, the one step in hand, then the rest. These pin that a segment
 * is never invented (the bar is exactly `totalNodes` long) and that "waiting"
 * shows only while the run is actually waiting on the user.
 *
 * What breaks it: dropping either `Math.min` cap (extra segments), marking a
 * finished run's step "in hand", ignoring `isSuspended`, or moving the
 * 12-segment readability limit (12 is drawn, 13 is not).
 */
import { describe, expect, it } from 'vitest';
import { stepSegments } from '../WorkflowRunBubble.js';
import type { WorkflowRunState } from '../types.js';

function run(over: Partial<WorkflowRunState>): WorkflowRunState {
  return {
    slug: 'launch-plan', workflowName: 'Launch plan', workflowId: 'wf_1', runId: 'run-1',
    status: 'running', totalNodes: 5, completedNodeIds: [], nodeOutputs: {}, failedNodeIds: [],
    currentNodeName: null, nodeNames: {}, startedAt: '2026-09-29T00:00:00.000Z',
    ...over,
  };
}

describe('stepSegments', () => {
  it('fills by count and marks the step in hand', () => {
    expect(stepSegments(run({ completedNodeIds: ['a', 'b'] }), false))
      .toEqual(['done', 'done', 'active', 'todo', 'todo']);
  });

  it('shows the step in hand as waiting only while the run is suspended', () => {
    expect(stepSegments(run({ completedNodeIds: ['a', 'b', 'c', 'd'] }), true))
      .toEqual(['done', 'done', 'done', 'done', 'waiting']);
  });

  it('a finished run has no step in hand', () => {
    expect(stepSegments(run({ status: 'completed', completedNodeIds: ['a', 'b', 'c', 'd', 'e'] }), false))
      .toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(stepSegments(run({ status: 'failed', completedNodeIds: ['a'], failedNodeIds: ['b'] }), false))
      .toEqual(['done', 'failed', 'todo', 'todo', 'todo']);
  });

  it('never draws more segments than the run has steps', () => {
    const over = stepSegments(run({ totalNodes: 2, completedNodeIds: ['a', 'b', 'c'], failedNodeIds: ['d'] }), true);
    expect(over).toEqual(['done', 'done']);
  });

  it('draws nothing when the step count is unknown or too long to read', () => {
    expect(stepSegments(run({ totalNodes: 0 }), false)).toEqual([]);
    expect(stepSegments(run({ totalNodes: 13 }), false)).toEqual([]);
    // Polarity at the limit: exactly 12 steps is still drawn, one segment each.
    expect(stepSegments(run({ totalNodes: 12 }), false)).toEqual(['active', ...Array<string>(11).fill('todo')]);
  });
});
