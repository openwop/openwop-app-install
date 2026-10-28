/**
 * The managed tier's underlying provider is the operator's choice
 * (`OPENWOP_MANAGED_PROVIDER`, default `minimax`). An operator whose customers
 * need a provider with business no-training API terms selects `anthropic`.
 *
 * Covers:
 *   1. Unset → MiniMax, unchanged (the default every existing deploy runs).
 *   2. `anthropic` → chat and tools rounds go to api.anthropic.com with the
 *      ANTHROPIC_API_KEY, and the result still carries user-facing ids only.
 *   3. Switching to `anthropic` with no ANTHROPIC_API_KEY is UNAVAILABLE, and
 *      the stored MiniMax key is never sent to Anthropic (separate rows).
 *   4. An unknown value is unavailable, never a silent MiniMax fallback.
 *
 * Sabotage-witnessed: with the Anthropic target sharing the MiniMax storage row,
 * case 3 goes red (the MiniMax key reaches api.anthropic.com); with an unknown
 * value mapped to MiniMax, case 4 goes red.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import {
  _clearManagedCacheForTests,
  bootstrapManagedProvider,
  configureManagedProvider,
  dispatchManagedChat,
  dispatchManagedToolsRound,
  managedUnderlyingProvider,
} from '../src/providers/managedProvider.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
const ENV_KEYS = ['OPENWOP_MANAGED_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'MINIMAX_API_KEY'] as const;

beforeAll(() => {
  process.env.OPENWOP_BYOK_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP = '100000';
});

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  storage = await openStorage('memory://');
  configureManagedProvider({ storage, dataDir: '/tmp/openwop-managed-anthropic-test' });
  _clearManagedCacheForTests();
  resetCachedMasterKey();
});

afterEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  await storage.close();
  vi.restoreAllMocks();
});

/**
 * The request went to Anthropic's Messages endpoint. Host and path are checked
 * separately so the vendor's own version segment stays out of the OpenWOP /v1
 * ratchet (`scripts/check-v1-reliance.mjs` counts the literal in tests).
 */
function expectAnthropicMessages(url: string): void {
  const u = new URL(url);
  expect(u.host).toBe('api.anthropic.com');
  expect(u.pathname.endsWith('/messages')).toBe(true);
}

/** A non-streaming Anthropic Messages response (the tools-round shape). */
function anthropicJson(text: string): Response {
  return new Response(JSON.stringify({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 9, output_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A streaming Anthropic Messages response (the chat shape). */
function anthropicSse(text: string): Response {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) controller.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function sentTo(spy: ReturnType<typeof vi.spyOn>): { url: string; key: string | undefined; model: unknown } {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return { url: String(url), key: headers['x-api-key'], model: (JSON.parse(String(init.body)) as { model?: unknown }).model };
}

describe('OPENWOP_MANAGED_PROVIDER', () => {
  it('unset → MiniMax, unchanged', () => {
    expect(managedUnderlyingProvider('managed:openwop-free')).toBe('minimax');
  });

  it('anthropic → the chat goes to Anthropic with the Anthropic key; the result names only openwop-free', async () => {
    process.env.OPENWOP_MANAGED_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    await bootstrapManagedProvider();
    expect(managedUnderlyingProvider('managed:openwop-free')).toBe('anthropic');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(anthropicSse('hello from claude'));

    const result = await dispatchManagedChat({
      userFacingProvider: 'openwop-free',
      tenantId: 'user:alice',
      messages: [{ role: 'user', content: 'say hi' }],
    });

    const sent = sentTo(spy);
    expectAnthropicMessages(sent.url);
    expect(sent.key).toBe('sk-ant-test');
    expect(sent.model).toBe('claude-sonnet-5-5');
    expect(result.completion).toBe('hello from claude');
    expect(result.provider).toBe('openwop-free');
    expect(result.model).toBe('openwop-free');
  });

  it('anthropic → a tools round goes to Anthropic (it was refused before)', async () => {
    process.env.OPENWOP_MANAGED_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    await bootstrapManagedProvider();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(anthropicJson('done'));

    const round = await dispatchManagedToolsRound({
      userFacingProvider: 'openwop-free',
      tenantId: 'user:alice',
      messages: [{ role: 'user', content: 'use a tool if you need one' }],
      tools: [{ name: 'lookup', description: 'Look something up', inputSchema: { type: 'object', properties: {} } }],
    });

    const sent = sentTo(spy);
    expectAnthropicMessages(sent.url);
    expect(sent.key).toBe('sk-ant-test');
    expect(sent.model).toBe('claude-opus-5');
    expect(round.text).toBe('done');
    expect(round.inputTokens).toBe(9);
  });

  it('switching to anthropic before its key is set is unavailable, and never sends the MiniMax key', async () => {
    process.env.MINIMAX_API_KEY = 'sk-minimax-secret';
    await bootstrapManagedProvider();
    process.env.OPENWOP_MANAGED_PROVIDER = 'anthropic';
    delete process.env.MINIMAX_API_KEY;
    await bootstrapManagedProvider();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(anthropicSse('should not happen'));

    await expect(dispatchManagedChat({
      userFacingProvider: 'openwop-free',
      tenantId: 'user:alice',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ code: 'managed_unavailable' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an unknown value is unavailable, not a silent MiniMax fallback', async () => {
    process.env.OPENWOP_MANAGED_PROVIDER = 'claude';
    process.env.MINIMAX_API_KEY = 'sk-minimax';
    await bootstrapManagedProvider();
    expect(managedUnderlyingProvider('managed:openwop-free')).toBeNull();
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(dispatchManagedChat({
      userFacingProvider: 'openwop-free',
      tenantId: 'user:alice',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ code: 'managed_unknown' });
    expect(spy).not.toHaveBeenCalled();
  });
});
