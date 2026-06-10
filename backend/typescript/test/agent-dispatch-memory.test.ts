/**
 * A4 — live cross-run agent memory during dispatch (RFC 0004 MemoryAdapter,
 * host-internal). Pure-unit with an injected in-memory port: proves a manifest
 * agent that declares `memoryShape.longTerm` now (a) reads prior memory into the
 * turn's context and (b) writes a turn summary on a completed turn — and that an
 * agent without `longTerm` (or without the wired port) touches no memory.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { runAgentDispatchLive, type AgentMemoryPort, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import type { AiCallResult } from '../src/executor/types.js';

function register(agentId: string, longTerm: boolean): void {
  getAgentRegistry().register({
    agentId,
    persona: 'Rememberer',
    modelClass: 'general',
    systemPrompt: 'Answer using memory.',
    packName: 'test',
    packVersion: '0',
    toolAllowlist: [],
    confidence: { defaultThreshold: 0.5 },
    memoryShape: { longTerm },
  });
}

/** A capturing memory port + a capturing callAI so we can assert what the
 *  model actually saw and what got written. */
function harness(seed: string[]) {
  const store: { content: string }[] = seed.map((content) => ({ content }));
  const reads: string[] = [];
  const writes: { scope: string; content: string }[] = [];
  const memory: AgentMemoryPort = {
    async read(scope) {
      reads.push(scope);
      return store;
    },
    async write(scope, entry) {
      writes.push({ scope, content: entry.content });
      store.push({ content: entry.content });
    },
  };
  let sawContent = '';
  const callAI: LiveDispatchDeps['callAI'] = async (req): Promise<AiCallResult> => {
    sawContent = req.messages.map((m) => m.content).join('\n');
    return { content: 'done' };
  };
  return { memory, reads, writes, callAI, getSaw: () => sawContent };
}

afterEach(() => getAgentRegistry()._resetForTest());

describe('runAgentDispatchLive — cross-run memory (A4)', () => {
  it('reads prior memory into the prompt and writes a turn summary on completion', async () => {
    register('mem.agent', true);
    const h = harness(['user prefers terse answers']);

    const res = await runAgentDispatchLive(
      { agentId: 'mem.agent', task: 'summarize the report' },
      { callAI: h.callAI, memory: h.memory, memoryScope: 'tenant-a/mem.agent' },
    );

    expect(res.status).toBe('completed');
    // Prior memory reached the model.
    expect(h.reads).toEqual(['tenant-a/mem.agent']);
    expect(h.getSaw()).toContain('user prefers terse answers');
    expect(h.getSaw()).toContain('summarize the report');
    // A summary was written back to the same scope.
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.scope).toBe('tenant-a/mem.agent');
    expect(h.writes[0]?.content).toContain('summarize the report');
  });

  it('does NOT touch memory when the agent omits memoryShape.longTerm', async () => {
    register('plain.agent', false);
    const h = harness(['should not be read']);

    const res = await runAgentDispatchLive(
      { agentId: 'plain.agent', task: 'do a thing' },
      { callAI: h.callAI, memory: h.memory, memoryScope: 'tenant-a/plain.agent' },
    );

    expect(res.status).toBe('completed');
    expect(h.reads).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(h.getSaw()).not.toContain('should not be read');
  });

  it('does NOT touch memory when no port is wired (no regression)', async () => {
    register('mem.agent', true);
    const h = harness(['unused']);

    const res = await runAgentDispatchLive(
      { agentId: 'mem.agent', task: 'do a thing' },
      { callAI: h.callAI }, // no memory port / scope
    );

    expect(res.status).toBe('completed');
    expect(h.reads).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});
