/**
 * ADR 1026 — a streamed reply that closes before the provider's terminal signal
 * is a retryable provider failure, never a completion.
 *
 * Source: Book AI live qualification 2026-10-28 (upstream proposal P37 item 4).
 * Every truncated structured Gemini reply ended with NO finishReason, cut at
 * 133–1,064 output tokens under maxOutputTokens 12000. The dispatcher returned
 * the fragment, so it failed as a JSON parse error ("Unterminated string"), and
 * the one repair retry failed the same way.
 *
 * Each provider is driven through the public `dispatchChat` with `fetch` stubbed
 * (or a loopback server for the sidecar and compat lanes). The SAME stub with
 * its terminal signal is the control: it must complete. The adapter cases drive
 * the real `callAI` → `dispatchStructured` → `mapDispatchErrors` path and the
 * ADR 1002 invocation log through a `memory://` boot.
 *
 * Red when: any dispatcher returns a fragment instead of throwing; the throw is
 * not mapped to the retryable `provider_unavailable`; the structured loop
 * records it as a parse error or ends `envelope_invalid`; the chat-path retry
 * classifier refuses it; compat starts failing on a stream its operator's
 * server is allowed to end bare; a Gemini prompt block (no candidate, so no
 * finishReason) is mistaken for a cut stream; or a replay of the failed run
 * re-dispatches instead of reproducing the recorded failure.
 *
 * Sabotage-witnessed (2026-11-02), each reverted after its run: the google,
 * anthropic, openai and OpenAI-compatible checks disabled one at a time; the
 * blockReason exemption and the Anthropic `message_stop` acceptance dropped; the Anthropic error-type capture, the sidecar
 * `error` finish and the Copilot scrub pass-through each removed; compat made
 * to fail; the `mapDispatchErrors` branch, either half of
 * `isTransientProviderFailure`, the `classifyDispatchError` branch and the
 * recorded-failure rethrow on replay (BYOK `callAI`'s invocation-log read, not
 * the managed-lane `viaReplayLane` copy) each removed; the parse-error correction
 * appended to a provider-error retry (the #5463 retry-body check). Each one reddened at
 * least one case. Re-probed grade-tests w84 (TST-FNB-1), which also pins the exact
 * attempt count (one more attempt than RFC 0032 §C's 3 reds the exhaust case).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { dispatchChat, isStreamIncompleteError, resetGoogleThinkingShapeMemoForTests } from '../src/providers/dispatch.js';
import { createAiProvidersAdapter, AiProviderError } from '../src/aiProviders/aiProvidersHost.js';
import { PROVIDER_ERROR_RETRY_REASON } from '../src/aiProviders/providerRefusalRetry.js';
import { isTransientProviderFailure } from '../src/host/conversationToolLoop.js';
import { classifyDispatchError } from '../src/observability/errorRecovery.js';
import type { ProviderPolicyResolver } from '../src/host/index.js';

const sseBody = (frames: string[]): string => frames.map((f) => `${f}\n\n`).join('');
const sseResponse = (frames: string[]): Response =>
  new Response(sseBody(frames), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const data = (v: unknown): string => `data: ${JSON.stringify(v)}`;
const event = (name: string, v: unknown): string => `event: ${name}\ndata: ${JSON.stringify(v)}`;

const PARTIAL = '{"title":"Hal';

const gemini = {
  cut: [data({ candidates: [{ content: { parts: [{ text: PARTIAL }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 133 } })],
  complete: (text = PARTIAL + 'f"}') => [
    data({ candidates: [{ content: { parts: [{ text }] } }] }),
    data({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 140 } }),
  ],
};

const anthropicHead = [
  event('message_start', { type: 'message_start', message: { usage: { input_tokens: 9 } } }),
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PARTIAL } }),
];
const anthropic = {
  cut: anthropicHead,
  overloaded: [...anthropicHead, event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })],
  complete: [
    ...anthropicHead,
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
    event('message_stop', { type: 'message_stop' }),
  ],
};

const openaiShape = {
  cut: [data({ choices: [{ delta: { content: PARTIAL }, finish_reason: null }] })],
  complete: [
    data({ choices: [{ delta: { content: PARTIAL }, finish_reason: null }] }),
    data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    data({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 5 } }),
    'data: [DONE]',
  ],
};

/** Stub fetch with a queue of SSE bodies (the last repeats); counts calls and
 *  keeps each request body. */
function stubFetch(queue: string[][]): { calls: () => number; bodies: string[] } {
  let n = 0;
  const bodies: string[] = [];
  vi.stubGlobal('fetch', (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const frames = queue[Math.min(n, queue.length - 1)]!;
    n++;
    return Promise.resolve(sseResponse(frames));
  });
  return { calls: () => n, bodies };
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`expected an Error rejection, got ${String(err)}`);
  }
  throw new Error('expected a rejection');
}

/** The rejection, narrowed to the adapter's typed provider error (fails otherwise). */
async function providerRejection(p: Promise<unknown>): Promise<AiProviderError> {
  const err = await rejection(p);
  expect(err).toBeInstanceOf(AiProviderError);
  if (!(err instanceof AiProviderError)) throw err;
  return err;
}

const msgs = [{ role: 'user' as const, content: 'hi' }];

beforeEach(() => { resetGoogleThinkingShapeMemoForTests(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('ADR 1026 — each streaming dispatcher', () => {
  const cases: Array<{ provider: 'google' | 'anthropic' | 'openai' | 'minimax'; model: string; cut: string[]; complete: string[]; finish: string }> = [
    { provider: 'google', model: 'gemini-2.5-flash', cut: gemini.cut, complete: gemini.complete(), finish: 'STOP' },
    { provider: 'anthropic', model: 'claude-test', cut: anthropic.cut, complete: anthropic.complete, finish: 'end_turn' },
    { provider: 'openai', model: 'gpt-test', cut: openaiShape.cut, complete: openaiShape.complete, finish: 'stop' },
    { provider: 'minimax', model: 'MiniMax-M2', cut: openaiShape.cut, complete: openaiShape.complete, finish: 'stop' },
  ];

  for (const c of cases) {
    it(`${c.provider}: a stream with no terminal signal throws the stream-incomplete error`, async () => {
      stubFetch([c.cut]);
      const err = await rejection(dispatchChat({ provider: c.provider, model: c.model, apiKey: 'k', messages: msgs }));
      expect(isStreamIncompleteError(err)).toBe(true);
      expect(err.message).toBe(`${c.provider}_stream_incomplete: stream ended without a finish reason`);
    });

    it(`${c.provider}: the same stream WITH its terminal signal completes`, async () => {
      stubFetch([c.complete]);
      const out = await dispatchChat({ provider: c.provider, model: c.model, apiKey: 'k', messages: msgs });
      expect(out.completion.startsWith(PARTIAL)).toBe(true);
      expect(out.finishReason).toBe(c.finish);
    });
  }

  it('anthropic: an in-band error event is named in the failure', async () => {
    stubFetch([anthropic.overloaded]);
    const err = await rejection(dispatchChat({ provider: 'anthropic', model: 'claude-test', apiKey: 'k', messages: msgs }));
    expect(isStreamIncompleteError(err)).toBe(true);
    expect(err.message).toBe('anthropic_stream_incomplete: stream ended without a finish reason (stream error: overloaded_error)');
  });

  it('anthropic: `message_stop` alone ends the message (either terminal event suffices)', async () => {
    stubFetch([[...anthropicHead, event('message_stop', { type: 'message_stop' })]]);
    const out = await dispatchChat({ provider: 'anthropic', model: 'claude-test', apiKey: 'k', messages: msgs });
    expect(out.completion).toBe(PARTIAL);
  });

  it('google: a blocked PROMPT (no candidate, so no finishReason) is a refusal, not a cut stream', async () => {
    stubFetch([[data({ promptFeedback: { blockReason: 'SAFETY' } })]]);
    const out = await dispatchChat({ provider: 'google', model: 'gemini-2.5-flash', apiKey: 'k', messages: msgs });
    expect(out.blockReason).toBe('SAFETY');
    expect(out.refusal).toBeDefined();
    expect(out.completion).toBe('');
  });
});

describe('ADR 1026 — loopback lanes (copilot sidecar, compat)', () => {
  let server: http.Server | undefined;
  const prevPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  afterEach(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()));
    server = undefined;
    if (prevPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = prevPrivate;
  });
  async function serve(frames: string[]): Promise<string> {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseBody(frames));
    });
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', () => res()));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
  }
  const copilot = (baseUrl: string) => dispatchChat({ provider: 'copilot', model: 'gpt-5', apiKey: 'gho_x', baseUrl, messages: msgs });

  it('copilot: a cut stream throws the stream-incomplete error, not copilot_transport_error', async () => {
    const err = await rejection(copilot(await serve(openaiShape.cut)));
    expect(isStreamIncompleteError(err)).toBe(true);
    expect(err.message).toBe('copilot_stream_incomplete: stream ended without a finish reason');
  });

  it("copilot: the sidecar's own `error` finish is the same failure", async () => {
    const err = await rejection(copilot(await serve([
      data({ choices: [{ delta: { content: PARTIAL }, finish_reason: null }] }),
      data({ choices: [{ delta: {}, finish_reason: 'error' }] }),
      'data: [DONE]',
    ])));
    expect(isStreamIncompleteError(err)).toBe(true);
    expect(err.message).toBe('copilot_stream_incomplete: stream ended without a finish reason (stream error: finish_reason=error)');
  });

  it('copilot: a complete stream completes', async () => {
    const out = await copilot(await serve(openaiShape.complete));
    expect(out.completion).toBe(PARTIAL);
    expect(out.finishReason).toBe('stop');
  });

  it('compat: an operator endpoint that ends bare is only logged — its text is returned', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const baseUrl = await serve(openaiShape.cut);
    const out = await dispatchChat({ provider: 'compat', model: 'llama3', apiKey: 'k', baseUrl, messages: msgs });
    expect(out.completion).toBe(PARTIAL);
    expect(out.finishReason).toBeUndefined();
  });
});

describe('ADR 1026 — retry classification', () => {
  it('the chat-path retry classifier accepts both the typed and the raw form', () => {
    const raw = Object.assign(new Error('google_stream_incomplete: stream ended without a finish reason'), { streamIncomplete: true });
    expect(isTransientProviderFailure(raw)).toBe(true);
    expect(isTransientProviderFailure(new AiProviderError('provider_unavailable', 'x', { reason: 'stream_incomplete' }))).toBe(true);
    // Control: the same code with neither a 5xx nor this reason is not retried.
    expect(isTransientProviderFailure(new AiProviderError('provider_unavailable', 'x', {}))).toBe(false);
  });

  it('the run-failure classifier tells the user to retry the raw form', () => {
    const raw = Object.assign(new Error('openwop-free_stream_incomplete: stream ended without a finish reason'), { streamIncomplete: true });
    expect(classifyDispatchError(raw)).toMatchObject({ category: 'network', action: 'retry' });
  });
});

// ── The adapter: structured output, and the ADR 1002 replay ─────────────────
const SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
type Emitted = Array<{ type: string; payload: Record<string, unknown> }>;

function adapter(emitted: Emitted, runId: string, replayFrom?: string) {
  const policyResolver: ProviderPolicyResolver = { async resolveForRun() { return []; } };
  return createAiProvidersAdapter({
    runId, nodeId: 'n-1026', tenantId: 't-1026', attempt: 1,
    secrets: { google: 'AIza-test-1026-not-a-real-key' },
    policyResolver,
    ...(replayFrom ? { replayInvocationsFromRunId: replayFrom } : {}),
    emit: async (type: string, payload: unknown) => {
      emitted.push({ type, payload: payload as Record<string, unknown> });
      return { eventId: 'e', sequence: emitted.length };
    },
  });
}
const structured = (emitted: Emitted, runId: string, replayFrom?: string) =>
  adapter(emitted, runId, replayFrom).callAI({ provider: 'google', model: 'gemini-2.5-flash', messages: msgs, responseSchema: SCHEMA, maxTokens: 12000 });

describe('ADR 1026 — structured output through the adapter', () => {
  let server: http.Server;
  const prevDsn = process.env.OPENWOP_STORAGE_DSN;
  const prevPacks = process.env.OPENWOP_INSTALL_PACKS;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_INSTALL_PACKS = 'none';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    if (prevDsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = prevDsn;
    if (prevPacks === undefined) delete process.env.OPENWOP_INSTALL_PACKS; else process.env.OPENWOP_INSTALL_PACKS = prevPacks;
  });
  beforeEach(() => { process.env.OPENWOP_PROVIDER_RETRY_BACKOFF_MS = '0'; });
  afterEach(() => {
    delete process.env.OPENWOP_PROVIDER_RETRY_BACKOFF_MS;
    delete process.env.OPENWOP_ENVELOPE_RELIABILITY_END_TO_END;
    vi.unstubAllEnvs();
  });

  it('a cut stream is retried as a provider failure and a later complete reply returns data', async () => {
    const f = stubFetch([gemini.cut, gemini.complete()]);
    const emitted: Emitted = [];
    const out = await structured(emitted, 'r-1026-recover');
    expect(out.data).toEqual({ title: 'Half' });
    expect(f.calls()).toBe(2);
    const retries = emitted.filter((e) => e.type === 'envelope.retry.attempted');
    expect(retries.map((e) => e.payload.reason)).toEqual([PROVIDER_ERROR_RETRY_REASON]);
    // Absorbed from #5463 (bookai-ea): the retry request must not carry the
    // bad-JSON correction. The fragment was a provider fault, not a model slip.
    expect(f.bodies[1]).not.toContain('not valid JSON');
  });

  it('every attempt cut: the run fails provider_unavailable, never a parse error', async () => {
    // RFC 0032 §C maxRetryAttempts, pinned so the count below is exact.
    vi.stubEnv('OPENWOP_ENVELOPE_RELIABILITY_MAX_RETRY_ATTEMPTS', '3');
    const f = stubFetch([gemini.cut]);
    const emitted: Emitted = [];
    const err = await providerRejection(structured(emitted, 'r-1026-exhaust'));
    expect(err.code).toBe('provider_unavailable');
    expect(err.message).toBe('Provider stream ended without a finish reason.');
    expect(err.details.reason).toBe('stream_incomplete');
    expect(f.calls(), 'every attempt was dispatched, and only those').toBe(3);
    const reasons = emitted.filter((e) => e.type.startsWith('envelope.retry.')).map((e) => e.payload.reason ?? e.payload.finalReason);
    expect(reasons.length).toBe(f.calls());
    expect(new Set(reasons)).toEqual(new Set([PROVIDER_ERROR_RETRY_REASON]));
    expect(JSON.stringify(emitted)).not.toContain('Unterminated');
  });

  it('the legacy loop fails provider_unavailable too', async () => {
    process.env.OPENWOP_ENVELOPE_RELIABILITY_END_TO_END = 'false';
    stubFetch([gemini.cut]);
    const err = await providerRejection(structured([], 'r-1026-legacy'));
    expect(err.code).toBe('provider_unavailable');
    expect(err.details.reason).toBe('stream_incomplete');
  });

  it('ADR 1002: a replay of the failed run reproduces the recorded failure without dispatching', async () => {
    stubFetch([gemini.cut]);
    const live = await providerRejection(structured([], 'r-1026-source'));
    const f = stubFetch([gemini.complete()]);
    const replayed = await providerRejection(structured([], 'r-1026-replay', 'r-1026-source'));
    expect(f.calls()).toBe(0);
    expect(replayed.code).toBe('provider_unavailable');
    expect(replayed.code).toBe(live.code);
    expect(replayed.message).toBe(live.message);
  });
});
