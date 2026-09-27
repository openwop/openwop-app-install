/**
 * ADR 0475 — the store's debug-session slice: pin upsert/remove, session
 * lifecycle (last unpin with no source run collapses to null), and the
 * cross-workflow isolation rule (loadFromSaved never carries pins over).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useBuilderStore } from '../builderStore.js';
import type { SavedWorkflow } from '../../schema/workflow.js';

const wfA: SavedWorkflow = {
  id: 'wf-debug-a', name: 'A', version: '1.0.0', nodes: [], edges: [], createdAt: 'now', updatedAt: 'now',
};
const wfB: SavedWorkflow = {
  id: 'wf-debug-b', name: 'B', version: '1.0.0', nodes: [], edges: [], createdAt: 'now', updatedAt: 'now',
};
const s = () => useBuilderStore.getState();
const pin = (backendNodeId: string) => ({ backendNodeId, output: { marker: backendNodeId } });

beforeEach(() => {
  s().loadFromSaved(wfA);
});

describe('builderStore — debug session (ADR 0475)', () => {
  it('setDebugPin creates the session on first pin and upserts on repeat', () => {
    expect(s().debugSession).toBeNull();
    s().setDebugPin('n1', pin('n1'));
    expect(Object.keys(s().debugSession!.pins)).toEqual(['n1']);
    s().setDebugPin('n1', { backendNodeId: 'n1', output: { marker: 'v2' } });
    expect(s().debugSession!.pins.n1!.output).toEqual({ marker: 'v2' });
    expect(Object.keys(s().debugSession!.pins)).toHaveLength(1);
  });

  it('removeDebugPin collapses the session to null when the last pin goes (no source run)', () => {
    s().setDebugPin('n1', pin('n1'));
    s().setDebugPin('n2', pin('n2'));
    s().removeDebugPin('n1');
    expect(Object.keys(s().debugSession!.pins)).toEqual(['n2']);
    s().removeDebugPin('n2');
    expect(s().debugSession).toBeNull();
  });

  it('a session anchored to a source run survives its last unpin (the banner keeps the run link)', () => {
    s().setDebugSession({ pins: { n1: pin('n1') }, sourceRunId: 'run-123' });
    s().removeDebugPin('n1');
    expect(s().debugSession).not.toBeNull();
    expect(s().debugSession!.sourceRunId).toBe('run-123');
  });

  it('loadFromSaved never carries pins across workflows (isolation rule)', () => {
    s().setDebugPin('n1', pin('n1'));
    s().loadFromSaved(wfB);
    expect(s().debugSession).toBeNull();
  });
});
