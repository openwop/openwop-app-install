/**
 * Email engagement (ADR 0218 / campaign gap plan C4):
 *   - instrumentBody rewrites URLs to tracked redirects + appends the
 *     unsubscribe line, with NO PII riding any link;
 *   - the public click route records + 302s; unknown tokens 404;
 *   - unsubscribe cascades: engagement row + marketing-consent revocation +
 *     crm:suppression row; idempotent;
 *   - stats roll up clicks/uniqueClicks/unsubscribes;
 *   - the suppressed recipient is skipped on the next campaign send.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { instrumentBody, recordClick, recordUnsubscribe, engagementStats, listEngagement, mintToken, renderHtmlBody } from '../src/features/email/engagementService.js';
import { isSuppressed } from '../src/features/crm/suppressionService.js';
import { getConsent } from '../src/features/consent/consentService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const T = 'user:engagement-test';
const MINT = { tenantId: T, campaignId: 'cmp-1', contactId: 'ct-1', email: 'ada@example.com' };

describe('ADR 0218 — engagement tracking', () => {
  it('instruments the body (tracked links + unsubscribe, zero PII in URLs)', async () => {
    const body = 'Fresh beans: https://solstice.example/shop?ref=nl and https://solstice.example/story';
    const out = await instrumentBody(body, BASE, MINT);
    expect(out).not.toContain('https://solstice.example/shop?ref=nl');
    expect(out).toContain(`${BASE}/host/openwop-app/public-email/c/`);
    expect(out).toContain(`${BASE}/host/openwop-app/public-email/u/`);
    expect(out).toContain('Unsubscribe:');
    // ADR 0227: the preference-center line rides beside the unsubscribe line.
    expect(out).toContain(`${BASE}/host/openwop-app/public-email/p/`);
    expect(out).toContain('Preferences:');
    expect(out).not.toContain('ada@example.com');
    expect(out).not.toContain('ct-1');
  });

  it('click route records + 302s; unknown token 404s; unsubscribe cascades and is idempotent', async () => {
    const body = await instrumentBody('Visit https://solstice.example/shop today', BASE, MINT);
    const clickUrl = body.match(new RegExp(`${BASE.replace(/[/.:]/g, (c) => `\\${c}`)}/host/openwop-app/public-email/c/[^\\s]+`))?.[0];
    const unsubUrl = body.match(new RegExp(`${BASE.replace(/[/.:]/g, (c) => `\\${c}`)}/host/openwop-app/public-email/u/[^\\s]+`))?.[0];
    expect(clickUrl && unsubUrl).toBeTruthy();

    // Click: public, no session, 302 to the original destination — which now
    // carries the opaque `owx` click token (ADR 0226) and nothing else.
    const click = await fetch(clickUrl!, { redirect: 'manual' });
    expect(click.status).toBe(302);
    const location = click.headers.get('location') ?? '';
    expect(location.startsWith('https://solstice.example/shop?owx=tok%3A')).toBe(true);
    expect(location).not.toContain('ada@example.com');
    expect(location).not.toContain('ct-1');
    const unknown = await fetch(`${BASE}/host/openwop-app/public-email/c/tok:nope`, { redirect: 'manual' });
    expect(unknown.status).toBe(404);

    // Unsubscribe (grade-code AUDIT-3): GET is a scanner-safe CONFIRM page that
    // MUST NOT mutate; the POST performs the opt-out (RFC 8058 one-click).
    const unsubGet = await fetch(unsubUrl!);
    expect(unsubGet.status).toBe(200);
    const confirmHtml = await unsubGet.text();
    expect(confirmHtml).toContain('<form method="post"'); // renders a confirm form, not "unsubscribed"
    expect(await isSuppressed(T, 'ada@example.com')).toBe(false); // GET did NOT mutate

    // POST performs it: consent revoked + suppression added; second POST is a no-op.
    const unsub1 = await fetch(unsubUrl!, { method: 'POST' });
    expect(unsub1.status).toBe(200);
    expect(await unsub1.text()).toContain('unsubscribed');
    const unsub2 = await fetch(unsubUrl!, { method: 'POST' });
    expect(unsub2.status).toBe(200);

    expect(await isSuppressed(T, 'ada@example.com')).toBe(true);
    const consent = await getConsent(T, 'ct-1');
    expect(consent?.categories.marketing).toBe(false);

    const stats = await engagementStats(T, 'cmp-1');
    expect(stats.clicks).toBeGreaterThanOrEqual(1);
    expect(stats.uniqueClicks).toBe(1);
    expect(stats.unsubscribes).toBe(1); // idempotent — one row despite two follows

    const rows = await listEngagement(T, 'cmp-1');
    expect(rows.some((r) => r.kind === 'clicked' && r.url?.startsWith('https://solstice.example/shop?owx='))).toBe(true);
  });

  it('service-level guards: unknown tokens are inert', async () => {
    expect(await recordClick('tok:missing')).toBeNull();
    // EM-2: the outcome is discriminated now — an unknown token is 'unknown',
    // which the route 404s, and is NOT the same as a write that failed.
    expect(await recordUnsubscribe('tok:missing')).toEqual({ status: 'unknown', unenforced: [] });
  });
});

describe('ENG-1 — click redirect is http(s)-only at the sink', () => {
  it('404s (never 302s) a stored click token whose URL is a dangerous scheme', async () => {
    // Seed a click token directly with a javascript: URL (the mint regex would
    // never produce this, but the sink must not trust the store).
    const bad = await mintToken({ tenantId: T, campaignId: 'cmp-eng1', contactId: 'ct-eng1', kind: 'click', url: 'javascript:alert(document.cookie)' });
    const res = await fetch(`${BASE}/host/openwop-app/public-email/c/${encodeURIComponent(bad)}`, { redirect: 'manual' });
    expect(res.status).toBe(404); // rejected — no open redirect to a non-http scheme
    expect(res.headers.get('location')).toBeNull();
  });

  it('still 302s a normal https destination', async () => {
    const ok = await mintToken({ tenantId: T, campaignId: 'cmp-eng1', contactId: 'ct-eng1', kind: 'click', url: 'https://solstice.example/ok' });
    const res = await fetch(`${BASE}/host/openwop-app/public-email/c/${encodeURIComponent(ok)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')?.startsWith('https://solstice.example/ok')).toBe(true);
  });
});

describe('ENG-2 — public POST forms reject a present cross-origin Origin', () => {
  it('rejects a cross-origin Origin on the preferences POST, allows same-origin and absent', async () => {
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-eng2', contactId: 'ct-eng2', kind: 'preferences', email: 'eng2@example.com' });
    const url = `${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(tok)}`;
    const form = 'email=on';
    const hdrs = { 'content-type': 'application/x-www-form-urlencoded' };

    // A PRESENT, cross-origin Origin → 403 (defense-in-depth).
    const cross = await fetch(url, { method: 'POST', headers: { ...hdrs, origin: 'https://evil.example' }, body: form });
    expect(cross.status).toBe(403);

    // Same-origin Origin (host matches) → allowed.
    const host = new URL(BASE).host;
    const same = await fetch(url, { method: 'POST', headers: { ...hdrs, origin: `http://${host}` }, body: form });
    expect(same.status).toBe(200);

    // Absent Origin (RFC 8058 server-to-server / privacy-stripped) → allowed.
    const absent = await fetch(url, { method: 'POST', headers: hdrs, body: form });
    expect(absent.status).toBe(200);
  });

  it('rejects a cross-origin Origin on the unsubscribe POST but allows an absent one (RFC 8058 one-click)', async () => {
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-eng2', contactId: 'ct-eng2b', kind: 'unsubscribe', email: 'eng2b@example.com' });
    const url = `${BASE}/host/openwop-app/public-email/u/${encodeURIComponent(tok)}`;
    const cross = await fetch(url, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    const absent = await fetch(url, { method: 'POST' });
    expect(absent.status).toBe(200); // no Origin → one-click still works
  });

  it('accepts the configured public base host even when it differs from the request Host (Firebase→Cloud Run proxy)', async () => {
    // Simulate the proxy: the browser Origin is the public host, but Express
    // sees a different (internal) Host. The configured base must be allowed.
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.openwop.dev';
    try {
      const tok = await mintToken({ tenantId: T, campaignId: 'cmp-eng2', contactId: 'ct-eng2c', kind: 'preferences', email: 'eng2c@example.com' });
      const url = `${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(tok)}`;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://app.openwop.dev' }, body: 'email=on' });
      expect(res.status).toBe(200); // public-base host matches the Origin, though req Host is 127.0.0.1
    } finally {
      delete process.env.OPENWOP_PUBLIC_BASE_URL;
    }
  });
});

describe('CMPUX-16 — public pages localize from Accept-Language', () => {
  const withLocales = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.OPENWOP_I18N_LOCALES;
    process.env.OPENWOP_I18N_LOCALES = 'en,es,fr,pt-BR';
    try { await fn(); } finally { if (prev === undefined) delete process.env.OPENWOP_I18N_LOCALES; else process.env.OPENWOP_I18N_LOCALES = prev; }
  };

  it('renders the unsubscribe + preference pages in the recipient browser locale, English by default', async () => {
    const uTok = await mintToken({ tenantId: T, campaignId: 'cmp-i18n', contactId: 'ct-i18n', kind: 'unsubscribe', email: 'i18n@example.com' });
    const pTok = await mintToken({ tenantId: T, campaignId: 'cmp-i18n', contactId: 'ct-i18n', kind: 'preferences', email: 'i18n@example.com' });
    const uUrl = `${BASE}/host/openwop-app/public-email/u/${encodeURIComponent(uTok)}`;
    const pUrl = `${BASE}/host/openwop-app/public-email/p/${encodeURIComponent(pTok)}`;

    await withLocales(async () => {
      // pt-BR browser → Portuguese unsubscribe page + lang tag.
      const pt = await (await fetch(uUrl, { headers: { 'accept-language': 'pt-BR,pt;q=0.9' } })).text();
      expect(pt).toContain('Cancelar inscrição');
      expect(pt).toContain('lang="pt-BR"');
      expect(pt).not.toContain('>Unsubscribe<');

      // es browser → Spanish preference page.
      const es = await (await fetch(pUrl, { headers: { 'accept-language': 'es-ES,es;q=0.9' } })).text();
      expect(es).toContain('Preferencias de comunicación');
      expect(es).toContain('lang="es"');

      // A locale with no catalog (de) → falls back to the host default (English).
      const de = await (await fetch(uUrl, { headers: { 'accept-language': 'de-DE,de;q=0.9' } })).text();
      expect(de).toContain('lang="en"');
      expect(de).toContain('>Unsubscribe<');
    });
  });

  it('stays English when the host has not configured i18n (honesty gate)', async () => {
    const prev = process.env.OPENWOP_I18N_LOCALES;
    delete process.env.OPENWOP_I18N_LOCALES; // unconfigured host
    try {
      const tok = await mintToken({ tenantId: T, campaignId: 'cmp-i18n', contactId: 'ct-i18n2', kind: 'unsubscribe', email: 'i18n2@example.com' });
      const html = await (await fetch(`${BASE}/host/openwop-app/public-email/u/${encodeURIComponent(tok)}`, { headers: { 'accept-language': 'pt-BR' } })).text();
      expect(html).toContain('lang="en"'); // unadvertised → English, not half-localized
      expect(html).toContain('>Unsubscribe<');
    } finally { if (prev !== undefined) process.env.OPENWOP_I18N_LOCALES = prev; }
  });
});

describe('ADR 0242 — HTML render + open pixel', () => {
  it('renderHtmlBody escapes the body (XSS gate), linkifies tracked URLs, and includes the pixel', () => {
    const instrumented = 'Hi <script>alert(1)</script> "quote"\n\nVisit https://host/host/openwop-app/public-email/c/tok:x now';
    const html = renderHtmlBody(instrumented, 'https://host/host/openwop-app/public-email/o/tok:o');
    // Escaped — no raw script tag survives.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // The tracked URL became an anchor.
    expect(html).toContain('<a href="https://host/host/openwop-app/public-email/c/tok:x">');
    // Paragraphs on the blank line.
    expect(html).toContain('<p ');
    // The open pixel is present.
    expect(html).toContain('<img src="https://host/host/openwop-app/public-email/o/tok:o" width="1" height="1"');
  });

  it('the pixel route serves a 1x1 GIF and records an open; an unknown token still serves a GIF (no record)', async () => {
    const tok = await mintToken({ tenantId: T, campaignId: 'cmp-open', contactId: 'ct-open', kind: 'open' });
    const url = `${BASE}/host/openwop-app/public-email/o/${encodeURIComponent(tok)}`;

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/gif');
    expect((res.headers.get('cache-control') ?? '')).toContain('no-store');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x47); expect(bytes[1]).toBe(0x49); expect(bytes[2]).toBe(0x46); // 'GIF'

    // Re-open (real) — two opens, one unique.
    await fetch(url);
    const stats = await engagementStats(T, 'cmp-open');
    expect(stats.opens).toBe(2);
    expect(stats.uniqueOpens).toBe(1);

    // Unknown token → still a GIF, no new open recorded.
    const unknown = await fetch(`${BASE}/host/openwop-app/public-email/o/tok:nope`);
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get('content-type')).toContain('image/gif');
    expect((await engagementStats(T, 'cmp-open')).opens).toBe(2);
  });
});
