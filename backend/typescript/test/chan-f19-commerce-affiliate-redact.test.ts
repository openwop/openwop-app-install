/**
 * CHAN-F19 #5 (ADR 0464 §9) — a commerce affiliate is an external person (name,
 * referral code, commission). They are not a workspace principal, so no subject
 * key reaches them through `eraseSubject`; their DSAR is the operator's redact
 * route, `POST …/commerce/orgs/:orgId/affiliates/:affiliateId/redact` (user
 * decision 2026-11-14).
 *
 * Through the real HTTP boundary (createApp + cookie sessions) this pins:
 *  - an org manager's redact sets the name to `[erased]` and keeps the code, the
 *    rates and the accrued ledger balance (money records), and the payout export
 *    shows the placeholder; a second redact changes nothing;
 *  - a member without `host:org:manage` gets 403, and the name is unchanged;
 *  - a manager of workspace A who posts workspace B's REAL affiliate id gets 404
 *    (ids are global, so this is the IDOR case), and B's name is unchanged.
 */
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { Affiliate } from '../src/features/commerce/affiliate.js';
import type { Order, Product } from '../src/features/commerce/commerceService.js';

let BASE: string; let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (a === null || typeof a === 'string') throw new Error('server is not listening on a TCP port');
      BASE = `http://127.0.0.1:${a.port}`; res();
    });
  });
  for (const id of ['users', 'commerce']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface ErrBody { error?: string; message?: string }
interface Res<T> { status: number; body: T; text: string }
function client() {
  let cookie = '';
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]; }
    const text = await res.text();
    let out: T;
    try { out = JSON.parse(text || 'null'); } catch { out = JSON.parse('null'); }
    return { status: res.status, body: out, text };
  };
  return { get: <T = ErrBody>(p: string) => call<T>('GET', p), post: <T = ErrBody>(p: string, b?: unknown) => call<T>('POST', p, b) };
}
type Client = ReturnType<typeof client>;
let n = 0;
/** A workspace whose owner holds `host:org:manage`, plus an `editor` member who does not. */
async function workspace(): Promise<{ owner: Client; editor: Client; orgId: string }> {
  const tenantId = `org:f19-aff-${Date.now()}-${n++}`;
  const owner = client(); await owner.post('/host/openwop-app/test/login', { email: `aff-${Date.now()}-${n++}@acme.test`, tenantId });
  const editor = client(); const er = await editor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `aff-${Date.now()}-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Shop' })).body.orgId;
  await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: er.body.user.userId, roles: ['editor'] });
  return { owner, editor, orgId };
}
const c = (orgId: string, suffix: string) => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${suffix}`;
const affiliateNamed = async (w: { owner: Client; orgId: string }, id: string): Promise<Affiliate | undefined> =>
  (await w.owner.get<{ affiliates: Affiliate[] }>(c(w.orgId, '/affiliates'))).body.affiliates.find((a) => a.affiliateId === id);

describe('CHAN-F19 #5 — an affiliate\'s DSAR is the operator redact', () => {
  it('erases the name and keeps the code, rates and accrued balance', async () => {
    const w = await workspace();
    const aff = await w.owner.post<Affiliate>(c(w.orgId, '/affiliates'), { code: 'MARIA10', name: 'Maria Souza', commissionType: 'percentage', commissionRate: 10 });
    expect(aff.status).toBe(201);
    const id = aff.body.affiliateId;
    const prod = await w.owner.post<Product>(c(w.orgId, '/products'), { type: 'service', name: 'Course', price: 200 });
    const order = await w.owner.post<Order>(c(w.orgId, '/orders'), { lines: [{ productId: prod.body.productId, quantity: 1 }], affiliateCode: 'maria10' });
    await w.owner.post(c(w.orgId, `/orders/${order.body.orderId}/pay`), { paymentIntentId: 'pi_f19' });
    expect((await affiliateNamed(w, id))?.balanceOwed).toBe(20);

    const r = await w.owner.post<Affiliate>(c(w.orgId, `/affiliates/${encodeURIComponent(id)}/redact`));
    expect(r.status, r.text).toBe(200);
    expect(r.body.name).toBe('[erased]');
    const after = await affiliateNamed(w, id);
    expect(after).toMatchObject({ name: '[erased]', code: 'MARIA10', commissionType: 'percentage', commissionRate: 10, balanceOwed: 20 });
    const csv = (await w.owner.get(c(w.orgId, '/affiliates/payouts.csv'))).text;
    expect(csv).toContain('"MARIA10","[erased]"');
    expect(csv).not.toContain('Maria Souza');

    const again = await w.owner.post<Affiliate>(c(w.orgId, `/affiliates/${encodeURIComponent(id)}/redact`));
    expect(again.status).toBe(200);
    expect(again.body.updatedAt, 'a repeat redact writes nothing').toBe(r.body.updatedAt);
  });

  it('refuses a member without host:org:manage, and the name is unchanged', async () => {
    const w = await workspace();
    const id = (await w.owner.post<Affiliate>(c(w.orgId, '/affiliates'), { code: 'ANA5', name: 'Ana Lima', commissionType: 'fixed', commissionRate: 5 })).body.affiliateId;
    const r = await w.editor.post(c(w.orgId, `/affiliates/${encodeURIComponent(id)}/redact`));
    expect(r.status, r.text).toBe(403);
    expect((await affiliateNamed(w, id))?.name).toBe('Ana Lima');
  });

  it('a manager of another workspace gets 404 for a real affiliate id, and it is unchanged', async () => {
    const a = await workspace();
    const b = await workspace();
    const bId = (await b.owner.post<Affiliate>(c(b.orgId, '/affiliates'), { code: 'JOAO7', name: 'João Pereira', commissionType: 'percentage', commissionRate: 7 })).body.affiliateId;
    const r = await a.owner.post(c(a.orgId, `/affiliates/${encodeURIComponent(bId)}/redact`));
    expect(r.status, r.text).toBe(404);
    expect(r.text).not.toContain('João');
    expect((await affiliateNamed(b, bId))?.name).toBe('João Pereira');
  });
});
