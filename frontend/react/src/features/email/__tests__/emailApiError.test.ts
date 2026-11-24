/**
 * Issue 5962 — the email client's failures carry the status and the code, so a
 * caller decides "not found" without reading message text.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTemplate } from '../emailClient.js';
import { EmailApiError, isEmailNotFound } from '../emailErrors.js';

afterEach(() => { vi.unstubAllGlobals(); });
const answer = (status: number, body?: unknown) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('issue 5962 — EmailApiError', () => {
  it('the server\'s real 404 body becomes a typed not-found', async () => {
    vi.stubGlobal('fetch', answer(404, { error: 'not_found', message: 'Template not found.' }));
    const err = await getTemplate('o1', 'gone').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmailApiError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'Template not found.' });
    expect(isEmailNotFound(err)).toBe(true);
  });

  it('a 500 is not a not-found, and a plain Error never is', async () => {
    vi.stubGlobal('fetch', answer(500, { error: 'internal', message: 'boom' }));
    const err = await getTemplate('o1', 'x').then(() => null, (e: unknown) => e);
    expect(isEmailNotFound(err)).toBe(false);
    expect(isEmailNotFound(new Error('getTemplate returned 404'))).toBe(false);
  });

  it('TST-OAR-1 — the status decides, not the code: a non-404 carrying `not_found` is not a not-found', () => {
    expect(isEmailNotFound(new EmailApiError('Template not found.', 404))).toBe(true);
    expect(isEmailNotFound(new EmailApiError('nope', 409, 'not_found'))).toBe(false);
  });
});
