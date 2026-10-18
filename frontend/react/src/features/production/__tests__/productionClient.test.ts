/**
 * ADR 0172 — productionClient: asserts each call hits its org-scoped endpoint
 * with the right method, maps the response envelope, and throws the server
 * message on a non-ok response.
 *
 * w32 (grade-tests): the fetch stub returns a REAL `Response` (it used to be an
 * `as unknown as Response` object whose `json()` resolved even for a 204, so
 * "tolerates a 204" passed with a client that parsed the empty body), and every
 * call's URL + method is asserted — createVendor, deleteVendor and listPlans
 * URLs were not.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listVendors, createVendor, deleteVendor, listPlans, setPlanStatus } from '../productionClient.js';

function stub(handler: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown }) {
  const spy = vi.fn(async (u: string, init?: RequestInit): Promise<Response> => {
    const r = handler(String(u), init);
    const status = r.status ?? (r.ok ? 200 : 400);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The [url, method] of the n-th fetch (GET when no method is set). */
function call(spy: ReturnType<typeof stub>, n = 0): { url: string; method: string; body?: string } {
  const [u, init] = spy.mock.calls[n]!;
  return { url: String(u), method: init?.method ?? 'GET', ...(init?.body !== undefined ? { body: String(init.body) } : {}) };
}

const ORG = /\/host\/openwop-app\/production\/orgs\/org1/;
const endsWith = (suffix: string): RegExp => new RegExp(`${ORG.source}${suffix.replace(/\//g, '\\/')}$`);

afterEach(() => { vi.unstubAllGlobals(); });

describe('productionClient', () => {
  it('listVendors hits the org-scoped vendors endpoint and unwraps { vendors }', async () => {
    const spy = stub(() => ({ ok: true, body: { vendors: [{ vendorId: 'v1', name: 'A' }] } }));
    const out = await listVendors('org1');
    expect(call(spy).url).toMatch(endsWith('/vendors'));
    expect(call(spy).method).toBe('GET');
    expect(out).toEqual([{ vendorId: 'v1', name: 'A' }]);
  });

  it('createVendor POSTs the input and returns the vendor', async () => {
    const spy = stub(() => ({ ok: true, status: 201, body: { vendorId: 'v2', name: 'B', type: 'agency' } }));
    const out = await createVendor('org1', { type: 'agency', name: 'B' });
    const c = call(spy);
    expect(c.url).toMatch(endsWith('/vendors'));
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ type: 'agency', name: 'B' });
    expect(out.vendorId).toBe('v2');
  });

  it('deleteVendor tolerates a 204 (no body)', async () => {
    const spy = stub(() => ({ ok: true, status: 204, body: undefined }));
    await expect(deleteVendor('org1', 'v1')).resolves.toBeUndefined();
    expect(call(spy).url).toMatch(endsWith('/vendors/v1'));
    expect(call(spy).method).toBe('DELETE');
  });

  it('deleteVendor surfaces the server message on a non-ok response', async () => {
    stub(() => ({ ok: false, status: 404, body: { message: 'Vendor not found.' } }));
    await expect(deleteVendor('org1', 'v1')).rejects.toThrow('Vendor not found.');
  });

  it('listPlans unwraps { plans }', async () => {
    const spy = stub(() => ({ ok: true, body: { plans: [{ planId: 'p1' }] } }));
    expect(await listPlans('org1')).toEqual([{ planId: 'p1' }]);
    expect(call(spy).url).toMatch(endsWith('/plans'));
    expect(call(spy).method).toBe('GET');
  });

  it('setPlanStatus POSTs the status to the plan status route', async () => {
    const spy = stub(() => ({ ok: true, body: { planId: 'p1', status: 'approved' } }));
    const out = await setPlanStatus('org1', 'p1', 'approved');
    const c = call(spy);
    expect(c.url).toMatch(endsWith('/plans/p1/status'));
    expect(c.method).toBe('POST');
    expect(JSON.parse(c.body!)).toEqual({ status: 'approved' });
    expect(out.status).toBe('approved');
  });

  it('throws the server message on a non-ok response', async () => {
    stub(() => ({ ok: false, status: 400, body: { message: 'companyId does not reference a company in this org.' } }));
    await expect(createVendor('org1', { type: 'contractor', name: 'X', companyId: 'nope' })).rejects.toThrow(/companyId/);
  });
});
