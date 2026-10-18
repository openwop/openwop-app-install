/**
 * P4-continuation coverage — every page-spotlight triple the app registers (the core
 * spec + the literals feature routes / page packs register) resolves a live element,
 * and the set of spotlight ids is EXACTLY the set the shipped backend page
 * walkthroughs reference (`backend/typescript/src/features/walkthroughs/feature.ts`).
 *
 * w51 r2 (/grade-tests): this used to register a HAND COPY of the seven feature-routed
 * triples and read it back (renaming a real registration stayed green — probe
 * ps-feature-rename), never call `resolve()` (ps-resolve), and pin `18` while the
 * backend references 25 (ps-backend-id). Both sides are now read from their sources
 * of truth; measured on e3c2492be: 25 FE = 25 backend (11 core + 7 feature routes +
 * 7 page packs).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { registerPageSpotlight } from '../pageSpotlight.js';
import { CORE_PAGE_SPOTLIGHTS } from '../corePageSpotlights.js';
import { getWalkthroughAction, __resetWalkthroughRegistryForTests } from '../actionRegistry.js';

type Triple = readonly [actionId: string, route: string, anchor: string];

/** Every literal `registerPageSpotlight('id', '/route', 'anchor')` in PRODUCT sources. */
function scannedRegistrations(): Triple[] {
  const out: Triple[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const src = readFileSync(full, 'utf8');
      for (const [, a, r, x] of src.matchAll(/registerPageSpotlight\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) {
        if (a && r && x) out.push([a, r, x]);
      }
    }
  };
  walk(join(process.cwd(), 'src'));
  return out;
}

/** The `*.page.view` ids the shipped backend page walkthroughs reference. */
function backendPageViewIds(): string[] {
  const src = readFileSync(join(process.cwd(), '../../backend/typescript/src/features/walkthroughs/feature.ts'), 'utf8');
  return [...src.matchAll(/pageWalkthrough\(\s*'[^']+'\s*,\s*'[^']+'\s*,\s*'([\w.-]+\.page\.view)'/g)].map((m) => m[1] ?? '');
}

afterEach(() => { document.body.innerHTML = ''; });

describe('page spotlights (P4 continuation)', () => {
  it('all core + feature triples register resolvable actions', () => {
    __resetWalkthroughRegistryForTests();
    const triples: Triple[] = [...CORE_PAGE_SPOTLIGHTS, ...scannedRegistrations()];
    const fe = triples.map(([a]) => a);
    const be = backendPageViewIds();

    // Cross-tree: exactly the ids the shipped page walkthroughs reference — measured 25.
    expect(new Set(fe).size, 'a spotlight id is registered twice').toBe(fe.length);
    expect([...fe].sort()).toEqual([...be].sort());
    expect(fe.length).toBe(25);

    for (const [a, r, anchor] of triples) registerPageSpotlight(a, r, anchor);
    // A DIFFERENT page's anchor is always in the DOM first: resolving "any anchor"
    // must not pass for resolving THIS page's anchor (w51 r2 probe ps-resolve-any).
    const decoy = document.createElement('div');
    decoy.setAttribute('data-walkthrough', 'decoy.page');
    document.body.appendChild(decoy);
    for (const [a, r, anchor] of triples) {
      const action = getWalkthroughAction(a);
      expect(action, a).toBeTruthy();
      expect(action?.route, a).toBe(r);
      expect(action?.verb, a).toBe('focus');
      // Resolvable: the action finds its page root through the anchor, and nothing else.
      expect(action?.resolve(), `${a} resolved without its own anchor in the DOM`).toBeNull();
      const root = document.createElement('section');
      root.setAttribute('data-walkthrough', anchor);
      document.body.appendChild(root);
      expect(action?.resolve(), a).toBe(root);
      root.remove();
    }
  });
});
