/**
 * ADR 0624 D6 / PROF-10 — the profiles client throws a TYPED failure. The pin
 * cap answers `409 validation_error { maxPinned, target }`; before this the
 * client collapsed every non-ok response to a bare `Error(message)`, so the
 * only way to say "full (max 12)" in the user's language was to sniff the
 * English prose. `status` / `code` / `details` ride on the error instead.
 *
 * `pinLimitOf` keys on BOTH the type and the status. The negative arms therefore
 * carry a `maxPinned` they must still ignore (a non-409 with the field; a
 * non-ProfilesApiError shaped exactly like a pin cap). Without it, deleting
 * either guard changed nothing. Sabotage-witnessed (/grade-tests wave 3,
 * `w3g3-pc-*`): dropping `code`/`details`/`status`, the ctx fallback message, the
 * 409 gate or the `instanceof` gate each turns a named case red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProfilesApiError, pinLimitOf, setAgentPinned, setChatAgentPinned } from '../profilesClient.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('ProfilesApiError — the typed failure', () => {
  it('a 409 pin cap surfaces status + code + details.maxPinned (sidebar lane)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, {
      error: 'validation_error', message: 'Pinned agents are full (max 12).', details: { maxPinned: 12, target: 'sidebar' },
    })));
    const err = await setAgentPinned('r1', true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfilesApiError);
    const typed = err as ProfilesApiError;
    expect(typed.status).toBe(409);
    expect(typed.code).toBe('validation_error');
    expect(typed.details).toEqual({ maxPinned: 12, target: 'sidebar' });
    expect(typed.message).toBe('Pinned agents are full (max 12).');
    expect(pinLimitOf(typed)).toBe(12);
  });

  it('the chat lane carries the same contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, {
      error: 'validation_error', message: 'Pinned agents are full (max 12).', details: { maxPinned: 12, target: 'chat' },
    })));
    const err = await setChatAgentPinned('r1', true).catch((e: unknown) => e);
    expect(pinLimitOf(err)).toBe(12);
    expect((err as ProfilesApiError).details?.target).toBe('chat');
  });

  it('pinLimitOf is undefined for every other failure (a 409 without the field, a 404, a non-JSON 500, a plain Error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: 'conflict', message: 'x' })));
    expect(pinLimitOf(await setAgentPinned('r1', true).catch((e: unknown) => e))).toBeUndefined();

    // A non-409 is not a pin cap EVEN WHEN it carries the field — the status decides.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: 'not_found', message: 'Agent not found.', details: { rosterId: 'r1', maxPinned: 12 } })));
    const nf = await setAgentPinned('r1', true).catch((e: unknown) => e) as ProfilesApiError;
    expect(nf.status).toBe(404);
    expect(nf.code).toBe('not_found');
    expect(nf.details?.maxPinned).toBe(12);
    expect(pinLimitOf(nf)).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 500 })));
    const server = await setAgentPinned('r1', true).catch((e: unknown) => e) as ProfilesApiError;
    expect(server.status).toBe(500);
    expect(server.code).toBeUndefined();
    expect(server.details).toBeUndefined();
    expect(server.message).toBe('setAgentPinned returned 500'); // the ctx fallback, unchanged

    expect(pinLimitOf(new Error('Pinned agents are full (max 12).'))).toBeUndefined(); // prose is not a contract
    // Nor is SHAPE: another client's error carrying the same status + details is
    // not this client's typed pin-cap failure.
    const lookalike = Object.assign(new Error('Pinned agents are full (max 12).'), { status: 409, details: { maxPinned: 12 } });
    expect(pinLimitOf(lookalike)).toBeUndefined();
  });
});
