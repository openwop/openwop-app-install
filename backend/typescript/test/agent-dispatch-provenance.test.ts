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
 *
 * Tracker TST-BKX-5. The dispatch cases register their OWN agent: the in-process
 * registry is empty in this file, and an earlier `if (!agentId) return` let both
 * cases pass without asserting anything (w65 probe vacuous). Red when the result
 * stops carrying provenance (success, escalation or failure), the pending default
 * or an explicit decision is lost, or recordMergeDecision mutates its input —
 * each sabotage-witnessed (w65).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  runAgentDispatch,
  echoProvenance,
  recordMergeDecision,
  type AgentDispatchProvenance,
  type AgentDispatchRequest,
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

const AGENT = 'prov.agent';
beforeAll(() => {
  getAgentRegistry().register({
    agentId: AGENT, persona: 'Prov', modelClass: 'general', systemPrompt: 'x',
    packName: 'test', packVersion: '0', toolAllowlist: [],
    handoff: {
      taskSchema: { type: 'object', required: ['goal'] },
      validateTask: (v: unknown) => (v && typeof v === 'object' && 'goal' in v ? { ok: true } : { ok: false, errors: 'missing goal' }),
    },
  });
});

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
    const req: AgentDispatchRequest = { agentId: AGENT, task: { goal: 'x' } };
    const result = runAgentDispatch(req);
    expect(result.status).toBe('completed');
    expect(result.provenance).toBeUndefined();
    expect('provenance' in result).toBe(false);
  });

  it('echoes provenance onto the result when supplied — on success, escalation AND failure', () => {
    const ok = runAgentDispatch({ agentId: AGENT, task: { goal: 'x' }, provenance: FULL });
    expect(ok.status).toBe('completed');
    expect(ok.provenance?.parentAgentId).toBe('host:kickbot');
    expect(ok.provenance?.workflowId).toBe('openwop-app.kicktodo.plan-generation');
    expect(ok.provenance?.mergeDecision).toBe('pending');
    // Context refs are ids only — no content ever rides the record.
    expect(ok.provenance?.contextRefs).toEqual(['artifact:plan-draft-3']);

    const escalated = runAgentDispatch({ agentId: AGENT, task: { goal: 'x' }, provenance: FULL, simulateConfidence: 0.1 });
    expect(escalated.status).toBe('escalated');
    expect(escalated.provenance?.parentAgentId).toBe('host:kickbot');

    const failed = runAgentDispatch({ agentId: AGENT, task: { nope: 1 }, provenance: FULL });
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('task_schema_violation');
    expect(failed.provenance?.parentAgentId).toBe('host:kickbot');
  });
});
