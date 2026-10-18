import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  redactRequestBody, redactResponseBody, recorderMode, installNetworkRecorder, listNetworkEntries,
} from '../networkRecorder.js';

/**
 * Guards the threat-model-secret-leakage invariant for the in-app network
 * recorder (ADR 0196 Gate B — the inspector shows raw bodies): plaintext credential
 * material submitted through `fetch` must never be buffered or mirrored to
 * sessionStorage. Two layers are witnessed:
 *   - the pure redactors — the route-level drop is asserted EXACTLY (a `not.toContain`
 *     was masked by the field scrub, which also removes a `value` field), and the
 *     field-level scrub on any other route;
 *   - the capture-time WIRING — the real `installNetworkRecorder` over a stubbed
 *     `fetch`: request bodies, response bodies and SSE event payloads reach the
 *     buffer and its sessionStorage mirror redacted.
 * `DTC-4` (BLOCKED-ON-PRODUCT, `it.fails`): a credential carried in the URL QUERY
 * (the invite preview `?token=`) is buffered and mirrored verbatim — redaction covers
 * bodies only.
 *
 * Sabotage that turns it red: un-anchoring/narrowing the BYOK route regexes, dropping
 * a name from SECRET_FIELD_KEYS, or calling the raw body instead of
 * redactRequestBody / redactResponseBody at the three capture sites.
 */
describe('networkRecorder redaction (threat-model-secret-leakage)', () => {
  const SECRET = 'sk-live-PLAINTEXT-KEY-do-not-store';

  it('drops the BYOK secrets POST body entirely', () => {
    const body = JSON.stringify({ credentialRef: 'openai:default', value: SECRET });
    const out = redactRequestBody('/host/openwop-app/byok/secrets', body);
    expect(out).toBe('[redacted: credential request body]');
    expect(out).not.toContain(SECRET);
  });

  it('redacts the same route behind the /api Firebase rewrite', () => {
    const body = JSON.stringify({ credentialRef: 'x', value: SECRET });
    expect(redactRequestBody('/api/host/openwop-app/byok/secrets', body)).toBe('[redacted: credential request body]');
  });

  it('redacts the DELETE-by-ref subpath form too', () => {
    const body = JSON.stringify({ value: SECRET });
    expect(redactRequestBody('/host/openwop-app/byok/secrets/openai:default', body)).toBe('[redacted: credential request body]');
  });

  it('scrubs secret-named fields on unknown routes (defense in depth)', () => {
    const body = JSON.stringify({ apiKey: SECRET, nested: { password: SECRET }, harmless: 1 });
    const out = redactRequestBody('/v1/runs', body)!;
    expect(out).not.toContain(SECRET);
    expect(out).toContain('harmless');
    expect(out).toContain('[redacted]');
  });

  it('leaves non-secret bodies untouched', () => {
    const body = JSON.stringify({ workflow: 'demo', input: { q: 'hi' } });
    expect(redactRequestBody('/v1/runs', body)).toBe(body);
  });

  it('passes through undefined / non-JSON bodies unchanged', () => {
    expect(redactRequestBody('/v1/runs', undefined)).toBeUndefined();
    expect(redactRequestBody('/v1/runs', 'not json')).toBe('not json');
  });

  // Response bodies are mirrored to sessionStorage once prod capture is enabled
  // (VITE_ENABLE_NETWORK_RECORDER), so they get the same redaction discipline.
  it('drops the BYOK secrets response body entirely (route-level)', () => {
    const body = JSON.stringify({ credentialRefs: ['openai:default'] });
    expect(redactResponseBody('/host/openwop-app/byok/secrets', body)).toBe('[redacted: credential response body]');
    expect(redactResponseBody('/api/host/openwop-app/byok/secrets', body)).toBe('[redacted: credential response body]');
  });

  it('scrubs secret-named fields in a response body (defense in depth)', () => {
    const body = JSON.stringify({ ok: true, token: SECRET, nested: { apiKey: SECRET }, harmless: 1 });
    const out = redactResponseBody('/host/openwop-app/connections/x', body)!;
    expect(out).not.toContain(SECRET);
    expect(out).toContain('harmless');
    expect(out).toContain('[redacted]');
  });

  it('leaves benign + non-JSON response bodies untouched', () => {
    const body = JSON.stringify({ runId: 'r-1', status: 'running' });
    expect(redactResponseBody('/v1/runs/r-1', body)).toBe(body);
    expect(redactResponseBody('/v1/runs', undefined)).toBeUndefined();
    expect(redactResponseBody('/v1/runs', 'not json')).toBe('not json');
  });
});

describe('capture-time redaction (the real recorder wrapper)', () => {
  const SECRET = 'sk-live-WIRED-KEY-do-not-store';
  const INVITE = 'inv-tok-PLAINTEXT-do-not-store';
  const STORAGE_KEY = 'openwop.networkRecorder.v1';
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/byok/secrets')) return json({ credentialRefs: ['openai:default'] });
      if (url.includes('/connections/')) return json({ ok: true, token: SECRET, harmless: 1 });
      if (url.includes('/events')) {
        const body = new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(new TextEncoder().encode(`data: {"token":"${SECRET}","harmless":1}\n\n`)); c.close(); },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return json({ ok: true });
    }));
    installNetworkRecorder();
  });

  const entry = (path: string) => listNetworkEntries().find((e) => e.path === path);
  /** Positive control first (the mirror holds THIS row), then the leak check. */
  async function mirrorHoldsRedacted(pathFragment: string, secret: string): Promise<void> {
    await vi.waitFor(() => expect(window.sessionStorage.getItem(STORAGE_KEY) ?? '').toContain(pathFragment));
    expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toContain(secret);
  }

  it('a BYOK secrets POST body is buffered as the route-level marker, never the plaintext', async () => {
    await window.fetch('/api/host/openwop-app/byok/secrets', {
      method: 'POST', body: JSON.stringify({ credentialRef: 'openai:default', value: SECRET }),
    });
    const e = entry('/api/host/openwop-app/byok/secrets');
    expect(e?.requestBody).toBe('[redacted: credential request body]');
    expect(e?.responseBody).toBe('[redacted: credential response body]');
    await mirrorHoldsRedacted('/api/host/openwop-app/byok/secrets', SECRET);
  });

  it('a secret-named field in a captured RESPONSE body is scrubbed in the buffer and the mirror', async () => {
    await window.fetch('/api/host/openwop-app/connections/x');
    const body = entry('/api/host/openwop-app/connections/x')?.responseBody ?? '';
    expect(body).toContain('harmless');
    expect(body).toContain('[redacted]');
    expect(body).not.toContain(SECRET);
    await mirrorHoldsRedacted('/api/host/openwop-app/connections/x', SECRET);
  });

  it('a secret-named field in an SSE event payload is scrubbed before it reaches the timeline', async () => {
    const res = await window.fetch('/api/runs/r-sec/events');
    await res.text();
    await vi.waitFor(() => expect(entry('/api/runs/r-sec/events')?.finishedAt).toBeTypeOf('number'));
    const events = entry('/api/runs/r-sec/events')?.sseEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toContain('harmless');
    expect(events[0]!.data).not.toContain(SECRET);
    await mirrorHoldsRedacted('/api/runs/r-sec/events', SECRET);
  });

  // DTC-4 — BLOCKED-ON-PRODUCT. `previewInvite` (orgs/invitesClient.ts) sends the invite
  // token — "the token is the credential" — in the URL query; the recorder keeps `url`
  // and `path` (incl. `search`) verbatim in the buffer and the sessionStorage mirror.
  // Fix-probe: redact `token=` in the entry's url/path at construction (w32g2-dtc4-fix-r2).
  it.fails('DTC-4: a credential in the URL query (invite preview ?token=) is not buffered or mirrored', async () => {
    await window.fetch(`/api/host/openwop-app/orgs/invitations/preview?token=${INVITE}`);
    await mirrorHoldsRedacted('/invitations/preview', INVITE);
    const rows = listNetworkEntries().filter((e) => e.path.startsWith('/api/host/openwop-app/orgs/invitations/preview'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).not.toContain(INVITE);
    expect(rows[0]!.path).not.toContain(INVITE);
  });
});

describe('recorderMode (prod keeps the cold-start liveness tap)', () => {
  it('dev → full capture', () => {
    expect(recorderMode({ PROD: false })).toBe('full');
  });
  it('prod without opt-in → liveness only (NOT off — preserves recordLastSuccess)', () => {
    expect(recorderMode({ PROD: true })).toBe('liveness');
  });
  it('prod with opt-in → full capture', () => {
    expect(recorderMode({ PROD: true, VITE_ENABLE_NETWORK_RECORDER: '1' })).toBe('full');
  });
  it('hard opt-out → off (unmodified fetch) regardless of env', () => {
    expect(recorderMode({ PROD: false, VITE_DISABLE_NETWORK_RECORDER: '1' })).toBe('off');
    expect(recorderMode({ PROD: true, VITE_DISABLE_NETWORK_RECORDER: '1' })).toBe('off');
  });
});
