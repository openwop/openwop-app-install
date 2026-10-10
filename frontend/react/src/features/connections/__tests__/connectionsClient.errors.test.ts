/**
 * ADR 0780 (grade-ux `CONNUX-3`) — a refused connections call keeps its STATUS
 * and parsed body, so the surface can say "you don't have permission" (403) or
 * "changed elsewhere" (409) instead of one generic failure.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnection, revokeConnection } from '../connectionsClient.js';
import { classifyHttpError } from '../../../client/classifyHttpError.js';

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('connections client refusals', () => {
  it('a 403 with a server sentence still classifies as forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(403, { error: 'forbidden_scope', message: 'Missing required scope: workspace:write' })));
    const err = await createConnection({ provider: 'servicenow', kind: 'api_key', secret: 'x' }).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    expect(classifyHttpError(err).kind).toBe('forbidden');
  });

  it('a refused revoke carries its status too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(409, { error: 'conflict', message: 'changed' })));
    const err = await revokeConnection('c1').catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(409);
  });
});
