/**
 * Consent feature (ADR 0020) — ROUTE + service harness. Boots the real app and
 * drives: the PUBLIC record/read, authed policy + records + data-subject delete
 * (RBAC), the centralized `isAllowed` enforcement helper (necessary always allowed;
 * fail-closed in opt-in; opt-out allows; toggle-off permissive), the well-known
 * advertisement, and a feature.consent.nodes smoke.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  __resetConsentStore, isAllowed, recordConsent, setPolicy,
} from '../src/features/consent/consentService.js';
import { buildConsentSurface } from '../src/features/consent/surface.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    const sc = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
    for (const c of sc) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
const pub = client();
let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `consent-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enableConsent = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('consent'); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Consent: registration + public + authed', () => {
  it('is registered + advertises ctx.features.consent at /.well-known/openwop', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'consent')).toBe(true);
    const disco = await pub.get('/.well-known/openwop');
    expect(disco.body.hostExtensions?.featureSurfaces).toContain('host.sample.consent');
  });

  // CONS-2 — the public lane now mints its own `visitor:` identity and requires
  // the minted token on every write and read. The old contract (an arbitrary
  // `subjectKey` from an unauthenticated body, into the keyspace shared with
  // contactIds / userIds / emails / E.164) is what this test used to pin.
  it('public record + read: mint-then-reuse a subjectToken (no auth)', async () => {
    const { orgId } = await ownerWithOrg();
    // 1. No token ⇒ the host MINTS one and hands it back. Capture still works
    //    with no prior state — the exit the refusal below prescribes.
    const rec = await pub.post(`/v1/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true, marketing: false } });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(rec.body.categories).toMatchObject({ necessary: true, analytics: true, marketing: false });
    expect(typeof rec.body.subjectToken).toBe('string');
    const token = rec.body.subjectToken as string;

    // 2. The read requires the token; it returns the record it addresses.
    const read = await pub.get(`/v1/host/openwop-app/public-consent/${orgId}/${encodeURIComponent(token)}`);
    expect(read.body.recorded).toBe(true);
    expect(read.body.categories.analytics).toBe(true);

    // 3. Re-posting WITH the token updates the same record, and merges rather
    //    than replacing (CONS-3): `analytics` survives a marketing-only write.
    const upd = await pub.post(`/v1/host/openwop-app/public-consent/${orgId}`, { subjectToken: token, categories: { marketing: true } });
    expect(upd.status, JSON.stringify(upd.body)).toBe(201);
    expect(upd.body.categories).toMatchObject({ necessary: true, analytics: true, marketing: true });
    expect(upd.body.subjectToken).toBe(token);
  });

  it('authed policy + records + data-subject delete (RBAC)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await pub.post(`/v1/host/openwop-app/public-consent/${orgId}`, { categories: { marketing: true } });
    const setPol = await owner.put(`/v1/host/openwop-app/consent/orgs/${orgId}/policy`, { defaultMode: 'opt-out', regulatedRegions: ['EU'] });
    expect(setPol.body.policy.defaultMode).toBe('opt-out');
    const recs = await owner.get(`/v1/host/openwop-app/consent/orgs/${orgId}/records`);
    // The operator console sees the minted `visitor:` key — a namespace no
    // authed identity space can collide with (CONS-2).
    const row = recs.body.records.find((r: any) => String(r.subjectKey).startsWith('visitor:') && r.categories.marketing === true);
    expect(row, JSON.stringify(recs.body.records)).toBeTruthy();
    const del = await owner.del(`/v1/host/openwop-app/consent/orgs/${orgId}/subjects/${encodeURIComponent(row.subjectKey)}`);
    expect(del.status).toBe(200); // GDPR erasure is idempotent (no 404)
    expect(del.body.ok).toBe(true);
    const after = await owner.get(`/v1/host/openwop-app/consent/orgs/${orgId}/subjects/${encodeURIComponent(row.subjectKey)}`);
    expect(after.body.record).toBeNull();
  });
});

describe('Consent: isAllowed enforcement (the gate Analytics/Email call)', () => {
  it('necessary always allowed; record honored; fail-closed vs opt-out', async () => {
    await __resetConsentStore();
    expect(await isAllowed('tC', 's1', 'necessary')).toBe(true);
    // toggle on (beforeAll), no record, no policy → fail-closed (opt-in default)
    expect(await isAllowed('tC', 's1', 'analytics')).toBe(false);
    // a recorded yes is honored
    await recordConsent({ tenantId: 'tC', subjectKey: 's1', categories: { analytics: true }, source: 'test' });
    expect(await isAllowed('tC', 's1', 'analytics')).toBe(true);
    // opt-out policy → an unrecorded subject is allowed
    await setPolicy('tC', { defaultMode: 'opt-out' });
    expect(await isAllowed('tC', 's-new', 'marketing')).toBe(true);
  });

  it('toggle off ⇒ permissive (public 404 + isAllowed allows)', async () => {
    const { orgId } = await ownerWithOrg();
    try {
      await enableConsent('off');
      expect((await pub.post(`/v1/host/openwop-app/public-consent/${orgId}`, { subjectKey: 'x', categories: {} })).status).toBe(404);
      expect(await isAllowed('tOff', 'anybody', 'analytics')).toBe(true); // no regime ⇒ permissive
    } finally {
      await enableConsent('on');
    }
  });
});

describe('Consent: feature.consent.nodes', () => {
  it('check + record run over a stub ctx.features.consent', async () => {
    await __resetConsentStore();
    const mod = await import('../../../packs/feature.consent.nodes/index.mjs');
    const surf = buildConsentSurface({ tenantId: 'tN' });
    const ctx = (i: Record<string, unknown>) => ({ features: { consent: surf }, inputs: i });
    const rec = await mod.nodes['feature.consent.nodes.record'](ctx({ subjectKey: 's', categories: { analytics: true } }));
    expect(rec.status).toBe('success');
    const chk = await mod.nodes['feature.consent.nodes.check'](ctx({ subjectKey: 's', category: 'analytics' }));
    expect(chk.status).toBe('success');
    expect((chk.outputs as { allowed: boolean }).allowed).toBe(true);
  });
});
