import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMenuConfig, putTenantMenuConfig } from '../menuConfigClient.js';

afterEach(() => vi.unstubAllGlobals());

describe('menu config client read honesty', () => {
  it('rejects a failed read instead of coercing unknown state to an empty bundle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => ({ error: 'unavailable', message: 'try later' }),
    } as unknown as Response)));

    await expect(getMenuConfig()).rejects.toThrow('unavailable: try later');
  });

  it('returns a legitimate empty bundle when the server answers successfully', async () => {
    const bundle = { tenant: { items: {}, headers: [] }, user: { items: {}, headers: [] } };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"v1"' }),
      json: async () => bundle,
    } as unknown as Response)));

    await expect(getMenuConfig()).resolves.toEqual(bundle);
  });

  it('round-trips the tenant ETag so concurrent workspace edits fail instead of clobbering', async () => {
    const bundle = { tenant: { items: {}, headers: [] }, user: { items: {}, headers: [] } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ etag: '"v7"' }), json: async () => bundle } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ etag: '"v8"' }), json: async () => ({ config: bundle.tenant }) } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await getMenuConfig();
    await putTenantMenuConfig(bundle.tenant);

    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ 'if-match': '"v7"' });
  });

  it('discards a prior tenant ETag when a later reload fails', async () => {
    const bundle = { tenant: { items: {}, headers: [] }, user: { items: {}, headers: [] } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ etag: '"old-context"' }), json: async () => bundle } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(), json: async () => ({ error: 'unavailable' }) } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers({ etag: '"new-context"' }), json: async () => ({ config: bundle.tenant }) } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await getMenuConfig();
    await expect(getMenuConfig()).rejects.toThrow('unavailable');
    await putTenantMenuConfig(bundle.tenant);

    const init = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(init.headers).not.toHaveProperty('if-match');
  });
});
