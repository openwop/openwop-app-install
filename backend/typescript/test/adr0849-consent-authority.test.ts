/**
 * ADR 0849 — the tenant-wide consent regime is an admin act, and a subject's consent can
 * be proven. Every leg below was RED on `b634adc76`:
 *
 *  D1  an EDITOR (workspace:write, no host:members:manage) set the tenant policy, edited
 *      the purpose vocabulary, read the raw-key ledger and looked up any subject;
 *  B1  `…/access` tells the console what to offer, on the un-toggle-gated DSAR lane;
 *  D2  a run an editor STARTED — or CAUSED (kanban Run, canvas invoke, an armed trigger;
 *      grade-code CN2CD-1) — recorded consent for any subject; a run with no person
 *      still records;
 *  D3  the record carries its own change log (dedupe, origin pinned, bounded); the ledger
 *      strips it; a lookup reports erasure (erased wins);
 *  B3  unbounded `purposes` / `region` refused;
 *  D4  an unreadable consent store never 500s the public pixel / conversion lanes;
 *  D7  an email opt-in checkbox grants email only — witnessed in
 *      `forms-email-consent-sink.test.ts` (the sink's own HTTP fixture).
 *
 * Re-witnessed by sabotage (/grade-tests wave 9): every route's admin check, the
 * `/access` answer and its un-gated lane, both D2 floors (actor and cause), the
 * history dedupe / origin pin / dropped count / legacy seed, the ledger strip, the
 * erased-wins lookup, both B3 bounds and the D4 unreadable branch each red their
 * case. Every case seeds what it reads. NOTE (not a grade): the anonymous-session
 * case pins today's 401 as PARITY with the policy read; whether an anon owner should
 * reach the console at all is ADR 0839 / residue CN2WF-8.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
// D4 — failure injection at the gate the public lanes import (the
// `email-unsubscribe-honesty` pattern: an ESM namespace cannot be spied on).
let consentReadFails = false;
vi.mock('../src/features/consent/consentService.js', async (orig) => {
  const actual = await orig<typeof import('../src/features/consent/consentService.js')>();
  return {
    ...actual,
    isAllowed: async (...args: Parameters<typeof actual.isAllowed>) => {
      if (consentReadFails) throw new Error('consent store unavailable');
      return actual.isAllowed(...args);
    },
  };
});

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { signSession, COOKIE_TTL_SECONDS } from '../src/middleware/cookieSession.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import {
  recordConsent, mergeConsentCategories, getConsent, getPolicy, fullMarketingOptOut, HISTORY_MAX,
  type ConsentRecord,
} from '../src/features/consent/consentService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

let BASE = '';
let server: http.Server;
let ws = '';
let editorCookie = '';
let adminCookie = '';
let editorId = '';
let adminId = '';

const craftCookie = (userId: string, activeTenant: string, personalTenant: string): string => {
  const now = Math.floor(Date.now() / 1000);
  return `__session=${signSession({ sid: randomBytes(12).toString('hex'), tenantId: activeTenant, tier: 'user', userId, personalTenant, iat: now, exp: now + COOKIE_TTL_SECONDS })}`;
};
const seat = async (principalId: string, roles: string[]): Promise<{ cookie: string; userId: string }> => {
  const user = await upsertFromPrincipal({ tenantId: ws, principalId, source: 'oidc' });
  // Seated at the ROOT org: on a `ws:` tenant the tenant scope is the root membership
  // (ADR 0815 D1b, architect M2).
  await createMember({ tenantId: ws, orgId: ws, subject: user.userId, displayName: principalId, roles });
  return { cookie: craftCookie(user.userId, ws, `ws:home-${principalId}`), userId: user.userId };
};
/** Every response this file reads, at the shape the routes send. */
interface Body {
  error?: string; canManage?: boolean; orgId?: string; purposes?: string[];
  records?: ConsentRecord[]; record?: ConsentRecord | null; erased?: boolean; erasedAt?: string;
  details?: { field?: string }; pixels?: unknown[]; recorded?: boolean; reason?: string;
}
const call = async (method: string, path: string, cookie: string | null, body?: unknown): Promise<{ status: number; body: Body }> => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
};
const rawRecords = new DurableCollection<ConsentRecord>('consent:record', (r) => `${r.tenantId}:${r.subjectKey}`);
const ORG = () => `/host/openwop-app/consent/orgs/${ws}`;
const setToggle = async (id: string, status: 'on' | 'off') => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'consent', 'campaign-connectors']) await setToggle(id, 'on');
  ws = (await createWorkspace({ name: 'Consent 0849', ownerSubject: 'oidc:c49-owner' })).tenantId;
  ({ cookie: editorCookie, userId: editorId } = await seat('oidc:c49-editor', ['editor']));
  ({ cookie: adminCookie, userId: adminId } = await seat('oidc:c49-admin', ['admin']));
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('D1 — the regime, the ledger and the lookup are the admin tier', () => {
  it('an EDITOR is refused every regime write and every raw-key read; the policy is unchanged', async () => {
    await recordConsent({ tenantId: ws, subjectKey: 'alice@x.test', categories: { marketing: false }, source: 'test' });
    const before = await getPolicy(ws);
    const put = await call('PUT', `${ORG()}/policy`, editorCookie, { defaultMode: 'opt-out' });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('forbidden_scope');
    expect(await getPolicy(ws), 'the editor flipped nothing').toEqual(before);
    for (const [method, path, body] of [
      ['POST', `${ORG()}/purpose-vocab`, { code: 'planted' }],
      ['DELETE', `${ORG()}/purpose-vocab/planted`, undefined],
      ['PUT', `${ORG()}/purpose-vocab/strict`, { strict: true }],
      ['GET', `${ORG()}/records`, undefined],
      ['GET', `${ORG()}/subjects/${encodeURIComponent('alice@x.test')}`, undefined],
    ] as const) {
      const r = await call(method, path, editorCookie, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    // The non-PII reads stay at the member tier.
    expect((await call('GET', `${ORG()}/policy`, editorCookie)).status).toBe(200);
    expect((await call('GET', `${ORG()}/purpose-vocab`, editorCookie)).status).toBe(200);
  });

  it('an ADMIN is admitted to all of them', async () => {
    // Self-seeded (wave 9) — this used to read the editor case's `alice` row.
    await recordConsent({ tenantId: ws, subjectKey: 'admin-alice@x.test', categories: { marketing: false }, source: 'test' });
    expect((await call('PUT', `${ORG()}/policy`, adminCookie, { defaultMode: 'opt-in' })).status).toBe(200);
    expect((await getPolicy(ws))?.defaultMode, 'the admit WROTE').toBe('opt-in');
    const vocab = await call('POST', `${ORG()}/purpose-vocab`, adminCookie, { code: 'newsletter' });
    expect(vocab.status).toBe(201);
    expect(vocab.body.purposes).toContain('newsletter');
    expect((await call('PUT', `${ORG()}/purpose-vocab/strict`, adminCookie, { strict: false })).status).toBe(200);
    const recs = await call('GET', `${ORG()}/records`, adminCookie);
    expect(recs.status).toBe(200);
    expect((recs.body.records ?? []).map((r) => r.subjectKey)).toContain('admin-alice@x.test');
    const look = await call('GET', `${ORG()}/subjects/${encodeURIComponent('admin-alice@x.test')}`, adminCookie);
    expect(look.status).toBe(200);
    expect(look.body.record?.subjectKey).toBe('admin-alice@x.test');
  });

  it('B1 — `…/access` answers on the DSAR lane, toggle ON and OFF', async () => {
    for (const status of ['on', 'off'] as const) {
      await setToggle('consent', status);
      try {
        const ed = await call('GET', `${ORG()}/access`, editorCookie);
        const ad = await call('GET', `${ORG()}/access`, adminCookie);
        expect([ed.status, ed.body], `toggle ${status}`).toEqual([200, { canManage: false }]);
        expect([ad.status, ad.body], `toggle ${status}`).toEqual([200, { canManage: true }]);
      } finally { await setToggle('consent', 'on'); }
    }
    expect((await call('GET', `${ORG()}/access`, null)).status).toBe(401);
  });
});

describe('D2 — a run records consent only if its PERSON could administer consent', () => {
  it('an editor-started or editor-caused run is refused and writes nothing; admin and person-less runs write', async () => {
    const asEditor = buildFeatureSurfaces({ tenantId: ws, runId: 'r-ed', actingUserId: editorId }).consent!;
    await expect(asEditor.record!({ subjectKey: 'planted-subject', categories: { 'marketing.whatsapp': true } }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await getConsent(ws, 'planted-subject')).toBeNull();

    const asAdmin = buildFeatureSurfaces({ tenantId: ws, runId: 'r-ad', actingUserId: adminId }).consent!;
    await asAdmin.record!({ subjectKey: 'admin-subject', categories: { marketing: true } });
    expect((await getConsent(ws, 'admin-subject'))?.source, 'the run is named').toBe('workflow:r-ad');

    // grade-code CN2CD-1 — the CAUSE lane is checked too: a kanban Run, a canvas invoke of
    // an editor's run and an armed trigger all carry the member as `orgScopeSubject`.
    const caused = buildFeatureSurfaces({ tenantId: ws, runId: 'r-ca', orgScopeSubject: editorId }).consent!;
    await expect(caused.record!({ subjectKey: 'caused-subject', categories: { marketing: true } }))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(await getConsent(ws, 'caused-subject')).toBeNull();
    const adminCaused = buildFeatureSurfaces({ tenantId: ws, runId: 'r-ac', orgScopeSubject: adminId }).consent!;
    await adminCaused.record!({ subjectKey: 'form-subject', categories: { 'marketing.email': true } });
    expect((await getConsent(ws, 'form-subject'))?.categories['marketing.email']).toBe(true);
    // No person (a system job) ⇒ no check, as on every floor.
    const system = buildFeatureSurfaces({ tenantId: ws, runId: 'r-sys' }).consent!;
    await system.record!({ subjectKey: 'system-subject', categories: { analytics: true } });
    expect(await getConsent(ws, 'system-subject')).not.toBeNull();

    // The read stays open to every lane that sends.
    expect(await asEditor.isAllowed!({ subjectKey: 'admin-subject', category: 'marketing' })).toMatchObject({ allowed: true });
  });
});

describe('D3 — the record proves itself', () => {
  it('each written state is logged newest-first; a repeat appends nothing', async () => {
    const k = 'hist@x.test';
    await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: { marketing: true }, source: 'form-optin:f1' });
    await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: { 'marketing.sms': false }, source: 'preference-center' });
    await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: fullMarketingOptOut(), source: 'unsubscribe' });
    for (let i = 0; i < 30; i++) await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: fullMarketingOptOut(), source: 'unsubscribe' });
    const rec = await getConsent(ws, k);
    expect(rec?.history?.map((h) => h.source)).toEqual(['unsubscribe', 'preference-center', 'form-optin:f1']);
    expect(rec?.history?.[0]?.categories, 'history[0] mirrors the row').toEqual(rec?.categories);
  });

  it('CN2CD-2 — a pre-0849 row SEEDS the log (marked legacy) instead of being overwritten unrecorded', async () => {
    await rawRecords.put({ tenantId: ws, subjectKey: 'legacy@x.test', categories: { necessary: true, analytics: false, marketing: true }, source: 'form-optin:f0', ts: '2026-01-01T00:00:00.000Z' });
    await mergeConsentCategories({ tenantId: ws, subjectKey: 'legacy@x.test', categories: { marketing: false }, source: 'unsubscribe' });
    const h = (await getConsent(ws, 'legacy@x.test'))?.history ?? [];
    expect(h.map((e) => [e.source, e.legacy ?? false])).toEqual([['unsubscribe', false], ['form-optin:f0', true]]);
    expect(h[1]?.ts).toBe('2026-01-01T00:00:00.000Z');
  });

  it('the bound holds and the ORIGIN receipt is pinned', async () => {
    const k = 'bound@x.test';
    await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: { analytics: true }, source: 'origin' });
    for (let i = 0; i < 40; i++) {
      await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: { marketing: i % 2 === 0 }, source: `flip-${i}` });
    }
    const h = (await getConsent(ws, k))?.history ?? [];
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0]?.source).toBe('flip-39');
    expect(h[h.length - 1]?.source, 'the first recorded receipt survives').toBe('origin');
    expect((await getConsent(ws, k))?.historyDropped, 'CN2CD-4 — the gap is counted, never silent').toBe(41 - HISTORY_MAX);
  });

  it('recordConsent (the latest-wins lane) carries the history too', async () => {
    const k = 'rc@x.test';
    await recordConsent({ tenantId: ws, subjectKey: k, categories: { analytics: true }, source: 'seed' });
    await recordConsent({ tenantId: ws, subjectKey: k, categories: { analytics: false }, source: 'seed-2' });
    expect((await getConsent(ws, k))?.history?.map((h) => h.source)).toEqual(['seed-2', 'seed']);
  });

  it('the ledger strips history; the lookup carries it and reports erasure (erased wins)', async () => {
    // Self-seeded (wave 9) — this used to read the history the FIRST D3 case wrote.
    const k = 'ledger@x.test';
    await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: { marketing: true }, source: 'form-optin:f1' });
    await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: { 'marketing.sms': false }, source: 'preference-center' });
    await mergeConsentCategories({ tenantId: ws, subjectKey: k, categories: fullMarketingOptOut(), source: 'unsubscribe' });
    const list = await call('GET', `${ORG()}/records`, adminCookie);
    const rows = list.body.records ?? [];
    expect(rows.map((r) => r.subjectKey)).toContain(k);
    expect(rows.every((r) => r.history === undefined)).toBe(true);

    const look = await call('GET', `${ORG()}/subjects/${encodeURIComponent(k)}`, adminCookie);
    expect(look.body).toMatchObject({ erased: false });
    expect(look.body.record?.history).toHaveLength(3);

    const del = await call('DELETE', `${ORG()}/subjects/${encodeURIComponent(k)}`, adminCookie);
    expect(del.status).toBe(200);
    const after = await call('GET', `${ORG()}/subjects/${encodeURIComponent('LEDGER@x.test')}`, adminCookie);
    expect(after.body.record).toBeNull();
    expect(after.body.erased, 'erasure is reported, not read as never-recorded').toBe(true);
    expect(typeof after.body.erasedAt).toBe('string');

    // A pre-barrier row beside a tombstone is still reported erased.
    await rawRecords.put({ tenantId: ws, subjectKey: k, categories: { necessary: true, analytics: true, marketing: true }, source: 'legacy', ts: new Date().toISOString() });
    const legacy = await call('GET', `${ORG()}/subjects/${encodeURIComponent(k)}`, adminCookie);
    expect(legacy.body).toMatchObject({ record: null, erased: true });
  });
});

describe('B3 — a write cannot carry an unbounded payload', () => {
  it('more than 32 purposes, a long purpose code or a long region is a 400 on the public capture', async () => {
    const PUB = `/host/openwop-app/public-consent/${ws}`;
    const many = await call('POST', PUB, null, { categories: { marketing: true }, purposes: Array.from({ length: 33 }, (_, i) => `p${i}`) });
    expect([many.status, many.body.details?.field]).toEqual([400, 'purposes']);
    const long = await call('POST', PUB, null, { categories: { marketing: true }, purposes: ['x'.repeat(65)] });
    expect([long.status, long.body.details?.field]).toEqual([400, 'purposes']);
    const region = await call('POST', PUB, null, { categories: { marketing: true }, region: 'r'.repeat(65) });
    expect([region.status, region.body.details?.field]).toEqual([400, 'region']);
    const ok = await call('POST', PUB, null, { categories: { marketing: true }, region: 'EU', purposes: ['newsletter'] });
    expect(ok.status).toBe(201);
  });
});

describe('D4 — an unreadable consent store never 500s a public lane', () => {
  it('pixels answer empty and conversions answer 202 consent_unreadable', async () => {
    consentReadFails = true;
    try {
    const px = await call('GET', `/host/openwop-app/public/${ws}/pixels?vk=visitor-1`, null);
    expect([px.status, px.body]).toEqual([200, { pixels: [] }]);
    const cv = await call('POST', `/host/openwop-app/public/${ws}/conversions`, null, { vk: 'visitor-1', eventName: 'purchase' });
    expect([cv.status, cv.body]).toEqual([202, { recorded: false, reason: 'consent_unreadable' }]);
    } finally { consentReadFails = false; }
  });
});


describe('owners keep their console (orchestrator ask: anon/personal owners, ADR 0839)', () => {
  function cookieClient() {
    let cookie = '';
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
      const res = await fetch(`${BASE}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const h = res.headers as { getSetCookie?: () => string[] };
      for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
    };
  }

  it('a PERSONAL-workspace owner manages their own regime: access, policy write, ledger, lookup', async () => {
    const owner = cookieClient();
    expect((await owner('POST', '/host/openwop-app/test/login', { email: `c49-own-${Date.now()}@acme.test` })).status).toBe(201);
    const org = await owner('POST', '/host/openwop-app/orgs', { name: 'Mine' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const base = `/host/openwop-app/consent/orgs/${org.body.orgId}`;
    expect((await owner('GET', `${base}/access`)).body).toEqual({ canManage: true });
    expect((await owner('PUT', `${base}/policy`, { defaultMode: 'opt-out' })).status).toBe(200);
    expect((await owner('GET', `${base}/records`)).status).toBe(200);
    expect((await owner('GET', `${base}/subjects/someone`)).status).toBe(200);
  });

  it('an ANONYMOUS session meets the same door it met before ADR 0849 (the org check), never a new one', async () => {
    // MEASURED on this branch AND unchanged from origin/main: every authed consent route
    // starts with `requireOrgScope`, whose `resolveCallerUser` refuses an anonymous
    // session (`sign_in_required`, 401) — even in the anon's OWN workspace. ADR 0849 adds
    // no door in front of that: `…/access` answers exactly as the untouched policy GET.
    // (Whether anon demo owners should reach /consent at all is the ADR 0839 question,
    // filed as residue CN2WF-8 — a change to the shared org seam, not to consent.)
    const anon = cookieClient();
    await anon('GET', '/host/openwop-app/me'); // mints the anonymous session
    const own = await anon('POST', '/host/openwop-app/orgs', { name: 'Anon Co' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const b = `/host/openwop-app/consent/orgs/${own.body.orgId}`;
    const policy = await anon('GET', `${b}/policy`);
    const access = await anon('GET', `${b}/access`);
    expect(policy.status).toBe(401);
    expect(access.status, 'the access probe refuses exactly as the pre-0849 policy read does').toBe(policy.status);
    expect(access.body.error).toBe(policy.body.error);
  });
});
