/**
 * CONS-5 — the ONLY DSAR erasure route the product ships was gated behind a
 * toggle that defaults OFF.
 *
 * `authz()` composes `requireFeatureEnabled('consent')` with `requireOrgScope`,
 * and `consentFeature.toggleDefault.status` is `'off'`. So in the DEFAULT
 * posture `DELETE …/consent/orgs/:orgId/subjects/:subjectKey` answered 404 —
 * while every other feature kept writing subject PII regardless. Erasure is not
 * a product feature a tenant buys; it is an obligation over data that exists
 * whether or not they configured a consent regime.
 *
 * WHAT THIS DOES NOT DO, and the reason it must not. Flipping the toggle default
 * to `on` would ALSO flip `isAllowed` from the documented permissive posture
 * ("toggle off ⇒ permissive, honest opt-in") to fail-closed under the `opt-in`
 * default — every existing tenant would start DENYING analytics and marketing
 * for every subject with no record, silently breaking live sends. The last two
 * cases here pin that enforcement semantics are UNCHANGED, so a future "just
 * default it on" cannot land quietly.
 *
 * RBAC is unchanged: the same `workspace:read` / `workspace:write` scopes gate
 * both routes. Only the toggle came off.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { consentFeature } from '../src/features/consent/feature.js';
import { isAllowed, recordConsent, __resetConsentStore } from '../src/features/consent/consentService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('users');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) {
      const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!;
    }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `dsar-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const tenantId = su.body.user?.tenantId ?? su.body.tenantId ?? '';
  expect(tenantId, 'a blank tenant would make the enforcement assertions vacuous').toBeTruthy();
  return { owner, orgId: org.body.orgId, tenantId };
}

const setConsentToggle = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('consent');
  expect(d, 'the consent toggle must be declared for this suite to mean anything').toBeTruthy();
  await saveConfig({ ...d!, status }, 'test');
};

const ORG = (orgId: string): string => `/v1/host/openwop-app/consent/orgs/${orgId}`;

describe('CONS-5 — the DSAR lane is reachable in the DEFAULT posture', () => {
  it('the toggle default is still OFF (the premise — if this changes, read the enforcement cases below)', () => {
    expect(consentFeature.toggleDefault?.status).toBe('off');
  });

  it('with `consent` OFF: erase + subject-read WORK, while the regime routes 404', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await setConsentToggle('off');

    // THE finding: on `origin/main` this is a 404 — the only DSAR erasure route
    // the product ships, unreachable in the posture every tenant starts in.
    const del = await owner.del(`${ORG(orgId)}/subjects/some-subject`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.ok).toBe(true);

    // The look-up half rides the same lane: an erase that works beside a lookup
    // that 404s is a worse surface than either.
    const read = await owner.get(`${ORG(orgId)}/subjects/some-subject`);
    expect(read.status).toBe(200);

    // …and the consent REGIME — the product the toggle buys — stays gated.
    expect((await owner.get(`${ORG(orgId)}/policy`)).status).toBe(404);
    expect((await owner.get(`${ORG(orgId)}/records`)).status).toBe(404);
    expect((await owner.put(`${ORG(orgId)}/policy`, { defaultMode: 'opt-out' })).status).toBe(404);
    expect((await owner.get(`${ORG(orgId)}/purpose-vocab`)).status).toBe(404);
  });

  it('RBAC is UNCHANGED — a non-member is still refused', async () => {
    // Taking the toggle off the lane must not take the authorization off it.
    const { orgId } = await ownerWithOrg();
    await setConsentToggle('off');
    const stranger = client();
    const su = await stranger.post('/v1/host/openwop-app/test/login', { email: `stranger-${Date.now()}-${n++}@acme.test` });
    expect(su.status).toBe(201);
    const del = await stranger.del(`${ORG(orgId)}/subjects/some-subject`);
    expect([403, 404]).toContain(del.status);
    expect(del.status).not.toBe(200);
  });

  it('an ANONYMOUS caller is refused (the lane is RBAC-gated, not open)', async () => {
    const { orgId } = await ownerWithOrg();
    await setConsentToggle('off');
    const anon = client();
    const del = await anon.del(`${ORG(orgId)}/subjects/some-subject`);
    expect([401, 403, 404]).toContain(del.status);
    expect(del.status).not.toBe(200);
  });

  it('ENFORCEMENT semantics are untouched — toggle OFF is still permissive', async () => {
    // The alternative fix (default the toggle on) would have flipped this to
    // `false` for every existing tenant with no consent record, silently
    // breaking live sends. Pinned so that change cannot land quietly.
    await __resetConsentStore();
    await setConsentToggle('off');
    expect(await isAllowed('t-cons5', 'nobody', 'analytics')).toBe(true);
    expect(await isAllowed('t-cons5', 'nobody', 'marketing')).toBe(true);
    // …except the ADR 0394 strict set, which is denied even with the toggle off.
    expect(await isAllowed('t-cons5', 'nobody', 'marketing.whatsapp')).toBe(false);
  });

  it('ENFORCEMENT semantics are untouched — toggle ON is still fail-closed under opt-in', async () => {
    await __resetConsentStore();
    await setConsentToggle('on');
    try {
      expect(await isAllowed('t-cons5b', 'nobody', 'analytics')).toBe(false);
      await recordConsent({ tenantId: 't-cons5b', subjectKey: 's1', categories: { analytics: true }, source: 'test' });
      expect(await isAllowed('t-cons5b', 's1', 'analytics')).toBe(true);
    } finally {
      await setConsentToggle('off');
    }
  });
});
