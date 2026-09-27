import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ENG-4 / IDN-10 ratchet — every route element in the feature manifest is LAZY.
 *
 * `chrome/features.tsx` imported `ChatTab` eagerly for ~six weeks after the
 * rationale for it died (ADR 0375 moved the home route off chat; ADR 0487
 * re-confirmed the `/` gate). Nothing failed, nothing was slow enough to notice
 * — the cost was silent: ~197 kB raw, 30% of the entry chunk, and five bundle
 * budget bumps paid on top of it. Making it lazy cut the entry 199.9 → 124.8 kB
 * gzip.
 *
 * The budget check in `scripts/check-bundle-budget.mjs` bounds the TOTAL but
 * cannot name a cause, and with ~5 kB of margin it would not even fail on a
 * re-eager import of a smaller tree — it would just quietly eat the headroom.
 * So pin the actual invariant at the source: the manifest may not statically
 * import a route component. A regression here is a one-word edit
 * (`lazy(() => import(x))` → `import x`) that no other gate would attribute.
 *
 * This reads the SOURCE rather than the module graph deliberately: importing
 * `features.tsx` here would tell us it evaluates, not how its elements got in.
 */
// cwd-relative, matching `permanentLoadingRatchet.test.ts` — under the jsdom
// environment `import.meta.url` is an http: URL, so fileURLToPath throws.
const source = readFileSync(join(process.cwd(), 'src/chrome/features.tsx'), 'utf8');

/** Strip line + block comments so prose about eager imports never trips this. */
const strip = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const code = strip(source);

/**
 * GRADE-DELTA CODE-2 — the manifest is not the only way back into the entry.
 *
 * The sweep below reads `chrome/features.tsx`, because that is where the eager
 * import lived. But ANY entry-reachable module that statically imports the chat
 * tree pulls it back in just as effectively, and this file would not have
 * noticed. `App.tsx` is the obvious one: it is the entry, it ALREADY imports
 * from `chat/` (the reviews store), so adding `ChatTab` to that existing import
 * line would silently undo the whole split while every assertion below passed.
 *
 * The budget check would eventually catch the SIZE — but only after ~75 kB of
 * headroom was gone, and it cannot name a cause. Name it here.
 */
const ENTRY_MODULES = ['App.tsx', 'main.tsx'] as const;

describe('feature-manifest route elements are code-split (ENG-4 / IDN-10)', () => {
  it('never statically imports a route component from a page/tree directory', () => {
    // Static `import … from '../<dir>/…'` where <dir> is a page-bearing tree.
    // ui/, featureTypes, and the registry are shared manifest infrastructure and
    // are legitimately eager — the manifest cannot describe routes without them.
    const PAGE_TREES = [
      'chat', 'builder', 'runs', 'kanban', 'prompts', 'memory', 'byok',
      'walkthroughs', 'agents', 'discovery', 'features',
    ];
    const offenders: string[] = [];
    for (const m of code.matchAll(/^import\s+(?!type\b)([^;]+?)\s+from\s+'\.\.\/([^/']+)\/([^']+)'/gm)) {
      const [, bound, dir, rest] = m;
      if (!PAGE_TREES.includes(dir!)) continue;
      // A named non-component import (a helper, a type-ish const) is fine; the
      // thing that costs is pulling a COMPONENT tree in. Components are
      // PascalCase, so flag any PascalCase binding out of a page tree.
      if (/\b[A-Z][A-Za-z0-9]*\b/.test(bound!.replace(/[{}]/g, ''))) {
        offenders.push(`import ${bound!.trim()} from '../${dir}/${rest}'`);
      }
    }
    expect(
      offenders,
      `chrome/features.tsx must lazy-load route components — these are static:\n  ${offenders.join('\n  ')}\n` +
        'Use `const X = lazy(() => import(...).then((m) => ({ default: m.X })))`. ' +
        'If a route genuinely must be eager, say why HERE, not only at the import.',
    ).toEqual([]);
  });

  it('lazy-loads ChatTab specifically, and prefetches it instead', () => {
    // Named separately from the sweep above because this is the exact regression
    // that happened, and the fix has a second half: dropping the eager import
    // without warming the chunk would trade bundle size for a cold `/chat` hop
    // (which is where every legacy `/?agent=` deep link lands).
    expect(code).not.toMatch(/^import\s*\{[^}]*\bChatTab\b[^}]*\}\s*from/m);
    expect(code).toMatch(/const\s+ChatTab\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(/);
    expect(code).toMatch(/export function prefetchChatTab\(\)/);
  });

  it.each(ENTRY_MODULES)('%s does not statically import the chat tree back into the entry', (mod) => {
    // Reading the entry modules directly, because the manifest sweep above cannot
    // see them — and they are the cheapest place to accidentally re-eager the
    // 197 kB this split removed.
    const src = strip(readFileSync(join(process.cwd(), 'src', mod), 'utf8'));
    const offenders: string[] = [];
    for (const m of src.matchAll(/^import\s+(?!type\b)([^;]+?)\s+from\s+'\.\/chat\/([^']+)'/gm)) {
      const [, bound, rest] = m;
      // Small leaf modules are legitimately entry-resident (App.tsx already holds
      // the reviews STORE, which the shell renders). What must never come back is
      // a COMPONENT tree — flag PascalCase bindings, the same rule as the sweep.
      const named = bound!.replace(/[{}]/g, '');
      if (/\b[A-Z][A-Za-z0-9]*\b/.test(named) && !/^\s*\{?\s*use[A-Z]/.test(named)) {
        offenders.push(`import ${bound!.trim()} from './chat/${rest}'`);
      }
    }
    expect(
      offenders,
      `src/${mod} statically imports chat components — this pulls the chat tree back into the entry chunk:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
