/**
 * ADR 0408 Phase C — pages in the content kernel: the cms.page system type
 * (minted, guarded, code-owned), the façade round-trip, the convergence
 * payoff (generic entity query sees pages), the id-preserving migration, and
 * the one-directional dependency guard (entities never imports cms).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createPage, getPage, listPages, transitionPage, migratePagesToKernel, CMS_PAGE_TYPE, type Page,
} from '../src/features/cms/cmsService.js';
import {
  createEntity, deleteEntityType, getEntityType, getSystemEntity, queryEntities, updateEntityType,
} from '../src/features/entities/entitiesService.js';

const T = 'tenant-kernel';
const ORG = 'org-kernel';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('cms.page in the content kernel (ADR 0408 Phase C)', () => {
  it('a created page IS a kernel row: system type minted, scalars queryable, blocks in ext', async () => {
    const page = await createPage({
      tenantId: T, orgId: ORG, title: 'Hello Kernel', slug: 'hello-kernel', createdBy: 'u1',
      sections: [{ type: 'richText', data: { heading: 'Hi', text: 'Body' } }],
    });
    const type = await getEntityType(T, undefined, CMS_PAGE_TYPE);
    expect(type?.system).toBe(true);
    expect(type?.status).toBe('published');
    expect(type?.publicRead).toBeUndefined(); // never public by default

    const row = await getSystemEntity(T, CMS_PAGE_TYPE, page.pageId);
    expect(row?.entityId).toBe(page.pageId); // id-preserving
    expect(row?.orgId).toBe(ORG); // top-level orgId → the RI-7 org-delete guard sees the row
    expect(row?.values.title).toBe('Hello Kernel');
    expect(row?.values.workflow_status).toBe('draft');
    expect(row?.status).toBe('draft'); // kernel entry status derives from workflow
    expect(Array.isArray((row?.ext as { blocks?: unknown[] }).blocks)).toBe(true);

    // Publish flips the derived kernel status to live (absent).
    await transitionPage(T, ORG, page.pageId, 'submit', 'u1');
    await transitionPage(T, ORG, page.pageId, 'approve', 'u1');
    const live = await getSystemEntity(T, CMS_PAGE_TYPE, page.pageId);
    expect(live?.values.workflow_status).toBe('published');
    expect(live?.status).toBeUndefined();
  });

  it('the convergence payoff: generic entity query sees pages (no page-specific kernel code)', async () => {
    await createPage({
      tenantId: T, orgId: ORG, title: 'A Post', slug: 'a-post', createdBy: 'u1', kind: 'post',
      sections: [{ type: 'richText', data: { text: 'post body' } }],
    });
    const result = await queryEntities({
      tenantId: T, typeName: CMS_PAGE_TYPE,
      filters: [{ key: 'kind', op: 'eq', value: 'post' }],
    });
    expect(result.entities.length).toBe(1);
    expect(result.entities[0]?.values.title).toBe('A Post');
  });

  it('system guards: generic writes + type-admin mutations are blocked', async () => {
    await expect(createEntity({ tenantId: T, typeName: CMS_PAGE_TYPE, values: { title: 'x' }, createdBy: 'u1' }))
      .rejects.toThrow(/system type/);
    await expect(updateEntityType({ tenantId: T, name: CMS_PAGE_TYPE, patch: { status: 'draft' }, actor: 'u1' }))
      .rejects.toThrow(/code-owned/);
    await expect(deleteEntityType({ tenantId: T, name: CMS_PAGE_TYPE })).rejects.toThrow(/system type/);
  });

  it('migrates legacy cms:page rows id-preservingly and idempotently', async () => {
    // Seed a LEGACY row exactly as the pre-kernel store held it.
    const legacy = new DurableCollection<Page>('cms:page', (p) => p.pageId);
    const legacyPage = {
      pageId: 'page-legacy-1', tenantId: 'tenant-legacy', orgId: 'org-legacy',
      title: 'Old Faithful', slug: 'old-faithful', status: 'published',
      sections: [{ sectionId: 's1', type: 'richText', data: { text: 'vintage' } }],
      version: 3, createdBy: 'u0', updatedBy: 'u0',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    } as unknown as Page;
    await legacy.put(legacyPage);

    const first = await migratePagesToKernel();
    expect(first.migrated).toBeGreaterThanOrEqual(1);
    const again = await migratePagesToKernel();
    expect(again.migrated).toBe(0); // idempotent

    const migrated = await getPage('tenant-legacy', 'org-legacy', 'page-legacy-1');
    expect(migrated?.title).toBe('Old Faithful');
    expect(migrated?.version).toBe(3); // domain metadata round-trips via ext.page
    expect(migrated?.sections[0]?.data.text).toBe('vintage');
    expect((await listPages('tenant-legacy', 'org-legacy')).length).toBe(1);
  });
});

describe('one-directional dependency (ADR 0408 boundary)', () => {
  it('the kernel (features/entities) never imports the façade (features/cms)', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'entities');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const line of src.split('\n').filter((l) => /^\s*import\b/.test(l))) {
        expect(line, `${f}: ${line.trim()}`).not.toMatch(/features\/cms|\.\.\/cms\//);
      }
    }
  });
});
