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
import { SYSTEM_SITE_ORG, SYSTEM_SITE_SLUG, SYSTEM_SITE_TENANT } from '../src/host/systemSite.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pack: any;
let server: http.Server;

// hero overlays seeded in host/systemSite.ts (assert real locale resolution).
const PT_HEADING = 'Colegas de IA que fazem trabalho de verdade — e continuam sendo seus.';
const EN_HEADING = 'AI coworkers that do real work — and stay yours.';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, res); });
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
  it('get-page resolves a published page to the requested locale (pt-BR overlay)', async () => {
    const out = await pack.getPage(ctxFor({ orgId: SYSTEM_SITE_ORG, slug: SYSTEM_SITE_SLUG, locale: 'pt-BR' }));
    expect(out.status).toBe('success');
    expect(out.outputs.locale).toBe('pt-BR');
    expect(heroHeading(out.outputs.page)).toBe(PT_HEADING);
    // The surface never leaks the per-locale overlays.
    for (const s of out.outputs.page.sections) expect(s.localizations).toBeUndefined();
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

  it('throws host_capability_missing when ctx.features.cms is absent', async () => {
    await expect(pack.getPage({ inputs: { slug: 'home' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.sample.cms' });
  });

  it('throws host_capability_missing (aiProviders) when ctx.callAI is absent', async () => {
    await expect(pack.translateSection({ inputs: { data: {}, targetLocale: 'pt-BR' }, features: {} }))
      .rejects.toMatchObject({ code: 'host_capability_missing', capability: 'host.aiProviders' });
  });
});
