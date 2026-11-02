/**
 * MKP-1 / MKP-2 — the two untrusted-egress provider paths (the local-model "compat"
 * dispatcher, ADR 0121; the image-generation adapter, ADR 0115) must route their fetch
 * through the connect-time-validating pinned dispatcher, closing the DNS-rebind TOCTOU
 * that the string-only host check can't. This asserts the WIRING hermetically by mocking
 * undici's `fetch` (the named import both paths now use, matching webhookDeliveryWorker):
 * each path passes `dispatcher === webhookEgressDispatcher()` + `redirect:'error'`. The
 * dispatcher's actual private-range blocking is covered by webhook-egress-guard's own
 * tests; here we only prove the call sites opt in.
 *
 * Tracker TST-CXD-1. Red when any of the three call sites drops
 * `dispatcher: webhookEgressDispatcher()` or `redirect: 'error'`
 * (providers/dispatch.ts, host/imageProviderAdapter.ts, host/sandboxAdapter.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Capture each undici.fetch call's options; keep the rest of undici real (Agent, Response)
// so webhookEgressDispatcher() still builds a genuine Agent we can identity-compare.
const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const capturedUrls = vi.hoisted(() => [] as string[]);
vi.mock('undici', async (importActual) => {
  const actual = await importActual<typeof import('undici')>();
  return {
    ...actual,
    fetch: vi.fn((_url: unknown, opts: Record<string, unknown>) => {
      captured.push(opts);
      capturedUrls.push(String(_url));
      const isSse = String(_url).includes('chat/completions');
      const body = isSse ? 'data: [DONE]\n\n' : JSON.stringify({ images: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }] });
      // The chat stub answers SSE, so it must SAY so: since the ADR 0756 follow-up the
      // OpenAI-compatible dispatcher honours a declared `application/json` as a
      // non-stream completion, and an SSE body mislabelled as JSON is a broken server.
      return Promise.resolve(new actual.Response(body, { status: 200, headers: { 'content-type': isSse ? 'text/event-stream' : 'application/json' } }));
    }),
  };
});

const { webhookEgressDispatcher } = await import('../src/host/webhookEgressGuard.js');
const { dispatchChat } = await import('../src/providers/dispatch.js');
type DispatchRequest = import('../src/providers/dispatch.js').DispatchRequest;
const { dispatchImageGeneration } = await import('../src/host/imageProviderAdapter.js');
const { runSandboxedCode } = await import('../src/host/sandboxAdapter.js');

const COMPAT_BASE = 'https://llm.example.com/v1';
const IMAGE_ENDPOINT = 'https://images.example.com/v1/generate';
const SANDBOX_ENDPOINT = 'https://sandbox.example.com/exec';

afterEach(() => {
  captured.length = 0;
  capturedUrls.length = 0;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('OPENWOP_IMAGE_PROVIDER_') || k.startsWith('OPENWOP_CODE_EXEC_')) delete process.env[k];
  }
});

describe('untrusted-egress pinning (MKP-1/MKP-2)', () => {
  it('the compat dispatcher pins egress + refuses redirects', async () => {
    const req: DispatchRequest = {
      provider: 'compat', model: 'llama3', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: COMPAT_BASE, // public host → passes the string check, reaches fetch
    };
    await dispatchChat(req);
    expect(captured).toHaveLength(1);
    expect(capturedUrls).toEqual([`${COMPAT_BASE}/chat/completions`]);
    expect(captured[0]!.redirect).toBe('error');
    expect(captured[0]!.dispatcher).toBe(webhookEgressDispatcher());
  });

  it('the image-generation adapter pins egress + refuses redirects', async () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = 'true';
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = IMAGE_ENDPOINT;
    process.env.OPENWOP_IMAGE_PROVIDER_KEY = 'k';
    await dispatchImageGeneration({ prompt: 'a cat', n: 1 });
    expect(captured).toHaveLength(1);
    expect(capturedUrls).toEqual([IMAGE_ENDPOINT]);
    expect(captured[0]!.redirect).toBe('error');
    expect(captured[0]!.dispatcher).toBe(webhookEgressDispatcher());
  });

  it('CXE-1: the code-exec sandbox adapter pins egress + refuses redirects', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = SANDBOX_ENDPOINT; // public host → reaches fetch
    await runSandboxedCode({ language: 'python', code: 'print(1)' });
    expect(captured).toHaveLength(1);
    expect(capturedUrls).toEqual([SANDBOX_ENDPOINT]);
    expect(captured[0]!.redirect).toBe('error');
    expect(captured[0]!.dispatcher).toBe(webhookEgressDispatcher());
  });
});
