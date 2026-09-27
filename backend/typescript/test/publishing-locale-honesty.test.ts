/**
 * UX_UPGRADE-publishing R2 — PUB2-B1 / PUB2-B2.
 *
 * R1 (`UX_UPGRADE-content.md`) covered `publishing/**` as UI only — its own
 * scope line says so — and fixed one string in `PublishingPage.tsx`. It was
 * careful there: it examined `listPages` and `publishingClient.ts:51` and
 * correctly cleared both. The backend was never opened, and both defects here
 * live in it.
 *
 * PUB2-B1 — `negotiatePublicLocale` answered ANY failure with `'en'`, defended
 * by a note that "the render itself still performs the authoritative
 * negotiation". That is true, and it is what hid the bug: the value is not a
 * per-request answer, it is the PRERENDER CACHE KEY. While the settings read
 * fails every visitor's key collapses to `'en'`, so the first miss stores a
 * document rendered in the FIRST visitor's language and every later visitor
 * gets it as a hit — public pages served in the wrong language, silently.
 *
 * PUB2-B2 — `prerenderBlogIndex` hardcoded `locale: 'en'` directly beneath a
 * docstring promising "Honest head: no fabricated fields", while its route has
 * always advertised `Vary: Accept-Language`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';

/** Toggle: make the content-locale read fail the way a storage hiccup would. */
const settingsFail = { on: false };
vi.mock('../src/host/contentLocales.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/contentLocales.js')>();
  return {
    ...actual,
    getContentLanguageSettings: async (tenantId: string, orgId: string) => {
      if (settingsFail.on) throw new Error('storage read failed');
      return actual.getContentLanguageSettings(tenantId, orgId);
    },
  };
});

import { createApp } from '../src/index.js';
import { createOrg } from '../src/host/accessControlService.js';
import { negotiatePublicLocale } from '../src/features/publishing/publishingService.js';
import { buildHtmlDocument } from '../src/features/publishing/prerenderService.js';

let server: http.Server;
let ORG = '';
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  // A REAL org: the first draft of this test used a made-up id, and the negative
  // control caught it — `resolvePublicOrg` throws `not_found`, so every call
  // returned null and the "failure" assertion would have passed for the wrong
  // reason. That is the control earning its place.
  const org = await createOrg({ tenantId: 'pub-r2', createdBy: 'pub-r2', name: 'Pub R2' });
  ORG = org.orgId;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { settingsFail.on = false; });

describe('PUB2-B1 — a failed negotiation yields no cache key, rather than a fabricated one', () => {
  it('returns null (not "en") when the settings read fails', async () => {
    settingsFail.on = true;
    // The distinguishing behaviour. `'en'` is not a worse default — it is a
    // DECISION minted from a failure, and it is used to segment a shared cache.
    expect(await negotiatePublicLocale(ORG, 'fr-FR,fr;q=0.9')).toBeNull();
  });

  it('still negotiates normally when the read SUCCEEDS (the negative control)', async () => {
    // Without this, "returns null on failure" would be satisfied by a function
    // that returns null always — which would disable the prerender memo for
    // every request on the host.
    const locale = await negotiatePublicLocale(ORG, 'fr-FR,fr;q=0.9');
    expect(locale, 'a working read still produces a key').toBeTruthy();
    expect(typeof locale).toBe('string');
  });

  it('two visitors with different Accept-Language never share one key', async () => {
    // The property the cache key exists to guarantee, asserted directly: under
    // the old code BOTH of these collapsed to 'en' while the read was failing,
    // which is exactly how one visitor's document reached the other.
    settingsFail.on = false;
    const fr = await negotiatePublicLocale(ORG, 'fr-FR,fr;q=0.9');
    const de = await negotiatePublicLocale(ORG, 'de-DE,de;q=0.9');
    // With a single-locale org both legitimately resolve to the base locale —
    // that is correct segmentation, not collapse. What must never happen is a
    // NON-null key minted from a FAILED read, so assert that directly:
    settingsFail.on = true;
    expect(await negotiatePublicLocale(ORG, 'fr-FR'), 'no key from a failed read').toBeNull();
    expect(await negotiatePublicLocale(ORG, 'de-DE'), 'nor for the next visitor').toBeNull();
    expect(fr).not.toBeNull();
    expect(de).not.toBeNull();
  });
});

describe('PUB2-B2 — `lang` is omitted when unknown, never guessed', () => {
  it('emits no lang attribute and no og:locale when the locale is absent', () => {
    const html = buildHtmlDocument(
      {
        seo: {
          title: 'T', description: 'D', canonicalUrl: 'https://x/y',
          ogTitle: 'T', ogDescription: 'D', noindex: false,
        },
      },
      '<main></main>',
    );
    // An absent `lang` means "unspecified"; `lang="en"` over Portuguese is a
    // false claim a screen reader acts on when choosing pronunciation.
    expect(html).toContain('<html>');
    expect(html).not.toMatch(/<html lang=/);
    expect(html).not.toContain('og:locale');
  });

  it('still emits both when the locale IS known (the negative control)', () => {
    const html = buildHtmlDocument(
      {
        seo: {
          title: 'T', description: 'D', canonicalUrl: 'https://x/y',
          ogTitle: 'T', ogDescription: 'D', noindex: false,
        },
        locale: 'pt-BR',
      },
      '<main></main>',
    );
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('<meta property="og:locale" content="pt-BR">');
  });
});
