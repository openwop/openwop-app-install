/**
 * ADR 0748 — RFC 0206 on this host: the RFC 0103 §D admin ops over the CMS
 * kernel, credential-derived delivery, the script-family negotiation step, the
 * error-catalog fallback, and the v2 `i18n` + `content` records.
 *
 * The route block replays the corpus scenario `v2-content-locale-keys` (the
 * `openwop.requirement.0206.delivery-extended-locale` row) step for step, and
 * validates every body against the vendored v2 schemas, so a passing run here is
 * the same evidence the scenario collects — minus the corpus harness.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppConfig } from '../src/index.js';
import { negotiateLocale, localizeErrorEnvelope, hostContentLocales } from '../src/host/i18n/index.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { isCredentialOptionalRead } from '../src/middleware/auth.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const V2 = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2');
const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (a: unknown) => void)(ajv);
for (const f of readdirSync(V2)) {
  if (!f.endsWith('.json')) continue;
  try { ajv.addSchema(JSON.parse(readFileSync(join(V2, f), 'utf8')) as Record<string, unknown>, f); } catch { /* duplicate $id */ }
}
function schema(name: string) {
  const fn = ajv.getSchema(`https://openwop.dev/spec/v2/${name}.schema.json`);
  if (!fn) throw new Error(`${name} did not register — validation would be vacuous`);
  return (doc: unknown): string[] => (fn(doc) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`));
}

// ── Pure: negotiation + error catalog ─────────────────────────────────────────

describe('negotiateLocale — the RFC 0206 script step', () => {
  it('prefers the script family before the language family', () => {
    expect(negotiateLocale('zh-Hant-TW', ['en', 'zh-Hans', 'zh-Hant'], 'en')).toBe('zh-Hant');
    // no bare `zh-Hant`, but a sibling carrying the same script beats `zh-Hans`
    expect(negotiateLocale('zh-Hant-TW', ['en', 'zh-Hans', 'zh-Hant-HK'], 'en')).toBe('zh-Hant-HK');
  });
  it('extended tags negotiate exactly, and a language match still falls to the family', () => {
    expect(negotiateLocale('es-419', ['en', 'es', 'es-419'], 'en')).toBe('es-419');
    expect(negotiateLocale('es-MX', ['en', 'es-419'], 'en')).toBe('es-419');
    expect(negotiateLocale('fil', ['en', 'fil'], 'en')).toBe('fil');
  });
  it('leaves every pre-RFC-0206 negotiation unchanged', () => {
    expect(negotiateLocale('pt-BR,pt;q=0.9', ['en', 'pt-BR'], 'en')).toBe('pt-BR');
    expect(negotiateLocale('pt-PT', ['en', 'pt-BR'], 'en')).toBe('pt-BR');
    expect(negotiateLocale('de', ['en', 'pt-BR'], 'en')).toBe('en');
  });
});

describe('localizeErrorEnvelope — exact → script → language, naming the column used', () => {
  const env: Parameters<typeof localizeErrorEnvelope>[0] = { error: 'not_found', message: 'Not found.' };
  it('answers es-419 from the es column and says `es`, not `es-419`', () => {
    const { envelope, localized } = localizeErrorEnvelope(env, 'es-419');
    expect(localized).toBe(true);
    expect(envelope.message).toBe('Recurso no encontrado.');
    expect(envelope.details?.locale).toBe('es');
  });
  it('fr-CA uses fr; a locale with no column is not localized', () => {
    expect(localizeErrorEnvelope(env, 'fr-CA').envelope.details?.locale).toBe('fr');
    expect(localizeErrorEnvelope(env, 'zh-Hant-TW').localized).toBe(false);
    expect(localizeErrorEnvelope(env, 'en').localized).toBe(false);
  });
});

describe('isCredentialOptionalRead — exact method and depth', () => {
  it('admits only GET/HEAD of one page by slug', () => {
    expect(isCredentialOptionalRead('GET', '/v1/content/pages/home')).toBe(true);
    expect(isCredentialOptionalRead('HEAD', '/v1/content/pages/home')).toBe(true);
    expect(isCredentialOptionalRead('POST', '/v1/content/pages/home')).toBe(false);
    expect(isCredentialOptionalRead('GET', '/v1/content/pages')).toBe(false);
    expect(isCredentialOptionalRead('PUT', '/v1/content/pages/p/sections/s')).toBe(false);
    expect(isCredentialOptionalRead('GET', '/v1/content/pages/p/sections/s')).toBe(false);
    expect(isCredentialOptionalRead('GET', '/v1/content/settings')).toBe(false);
  });
});

// ── v2 advertisement ──────────────────────────────────────────────────────────

const CONFIG = { serviceName: 'test', serviceVersion: '0.0.1' } as unknown as AppConfig;

describe('v2 `i18n` + `content` records', () => {
  it('are absent when no content locales are configured', () => {
    const saved = process.env.OPENWOP_I18N_LOCALES;
    delete process.env.OPENWOP_I18N_LOCALES;
    try {
      const doc = buildV2Advertisement(CONFIG);
      expect(doc.i18n).toBeUndefined();
      expect(doc.content).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.OPENWOP_I18N_LOCALES = saved;
    }
  });

  it('validate, carry the extended tag, and hold the RFC 0103 §A invariants', () => {
    const saved = process.env.OPENWOP_I18N_LOCALES;
    process.env.OPENWOP_I18N_LOCALES = 'en,pt-BR,es-419';
    try {
      const doc = buildV2Advertisement(CONFIG);
      const errors = schema('capabilities')(doc);
      expect(errors, errors.join('\n')).toEqual([]);
      const i18n = doc.i18n as { defaultLocale: string; supportedLocales: string[] };
      const content = doc.content as { baseLocale: string; supportedLocales: string[]; witness: string };
      expect(content.witness).toBe('witnessable-gated');
      expect(content.baseLocale).toBe(i18n.defaultLocale);
      expect(content.supportedLocales).not.toContain(content.baseLocale);
      for (const l of content.supportedLocales) expect(i18n.supportedLocales).toContain(l);
      expect(content.supportedLocales).toEqual(['pt-BR', 'es-419']);
      expect(content.supportedLocales).toEqual(hostContentLocales());
    } finally {
      if (saved === undefined) delete process.env.OPENWOP_I18N_LOCALES; else process.env.OPENWOP_I18N_LOCALES = saved;
    }
  });
});

// ── Routes: the corpus scenario, replayed ─────────────────────────────────────

let BASE: string;
let server: http.Server;
const OP = 'k-op-0748-operator';     // wildcard operator key (the conformance harness posture)
const TB = 'k-tb-0748-tenant-b';     // a key scoped to tenant-b
const saved: Record<string, string | undefined> = {};

async function call(method: string, path: string, opts: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? OP}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

beforeAll(async () => {
  for (const k of ['OPENWOP_I18N_LOCALES', 'OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE']) saved[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_I18N_LOCALES = 'en,pt-BR,es-419';
  process.env.OPENWOP_API_KEYS = `${OP}:*,${TB}:tenant-b`;
  // The strict posture: no credential → 401 everywhere EXCEPT the one
  // credential-optional read, which must still answer anonymously.
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  // …without the enterprise `auth` posture's KMS/durable-store boot requirements.
  process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('RFC 0206 delivery-extended-locale — the scenario flow', () => {
  const tag = 'es-419';
  const pageId = 'rfc0206-probe';
  const slug = 'rfc0206-probe';

  it('creates a published page, writes base + extended overlay, and delivers the overlay', async () => {
    const created = await call('POST', '/v1/content/pages', { body: { pageId, slug, name: 'RFC 0206 probe', status: 'published', sectionOrder: ['hero'] } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(schema('localized-content-page')(created.json)).toEqual([]);
    expect(created.json).toMatchObject({ pageId, slug, status: 'published', sectionOrder: ['hero'] });

    const base = await call('PUT', `/v1/content/pages/${pageId}/sections/hero`, { body: { locale: 'en', data: { heading: 'base', cta: 'base-cta' } } });
    expect(base.status, JSON.stringify(base.json)).toBe(200);
    const over = await call('PUT', `/v1/content/pages/${pageId}/sections/hero`, { body: { locale: tag, data: { heading: `overlay:${tag}` } } });
    expect(over.status, JSON.stringify(over.json)).toBe(200);
    expect(schema('localized-content-section')(over.json)).toEqual([]);
    expect(over.json).toMatchObject({ sectionId: 'hero', sectionType: 'fields', data: { heading: 'base', cta: 'base-cta' }, localizations: { [tag]: { heading: `overlay:${tag}` } }, status: 'published', order: 0 });

    const res = await call('GET', `/v1/content/pages/${slug}`, { headers: { 'accept-language': tag } });
    expect(res.status).toBe(200);
    expect(schema('localized-content-page-response')(res.json)).toEqual([]);
    expect(res.headers.get('content-language')).toBe(tag);
    const hero = res.json.sections.find((s: { sectionId: string }) => s.sectionId === 'hero');
    expect(hero.data).toEqual({ heading: `overlay:${tag}`, cta: 'base-cta' });
    // a tenant's content is never publicly cacheable
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('vary')).toMatch(/Authorization/);
  });

  it('serves the same ops under major 2 (the unversioned rewrite)', async () => {
    const res = await call('GET', `/content/pages/${slug}`, { headers: { 'accept-language': 'es-MX', 'openwop-version': '2' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-language')).toBe(tag); // es-MX → family → es-419
    const list = await call('GET', '/content/pages', { headers: { 'openwop-version': '2' } });
    expect(list.status).toBe(200);
    for (const p of list.json) expect(schema('localized-content-page')(p)).toEqual([]);
    expect(list.json.map((p: { pageId: string }) => p.pageId)).toContain(pageId);
  });

  it('settings are the effective (advertised) ones and validate', async () => {
    const res = await call('GET', '/v1/content/settings');
    expect(res.status).toBe(200);
    expect(schema('localized-content-language-settings')(res.json)).toEqual([]);
    expect(res.json).toEqual({ baseLocale: 'en', supportedLocales: ['pt-BR', 'es-419'], autoTranslateOnPublish: false });
  });

  it('§F: the page is unreachable from another tenant and from the anonymous lane', async () => {
    expect((await call('GET', `/v1/content/pages/${slug}`, { key: TB })).status).toBe(404);
    expect((await call('GET', `/v1/content/pages/${slug}`, { key: null })).status).toBe(404);
    // …while the anonymous lane still serves the system site, publicly cacheable
    const home = await call('GET', '/v1/content/pages/home', { key: null });
    expect(home.status).toBe(200);
    expect(schema('localized-content-page-response')(home.json)).toEqual([]);
    expect(home.headers.get('cache-control')).toMatch(/^public/);
  });

  it('a presented-but-rejected bearer is a 401, never the anonymous lane', async () => {
    expect((await call('GET', '/v1/content/pages/home', { key: 'not-a-key' })).status).toBe(401);
  });

  it('admin ops never ride the carve-out: no credential → 401', async () => {
    expect((await call('POST', '/v1/content/pages', { key: null, body: { pageId: 'x', slug: 'x', name: 'x', sectionOrder: [] } })).status).toBe(401);
    expect((await call('GET', '/v1/content/pages', { key: null })).status).toBe(401);
    expect((await call('PUT', `/v1/content/pages/${pageId}/sections/hero`, { key: null, body: { locale: 'en', data: {} } })).status).toBe(401);
    expect((await call('GET', '/v1/content/settings', { key: null })).status).toBe(401);
    // deleteContentPage shares delivery's path item; only GET/HEAD there is credential-optional.
    expect((await call('DELETE', `/v1/content/pages/${pageId}`, { key: null })).status).toBe(401);
  });

  it('a tenant-pinned env key authors in ITS OWN tenant only (ADR 0601 C4; ADR 0748 correction)', async () => {
    // Corrected: this leg used to assert 403 and call it fail-closed. An env key
    // is its tenant's own principal, so the 403 was a gate defect — it is what
    // the production certify binding hit on every §D write.
    const r = await call('POST', '/v1/content/pages', { key: TB, body: { pageId: 'tb-1', slug: 'tb-one', name: 'x', sectionOrder: [], status: 'published' } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await call('GET', '/v1/content/pages/tb-one', { key: TB })).status).toBe(200);
    expect((await call('GET', '/v1/content/pages/tb-one')).status).toBe(404); // not in the operator's tenant
  });
});

describe('protocol create never adapts what the caller addressed', () => {
  it('409 on an existing pageId and on a taken slug; never a renamed slug', async () => {
    const body = { pageId: 'dup-1', slug: 'dup-one', name: 'Dup', sectionOrder: [] };
    expect((await call('POST', '/v1/content/pages', { body })).status).toBe(201);
    expect((await call('POST', '/v1/content/pages', { body })).status).toBe(409);
    expect((await call('POST', '/v1/content/pages', { body: { ...body, pageId: 'dup-2' } })).status).toBe(409);
  });
  it('400 on malformed input', async () => {
    const ok = { pageId: 'v-1', slug: 'v-one', name: 'V', sectionOrder: [] };
    expect((await call('POST', '/v1/content/pages', { body: { ...ok, slug: 'Bad Slug' } })).status).toBe(400);
    expect((await call('POST', '/v1/content/pages', { body: { ...ok, slug: 'double--hyphen' } })).status).toBe(400);
    expect((await call('POST', '/v1/content/pages', { body: { ...ok, pageId: '../etc' } })).status).toBe(400);
    expect((await call('POST', '/v1/content/pages', { body: { ...ok, sectionOrder: ['a', 'a'] } })).status).toBe(400);
    expect((await call('POST', '/v1/content/pages', { body: { ...ok, status: 'archived' } })).status).toBe(400);
  });
  it('a draft page is created as draft and is not delivered', async () => {
    expect((await call('POST', '/v1/content/pages', { body: { pageId: 'd-1', slug: 'd-one', name: 'D', sectionOrder: ['s'], status: 'draft' } })).json.status).toBe('draft');
    expect((await call('PUT', '/v1/content/pages/d-1/sections/s', { body: { locale: 'en', data: { heading: 'draft' } } })).status).toBe(200);
    expect((await call('GET', '/v1/content/pages/d-one')).status).toBe(404);
  });
});

describe('section PUT validation', () => {
  it('rejects non-canonical locales, extra fields, and nested field values', async () => {
    await call('POST', '/v1/content/pages', { body: { pageId: 'val-1', slug: 'val-one', name: 'Val', sectionOrder: ['s'] } });
    const put = (body: unknown) => call('PUT', '/v1/content/pages/val-1/sections/s', { body });
    for (const locale of ['en-us', 'zh-hans', 'de-CH-1996', 'en_US']) expect((await put({ locale, data: { a: 'x' } })).status).toBe(400);
    expect((await put({ locale: 'en', data: { a: 'x' }, extra: 1 })).status).toBe(400);
    expect((await put({ locale: 'en', data: { a: { nested: true } } })).status).toBe(400);
    expect((await put({ locale: 'en', data: { 'bad key': 'x' } })).status).toBe(400);
    expect((await put({ locale: 'zh-Hant-TW', data: { a: 'x' } })).status).toBe(200);
  });
  it('404 for an unknown page; a new section id appends', async () => {
    expect((await call('PUT', '/v1/content/pages/nope/sections/s', { body: { locale: 'en', data: {} } })).status).toBe(404);
    const r = await call('PUT', '/v1/content/pages/val-1/sections/extra', { body: { locale: 'en', data: { a: 'y' } } });
    expect(r.status).toBe(200);
    expect(r.json.order).toBe(1);
  });
  it('delivery negotiates over the ADVERTISED locales only: an authored but unadvertised zh-Hant is not served', async () => {
    await call('POST', '/v1/content/pages', { body: { pageId: 'zh-1', slug: 'zh-one', name: 'Zh', sectionOrder: ['s'], status: 'published' } });
    await call('PUT', '/v1/content/pages/zh-1/sections/s', { body: { locale: 'en', data: { t: 'en' } } });
    await call('PUT', '/v1/content/pages/zh-1/sections/s', { body: { locale: 'zh', data: { t: 'zh' } } });
    await call('PUT', '/v1/content/pages/zh-1/sections/s', { body: { locale: 'zh-Hant', data: { t: 'zh-Hant' } } });
    // zh-* is authored but not advertised, so `Content-Language` may not name it
    // and the reader gets base. The §C script step itself is pinned by
    // locale-rfc0206-grammar.test.ts (resolveSection) and the negotiateLocale block above.
    const r = await call('GET', '/v1/content/pages/zh-one', { headers: { 'accept-language': 'zh-Hant-TW' } });
    expect(r.headers.get('content-language')).toBe('en');
    expect(r.json.sections[0].data).toEqual({ t: 'en' });
  });
});

describe('a shared-section reference is never silently written through', () => {
  it('409s instead of answering 200 for content the ref would drop', async () => {
    const { getPage, updatePage } = await import('../src/features/cms/cmsService.js');
    await call('POST', '/v1/content/pages', { body: { pageId: 'ref-1', slug: 'ref-one', name: 'Ref', sectionOrder: [] } });
    const page = await getPage('default', 'default', 'ref-1');
    expect(page).toBeTruthy();
    await updatePage('default', 'default', 'ref-1', { sections: [{ sectionId: 'sec:shared', type: 'hero', data: {}, ref: { sharedSectionId: 'shsec:x' } }], baseLocale: 'en' }, 'test');
    const r = await call('PUT', '/v1/content/pages/ref-1/sections/shared', { body: { locale: 'en', data: { heading: 'x' } } });
    expect(r.status).toBe(409);
  });
});

describe('the approval gate binds the protocol lane exactly as the editor', () => {
  async function setGate(status: 'on' | 'off'): Promise<void> {
    const d = getToggleDefault('cms-approval-gate');
    expect(d, 'cms-approval-gate must be declared').toBeTruthy();
    if (d) await saveConfig({ ...d, status }, 'test');
  }
  it('refuses a published create and a live edit while the gate is on', async () => {
    await call('POST', '/v1/content/pages', { body: { pageId: 'g-1', slug: 'g-one', name: 'G', sectionOrder: ['s'], status: 'published' } });
    await setGate('on');
    try {
      expect((await call('POST', '/v1/content/pages', { body: { pageId: 'g-2', slug: 'g-two', name: 'G', sectionOrder: [], status: 'published' } })).status).toBe(409);
      expect((await call('PUT', '/v1/content/pages/g-1/sections/s', { body: { locale: 'es-419', data: { a: 'x' } } })).status).toBe(409);
      // a draft is still authorable under the gate
      expect((await call('POST', '/v1/content/pages', { body: { pageId: 'g-3', slug: 'g-three', name: 'G', sectionOrder: [] } })).status).toBe(201);
    } finally {
      await setGate('off');
    }
  });
});
