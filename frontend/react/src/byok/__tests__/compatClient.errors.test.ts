/**
 * ADR 0779 D7 (grade-ux H1): the compat client's error carries the server
 * envelope AND the HTTP status, so the card shows the validation sentence
 * ("baseUrl must be https …") instead of classifying a 400 as "Something went
 * wrong. Retry.", and can branch on the status (403 → read-only).
 *
 * Sabotage that turns this red: dropping `body` from the thrown error in
 * compatClient.ts `asJson` (the message falls back to the classification), or
 * dropping `status`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../client/config.js';
import { createCompatEndpoint } from '../lib/compatClient.js';
import { byokErrorMessage } from '../lib/byokWriteAccess.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('compat client errors', () => {
  it('a 400 reaches byokErrorMessage as the server sentence', async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: 'validation_error', message: 'baseUrl must be https' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    const err = await createCompatEndpoint({ orgId: 'o', label: 'x', baseUrl: 'http://x', capabilities: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, body: { error: 'validation_error', message: 'baseUrl must be https' } });
    expect(byokErrorMessage((k: string) => k, err)).toBe('baseUrl must be https');
    // The request that was refused: a POST of the create body to the collection.
    expect(f.mock.calls[0]![0]).toBe(`${config.baseUrl}/host/openwop-app/compat-endpoints`);
    const init = f.mock.calls[0]![1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ orgId: 'o', label: 'x', baseUrl: 'http://x', capabilities: {} });
  });
});
