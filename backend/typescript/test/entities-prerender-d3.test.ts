/**
 * ADR 0407 D3 — server-side entity prerender via the core content-section
 * registry. Pins the HONESTY invariant (no cloaking): the crawler resolver
 * returns EXACTLY what the anonymous public read returns — published +
 * publicRead types, LIVE rows only — so a draft or non-public entity can NEVER
 * appear in prerendered HTML. Plus: sectionHtml renders resolved items, chrome
 * fallback when unresolved, and the core registry is feature-pure.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { resolveContentSection, __clearContentSectionResolvers } from '../src/host/contentDataSources.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import type { Section } from '../src/features/cms/cmsService.js';
import {
  createEntityType, updateEntityType, createEntity,
} from '../src/features/entities/entitiesService.js';
import { registerEntityContentResolvers, readPublicEntities } from '../src/features/entities/publicRead.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { prerenderPage } from '../src/features/publishing/prerenderService.js';

const T = 'tenant-d3';
const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'entities', salt: 'entities', ...ON });
  registerToggleDefault({ id: 'entities-localization', salt: 'entities-localization-v1', status: 'off', bucketUnit: 'tenant' });
  await saveConfig({ id: 'entities', salt: 'entities', ...ON }, 'test');

  await createEntityType({
    tenantId: T, name: 'event', displayName: 'Event',
    fields: [
      { key: 'name', label: 'Name', type: 'string', required: true },
      { key: 'venue', label: 'Venue', type: 'string', required: false },
    ],
    createdBy: 'u1',
  });
  await updateEntityType({ tenantId: T, name: 'event', patch: { status: 'published' }, actor: 'u1' });
  await updateEntityType({ tenantId: T, name: 'event', patch: { publicRead: true }, actor: 'u1' });
  await createEntity({ tenantId: T, typeName: 'event', entityId: 'ev-live', values: { name: 'Live Roast Fest', venue: 'The Roastery' }, createdBy: 'u1' });
  await createEntity({ tenantId: T, typeName: 'event', entityId: 'ev-draft', values: { name: 'SECRET Draft Event' }, status: 'draft', createdBy: 'u1' });

  registerEntityContentResolvers();
});

afterEach(() => { /* registry persists across tests in this file (feature-init parity) */ });

const listSection = (): Section => ({
  sectionId: 'sec-el', type: 'entityList',
  data: { heading: 'Upcoming events', tenantId: T, typeName: 'event', titleField: 'name', bodyField: 'venue', limit: 10 },
});

describe('ADR 0407 D3 — server-side entity resolution (no cloaking)', () => {
  it('resolves LIVE rows only — a draft entity is never returned', async () => {
    const resolved = await resolveContentSection('entityList', listSection().data as Record<string, unknown>, { pageTenantId: T });
    expect(resolved).not.toBeNull();
    const titles = (resolved?.items ?? []).map((i) => i.title);
    expect(titles).toContain('Live Roast Fest');
    expect(titles).not.toContain('SECRET Draft Event');
    // Parity: the resolver output matches the anonymous public read exactly.
    const publicRead = await readPublicEntities({ tenantId: T, typeName: 'event', limit: 10 });
    expect(publicRead.entities.map((e) => String(e.values.name))).toEqual(titles);
  });

  it('a NON-public type resolves to null (nothing leaks to a crawler)', async () => {
    await createEntityType({ tenantId: T, name: 'secret', displayName: 'Secret', fields: [{ key: 'name', label: 'Name', type: 'string', required: true }], createdBy: 'u1' });
    await updateEntityType({ tenantId: T, name: 'secret', patch: { status: 'published' }, actor: 'u1' }); // published but NOT publicRead
    await createEntity({ tenantId: T, typeName: 'secret', entityId: 's1', values: { name: 'Top Secret' }, createdBy: 'u1' });
    const resolved = await resolveContentSection('entityList', { tenantId: T, typeName: 'secret', titleField: 'name', limit: 10 }, { pageTenantId: T });
    // Resolver caught the 404 and returned null (degrade to chrome) — or an empty list; never the row.
    expect(resolved === null || resolved.items.length === 0).toBe(true);
  });

  it('sectionHtml renders resolved items into semantic HTML, escaping content', async () => {
    const resolved = await resolveContentSection('entityList', listSection().data as Record<string, unknown>, { pageTenantId: T });
    const html = sectionHtml(listSection(), { assetBase: 'https://app.test', resolvedSections: { 'sec-el': resolved! } });
    expect(html).toContain('<ul>');
    expect(html).toContain('<h3>Live Roast Fest</h3>');
    expect(html).toContain('<p>The Roastery</p>');
    expect(html).not.toContain('SECRET Draft Event');
  });

  it('sectionHtml falls back to chrome when a section is unresolved (existing degradation)', () => {
    const html = sectionHtml(listSection(), { assetBase: 'https://app.test' });
    expect(html).toBe('<section>\n<h2 id="upcoming-events">Upcoming events</h2>\n</section>'); // R2-D10 — stable anchor ids
  });
});

describe('ADR 0407 D3 — end-to-end prerender (real crawler HTML)', () => {
  it('the prerendered page HTML contains the LIVE entity title + a JSON-LD ItemList, never the draft', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'u1', name: 'Solstice' });
    const page = await createPage({
      tenantId: T, orgId: org.orgId, title: 'Events', slug: 'events', createdBy: 'u1',
      sections: [
        { type: 'hero', data: { heading: 'Our events' } },
        { type: 'entityList', data: { heading: 'Upcoming', tenantId: T, typeName: 'event', titleField: 'name', bodyField: 'venue', limit: 10 } },
      ],
    });
    await transitionPage(T, org.orgId, page.pageId, 'publish', 'u1');

    const result = await prerenderPage(org.orgId, 'events', 'https://app.test', null);
    expect(result).not.toBeNull();
    const html = result!.html;
    // Server-rendered entity content (the SEO payoff) — live only.
    expect(html).toContain('<h3>Live Roast Fest</h3>');
    expect(html).toContain('The Roastery');
    expect(html).not.toContain('SECRET Draft Event');
    // JSON-LD ItemList for the collection.
    expect(html).toContain('"@type":"ItemList"');
    expect(html).toContain('"name":"Live Roast Fest"');
  });
});

describe('core-purity (ADR 0407 D3 boundary)', () => {
  it('host/contentDataSources imports nothing from features/', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'contentDataSources.ts');
    for (const line of readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*import\b/.test(l))) {
      expect(line, line.trim()).not.toMatch(/features\//);
    }
  });

  it('publishing (sectionHtml/prerenderService) never imports entities directly', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'publishing');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => /^\s*import\b/.test(l))) {
        expect(line, `${f}: ${line.trim()}`).not.toMatch(/\.\.\/entities\//);
      }
    }
  });
});
