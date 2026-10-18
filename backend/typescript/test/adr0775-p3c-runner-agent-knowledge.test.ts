/**
 * ADR 0775 P3c (`ARWF-13`, knowledge half) — the agent-runner node, which every
 * autonomous lane ends in (a scheduled turn, a follow-up, a heartbeat fallback),
 * composes the agent's OWN bound knowledge into the turn, as chat and the ad-hoc
 * dispatch lane already did. Before this the run path passed no
 * `knowledgeRetrieve`, so the same agent answered a schedule without the
 * knowledge it cites in chat.
 *
 * The resolver is stubbed (its own behaviour is covered by the agent-knowledge
 * tests); what this pins is that the runner asks for it with the RESOLVED profile
 * id and that what it returns reaches the model.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveAgentKnowledgeRetrieve } = vi.hoisted(() => ({ resolveAgentKnowledgeRetrieve: vi.fn() }));
vi.mock('../src/host/agentKnowledgeComposition.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/agentKnowledgeComposition.js')>()),
  resolveAgentKnowledgeRetrieve,
}));
// The real port needs the host surfaces booted; the stubbed resolver never reads it.
vi.mock('../src/host/agentMemoryAdapter.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/agentMemoryAdapter.js')>()),
  createAgentMemoryPort: () => ({}),
}));

import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { getAgentRegistry, type ResolvedAgentManifest } from '../src/executor/agentRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import type { AiCallRequest, AiCallResult, NodeContext } from '../src/executor/types.js';

const MARKER = 'P3C-KNOWLEDGE-MARKER: invoices over 5000 need a second approver';

describe('agent-runner composes the agent\'s bound knowledge', () => {
  const registry = getAgentRegistry();
  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });
  beforeEach(() => {
    registry._resetForTest();
    resolveAgentKnowledgeRetrieve.mockReset();
  });

  async function run(): Promise<{ out: unknown; seen: string; rosterId: string }> {
    registry.register({
      agentId: 'test.p3c-agent', persona: 'P3c', modelClass: 'chat', systemPrompt: 'You review invoices.',
      packName: 'test', packVersion: '0', toolAllowlist: [],
    } as ResolvedAgentManifest);
    const entry = await createRosterEntry({ tenantId: 'tenant-p3c', persona: `P3c ${Date.now()}`, agentRef: { agentId: 'test.p3c-agent', version: '0' } });
    let seen = '';
    const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async (req) => {
      seen = JSON.stringify(req);
      return { data: 'done' };
    });
    const out = await agentRunnerNode.execute({
      tenantId: 'tenant-p3c', runId: `run-p3c-${Date.now()}`, config: { offerTools: [] }, configurable: {},
      inputs: { agentId: entry.rosterId, task: 'review the overnight invoices', credentialRef: 'managed:openwop-free' },
      emit: async () => {}, callAI, callAIWithTools: vi.fn(async () => { throw new Error('no tools offered'); }),
    } as unknown as NodeContext);
    return { out, seen, rosterId: entry.rosterId };
  }

  it('asks for the RESOLVED profile and puts the returned knowledge in front of the model', async () => {
    resolveAgentKnowledgeRetrieve.mockResolvedValue(async () => [{ content: MARKER, title: 'AP policy', kind: 'kb' as const }]);
    const { out, seen, rosterId } = await run();
    expect((out as { status: string }).status, JSON.stringify(out)).toBe('success');
    expect(resolveAgentKnowledgeRetrieve).toHaveBeenCalledTimes(1);
    expect(resolveAgentKnowledgeRetrieve.mock.calls[0]![0]).toBe('tenant-p3c');
    expect(resolveAgentKnowledgeRetrieve.mock.calls[0]![1]).toBe(rosterId);
    expect(seen).toContain(MARKER);
  });

  it('a resolver fault degrades to no knowledge block, never a failed turn', async () => {
    resolveAgentKnowledgeRetrieve.mockRejectedValue(new Error('kb backend down'));
    const { out, seen } = await run();
    expect((out as { status: string }).status, JSON.stringify(out)).toBe('success');
    expect(seen).not.toContain(MARKER);
  });
});
