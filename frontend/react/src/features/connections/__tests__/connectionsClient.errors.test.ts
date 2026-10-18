/**
 * ADR 0780 (grade-ux `CONNUX-3`) — a refused connections call keeps its STATUS
 * and parsed body, so the surface can say "you don't have permission" (403) or
 * "changed elsewhere" (409) instead of one generic failure. The error's message
 * is the server's sentence when it sent one, else `<call> returned <status>`.
 *
 * Sabotage that turns it red (wave 52): dropping `body` from `refusal()`, or
 * replacing the message with the `returned <status>` fallback, or dropping the
 * fallback for a non-JSON body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection, revokeConnection } from '../connectionsClient.js';
import { classifyHttpError } from '../../../client/classifyHttpError.js';
import { ApiError } from '../../../client/requestJson.js';

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('connections client refusals', () => {
  it('a 403 with a server sentence still classifies as forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(403, { error: 'forbidden_scope', message: 'Missing required scope: workspace:write' })));
    const err: unknown = await createConnection({ provider: 'servicenow', kind: 'api_key', secret: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) return;
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write' });
    expect(err.message).toBe('Missing required scope: workspace:write');
    expect(classifyHttpError(err).kind).toBe('forbidden');
  });

  it('a refused revoke carries its status too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(409, { error: 'conflict', message: 'changed' })));
    const err: unknown = await revokeConnection('c1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) return;
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ error: 'conflict', message: 'changed' });
  });

  it('a refusal with no JSON body keeps its status and falls back to "<call> returned <status>"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream exploded', { status: 500 })));
    const err: unknown = await revokeConnection('c1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    if (!(err instanceof ApiError)) return;
    expect(err.status).toBe(500);
    expect(err.body).toBeUndefined();
    expect(err.message).toBe('revokeConnection returned 500');
  });
});
