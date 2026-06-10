/**
 * A4 — the concrete `AgentMemoryPort` over the host's RFC 0004 memory store.
 * Complements agent-dispatch-memory.test.ts (which proves the DISPATCH behavior
 * with a mock port) by proving the real adapter: a tenant-bound read/write
 * round-trip against `inMemorySurfaces`, cross-tenant isolation (CTI-1), a stable
 * per-agent namespace, and an end-to-end live dispatch where prior memory
 * persisted by the adapter reaches the next turn's prompt.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createAgentMemoryPort, agentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { runAgentDispatchLive, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
import type { AiCallResult } from '../src/executor/types.js';

beforeAll(() => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-agentmem-')) });
});
afterEach(() => getAgentRegistry()._resetForTest());

describe('agentMemoryScope', () => {
  it('namespaces per agent, distinct from the demo ref', () => {
    expect(agentMemoryScope('core.x')).toBe('agent:core.x');
    expect(agentMemoryScope('a')).not.toBe(agentMemoryScope('b'));
  });
});

describe('createAgentMemoryPort — real store round-trip', () => {
  it('writes then reads back within a tenant + scope', async () => {
    const port = createAgentMemoryPort('tenant-a');
    const scope = agentMemoryScope('mem.agent');
    await port.write(scope, { content: 'user prefers terse answers', tags: ['pref'] });
    await port.write(scope, { content: 'project deadline is friday' });
    const entries = await port.read(scope);
    const contents = entries.map((e) => e.content);
    expect(contents).toContain('user prefers terse answers');
    expect(contents).toContain('project deadline is friday');
  });

  it('isolates by tenant (CTI-1) — a different tenant sees nothing', async () => {
    const scope = agentMemoryScope('shared.id');
    await createAgentMemoryPort('tenant-x').write(scope, { content: 'x-only secret' });
    const other = await createAgentMemoryPort('tenant-y').read(scope);
    expect(other.map((e) => e.content)).not.toContain('x-only secret');
  });

  it('isolates by agent scope within one tenant', async () => {
    const port = createAgentMemoryPort('tenant-b');
    await port.write(agentMemoryScope('agent.one'), { content: 'one note' });
    const two = await port.read(agentMemoryScope('agent.two'));
    expect(two.map((e) => e.content)).not.toContain('one note');
  });

  it('feeds prior memory into a live dispatch turn end-to-end', async () => {
    getAgentRegistry().register({
      agentId: 'mem.live', persona: 'Rememberer', modelClass: 'general',
      systemPrompt: 'Use memory.', packName: 'test', packVersion: '0',
      toolAllowlist: [], confidence: { defaultThreshold: 0.5 }, memoryShape: { longTerm: true },
    });
    const port = createAgentMemoryPort('tenant-live');
    const scope = agentMemoryScope('mem.live');
    await port.write(scope, { content: 'remembered fact: sky is teal' });

    let saw = '';
    const callAI: LiveDispatchDeps['callAI'] = async (req): Promise<AiCallResult> => {
      saw = req.messages.map((m) => m.content).join('\n');
      return { content: 'ok' };
    };
    const res = await runAgentDispatchLive(
      { agentId: 'mem.live', task: 'answer the question' },
      { callAI, memory: port, memoryScope: scope },
    );
    expect(res.status).toBe('completed');
    // The adapter-persisted memory reached the model's prompt.
    expect(saw).toContain('remembered fact: sky is teal');
    expect(saw).toContain('answer the question');
    // And the completed turn wrote a new summary back to the same scope.
    const after = await port.read(scope);
    expect(after.length).toBeGreaterThan(1);
  });
});
