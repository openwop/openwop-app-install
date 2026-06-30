/**
 * ADR 0133 Phase 2 — the pure taskDeckProjection (bucketing, parent/child grouping,
 * blocked-reason join).
 */
import { describe, it, expect } from 'vitest';
import { taskDeckProjection, type BlockedInfo } from '../src/features/task-deck/taskDeckProjection.js';
import type { RunRecord, RunStatus } from '../src/types.js';

function run(id: string, status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: id, workflowId: `wf-${id}`, tenantId: 't', status, inputs: {}, metadata: {}, configurable: {},
    createdAt: '2026-06-24T00:00:00.000Z', updatedAt: `2026-06-24T00:00:0${id.length}.000Z`, ...extra,
  } as RunRecord;
}
const NO_BLOCKS = new Map<string, BlockedInfo>();

describe('taskDeckProjection (ADR 0133 P2)', () => {
  it('buckets top-level runs by status', () => {
    const deck = taskDeckProjection([
      run('a', 'pending'), run('b', 'running'), run('c', 'completed'), run('d', 'failed'), run('e', 'cancelled'),
      run('f', 'waiting-approval'),
    ], NO_BLOCKS);
    expect(deck.buckets.pending.map((c) => c.runId)).toEqual(['a']);
    expect(deck.buckets.running.map((c) => c.runId)).toEqual(['b']);
    expect(deck.buckets.completed.map((c) => c.runId)).toEqual(['c']);
    expect(deck.buckets.failed.map((c) => c.runId).sort()).toEqual(['d', 'e']); // failed + cancelled
    expect(deck.buckets.blocked.map((c) => c.runId)).toEqual(['f']);
  });

  it('nests a child under its in-scope parent (NOT double-counted in a top bucket)', () => {
    const parent = run('p', 'running');
    const child = run('ch', 'running', { metadata: { parentRunId: 'p', delegatedBy: 'agent:a1' } });
    const deck = taskDeckProjection([parent, child], NO_BLOCKS);
    expect(deck.buckets.running.map((c) => c.runId)).toEqual(['p']); // only the parent at top level
    expect(deck.buckets.delegated).toEqual([]); // child is nested, not a flat delegated card
    expect(deck.buckets.running[0].children.map((c) => c.runId)).toEqual(['ch']);
    expect(deck.buckets.running[0].children[0].status).toBe('delegated'); // a running child = delegated work
    expect(deck.buckets.running[0].children[0].delegatedBy).toBe('agent:a1');
  });

  it('an orphan child (parent out of scope) surfaces as a top-level delegated card', () => {
    const child = run('ch', 'running', { parentRunId: 'missing-parent' });
    const deck = taskDeckProjection([child], NO_BLOCKS);
    expect(deck.buckets.delegated.map((c) => c.runId)).toEqual(['ch']);
  });

  it('joins the blocked reason + resume ref for a blocked run', () => {
    const blocked = new Map<string, BlockedInfo>([['x', { interruptId: 'int-1', nodeId: 'gate', kind: 'approval' }]]);
    const deck = taskDeckProjection([run('x', 'waiting-approval')], blocked);
    const card = deck.buckets.blocked[0];
    expect(card.blockedReason).toBe('approval');
    expect(card.resumeRef).toEqual({ runId: 'x', nodeId: 'gate', interruptId: 'int-1' });
  });

  it('prefers the native parentRunId over the metadata stamp', () => {
    const child = run('ch', 'completed', { parentRunId: 'native-p', metadata: { parentRunId: 'meta-p' } });
    const deck = taskDeckProjection([run('native-p', 'running'), child], NO_BLOCKS);
    expect(deck.buckets.running[0].children.map((c) => c.runId)).toEqual(['ch']); // grouped under native-p
  });

  it('title falls back workflowId → runId; metadata.title wins', () => {
    const deck = taskDeckProjection([run('a', 'running', { metadata: { title: 'My Task' } })], NO_BLOCKS);
    expect(deck.buckets.running[0].title).toBe('My Task');
  });
});
