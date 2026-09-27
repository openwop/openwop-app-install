/**
 * ADR 0490 — the guard for the eager/lazy `en` namespace split.
 *
 * The split is safe because of two MEASURED facts, not because of an argument.
 * If either stops holding, a feature renders raw keys for real users, so both
 * are pinned here:
 *
 *   1. No feature component uses another feature's namespace. A lazy catalog is
 *      therefore only ever needed by its own (already lazy) page.
 *   2. Every namespace rendered by NON-feature code — the shell, which paints
 *      before any route resolves — is either an area namespace (eager by the
 *      `/src/*​/i18n/en.ts` glob) or is named in `SHELL_FEATURE_NAMESPACES`.
 *
 * It also pins the two hand-maintained lists to each other: `resources.ts` and
 * `vite.config.ts` both name the shell-rendered feature namespaces, and a
 * mismatch would put a catalog in the lazy chunk while the loader thought it
 * was eager.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const FEATURES = join(SRC, 'features');

const featureDirs = (): string[] =>
  readdirSync(FEATURES).filter((d) => statSync(join(FEATURES, d)).isDirectory());

/** Every .ts/.tsx under `dir`, skipping tests and catalogs. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'i18n') continue;
      out.push(...sourceFiles(p));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

const namespacesIn = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/useTranslation\('([a-z0-9-]+)'\)/g)].map((m) => m[1]!);

/** The shell-rendered feature namespaces, read from the module that owns them. */
const shellFeatureNamespaces = (): string[] => {
  const src = readFileSync(join(SRC, 'i18n', 'resources.ts'), 'utf8');
  const block = src.slice(src.indexOf('SHELL_FEATURE_NAMESPACES'), src.indexOf('const isLazyFeatureCatalog'));
  return [...block.matchAll(/^\s*'([a-z0-9-]+)',$/gm)].map((m) => m[1]!);
};

describe('ADR 0490 — the eager/lazy namespace split stays safe', () => {
  it('no feature component uses ANOTHER feature’s namespace', () => {
    const feats = new Set(featureDirs());
    const offenders: string[] = [];
    for (const feat of feats) {
      for (const file of sourceFiles(join(FEATURES, feat))) {
        for (const ns of namespacesIn(file)) {
          if (ns !== feat && feats.has(ns)) offenders.push(`${file.slice(SRC.length + 1)} uses '${ns}'`);
        }
      }
    }
    // If this fails: that namespace is lazy and will render RAW KEYS in the
    // borrowing feature. Either add it to SHELL_FEATURE_NAMESPACES (and the
    // vite list), or stop borrowing it.
    expect(offenders).toEqual([]);
  });

  it('every feature namespace the SHELL renders is kept eager', () => {
    const feats = new Set(featureDirs());
    const shell = new Set(shellFeatureNamespaces());
    const areaDirs = new Set(
      readdirSync(SRC).filter((d) => {
        try { return statSync(join(SRC, d, 'i18n', 'en.ts')).isFile(); } catch { return false; }
      }),
    );
    const offenders: string[] = [];
    for (const entry of readdirSync(SRC)) {
      const p = join(SRC, entry);
      if (entry === 'features' || !statSync(p).isDirectory()) continue;
      for (const file of sourceFiles(p)) {
        for (const ns of namespacesIn(file)) {
          // A namespace that is a FEATURE dir and NOT an area catalog must be
          // named as shell-eager, or the shell paints raw keys.
          if (feats.has(ns) && !areaDirs.has(ns) && !shell.has(ns)) {
            offenders.push(`${file.slice(SRC.length + 1)} uses feature ns '${ns}'`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('resources.ts and vite.config.ts name the SAME shell namespaces', () => {
    // Two hand-maintained lists: a mismatch puts a catalog in the lazy chunk
    // while the loader believes it is eager (or the reverse), which is exactly
    // the kind of drift that only shows up in production.
    const vite = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
    const line = vite.split('\n').find((l) => l.includes("enFeature && !["));
    expect(line, 'the vite manualChunks shell-namespace list moved').toBeTruthy();
    const inVite = [...line!.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
    expect([...inVite].sort()).toEqual([...shellFeatureNamespaces()].sort());
  });

  it('the LAZY-LOCALE list matches the same shell namespaces', () => {
    // The locale follow-up applies the identical partition to pt-BR/fr/es. It
    // adds a THIRD hand-maintained copy of the shell-namespace list (the
    // lazy-feature branch in vite's manualChunks), so it is pinned to the other
    // two for the same reason: drift would put a locale's catalog in a chunk the
    // loader does not expect.
    const vite = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');
    const line = vite.split('\n').find((l) => l.includes('lazyFeature && !['));
    expect(line, 'the vite lazy-locale shell-namespace list moved').toBeTruthy();
    const inVite = [...line!.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
    expect([...inVite].sort()).toEqual([...shellFeatureNamespaces()].sort());
  });

  it('resources.ts partitions lazy locales by the same shell set', () => {
    // The runtime partition must use SHELL_FEATURE_NAMESPACES, not a second
    // literal list that could drift from it.
    const res = readFileSync(join(SRC, 'i18n', 'resources.ts'), 'utf8');
    expect(res).toContain('function partitionLocaleGlobs');
    expect(res.match(/partitionLocaleGlobs[\s\S]{0,600}?SHELL_FEATURE_NAMESPACES\.has/))
      .toBeTruthy();
  });

  it('the check is not vacuous — it really walked the tree', () => {
    expect(featureDirs().length).toBeGreaterThan(50);
    expect(shellFeatureNamespaces().length).toBeGreaterThan(0);
  });
});
