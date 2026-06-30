/**
 * RFC 0103 normative public content delivery (ADR 0064 Phase 3) —
 * GET /v1/content/pages/{slug}. Projects the seeded system-site content in the
 * normative response shape, ANONYMOUSLY (public path), locale-negotiated over
 * the HOST-advertised set (capabilities.content), published-only. The seeded
 * home hero carries es/pt-BR overlays, so negotiation returns real translated
 * content + an honest Content-Language; a supported-but-unauthored locale (fr)
 * negotiates to fr yet falls back to base per-section.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;

// pt-BR / es hero overlays seeded in host/systemSite.ts (assert real merge).
const PT_HEADING = 'Colegas de IA que fazem trabalho de verdade — e continuam sendo seus.';
const ES_HEADING = 'Compañeros de IA que hacen trabajo real — y siguen siendo tuyos.';
const EN_HEADING = 'AI coworkers that do real work — and stay yours.';

interface Delivery {
  version: string; locale: string; slug: string;
  page: { name: string };
  sections: Array<{ sectionId: string; sectionType: string; data: Record<string, unknown>; order: number }>;
}
const get = async (al?: string): Promise<{ status: number; cl: string | null; body: Delivery }> => {
  const res = await fetch(`${BASE}/v1/content/pages/home`, al ? { headers: { 'accept-language': al } } : {});
  return { status: res.status, cl: res.headers.get('content-language'), body: (await res.json().catch(() => ({}))) as Delivery };
};
const heroHeading = (b: Delivery): unknown => b.sections.find((s) => s.sectionType === 'hero')?.data.heading;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  // Operator-configure the host content locales (drives capabilities + the
  // negotiation set the projection honors).
  process.env.OPENWOP_I18N_LOCALES = 'en,es,pt-BR,fr';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_I18N_LOCALES;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('GET /v1/content/pages/:slug — normative delivery (RFC 0103)', () => {
  it('serves the seeded system-site home ANONYMOUSLY in the normative shape (base)', async () => {
    const r = await get('en');
    expect(r.status).toBe(200);
    expect(r.cl).toBe('en');
    expect(r.body.version).toBe('1');
    expect(r.body.slug).toBe('home');
    expect(heroHeading(r.body)).toBe(EN_HEADING);
    for (const s of r.body.sections) {
      expect(typeof s.sectionType).toBe('string');
      expect(typeof s.order).toBe('number');
      expect((s as Record<string, unknown>).localizations).toBeUndefined(); // never leak overlays
    }
  });

  it('negotiates pt-BR → Content-Language pt-BR + translated hero', async () => {
    const r = await get('pt-BR,pt;q=0.9');
    expect(r.cl).toBe('pt-BR');
    expect(heroHeading(r.body)).toBe(PT_HEADING);
  });

  it('negotiates es (with q-values) → Content-Language es + translated hero', async () => {
    const r = await get('fr;q=0.3, es;q=0.9');
    expect(r.cl).toBe('es');
    expect(heroHeading(r.body)).toBe(ES_HEADING);
  });

  it('a supported-but-unauthored locale (fr) negotiates to fr yet falls back to base per-section', async () => {
    const r = await get('fr');
    expect(r.cl).toBe('fr');               // fr is advertised/supported → honest negotiated locale
    expect(heroHeading(r.body)).toBe(EN_HEADING); // no fr overlay → sparse fallback to base
  });

  it('an unsupported locale falls back to base; malformed never 400s', async () => {
    const de = await get('de');
    expect(de.cl).toBe('en');
    expect(heroHeading(de.body)).toBe(EN_HEADING);
    const bad = await get('!!!;;;q=zzz');
    expect(bad.status).toBe(200);
    expect(bad.cl).toBe('en');
  });

  it('404s an unknown slug and 400s a malformed one', async () => {
    expect((await fetch(`${BASE}/v1/content/pages/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${BASE}/v1/content/pages/Bad_Slug`)).status).toBe(400);
  });

  it('advertises §A-coherent capabilities.i18n + content (operator-configured)', async () => {
    const disc = await (await fetch(`${BASE}/.well-known/openwop`)).json() as {
      capabilities?: { content?: { supported: boolean; baseLocale: string; supportedLocales: string[] }; i18n?: { defaultLocale: string; supportedLocales: string[] } };
    };
    const i18n = disc.capabilities?.i18n; const content = disc.capabilities?.content;
    expect(content?.supported).toBe(true);
    expect(content?.baseLocale).toBe(i18n?.defaultLocale);            // §A: content.baseLocale == i18n.defaultLocale
    expect(content?.supportedLocales).not.toContain(content?.baseLocale); // §A: base ∉ content.supported
    for (const l of content?.supportedLocales ?? []) expect(i18n?.supportedLocales).toContain(l); // §A: content ⊆ i18n
  });
});
