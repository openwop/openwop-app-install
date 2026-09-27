/**
 * MMXC-1 / ADR 0611 — the managed free tier shares ONE MiniMax server key across
 * ALL tenants, and MiniMax's AUTOMATIC prompt-prefix cache keys by content on that
 * shared key, so two tenants sending the same prefix would share a provider cache
 * entry (the `prompt-prefix-cache-cross-tenant-isolation` hazard RFC 0116 §43
 * elevates to a protocol-tier invariant). `prepareManagedDispatch` stamps a
 * per-tenant, opaque, stable cache-scope sentinel into the leading system content,
 * so the outbound-prefix BYTES differ per tenant → MiniMax's cache structurally
 * misses cross-tenant while each tenant's own reuse still hits.
 *
 * This asserts the REAL outbound HTTP body (captured off the fetch mock), so it
 * rides the actual dispatch path (dispatchManagedChat → dispatchChat → MiniMax) —
 * not an internal helper that a later merge/dedup could bypass. Born-red: without
 * the stamp, tenant A and tenant B's leading system bytes are identical (the shared
 * default prompt). Sabotage-verified.
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
} from '../src/providers/managedProvider.js';
import type { ToolDef } from '../src/providers/dispatchAnthropicTools.js';
import type { Storage } from '../src/storage/storage.js';

const TEST_MASTER_KEY = 'a'.repeat(64);
let storage: Storage;

beforeAll(() => {
  process.env.OPENWOP_BYOK_ENCRYPTION_KEY = TEST_MASTER_KEY;
  process.env.OPENWOP_MANAGED_DAILY_TOKEN_CAP = '100000';
});

beforeEach(async () => {
  storage = await openStorage('memory://');
  configureManagedProvider({ storage, dataDir: '/tmp/openwop-mmxc1-test' });
  _clearManagedCacheForTests();
  resetCachedMasterKey();
  process.env.MINIMAX_API_KEY = 'sk-test';
  await bootstrapManagedProvider();
});

afterEach(async () => {
  await storage.close();
  vi.restoreAllMocks();
  delete process.env.MINIMAX_API_KEY;
});

// Dispatch one managed chat for `tenantId` and return the RAW outbound MiniMax
// request body (captured off the fetch mock, which also returns a valid SSE reply
// so the dispatch completes).
async function outboundBodyFor(tenantId: string): Promise<string> {
  let captured = '';
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
    captured = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) { const e = new TextEncoder(); for (const ch of chunks) c.enqueue(e.encode(ch)); c.close(); },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  await dispatchManagedChat({
    userFacingProvider: 'openwop-free',
    tenantId,
    messages: [{ role: 'user', content: 'hi' }],
  });
  return captured;
}

// The TOOLS-ROUND path (dispatchManagedToolsRound → dispatchMiniMaxToolsRound) is a
// second managed outbound path that also flows through prepareManagedDispatch. It
// posts a plain JSON body (not SSE), so capture the body + return a JSON round.
async function outboundToolsBodyFor(tenantId: string): Promise<string> {
  let captured = '';
  const tool: ToolDef = { name: 'noop', description: 'no-op', inputSchema: { type: 'object', properties: {} } };
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_url, init) => {
    captured = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  await dispatchManagedToolsRound({
    userFacingProvider: 'openwop-free',
    tenantId,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [tool],
  });
  return captured;
}

const SENTINEL = /\[cache-scope ([0-9a-f]{16})\]/;

describe('MMXC-1 — managed MiniMax per-tenant cache-scope sentinel', () => {
  it('stamps a per-tenant sentinel into the outbound prefix', async () => {
    const body = await outboundBodyFor('user:alice');
    expect(body).toMatch(SENTINEL);
  });

  it('two tenants sending the SAME prompt get DIFFERENT cache-scope bytes (cross-tenant miss)', async () => {
    const a = (await outboundBodyFor('user:alice')).match(SENTINEL)?.[1];
    const b = (await outboundBodyFor('user:bob')).match(SENTINEL)?.[1];
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // Born-red without the stamp: both leading system messages are the identical
    // shared default prompt, so no per-tenant sentinel exists and a===b (undefined).
    expect(a).not.toEqual(b);
  });

  it('the SAME tenant gets a STABLE sentinel (within-tenant cache reuse preserved)', async () => {
    const first = (await outboundBodyFor('user:alice')).match(SENTINEL)?.[1];
    const second = (await outboundBodyFor('user:alice')).match(SENTINEL)?.[1];
    expect(first).toBeTruthy();
    expect(first).toEqual(second);
  });

  it('never sends the RAW tenant id (secret-free hash only)', async () => {
    const body = await outboundBodyFor('user:alice-secret-handle');
    expect(body).toMatch(SENTINEL);
    expect(body).not.toContain('alice-secret-handle');
  });

  it('the TOOLS-ROUND path also carries a per-tenant sentinel that differs cross-tenant', async () => {
    const a = (await outboundToolsBodyFor('user:alice')).match(SENTINEL)?.[1];
    const b = (await outboundToolsBodyFor('user:bob')).match(SENTINEL)?.[1];
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toEqual(b);
  });
});
