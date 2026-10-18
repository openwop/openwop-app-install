/**
 * ADR 0121 / RFC 0108: the compat-endpoint client's gating branches. A 404 means
 * the operator opt-in (OPENWOP_COMPAT_PROVIDER_ENABLED) is off → the card hides
 * (null). A 403 (no scope) throws an error CARRYING `status` → the card branches on
 * it (`writeForbidden`) rather than reading the raw text. A 200 returns the org's
 * endpoints, read for the org named in the query.
 *
 * The stored key is never returned by the SERVER (only `hasKey`); this client
 * passes the body through unchanged, so that property is the backend route's to
 * prove, not this file's.
 *
 * Sabotage that turns these red (compatClient.ts): dropping the 404 gate; adding
 * 403 to it; dropping `status` from the thrown error; dropping/garbling the
 * `orgId` query; mis-unwrapping `.endpoints`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { config } from '../../../client/config.js';
import { listCompatEndpoints, type CompatEndpointView } from '../compatClient.js';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stubFetch = (res: Response) => {
  const f = vi.fn<typeof fetch>(async () => res);
  vi.stubGlobal('fetch', f);
  return f;
};

const LIST_URL = `${config.baseUrl}/host/openwop-app/compat-endpoints?orgId=org%201`;

afterEach(() => { vi.unstubAllGlobals(); });

describe('listCompatEndpoints — gating', () => {
  it('returns null when the surface is disabled (404 → card hides)', async () => {
    const f = stubFetch(json({}, 404));
    expect(await listCompatEndpoints('org 1')).toBeNull();
    expect(f.mock.calls[0]![0]).toBe(LIST_URL);
  });

  it('returns the org\'s endpoints on 200, read for exactly that org', async () => {
    const endpoints: CompatEndpointView[] = [{ id: 'compat-1', orgId: 'org 1', label: 'Local', baseUrl: 'https://x/v1', hasKey: true, capabilities: { vision: false, tools: true, longContext: false }, createdAt: 't', updatedAt: 't' }];
    const f = stubFetch(json({ endpoints }, 200));
    expect(await listCompatEndpoints('org 1')).toEqual(endpoints);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![0]).toBe(LIST_URL);
  });

  it('throws on 403 (no scope) with the status attached — NOT treated as available', async () => {
    stubFetch(json({ message: 'forbidden_scope' }, 403));
    const err = await listCompatEndpoints('org 1').catch((e: unknown) => e);
    expect(err instanceof Error && err.message).toBe('forbidden_scope');
    expect(err).toMatchObject({ status: 403 });
  });
});
