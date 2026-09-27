/**
 * Identity floor — deterministic session↔contact link (ADR 0226 / D4):
 *   - link write/read is last-writer-wins per session and tenant-isolated;
 *   - the GDPR erasure cascade (consent deleteSubject → subject-erasure seam)
 *     removes link rows by sessionKey AND by contactId;
 *   - the public form submit with a `sessionKey` writes the link (consent-gated
 *     on `analytics`, the beacon's own gate);
 *   - instrumented email clicks land on `dest?owx=<token>`; the beacon echoes
 *     `owx` and writes the link (tenant must match); recordClick still 302s;
 *   - attribution rows gain `knownContactConversions` ADDITIVE beside
 *     `webConversions`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { linkSession, contactForSession, eraseSubjectLinks, sessionsForContact } from '../src/features/analytics/identityLinkService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import { instrumentBody, deleteSubjectEngagement, claimClickTokenForSession } from '../src/features/email/engagementService.js';
import { recordEvent } from '../src/features/analytics/analyticsService.js';
import { buildAttribution } from '../src/features/campaign-intel/attribution.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'analytics']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const pub = client();
let n = 0;
/** Authed owner whose HOME tenant is pinned (ADR 0026 seam) so service-level
 *  asserts can address the same tenant the org rides on. */
async function ownerWithOrg(tenantId: string): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const su = await owner.post('/host/openwop-app/test/login', { email: `idlink-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

const T = 'user:idlink-test';

describe('ADR 0226 — link table (deterministic only)', () => {
  it('writes/reads a link, last-writer-wins per session, tenant-isolated', async () => {
    expect(await linkSession(T, 'sess-1', 'ct-a', 'form-submit')).toMatchObject({ contactId: 'ct-a', source: 'form-submit' });
    expect(await contactForSession(T, 'sess-1')).toBe('ct-a');
    // Last-writer-wins: ONE link per session — the newest deterministic evidence.
    await linkSession(T, 'sess-1', 'ct-b', 'email-click');
    expect(await contactForSession(T, 'sess-1')).toBe('ct-b');
    // Tenant isolation: the same session key under another tenant is unlinked.
    expect(await contactForSession('user:idlink-other', 'sess-1')).toBeNull();
    // Empty inputs are inert no-ops (best-effort writers).
    expect(await linkSession(T, '', 'ct-a', 'form-submit')).toBeNull();
    expect(await contactForSession(T, '')).toBeNull();
  });

  it('erasure cascade: consent deleteSubject removes links by sessionKey AND by contactId', async () => {
    // By sessionKey (the anonymous side is the erased subject).
    await linkSession(T, 'sess-erase-a', 'ct-e1', 'form-submit');
    await deleteSubject(T, 'sess-erase-a'); // fans out through the subject-erasure seam
    expect(await contactForSession(T, 'sess-erase-a')).toBeNull();
    // By contactId (the CRM side is the erased subject).
    await linkSession(T, 'sess-erase-b', 'ct-e2', 'email-click');
    await deleteSubject(T, 'ct-e2');
    expect(await contactForSession(T, 'sess-erase-b')).toBeNull();
    // Direct eraser: other tenants' rows are untouched.
    await linkSession(T, 'sess-keep', 'ct-keep', 'form-submit');
    await linkSession('user:idlink-other2', 'sess-keep', 'ct-keep', 'form-submit');
    await eraseSubjectLinks(T, 'ct-keep');
    expect(await contactForSession(T, 'sess-keep')).toBeNull();
    expect(await contactForSession('user:idlink-other2', 'sess-keep')).toBe('ct-keep');
  });

  it('WF-ANL-8: the ADR 0381 resolver reads FRESH — a peer instance\'s link cannot be missed', async () => {
    // A second Cloud Run instance writing a link does NOT invalidate THIS
    // process's 60s snapshot, so an erasure fielded here used to resolve a
    // SHORT key closure and silently under-erase while still reporting clean.
    // Simulate the peer by writing through an independent handle on the same
    // namespace — the same storage, no in-process invalidation.
    const T8 = 'user:idlink-wfanl8';
    await linkSession(T8, 'sess-primed', 'ct-8', 'form-submit'); // primes + invalidates
    expect(await sessionsForContact(T8, 'ct-8')).toEqual(['sess-primed']); // snapshot now warm
    const peer = new DurableCollection<{ key: string; tenantId: string; sessionKey: string; contactId: string; source: string; at: string }>(
      'analytics:identity-link', (l) => l.key,
    );
    await peer.put({ key: `${T8}::sess-peer`, tenantId: T8, sessionKey: 'sess-peer', contactId: 'ct-8', source: 'form-submit', at: new Date().toISOString() });
    // The STALE read still cannot see it — the defect is real, not hypothetical.
    expect(await sessionsForContact(T8, 'ct-8')).toEqual(['sess-primed']);
    // The FRESH read (what the resolver now uses) does.
    expect((await sessionsForContact(T8, 'ct-8', { fresh: true })).sort()).toEqual(['sess-peer', 'sess-primed']);
    // …and end-to-end: erasing the CONTACT reaches the peer-written session's
    // analytics rows, which the stale closure would have left behind.
    await recordEvent({ tenantId: T8, orgId: 'o8', raw: { type: 'pageview', sessionKey: 'sess-peer', path: '/peer' } });
    await deleteSubject(T8, 'ct-8');
    expect(await contactForSession(T8, 'sess-peer')).toBeNull();
    const { listEvents } = await import('../src/features/analytics/analyticsService.js');
    expect(await listEvents(T8, 'o8')).toEqual([]);
  });
});

describe('ADR 0226 — form-submit writer', () => {
  const FORM = {
    title: 'Contact us',
    createToContact: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'email', required: true },
    ],
  };
  const makePublishedForm = async (tenantId: string): Promise<string> => {
    const { owner, orgId } = await ownerWithOrg(tenantId);
    const form = (await owner.post(`/host/openwop-app/forms/orgs/${orgId}/forms`, FORM)).body;
    const pubd = await owner.patch(`/host/openwop-app/forms/orgs/${orgId}/forms/${form.formId}/status`, { status: 'published' });
    expect(pubd.status, JSON.stringify(pubd.body)).toBe(200);
    return form.formId;
  };

  it('public submit with a sessionKey links the created contact', async () => {
    const FT = 'user:idlink-forms';
    const formId = await makePublishedForm(FT);
    const sub = await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, {
      values: { name: 'Ada', email: 'ada-link@example.com' }, sessionKey: 'sess-form-1',
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const contactId = await contactForSession(FT, 'sess-form-1');
    expect(contactId).toBeTruthy();
    // No sessionKey ⇒ no link (and no error) — purely additive.
    const plain = await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, { values: { name: 'Bea', email: 'bea-link@example.com' } });
    expect(plain.status).toBe(201);
  });

  it('is consent-gated on `analytics` (the beacon\'s own gate)', async () => {
    const FT = 'user:idlink-forms-consent';
    const formId = await makePublishedForm(FT);
    try {
      await enable('consent', 'on'); // no record + opt-in default ⇒ analytics denied
      const sub = await pub.post(`/host/openwop-app/public-forms/${formId}/submit`, {
        values: { name: 'Cy', email: 'cy-link@example.com' }, sessionKey: 'sess-form-2',
      });
      expect(sub.status).toBe(201); // the submit itself always succeeds
      expect(await contactForSession(FT, 'sess-form-2')).toBeNull(); // but no link
    } finally { await enable('consent', 'off'); }
  });
});

describe('ADR 0226 — email-click (owx) beacon writer', () => {
  it('owx rides the destination; the beacon writes the link; recordClick still 302s', async () => {
    const BT = 'user:idlink-beacon';
    const { orgId } = await ownerWithOrg(BT);
    const body = await instrumentBody('Go https://dest.example/landing now', BASE, {
      tenantId: BT, campaignId: 'cmp-owx', contactId: 'ct-owx', email: 'owx@example.com',
    });
    const clickUrl = body.match(new RegExp(`${BASE.replace(/[/.:]/g, (c) => `\\${c}`)}/host/openwop-app/public-email/c/[^\\s]+`))?.[0];
    expect(clickUrl).toBeTruthy();
    const click = await fetch(clickUrl!, { redirect: 'manual' });
    expect(click.status).toBe(302);
    const location = click.headers.get('location') ?? '';
    expect(location.startsWith('https://dest.example/landing?owx=')).toBe(true);
    const owx = new URL(location).searchParams.get('owx');
    expect(owx?.startsWith('tok:')).toBe(true);
    // The opaque token is the ONLY thing riding the URL — never PII.
    expect(location).not.toContain('owx@example.com');
    expect(location).not.toContain('ct-owx');
    // The destination page's beacon echoes owx → the link is written.
    const beacon = await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, {
      type: 'pageview', path: '/landing', sessionKey: 's-owx', owx,
    });
    expect(beacon.status, JSON.stringify(beacon.body)).toBe(201);
    expect(await contactForSession(BT, 's-owx')).toBe('ct-owx');

    // ANLWF-1 / ADR 0651 D1 — the SAME token from a DIFFERENT session must not link.
    // The click-token row bound to nothing but tenant+contact, never expired and was
    // never consumed, and `sessionKey` is caller-chosen — so a forwarded newsletter's
    // token plus any session key durably linked that session to the original
    // recipient's contact, and the ADR 0381 DSAR resolver then expanded the
    // recipient's erasure to a stranger's history. The cross-tenant negative below
    // was read as protection; the SAME-tenant forge is the hole. The token is now
    // CLAIMED by the first session that links through it; a later mismatch still
    // records the event (capture-before-effect) and writes NO link.
    const forged = await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, {
      type: 'pageview', path: '/landing', sessionKey: 's-forged', owx,
    });
    expect(forged.status, 'the EVENT still lands — refusing it would make the token an oracle').toBe(201);
    expect(await contactForSession(BT, 's-forged'), 'a foreign session must NOT be linked through a token another session claimed').toBeNull();
    // …and the legitimate claimant keeps its link.
    expect(await contactForSession(BT, 's-owx')).toBe('ct-owx');

    // ANL-20 (grade-code 2026-09-10) — the claim planted an ANALYTICS session key in
    // `email:engagement-token`, a store whose eraser matched only contactId/email.
    // A DSAR arriving in the session-key space (exactly what the ADR 0381 resolver
    // produces) deleted nothing there and the receipt was green. The claimed row
    // must go with the session — and go entirely (un-claiming would re-open the
    // token to the next holder).
    expect(await claimClickTokenForSession(owx!, 's-owx'), 'precondition: the claimant still resolves').not.toBeNull();
    const erased = await deleteSubjectEngagement(BT, 's-owx');
    expect(erased.removed, 'the claimed token row is erased by the SESSION key').toBeGreaterThanOrEqual(1);
    expect(erased.failed).toBe(0);
    expect(await claimClickTokenForSession(owx!, 's-owx'), 'the token is gone, not merely un-claimed').toBeNull();
    expect(await claimClickTokenForSession(owx!, 's-third'), 'nobody can re-claim an erased token').toBeNull();
  });

  it('never links across tenants (token tenant must match the beacon tenant)', async () => {
    const AT = 'user:idlink-token-owner';
    const BT2 = 'user:idlink-beacon-other';
    const { orgId } = await ownerWithOrg(BT2);
    const body = await instrumentBody('See https://dest.example/x', BASE, {
      tenantId: AT, campaignId: 'cmp-x', contactId: 'ct-x', email: 'x@example.com',
    });
    const clickUrl = body.match(new RegExp(`${BASE.replace(/[/.:]/g, (c) => `\\${c}`)}/host/openwop-app/public-email/c/[^\\s]+`))?.[0];
    const click = await fetch(clickUrl!, { redirect: 'manual' });
    const owx = new URL(click.headers.get('location') ?? 'https://x.invalid/').searchParams.get('owx');
    expect(owx).toBeTruthy();
    // Beacon under ANOTHER tenant's org carrying tenant A's token: recorded, not linked.
    const beacon = await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, {
      type: 'pageview', sessionKey: 's-cross', owx,
    });
    expect(beacon.status).toBe(201);
    expect(await contactForSession(BT2, 's-cross')).toBeNull();
    expect(await contactForSession(AT, 's-cross')).toBeNull();
  });

  it('a bogus owx is inert (best-effort — the beacon write never fails)', async () => {
    const BT3 = 'user:idlink-bogus';
    const { orgId } = await ownerWithOrg(BT3);
    const beacon = await pub.post(`/host/openwop-app/public-analytics/${orgId}/collect`, {
      type: 'event', name: 'x', sessionKey: 's-bogus', owx: 'tok:not-a-real-token',
    });
    expect(beacon.status).toBe(201);
    expect(await contactForSession(BT3, 's-bogus')).toBeNull();
  });
});

describe('ADR 0226 — attribution knownContactConversions', () => {
  const KERNEL = {
    headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
    tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
  };
  it('counts only conversions whose session resolves — additive beside webConversions', async () => {
    const AT = 'user:idlink-attr';
    const ORG = 'org-idlink-attr';
    const brief = await createBrief(AT, ORG, 'test', {
      name: 'Linked', objective: 'o', productName: 'p', personaIds: ['x'],
      messaging: { primaryValueProp: 'v' },
      channels: [{ type: 'ad_variants', enabled: true, config: {} }],
      utm: { campaign: 'linked-launch' },
    });
    await setKernel(AT, brief.id, KERNEL);
    await updateBrief(AT, brief.id, { status: 'confirmed' }, 'test');
    const campaign = await finalizeFromBrief(AT, { ...brief, kernel: KERNEL, status: 'confirmed' as const, utm: { campaign: 'linked-launch' } }, 'test');

    await recordEvent({ tenantId: AT, orgId: ORG, raw: { type: 'conversion', sessionKey: 'sA', utm: { campaign: 'linked-launch' } } });
    await recordEvent({ tenantId: AT, orgId: ORG, raw: { type: 'conversion', sessionKey: 'sB', utm: { campaign: 'linked-launch' } } });
    await recordEvent({ tenantId: AT, orgId: ORG, raw: { type: 'conversion', utm: { campaign: 'linked-launch' } } }); // sessionless
    await linkSession(AT, 'sA', 'ct-known', 'form-submit');

    const report = await buildAttribution(AT, ORG);
    const row = report.rows.find((r) => r.campaignId === campaign.id);
    expect(row).toBeTruthy();
    expect(row!.webConversions).toBe(3);
    expect(row!.knownContactConversions).toBe(1); // additive subset, never a replacement
  });
});
