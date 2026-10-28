/**
 * ADR 0889 D6 / P2 — the scripted tool-call mock (TST-BPA).
 *
 * Before this, `callAIWithTools` threw for `mock` and `providerSupportsToolCalling`
 * said no, so no chat or agent trajectory could run without a real key. The
 * mock is test-seam gated exactly like every other mock path, and it is NOT
 * added to the advertised tool-calling provider list.
 *
 * Red when (each sabotage-witnessed, wave 65): the `mockProviderEnabled()` gate is
 * dropped from the mock branch of `callAIWithTools` ⇒ "is refused when…"; the mock
 * call id loses its round index, or the mock round stops emitting `provider.usage`,
 * or the programmed token counts are replaced by the defaults ⇒ "replays…";
 * `mock` is added to `TOOL_CALLING_PROVIDERS` ⇒ "does NOT make…".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiProvidersAdapter, providerSupportsToolCalling, type AdapterScope } from '../src/aiProviders/aiProvidersHost.js';
import type { AiToolCallRequest } from '../src/executor/types.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';

const ENV = 'OPENWOP_MOCK_PROVIDER_ENABLED';
const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };

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
  const req: AiToolCallRequest = { provider: 'mock', model: 'mock-mini', messages: [{ role: 'user', content: 'hi' }], tools };

  it('replays programmed tool calls, then the final text, emitting provider.usage per round', async () => {
    process.env[ENV] = 'true';
    programMock('n-tools', [
      { toolCalls: [{ name: 'crm_lookup', input: { id: 7 } }, { name: 'crm_lookup', input: { id: 8 } }], inputTokens: 11, outputTokens: 3 },
      { content: 'all done', inputTokens: 13, outputTokens: 5 },
    ]);
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const scope: AdapterScope = {
      runId: 'r-1', nodeId: 'n-tools', tenantId: 't-1', attempt: 1, secrets: {}, policyResolver,
      emit: async (type: string, payload: unknown) => { emitted.push({ type, payload }); return { eventId: `e-${emitted.length}`, sequence: emitted.length }; },
    };
    const adapter = createAiProvidersAdapter(scope);

    const r1 = await adapter.callAIWithTools(req);
    expect(r1.toolCalls).toEqual([
      { id: 'mock-call-0-0', name: 'crm_lookup', input: { id: 7 } },
      { id: 'mock-call-0-1', name: 'crm_lookup', input: { id: 8 } },
    ]);
    expect(r1.finishReason).toBe('tool-call');
    const r2 = await adapter.callAIWithTools(req);
    expect(r2.content).toBe('all done');
    expect(r2.toolCalls ?? []).toEqual([]);
    expect(r2.finishReason).toBe('stop');
    const usage = emitted.filter((e) => e.type === 'provider.usage').map((e) => e.payload as { inputTokens: number; outputTokens: number; nodeId?: string });
    expect(usage.map((u) => [u.inputTokens, u.outputTokens, u.nodeId])).toEqual([[11, 3, 'n-tools'], [13, 5, 'n-tools']]);
  });

  it('is refused when the mock provider is disabled (production posture)', async () => {
    process.env[ENV] = 'false';
    const adapter = createAiProvidersAdapter({ runId: 'r-2', nodeId: 'n', tenantId: 't', attempt: 1, secrets: {}, policyResolver });
    await expect(adapter.callAIWithTools(req)).rejects.toMatchObject({ code: 'host_capability_missing' });
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
