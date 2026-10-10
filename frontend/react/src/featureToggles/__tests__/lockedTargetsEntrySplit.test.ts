/**
 * ADR 0419 §8 follow-on — the entry-chunk budget. The entry-chunk nav (Sidebar,
 * the Agents row) and the access context must not import the lookup at all —
 * they link to `?feature=<id>` and the store resolves it. The surfaces that DO use
 * `lockedTargets.ts` are lazy, and it reaches the catalog and the copy only
 * through the dynamic `import('./LockedState.js')`, which in turn reaches the
 * marketplace modules through a second dynamic hop (Vite lists a lazy chunk's
 * static deps in the ENTRY preload map). This pins all three.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');
const staticImports = (src: string): string[] =>
  [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);

describe('locked nav targets stay out of the entry chunk', () => {
  it('lockedTargets.ts statically imports only react, and loads LockedState dynamically', () => {
    const src = read('featureToggles/lockedTargets.ts');
    expect(staticImports(src)).toEqual(['react']);
    expect(src).toContain("import('./LockedState.js')");
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
