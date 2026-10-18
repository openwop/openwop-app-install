import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestJson, ApiError, setRequestTelemetry } from '../requestJson.js';
import { classifyHttpError } from '../classifyHttpError.js';
import { config } from '../config.js';

/**
 * The shared requestJson helper + ApiError contract (enterprise-review
 * remediation #55; status 0 → offline per GAP-ANALYSIS E5 / ADR 0482):
 * relative paths resolve against config.baseUrl, a failure is a structured
 * ApiError carrying the numeric status and the parsed body (no string
 * parsing), a malformed 200 keeps its real status, okStatuses, the telemetry
 * seam, and the network-error → status:0 → offline mapping.
 *
 * Breaks it: a failure that loses its status or body, a network error that
 * reads as a server error, a guard failure that reads as offline, or a
 * relative path sent unresolved.
 */
type Impl = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: Impl) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
    impl(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init));
}

beforeEach(() => setRequestTelemetry(null));
afterEach(() => { vi.restoreAllMocks(); });

describe('requestJson', () => {
  it('parses a JSON 200 body from the path resolved against config.baseUrl (GET by default)', async () => {
    const f = mockFetch(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await requestJson('/v1/x')).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe(`${config.baseUrl}/v1/x`);
    expect(f.mock.calls[0]![1]?.method).toBe('GET');
  });

  it('throws a structured ApiError with numeric status, the parsed body, and the server message on failure', async () => {
    mockFetch(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 429, statusText: 'Too Many' }));
    const e = await requestJson('/v1/x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(429);
    expect((e as ApiError).body).toEqual({ message: 'nope' });
    expect((e as ApiError).message).toBe('GET /v1/x → 429: nope');
  });

  it('classifyHttpError reads ApiError.status directly (no string parsing)', async () => {
    const err = new ApiError({ status: 429, statusText: 'Too Many', url: '/v1/x' });
    expect(classifyHttpError(err).kind).toBe('rate-limited');
  });

  it('maps a network failure to ApiError(status:0) → offline', async () => {
    mockFetch(async () => { throw new TypeError('Failed to fetch'); });
    const e = await requestJson('/v1/x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(0);
    expect(classifyHttpError(e).kind).toBe('offline');
  });

  it('treats okStatuses as success', async () => {
    mockFetch(async () => new Response('', { status: 404 }));
    await expect(requestJson('/v1/x', { method: 'DELETE', okStatuses: [404] })).resolves.toBeUndefined();
  });

  it('fails a 200 that does not satisfy the guard — carrying the real 200, never the offline status 0', async () => {
    mockFetch(async () => new Response(JSON.stringify({ wrong: true }), { status: 200 }));
    const guard = (v: unknown): v is { id: string } => !!v && typeof (v as { id?: unknown }).id === 'string';
    const e = await requestJson('/v1/x', { guard }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(200);
    expect(classifyHttpError(e).kind).not.toBe('offline');
  });

  it('sets content-type and serializes json bodies; emits telemetry', async () => {
    const seen: { status: number; ok: boolean }[] = [];
    setRequestTelemetry({ onRequest: (ev) => seen.push({ status: ev.status, ok: ev.ok }) });
    let sentCT: string | null = null;
    let sentBody: unknown = null;
    mockFetch(async (_url, init) => {
      sentCT = new Headers(init?.headers).get('content-type');
      sentBody = init?.body;
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    });
    await requestJson('/v1/x', { json: { a: 1 } });
    expect(sentCT).toBe('application/json');
    expect(sentBody).toBe(JSON.stringify({ a: 1 }));
    expect(seen).toEqual([{ status: 200, ok: true }]);
  });
});
