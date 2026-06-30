/**
 * MKP-1 / MKP-2 — the two untrusted-egress provider paths (the local-model "compat"
 * dispatcher, ADR 0121; the image-generation adapter, ADR 0115) must route their fetch
 * through the connect-time-validating pinned dispatcher, closing the DNS-rebind TOCTOU
 * that the string-only host check can't. This asserts the WIRING hermetically by mocking
 * undici's `fetch` (the named import both paths now use, matching webhookDeliveryWorker):
 * each path passes `dispatcher === webhookEgressDispatcher()` + `redirect:'error'`. The
 * dispatcher's actual private-range blocking is covered by webhook-egress-guard's own
 * tests; here we only prove the call sites opt in.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Capture each undici.fetch call's options; keep the rest of undici real (Agent, Response)
// so webhookEgressDispatcher() still builds a genuine Agent we can identity-compare.
const captured = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('undici', async (importActual) => {
  const actual = await importActual<typeof import('undici')>();
  return {
    ...actual,
    fetch: vi.fn((_url: unknown, opts: Record<string, unknown>) => {
      captured.push(opts);
      const isSse = String(_url).includes('chat/completions');
      const body = isSse ? 'data: [DONE]\n\n' : JSON.stringify({ images: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }] });
      return Promise.resolve(new actual.Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    }),
  };
});

const { webhookEgressDispatcher } = await import('../src/host/webhookEgressGuard.js');
const { dispatchChat } = await import('../src/providers/dispatch.js');
const { dispatchImageGeneration } = await import('../src/host/imageProviderAdapter.js');
const { runSandboxedCode } = await import('../src/host/sandboxAdapter.js');

afterEach(() => {
  captured.length = 0;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('OPENWOP_IMAGE_PROVIDER_') || k.startsWith('OPENWOP_CODE_EXEC_')) delete process.env[k];
  }
});

describe('untrusted-egress pinning (MKP-1/MKP-2)', () => {
  it('the compat dispatcher pins egress + refuses redirects', async () => {
    await dispatchChat({
      provider: 'compat', model: 'llama3', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      baseUrl: 'https://llm.example.com/v1', // public host → passes the string check, reaches fetch
    } as Parameters<typeof dispatchChat>[0]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.redirect).toBe('error');
    expect(captured[0]!.dispatcher).toBe(webhookEgressDispatcher());
  });

  it('the image-generation adapter pins egress + refuses redirects', async () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = 'true';
    process.env.OPENWOP_IMAGE_PROVIDER_ENDPOINT = 'https://images.example.com/v1/generate';
    process.env.OPENWOP_IMAGE_PROVIDER_KEY = 'k';
    await dispatchImageGeneration({ prompt: 'a cat', n: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.redirect).toBe('error');
    expect(captured[0]!.dispatcher).toBe(webhookEgressDispatcher());
  });

  it('CXE-1: the code-exec sandbox adapter pins egress + refuses redirects', async () => {
    process.env.OPENWOP_CODE_EXEC_ENDPOINT = 'https://sandbox.example.com/exec'; // public host → reaches fetch
    await runSandboxedCode({ language: 'python', code: 'print(1)' });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.redirect).toBe('error');
    expect(captured[0]!.dispatcher).toBe(webhookEgressDispatcher());
  });
});
