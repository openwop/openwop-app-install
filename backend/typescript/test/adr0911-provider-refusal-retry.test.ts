/**
 * ADR 0911 (Book AI P19) — a provider refusal inside the structured-output
 * retry loop is reported as itself, not as "did not emit valid JSON".
 *
 * Drives the real adapter → `dispatchStructured` → `providers/dispatch.ts`
 * path with `fetch` stubbed, so the HTTP status is mapped by the production
 * `mapDispatchErrors` ladder, not by a test double.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createAiProvidersAdapter, AiProviderError } from '../src/aiProviders/aiProvidersHost.js';
import { classifyProviderRefusal, describeProviderRefusal, providerRetryBackoffMs, PROVIDER_ERROR_RETRY_REASON } from '../src/aiProviders/providerRefusalRetry.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const SCHEMA = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };

function sse(content: string): Response {
  const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function status(code: number, body = 'upstream says no', headers: Record<string, string> = {}): Response {
  return new Response(body, { status: code, headers });
}

/** Stub fetch with a queue of responses; returns the call counter. */
function stubFetch(queue: Array<() => Response>): { calls: () => number } {
  let n = 0;
  vi.stubGlobal('fetch', () => {
    const next = queue[Math.min(n, queue.length - 1)]!;
    n++;
    return Promise.resolve(next());
  });
  return { calls: () => n };
}

function scope(emitted: Array<{ type: string; payload: Record<string, unknown> }>) {
  const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
  return {
    runId: 'r-0911', nodeId: 'n-0911', tenantId: 't-0911', attempt: 1,
    secrets: { openai: 'sk-test-0911-not-a-real-key' },
    policyResolver,
    emit: async (type: string, payload: unknown) => {
      emitted.push({ type, payload: payload as Record<string, unknown> });
      return { eventId: 'e', sequence: emitted.length };
    },
  };
}

const call = (emitted: Array<{ type: string; payload: Record<string, unknown> }>) =>
  createAiProvidersAdapter(scope(emitted)).callAI({
    provider: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], responseSchema: SCHEMA,
  });

async function failure(p: Promise<unknown>): Promise<AiProviderError> {
  try { await p; } catch (err) { return err as AiProviderError; }
  throw new Error('expected the call to fail');
}

// The adapter records each call in the invocation log, which `createApp`
// installs (same boot as test/ai-providers.test.ts).
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_INSTALL_PACKS = 'none';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

beforeEach(() => {
  process.env.OPENWOP_PROVIDER_RETRY_BACKOFF_MS = '0';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENWOP_PROVIDER_RETRY_BACKOFF_MS;
  delete process.env.OPENWOP_ENVELOPE_RELIABILITY_END_TO_END;
});

describe('ADR 0911 — end-to-end retry loop', () => {
  it('a 5xx is retried under its own reason, with the vendor text, and a later success returns data', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const f = stubFetch([() => status(503, 'overloaded, try later'), () => sse('{"ok":true}')]);
    const res = await call(emitted);
    expect(res.data).toEqual({ ok: true });
    expect(f.calls()).toBe(2);
    const retries = emitted.filter((e) => e.type === 'envelope.retry.attempted');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.payload.reason).toBe(PROVIDER_ERROR_RETRY_REASON);
    expect(retries[0]!.payload.reason).not.toBe('parse-error');
    expect(String(retries[0]!.payload.previousError)).toContain('provider_unavailable (HTTP 503)');
    expect(String(retries[0]!.payload.previousError)).toContain('overloaded, try later');
  });

  it('a 5xx on every attempt fails provider_unavailable, not envelope_invalid', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const f = stubFetch([() => status(500)]);
    const err = await failure(call(emitted));
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.code).toBe('provider_unavailable');
    expect(f.calls()).toBe(3);
    const exhausted = emitted.find((e) => e.type === 'envelope.retry.exhausted');
    expect(exhausted?.payload.finalReason).toBe(PROVIDER_ERROR_RETRY_REASON);
    // The reformat fallback would only hit the same refusing provider.
    expect(emitted.some((e) => e.type === 'envelope.nlToFormat.engaged')).toBe(false);
  });

  it.each([[401, 'byok_required_but_unresolved'], [403, 'byok_required_but_unresolved'], [404, 'model_not_supported'], [400, 'invalid_request']])(
    'a %i is thrown as %s after ONE call, with no retry',
    async (code, expected) => {
      const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const f = stubFetch([() => status(code)]);
      const err = await failure(call(emitted));
      expect(err.code).toBe(expected);
      expect(f.calls()).toBe(1);
      expect(emitted.some((e) => e.type.startsWith('envelope.retry'))).toBe(false);
    },
  );

  it('a 429 is thrown as provider_rate_limited after the dispatch layer\'s own Retry-After retries, not retried again', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const f = stubFetch([() => status(429, 'quota', { 'Retry-After': '0' })]);
    const err = await failure(call(emitted));
    expect(err.code).toBe('provider_rate_limited');
    // fetchWith429Retry makes 3; a second retry layer would make 9.
    expect(f.calls()).toBe(3);
    expect(emitted.some((e) => e.type.startsWith('envelope.retry'))).toBe(false);
  });

  it('a run whose LAST attempt was a parse failure still ends envelope_invalid', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    stubFetch([() => status(503), () => sse('{"ok": tru'), () => sse('not json at all {')]);
    const err = await failure(call(emitted));
    expect(err.code).toBe('envelope_invalid');
    const reasons = emitted.filter((e) => e.type === 'envelope.retry.attempted').map((e) => e.payload.reason);
    expect(reasons).toEqual([PROVIDER_ERROR_RETRY_REASON, 'parse-error']);
  });
});

describe('ADR 0911 — legacy loop (OPENWOP_ENVELOPE_RELIABILITY_END_TO_END=false)', () => {
  it('a 5xx on every attempt fails provider_unavailable', async () => {
    process.env.OPENWOP_ENVELOPE_RELIABILITY_END_TO_END = 'false';
    const f = stubFetch([() => status(502)]);
    const err = await failure(call([]));
    expect(err.code).toBe('provider_unavailable');
    expect(f.calls()).toBe(3);
  });

  it('a 401 is thrown after ONE call', async () => {
    process.env.OPENWOP_ENVELOPE_RELIABILITY_END_TO_END = 'false';
    const f = stubFetch([() => status(401)]);
    const err = await failure(call([]));
    expect(err.code).toBe('byok_required_but_unresolved');
    expect(f.calls()).toBe(1);
  });
});

describe('ADR 0911 — helpers', () => {
  it('classifies only provider refusal codes', () => {
    expect(classifyProviderRefusal(new AiProviderError('provider_unavailable', 'x'))).toBe('transient');
    expect(classifyProviderRefusal(new AiProviderError('provider_timed_out', 'x'))).toBe('transient');
    expect(classifyProviderRefusal(new AiProviderError('provider_rate_limited', 'x'))).toBe('fatal');
    expect(classifyProviderRefusal(new AiProviderError('internal_error', 'x'))).toBeNull();
    expect(classifyProviderRefusal(new Error('boom'))).toBeNull();
  });

  it('the vendor excerpt is scrubbed and capped', () => {
    const upstream = `bad key AIzaSyA1234567890abcdefghijklmnopqrstu and sk-ant-${'x'.repeat(30)} at https://h/?key=SECRETVALUE ${'y'.repeat(400)}`;
    const text = describeProviderRefusal(
      new AiProviderError('provider_unavailable', 'Provider 5xx.', { status: 503, upstreamMessage: upstream }),
      (s) => s.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-***'),
    );
    expect(text).not.toContain('AIzaSyA1234567890');
    expect(text).not.toContain('SECRETVALUE');
    expect(text).not.toContain('x'.repeat(30));
    expect(text.length).toBeLessThan(260);
  });

  it('backoff doubles from the base and caps; 0 disables', () => {
    process.env.OPENWOP_PROVIDER_RETRY_BACKOFF_MS = '1000';
    expect([1, 2, 3, 5].map(providerRetryBackoffMs)).toEqual([1000, 2000, 4000, 8000]);
    process.env.OPENWOP_PROVIDER_RETRY_BACKOFF_MS = '0';
    expect(providerRetryBackoffMs(3)).toBe(0);
  });
});
