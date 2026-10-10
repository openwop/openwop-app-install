/**
 * ADR 0411 §P3 (grade-code VID-1) — the generative-MEDIA provider dispatch now
 * emits the ADR 0118 `openwop.provider.dispatch` span (reusing `withLlmSpan`), so
 * the most expensive media calls are visible in traces. This proves, through the
 * REAL adapter + a stubbed provider, that (a) the span is emitted with
 * provider/model + the OpenInference `LLM` kind, and (b) the ADR 0118 security
 * invariant holds on it — the prompt and the BYOK key NEVER reach a span attribute.
 *
 * Reds if: either media call site (image native, aiProvidersHost `dispatchImagesNative`;
 * TTS, `dispatchFor`) stops wrapping the dispatch in `PROVIDER_DISPATCH_SPAN`, drops
 * the `'LLM'` kind, or stops passing the requested model.
 *
 * Ceiling (honest double guard): the no-prompt/no-key assertions cannot be turned red
 * by ONE edit — the call sites pass only `{provider, model}`, and `safeSpanAttributes`
 * drops any non-allowlisted key anyway (probe w5g1-0411-leak-filter stayed green). The
 * filter half is witnessed by `test/llm-spans.test.ts`; these assertions keep the
 * call-site half.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { createApp } from '../src/index.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import type { HostAdapterSuite } from '../src/host/index.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const exporter = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

describe('ADR 0411 media dispatch → provider.dispatch span (grade-code VID-1)', () => {
  let server: http.Server;
  let adapter: ReturnType<typeof createAiProvidersAdapter>;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    delete process.env.OPENWOP_IMAGE_PROVIDER_ENABLED; // force the native BYOK path
    delete process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT;
    // Register the in-memory exporter's provider BEFORE createApp — the global tracer
    // provider can only be set once, and createApp registers one during boot.
    tracerProvider.register();
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
    const hostSuite = app.locals.hostSuite as HostAdapterSuite;
    adapter = createAiProvidersAdapter({
      runId: 'span-run', nodeId: 'image.generate', tenantId: 'default', attempt: 1,
      secrets: { 'my-openai': 'sk-secret-key-123' }, policyResolver: hostSuite.providerPolicyResolver,
    });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    trace.disable();
  });
  afterEach(() => { exporter.reset(); vi.restoreAllMocks(); });

  it('emits openwop.provider.dispatch (kind LLM) with provider/model, and NEVER the prompt or key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await adapter.callImageGenerator({ prompt: 'a SECRET blue circle prompt', provider: 'openai', credentialRef: 'my-openai', model: 'gpt-image-1', n: 1 });

    const dispatch = exporter.getFinishedSpans().find((s) => s.name === 'openwop.provider.dispatch');
    expect(dispatch).toBeDefined();
    expect(dispatch!.attributes['openwop.ai.provider']).toBe('openai');
    expect(dispatch!.attributes['openwop.ai.model']).toBe('gpt-image-1');
    expect(dispatch!.attributes['openinference.span.kind']).toBe('LLM');
    // ADR 0118 security invariant on the NEW media span: no prompt bytes, no key.
    const serialized = JSON.stringify(dispatch!.attributes);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('sk-secret-key-123');
  });

  it('TTS (callSpeechSynthesizer) emits the dispatch span too (ENG-5), with no text/key leak', async () => {
    const audio = Buffer.from('opaque-audio-bytes');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));

    await adapter.callSpeechSynthesizer({ provider: 'openai', credentialRef: 'my-openai', model: 'tts-1', voiceId: 'alloy', text: 'SECRET words to synthesize' });

    const dispatch = exporter.getFinishedSpans().find((s) => s.name === 'openwop.provider.dispatch');
    expect(dispatch).toBeDefined();
    expect(dispatch!.attributes['openwop.ai.provider']).toBe('openai');
    expect(dispatch!.attributes['openwop.ai.model']).toBe('tts-1');
    expect(dispatch!.attributes['openinference.span.kind']).toBe('LLM');
    const serialized = JSON.stringify(dispatch!.attributes);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('sk-secret-key-123');
  });
});
