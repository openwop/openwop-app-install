/**
 * ADR 0990 — the site owner chooses the free tier's provider and model.
 *
 * Covers the core resolver (P2), driven through the same seam the
 * managed-tier-admin feature registers:
 *   1. The stored setting wins over env, and the chat goes to that provider
 *      with that provider's key and the stored model (D1).
 *   2. A setting naming a provider with no key is unavailable, and never sends
 *      another provider's key (D2).
 *   3. The Secrets Vault key wins over the env key (D2).
 *   4. A stored provider that no longer validates is unavailable, not a silent
 *      MiniMax fallback (D4).
 *   5. A failed read keeps the last good selection; with none, env serves (D1).
 *   5b. A read that never settles is replaced after 10 s (the detached-latch rule).
 *   6. Speech stays on the MiniMax key whichever provider serves chat (D7).
 *   7. Anthropic cache reads count toward the daily cap (D5).
 *   8. A per-provider cap in the setting replaces the env cap (D5).
 *   9. A test message runs the candidate, not the saved selection (D3).
 *
 * Sabotage-witnessed: with `resolveManagedSpeechKey` resolving through the
 * selected chat target, case 6 goes red (the Anthropic key is returned for
 * MiniMax speech); with the Anthropic cache reads left out of the cap rows,
 * case 7 goes red; with a stored unsupported provider mapped to MiniMax, case 4
 * goes red (the MiniMax key is sent); with the refresh latch unbounded, case 5b
 * times out.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { resetCachedMasterKey } from '../src/byok/encryption.js';
import { clearCache, configureSecretResolver, setSecret } from '../src/byok/secretResolver.js';
import {
  _clearManagedCacheForTests,
  bootstrapManagedProvider,
  configureManagedProvider,
  dispatchManagedChat,
  effectiveManagedTierSelection,
  getManagedProviderStatuses,
  managedUnderlyingProvider,
  refreshManagedTierSelection,
  registerManagedTierConfigProvider,
  resolveManagedSpeechKey,
  testManagedTierCandidate,
  type ManagedTierSelection,
} from '../src/providers/managedProvider.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
const DATA_DIR = '/tmp/openwop-managed-tier-select-test';
const ENV_KEYS = [
  'OPENWOP_MANAGED_PROVIDER', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'MINIMAX_API_KEY', 'MINIMAX_MODEL',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'GOOGLE_API_KEY', 'GOOGLE_MODEL', 'OPENWOP_BYOK_EPHEMERAL',
] as const;

beforeAll(() => {
  process.env.OPENWOP_BYOK_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP = '100000';
});

/** The seam the feature registers, under the test's control. */
let stored: ManagedTierSelection | null = null;
let readFails = false;

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  storage = await openStorage('memory://');
  configureManagedProvider({ storage, dataDir: DATA_DIR });
  configureSecretResolver({ storage, dataDir: DATA_DIR });
  clearCache();
  _clearManagedCacheForTests();
  resetCachedMasterKey();
  stored = null;
  readFails = false;
  registerManagedTierConfigProvider(async () => {
    if (readFails) throw new Error('store unavailable');
    return stored;
  });
});

afterEach(async () => {
  registerManagedTierConfigProvider(null);
  for (const k of ENV_KEYS) delete process.env[k];
  await storage.close();
  vi.restoreAllMocks();
});

async function select(next: ManagedTierSelection | null): Promise<void> {
  stored = next;
  await refreshManagedTierSelection(true);
}

/** A streaming OpenAI chat-completions response (the chat shape). */
function openAiSse(text: string): Response {
  const chunks = [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicSse(text: string, usage: { input: number; output: number; cacheRead?: number }): Response {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: usage.input, output_tokens: 0, ...(usage.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}) } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output } },
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

/** The URL, the key header (whichever the provider uses) and the model of the first call. */
function sentTo(spy: ReturnType<typeof vi.spyOn>): { url: string; key: string | undefined; model: unknown } {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  const auth = headers.authorization ?? headers.Authorization;
  const key = headers['x-api-key'] ?? (auth ? auth.replace(/^Bearer /, '') : undefined);
  const body = init.body ? JSON.parse(String(init.body)) as { model?: unknown } : {};
  return { url: String(url), key, model: body.model };
}

const chat = () => dispatchManagedChat({
  userFacingProvider: 'openwop-free',
  tenantId: 'user:alice',
  messages: [{ role: 'user', content: 'hi' }],
});

describe('ADR 0990 — the free tier runs on the owner\'s chosen provider', () => {
  it('the stored setting wins over env, with that provider\'s key and the stored model', async () => {
    process.env.OPENWOP_MANAGED_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    await bootstrapManagedProvider();
    await select({ provider: 'openai', model: 'gpt-5.6-luna' });

    expect(effectiveManagedTierSelection()).toMatchObject({ provider: 'openai', model: 'gpt-5.6-luna', source: 'setting' });
    expect(managedUnderlyingProvider('managed:openwop-free')).toBe('openai');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(openAiSse('hello'));
    const result = await chat();
    expect(result.completion).toBe('hello');

    const sent = sentTo(spy);
    expect(sent.url).toContain('api.openai.com');
    expect(sent.key).toBe('sk-openai-env');
    expect(sent.model).toBe('gpt-5.6-luna');
    // The caller still sees only the user-facing id.
    expect(result.provider).toBe('openwop-free');
    expect(result.model).toBe('openwop-free');
  });

  it('a setting naming a provider with no key is unavailable, and never sends another provider\'s key', async () => {
    process.env.MINIMAX_API_KEY = 'sk-minimax-secret';
    await bootstrapManagedProvider();
    await setSecret('free-tier:minimax', 'sk-minimax-vault');
    await select({ provider: 'google', model: 'gemini-3.8-flash' });
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(chat()).rejects.toMatchObject({ code: 'managed_unavailable' });
    expect(spy).not.toHaveBeenCalled();
    const [status] = await getManagedProviderStatuses();
    expect(status).toMatchObject({ providerId: 'openwop-free', ready: false });
    expect(status!.detail).toContain('free-tier:google');
  });

  it('the Secrets Vault key wins over the env key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    await bootstrapManagedProvider();
    await setSecret('free-tier:anthropic', 'sk-ant-vault');
    await select({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(anthropicSse('hi', { input: 5, output: 1 }));

    await chat();
    // Host + path, not the full URL: Anthropic's own version segment is not an OpenWOP /v1 reference.
    expect(sentTo(spy)).toMatchObject({ url: expect.stringMatching(/^https:\/\/api\.anthropic\.com\/.*\/messages$/), key: 'sk-ant-vault', model: 'claude-sonnet-5-5' });
  });

  it('a stored provider that no longer validates is unavailable, not a MiniMax fallback', async () => {
    process.env.MINIMAX_API_KEY = 'sk-minimax';
    await bootstrapManagedProvider();
    await select({ provider: 'retired-provider', model: 'x' });
    const spy = vi.spyOn(globalThis, 'fetch');

    expect(managedUnderlyingProvider('managed:openwop-free')).toBeNull();
    await expect(chat()).rejects.toMatchObject({ code: 'managed_unknown' });
    expect(spy).not.toHaveBeenCalled();
    const [status] = await getManagedProviderStatuses();
    expect(status!.detail).toContain('"retired-provider" (setting) is not supported');
  });

  it('a failed read keeps the last good selection; with none, env serves', async () => {
    await select({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    readFails = true;
    await refreshManagedTierSelection(true);
    expect(effectiveManagedTierSelection()).toMatchObject({ provider: 'anthropic', source: 'setting' });

    // A fresh instance that has never read the setting: env, not "no tier".
    _clearManagedCacheForTests();
    await refreshManagedTierSelection(true);
    expect(effectiveManagedTierSelection()).toMatchObject({ provider: 'minimax', source: 'default' });
  });

  it('a read that never settles does not wedge later refreshes', async () => {
    registerManagedTierConfigProvider(() => new Promise<ManagedTierSelection | null>(() => {}));
    void refreshManagedTierSelection(true); // hangs forever
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11_000); // past the 10 s bound
    registerManagedTierConfigProvider(async () => ({ provider: 'openai', model: 'gpt-5.6-terra' }));
    await refreshManagedTierSelection(true);
    expect(effectiveManagedTierSelection()).toMatchObject({ provider: 'openai', source: 'setting' });
  });

  it('speech stays on the MiniMax key whichever provider serves chat', async () => {
    process.env.MINIMAX_API_KEY = 'sk-minimax-speech';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-chat';
    await bootstrapManagedProvider();
    await select({ provider: 'anthropic', model: 'claude-sonnet-5-5' });

    expect(await resolveManagedSpeechKey()).toBe('sk-minimax-speech');
    await setSecret('free-tier:minimax', 'sk-minimax-vault');
    expect(await resolveManagedSpeechKey()).toBe('sk-minimax-vault');
  });

  it('Anthropic cache reads count toward the daily cap', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    await bootstrapManagedProvider();
    await select({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(anthropicSse('cached', { input: 10, output: 3, cacheRead: 4000 }));

    await chat();
    const date = new Date().toISOString().slice(0, 10);
    const usage = await storage.getManagedUsage('user:alice', 'openwop-free', date);
    expect(usage).toEqual({ inputTokens: 4010, outputTokens: 3 });
  });

  it('a per-provider cap in the setting replaces the env cap', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai';
    await bootstrapManagedProvider();
    await select({ provider: 'openai', model: 'gpt-5.6-terra', dailyTokenCap: 5 });
    const date = new Date().toISOString().slice(0, 10);
    await storage.incrementManagedUsage('user:alice', 'openwop-free', date, 4, 1);
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(chat()).rejects.toMatchObject({ code: 'daily_limit_reached' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a test message runs the CANDIDATE, not the saved selection, and reports a bad model', async () => {
    process.env.MINIMAX_API_KEY = 'sk-minimax';
    process.env.OPENAI_API_KEY = 'sk-openai';
    await bootstrapManagedProvider();
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(openAiSse('ready'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'The model `gpt-nope` does not exist' } }), { status: 404, headers: { 'content-type': 'application/json' } }));

    const ok = await testManagedTierCandidate({ provider: 'openai', model: 'gpt-5.6-terra', tenantId: 'user:op' });
    expect(ok).toMatchObject({ ok: true, provider: 'openai', reply: 'ready' });
    expect(sentTo(spy)).toMatchObject({ key: 'sk-openai', model: 'gpt-5.6-terra' });
    // The free tier itself did not move.
    expect(effectiveManagedTierSelection()).toMatchObject({ provider: 'minimax' });

    const bad = await testManagedTierCandidate({ provider: 'openai', model: 'gpt-nope', tenantId: 'user:op' });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('sk-openai');

    const noKey = await testManagedTierCandidate({ provider: 'google', model: 'gemini-3.8-flash', tenantId: 'user:op' });
    expect(noKey).toMatchObject({ ok: false, code: 'managed_key_missing' });
  });
});
