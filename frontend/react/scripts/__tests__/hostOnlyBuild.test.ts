/**
 * ADR 1031 × ADR 0874 D4 — the adopter bundle's budgeted build holds host code only.
 *
 * `stripAdopter` is the rewrite; `hostOnlyPlugin` is its guard rails. Red under:
 * an adopter glob literal left in place (eager, lazy, or inside an array), a
 * first-party glob rewritten, a non-glob module or an adopter module touched, an
 * adopter `@import` kept (or a first-party one dropped), the plugin active with the
 * flag off, the plugin running under a NAMED distribution (a shipped build), and
 * a flag value other than "1" accepted, the plugin's transform handing back the
 * ORIGINAL code while counting a rewrite, and an untouched module counted as a
 * rewrite (so a tree whose adopter literals changed shape would pass unrewritten).
 *
 * The end-to-end witness is the real build: in KickTodo at openwop-app 48d891616
 * the default build's entry is 130.2 kB with adopter features, 127.9 kB with this
 * flag (the same number as setting `src/adopter/` aside by hand).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HOST_ONLY_ENV, NO_ADOPTER_DIR, hostOnlyPlugin, stripAdopter } from '../hostOnlyBuild.mjs';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function tree(withAdopter: boolean): string {
  const r = mkdtempSync(join(tmpdir(), 'owp-hostonly-'));
  roots.push(r);
  if (withAdopter) mkdirSync(join(r, 'src', 'adopter', 'features', 'x'), { recursive: true });
  return r;
}

describe('stripAdopter — the rewrite', () => {
  it('points an eager adopter glob at a directory that cannot exist', () => {
    const code = "const m = import.meta.glob('/src/adopter/features/*/routes.tsx', { eager: true });";
    expect(stripAdopter(code, '/r/src/features/adopterFeatures.ts'))
      .toBe(`const m = import.meta.glob('${NO_ADOPTER_DIR}*/routes.tsx', { eager: true });`);
  });

  it('rewrites the adopter entry of an ARRAY glob and keeps the first-party one', () => {
    const code = "import.meta.glob(['/src/features/*/i18n/en.ts', '/src/adopter/features/*/i18n/en.ts'])";
    const out = stripAdopter(code, '/r/src/i18n/resources.ts');
    expect(out).toContain("'/src/features/*/i18n/en.ts'");
    expect(out).toContain(`'${NO_ADOPTER_DIR}*/i18n/en.ts'`);
    expect(out).not.toContain('/src/adopter/');
  });

  it('rewrites every adopter literal in a module, whatever the quote', () => {
    const code = 'import.meta.glob("/src/adopter/features/*/a.ts"); import.meta.glob(`/src/adopter/features/*/b.ts`);';
    expect(stripAdopter(code, '/r/src/x.ts')).not.toContain('/src/adopter/');
  });

  it('leaves first-party globs, non-glob modules and adopter modules alone', () => {
    expect(stripAdopter("import.meta.glob('/src/features/*/routes.tsx')", '/r/src/features/registry.ts')).toBeNull();
    expect(stripAdopter("const p = '/src/adopter/features/x';", '/r/src/x.ts')).toBeNull();
    expect(stripAdopter("import.meta.glob('/src/adopter/features/*/a.ts')", '/r/src/adopter/features/k/routes.tsx')).toBeNull();
    expect(stripAdopter("import.meta.glob('/src/adopter/features/*/a.ts')", '/r/src/x.json')).toBeNull();
  });

  it('drops adopter @imports from a stylesheet and keeps first-party ones', () => {
    const css = "@import '../features/crm/styles.css';\n@import '../adopter/features/kicktodo/styles.css';\n@import \"../adopter/features/k2/styles.css\";\n.x{}\n";
    expect(stripAdopter(css, '/r/src/styles/features.generated.css')).toBe("@import '../features/crm/styles.css';\n.x{}\n");
    expect(stripAdopter("@import '../features/crm/styles.css';\n", '/r/src/styles/features.generated.css')).toBeNull();
  });
});

describe('hostOnlyPlugin — the guard rails', () => {
  it('is OFF (no plugin) unless the flag is set', () => {
    expect(hostOnlyPlugin({ env: {}, root: tree(true) })).toEqual([]);
    expect(hostOnlyPlugin({ env: { [HOST_ONLY_ENV]: '' }, root: tree(true) })).toEqual([]);
  });

  it('is ON for the default distribution with the flag set to 1', () => {
    const p = hostOnlyPlugin({ env: { [HOST_ONLY_ENV]: '1' }, distribution: 'default', root: tree(true) });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ enforce: 'pre', apply: 'build' });
  });

  it('REFUSES a named distribution: that is a shipped build and keeps its adopter features', () => {
    expect(() => hostOnlyPlugin({ env: { [HOST_ONLY_ENV]: '1' }, distribution: 'kicktodo', root: tree(true) }))
      .toThrow(/named distribution is a SHIPPED build/);
  });

  it('accepts only "1"', () => {
    for (const v of ['true', '0', 'yes']) {
      expect(() => hostOnlyPlugin({ env: { [HOST_ONLY_ENV]: v }, root: tree(true) })).toThrow(/only "1" is accepted/);
    }
  });

  type Ctx = { error: (m: string) => never; getModuleIds: () => IterableIterator<string> };
  const ctx = (ids: string[]): Ctx => ({
    error: (m: string) => { throw new Error(m); },
    getModuleIds: () => ids[Symbol.iterator](),
  });
  interface Hooks { transform(code: string, id: string): unknown; generateBundle(this: Ctx): void }
  function isHooks(p: unknown): p is Hooks {
    return typeof p === 'object' && p !== null
      && 'transform' in p && typeof p.transform === 'function'
      && 'generateBundle' in p && typeof p.generateBundle === 'function';
  }
  const plugin = (root: string): Hooks => {
    const [p] = hostOnlyPlugin({ env: { [HOST_ONLY_ENV]: '1' }, root });
    if (!isHooks(p)) throw new Error('hostOnlyPlugin returned no transform/generateBundle hooks');
    return p;
  };
  const ADOPTER_GLOB = "import.meta.glob('/src/adopter/features/*/routes.tsx', { eager: true })";
  const FIRST_PARTY_GLOB = "import.meta.glob('/src/features/*/routes.tsx')";

  it('fails the build when it rewrote nothing in a tree that HAS adopter features', () => {
    const p = plugin(tree(true));
    // An untouched first-party module is not a rewrite.
    expect(p.transform(FIRST_PARTY_GLOB, '/r/src/features/registry.ts')).toBeNull();
    expect(() => p.generateBundle.call(ctx(['/r/src/main.tsx']))).toThrow(/rewrote nothing/);
  });

  it('fails the build when an adopter module still reached the bundle', () => {
    const p = plugin(tree(true));
    expect(p.transform(ADOPTER_GLOB, '/r/src/features/adopterFeatures.ts'))
      .toEqual({ code: "import.meta.glob('/src/.host-only-build-no-adopter/features/*/routes.tsx', { eager: true })", map: null });
    expect(() => p.generateBundle.call(ctx(['/r/src/main.tsx', '/r/src/adopter/features/k/routes.tsx']))).toThrow(/still reached the bundle/);
  });

  it('passes a clean host-only bundle, and a tree with no adopter features at all', () => {
    const p = plugin(tree(true));
    expect(p.transform(FIRST_PARTY_GLOB, '/r/src/features/registry.ts')).toBeNull();
    expect(p.transform(ADOPTER_GLOB, '/r/src/features/adopterFeatures.ts'))
      .toEqual({ code: "import.meta.glob('/src/.host-only-build-no-adopter/features/*/routes.tsx', { eager: true })", map: null });
    expect(() => p.generateBundle.call(ctx(['/r/src/main.tsx']))).not.toThrow();
    expect(() => plugin(tree(false)).generateBundle.call(ctx(['/r/src/main.tsx']))).not.toThrow();
  });
});
