/**
 * ADR 0433 — agent-dispatch provenance (the PRD §13 delegation record).
 *
 *  - ABSENT stays absent: a caller that supplies nothing gets no provenance,
 *    never an inferred parent (the dispatcher must not fabricate attribution)
 *  - SUPPLIED echoes verbatim on success AND on escalation/failure, so a
 *    delegation is attributable regardless of outcome
 *  - `mergeDecision` defaults to `pending` — "supplied but unjudged" is
 *    distinguishable from "not recorded"
 *  - `recordMergeDecision` is pure and never invents a record
 *  - existing callers are unaffected (every field optional)
 */
import { describe, expect, it } from 'vitest';
import {
  runAgentDispatch,
  echoProvenance,
  recordMergeDecision,
  type AgentDispatchProvenance,
} from '../src/host/agentDispatch.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';

const FULL: AgentDispatchProvenance = {
  parentAgentId: 'host:kickbot',
  parentSubject: 'user:parent-1',
  projectSubject: 'project:candidate-7',
  specialistVersion: '1.2.0',
  workflowId: 'openwop-app.kicktodo.plan-generation',
  workflowVersion: '1.0.0',
  nodeId: 'generate',
  nodeVersion: '1.0.0',
  contextRefs: ['artifact:plan-draft-3'],
  budget: { maxUsd: 0.5, maxTokens: 20000 },
};

function anyAgentId(): string | null {
  const agents = getAgentRegistry().list();
  return agents[0]?.agentId ?? null;
}

describe('echoProvenance / recordMergeDecision (pure)', () => {
  it('absent stays absent — the dispatcher never fabricates attribution', () => {
    expect(echoProvenance(undefined)).toBeUndefined();
    expect(recordMergeDecision(undefined, 'accepted')).toBeUndefined();
  });

  it('supplied echoes verbatim and defaults mergeDecision to pending', () => {
    const echoed = echoProvenance(FULL)!;
    expect(echoed.mergeDecision).toBe('pending'); // supplied-but-unjudged
    // Every caller-supplied field survives untouched.
    for (const [k, v] of Object.entries(FULL)) {
      expect(echoed[k as keyof AgentDispatchProvenance]).toEqual(v);
    }
  });

  it('an explicit mergeDecision is preserved, not overwritten by the default', () => {
    expect(echoProvenance({ ...FULL, mergeDecision: 'rejected' })!.mergeDecision).toBe('rejected');
  });

  it('recordMergeDecision is pure — the input record is not mutated', () => {
    const input: AgentDispatchProvenance = { ...FULL, mergeDecision: 'pending' };
    const stamped = recordMergeDecision(input, 'accepted-with-edits')!;
    expect(stamped.mergeDecision).toBe('accepted-with-edits');
    expect(input.mergeDecision).toBe('pending'); // untouched
  });
});

describe('runAgentDispatch echo', () => {
  it('omits provenance entirely when the caller supplies none (no shape change for existing callers)', () => {
    const agentId = anyAgentId();
    if (!agentId) return; // no manifest agents installed in this environment
    const result = runAgentDispatch({ agentId, task: { goal: 'x' } } as never);
    expect(result.provenance).toBeUndefined();
    expect('provenance' in result).toBe(false);
  });

  it('echoes provenance onto the result when supplied', () => {
    const agentId = anyAgentId();
    if (!agentId) return;
    const result = runAgentDispatch({ agentId, task: { goal: 'x' }, provenance: FULL } as never);
    expect(result.provenance?.parentAgentId).toBe('host:kickbot');
    expect(result.provenance?.workflowId).toBe('openwop-app.kicktodo.plan-generation');
    expect(result.provenance?.mergeDecision).toBe('pending');
    // Context refs are ids only — no content ever rides the record.
    expect(result.provenance?.contextRefs).toEqual(['artifact:plan-draft-3']);
  });
});
