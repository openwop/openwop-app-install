/**
 * ADR 0419 §8 follow-on — the entry-chunk budget. The entry-chunk nav (Sidebar,
 * the Agents row) and the access context must not import the lookup at all —
 * they link to `?feature=<id>` and the store resolves it. The surfaces that DO use
 * `lockedTargets.ts` are lazy, and it reaches the catalog and the copy only
 * through the dynamic `import('./LockedState.js')`, which in turn reaches the
 * marketplace modules through a second dynamic hop (Vite lists a lazy chunk's
 * static deps in the ENTRY preload map). This pins all three.
 *
 * The import scan reads every STATIC edge Rollup follows — `import … from`,
 * `export … from` (a re-export is a static import) and a bare side-effect
 * `import '…'` — with either quote style (wave 50: double quotes and re-exports
 * used to escape it). Comments are stripped first, so a commented-out import is
 * neither an edge nor proof of the dynamic one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"])\/\/[^\n]*/g, '$1');
const staticImports = (src: string): string[] =>
  [...stripComments(src).matchAll(/^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|^import\s+['"]([^'"]+)['"]/gm)].map((m) => (m[1] ?? m[2])!);

describe('locked nav targets stay out of the entry chunk', () => {
  it('the scan reads every static edge form, and no comment', () => {
    expect(staticImports([
      "import { a } from 'x-single';",
      'import { b } from "x-double";',
      "import type { C } from 'x-type';",
      "export { d } from 'x-reexport';",
      "export * from 'x-star';",
      "import 'x-side-effect';",
      "// import { e } from 'x-commented';",
      "const f = await import('x-dynamic');",
    ].join('\n'))).toEqual(['x-single', 'x-double', 'x-type', 'x-reexport', 'x-star', 'x-side-effect']);
  });

  it('lockedTargets.ts statically imports only react, and loads LockedState dynamically', () => {
    const src = read('featureToggles/lockedTargets.ts');
    expect(staticImports(src)).toEqual(['react']);
    expect(stripComments(src)).toContain("import('./LockedState.js')");
  });

  it('the entry-side modules never statically import the lookup or the lazy locked modules', () => {
    for (const f of ['featureToggles/FeatureAccessContext.tsx', 'featureToggles/EntitlementGuard.tsx', 'chrome/Sidebar.tsx', 'chrome/PinnedAgentsNav.tsx']) {
      const lazy = staticImports(read(f)).filter((s) => /lockedTargets|LockedState|lockedUpsell|LockedUpgradePrompt|marketplaceClient/.test(s));
      expect(lazy, f).toEqual([]);
    }
  });

  it('LockedState itself statically imports nothing beyond what the entry already holds', () => {
    const deps = staticImports(read('featureToggles/LockedState.tsx'));
    expect(deps.filter((s) => /marketplace|billing|writeAccess/.test(s))).toEqual([]);
  });
});
