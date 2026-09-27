/**
 * TWIN-UX-6 follow-through — the `ApiError` preference order, pinned.
 *
 * `apiErrorFrom` is what revived the 28 dead translated strings, and its
 * contract is exactly three claims, each of which was a shipped bug in the
 * other direction:
 *
 *   1. The BACKEND'S OWN prose wins when it sent any — the clients used to
 *      replace "This memory already holds the maximum 200 curated notes…" with
 *      `addMemory failed (400)`.
 *   2. The LOCALIZED fallback renders only on message-less failures (a proxy
 *      502, a non-JSON body) — which is also the honest limit of the "revived"
 *      claim: when the server speaks, its English wins in all four locales
 *      until backend messages ship by code (recorded follow-up).
 *   3. `serverMessage` is TYPED, never sniffed back out of `message`, so a
 *      consumer can present it separately from the fallback.
 */
import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorFrom } from '../errorEnvelope.js';

const res = (status: number, body: string | null, contentType = 'application/json'): Response =>
  new Response(body, { status, headers: body === null ? {} : { 'content-type': contentType } });

const FALLBACK = 'localized fallback for what the USER was doing';

describe('apiErrorFrom — preference order', () => {
  it('prefers the server’s own message, and carries it TYPED as serverMessage', async () => {
    const e = await apiErrorFrom(
      res(400, JSON.stringify({ error: 'note_cap', message: 'This memory already holds the maximum 200 curated notes.' })),
      FALLBACK,
    );
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe('This memory already holds the maximum 200 curated notes.');
    expect(e.serverMessage).toBe('This memory already holds the maximum 200 curated notes.');
    expect(e.status).toBe(400);
  });

  it('falls back to the localized string on a message-less envelope', async () => {
    const e = await apiErrorFrom(res(500, JSON.stringify({ error: 'internal' })), FALLBACK);
    expect(e.message).toBe(FALLBACK);
    expect(e.serverMessage).toBeUndefined();
  });

  it('falls back — without throwing — on a non-JSON body (the proxy-502 case)', async () => {
    const e = await apiErrorFrom(res(502, '<html>Bad Gateway</html>', 'text/html'), FALLBACK);
    expect(e.message).toBe(FALLBACK);
    expect(e.serverMessage).toBeUndefined();
    expect(e.status).toBe(502);
  });

  it('tolerates the legacy nested envelope during the deprecation window', async () => {
    const e = await apiErrorFrom(
      res(409, JSON.stringify({ error: { code: 'held', message: 'Nested prose still reaches the user.' } })),
      FALLBACK,
    );
    expect(e.message).toBe('Nested prose still reaches the user.');
    expect(e.serverMessage).toBe('Nested prose still reaches the user.');
  });

  it('an empty-string server message does not shadow the fallback', async () => {
    const e = await apiErrorFrom(res(500, JSON.stringify({ error: 'x', message: '' })), FALLBACK);
    expect(e.message).toBe(FALLBACK);
    expect(e.serverMessage).toBeUndefined();
  });
});
