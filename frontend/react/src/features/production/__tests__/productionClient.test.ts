/**
 * ADR 0172 — productionClient: asserts each call hits its org-scoped endpoint,
 * maps the response envelope, and throws the server message on a non-ok response.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { listVendors, createVendor, deleteVendor, listPlans, setPlanStatus } from '../productionClient.js';

function stub(handler: (url: string, init?: RequestInit) => { ok: boolean; status?: number; body: unknown }): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (u: string, init?: RequestInit) => {
    const r = handler(String(u), init);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('productionClient', () => {
  it('listVendors hits the org-scoped vendors endpoint and unwraps { vendors }', async () => {
    const spy = stub(() => ({ ok: true, body: { vendors: [{ vendorId: 'v1', name: 'A' }] } }));
    const out = await listVendors('org1');
    expect(String(spy.mock.calls[0]![0])).toMatch(/\/production\/orgs\/org1\/vendors$/);
    expect(out).toEqual([{ vendorId: 'v1', name: 'A' }]);
  });

  it('createVendor POSTs the input and returns the vendor', async () => {
    const spy = stub(() => ({ ok: true, body: { vendorId: 'v2', name: 'B', type: 'agency' } }));
    const out = await createVendor('org1', { type: 'agency', name: 'B' });
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 'agency', name: 'B' });
    expect(out.vendorId).toBe('v2');
  });

  it('deleteVendor tolerates a 204 (no body)', async () => {
    stub(() => ({ ok: true, status: 204, body: undefined }));
    await expect(deleteVendor('org1', 'v1')).resolves.toBeUndefined();
  });

  it('listPlans unwraps { plans }', async () => {
    stub(() => ({ ok: true, body: { plans: [{ planId: 'p1' }] } }));
    expect(await listPlans('org1')).toEqual([{ planId: 'p1' }]);
  });

  it('setPlanStatus POSTs the status to the plan status route', async () => {
    const spy = stub(() => ({ ok: true, body: { planId: 'p1', status: 'approved' } }));
    const out = await setPlanStatus('org1', 'p1', 'approved');
    expect(String(spy.mock.calls[0]![0])).toMatch(/\/production\/orgs\/org1\/plans\/p1\/status$/);
    expect(JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body))).toEqual({ status: 'approved' });
    expect(out.status).toBe('approved');
  });

  it('throws the server message on a non-ok response', async () => {
    stub(() => ({ ok: false, status: 400, body: { message: 'companyId does not reference a company in this org.' } }));
    await expect(createVendor('org1', { type: 'contractor', name: 'X', companyId: 'nope' })).rejects.toThrow(/companyId/);
  });
});
