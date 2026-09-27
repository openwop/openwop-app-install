/**
 * feature.cms.nodes — the CMS feature node pack over `ctx.features.cms` (ADR
 * 0064 Phase 3 / RFC 0103). Proves `get-page` reads a published page resolved
 * for a target locale (exact → family → base) over the feature surface, that
 * `translate-section` drafts an overlay via the run-scoped provider, and the
 * capability-missing backstops. Drives the node functions directly against a ctx
 * built from the real host bundle — the get-page path reads the seeded
 * SYSTEM-SITE home (host:site / host-site / home), whose hero carries es/pt-BR
 * overlays, so locale resolution is observable end-to-end.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { DEFAULT_HERO_HEADINGS, SYSTEM_SITE_ORG, SYSTEM_SITE_SLUG, SYSTEM_SITE_TENANT } from '../src/host/systemSite.js';
import {
  createPage, getContentLanguageSettings, getPublishedBySlug, localizePage, setLocalePublishState, updateContentLanguageSettings,
} from '../src/features/cms/cmsService.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pack: any;
let server: http.Server;

// hero overlays seeded in host/systemSite.ts (assert real locale resolution).
const PT_HEADING = DEFAULT_HERO_HEADINGS['pt-BR'];
const EN_HEADING = DEFAULT_HERO_HEADINGS.en;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  // @ts-expect-error — untyped .mjs pack module (loaded the way the runtime does)
  pack = await import('../../../packs/feature.cms.nodes/index.mjs');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const ctxFor = (inputs: Record<string, unknown>, callAI?: unknown) => ({
  inputs,
  features: buildHostSurfaceBundle({ tenantId: SYSTEM_SITE_TENANT }).features,
  ...(callAI ? { callAI } : {}),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const heroHeading = (page: any): unknown =>
  page.sections.find((s: { sectionType: string }) => s.sectionType === 'hero')?.data.heading;

describe('feature.cms.nodes', () => {
  // UX_UPGRADE-content R2 (CMS2-B2) — this test USED TO assert that asking for
  // `pt-BR` returned `locale:'pt-BR'` and the Portuguese hero, and it passed
  // because the surface hand-rolled its resolution with a bare `resolveSection`
  // instead of `localizePage`. It was pinning a DIVERGENCE: the system-site org
  // has never declared `supportedLocales` (default `[]`), so a real visitor
  // sending `Accept-Language: pt-BR` gets the ENGLISH page. The AI lane was the
  // only consumer being served the Portuguese — and being told, in the field a
  // model trusts, that `pt-BR` was the locale it got.
  //
  // CORRECTED (review CMS2-R4): the surface-vs-`localizePage` comparison below
  // is DOCUMENTATION, not the check. Since the fix IS `localizePage(hit.page,
  // …)` with the same inputs, both sides move together — a bug inside
  // `localizePage` is invisible to it. The discriminating assertion is the
  // absolute `toBe('en')` pin, which an earlier version of this comment
  // dismissed as "weaker". Keep both: the pin discriminates, the comparison
  // states the invariant the pin exists to protect.
  it('get-page agrees with the delivery lane for an UNDECLARED locale', async () => {
    const page = await getPublishedBySlug(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_SLUG);
    const settings = await getContentLanguageSettings(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
    expect(settings.supportedLocales).not.toContain('pt-BR'); // the precondition this test rests on
    const delivered = localizePage(page!.page, 'pt-BR', settings);

    const out = await pack.getPage(ctxFor({ orgId: SYSTEM_SITE_ORG, slug: SYSTEM_SITE_SLUG, locale: 'pt-BR' }));
    expect(out.status).toBe('success');
    // The locale the model is told it got is the one actually negotiated…
    expect(out.outputs.locale).toBe(delivered.locale);
    // …and the body is the one a visitor asking for pt-BR would be served.
    expect(heroHeading(out.outputs.page)).toBe(
      delivered.page.sections.find((s) => s.type === 'hero')?.data.heading,
    );
    expect(out.outputs.locale).toBe('en');
    // The surface never leaks the per-locale overlays.
    for (const s of out.outputs.page.sections) expect(s.localizations).toBeUndefined();
  });

  it('…and serves the pt-BR overlay once the org DECLARES pt-BR', async () => {
    // The other polarity: without this, the assertion above is satisfied by a
    // surface that can never return a non-base locale at all.
    await updateContentLanguageSettings(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, { supportedLocales: ['pt-BR'] }, 'test');
    try {
      const out = await pack.getPage(ctxFor({ orgId: SYSTEM_SITE_ORG, slug: SYSTEM_SITE_SLUG, locale: 'pt-BR' }));
      expect(out.outputs.locale).toBe('pt-BR');
      expect(heroHeading(out.outputs.page)).toBe(PT_HEADING);
    } finally {
      await updateContentLanguageSettings(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, { supportedLocales: [] }, 'test');
    }
  });

  it('withholds a locale held at `draft` — the AI lane is not a bypass', async () => {
    // CMS2-B2 proper: ADR 0205 D2 tells an admin the locale is held back from
    // DELIVERY. It was held back from visitors and served to models.
    await updateContentLanguageSettings(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, { supportedLocales: ['pt-BR'] }, 'test');
    try {
      const page = await getPublishedBySlug(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_SLUG);
      await setLocalePublishState(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, page!.page.pageId, 'pt-BR', 'draft', 'test');
      const out = await pack.getPage(ctxFor({ orgId: SYSTEM_SITE_ORG, slug: SYSTEM_SITE_SLUG, locale: 'pt-BR' }));
      expect(out.outputs.locale).toBe('en');
      expect(heroHeading(out.outputs.page)).toBe(EN_HEADING);
    } finally {
      const page = await getPublishedBySlug(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_SLUG);
      if (page) await setLocalePublishState(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, page.page.pageId, 'pt-BR', 'published', 'test');
      await updateContentLanguageSettings(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, { supportedLocales: [] }, 'test');
    }
  });

  it('get-page falls back to base when no locale is requested', async () => {
    const out = await pack.getPage(ctxFor({ orgId: SYSTEM_SITE_ORG, slug: SYSTEM_SITE_SLUG }));
    expect(out.status).toBe('success');
    expect(heroHeading(out.outputs.page)).toBe(EN_HEADING);
  });

  it('get-page returns a null page for an unknown slug', async () => {
    const out = await pack.getPage(ctxFor({ orgId: SYSTEM_SITE_ORG, slug: 'does-not-exist' }));
    expect(out.status).toBe('success');
    expect(out.outputs.page).toBeNull();
  });

  it('translate-section drafts an overlay from base data via the run-scoped provider', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const callAI = async (req: Record<string, unknown>) => {
      calls.push(req);
      return { content: '```json\n{"heading":"Olá mundo","ctaLabel":"Começar"}\n```' };
    };
    const out = await pack.translateSection(ctxFor(
      { data: { heading: 'Hello world', ctaLabel: 'Get started' }, targetLocale: 'pt-BR' },
      callAI,
    ));
    expect(out.status).toBe('success');
    expect(out.outputs.targetLocale).toBe('pt-BR');
    expect(out.outputs.overlay).toEqual({ heading: 'Olá mundo', ctaLabel: 'Começar' });
    // The prompt names the target language and carries the base JSON.
    expect(String((calls[0]!.messages as Array<{ content: string }>)[0]!.content)).toContain('Hello world');
  });

  it('translate-section fails closed without a targetLocale', async () => {
    const out = await pack.translateSection(ctxFor({ data: { heading: 'x' } }, async () => ({ content: '{}' })));
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('validation_error');
  });

  // ── CMS2-B4: a REFUSAL is not a success ──────────────────────────────────
  // The surface answers `{updated:false, reason}` / `{submitted:false, reason}`
  // for a page or section that isn't there. Both wrappers used to hand that
  // straight back under `status:'success'`, with `reason` not even declared in
  // pack.json's outputs — so a chain could not branch on it even deliberately.
  // The CHAT lane already returned a tool error for exactly this; the node lane
  // was left behind, and a run's terminal output claimed a translation had been
  // written and submitted for review when nothing had been written and no
  // approval row existed.

  it('update-section-draft FAILS on a refusal instead of reporting success', async () => {
    const out = await pack.updateSectionDraft(ctxFor({
      orgId: SYSTEM_SITE_ORG, pageId: 'page:does-not-exist', sectionId: 's1', data: { heading: 'x' },
    }));
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('not_found');
    // The reason rides the ERROR CODE, asserted above — NOT `outputs`, which
    // `tarballLoader` discards on a non-success return. The first version of
    // this test asserted `outputs.updated === false` and passed only because it
    // calls the raw pack function rather than the registered NodeModule: green
    // against an artifact no chain ever runs.
  });

  it('submit-page FAILS on a refusal instead of reporting a review that never queued', async () => {
    const out = await pack.submitPage(ctxFor({ orgId: SYSTEM_SITE_ORG, pageId: 'page:does-not-exist' }));
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('not_found');
  });

  it('update-section-draft still SUCCEEDS on a real write (the negative control)', async () => {
    // Without this the two arms above are satisfied by a wrapper that fails on
    // everything. Uses a fresh draft page so the write genuinely lands.
    const page = await createPage({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, title: 'Node write control',
      sections: [{ type: 'hero', data: { heading: 'base' } }], createdBy: 'test',
    });
    const out = await pack.updateSectionDraft(ctxFor({
      orgId: SYSTEM_SITE_ORG, pageId: page.pageId, sectionId: page.sections[0]!.sectionId, data: { heading: 'patched' },
    }));
    expect(out.status).toBe('success');
    expect(out.outputs.updated).toBe(true);
  });

  it('throws host_capability_missing when ctx.features.cms is absent', async () => {
    await expect(pack.getPage({ inputs: { slug: 'home' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.sample.cms' });
  });

  it('throws host_capability_missing (aiProviders) when ctx.callAI is absent', async () => {
    await expect(pack.translateSection({ inputs: { data: {}, targetLocale: 'pt-BR' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.aiProviders' });
  });
});

// ── ADR 0592 §7 (CMSLWF-4): invalid model output is a TYPED failure with ONE
// bounded error-fed repair — never success-with-empty. The old node returned
// `status:'success'` with `overlay:{}` for garbage, and the failure surfaced
// one node LATE as the store node's `empty` (misattributed locus).
describe('translate-section — typed failure + one bounded repair (ADR 0592 §7)', () => {
  it('repairs once on garbage, then succeeds when the repair lands', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const callAI = async (req: Record<string, unknown>) => {
      calls.push(req);
      return calls.length === 1
        ? { content: 'I would be happy to translate that for you!' }
        : { content: '{"heading":"Olá"}' };
    };
    const out = await pack.translateSection(ctxFor({ data: { heading: 'Hi' }, targetLocale: 'pt-BR' }, callAI));
    expect(out.status).toBe('success');
    expect(out.outputs.overlay).toEqual({ heading: 'Olá' });
    expect(calls.length).toBe(2);
    // The repair message is ERROR-FED: it carries the bad completion back.
    const repairMessages = calls[1]!.messages as Array<{ role: string; content: string }>;
    expect(repairMessages.some((m) => m.role === 'assistant' && /happy to translate/.test(m.content))).toBe(true);
  });

  it('fails TYPED (invalid_model_output) when the repair also returns garbage — exactly two calls, then honest failure', async () => {
    const calls: unknown[] = [];
    const callAI = async (req: unknown) => { calls.push(req); return { content: 'still not JSON' }; };
    const out = await pack.translateSection(ctxFor({ data: { heading: 'Hi' }, targetLocale: 'pt-BR' }, callAI));
    expect(out.status).toBe('failed');
    expect(out.error.code).toBe('invalid_model_output');
    expect(calls.length).toBe(2); // initial + ONE repair, bounded
  });

  it('empty INPUT data returns an empty overlay without any provider call (nothing to translate ≠ failure)', async () => {
    const calls: unknown[] = [];
    const callAI = async (req: unknown) => { calls.push(req); return { content: '{}' }; };
    const out = await pack.translateSection(ctxFor({ data: {}, targetLocale: 'pt-BR' }, callAI));
    expect(out.status).toBe('success');
    expect(out.outputs.overlay).toEqual({});
    expect(calls.length).toBe(0);
  });
});
