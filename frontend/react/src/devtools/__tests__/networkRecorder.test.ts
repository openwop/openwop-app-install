import { describe, it, expect } from 'vitest';
import { redactRequestBody, redactResponseBody, recorderMode } from '../networkRecorder.js';

/**
 * Guards the threat-model-secret-leakage invariant for the in-app network
 * recorder: plaintext credential material submitted through `fetch` must never
 * be buffered or mirrored to sessionStorage. The recorder applies
 * redactRequestBody() at capture time, so testing that function proves the
 * invariant without standing up the global fetch hook.
 */
describe('networkRecorder redaction (threat-model-secret-leakage)', () => {
  const SECRET = 'sk-live-PLAINTEXT-KEY-do-not-store';

  it('drops the BYOK secrets POST body entirely', () => {
    const body = JSON.stringify({ credentialRef: 'openai:default', value: SECRET });
    const out = redactRequestBody('/v1/host/openwop-app/byok/secrets', body);
    expect(out).toBe('[redacted: credential request body]');
    expect(out).not.toContain(SECRET);
  });

  it('redacts the same route behind the /api Firebase rewrite', () => {
    const body = JSON.stringify({ credentialRef: 'x', value: SECRET });
    expect(redactRequestBody('/api/v1/host/openwop-app/byok/secrets', body)).not.toContain(SECRET);
  });

  it('redacts the DELETE-by-ref subpath form too', () => {
    const body = JSON.stringify({ value: SECRET });
    expect(redactRequestBody('/v1/host/openwop-app/byok/secrets/openai:default', body)).not.toContain(SECRET);
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
    expect(redactResponseBody('/v1/host/openwop-app/byok/secrets', body)).toBe('[redacted: credential response body]');
    expect(redactResponseBody('/api/v1/host/openwop-app/byok/secrets', body)).not.toContain('openai');
  });

  it('scrubs secret-named fields in a response body (defense in depth)', () => {
    const body = JSON.stringify({ ok: true, token: SECRET, nested: { apiKey: SECRET }, harmless: 1 });
    const out = redactResponseBody('/v1/host/openwop-app/connections/x', body)!;
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
