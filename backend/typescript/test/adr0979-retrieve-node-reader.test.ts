/**
 * ADR 0979 D2 + D3 — the two pure decisions behind the ledger fix.
 *
 * D3 (closes ADR 0664 AGKM-10): the agent-knowledge retrieve node used to read
 * every bound corpus PRE-AUTHORIZED (no caller), so a workflow author could name
 * any roster agent and pull its project-bound corpora into a run output. It now
 * reads as the run's actor, else as a subject-less caller carrying only the
 * causing member for the org floor, never pre-authorized. What `kbService` does
 * with each caller shape is pinned by its own tests (KBC-1, ADR 0830); this file
 * pins which shape the node hands it.
 *
 * D2: the fabricated-output detector, including the chain-pack `@version`
 * suffix and the rule that a node which never completed did not produce output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveForAgent = vi.fn(async (..._args: unknown[]) => ({ chunks: [], hasResults: false, failedSources: [] }));
vi.mock('../src/features/agent-knowledge/service.js', () => ({
  retrieveForAgent: (...args: unknown[]) => retrieveForAgent(...args),
  ingestDocToBoundCollection: vi.fn(),
}));

const { buildAgentKnowledgeSurface } = await import('../src/features/agent-knowledge/surface.js');
const { runOutputWasFabricated } = await import('../src/host/workflowDemoAvailability.js');

const callerOf = async (scope: Record<string, unknown>): Promise<unknown> => {
  retrieveForAgent.mockClear();
  const surface = buildAgentKnowledgeSurface({ tenantId: 't1', runId: 'r1', ...scope }) as { retrieve: (a: unknown) => Promise<unknown> };
  await surface.retrieve({ agentId: 'host:ava', query: 'q' });
  expect(retrieveForAgent).toHaveBeenCalledTimes(1);
  return retrieveForAgent.mock.calls[0]![3];
};

describe('ADR 0979 D3 — the retrieve node never reads as nobody', () => {
  beforeEach(() => retrieveForAgent.mockClear());

  it('a run with an actor reads as that actor', async () => {
    expect(await callerOf({ actingUserId: 'user:alice' })).toEqual({ subject: 'user:alice' });
  });

  it('an actorless run reads as no subject, with the causing member for the org floor only', async () => {
    expect(await callerOf({ orgScopeSubject: 'user:bob' })).toEqual({ orgScopeSubject: 'user:bob' });
  });

  it('a run with neither is a subject-less caller — never pre-authorized', async () => {
    const caller = await callerOf({});
    expect(caller).toEqual({});
    expect(caller).not.toHaveProperty('preAuthorized');
  });
});

describe('ADR 0979 D2 — runOutputWasFabricated', () => {
  const state = (entries: Array<[string, string]>) => new Map(entries);
  const outs = (entries: Array<[string, Record<string, unknown>]>) => new Map(entries);

  it('detects the mock-AI node with or without a version suffix', () => {
    for (const typeId of ['local.sample.demo.mock-ai', 'local.sample.demo.mock-ai@0.1.0']) {
      expect(runOutputWasFabricated([{ nodeId: 'm', typeId }], state([['m', 'completed']]), outs([]))).toBe(true);
    }
  });

  it('a mock node that never completed produced nothing', () => {
    expect(runOutputWasFabricated([{ nodeId: 'm', typeId: 'local.sample.demo.mock-ai' }], state([['m', 'skipped']]), outs([]))).toBe(false);
  });

  it('detects every placeholder marker web search returns, and nothing else', () => {
    const one = (o: Record<string, unknown>) => runOutputWasFabricated([{ nodeId: 's', typeId: 'core.web.search' }], state([['s', 'completed']]), outs([['s', o]]));
    expect(one({ stub: true })).toBe(true);
    expect(one({ engine: 'stub' })).toBe(true);
    expect(one({ engine: 'demo' })).toBe(true);
    expect(one({ engine: 'brave', results: [] })).toBe(false);
    expect(one({ stub: 'true' })).toBe(false);
  });
});
