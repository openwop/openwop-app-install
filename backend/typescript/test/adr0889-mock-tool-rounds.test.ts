/**
 * ADR 0889 D6 / P2 — the scripted tool-call mock.
 *
 * Before this, `callAIWithTools` threw for `mock` and `providerSupportsToolCalling`
 * said no, so no chat or agent trajectory could run without a real key. The
 * mock is test-seam gated exactly like every other mock path, and it is NOT
 * added to the advertised tool-calling provider list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiProvidersAdapter, providerSupportsToolCalling } from '../src/aiProviders/aiProvidersHost.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';

const ENV = 'OPENWOP_MOCK_PROVIDER_ENABLED';

describe('ADR 0889 D6 — scripted mock tool rounds', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[ENV];
    resetMockPrograms();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
    resetMockPrograms();
  });

  const tools = [{ name: 'crm_lookup', description: 'look up', inputSchema: { type: 'object' } }];
  const req = { provider: 'mock', model: 'mock-mini', messages: [{ role: 'user' as const, content: 'hi' }], tools };

  it('replays programmed tool calls, then the final text, emitting provider.usage per round', async () => {
    process.env[ENV] = 'true';
    programMock('n-tools', [
      { toolCalls: [{ name: 'crm_lookup', input: { id: 7 } }, { name: 'crm_lookup', input: { id: 8 } }], inputTokens: 11, outputTokens: 3 },
      { content: 'all done' },
    ]);
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const adapter = createAiProvidersAdapter({
      runId: 'r-1', nodeId: 'n-tools', tenantId: 't-1', attempt: 1, secrets: {},
      emit: async (type: string, payload: unknown) => { emitted.push({ type, payload }); },
    } as never);

    const r1 = await adapter.callAIWithTools!(req as never);
    expect(r1.toolCalls).toEqual([
      { id: 'mock-call-0-0', name: 'crm_lookup', input: { id: 7 } },
      { id: 'mock-call-0-1', name: 'crm_lookup', input: { id: 8 } },
    ]);
    const r2 = await adapter.callAIWithTools!(req as never);
    expect(r2.content).toBe('all done');
    expect(r2.toolCalls ?? []).toEqual([]);
    expect(emitted.filter((e) => e.type === 'provider.usage')).toHaveLength(2);
  });

  it('is refused when the mock provider is disabled (production posture)', async () => {
    process.env[ENV] = 'false';
    expect(providerSupportsToolCalling('mock')).toBe(false);
    const adapter = createAiProvidersAdapter({ runId: 'r-2', nodeId: 'n', tenantId: 't', attempt: 1, secrets: {} } as never);
    await expect(adapter.callAIWithTools!(req as never)).rejects.toThrow();
  });

  it('does NOT make the mock chat-tool-eligible: scripted rounds are an eval-lane path, chat on mock stays plain', () => {
    // The CS-GB-1 contract (model-router-conversation-target.test.ts): a mock
    // chat turn is a plain completion even on a test host.
    process.env[ENV] = 'true';
    expect(providerSupportsToolCalling('mock')).toBe(false);
    expect(providerSupportsToolCalling('anthropic')).toBe(true);
    expect(providerSupportsToolCalling('nope')).toBe(false);
  });
});
