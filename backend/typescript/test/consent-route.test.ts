/**
 * Consent feature (ADR 0020) — ROUTE harness. Boots the real app and drives what
 * only the wire can carry: the `host.sample.consent` advertisement, the PUBLIC
 * record/read lane (mint → read → token re-post MERGES), the authed policy +
 * records + data-subject erase (RBAC), and the toggle-off uniform 404 on the
 * public capture.
 *
 * Wave 9 (/grade-tests) removed the cases this file used to carry beside those,
 * each red-witnessed by the covering test under the same sabotage:
 *  - `isAllowed` semantics (necessary / fail-closed / opt-out) → consent-dsar-ungated
 *    "toggle ON is still fail-closed", consent-channels' matrix, consent-erasure-tombstone
 *    ARM A;
 *  - the toggle-off permissive `isAllowed` → consent-dsar-ungated "toggle OFF is still
 *    permissive";
 *  - the node smoke → consent-node-args' CONTROL arms.
 * Sabotage that reds THIS file: renaming the consent surface id (advert), a wholesale
 * (non-merging) write (public case), an erased lookup that returns the row (authed
 * case), and a public lane that ignores the toggle (toggle case).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { v1Advertisement } from './support/v1Advertisement.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { ConsentPolicy, ConsentRecord } from '../src/features/consent/consentService.js';

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

/** Every response this file reads, at the shape the routes send. */
interface Body {
  orgId?: string; ok?: boolean; subjectToken?: string; recorded?: boolean;
  categories?: Record<string, boolean>; policy?: ConsentPolicy; records?: ConsentRecord[];
  record?: ConsentRecord | null; erased?: boolean;
}
interface Res { status: number; body: Body }
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
    const text = res.status === 204 ? '' : await res.text();
    let parsed: Body = {};
    try { parsed = text ? (JSON.parse(text) as Body) : {}; } catch { parsed = {}; }
    return { status: res.status, body: parsed };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}
const pub = client();
let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const su = await owner.post('/host/openwop-app/test/login', { email: `consent-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId! };
}
const enableConsent = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('consent'); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Consent: registration + public + authed', () => {
  it('is registered + advertises ctx.features.consent at /.well-known/openwop', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'consent')).toBe(true);
    // ADR 0812 — the v2 root carries no `hostExtensions.featureSurfaces` (ADR 0014) yet; read the v1 claim from its builder.
    expect((await v1Advertisement()).hostExtensions?.featureSurfaces).toContain('host.sample.consent');
  });

  // CONS-2 — the public lane now mints its own `visitor:` identity and requires
  // the minted token on every write and read. The old contract (an arbitrary
  // `subjectKey` from an unauthenticated body, into the keyspace shared with
  // contactIds / userIds / emails / E.164) is what this test used to pin.
  it('public record + read: mint-then-reuse a subjectToken (no auth)', async () => {
    const { orgId } = await ownerWithOrg();
    // 1. No token ⇒ the host MINTS one and hands it back. Capture still works
    //    with no prior state — the exit the refusal below prescribes.
    const rec = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true, marketing: false } });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect(rec.body.categories).toMatchObject({ necessary: true, analytics: true, marketing: false });
    expect(typeof rec.body.subjectToken).toBe('string');
    const token = rec.body.subjectToken!;

    // 2. The read requires the token; it returns the record it addresses.
    const read = await pub.get(`/host/openwop-app/public-consent/${orgId}/${encodeURIComponent(token)}`);
    expect(read.body.recorded).toBe(true);
    expect(read.body.categories?.analytics).toBe(true);

    // 3. Re-posting WITH the token updates the same record, and merges rather
    //    than replacing (CONS-3): `analytics` survives a marketing-only write.
    const upd = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { subjectToken: token, categories: { marketing: true } });
    expect(upd.status, JSON.stringify(upd.body)).toBe(201);
    expect(upd.body.categories).toMatchObject({ necessary: true, analytics: true, marketing: true });
    expect(upd.body.subjectToken).toBe(token);
  });

  it('authed policy + records + data-subject delete (RBAC)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { marketing: true } });
    const setPol = await owner.put(`/host/openwop-app/consent/orgs/${orgId}/policy`, { defaultMode: 'opt-out', regulatedRegions: ['EU'] });
    expect(setPol.status).toBe(200);
    expect(setPol.body.policy?.defaultMode).toBe('opt-out');
    const recs = await owner.get(`/host/openwop-app/consent/orgs/${orgId}/records`);
    // The operator console sees the minted `visitor:` key — a namespace no
    // authed identity space can collide with (CONS-2).
    const row = (recs.body.records ?? []).find((r) => r.subjectKey.startsWith('visitor:') && r.categories.marketing === true);
    expect(row, JSON.stringify(recs.body.records)).toBeTruthy();
    const del = await owner.del(`/host/openwop-app/consent/orgs/${orgId}/subjects/${encodeURIComponent(row!.subjectKey)}`);
    expect(del.status).toBe(200); // GDPR erasure is idempotent (no 404)
    expect(del.body.ok).toBe(true);
    const after = await owner.get(`/host/openwop-app/consent/orgs/${orgId}/subjects/${encodeURIComponent(row!.subjectKey)}`);
    expect(after.body.record).toBeNull();
    // `record: null` alone also reads "never recorded" — the lookup must say ERASED.
    expect(after.body.erased).toBe(true);
  });
});

describe('Consent: the public capture is toggle-gated', () => {
  it('toggle off ⇒ the public capture 404s (uniform, like an unknown org)', async () => {
    const { orgId } = await ownerWithOrg();
    try {
      await enableConsent('off');
      // A VALID body, so the 404 cannot be a validation artefact: with the gate removed
      // this would mint (201).
      const res = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
      expect(res.status).toBe(404);
      expect(res.body.subjectToken).toBeUndefined();
    } finally {
      await enableConsent('on');
    }
  });
});
