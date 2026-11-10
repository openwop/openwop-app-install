/**
 * ADR 1034 — territories, dealers and sales-maps integrity (feature loop row 75).
 *
 *  - D9  partner tokens: plaintext at rest, no expiry, no revoke, alive for a suspended
 *        dealer, minted at workspace:write. Now: sha256 at rest, 180-day expiry, revoke,
 *        suspended ⇒ uniform 404, manager-only mint; legacy rows re-keyed by a migration
 *        that two instances can run at once.
 *  - D1  the territory transition card is find-or-create, race-safe, transition-matched.
 *  - D5  every attainment-feeding write on the ACTIVE model is a manager write.
 *  - D11 the geocode cache key is length-prefixed (tenant ids contain `:`).
 *
 * Red when: the raw token is stored; a stored hash works as a link; an expired, revoked
 * or suspended-dealer link answers; an editor can mint; the migration leaves a plaintext
 * row or double-writes under concurrency; two concurrent transition submits mint two
 * cards; an activate submit is handed a pending archive card; an editor writes a quota,
 * territory or rule on the active model; two tenant/org splits share a geocode key.
 *
 * grade-tests w88: the refusals now assert the denial body, not only the status.
 * The editor's rule create and delete on the ACTIVE model are in the D5 list. The entity
 * would refuse those writes too (409 "rules can only be edited on a planning model"),
 * so the case asserts 403 plus `requiredScope`, which only the route's
 * `authorizeModelWrite` answers. The geocode key is checked against a `|` split as well
 * as a `:` split, so dropping the length prefix is caught. The two concurrency claims
 * (the token re-key and the transition card) are witnessed by sabotage probes against
 * the in-memory store, where both callers list before either writes. They are not
 * forced races.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { hashPartnerToken, rekeyLegacyPartnerTokens, resolvePartnerToken } from '../src/features/dealers/entities/registration.js';
import { createTerritoryTransitionApproval, getApproval, resolveApproval } from '../src/host/approvalService.js';
import { cacheKey, getCachedGeocode, rekeyLegacyGeocodes } from '../src/features/sales-maps/entities/geocode.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'dealers', 'territories', 'sales-maps']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Body {
  user?: { userId: string }; orgId?: string; companyId?: string; dealerId?: string; modelId?: string; territoryId?: string; ruleId?: string;
  token?: string; url?: string; expiresAt?: string; error?: string; message?: string; details?: Record<string, unknown>;
  review?: { approvalId: string };
}
interface Res { status: number; body: Body }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(withCookie = true): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (withCookie) for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function scenario(): Promise<{ owner: Client; editor: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:adr1034t-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const editor = client();
  const editorId = (await editor.post('/host/openwop-app/test/login', { email: `e-${Date.now()}-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId ?? '';
  await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorId, roles: ['editor'] });
  return { owner, editor, orgId, tenantId };
}
const D = (orgId: string): string => `/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;
const T = (orgId: string): string => `/host/openwop-app/territories/orgs/${encodeURIComponent(orgId)}`;
const partner = client(false);

async function dealer(owner: Client, orgId: string): Promise<string> {
  const companyId = (await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: `Co ${n++}` })).body.companyId;
  return (await owner.post(`${D(orgId)}/dealers`, { name: `Dealer ${n++}`, companyId })).body.dealerId ?? '';
}

describe('D9 — partner tokens', () => {
  it('stores only a hash, answers the raw link, and never the stored value', async () => {
    const { owner, editor, orgId } = await scenario();
    const dealerId = await dealer(owner, orgId);
    // Minting is a manager act now.
    const denied = await editor.post(`${D(orgId)}/dealers/${dealerId}/portal-token`);
    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({ requiredScope: 'host:dealers:manage' });
    const minted = await owner.post(`${D(orgId)}/dealers/${dealerId}/portal-token`);
    expect(minted.status).toBe(201);
    const raw = minted.body.token ?? '';
    expect(Date.parse(minted.body.expiresAt ?? '') - Date.now()).toBeGreaterThan(179 * 24 * 3600 * 1000);
    // Nothing at rest holds the raw token — not as a key, not inside a value.
    const rows = await hostExtStorage().kvList('hostext:dealers:partner-token:');
    expect(rows.some((r) => r.key.includes(raw) || r.value.includes(raw))).toBe(false);
    expect(rows.some((r) => r.key.endsWith(hashPartnerToken(raw)))).toBe(true);
    expect((await partner.get(`/host/openwop-app/partner/${raw}`)).status).toBe(200);
    // A leaked stored value is not a working link.
    expect((await partner.get(`/host/openwop-app/partner/${hashPartnerToken(raw)}`)).status).toBe(404);
  });

  it('a suspended dealer’s link is dead (both routes, uniform 404), and comes back on reactivation', async () => {
    const { owner, orgId } = await scenario();
    const dealerId = await dealer(owner, orgId);
    const raw = (await owner.post(`${D(orgId)}/dealers/${dealerId}/portal-token`)).body.token ?? '';
    expect((await owner.patch(`${D(orgId)}/dealers/${dealerId}`, { status: 'suspended' })).status).toBe(200);
    const view = await partner.get(`/host/openwop-app/partner/${raw}`);
    expect(view.status).toBe(404);
    expect(view.body.message).toBe('Invalid partner link.');
    const reg = await partner.post(`/host/openwop-app/partner/${raw}/register`, { dealTitle: 'X', companyName: 'Y' });
    expect([reg.status, reg.body.message]).toEqual([404, 'Invalid partner link.']);
    expect((await owner.patch(`${D(orgId)}/dealers/${dealerId}`, { status: 'active' })).status).toBe(200);
    expect((await partner.get(`/host/openwop-app/partner/${raw}`)).status).toBe(200);
  });

  it('revoke kills the link; the route is manager-only and idempotent', async () => {
    const { owner, editor, orgId } = await scenario();
    const dealerId = await dealer(owner, orgId);
    const raw = (await owner.post(`${D(orgId)}/dealers/${dealerId}/portal-token`)).body.token ?? '';
    const refused = await editor.del(`${D(orgId)}/dealers/${dealerId}/portal-token`);
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({ requiredScope: 'host:dealers:manage' });
    expect((await partner.get(`/host/openwop-app/partner/${raw}`)).status).toBe(200);
    expect((await owner.del(`${D(orgId)}/dealers/${dealerId}/portal-token`)).status).toBe(204);
    expect((await partner.get(`/host/openwop-app/partner/${raw}`)).status).toBe(404);
    expect((await owner.del(`${D(orgId)}/dealers/${dealerId}/portal-token`)).status).toBe(204);
  });

  it('the migration re-keys legacy plaintext rows with an expiry, converging under two concurrent runs', async () => {
    const { owner, orgId, tenantId } = await scenario();
    const dealerId = await dealer(owner, orgId);
    const storage = hostExtStorage();
    const fresh = `ptoken:legacy-fresh-${n++}`;
    const stale = `ptoken:legacy-stale-${n++}`;
    const noDate = `ptoken:legacy-nodate-${n++}`;
    const legacy = (token: string, createdAt: string) => JSON.stringify({ token, tenantId, orgId, dealerId, createdAt });
    await storage.kvSet(`hostext:dealers:partner-token:${fresh}`, legacy(fresh, new Date().toISOString()));
    await storage.kvSet(`hostext:dealers:partner-token:${stale}`, legacy(stale, '2020-01-01T00:00:00.000Z'));
    await storage.kvSet(`hostext:dealers:partner-token:${noDate}`, legacy(noDate, 'not a date'));
    const before = Date.now();
    const [a, b] = await Promise.all([rekeyLegacyPartnerTokens(), rekeyLegacyPartnerTokens()]);
    const after = Date.now();
    expect(a + b).toBe(3); // each row re-keyed exactly once across the two runs…
    expect(await rekeyLegacyPartnerTokens()).toBe(0); // …and a re-run is a no-op
    for (const raw of [fresh, stale, noDate]) {
      expect(await storage.kvGet(`hostext:dealers:partner-token:${raw}`)).toBeNull(); // no plaintext left
    }
    // The fresh row keeps working through the same link; the stale one has expired
    // (createdAt + 180 d is in 2020); the dateless one took the migration's own time.
    expect((await resolvePartnerToken(fresh)).dealerId).toBe(dealerId);
    await expect(resolvePartnerToken(stale)).rejects.toMatchObject({ code: 'not_found' });
    const TTL = 180 * 24 * 3600 * 1000;
    const noDateExpiry = Date.parse((await resolvePartnerToken(noDate)).expiresAt ?? '');
    expect(noDateExpiry).toBeGreaterThanOrEqual(before + TTL);
    expect(noDateExpiry).toBeLessThanOrEqual(after + TTL);
  });
});

describe('D1 — the territory transition card is race-safe and transition-matched', () => {
  it('concurrent submits share one card; a pending archive card is never handed back as an activation', async () => {
    const { owner, orgId, tenantId } = await scenario();
    const modelId = (await owner.post(`${T(orgId)}/models`, { name: 'M' })).body.modelId ?? '';
    const make = (transition: 'activate' | 'archive') => createTerritoryTransitionApproval({ tenantId, orgId, modelId, transition, proposal: transition });
    const [x, y] = await Promise.all([make('archive'), make('archive')]);
    expect(x.approvalId).toBe(y.approvalId);
    await expect(make('activate')).rejects.toMatchObject({ code: 'conflict' });
    // The HTTP route takes the same rule.
    const http409 = await owner.post(`${T(orgId)}/models/${modelId}/activate`);
    expect(http409.status).toBe(409);
    expect(http409.body.message).toMatch(/already has a pending archive review/);
    expect((await getApproval(x.approvalId))?.territoryTransition?.transition).toBe('archive');
  });

  it('a decided card the listing lost is never handed back as the new review (grade-code H3)', async () => {
    const { owner, orgId, tenantId } = await scenario();
    const modelId = (await owner.post(`${T(orgId)}/models`, { name: 'M' })).body.modelId ?? '';
    const first = await createTerritoryTransitionApproval({ tenantId, orgId, modelId, transition: 'activate', proposal: 'p' });
    await resolveApproval(first.approvalId, { status: 'rejected', note: 'no' });
    // Lose its index rows: the listing no longer sees the decided card.
    const storage = hostExtStorage();
    for (const r of await storage.kvList('hostext:approval:by-tenant-status:')) if (r.key.endsWith(first.approvalId)) await storage.kvDelete(r.key);
    const again = await createTerritoryTransitionApproval({ tenantId, orgId, modelId, transition: 'activate', proposal: 'p' });
    expect(again.status).toBe('pending');
    expect(again.approvalId).not.toBe(first.approvalId);
    expect((await getApproval(first.approvalId))?.status).toBe('rejected'); // not resurrected
  });
});

describe('D5 — attainment-feeding writes on the ACTIVE model are manager writes', () => {
  it('an editor may shape a planning model, not the active one', async () => {
    const { owner, editor, orgId } = await scenario();
    const modelId = (await owner.post(`${T(orgId)}/models`, { name: 'M' })).body.modelId ?? '';
    // Planning model: the editor may add a territory, a rule and a quota.
    const terr = await editor.post(`${T(orgId)}/models/${modelId}/territories`, { name: 'West' });
    expect(terr.status).toBe(201);
    const territoryId = terr.body.territoryId ?? '';
    expect((await editor.put(`${T(orgId)}/models/${modelId}/territories/${territoryId}/quota`, { period: '2026-Q1', amount: 100, currency: 'USD' })).status).toBe(200);
    const RULE = { target: 'deal', territoryId, filter: { field: 'amount', op: 'gt', value: 7000 } };
    const rule = await editor.post(`${T(orgId)}/models/${modelId}/rules`, RULE);
    expect(rule.status).toBe(201);
    const ruleId = rule.body.ruleId ?? '';
    // Activate through the review.
    const review = (await owner.post(`${T(orgId)}/models/${modelId}/activate`)).body.review?.approvalId ?? '';
    expect((await owner.post(`/host/openwop-app/reviews/approval:${review}/actions/approve`)).status).toBe(200);
    // Active model: every write that moves attainment is refused to the editor, naming the scope.
    const writes = [
      editor.put(`${T(orgId)}/models/${modelId}/territories/${territoryId}/quota`, { period: '2026-Q1', amount: 1, currency: 'USD' }),
      editor.post(`${T(orgId)}/models/${modelId}/territories`, { name: 'East' }),
      editor.patch(`${T(orgId)}/models/${modelId}/territories/${territoryId}`, { name: 'West 2' }),
      editor.del(`${T(orgId)}/models/${modelId}/territories/${territoryId}/quota?period=2026-Q1`),
      editor.post(`${T(orgId)}/models/${modelId}/rules`, RULE),
      editor.del(`${T(orgId)}/models/${modelId}/rules/${encodeURIComponent(ruleId)}`),
    ];
    for (const w of await Promise.all(writes)) {
      expect(w.status).toBe(403);
      expect(w.body.details).toMatchObject({ requiredScope: 'host:territories:manage' });
    }
    // The owner still can.
    expect((await owner.put(`${T(orgId)}/models/${modelId}/territories/${territoryId}/quota`, { period: '2026-Q1', amount: 1, currency: 'USD' })).status).toBe(200);
  });
});

describe('D11 — the geocode cache key is unambiguous', () => {
  it('a tenant/org split across `:` no longer shares a key, and legacy rows are re-keyed', async () => {
    expect(cacheKey('org:a', 'b', '1 Main St')).not.toBe(cacheKey('org', 'a:b', '1 Main St'));
    expect(cacheKey('a|b', 'c', '1 Main St')).not.toBe(cacheKey('a', 'b|c', '1 Main St')); // the separator alone is not enough
    const storage = hostExtStorage();
    const tenantId = `org:geo-${n++}`;
    const legacyKey = `${tenantId}:o1:1 main st`;
    await storage.kvSet(`hostext:sales-maps:geocode:${legacyKey}`, JSON.stringify({ cacheKey: legacyKey, tenantId, orgId: 'o1', address: '1 Main St', lat: 1, lng: 2, source: 'manual', at: new Date().toISOString() }));
    expect(await getCachedGeocode(tenantId, 'o1', '1 Main St')).toBeNull(); // unreachable under the new key…
    const [a, b] = await Promise.all([rekeyLegacyGeocodes(), rekeyLegacyGeocodes()]);
    expect(a + b).toBe(1);
    expect(await getCachedGeocode(tenantId, 'o1', '1 Main St')).toMatchObject({ lat: 1, lng: 2 }); // …until the migration runs
    expect(await storage.kvGet(`hostext:sales-maps:geocode:${legacyKey}`)).toBeNull();
  });
});
