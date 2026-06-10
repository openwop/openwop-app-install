/**
 * A10 — verifier/critic in the live dispatch (RFC 0090). An injected critic runs
 * over the actor's result before commit; it emits `agent.verified`, and on a
 * gating host a non-`pass` verdict escalates instead of completing.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { runAgentDispatchLive, type AgentVerifier, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import type { AiCallResult } from '../src/executor/types.js';

function register(): void {
  getAgentRegistry().register({
    agentId: 'verify.agent',
    persona: 'Actor',
    modelClass: 'general',
    systemPrompt: 'Do the task.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0.5 },
  });
}

const callAI: LiveDispatchDeps['callAI'] = async (): Promise<AiCallResult> => ({ content: 'answer' });

afterEach(() => getAgentRegistry()._resetForTest());

describe('runAgentDispatchLive — verifier (A10 / RFC 0090)', () => {
  it('emits agent.verified and completes on pass', async () => {
    register();
    const verifier: AgentVerifier = async () => ({ verdict: 'pass', criteria: ['grounded'], confidence: 0.9 });

    const res = await runAgentDispatchLive(
      { agentId: 'verify.agent', task: 't' },
      { callAI, verifier, verifierGating: true },
    );

    expect(res.status).toBe('completed');
    const v = res.events.find((e) => e.type === 'agent.verified');
    expect(v?.verdict).toBe('pass');
    expect(v?.target).toBe('verify.agent');
    expect(v?.criteria).toEqual(['grounded']);
  });

  it('escalates on a gating fail verdict', async () => {
    register();
    const verifier: AgentVerifier = async () => ({ verdict: 'fail' });

    const res = await runAgentDispatchLive(
      { agentId: 'verify.agent', task: 't' },
      { callAI, verifier, verifierGating: true },
    );

    expect(res.status).toBe('escalated');
    expect(res.events.find((e) => e.type === 'agent.verified')?.verdict).toBe('fail');
    // No final-decision commit on a gated turn.
    expect(res.events.some((e) => e.type === 'agent.decided' && e.decision === 'escalate')).toBe(true);
  });

  it('does not gate when verifierGating is off (verdict is observational)', async () => {
    register();
    const verifier: AgentVerifier = async () => ({ verdict: 'fail' });

    const res = await runAgentDispatchLive(
      { agentId: 'verify.agent', task: 't' },
      { callAI, verifier }, // no gating
    );

    expect(res.status).toBe('completed');
    expect(res.events.find((e) => e.type === 'agent.verified')?.verdict).toBe('fail');
  });
});
