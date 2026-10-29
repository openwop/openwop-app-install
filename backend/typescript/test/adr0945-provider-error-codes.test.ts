/**
 * ADR 0945 P2 — the judge's provider error codes come from the WHOLE provider
 * body. The first production run (2026-10-29, gemini-2.5-pro) logged
 * `providerStatus: 429, providerCodes: ""`: Google's quota 429 puts a long
 * `message` before `"status": "RESOURCE_EXHAUSTED"`, and the thrown message
 * keeps only 500 bytes. Mocks only the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchChat, providerErrorCodes, type ProviderHttpError } from '../src/providers/dispatch.js';
import { summariseProviderError } from '../src/host/creativeFidelity/index.js';

const KEY = 'AIzaSyD3adb33fC0ffee0123456789abcdefGHIJ';
// Shape of Google's pretty-printed free-tier quota 429; the message alone is
// longer than the 500-byte error-message cap.
const QUOTA = Array.from({ length: 4 }, (_, i) => `* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests_${i}, limit: 0, model: gemini-2.5-pro`).join('\n');
const BODY = JSON.stringify({ error: { code: 429,
  message: `You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. Key ${KEY}\n${QUOTA}`,
  status: 'RESOURCE_EXHAUSTED',
  details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_content_free_tier_requests' }] },
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', metadata: { key: KEY } }] } }, null, 2);

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

async function googleFailure(): Promise<ProviderHttpError> {
  global.fetch = vi.fn(async () => new Response(BODY, { status: 429, headers: { 'Retry-After': '0' } })) as typeof fetch;
  try {
    await dispatchChat({ provider: 'google', model: 'gemini-2.5-pro', apiKey: 'k', messages: [{ role: 'user', content: 'hi' }], maxTokens: 24 });
  } catch (e) { return e as ProviderHttpError; }
  throw new Error('expected a provider failure');
}

describe('provider error codes survive message truncation', () => {
  it('the fixture really puts the code past the 500-byte message cap', async () => {
    const err = await googleFailure();
    expect(BODY.indexOf('RESOURCE_EXHAUSTED')).toBeGreaterThan(520);
    expect(err.message).toMatch(/^google_429: /);
    expect(err.message).not.toContain('RESOURCE_EXHAUSTED');
  });

  it('the dispatcher attaches the codes read from the whole body', async () => {
    const err = await googleFailure();
    expect(err.providerCodes).toEqual(['RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED']);
  });

  it('the judge summary records status and codes, never the key or the message', async () => {
    const summary = summariseProviderError(await googleFailure());
    expect(summary).toEqual({ status: 429, codes: ['RESOURCE_EXHAUSTED', 'RATE_LIMIT_EXCEEDED'] });
    expect(JSON.stringify(summary)).not.toContain(KEY);
  });

  it('only code-shaped values are collected; an attached non-code is dropped by the summary', () => {
    expect(providerErrorCodes(`{"status": "two words", "code": "${KEY}", "type": "invalid_request_error"}`)).toEqual(['invalid_request_error']);
    const forged = Object.assign(new Error('google_429: {}'), { providerCodes: ['RESOURCE_EXHAUSTED', KEY, 'has space'] });
    expect(summariseProviderError(forged)).toEqual({ status: 429, codes: ['RESOURCE_EXHAUSTED'] });
  });
});
