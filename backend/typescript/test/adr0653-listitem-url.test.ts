/**
 * ADR 0653 phase C — a resolved item's `href` reaches the ItemList as `url`,
 * and its ABSENCE is preserved.
 *
 * `ResolvedContentItem.href` was declared by ADR 0407 and read by nobody. The
 * prerenderer built `{'@type':'ListItem', position, name}` with no `url`, and
 * the tree's only `.href` reader is a `columns` card's own href in
 * `sectionHtml.ts` — a different field. Producer dead, consumer dead; closing
 * either alone achieves nothing, which is why B and C are one change.
 *
 * The absence case matters more than the presence case. schema.org `url` is a
 * CLAIM that the item has a followable page, and entities have no public page
 * routes yet (the deferral ADR 0407 records "with cause"). A guessed URL puts a
 * 404 into structured data a crawler trusts. So `url` must be absent — not
 * empty-string, not null — when no resolver supplied one.
 *
 * Driven through the REAL emitter (`prerenderPage`), with a resolver registered for
 * the page's `entityList` section. (/grade-tests w58: this file used to assert a local
 * copy of the expression, which no product change could turn red.)
 *
 * Tracker TST-BG3-21. Red when the emitter drops the `url`, emits `url` for a missing
 * or empty href, or numbers positions from anything but 1.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerContentSectionResolver } from '../src/host/contentDataSources.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { prerenderPage } from '../src/features/publishing/prerenderService.js';

const T = 'tenant-adr0653c';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // Three items: one with a page, one with an EMPTY href, one with none — so the
  // position order and both absence rules are visible in one ItemList.
  registerContentSectionResolver('entityList', async () => ({
    items: [
      { title: 'Sleep', href: '/discover/sleep' },
      { title: 'Focus', href: '' },
      { title: 'Calm' },
    ],
  }));
});

/** Every JSON-LD block in the document, parsed. */
function jsonLdBlocks(html: string): Array<Record<string, unknown>> {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1] ?? 'null') as Record<string, unknown>);
}

describe('ADR 0653 pC — ListItem.url through the real prerender', () => {
  it('carries url only for a supplied href; omits it for a missing or empty one; positions are 1-based', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'u1', name: 'Listco' });
    const page = await createPage({
      tenantId: T, orgId: org.orgId, title: 'Programs', slug: 'programs', createdBy: 'u1',
      // A structurally valid entityList; the resolver registered above answers it.
      sections: [{ type: 'entityList', data: { heading: 'Programs', tenantId: T, typeName: 'program', titleField: 'name' } }],
    });
    await transitionPage(T, org.orgId, page.pageId, 'publish', 'u1');

    const result = await prerenderPage(org.orgId, 'programs', 'https://app.test', null);
    expect(result).not.toBeNull();
    const lists = jsonLdBlocks(result!.html).filter((b) => b['@type'] === 'ItemList');
    expect(lists).toHaveLength(1);
    expect(lists[0]!['itemListElement']).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Sleep', url: '/discover/sleep' },
      { '@type': 'ListItem', position: 2, name: 'Focus' },
      { '@type': 'ListItem', position: 3, name: 'Calm' },
    ]);
  });
});
