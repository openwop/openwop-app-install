import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestJson, ApiError, setRequestTelemetry } from '../requestJson.js';
import { classifyHttpError } from '../classifyHttpError.js';

/**
 * Covers the shared requestJson helper + ApiError contract: structured status
 * (no string parsing), JSON parse, guard, okStatuses, telemetry seam, and the
 * network-error → status:0 → offline mapping in classifyHttpError.
 */
const origFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

beforeEach(() => setRequestTelemetry(null));
afterEach(() => { globalThis.fetch = origFetch; vi.restoreAllMocks(); });

describe('requestJson', () => {
  it('parses a JSON 200 body', async () => {
    mockFetch(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await requestJson('/v1/x')).toEqual({ ok: 1 });
  });

  it('throws a structured ApiError with numeric status on failure', async () => {
    mockFetch(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 429, statusText: 'Too Many' }));
    await expect(requestJson('/v1/x')).rejects.toMatchObject({ status: 429 });
    try {
      await requestJson('/v1/x');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(429);
      expect((e as ApiError).message).toContain('nope');
    }
  });

  it('classifyHttpError reads ApiError.status directly (no string parsing)', async () => {
    const err = new ApiError({ status: 429, statusText: 'Too Many', url: '/v1/x' });
    expect(classifyHttpError(err).kind).toBe('rate-limited');
  });

  it('maps a network failure to ApiError(status:0) → offline', async () => {
    mockFetch(async () => { throw new TypeError('Failed to fetch'); });
    try {
      await requestJson('/v1/x');
    } catch (e) {
      expect((e as ApiError).status).toBe(0);
      expect(classifyHttpError(e).kind).toBe('offline');
    }
  });

  it('treats okStatuses as success', async () => {
    mockFetch(async () => new Response('', { status: 404 }));
    await expect(requestJson('/v1/x', { method: 'DELETE', okStatuses: [404] })).resolves.toBeUndefined();
  });

  it('fails a 200 that does not satisfy the guard', async () => {
    mockFetch(async () => new Response(JSON.stringify({ wrong: true }), { status: 200 }));
    const guard = (v: unknown): v is { id: string } => !!v && typeof (v as { id?: unknown }).id === 'string';
    await expect(requestJson('/v1/x', { guard })).rejects.toBeInstanceOf(ApiError);
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
