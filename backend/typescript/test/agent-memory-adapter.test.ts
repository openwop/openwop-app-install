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
import { runAgentDispatchLive, MEMORY_UNTRUSTED_TAG, type LiveDispatchDeps } from '../src/host/agentDispatch.js';
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

  it('SR-1: scrubs secret-shaped tokens before the durable write + embed (RFC 0004)', async () => {
    const port = createAgentMemoryPort('tenant-sr1');
    const scope = agentMemoryScope('mem.sr1');
    await port.write(scope, { content: 'the api key is sk-abcd1234efgh5678ijkl and the user prefers email' });
    const joined = (await port.read(scope)).map((e) => e.content).join(' ');
    expect(joined).toContain('[REDACTED:secret-shaped]');
    expect(joined).not.toContain('sk-abcd1234efgh5678ijkl');
    expect(joined).toContain('prefers email'); // surrounding non-secret text preserved
  });

  it('surfaces contentTrust from the untrusted tag on BOTH read paths (ADR 0038 §C review fix)', async () => {
    const port = createAgentMemoryPort('tenant-trust');
    const scope = agentMemoryScope('mem.trust');
    await port.write(scope, { content: 'derived from a webhook payload', tags: ['mem.trust', MEMORY_UNTRUSTED_TAG] });
    await port.write(scope, { content: 'a hand-curated trusted note', tags: ['mem.trust'] });

    // Recency path (no query) carries the durable tag → contentTrust.
    const recency = await port.read(scope);
    expect(recency.find((e) => e.content.includes('webhook'))?.contentTrust).toBe('untrusted');
    expect(recency.find((e) => e.content.includes('curated'))?.contentTrust).toBe('trusted');

    // RAG path (query) carries the mirrored vector-metadata contentTrust.
    const rag = await port.read(scope, 'webhook payload');
    expect(rag.find((e) => e.content.includes('webhook'))?.contentTrust).toBe('untrusted');
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
