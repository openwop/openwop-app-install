/**
 * The managed tier's DAILY allowance must survive a tool turn as itself.
 * `aiProvidersHost` reports it as `provider_rate_limited` and keeps the cause
 * in `details.managedCode`; the tool loop used to drop that, so the chat
 * retried after four seconds and then showed "Something went wrong"
 * (ADR 0773 G-10b, case 4, 2026-10-01).
 */
import { describe, expect, it } from 'vitest';
import { MANAGED_DAILY_LIMIT, managedLimitCode, runChatToolLoop } from '../src/host/agentDispatch.js';
import { isProviderRateLimited } from '../src/host/conversationToolLoop.js';
import { AiProviderError } from '../src/aiProviders/aiProvidersHost.js';

const daily = () => new AiProviderError('provider_rate_limited', 'Daily limit reached (50000 tokens). Resets at 00:00 UTC.', { managedCode: 'daily_limit_reached' });
const burst = () => new AiProviderError('provider_rate_limited', 'minimax_429: slow down');

describe('the managed daily limit in a tool turn', () => {
  it('is recognised by its managed code only', () => {
    expect(managedLimitCode(daily())).toBe(MANAGED_DAILY_LIMIT);
    expect(managedLimitCode(burst())).toBeUndefined();
    expect(managedLimitCode(new Error('x'))).toBeUndefined();
    expect(managedLimitCode(null)).toBeUndefined();
  });

  it('is not retried as a burst limit, while a real burst still is', () => {
    expect(isProviderRateLimited(daily())).toBe(false);
    expect(isProviderRateLimited(burst())).toBe(true);
  });

  it('ends the turn with the daily-limit code, not the folded provider code', async () => {
    const result = await runChatToolLoop(
      { provider: 'mock', model: 'm', credentialRef: '', systemPrompt: 's', messages: [{ role: 'user', content: 'go' }], tools: [], agentId: 'a1', persona: 'Probe' },
      { callAIWithTools: async () => { throw daily(); }, executeTool: async () => ({ content: '' }) },
    );
    expect(result.error?.code).toBe('daily_limit_reached');
  });

  it('keeps a burst limit as the provider code', async () => {
    const result = await runChatToolLoop(
      { provider: 'mock', model: 'm', credentialRef: '', systemPrompt: 's', messages: [{ role: 'user', content: 'go' }], tools: [], agentId: 'a1', persona: 'Probe' },
      { callAIWithTools: async () => { throw burst(); }, executeTool: async () => ({ content: '' }) },
    );
    expect(result.error?.code).toBe('provider_rate_limited');
  });
});
