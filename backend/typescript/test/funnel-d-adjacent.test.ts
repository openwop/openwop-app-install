/**
 * ADR 0297 (Funnel D) — the three IN builds:
 *  D1 pixels + conversions relay: consented visitors get the org's pixel list,
 *     unconsented get an EMPTY list (no config oracle); the relay hashes the
 *     email server-side (raw never stored), dedups by eventId, and rows stay
 *     honestly QUEUED until a transport delivers (injectable; none wired v1);
 *  D2 affiliate growth: a public-checkout `ref` attributes ONLY a real
 *     affiliate code (junk silently dropped — no validation oracle), the
 *     commission accrues at paid, and the payout CSV exports the ledger;
 *  D3 lead scoring: explainable compute-on-read from identity-linked funnel
 *     events + paid orders, with visible fixed weights.
 *
 * TST-DEB-1 — red when: the public pixel list ignores a missing `vk`, the relay
 * stops deduping by eventId or stores the raw email, a retry re-fires an
 * already-delivered platform, a junk `ref` is stamped, the commission basis or
 * rate maths changes by a cent, or a lead-score part/weight moves (each
 * sabotage-witnessed, wave 70). Amounts are cent-sensitive on purpose:
 * 19.99 × 7.5% = 149.925 minor units → 149 (floor) = 1.49, so a dropped,
 * rounded or doubled cent changes the asserted value.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { dispatchQueuedConversions, listConversions, upsertPixel, __resetPixels, type ConversionEvent, type PixelPlatform } from '../src/features/campaign-connectors/pixelService.js';
import { getOrder, markAsPaid } from '../src/features/commerce/commerceService.js';
import { listAffiliates } from '../src/features/commerce/affiliate.js';
import { linkSession } from '../src/features/analytics/identityLinkService.js';
import { collectEvent } from '../src/features/cdp/collectService.js';
import { computeLeadScore } from '../src/features/crm/leadScoreService.js';
import { createContact } from '../src/features/crm/contactsService.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'commerce', 'crm', 'cdp', 'campaign-connectors']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface RawRes { status: number; text: string }
function client() {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return res;
  };
  const json = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await send(method, path, body);
    return { status: res.status, body: (await res.json()) as T };
  };
  return {
    get: <T>(p: string) => json<T>('GET', p),
    getRaw: async (p: string): Promise<RawRes> => { const res = await send('GET', p); return { status: res.status, text: await res.text() }; },
    post: <T>(p: string, b?: unknown) => json<T>('POST', p, b),
  };
}
interface Pixels { pixels: Array<{ platform: string; pixelId: string }> }
interface Relay { recorded?: boolean; deduped?: boolean }
interface Created { productId: string }
interface Checkout { orderId: string }

async function shop() {
  const owner = client();
  const login = await owner.post<{ user?: { tenantId: string } }>('/host/openwop-app/test/login', { email: `fd-${Date.now()}-${n++}@acme.test` });
  const tenantId = login.body.user?.tenantId ?? '';
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Adjacent Co' });
  const orgId = org.body.orgId;
  expect(tenantId).not.toBe('');
  return { owner, tenantId, orgId };
}

describe('D1 — pixels + conversions relay', () => {
  it('consented visitors see pixels; unconsented see an empty list; relay hashes + dedups; queued until a transport delivers', async () => {
    await __resetPixels();
    const { tenantId, orgId } = await shop();
    await upsertPixel(tenantId, orgId, { platform: 'meta', pixelId: 'px-123' });
    const v = client();

    // consent toggle off ⇒ isAllowed permissive — a vk-carrying visitor is "consented"
    const consented = await v.get<Pixels>(`/host/openwop-app/public/${encodeURIComponent(orgId)}/pixels?vk=vis-1`);
    expect(consented.body.pixels).toEqual([{ platform: 'meta', pixelId: 'px-123' }]);
    // no vk ⇒ empty (and indistinguishable from none-configured)
    const anon = await v.get<Pixels>(`/host/openwop-app/public/${encodeURIComponent(orgId)}/pixels`);
    expect(anon.body.pixels).toEqual([]);

    // relay: hashed identifier, dedup by eventId, honest 202
    const first = await v.post<Relay>(`/host/openwop-app/public/${encodeURIComponent(orgId)}/conversions`, {
      vk: 'vis-1', eventId: 'evt-1', eventName: 'purchase', email: '  Buyer@X.Test ', value: 120, currency: 'usd',
    });
    expect(first.status).toBe(202);
    expect(first.body.recorded).toBe(true);
    const dup = await v.post<Relay>(`/host/openwop-app/public/${encodeURIComponent(orgId)}/conversions`, { vk: 'vis-1', eventId: 'evt-1', eventName: 'purchase' });
    expect(dup.status).toBe(202);
    expect(dup.body.deduped).toBe(true);

    const rows = await listConversions(tenantId, orgId);
    expect(rows).toHaveLength(1);
    // sha256('buyer@x.test') — pinned as a literal, never computed by hashEmail.
    expect(rows[0].emailHash).toBe('7a35f90e264bf3164414cce1b7ecee2c345f3d7911fa6c14a71f4f9e2575a116');
    expect(JSON.stringify(rows[0])).not.toContain('x.test'); // the raw address never persists
    expect(rows[0].status).toBe('queued');

    // no transport wired ⇒ stays queued (honest); an injected transport delivers
    expect(await dispatchQueuedConversions(tenantId, orgId, null)).toBe(0);
    const delivered: Array<{ platform: PixelPlatform; eventId: string }> = [];
    const sent = await dispatchQueuedConversions(tenantId, orgId, async (platform: PixelPlatform, e: ConversionEvent) => { delivered.push({ platform, eventId: e.eventId }); });
    expect(sent).toBe(1);
    expect(delivered).toEqual([{ platform: 'meta', eventId: 'evt-1' }]);
    expect((await listConversions(tenantId, orgId))[0].status).toBe('sent');

    // GC-D1-1 — a partial delivery resumes without double-firing: add a second
    // platform, queue an event, fail tiktok once, then retry — meta must be
    // delivered exactly once across the two attempts.
    await upsertPixel(tenantId, orgId, { platform: 'tiktok', pixelId: 'tk-9' });
    await v.post(`/host/openwop-app/public/${encodeURIComponent(orgId)}/conversions`, { vk: 'vis-1', eventId: 'evt-2', eventName: 'lead' });
    const attempts: string[] = [];
    const flaky = async (platform: PixelPlatform, e: ConversionEvent): Promise<void> => {
      attempts.push(`${platform}:${e.eventId}`);
      if (platform === 'tiktok' && attempts.filter((a) => a.startsWith('tiktok')).length === 1) throw new Error('flap');
    };
    expect(await dispatchQueuedConversions(tenantId, orgId, flaky)).toBe(0); // meta ok, tiktok flapped ⇒ still queued
    expect(await dispatchQueuedConversions(tenantId, orgId, flaky)).toBe(1); // tiktok retried ⇒ sent
    expect(attempts.filter((a) => a === 'meta:evt-2').length).toBe(1); // never double-fired
  });
});

describe('D2 — affiliate ref capture + payout export', () => {
  it('attributes only a real code, accrues at paid, and exports the CSV ledger', async () => {
    const { owner, tenantId, orgId } = await shop();
    const c = (sfx: string): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${sfx}`;
    const prod = await owner.post<Created>(c('/products'), { type: 'digital', name: 'Guide', price: 19.99, currency: 'USD' });
    const aff = await owner.post(c('/affiliates'), { code: 'JANE10', name: 'Jane', commissionType: 'percentage', commissionRate: 7.5 });
    expect(aff.status).toBe(201);

    const guest = client();
    // junk ref: silently dropped (no oracle), order still succeeds
    const junk = await guest.post<Checkout>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`, {
      email: `j-${n++}@x.test`, lines: [{ productId: prod.body.productId, quantity: 1 }], ref: 'NOT-A-CODE',
    });
    expect(junk.status).toBe(201);
    expect((await getOrder(tenantId, orgId, junk.body.orderId))?.affiliateCode).toBeUndefined();

    // real ref attributes + accrues on paid
    const attributed = await guest.post<Checkout>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`, {
      email: `a-${n++}@x.test`, lines: [{ productId: prod.body.productId, quantity: 1 }], ref: 'jane10',
    });
    expect((await getOrder(tenantId, orgId, attributed.body.orderId))?.affiliateCode).toBe('JANE10');
    await markAsPaid(tenantId, orgId, attributed.body.orderId, 'pi_aff', { actor: 'test' });
    const jane = (await listAffiliates(tenantId, orgId)).find((a) => a.code === 'JANE10');
    expect(jane?.balanceOwed).toBe(1.49); // floor(1999 × 7.5 / 100) = 149 minor units

    const csv = await owner.getRaw(c('/affiliates/payouts.csv'));
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe('code,name,currency,balance_owed,pending_payouts');
    expect(csv.text.split('\n').slice(1)).toEqual(['"JANE10","Jane","USD",1.49,0']);
  });
});

describe('D3 — explainable lead score', () => {
  it('computes from identity-linked funnel events + paid orders with visible weights', async () => {
    const { owner, tenantId, orgId } = await shop();
    const contact = await createContact({ tenantId, name: 'Lead Lucy', email: `lucy-${n++}@x.test` });
    await linkSession(tenantId, 'lucy-session', contact.contactId, 'form-submit');

    // 2 views + 1 completion from her session; 1 unrelated visitor event
    await collectEvent(tenantId, 'funnel.step_viewed', { orgId, funnelId: 'f', stepId: 's', visitor: 'lucy-session' });
    await collectEvent(tenantId, 'funnel.step_viewed', { orgId, funnelId: 'f', stepId: 's', visitor: 'lucy-session' });
    await collectEvent(tenantId, 'funnel.step_completed', { orgId, funnelId: 'f', stepId: 's', visitor: 'lucy-session' });
    await collectEvent(tenantId, 'funnel.step_viewed', { orgId, funnelId: 'f', stepId: 's', visitor: 'someone-else' });

    // a paid order for her (org-scoped part)
    const c = (sfx: string): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}${sfx}`;
    const prod = await owner.post<Created>(c('/products'), { type: 'digital', name: 'Starter', price: 30, currency: 'USD' });
    const guest = client();
    const co = await guest.post<Checkout>(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/checkout`, {
      email: contact.email, lines: [{ productId: prod.body.productId, quantity: 1 }],
    });
    await markAsPaid(tenantId, orgId, co.body.orderId, 'pi_lucy', { actor: 'test' });

    const score = await computeLeadScore(tenantId, contact.contactId, orgId);
    expect(score.parts).toEqual({ linkedSessions: 1, funnelViews: 2, funnelCompletions: 1, paidOrders: 1 });
    expect(score.score).toBe(2 * 1 + 1 * 5 + 1 * 20);

    // the route serves it, tenant-guarded
    const viaRoute = await owner.get<{ score: number; weights: Record<string, number> }>(`/host/openwop-app/crm/contacts/${encodeURIComponent(contact.contactId)}/score?orgId=${encodeURIComponent(orgId)}`);
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body.score).toBe(score.score);
    expect(viaRoute.body.weights).toEqual({ view: 1, completion: 5, paidOrder: 20 });
  });
});
