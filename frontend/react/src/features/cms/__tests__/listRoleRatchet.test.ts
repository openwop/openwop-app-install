/**
 * The CMS list-role ratchet.
 *
 * WebKit drops the list role from an `<ol>`/`<ul>` whose markers are styled
 * away (`list-style: none`), so VoiceOver in Safari and on iOS stops saying
 * "list, N items" (WebKit bug 304137, still open in December 2025). Chromium
 * keeps the role, which is why a headless accessibility-tree check reads the
 * public pages as fine. These lists carry meaning — ordered flow steps, the
 * activity rows a count is made of, a pricing tier's features — so each one
 * restores the role with `role="list"`.
 *
 * Every `<ol>`/`<ul>` in the CMS feature whose class sets `list-style: none` in
 * `global.css` (or uses `u-list-none`) MUST carry `role="list"`. A new section
 * layout that forgets it turns this red instead of shipping a list Safari
 * users cannot count.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolved from the vitest root (frontend/react), not `import.meta.url`.
const CMS_DIR = join(process.cwd(), 'src', 'features', 'cms');
const CSS = readFileSync(join(process.cwd(), 'src', 'styles', 'global.css'), 'utf8');

/** Classes whose own rule sets `list-style: none` (the last compound in a selector). */
function unmarkedListClasses(css: string): Set<string> {
  const out = new Set<string>(['u-list-none']);
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/list-style(-type)?\s*:\s*none/.test(rule[2] ?? '')) continue;
    for (const sel of (rule[1] ?? '').split(',')) {
      const m = /\.([A-Za-z0-9_-]+)\s*$/.exec(sel.trim());
      if (m?.[1]) out.add(m[1]);
    }
  }
  return out;
}

function offenders(): string[] {
  const unmarked = unmarkedListClasses(CSS);
  const found: string[] = [];
  for (const file of readdirSync(CMS_DIR).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(join(CMS_DIR, file), 'utf8');
    for (const tag of src.matchAll(/<(ol|ul)\b([^>]*)>/g)) {
      const attrs = tag[2] ?? '';
      const cls = /className=\{?[`"']([^`"']+)/.exec(attrs)?.[1]?.split(/\s+/) ?? [];
      if (cls.some((c) => unmarked.has(c)) && !/\brole=/.test(attrs)) {
        const line = src.slice(0, tag.index).split('\n').length;
        found.push(`${file}:${line} <${tag[1]} ${cls.join(' ')}>`);
      }
    }
  }
  return found;
}

describe('CMS lists with hidden markers keep their list role (Safari/VoiceOver)', () => {
  it('finds the unmarked-list classes in global.css (the census is not empty)', () => {
    const unmarked = unmarkedListClasses(CSS);
    // A parser that silently matched nothing would make the next case vacuous.
    expect(unmarked.has('fp-flow__steps')).toBe(true);
    expect(unmarked.has('fp-activity__list')).toBe(true);
  });

  it('every such <ol>/<ul> in features/cms carries role="list"', () => {
    expect(offenders()).toEqual([]);
  });
});
