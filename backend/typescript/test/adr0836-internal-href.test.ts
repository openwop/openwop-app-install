/**
 * ADR 0836 D7 + D9 — the predicates that have a browser mirror, pinned to it.
 *
 * - `isInternalHref`: the backend copy (`src/host/internalHref.ts`, used by the
 *   write-time `safeLink` and every server render exit) and the frontend copy
 *   (`frontend/react/src/lib/internalHref.ts`, used by `SectionRenderer` and the
 *   funnel viewer) run ONE vector table. The headline vector is `"/\t/evil.com"`:
 *   it passed the old `/^\/(?![/\\])/` and a URL parser resolves it off-site.
 * - the `[TODO` publish blocker: the server rule and the browser checklist's ONE
 *   `block` rule are the same regex.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isInternalHref } from '../src/host/internalHref.js';
import { TODO_MARKER } from '../src/features/cms/cmsService.js';

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, '../../../frontend/react/src');

const VECTORS: Array<[string, boolean]> = [
  ['/agents', true],
  ['/p/pricing?ref=nav#top', true],
  ['/', true],
  ['//evil.com', false],
  ['/\\evil.com', false],
  ['/\t/evil.com', false],
  ['/\n/evil.com', false],
  ['/\r/evil.com', false],
  ['/ /evil.com', false],
  ['/a b', false],
  ['/\u0000x', false],
  ['/\u007fx', false],
  ['https://example.com', false], // external: a separate predicate decides it
  ['javascript:alert(1)', false],
  ['agents', false],
  ['', false],
];

describe('ADR 0836 D7 — isInternalHref', () => {
  it.each(VECTORS)('backend: %j → %s', (href, want) => {
    expect(isInternalHref(href)).toBe(want);
  });

  it('the headline vector is real: the old regex accepted it and a URL parser resolves it off-site', () => {
    expect(/^\/(?![/\\])/.test('/\t/evil.com')).toBe(true);
    expect(new URL('/\t/evil.com', 'https://app.example').origin).toBe('https://evil.com');
  });

  it.each(VECTORS)('frontend mirror: %j → %s', async (href, want) => {
    const mod = (await import(join(FRONTEND, 'lib/internalHref.ts'))) as { isInternalHref: (h: string) => boolean };
    expect(mod.isInternalHref(href)).toBe(want);
  });

  it('no render exit keeps a private copy of the old regex', () => {
    const files = [
      // The CMS CTA exit moved out of SectionRenderer into CtaLink (ADR 0820 §7, the
      // public /pricing split); SectionRenderer and PricingSection import it from there.
      join(FRONTEND, 'features/cms/CtaLink.tsx'),
      join(FRONTEND, 'features/funnels/viewer/FunnelViewerPage.tsx'),
      join(here, '../src/features/publishing/sectionHtml.ts'),
      join(here, '../src/features/funnels/funnelsService.ts'),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toContain('isInternalHref');
      expect(/\/\^\\\/\(\?!\[\\?\/\\\\\]\)\/\.test/.test(src), `${f} still tests the old regex`).toBe(false);
    }
    for (const f of ['features/cms/SectionRenderer.tsx', 'features/cms/PricingSection.tsx']) {
      const src = readFileSync(join(FRONTEND, f), 'utf8');
      expect(src, f).toContain("from './CtaLink.js'");
      expect(/\/\^\\\/\(\?!\[\\?\/\\\\\]\)\/\.test/.test(src), `${f} still tests the old regex`).toBe(false);
    }
  });
});

describe('ADR 0836 D9 — the server blocker is the browser checklist\'s `block` rule', () => {
  it('same TODO regex (source + flags) as publishChecks.ts', () => {
    const src = readFileSync(join(FRONTEND, 'features/cms/publishChecks.ts'), 'utf8');
    const m = /const TODO = \/(.+)\/([a-z]*);/.exec(src);
    expect(m, 'publishChecks.ts must declare `const TODO = /…/flags;`').toBeTruthy();
    expect(m![1]).toBe(TODO_MARKER.source);
    expect(m![2]).toBe(TODO_MARKER.flags);
  });
});
