/**
 * A2 — the built-in agent tool catalog + executor wired to real host surfaces.
 *
 * Proves the tool loop runs end-to-end against a REAL host capability (the
 * knowledge RAG surface, network-free), not just an injected mock: a live
 * dispatch whose model calls `openwop:knowledge.search` has the host actually
 * execute the retrieval and feed real results back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { runAgentDispatchLive, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import { builtinAgentToolIds, createAgentToolProvider } from '../src/host/agentToolProvider.js';
import type { AiToolCallResult } from '../src/executor/types.js';

afterEach(() => getAgentRegistry()._resetForTest());

describe('agent tool provider (A2)', () => {
  it('exposes openwop:knowledge.search and executes it against the real surface', async () => {
    const provider = createAgentToolProvider({ tenantId: 'tenant-a' });
    expect(builtinAgentToolIds()).toContain('openwop:knowledge.search');
    expect(provider.resolveTool('openwop:knowledge.search')?.inputSchema).toBeTypeOf('object');
    expect(provider.resolveTool('nope')).toBeUndefined();

    const out = await provider.executeTool({ name: 'openwop:knowledge.search', input: { query: 'workflow' } });
    expect(out.isError).toBeFalsy();
    // The real knowledge surface returns a structured RAG result.
    const parsed = JSON.parse(out.content) as { chunks?: unknown[]; hasResults?: boolean };
    expect(Array.isArray(parsed.chunks)).toBe(true);
  });

  it('runs the dispatch loop end-to-end with the real executor', async () => {
    getAgentRegistry().register({
      agentId: 'research.agent',
      persona: 'Researcher',
      modelClass: 'research',
      systemPrompt: 'Ground answers in the knowledge base.',
      packName: 'test',
      packVersion: '0',
      toolAllowlist: ['openwop:knowledge.search'],
      confidence: { defaultThreshold: 0.5 },
    });
    const provider = createAgentToolProvider({ tenantId: 'tenant-a' });

    let round = 0;
    const executedResults: string[] = [];
    const callAIWithTools = async (): Promise<AiToolCallResult> => {
      round += 1;
      if (round === 1) {
        return { toolCalls: [{ id: 'c1', name: 'openwop:knowledge.search', input: { query: 'workflow' } }], finishReason: 'tool-call' };
      }
      return { content: 'Grounded answer.', toolCalls: [], finishReason: 'stop' };
    };
    // Wrap the real executor to capture what came back.
    const executeTool: LiveDispatchDeps['executeTool'] = async (call) => {
      const r = await provider.executeTool(call);
      executedResults.push(r.content);
      return r;
    };
    const callAINever: LiveDispatchDeps['callAI'] = async () => {
      throw new Error('single-shot path must not run');
    };

    const res = await runAgentDispatchLive(
      { agentId: 'research.agent', task: 'What is a workflow?', availableTools: ['openwop:knowledge.search'] },
      { callAI: callAINever, callAIWithTools, resolveTool: provider.resolveTool, executeTool },
    );

    expect(res.status).toBe('completed');
    expect(res.events.find((e) => e.type === 'agent.toolReturned')?.status).toBe('ok');
    // The real knowledge surface ran and produced a structured result.
    expect(executedResults).toHaveLength(1);
    expect(JSON.parse(executedResults[0]!)).toHaveProperty('chunks');
    expect((res.result as { content?: string }).content).toBe('Grounded answer.');
  });
});
