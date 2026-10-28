/**
 * ADR 0912 (Book AI P22) — native structured output, a corrective retry, a
 * jsonrepair recovery path, and a bounded excerpt of an unparsable reply.
 *
 * Provider requests are observed at `fetch` (stubbed), so these pin the real
 * request bodies `providers/dispatch.ts` sends, not a test double's view.
 *
 * Tracker TST-BJR. Red when (probe-witnessed, w65): a web-search turn asks for JSON
 * mode; an inexpressible schema is still sent; a schema INVALID_ARGUMENT walks the
 * thinking ladder instead of dropping the schema; OpenAI does not fall back to
 * json_object; jsonrepair stops escaping an inner quote; the corrective fragment or
 * the missing-key names leave the retry; the reply excerpt is uncapped/unscrubbed.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { dispatchChat, resetGoogleThinkingShapeMemoForTests } from '../src/providers/dispatch.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import { tryLenientParse, repairJsonStrings } from '../src/host/envelopeReliabilityEmit.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const SCHEMA = {
  type: 'object',
  required: ['line'],
  additionalProperties: false,
  properties: { line: { type: 'string', minLength: 1 }, n: { type: 'integer' } },
};

type Captured = { url: string; body: Record<string, unknown> };

function googleOk(text: string): Response {
  const chunk = JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
  return new Response(`data: ${chunk}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function openaiOk(content: string): Response {
  const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stub(queue: Array<() => Response>): Captured[] {
  const seen: Captured[] = [];
  vi.stubGlobal('fetch', (url: string, init: { body?: string }) => {
    seen.push({ url: String(url), body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
    return Promise.resolve(queue[Math.min(seen.length - 1, queue.length - 1)]!());
  });
  return seen;
}

const gen = (c: Captured) => c.body.generationConfig as Record<string, unknown>;
const base = { apiKey: 'k-test', messages: [{ role: 'user' as const, content: 'hi' }] };

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

beforeEach(() => resetGoogleThinkingShapeMemoForTests());
afterEach(() => vi.unstubAllGlobals());

describe('ADR 0912 — Google native JSON', () => {
  it('asks for application/json with the projected responseSchema', async () => {
    const seen = stub([() => googleOk('{"line":"x"}')]);
    const r = await dispatchChat({ ...base, provider: 'google', model: 'gemini-1.5-flash', jsonSchema: SCHEMA });
    expect(r.structuredMode).toBe('schema');
    expect(gen(seen[0]!).responseMimeType).toBe('application/json');
    const rs = gen(seen[0]!).responseSchema as Record<string, unknown>;
    expect(rs.required).toEqual(['line']);
    expect(rs).not.toHaveProperty('additionalProperties');
  });

  it('a schema Gemini cannot express goes as JSON mode only', async () => {
    const seen = stub([() => googleOk('{"line":"x"}')]);
    const r = await dispatchChat({ ...base, provider: 'google', model: 'gemini-1.5-flash', jsonSchema: { type: 'object', properties: { blob: { type: 'object' } } } });
    expect(r.structuredMode).toBe('mime');
    expect(gen(seen[0]!).responseMimeType).toBe('application/json');
    expect(gen(seen[0]!)).not.toHaveProperty('responseSchema');
  });

  it('an INVALID_ARGUMENT 400 drops the schema on the SAME thinking rung before the ladder moves', async () => {
    const seen = stub([
      () => new Response('{"error":{"status":"INVALID_ARGUMENT"}}', { status: 400 }),
      () => googleOk('{"line":"x"}'),
    ]);
    const r = await dispatchChat({ ...base, provider: 'google', model: 'gemini-3.8-flash', jsonSchema: SCHEMA });
    expect(seen).toHaveLength(2);
    expect(r.structuredMode).toBe('mime');
    expect(gen(seen[1]!)).not.toHaveProperty('responseSchema');
    expect(gen(seen[1]!).thinkingConfig).toEqual(gen(seen[0]!).thinkingConfig);
  });

  it('a web-search turn and a plain call send no JSON mode', async () => {
    const seen = stub([() => googleOk('ok')]);
    await dispatchChat({ ...base, provider: 'google', model: 'gemini-1.5-flash', jsonSchema: SCHEMA, webSearch: true });
    await dispatchChat({ ...base, provider: 'google', model: 'gemini-1.5-flash' });
    for (const c of seen) expect(gen(c)).not.toHaveProperty('responseMimeType');
  });
});

describe('ADR 0912 — OpenAI native JSON', () => {
  it('sends response_format json_schema, and falls back to json_object on a format 400', async () => {
    const seen = stub([
      () => new Response('{"error":{"message":"Invalid parameter: response_format","type":"invalid_request_error"}}', { status: 400 }),
      () => openaiOk('{"line":"x"}'),
    ]);
    const r = await dispatchChat({ ...base, provider: 'openai', model: 'gpt-test', jsonSchema: SCHEMA });
    expect((seen[0]!.body.response_format as { type: string }).type).toBe('json_schema');
    expect((seen[1]!.body.response_format as { type: string }).type).toBe('json_object');
    expect(r.structuredMode).toBe('json_object');
  });

  it('a plain call sends no response_format', async () => {
    const seen = stub([() => openaiOk('hello')]);
    const r = await dispatchChat({ ...base, provider: 'openai', model: 'gpt-test' });
    expect(seen[0]!.body).not.toHaveProperty('response_format');
    expect(r.structuredMode).toBeUndefined();
  });
});

describe('ADR 0912 — jsonrepair', () => {
  it('escapes an unescaped quote inside a string value and reports the path', () => {
    const r = tryLenientParse('{"line": "she said "run" and left", "n": 2}');
    expect(r?.path).toBe('jsonrepair');
    expect(r?.data).toEqual({ line: 'she said "run" and left', n: 2 });
  });

  it('escapes a raw newline inside a string', () => {
    expect(tryLenientParse('{"line": "one\ntwo"}')?.data).toEqual({ line: 'one\ntwo' });
  });

  it('leaves valid JSON untouched and does not invent a parse for broken structure', () => {
    expect(repairJsonStrings('{"a":"b \\"c\\"","d":[1,2]}')).toBe('{"a":"b \\"c\\"","d":[1,2]}');
    expect(tryLenientParse('{"a": "x", "b": }')).toBeNull();
  });
});

describe('ADR 0912 — the retry says what was wrong, and keeps an excerpt', () => {
  function scope(emitted: Array<{ type: string; payload: Record<string, unknown> }>) {
    const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
    return {
      runId: 'r-0912', nodeId: 'n-0912', tenantId: 't-0912', attempt: 1,
      secrets: { openai: 'sk-test-0912-not-a-real-key' }, policyResolver,
      emit: async (type: string, payload: unknown) => { emitted.push({ type, payload: payload as Record<string, unknown> }); return { eventId: 'e', sequence: emitted.length }; },
    };
  }
  const systemOf = (c: Captured) => ((c.body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'system')?.content);

  it('a parse failure is followed by a corrective fragment and recorded with the reply excerpt', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const seen = stub([() => openaiOk('{"line": oops not json'), () => openaiOk('{"line":"fixed"}')]);
    const res = await createAiProvidersAdapter(scope(emitted)).callAI({ provider: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], responseSchema: SCHEMA });
    expect(res.data).toEqual({ line: 'fixed' });
    expect(JSON.stringify(systemOf(seen[0]!))).not.toContain('not valid JSON');
    expect(JSON.stringify(systemOf(seen[1]!))).toContain('Your previous reply was not valid JSON');
    const retry = emitted.find((e) => e.type === 'envelope.retry.attempted');
    expect(retry?.payload.reason).toBe('parse-error');
    expect(String(retry?.payload.previousError)).toContain('oops not json');
  });

  it('a schema violation names the missing keys in the next request', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const seen = stub([() => openaiOk('{"n": 1}'), () => openaiOk('{"line":"x"}')]);
    await createAiProvidersAdapter(scope(emitted)).callAI({ provider: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], responseSchema: SCHEMA });
    expect(JSON.stringify(systemOf(seen[1]!))).toContain('missing the required key(s) \\"line\\"');
    const retry = emitted.find((e) => e.type === 'envelope.retry.attempted');
    expect(String(retry?.payload.previousError)).toContain('missing line');
  });

  it('the excerpt is capped and scrubbed', async () => {
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const leaked = `sk-ant-${'z'.repeat(40)}`;
    stub([() => openaiOk(`${leaked} ${'w'.repeat(500)}`), () => openaiOk('{"line":"x"}')]);
    await createAiProvidersAdapter(scope(emitted)).callAI({ provider: 'openai', model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], responseSchema: SCHEMA });
    const prev = String(emitted.find((e) => e.type === 'envelope.retry.attempted')?.payload.previousError);
    expect(prev).not.toContain('z'.repeat(40));
    expect(prev).not.toContain('w'.repeat(250));
  });
});
