/**
 * CDP-G — collection SDK (ADR 0269). The zero-dep client builds the right requests
 * (path, method, bearer auth, JSON body) and treats a resolve 404 as null.
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-ignore — the shipped SDK is plain ESM.
import { createCdpClient } from '../sdk/cdpCollectSdk.mjs';

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300, json: async () => body }));
}

describe('CDP-G createCdpClient', () => {
  it('collect POSTs the event with bearer auth + JSON body', async () => {
    const f = mockFetch(201, { eventId: 'evt:1', hasSchema: false });
    const cdp = createCdpClient({ baseUrl: 'https://app.test/', token: 'owk_abc', fetchImpl: f });
    const r = await cdp.collect('signup', { orderId: 'o1' });
    expect(r.status).toBe(201);
    const [calledUrl, init] = (f as any).mock.calls[0];
    expect(calledUrl).toBe('https://app.test/v1/host/openwop-app/cdp/collect');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer owk_abc');
    expect(JSON.parse(init.body)).toEqual({ eventType: 'signup', payload: { orderId: 'o1' } });
  });

  it('collectBatch POSTs the events array to the batch endpoint', async () => {
    const f = mockFetch(200, { accepted: 2, rejected: 0, results: [] });
    const cdp = createCdpClient({ baseUrl: 'https://app.test', token: 'owk_abc', fetchImpl: f });
    const events = [{ eventType: 'signup', payload: { orderId: 'o1' } }, { eventType: 'view', payload: { p: 1 } }];
    const r = await cdp.collectBatch(events);
    expect(r.status).toBe(200);
    const [calledUrl, init] = (f as any).mock.calls[0];
    expect(calledUrl).toBe('https://app.test/v1/host/openwop-app/cdp/collect/batch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ events });
  });

  it('resolveIdentity returns the record, or null on a 404 miss', async () => {
    const hit = createCdpClient({ baseUrl: 'https://app.test', token: 't', fetchImpl: mockFetch(200, { contact: { contactId: 'crm:1' } }) });
    expect((await hit.resolveIdentity('email', 'a@x.test')).contact.contactId).toBe('crm:1');
    const miss = createCdpClient({ baseUrl: 'https://app.test', token: 't', fetchImpl: mockFetch(404, { error: 'not_found' }) });
    expect(await miss.resolveIdentity('email', 'none@x.test')).toBeNull();
  });

  it('requires a baseUrl', () => {
    expect(() => createCdpClient({})).toThrow(/baseUrl/);
  });
});
