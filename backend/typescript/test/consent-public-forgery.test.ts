/**
 * CONS-2 — an unauthenticated caller could FORGE or WIPE any subject's consent,
 * and read it. CONS-3 — a form EMAIL opt-in silently GRANTED sms and push.
 *
 * CONS-2. `POST /v1/host/openwop-app/public-consent/:orgId` took `subjectKey`
 * from the request BODY with no proof-of-possession and called `recordConsent`,
 * which REPLACES the stored record wholesale. That keyspace is shared with CRM
 * contactIds, `User.userId`s, email addresses and (since ADR 0394) raw E.164
 * numbers, so anyone who knew a subject key could flip `marketing:false` to
 * `true` and drop every per-channel specific. `GET …/:subjectKey` was the
 * matching anonymous oracle. No test exercised forgery in either direction.
 *
 * CONS-3. `formsConsentSink` wrote a fresh record `{ necessary, analytics: prior,
 * marketing: true, 'marketing.email': true }` — hand-preserving `analytics` and
 * dropping any recorded `marketing.sms:false` / `marketing.push:false`.
 * `isAllowed` falls back to the umbrella when a specific is ABSENT, so a
 * dropped `false` became ALLOW: a person who used the preference centre to turn
 * SMS off became SMS-mailable by ticking an EMAIL checkbox. The existing sink
 * test asserted preservation of `analytics` ONLY — the assertion shape that
 * made this invisible — so the cases here widen it to every specific.
 *
 * THE REFUSAL MUST HAVE AN EXIT. Public capture is the only path the host
 * ships, so a fix that merely blocked unauthenticated writes would leave the
 * feature with no way in at all. The first case pins that mint-then-reuse works
 * end-to-end with no prior state.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { isAllowed, recordConsent, getConsent, listConsent, setPolicy, __resetConsentStore } from '../src/features/consent/consentService.js';
import { PUBLIC_SUBJECT_PREFIX, mintPublicSubjectToken } from '../src/features/consent/publicSubjectToken.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'consent']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> } {
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
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

const anon = client();
let n = 0;
let TENANT = '';

async function newOrg(): Promise<string> {
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `forge-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  TENANT = su.body.tenantId ?? org.body.tenantId ?? '';
  // A blank tenant would make every `recordConsent` / `isAllowed` below address
  // the SAME empty keyspace and the forgery cases would pass vacuously.
  expect(TENANT, 'the harness must resolve a real tenant').toBeTruthy();
  return org.body.orgId as string;
}

const PUB = (orgId: string): string => `/v1/host/openwop-app/public-consent/${orgId}`;

describe('CONS-2 — the public lane cannot address an authed subject', () => {
  it('the exit exists: mint-then-reuse works with no prior state', async () => {
    const orgId = await newOrg();
    const mint = await anon.post(PUB(orgId), { categories: { analytics: true } });
    expect(mint.status).toBe(201);
    expect(typeof mint.body.subjectToken).toBe('string');
    const read = await anon.get(`${PUB(orgId)}/${encodeURIComponent(mint.body.subjectToken)}`);
    expect(read.body.recorded).toBe(true);
    expect(read.body.categories.analytics).toBe(true);
  });

  it('a body `subjectKey` is REFUSED (400) and names the replacement — never silently ignored', async () => {
    const orgId = await newOrg();
    const res = await anon.post(PUB(orgId), { subjectKey: 'crm:victim', categories: { marketing: true } });
    expect(res.status).toBe(400);
    // Ignoring it would let the caller believe they recorded consent for a
    // person they did not — a fabrication with a green status code.
    expect(String(res.body?.message)).toMatch(/subjectToken/);
  });

  it('THE FORGERY: an anonymous caller cannot overwrite a recorded revocation', async () => {
    const orgId = await newOrg();
    // The victim's revocation, recorded through the authed/in-process lane
    // exactly as CRM or the preference centre would write it.
    await recordConsent({ tenantId: TENANT, subjectKey: 'crm:victim', categories: { marketing: false, 'marketing.sms': false }, source: 'preference-center' });
    expect(await isAllowed(TENANT, 'crm:victim', 'marketing')).toBe(false);

    // Every shape an attacker has: the old body field, and a forged token whose
    // visitor id is the victim's key.
    expect((await anon.post(PUB(orgId), { subjectKey: 'crm:victim', categories: { marketing: true } })).status).toBe(400);
    expect((await anon.post(PUB(orgId), { subjectToken: 'v1.crm:victim.deadbeef', categories: { marketing: true } })).status).toBe(400);
    expect((await anon.post(PUB(orgId), { subjectToken: `v1.${'0'.repeat(8)}-0000-0000-0000-000000000000.forged`, categories: { marketing: true } })).status).toBe(400);

    // The revocation stands, byte for byte.
    const still = await getConsent(TENANT, 'crm:victim');
    expect(still!.categories.marketing).toBe(false);
    expect(still!.categories['marketing.sms']).toBe(false);
    expect(still!.source).toBe('preference-center');
    expect(await isAllowed(TENANT, 'crm:victim', 'marketing')).toBe(false);
  });

  it('THE ORACLE: the anonymous read discloses nothing without a valid token', async () => {
    const orgId = await newOrg();
    await recordConsent({ tenantId: TENANT, subjectKey: 'crm:victim2', categories: { marketing: true }, source: 'crm' });
    // A raw subject key is not a token, so it 404s uniformly — never a 200
    // reporting the victim's categories, and never a 400 that would confirm
    // which tokens are well-formed for this tenant.
    const probe = await anon.get(`${PUB(orgId)}/crm%3Avictim2`);
    expect(probe.status).toBe(404);
    expect(JSON.stringify(probe.body ?? {})).not.toContain('marketing');
  });

  it('a token minted for one tenant does not resolve in another', async () => {
    const orgA = await newOrg();
    const tenantA = TENANT;
    const orgB = await newOrg();
    const minted = mintPublicSubjectToken(tenantA);
    expect((await anon.post(PUB(orgA), { subjectToken: minted.token, categories: { analytics: true } })).status).toBe(201);
    expect((await anon.post(PUB(orgB), { subjectToken: minted.token, categories: { analytics: true } })).status).toBe(400);
    expect(minted.subjectKey.startsWith(PUBLIC_SUBJECT_PREFIX)).toBe(true);
  });
});

/**
 * Review F1 — the arms the suite above did NOT have.
 *
 * Every case there sent a WELL-FORMED-BUT-WRONG token (`v1.crm:victim.deadbeef`,
 * a forged signature, another tenant's token), so all of them exercised the
 * `verifyPublicSubjectToken` → 400 leg. NOT ONE sent a falsy-but-present value,
 * and that is the leg that was broken: the route read `optionalString(body
 * .subjectToken)`, which collapses `""`, `"   "`, `null`, `0` and `{}` to
 * `undefined`, so each one fell to the MINT branch and returned 201 with a
 * fresh identity. The forgery cases could not see it because a forged token is
 * a non-empty string.
 *
 * The consequence is CONS-1's shape re-created one route over: the visitor's
 * recorded opt-OUT stays under the abandoned key, `isAllowed` finds neither a
 * record nor a tombstone for the newly minted one, and returns the fail-open
 * `opt-out` policy default — a recorded refusal read as a permission, 201,
 * `ok:true`, unauthenticated.
 */
describe('CONS-2 / review F1 — a falsy `subjectToken` is a 400, never a silent re-mint', () => {
  // The exact shapes a real banner emits. `localStorage.getItem(k) ?? ''` after
  // a storage clear is the empty string; a serializer that keeps null keys
  // sends `null`. Neither is a caller asking to be given a new identity — they
  // are a caller who BELIEVES they are addressing an existing record.
  const FALSY_SHAPES: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['null', null],
    ['number zero', 0],
    ['boolean false', false],
    ['object', {}],
    ['array', []],
  ];

  for (const [label, value] of FALSY_SHAPES) {
    it(`refuses a \`subjectToken\` of ${label} — 400, and mints NOTHING`, async () => {
      const orgId = await newOrg();
      const res = await anon.post(PUB(orgId), { subjectToken: value, categories: { marketing: true } });
      expect(res.status, `subjectToken:${JSON.stringify(value)} — ${JSON.stringify(res.body)}`).toBe(400);
      // A 400 that still handed back an identity would be the same fabrication
      // wearing a red status code.
      expect(res.body?.subjectToken).toBeUndefined();
      // And nothing reached the store: a mint writes a record before it answers.
      expect(await listConsent(TENANT)).toEqual([]);
    });
  }

  it('THE SCENARIO END-TO-END: a cleared localStorage cannot turn an opt-OUT into an allow', async () => {
    const orgId = await newOrg();
    // The tenant's posture is the permissive one — this is what makes a missing
    // record read as ALLOW, and it is a legitimate operator choice, not a bug.
    await setPolicy(TENANT, { defaultMode: 'opt-out' });

    // The visitor arrives with no token, is minted one, and opts OUT of marketing.
    const first = await anon.post(PUB(orgId), { categories: { marketing: false } });
    expect(first.status).toBe(201);
    const tokenA = first.body.subjectToken as string;
    const visitorA = (await listConsent(TENANT))[0]!.subjectKey;
    expect(visitorA.startsWith(PUBLIC_SUBJECT_PREFIX)).toBe(true);
    expect(await isAllowed(TENANT, visitorA, 'marketing')).toBe(false);

    // Storage is cleared. The banner sends `?? ''` on the next page load.
    const second = await anon.post(PUB(orgId), { subjectToken: '', categories: { marketing: true } });
    expect(second.status, JSON.stringify(second.body)).toBe(400);

    // No second identity exists, so there is nothing for the fail-open default
    // to answer for. Before the fix this list held TWO rows and the second one
    // was `marketing:true`.
    const rows = await listConsent(TENANT);
    expect(rows.map((r) => r.subjectKey)).toEqual([visitorA]);
    expect(await isAllowed(TENANT, visitorA, 'marketing')).toBe(false);

    // The exit the 400 names actually works: the visitor can re-mint on purpose
    // by OMITTING the field, and can still reach their own record with the
    // token they held. Both halves — a refusal with no way forward would be its
    // own defect (Art. 7(3): withdrawal as easy as giving).
    expect(String(second.body?.message)).toMatch(/omit the field/i);
    const reuse = await anon.post(PUB(orgId), { subjectToken: tokenA, categories: { analytics: true } });
    expect(reuse.status).toBe(201);
    expect((await listConsent(TENANT)).map((r) => r.subjectKey)).toEqual([visitorA]);
  });

  it('a whitespace-PADDED valid token is accepted, not 400ed (the stated trim decision)', async () => {
    const orgId = await newOrg();
    const mint = await anon.post(PUB(orgId), { categories: { analytics: true } });
    expect(mint.status).toBe(201);
    const padded = `  ${mint.body.subjectToken as string}\n`;
    // `verifyPublicSubjectToken` trims, so the POST body lane and the GET
    // path-param lane cannot disagree. Without the trim this 400s on
    // `parts[0] === '  v1'` — a refusal for a token that is, in every sense the
    // visitor can act on, theirs.
    const again = await anon.post(PUB(orgId), { subjectToken: padded, categories: { marketing: true } });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    // ONE identity, not two — the padded token resolved to the SAME visitor.
    expect(await listConsent(TENANT)).toHaveLength(1);
    expect((await listConsent(TENANT))[0]!.categories.analytics).toBe(true);
  });
});

describe('CONS-3 — a partial write must never GRANT by omission', () => {
  it('an email-only grant preserves EVERY recorded specific, not just analytics', async () => {
    await __resetConsentStore();
    const T = 'tCons3';
    const d = getToggleDefault('consent');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    // The subject used the preference centre: analytics on, sms + push OFF.
    await recordConsent({
      tenantId: T,
      subjectKey: 'contact-9',
      categories: { analytics: true, marketing: false, 'marketing.sms': false, 'marketing.push': false },
      source: 'preference-center',
    });

    // …then ticks an EMAIL opt-in checkbox on a form. The sink speaks to two
    // categories; it must speak to no others.
    const { mergeConsentCategories } = await import('../src/features/consent/consentService.js');
    await mergeConsentCategories({
      tenantId: T, subjectKey: 'contact-9',
      categories: { marketing: true, 'marketing.email': true },
      legalBasis: 'consent', source: 'form-optin:f1',
    });

    expect(await isAllowed(T, 'contact-9', 'marketing.email'), 'the grant they gave').toBe(true);
    // THE finding: on `origin/main` both of these are TRUE, because the sink
    // dropped the recorded `false` and `isAllowed` falls back to the umbrella.
    expect(await isAllowed(T, 'contact-9', 'marketing.sms'), 'sms was refused').toBe(false);
    expect(await isAllowed(T, 'contact-9', 'marketing.push'), 'push was refused').toBe(false);
    // …and the one the old test DID check still holds.
    expect(await isAllowed(T, 'contact-9', 'analytics')).toBe(true);
    // whatsapp stays strict-explicit regardless (ADR 0394).
    expect(await isAllowed(T, 'contact-9', 'marketing.whatsapp')).toBe(false);
  });

  it('the workflow surface `record` is a partial update too, not a wholesale write', async () => {
    await __resetConsentStore();
    const T = 'tCons3wf';
    const d = getToggleDefault('consent');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    await recordConsent({ tenantId: T, subjectKey: 's1', categories: { analytics: true, 'marketing.sms': false }, source: 'preference-center' });

    const { buildConsentSurface } = await import('../src/features/consent/surface.js');
    const surface = buildConsentSurface({ tenantId: T });
    await surface.record!({ subjectKey: 's1', categories: { marketing: true } });

    expect(await isAllowed(T, 's1', 'marketing')).toBe(true);
    expect(await isAllowed(T, 's1', 'marketing.sms'), 'the node never spoke to sms').toBe(false);
    expect(await isAllowed(T, 's1', 'analytics'), 'nor to analytics').toBe(true);
  });
});

describe('CONS-18 — the subject key is bounded', () => {
  it('rejects an empty and an oversized key on BOTH write paths', async () => {
    const { recordConsent: rc, mergeConsentCategories: mc } = await import('../src/features/consent/consentService.js');
    const long = 'x'.repeat(257);
    for (const key of ['', '   ', long]) {
      await expect(rc({ tenantId: 't18', subjectKey: key, categories: {}, source: 'test' })).rejects.toThrow(/subjectKey/);
      await expect(mc({ tenantId: 't18', subjectKey: key, categories: {}, source: 'test' })).rejects.toThrow(/subjectKey/);
    }
    // …and the real shapes all still pass: a UUID, a crm: contactId, an email,
    // an E.164 number, a minted visitor key. A charset ban would have broken
    // every one of these that contains `:`.
    for (const key of ['9f1b2c3d-0000-4000-8000-000000000000', 'crm:jane', 'jane@example.com', '+15551230000', 'visitor:9f1b2c3d-0000-4000-8000-000000000000']) {
      const rec = await rc({ tenantId: 't18', subjectKey: key, categories: { analytics: true }, source: 'test' });
      expect(rec.subjectKey).toBe(key);
    }
  });
});

describe('CONS-9 — listConsent is a BOUNDED per-tenant read', () => {
  it('returns only this tenant\'s rows, including against a prefix NEIGHBOUR', async () => {
    const { recordConsent: rc, listConsent: lc } = await import('../src/features/consent/consentService.js');
    // `ws:acme` is a prefix of `ws:acme-corp`. The scan prefix is `${tenantId}:`
    // — the trailing separator is what makes `ws:acme:` not match
    // `ws:acme-corp:s2`, so this case is closed by the KEY SHAPE.
    await rc({ tenantId: 'ws:acme', subjectKey: 's1', categories: {}, source: 'test' });
    await rc({ tenantId: 'ws:acme-corp', subjectKey: 's2', categories: {}, source: 'test' });
    const mine = await lc('ws:acme');
    expect(mine.map((r) => r.subjectKey)).toEqual(['s1']);
    // fail-closed on a falsy tenant — never a global scan
    expect(await lc('')).toEqual([]);
  });

  it('the belt-and-braces tenant filter catches a row whose BODY disagrees with its key', async () => {
    // WHY THIS CASE EXISTS. The obvious version — "a prefix neighbour cannot
    // leak in" — passed with the filter REMOVED, because the trailing `:` in
    // the scan prefix already handles it. A sabotage probe that comes back
    // green is a finding about the test, so the assertion moved to what the
    // filter actually guards: a row filed under one tenant's key prefix whose
    // stored `tenantId` says another. That is the shape a bad migration, a
    // tenant fold/rekey, or a hand-repaired row produces, and it is exactly the
    // case a prefix scan alone cannot see.
    const { listConsent: lc } = await import('../src/features/consent/consentService.js');
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const raw = new DurableCollection<{ tenantId: string; subjectKey: string; categories: unknown; source: string; ts: string }>(
      'consent:record', (r) => `ws:victim:${r.subjectKey}`,
    );
    await raw.put({ tenantId: 'ws:attacker', subjectKey: 'planted', categories: { necessary: true }, source: 'x', ts: new Date().toISOString() });
    expect((await lc('ws:victim')).map((r) => r.subjectKey)).toEqual([]);
  });
});
