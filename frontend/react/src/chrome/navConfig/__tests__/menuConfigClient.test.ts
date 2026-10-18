/**
 * ADR 0139 Phase 2 — the menu-config client's read honesty and its concurrency
 * guard. A failed read must REJECT (the provider turns that into a distinct
 * degraded state) rather than coerce "unknown" to an empty bundle; the tenant
 * ETag from a read must ride the next tenant PUT as `If-Match` so concurrent
 * workspace edits fail instead of clobbering; and a failed reload (possibly after
 * an identity/tenant change) must drop the previous context's validator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMenuConfig, putTenantMenuConfig } from '../menuConfigClient.js';

afterEach(() => vi.unstubAllGlobals());

/** A real Response — no laundered fetch fixtures. */
const res = (status: number, body: unknown, etag?: string): Response =>
  new Response(JSON.stringify(body), { status, headers: etag ? { etag, 'content-type': 'application/json' } : { 'content-type': 'application/json' } });
const bundle = () => ({ tenant: { items: {}, headers: [] }, user: { items: {}, headers: [] } });

describe('menu config client read honesty', () => {
  it('rejects a failed read instead of coercing unknown state to an empty bundle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(503, { error: 'unavailable', message: 'try later' })));

    await expect(getMenuConfig()).rejects.toThrow('unavailable: try later');
  });

  it('returns a legitimate empty bundle when the server answers successfully', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, bundle(), '"v1"')));

    await expect(getMenuConfig()).resolves.toEqual(bundle());
  });

  it('round-trips the tenant ETag so concurrent workspace edits fail instead of clobbering', async () => {
    const b = bundle();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => res(200, {}))
      .mockResolvedValueOnce(res(200, b, '"v7"'))
      .mockResolvedValueOnce(res(200, { config: b.tenant }, '"v8"'));
    vi.stubGlobal('fetch', fetchMock);

    await getMenuConfig();
    await putTenantMenuConfig(b.tenant);

    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toMatch(/\/host\/openwop-app\/menu-config\/tenant$/);
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toMatchObject({ 'if-match': '"v7"' });
  });

  it('discards a prior tenant ETag when a later reload fails', async () => {
    const b = bundle();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => res(200, {}))
      .mockResolvedValueOnce(res(200, b, '"old-context"'))
      .mockResolvedValueOnce(res(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(res(200, { config: b.tenant }, '"new-context"'));
    vi.stubGlobal('fetch', fetchMock);

    await getMenuConfig();
    await expect(getMenuConfig()).rejects.toThrow('unavailable');
    await putTenantMenuConfig(b.tenant);

    const init = fetchMock.mock.calls[2]?.[1];
    expect(init?.method).toBe('PUT');
    expect(init?.headers).not.toHaveProperty('if-match');
  });
});
