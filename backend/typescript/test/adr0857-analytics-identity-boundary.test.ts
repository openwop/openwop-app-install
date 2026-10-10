/**
 * ADR 0857 — the analytics identity boundary (feature loop round 2, row 33).
 *
 * Each `describe` below was written BEFORE the fix and witnessed red on
 * `54e629220`:
 *
 *   D1  a link writer accepted ANY string as a session key, and the ADR 0381
 *       resolver looked it up as one. An anonymous form submit with
 *       `sessionKey: '<someone's email>'` and a second person's address linked
 *       the first person's DSAR key to the second person's contact — so
 *       erasing Alice erased Bob.
 *   D2  `ctx.features.analytics.events` stripped only `tenantId`; the
 *       re-identifying columns the HTTP route stopped returning (ANL-15) still
 *       reached every run.
 *   D3  the beacon could only evaluate consent against its own `sessionKey`,
 *       a keyspace no visitor can write consent into — so a refusal recorded
 *       through the public consent lane was never honoured by the beacon.
 *   D4  `analytics:identity-link` and `analytics:nav-counts` had no retention
 *       purger.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { contactForSession, linkSession, isLinkableSessionKey, type IdentityLink } from '../src/features/analytics/identityLinkService.js';
import { recordEvent, listEvents } from '../src/features/analytics/analyticsService.js';
import { buildAnalyticsSurface } from '../src/features/analytics/surface.js';
import { ANALYTICS_QUERY_TOOL_ID } from '../src/features/analytics/agentTools.js';
import { builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { recordNav, navReport, isoWeekEnd, isoWeek } from '../src/features/analytics/navTelemetryService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { eraseSubject, registeredSubjectKeyResolverNames } from '../src/host/subjectErasure.js';
import { findContactByEmail } from '../src/features/crm/contactsService.js';
import { setPolicy, writeErasureTombstone } from '../src/features/consent/consentService.js';
import { instrumentBody } from '../src/features/email/engagementService.js';
import { purgeRetained } from '../src/host/retentionPurger.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'analytics', 'crm']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
interface OrgBody { orgId: string }
interface FormBody { formId: string }
interface ConsentBody { subjectToken: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    // JSON boundary: the caller names the response shape it reads (`Res<T>`).
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = unknown>(p: string, b?: unknown) => call<T>('PATCH', p, b),
  };
}
const pub = client();
let n = 0;
async function ownerWithOrg(tenantId: string): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const su = await owner.post('/host/openwop-app/test/login', { email: `adr0857-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

const FORM = {
  title: 'Contact us',
  createToContact: true,
  fields: [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
  ],
};
async function publishedForm(tenantId: string): Promise<string> {
  const { owner, orgId } = await ownerWithOrg(tenantId);
  const form = (await owner.post<FormBody>(`/host/openwop-app/forms/orgs/${orgId}/forms`, FORM)).body;
  const pubd = await owner.patch(`/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
  expect(pubd.status, JSON.stringify(pubd.body)).toBe(200);
  return form.formId;
}

describe('ADR 0857 D1 — a session key is its own keyspace', () => {
  it('the grammar admits the first-party key and refuses every DSAR identity shape', () => {
    for (const ok of ['vk-0b9d4a4e-3c1f-4c55-9a51-2f1c1f0e9b77', 'demo-cdp-sess-3', 's2', 'sess_form-1']) expect(isLinkableSessionKey(ok), ok).toBe(true);
    for (const bad of [
      'alice@example.com', 'crm:3f6c', 'visitor:1234', 'user:abc', '+15550001111', '15550001111',
      '0b9d4a4e-3c1f-4c55-9a51-2f1c1f0e9b77', // a bare UUID is a userId shape
      '', ' sess', 'a'.repeat(129),
    ]) expect(isLinkableSessionKey(bad), bad).toBe(false);
  });

  it("an anonymous form submit cannot bind someone's email (as a session key) to another person's contact", async () => {
    const FT = 'user:adr0857-d1-form';
    const formId = await publishedForm(FT);
    // Bob exists as a contact.
    expect((await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { values: { name: 'Bob', email: 'bob-0857@example.com' } })).status).toBe(201);
    const bob = await findContactByEmail(FT, 'bob-0857@example.com');
    expect(bob).toBeTruthy();
    // The attacker submits Bob's address with Alice's email as the "session key".
    const atk = await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, {
      values: { name: 'Bob', email: 'bob-0857@example.com' }, sessionKey: 'alice-0857@example.com',
    });
    expect(atk.status).toBe(201); // the capture itself still lands
    expect(await contactForSession(FT, 'alice-0857@example.com'), 'no link may be written for a non-session key').toBeNull();
    // Read the STORE, not through `contactForSession` (grade-tests w8): that reader
    // applies the grammar too and returns null for an email key whatever is stored.
    // NOTE, STATED: this Bob leg is ALSO refused by ADR 0860 D7 (an EXISTING contact is
    // never linked), so it is a double guard; the leg below is the one only the
    // WRITE grammar can stop.
    const raw = new DurableCollection<IdentityLink>('analytics:identity-link', (l) => l.key);
    expect(await raw.get(`${FT}::alice-0857@example.com`), 'no row minted under a non-session key').toBeNull();
    // A FRESH address creates its contact (D7 does not apply), so only the grammar
    // stands between Alice's email-as-session-key and a durable link row.
    const fresh = await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, {
      values: { name: 'Carol', email: 'carol-0857@example.com' }, sessionKey: 'alice-0857@example.com',
    });
    expect(fresh.status).toBe(201);
    expect(await findContactByEmail(FT, 'carol-0857@example.com'), 'precondition: the submit created a contact').toBeTruthy();
    expect(await raw.get(`${FT}::alice-0857@example.com`), 'the WRITE grammar refused the link').toBeNull();
  });

  it('a legacy planted link row cannot carry an erasure across to another subject', async () => {
    const FT = 'user:adr0857-d1-legacy';
    const formId = await publishedForm(FT);
    expect((await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { values: { name: 'Bob', email: 'bob-legacy@example.com' } })).status).toBe(201);
    const bob = await findContactByEmail(FT, 'bob-legacy@example.com');
    expect(bob).toBeTruthy();
    // A row the pre-0857 writer COULD produce (planted directly — the writer no longer can).
    const raw = new DurableCollection<{ key: string; tenantId: string; sessionKey: string; contactId: string; source: string; at: string }>('analytics:identity-link', (l) => l.key);
    await raw.put({ key: `${FT}::alice-legacy@example.com`, tenantId: FT, sessionKey: 'alice-legacy@example.com', contactId: bob!.contactId, source: 'form-submit', at: new Date().toISOString() });
    await eraseSubject(FT, 'alice-legacy@example.com');
    expect(await findContactByEmail(FT, 'bob-legacy@example.com'), "erasing Alice must not erase Bob's contact").toBeTruthy();
  });

  it('a legal 40+ char key (a hex SDK session id) links and resolves — the grammar and the store see ONE string (review H1)', async () => {
    const T = 'user:adr0857-h1';
    const k = 'a'.repeat(8) + '0123456789abcdef'.repeat(4); // 72 chars, secret-shaped to scrubSecretShaped
    expect(isLinkableSessionKey(k)).toBe(true);
    expect(await linkSession(T, k, 'crm:h1', 'form-submit')).toMatchObject({ sessionKey: k });
    expect(await contactForSession(T, k)).toBe('crm:h1');
  });

  it('linkSession itself refuses a non-session key (both writers go through it)', async () => {
    expect(await linkSession('user:adr0857-d1-unit', 'carol@example.com', 'crm:x', 'email-click')).toBeNull();
    expect(await linkSession('user:adr0857-d1-unit', 'vk-ok', 'crm:x', 'email-click')).toMatchObject({ sessionKey: 'vk-ok' });
  });
});

describe('ADR 0857 A2/A3 — the grammar\'s neighbours', () => {
  it('an owx beacon on a non-linkable session does NOT burn the click token (claim happens after the grammar check)', async () => {
    const T = 'user:adr0857-a2';
    const { orgId } = await ownerWithOrg(T);
    const body = await instrumentBody('Go https://dest.example/a2 now', BASE, { tenantId: T, campaignId: 'cmp-a2', contactId: 'crm:a2', email: 'a2@example.com' });
    const clickUrl = body.match(/http:\/\/127\.0\.0\.1:\d+\/host\/openwop-app\/public-email\/c\/\S+/)?.[0];
    expect(clickUrl).toBeTruthy();
    const owx = new URL((await fetch(clickUrl!, { redirect: 'manual' })).headers.get('location') ?? '').searchParams.get('owx');
    expect(owx).toBeTruthy();
    expect((await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'mallory@example.com', owx })).status).toBe(201);
    // The real recipient's session still links — the token was not consumed.
    expect((await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'vk-a2-real', owx })).status).toBe(201);
    expect(await contactForSession(T, 'vk-a2-real')).toBe('crm:a2');
  });

  it('pins the subject-key resolver set — a new identity space must re-check the session grammar', () => {
    expect(
      registeredSubjectKeyResolverNames().sort(),
      'A new subject-key resolver was registered. ADR 0857 D1 is safe only while no other identity space mints keys matching `isLinkableSessionKey` — check its key shapes, then add its name here.',
    ).toEqual(['identityLinkResolver', 'kicktodoCoreResolver', 'resolveCrmSubjectKeys', 'usersEmailKeyResolver']);
  });
});

describe('ADR 0857 D2 — the workflow surface projects the same shape the route does', () => {
  it('events() never carries visitorHash / clickIds / owx / experiment / tenantId', async () => {
    const T = 'user:adr0857-d2';
    await recordEvent({ tenantId: T, orgId: 'o-d2', visitorHash: 'h'.repeat(64), raw: {
      type: 'pageview', path: '/p', sessionKey: 'vk-d2', owx: 'tok:abc', clickIds: { gclid: 'G-1' }, utm: { source: 'news' },
    } });
    expect((await listEvents(T, 'o-d2')).length).toBe(1);
    const surface = buildAnalyticsSurface({ tenantId: T });
    const out = await surface.events!({ orgId: 'o-d2' }) as { events: Record<string, unknown>[] };
    expect(out.events).toHaveLength(1);
    const row = out.events[0]!;
    for (const k of ['visitorHash', 'clickIds', 'owx', 'experiment', 'experimentDropped', 'tenantId']) expect(row, k).not.toHaveProperty(k);
    expect(row).toMatchObject({ type: 'pageview', path: '/p', sessionKey: 'vk-d2', utm: { source: 'news' } });
  });
});

describe('ADR 0857 D3 — the beacon honours consent recorded through the public lane', () => {
  it('a visitor-recorded refusal blocks the beacon under opt-out; a grant opens it under opt-in', async () => {
    const T = 'user:adr0857-d3';
    const { orgId } = await ownerWithOrg(T);
    try {
      await enable('consent', 'on');
      await setPolicy(T, { defaultMode: 'opt-out' });
      // The visitor's banner records an analytics REFUSAL and keeps the token.
      const refused = await pub.post<ConsentBody>(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: false } });
      expect(refused.status, JSON.stringify(refused.body)).toBe(201);
      const token = refused.body.subjectToken;
      const denied = await pub.post<{ recorded?: boolean; reason?: string }>(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'vk-d3', consentToken: token });
      expect(denied.status, JSON.stringify(denied.body)).toBe(202);
      expect(denied.body).toMatchObject({ recorded: false, reason: 'consent' });
      expect((await listEvents(T, orgId)).length, 'a 202 must store nothing').toBe(0);

      // Opt-in: a granted token opens the beacon; an absent one stays closed.
      await setPolicy(T, { defaultMode: 'opt-in' });
      const granted = await pub.post<ConsentBody>(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
      expect((await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'vk-d3b' })).status).toBe(202);
      const ok = await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'vk-d3b', consentToken: granted.body.subjectToken });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    } finally { await enable('consent', 'off'); }
  });

  it('a granting token does not resurrect tracking on an erasure-tombstoned session key (A1)', async () => {
    const T = 'user:adr0857-a1';
    const { orgId } = await ownerWithOrg(T);
    try {
      await enable('consent', 'on');
      await setPolicy(T, { defaultMode: 'opt-in' });
      const granted = await pub.post<ConsentBody>(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
      await writeErasureTombstone(T, 'vk-erased');
      const r = await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'vk-erased', consentToken: granted.body.subjectToken });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      expect((await listEvents(T, orgId)).length).toBe(0);
    } finally { await enable('consent', 'off'); }
  });

  it('a supplied-but-invalid token is a typed 400, never a silent fall-back to the session key', async () => {
    const T = 'user:adr0857-d3-bad';
    const { orgId } = await ownerWithOrg(T);
    for (const bad of ['', 'publicconsent:v1:forged', 7]) {
      const r = await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'vk-bad', consentToken: bad });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
    }
    expect((await listEvents(T, orgId)).length).toBe(0);
  });
});

describe('ADR 0857 D4 — the two un-purged analytics stores age out', () => {
  it('isoWeekEnd is the following Monday 00:00Z, including a week 1 that starts in the prior calendar year (A4)', () => {
    expect(isoWeekEnd('2020-W01')).toBe('2020-01-06T00:00:00.000Z'); // W01 = 2019-12-30 .. 2020-01-05
    expect(isoWeekEnd('2026-W53')).toBe('2027-01-04T00:00:00.000Z');
    expect(isoWeekEnd('2021-W01')).toBe('2021-01-11T00:00:00.000Z'); // 2021-W01 starts 2021-01-04
    // Round-trip against the writer's own labeller over a span of days.
    for (let d = Date.UTC(2019, 11, 20); d < Date.UTC(2021, 0, 20); d += 86_400_000) {
      const label = isoWeek(new Date(d));
      const end = Date.parse(isoWeekEnd(label)!);
      expect(end > d && end - d <= 7 * 86_400_000, `${new Date(d).toISOString()} → ${label}`).toBe(true);
    }
    expect(isoWeekEnd('garbage')).toBeUndefined();
  });

  it('identity links and nav counts older than the cutoff are deleted; newer ones stay', async () => {
    const T = 'user:adr0857-d4';
    const links = new DurableCollection<{ key: string; tenantId: string; sessionKey: string; contactId: string; source: string; at: string }>('analytics:identity-link', (l) => l.key);
    await links.put({ key: `${T}::vk-old`, tenantId: T, sessionKey: 'vk-old', contactId: 'crm:o', source: 'form-submit', at: '2020-01-01T00:00:00.000Z' });
    await linkSession(T, 'vk-new', 'crm:n', 'form-submit');
    await recordNav(T, '/crm', 'sidebar', new Date('2020-01-08T00:00:00.000Z'));
    await recordNav(T, '/crm', 'sidebar');
    await purgeRetained(T, 'confidential-pii', '2024-01-01T00:00:00.000Z');
    await purgeRetained(T, 'internal', '2024-01-01T00:00:00.000Z');
    expect(await contactForSession(T, 'vk-old')).toBeNull();
    expect(await contactForSession(T, 'vk-new')).toBe('crm:n');
    const old = await navReport(T, 1, new Date('2020-01-08T00:00:00.000Z'));
    expect(old.rows, 'the 2020 week must be purged').toEqual([]);
    expect((await navReport(T)).rows).toEqual([{ route: '/crm', source: 'sidebar', count: 1 }]);
  });
});

describe('ADR 0857 D6 — the agents pack rides the real registered tool (ANLWF-10, the CFP-1 class)', () => {
  it('the allowlist is exactly the registered query tool, and that tool survives the chat filter', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../packs/vendor.openwop-app.analytics.agents/pack.json', import.meta.url), 'utf8')) as { agents: { toolAllowlist: string[] }[] };
    expect(manifest.agents).toHaveLength(1);
    expect(manifest.agents[0]!.toolAllowlist).toEqual([ANALYTICS_QUERY_TOOL_ID]);
    expect(builtinAgentToolIds()).toContain(ANALYTICS_QUERY_TOOL_ID);
  });
});
