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
 */

import { describe, it, expect } from 'vitest';

/** The emitter's shape, extracted so the assertion is about the RULE rather
 *  than about booting a prerender. Mirrors prerenderService's expression
 *  exactly; the source-pin below is what keeps them honest. */
const listItem = (it: { title: string; href?: string }, i: number) => ({
  '@type': 'ListItem',
  position: i + 1,
  name: it.title,
  ...(it.href === undefined || it.href === '' ? {} : { url: it.href }),
});

describe('ADR 0653 pC — ListItem.url', () => {
  it('carries url when the resolver supplied an href', () => {
    expect(listItem({ title: 'Sleep', href: '/discover/sleep' }, 0)).toEqual({
      '@type': 'ListItem', position: 1, name: 'Sleep', url: '/discover/sleep',
    });
  });

  it('OMITS url entirely when there is no href — not null, not empty', () => {
    const out = listItem({ title: 'Sleep' }, 0) as Record<string, unknown>;
    expect('url' in out).toBe(false);
  });

  it('treats an empty-string href as absent', () => {
    // A resolver returning '' has not supplied a page; emitting `url: ''` would
    // be a claim backed by nothing, and `in`-checks downstream would see a field.
    const out = listItem({ title: 'Sleep', href: '' }, 0) as Record<string, unknown>;
    expect('url' in out).toBe(false);
  });

  it('positions are 1-based and preserved', () => {
    expect(listItem({ title: 'x' }, 4).position).toBe(5);
  });
});

describe('ADR 0653 pC — the emitter actually does this', () => {
  it('prerenderService consumes it.href into url, conditionally', async () => {
    // The helper above is a mirror. This is the oracle: without it, a future
    // edit could drop the conditional and every case above would still pass.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'features', 'publishing', 'prerenderService.ts'),
      'utf8',
    );
    expect(src).toMatch(/it\.href === undefined \|\| it\.href === ''/);
    expect(src).toContain('{ url: it.href }');
  });
});
