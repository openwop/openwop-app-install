/**
 * ADR 0821 D1/D7 — the store's AI-credit packs:
 *   GET  …/billing/token-packs                  (the store read)
 *   POST …/billing/token-packs/:packKey/checkout (buy one by an OPAQUE key)
 *
 * Pins:
 *   - the read is gated like the bundle-store read: billing toggle on, the
 *     caller's own tenant (a member is served — it is not admin-class);
 *   - honest-when-unconfigured: no pack prices ⇒ `[]`; a pack with no display
 *     copy lists its credits with no `priceDisplay` (the UI offers no buy);
 *   - NO Stripe price id ever crosses the boundary (list OR checkout response);
 *   - display copy for a price that is not a configured pack is ignored;
 *   - checkout is a billing WRITE: an editor is refused 403 naming
 *     host:billing:manage, an admin is served (positive control);
 *   - the packKey resolves the RIGHT price server-side — proven by fulfilment:
 *     completing the session credits exactly that pack's tokens;
 *   - an unknown packKey, or a raw price id used as one, is the route's own 404.
 *
 * Authority legs use the ADR 0554 §P3 harness (see adr0821-ai-credit-meter-route).
 * Tracker: TST-BNC-3.
 *
 * Red when (wave 60 probes w60g4-pack-*): an unpriced pack gets a priceDisplay;
 * packs are not smallest-first; the checkout response echoes a price id; a raw
 * price id is accepted as a key; the session is opened on another pack's price;
 * an editor may buy; the read ignores the billing toggle.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { getBalance, processStripeEvent, tokenPackKey } from '../src/features/billing/billingService.js';

const B = '/host/openwop-app/billing';
const ADMIN = 'oidc:packs-admin';
const EDITOR = 'oidc:packs-editor';
const PACKS = { price_pack_small_secret: 1_000_000, price_pack_mid_secret: 5_000_000, price_pack_big_secret: 25_000_000 };
const DISPLAY = {
  price_pack_small_secret: { price: '$5' },
  price_pack_mid_secret: { price: '$20', label: 'Popular' },
  // big has NO display → listed, but unpriced.
  price_not_a_pack: { price: '$999' },
};
const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_BILLING_TOKENS_PER_CREDIT', 'OPENWOP_BILLING_TOKEN_PACK_PRICES', 'OPENWOP_BILLING_TOKEN_PACK_DISPLAY'];
const savedEnv: Record<string, string | undefined> = {};
let server: http.Server;
let BASE = '';
let WS = '';

async function login(subject: string, tenantId: string, sharedWorkspace = true): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
const get = (path: string, cookie: string) => fetch(`${BASE}${path}`, { headers: { cookie } });
const buy = (packKey: string, cookie: string) => fetch(`${BASE}${B}/token-packs/${encodeURIComponent(packKey)}/checkout`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
});
interface Pack { packKey: string; credits: number; tokens: number; priceDisplay?: { price?: string; label?: string } }
const packsOf = async (cookie: string): Promise<Pack[]> => ((await (await get(`${B}/token-packs`, cookie)).json()) as { packs: Pack[] }).packs;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_BILLING_TOKENS_PER_CREDIT = '1000';
  process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify(PACKS);
  process.env.OPENWOP_BILLING_TOKEN_PACK_DISPLAY = JSON.stringify(DISPLAY);
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('billing');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  const ws = await createWorkspace({ name: 'ADR 0821 D7 packs workspace', ownerSubject: 'oidc:packs-owner' });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
});

afterAll(async () => {
  for (const k of ENV_KEYS) { const v = savedEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('GET billing/token-packs', () => {
  it('lists every configured pack smallest first, in credits, with its display copy — a member is served', async () => {
    const res = await get(`${B}/token-packs`, await login(EDITOR, WS));
    expect(res.status).toBe(200);
    const { packs } = await res.json() as { packs: Pack[] };
    expect(packs.map((p) => p.credits)).toEqual([1000, 5000, 25000]);
    expect(packs.map((p) => p.tokens)).toEqual([1_000_000, 5_000_000, 25_000_000]);
    expect(packs[0]!.priceDisplay).toEqual({ price: '$5' });
    expect(packs[1]!.priceDisplay).toEqual({ price: '$20', label: 'Popular' });
    // Honest-when-unconfigured: the big pack has no display ⇒ no priceDisplay at all.
    expect(packs[2]!.priceDisplay).toBeUndefined();
    // Display for a non-pack price is ignored (never a fourth, phantom pack).
    expect(packs).toHaveLength(3);
  });

  it('carries NO Stripe price id — only opaque pack keys', async () => {
    const res = await get(`${B}/token-packs`, await login(ADMIN, WS));
    const text = await res.text();
    expect(text).not.toContain('price_');
    const { packs } = JSON.parse(text) as { packs: Pack[] };
    for (const p of packs) expect(p.packKey).toMatch(/^pack_[0-9a-f]{16}$/);
    expect(new Set(packs.map((p) => p.packKey)).size).toBe(3);
  });

  it('no pack configured ⇒ []', async () => {
    const saved = process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES;
    delete process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES;
    try {
      expect(await packsOf(await login(ADMIN, WS))).toEqual([]);
    } finally {
      process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = saved;
    }
  });

  it('billing toggle off ⇒ the read is refused (positive control: on ⇒ 200, above)', async () => {
    const d = getToggleDefault('billing');
    if (!d) throw new Error('billing toggle default must exist');
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      const res = await get(`${B}/token-packs`, await login(ADMIN, WS));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: 'not_found', message: 'Billing is not enabled for this tenant.' });
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('POST billing/token-packs/:packKey/checkout', () => {
  it('refuses an EDITOR with a 403 naming host:billing:manage', async () => {
    const res = await buy(tokenPackKey('price_pack_small_secret'), await login(EDITOR, WS));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('host:billing:manage');
  });

  it('serves an ADMIN; the packKey resolves the RIGHT price — completing the session credits exactly that pack', async () => {
    const cookie = await login(ADMIN, WS);
    const mid = (await packsOf(cookie)).find((p) => p.credits === 5000)!;
    const res = await buy(mid.packKey, cookie);
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text, 'the store named a pack, so no price id is echoed').not.toContain('price_');
    const session = JSON.parse(text) as { sessionId: string; url: string; mode: string };
    expect(session.mode).toBe('demo');
    const before = (await getBalance(WS)).totalAvailable;
    await processStripeEvent(WS, { id: 'evt_d7_mid', type: 'checkout.session.completed', data: { object: { id: session.sessionId, object: 'checkout.session', customer: null, payment_status: 'paid' } } });
    expect((await getBalance(WS)).totalAvailable - before).toBe(5_000_000);
  });

  it('an unknown packKey is a 404 (and a raw price id is NOT accepted as a key)', async () => {
    const cookie = await login(ADMIN, WS);
    for (const key of ['pack_0000000000000000', 'price_pack_small_secret']) {
      const res = await buy(key, cookie);
      expect(res.status, key).toBe(404);
      expect(await res.json(), key).toMatchObject({ error: 'not_found', message: 'This credit pack is not for sale.' });
    }
  });
});
