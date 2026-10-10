/**
 * ADR 0860 — public visitors choose analytics, by region, on the existing consent
 * lane; a form submit links a session only to a contact it CREATED.
 *
 * Witnessed red on `90e7f78ee` before the change (the region default, the posture
 * route, the scope legs that depend on `opts.visitor`, the page-read and funnel
 * legs, and the D7 spoof leg all failed; the "unchanged" legs passed and stay as
 * guards that the default did not leak into other decisions).
 *
 * Re-witnessed by sabotage (/grade-tests wave 9): the sentinel set, the foreign-
 * subdivision drop, the operator-named header, the `CA` expansion, the "maybe
 * California" rule, the floor out-ranking a policy, the region default, its
 * analytics-only scope, the no-policy regime, the token subject, posture and page
 * `no-store`, the page / funnel gates, both D7 skips, the day-keyed note, the
 * refused-token attribution and the owx lane each red their case.
 */

import http from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { listEvents } from '../src/features/analytics/analyticsService.js';
import { contactForSession } from '../src/features/analytics/identityLinkService.js';
import { isAllowed, setPolicy } from '../src/features/consent/consentService.js';
import { regionIsRegulated, visitorRegionOf } from '../src/features/consent/visitorRegion.js';
import { findContactByEmail } from '../src/features/crm/contactsService.js';
import { listActivities } from '../src/features/crm/crmEntitiesService.js';
import { instrumentBody } from '../src/features/email/engagementService.js';
import { assignWeightedVariant } from '../src/host/variantAssignment.js';
import { listCollectedEvents } from '../src/features/cdp/collectService.js';
import { listSubmissions } from '../src/features/forms/formsService.js';
import { createPage, setLocalePublishState, updateContentLanguageSettings } from '../src/features/cms/cmsService.js';
import { getOrg } from '../src/host/accessControlService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_GEO_COUNTRY_HEADER;
  delete process.env.OPENWOP_GEO_SUBDIVISION_HEADER;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'analytics', 'crm', 'consent', 'funnels', 'cdp']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** Every response field this file reads, at the shape the routes send. */
interface Body {
  orgId?: string; subjectToken?: string; regime?: string; pageId?: string; slug?: string;
  versions?: Array<{ versionId: string; snapshot: { title: string } }>;
  experimentId?: string; salt?: string; variants?: Array<{ key: string; versionId: string | null; weight: number }>;
  experiment?: { variant?: string }; sections?: unknown; funnel?: { funnelId: string };
  formId?: string; submissionId?: string;
}
interface Res { status: number; body: Body; headers: Headers }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let parsed: Body = {};
    try { parsed = text ? (JSON.parse(text) as Body) : {}; } catch { parsed = {}; }
    return { status: res.status, headers: res.headers, body: parsed };
  };
  return {
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, b?: unknown, h?: Record<string, string>) => call('POST', p, b, h),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
  };
}
const pub = client();
let n = 0;
async function ownerWithOrg(tenantId: string): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const su = await owner.post('/host/openwop-app/test/login', { email: `adr0860-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId! };
}

/** Run `fn` with the geo headers configured, the way an operator behind an
 *  overwriting edge would. */
async function withGeo<T>(fn: () => Promise<T>): Promise<T> {
  process.env.OPENWOP_GEO_COUNTRY_HEADER = 'X-Test-Country';
  process.env.OPENWOP_GEO_SUBDIVISION_HEADER = 'X-Test-Region';
  try { return await fn(); } finally {
    delete process.env.OPENWOP_GEO_COUNTRY_HEADER;
    delete process.env.OPENWOP_GEO_SUBDIVISION_HEADER;
  }
}
const geo = (country: string, sub?: string): Record<string, string> => ({ 'x-test-country': country, ...(sub ? { 'x-test-region': sub } : {}) });
const collect = (orgId: string, sessionKey: string, h?: Record<string, string>, extra: Record<string, unknown> = {}) =>
  pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey, ...extra }, h);

describe('ADR 0860 D1 — the region comes only from the operator-named header', () => {
  // A REAL IncomingMessage carrying the headers (wave 9: was `({ headers }) as unknown as
  // Request`, a laundered plain object). One downcast from Express's own base type.
  const req = (headers: Record<string, string>): Request => {
    const m = new http.IncomingMessage(new Socket());
    m.headers = headers;
    return m as Request;
  };

  it('unset env ⇒ unknown, whatever the client sends', () => {
    expect(visitorRegionOf(req({ 'x-test-country': 'US', 'cf-ipcountry': 'US', 'x-client-region': 'US' }))).toBeNull();
  });

  it('a configured header yields a country and a normalized subdivision; junk is unknown', async () => {
    await withGeo(async () => {
      expect(visitorRegionOf(req(geo('us', 'USCA')))).toEqual({ country: 'US', subdivision: 'US-CA' });
      expect(visitorRegionOf(req(geo('US', 'US-NY')))).toEqual({ country: 'US', subdivision: 'US-NY' });
      expect(visitorRegionOf(req(geo('US', 'NY')))).toEqual({ country: 'US', subdivision: 'US-NY' });
      expect(visitorRegionOf(req(geo('US', 'FRIDF')))).toEqual({ country: 'US' }); // a foreign subdivision is dropped
      for (const bad of ['', 'X1', 'USA', 'U']) expect(visitorRegionOf(req(geo(bad))), bad).toBeNull();
      // grade-code M2 — geo-database sentinels mean "unknown", never a country.
      for (const sentinel of ['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'AP', 'EU']) expect(visitorRegionOf(req(geo(sentinel))), sentinel).toBeNull();
    });
  });

  it('the floor, the tenant additions, and the unknown cases', () => {
    expect(regionIsRegulated(null)).toBe(true);
    expect(regionIsRegulated({ country: 'FR' })).toBe(true);
    expect(regionIsRegulated({ country: 'NO' })).toBe(true); // EEA, not EU
    expect(regionIsRegulated({ country: 'GB' })).toBe(true);
    expect(regionIsRegulated({ country: 'US', subdivision: 'US-CA' })).toBe(true);
    expect(regionIsRegulated({ country: 'US' }), 'a US visitor might be in California').toBe(true);
    expect(regionIsRegulated({ country: 'US', subdivision: 'US-NY' })).toBe(false);
    expect(regionIsRegulated({ country: 'CA' }), "'CA' in the floor means California; Canada only via a policy").toBe(false);
    expect(regionIsRegulated({ country: 'CA' }, ['EU', 'CA', 'UK']), "a policy's 'CA' matches Canada too").toBe(true);
    expect(regionIsRegulated({ country: 'JP' })).toBe(false);
    expect(regionIsRegulated({ country: 'JP' }, ['JP'])).toBe(true);
    expect(regionIsRegulated({ country: 'DE' }, []), 'a policy cannot remove the floor').toBe(true);
  });
});

describe('ADR 0860 D2 — the beacon applies the region-aware default with no tenant policy', () => {
  it('unknown region ⇒ opt-in (prod today: no geo header configured)', async () => {
    const T = 'user:adr0860-unknown';
    const { orgId } = await ownerWithOrg(T);
    expect((await collect(orgId, 'vk-u1', geo('US', 'USNY'))).status, 'the header is ignored when the operator did not name it').toBe(202);
    expect((await listEvents(T, orgId)).length).toBe(0);
  });

  it('regulated ⇒ 202; elsewhere ⇒ 201', async () => {
    const T = 'user:adr0860-geo';
    const { orgId } = await ownerWithOrg(T);
    await withGeo(async () => {
      expect((await collect(orgId, 'vk-fr', geo('FR'))).status).toBe(202);
      expect((await collect(orgId, 'vk-gb', geo('GB'))).status).toBe(202);
      expect((await collect(orgId, 'vk-ca', geo('US', 'USCA'))).status).toBe(202);
      expect((await collect(orgId, 'vk-us', geo('US'))).status, 'no subdivision ⇒ maybe California').toBe(202);
      expect((await collect(orgId, 'vk-junk', geo('X1'))).status).toBe(202);
      const ny = await collect(orgId, 'vk-ny', geo('US', 'USNY'));
      expect(ny.status, JSON.stringify(ny.body)).toBe(201);
      expect((await collect(orgId, 'vk-jp', geo('JP'))).status).toBe(201);
    });
    expect((await listEvents(T, orgId)).map((e) => e.sessionKey).sort()).toEqual(['vk-jp', 'vk-ny']);
  });

  it('a policy adds regions, keeps opt-in when it chose opt-in, and the floor out-ranks an explicit opt-out (architect H3)', async () => {
    const T = 'user:adr0860-policy';
    const { orgId } = await ownerWithOrg(T);
    await withGeo(async () => {
      await setPolicy(T, { defaultMode: 'opt-out', regulatedRegions: ['JP'] });
      expect((await collect(orgId, 'vk-p1', geo('JP'))).status).toBe(202);
      expect((await collect(orgId, 'vk-p2', geo('DE'))).status, 'floor region under an opt-out policy').toBe(202);
      expect((await collect(orgId, 'vk-p3')).status, 'unknown region under an opt-out policy').toBe(202);
      expect((await collect(orgId, 'vk-p4', geo('US', 'USNY'))).status).toBe(201);
      await setPolicy(T, { defaultMode: 'opt-in', regulatedRegions: [] });
      expect((await collect(orgId, 'vk-p5', geo('US', 'USNY'))).status, "the tenant's opt-in holds outside the floor").toBe(202);
    });
  });

  it("a visitor's recorded refusal wins over a permissive region", async () => {
    const T = 'user:adr0860-refusal';
    const { orgId } = await ownerWithOrg(T);
    await withGeo(async () => {
      const refused = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: false } });
      expect(refused.status).toBe(201);
      expect((await collect(orgId, 'vk-r1', geo('US', 'USNY'), { consentToken: refused.body.subjectToken! })).status).toBe(202);
      const granted = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
      expect((await collect(orgId, 'vk-r2', geo('FR'), { consentToken: granted.body.subjectToken! })).status, 'an EU visitor who opted in').toBe(201);
    });
  });

  it('the default reaches no other decision: no visitor context, or any other category, keeps the unset-policy deny', async () => {
    const T = 'user:adr0860-scope';
    expect(await isAllowed(T, 'vk-s', 'analytics')).toBe(false);
    expect(await isAllowed(T, 'crm:s', 'marketing.email', { visitor: { region: { country: 'US', subdivision: 'US-NY' } } })).toBe(false);
    expect(await isAllowed(T, 'crm:s', 'marketing', { visitor: { region: { country: 'JP' } } })).toBe(false);
    expect(await isAllowed(T, 'vk-s', 'analytics', { visitor: { region: { country: 'JP' } } })).toBe(true);
  });
});

describe('ADR 0860 D4 — the posture route', () => {
  it('returns the regime only, never cached, and 404s like the rest of the lane', async () => {
    const T = 'user:adr0860-posture';
    const { orgId } = await ownerWithOrg(T);
    const unknown = await pub.get(`/host/openwop-app/public-consent/${orgId}/posture`);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ regime: 'opt-in' });
    expect(unknown.headers.get('cache-control')).toContain('no-store');
    await withGeo(async () => {
      expect((await pub.get(`/host/openwop-app/public-consent/${orgId}/posture`, geo('US', 'USNY'))).body).toEqual({ regime: 'opt-out' });
      expect((await pub.get(`/host/openwop-app/public-consent/${orgId}/posture`, geo('FR'))).body).toEqual({ regime: 'opt-in' });
    });
    expect((await pub.get('/host/openwop-app/public-consent/org-nope/posture')).status).toBe(404);
  });
});

// ─── the page read (experiment assignment) ──────────────────────────────────
const cms = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
async function runningExperiment(owner: ReturnType<typeof client>, orgId: string): Promise<{ slug: string; vk: string }> {
  const created = await owner.post(cms(orgId, '/pages'), { title: 'V1 Title', sections: [{ type: 'hero', data: { heading: 'One' } }] });
  const pageId = created.body.pageId!;
  await owner.post(cms(orgId, `/pages/${pageId}/publish`));
  await owner.post(cms(orgId, `/pages/${pageId}/unpublish`));
  await owner.patch(cms(orgId, `/pages/${pageId}`), { title: 'V2 Title', sections: [{ type: 'hero', data: { heading: 'Two' } }] });
  const pub2 = await owner.post(cms(orgId, `/pages/${pageId}/publish`));
  const versions = await owner.get(cms(orgId, `/pages/${pageId}/versions`));
  const v1 = (versions.body.versions ?? []).find((v) => v.snapshot.title === 'V1 Title')!.versionId;
  const e = (await owner.post(cms(orgId, `/pages/${pageId}/experiments`), {
    name: 'Hero', variants: [{ key: 'control', versionId: null, weight: 50 }, { key: 'legacy', versionId: v1, weight: 50 }],
  })).body;
  expect((await owner.post(cms(orgId, `/pages/${pageId}/experiments/${e.experimentId}/start`))).status).toBe(200);
  for (let i = 0; i < 500; i++) {
    const vk = `vk-exp-${i}`;
    if (assignWeightedVariant(vk, e.experimentId!, e.salt!, e.variants ?? []) === 'legacy') return { slug: pub2.body.slug!, vk };
  }
  throw new Error('no legacy visitor');
}

describe('ADR 0860 D3 — the page read decides with the same helper', () => {
  it('no token + regulated ⇒ no experiment; granting token (header) ⇒ variant; non-regulated ⇒ variant; never cached', async () => {
    const T = 'org:adr0860-page';
    const { owner, orgId } = await ownerWithOrg(T);
    const { slug, vk } = await runningExperiment(owner, orgId);
    const page = (h?: Record<string, string>) => pub.get(`/host/openwop-app/public/${orgId}/pages/${slug}?vk=${vk}`, h);
    const denied = await page();
    expect(denied.status).toBe(200);
    expect(denied.body.experiment).toBeUndefined();
    expect(denied.headers.get('cache-control')).toContain('no-store');
    const granted = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
    const withToken = await page({ 'x-openwop-consent-token': granted.body.subjectToken! });
    expect(withToken.body.experiment?.variant).toBe('legacy');
    const forged = await page({ 'x-openwop-consent-token': 'forged' });
    expect(forged.status, 'a bad token never takes a page down').toBe(200);
    expect(forged.body.experiment, 'a refused token is a refusal, never an assignment').toBeUndefined();
    await withGeo(async () => {
      expect((await page(geo('US', 'USNY'))).body.experiment?.variant).toBe('legacy');
    });
  });
});


describe('ADR 0860 D3 (architect B1) — the funnel routes decide with the same helper', () => {
  it('a vk with no token in an unknown region records nothing; the same vk with a granting token records the step', async () => {
    const T = 'org:adr0860-funnel';
    const { owner, orgId } = await ownerWithOrg(T);
    const page = await owner.post(cms(orgId, '/pages'), { title: 'Landing 0860' });
    await owner.post(cms(orgId, `/pages/${page.body.pageId!}/publish`));
    const created = await owner.post(`/host/openwop-app/funnels/orgs/${orgId}/funnels`, {
      name: 'F', slug: 'f-0860', steps: [{ stepId: 'st-1', kind: 'landing', pageId: page.body.pageId }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await owner.post(`/host/openwop-app/funnels/orgs/${orgId}/funnels/${created.body.funnel!.funnelId}/publish`)).status).toBe(200);
    const view = (h?: Record<string, string>) => pub.get(`/host/openwop-app/public/${orgId}/funnels/f-0860?vk=vk-fun`, h);
    const steps = async () => (await listCollectedEvents(T, 200)).filter((e) => e.eventType === 'funnel.step_viewed');
    expect((await view()).status).toBe(200);
    expect(await steps()).toHaveLength(0);
    const granted = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
    expect((await view({ 'x-openwop-consent-token': granted.body.subjectToken! })).status).toBe(200);
    expect(await steps()).toHaveLength(1);
  });
});

describe('ADR 0860 × ADR 0861 — a withheld locale and a refused visitor on the same public read', () => {
  it('the page never serves the withheld overlay, whatever the consent; the visitor is never recorded or cached', async () => {
    const T = 'org:adr0860-x-0861';
    const { owner, orgId } = await ownerWithOrg(T);
    const tenantId = (await getOrg(orgId))!.tenantId;
    await updateContentLanguageSettings(tenantId, orgId, { baseLocale: 'en', supportedLocales: ['pt-BR'] }, 'u1');
    const created = await createPage({
      tenantId, orgId, title: 'Bilingual', createdBy: 'u1',
      sections: [{ type: 'richText', data: { text: 'english body' }, localizations: { pt: { text: 'corpo retido' } } }],
    });
    expect((await owner.post(cms(orgId, `/pages/${created.pageId}/publish`))).status).toBe(200);
    await setLocalePublishState(tenantId, orgId, created.pageId, 'pt', 'draft', 'u1');
    const refused = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: false } });
    const token = refused.body.subjectToken!;
    const read = (h: Record<string, string>) => pub.get(`/host/openwop-app/public/${orgId}/pages/${created.slug}?vk=vk-x`, { 'accept-language': 'pt-BR', ...h });
    const variants: Record<string, string>[] = [{}, { 'x-openwop-consent-token': token }];
    for (const h of variants) {
      const r = await read(h);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body.sections)).not.toContain('corpo retido');
      expect(JSON.stringify(r.body.sections)).toContain('english body');
      expect(r.body.experiment).toBeUndefined();
      expect(r.headers.get('cache-control')).toContain('no-store');
    }
    expect((await collect(orgId, 'vk-x', undefined, { consentToken: token })).status).toBe(202);
    await withGeo(async () => {
      expect((await collect(orgId, 'vk-x', geo('US', 'USNY'), { consentToken: token })).status, 'a recorded refusal beats a permissive region').toBe(202);
    });
  });
});

// ─── D7 — forms link only contacts they create ──────────────────────────────
const FORM = {
  title: 'Contact us',
  createToContact: true,
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
  ],
};
const orgOf = new Map<string, string>();
async function publishedForm(tenantId: string): Promise<{ formId: string; orgId: string }> {
  const { owner, orgId } = await ownerWithOrg(tenantId);
  const formId = (await owner.post(`/host/openwop-app/forms/orgs/${orgId}/forms`, FORM)).body.formId;
  expect(formId, 'the form create must return an id').toEqual(expect.any(String));
  if (typeof formId !== 'string') throw new Error('unreachable: asserted above');
  orgOf.set(formId, orgId);
  expect((await owner.patch(`/host/openwop-app/forms/orgs/${orgId}/forms/${formId}/status`, { status: 'published' })).status).toBe(200);
  return { formId, orgId };
}

describe('ADR 0860 D7 — a form submit links a session only to a contact it created', () => {
  it("Bob's email cannot attach the submitter's session to Bob; Bob gets ONE activity; a new contact still links", async () => {
    const T = 'user:adr0860-d7';
    const { formId, orgId } = await publishedForm(T);
    await setPolicy(T, { defaultMode: 'opt-in' });
    const granted = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
    const consentToken = granted.body.subjectToken!;
    const submit = (email: string, sessionKey: string) =>
      pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { values: { name: 'X', email }, sessionKey, consentToken });

    // Bob already exists.
    expect((await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { values: { name: 'Bob', email: 'bob-0860@example.com' } })).status).toBe(201);
    const bob = await findContactByEmail(T, 'bob-0860@example.com');
    expect(bob).toBeTruthy();

    // The spoof: someone else submits Bob's email with their own session, consented.
    expect((await submit('bob-0860@example.com', 'vk-mallory')).status).toBe(201);
    expect((await submit('bob-0860@example.com', 'vk-mallory')).status).toBe(201); // a second time, same day
    expect(await contactForSession(T, 'vk-mallory'), "the submitter's session must not be linked to Bob").toBeNull();
    const notes = (await listActivities(T, orgId)).filter((a) => a.contactId === bob!.contactId);
    // CEILING (wave 9): the note key is the UTC DAY (`crm/formsSubmissionSink.ts`), so a
    // UTC-midnight crossing between the two spoof submits would write 2 notes. A
    // milliseconds-wide window the clock-shift lane does not move; not fixable here
    // without faking Date under a live server.
    expect(notes, 'one note per form, per contact, per day').toHaveLength(1);
    expect(notes[0]!.body).toBe('Submitted the form "Contact us".');

    // A submission that CREATES its contact still links its (consented) session.
    expect((await submit('carol-0860@example.com', 'vk-carol')).status).toBe(201);
    const carol = await findContactByEmail(T, 'carol-0860@example.com');
    expect(await contactForSession(T, 'vk-carol')).toBe(carol!.contactId);
  });

  it('a clientKey replay with a DIFFERENT session links nothing (architect M5)', async () => {
    const T = 'user:adr0860-replay';
    const { formId } = await publishedForm(T);
    const body = { values: { name: 'Dee', email: 'dee-0860@example.com' }, clientKey: 'ck-1' };
    expect((await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { ...body, sessionKey: 'vk-first' })).status).toBe(201);
    await withGeo(async () => {
      expect((await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { ...body, sessionKey: 'vk-second' }, geo('JP'))).status).toBe(201);
    });
    expect(await contactForSession(T, 'vk-second')).toBeNull();
    // grade-code M3 — the positive control: the flag persisted, and the SAME
    // session's consented replay links. Without it, either guard could rot green.
    const row = (await listSubmissions(T, orgOf.get(formId)!, formId)).find((x) => x.meta.sessionKey === 'vk-first');
    expect(row?.contactCreated).toBe(true);
    await withGeo(async () => {
      expect((await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { ...body, sessionKey: 'vk-first' }, geo('JP'))).status).toBe(201);
    });
    expect(await contactForSession(T, 'vk-first')).toBe(row?.contactId);
  });

  it('an invalid token still records the lead, links nothing, and is a refusal for funnel attribution (grade-code M1)', async () => {
    const T = 'org:adr0860-badtoken';
    const { owner, orgId } = await ownerWithOrg(T);
    await setPolicy(T, { defaultMode: 'opt-out' });
    const form = (await owner.post(`/host/openwop-app/forms/orgs/${orgId}/forms`, FORM)).body;
    await owner.patch(`/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    const page = await owner.post(cms(orgId, '/pages'), { title: 'Step 0860' });
    await owner.post(cms(orgId, `/pages/${page.body.pageId}/publish`));
    const fun = await owner.post(`/host/openwop-app/funnels/orgs/${orgId}/funnels`, {
      name: 'G', slug: 'g-0860', steps: [{ stepId: 'st-a', kind: 'optin', pageId: page.body.pageId }],
    });
    expect(fun.status, JSON.stringify(fun.body)).toBe(201);
    const funnelId = fun.body.funnel?.funnelId;
    expect(funnelId, 'the funnel create must return an id').toEqual(expect.any(String));
    if (typeof funnelId !== 'string') throw new Error('unreachable: asserted above');
    const r = await pub.post(`/host/openwop-app/public-forms/${form.formId}/submit`, {
      values: { name: 'Fay', email: 'fay-0860@example.com' }, sessionKey: 'vk-fay', consentToken: 'forged',
      context: { funnelId, stepId: 'st-a', visitor: 'vk-fay' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.submissionId).toBeTruthy();
    expect(await contactForSession(T, 'vk-fay')).toBeNull();
    const done = (await listCollectedEvents(T, 200)).filter((e) => e.eventType === 'funnel.step_completed');
    expect(done.map((e) => (e.payload as { visitor?: string }).visitor), 'a refused token never yields a consented visitor').toEqual(['']);
  });

  it('the verified lane still links an EXISTING contact: a signed email click', async () => {
    const T = 'user:adr0860-owx';
    const { formId, orgId } = await publishedForm(T);
    expect((await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { values: { name: 'Eve', email: 'eve-0860@example.com' } })).status).toBe(201);
    const eve = await findContactByEmail(T, 'eve-0860@example.com');
    const body = await instrumentBody('Go https://dest.example/e now', BASE, { tenantId: T, campaignId: 'cmp-0860', contactId: eve!.contactId, email: 'eve-0860@example.com' });
    const clickUrl = body.match(/http:\/\/127\.0\.0\.1:\d+\/host\/openwop-app\/public-email\/c\/\S+/)?.[0];
    const owx = new URL((await fetch(clickUrl!, { redirect: 'manual' })).headers.get('location') ?? '').searchParams.get('owx');
    const granted = await pub.post(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
    expect((await collect(orgId, 'vk-eve', undefined, { owx, consentToken: granted.body.subjectToken! })).status).toBe(201);
    expect(await contactForSession(T, 'vk-eve')).toBe(eve!.contactId);
  });
});
