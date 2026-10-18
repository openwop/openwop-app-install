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
 *
 * NSSPLIT-BORROW-1 (wave 51) — fact 1 is FALSE at HEAD, and case 1 cannot see it:
 * `namespacesIn` reads only `useTranslation('ns')`. MEASURED 2026-10-16 (e3c2492be),
 * five cross-feature borrows in the forms it is blind to:
 *   - features/publishing/PublishingPage.tsx:60  `useTranslation(['publishing', 'cms'])`
 *   - features/publishing/PublishingPage.tsx:96  `t('cms:frontPageScope')`
 *   - features/marketplace/BundleShopPage.tsx:97 `useTranslation(['marketplace', 'billing'])`
 *   - features/cms/SectionRenderer.tsx:181-199   `i18n.t('site:heroVignette…')` (no `site` hook)
 *   - features/profiles/ProfilePage.tsx:749-752  `t('twin:toggleReadFailed…')` under `useTranslation('profiles')`
 * The array-hook forms suspend and load through `lazyNsBackend` (BundleShopPage's is the
 * BILLUX-1 fix, UX-ASSESSMENT.md:17838), and PublishingPage's `t('cms:…')` rides its own
 * array hook, so those three sites are safe and NOT pinned. A bare `t('ns:key')` /
 * `i18n.t('ns:key')` does NOT trigger a load, so the two bare sites (SectionRenderer
 * `site`, ProfilePage `twin`, :749-752) likely render raw keys. Pinned as an `it.fails`
 * below; case 1 is left exactly as it was. The fix PR for NSSPLIT-BORROW-1 flips the
 * `it.fails` to `it`.
 *
 * Sabotage (wave 51 probes): a cross-feature `useTranslation`, a shell file using a lazy
 * feature namespace, a second `featureToggles` user, a suspending `assistantAction`
 * hook, or a drift in any of the three shell-namespace lists each red one case.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

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

/**
 * Every namespace a file borrows, in ANY form: `useTranslation('a')`,
 * `useTranslation(['a', 'b'])`, `t('a:key')` / `i18n.t('a:key')`, and `{ ns: 'a' }`.
 * (NSSPLIT-BORROW-1 — `namespacesIn` sees only the first.)
 */
/** Namespaces a file LOADS through its own `useTranslation(...)` hook (string or array form). */
function hookLoadedIn(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/useTranslation\(\s*\[([^\]]*)\]/g)) {
    for (const n of (m[1] ?? '').matchAll(/['"]([a-z0-9-]+)['"]/g)) out.add(n[1]!);
  }
  for (const m of src.matchAll(/useTranslation\(\s*['"]([a-z0-9-]+)['"]/g)) out.add(m[1]!);
  return out;
}

/** Namespaces a file reads WITHOUT loading them: a bare `t('ns:key')` / `i18n.t('ns:key')`
 *  or an `{ ns: … }` option, for a namespace its own hook does not name. A bare reference
 *  does not trigger `lazyNsBackend`, so a lazy namespace read this way paints raw keys. */
function bareBorrowsIn(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const loaded = hookLoadedIn(src);
  const out = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*['"`]([a-z0-9-]+):/g)) out.add(m[1]!);
  for (const m of src.matchAll(/\bns:\s*\[?\s*['"]([a-z0-9-]+)['"]/g)) out.add(m[1]!);
  return [...out].filter((ns) => !loaded.has(ns));
}

/** The shell-rendered feature namespaces, read from the module that owns them. */
const shellFeatureNamespaces = (): string[] => {
  const src = readFileSync(join(SRC, 'i18n', 'resources.ts'), 'utf8');
  // Bounded by the Set literal itself. The old end anchor (`const isLazyFeatureCatalog`)
  // no longer exists, so the slice ran to EOF and any later `'x',` line would have been
  // read as a shell namespace.
  const start = src.indexOf('const SHELL_FEATURE_NAMESPACES');
  const end = src.indexOf(']);', start);
  expect(start, 'SHELL_FEATURE_NAMESPACES declaration moved').toBeGreaterThan(-1);
  expect(end, 'SHELL_FEATURE_NAMESPACES literal is not closed').toBeGreaterThan(start);
  const block = src.slice(start, end);
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

  // NSSPLIT-BORROW-1 — the raw-key half of case 1's claim, with a scanner that sees the
  // BARE borrow forms case 1 is blind to. RED today on the two `file:ns` pairs in the
  // header (cms/SectionRenderer:site, profiles/ProfilePage:twin), so it is pinned as
  // `it.fails`; the fix flips it to `it`. An array hook that LOADS the other namespace
  // is the sanctioned fix (BILLUX-1 chose it for BundleShopPage) and is not counted.
  it.fails('no feature reads another feature namespace it does not load (NSSPLIT-BORROW-1)', () => {
    const feats = new Set(featureDirs());
    const offenders: string[] = [];
    for (const feat of feats) {
      for (const file of sourceFiles(join(FEATURES, feat))) {
        for (const ns of bareBorrowsIn(file)) {
          const key = `${file.slice(SRC.length + 1).split(sep).join('/')}:${ns}`;
          if (ns !== feat && feats.has(ns)) offenders.push(key);
        }
      }
    }
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

  it('ADR 0819 — the lazy AREA catalog `featureToggles` is rendered only by its lazy panel', () => {
    // It is deferred out of the eager chunk; any OTHER renderer (shell or
    // feature) would paint raw keys until the admin panel happened to load it.
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { if (entry !== '__tests__' && entry !== 'i18n') walk(p); continue; }
        if (!/\.tsx?$/.test(entry)) continue;
        // Its own matcher: `namespacesIn` matches lowercase ids only, and this one is camelCase.
        if (/useTranslation\('featureToggles'\)|['"]featureToggles:/.test(readFileSync(p, 'utf8'))) users.push(p.slice(SRC.length + 1));
      }
    };
    walk(SRC);
    expect(users).toEqual(['featureToggles/FeatureTogglePanel.tsx']);
    const chrome = readFileSync(join(SRC, 'chrome', 'features.tsx'), 'utf8');
    expect(chrome).toContain("lazy(() => import('../featureToggles/FeatureTogglePanel.js')");
  });

  it('ADR 0862 — the lazy AREA catalog `assistantAction` is used only where it is loaded first', () => {
    // Deferred out of the eager chunk like `featureToggles`. Its renderer owns a Suspense
    // boundary; every other user either renders that renderer (ReviewCard) or loads the
    // namespace up front without suspending. Any other user would paint raw keys.
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) { if (entry !== '__tests__' && entry !== 'i18n') walk(p); continue; }
        if (!/\.tsx?$/.test(entry)) continue;
        if (/useTranslation\((\[[^\]]*)?'assistantAction'|['"]assistantAction:/.test(readFileSync(p, 'utf8'))) users.push(p.slice(SRC.length + 1));
      }
    };
    walk(SRC);
    expect(users.sort()).toEqual([
      'agents/AgentHealthPanel.tsx',
      'agents/RecurringTasksPanel.tsx',
      'agents/approvalsClient.ts',
      'assistantAction/AssistantActionFields.tsx',
      'chat/reviews/ReviewCard.tsx',
      'notifications/ApprovalsInbox.tsx',
      'notifications/NeedsYouInbox.tsx',
    ]);
    // Loaded WITHOUT suspending: listing it in the main hook blanked the whole inbox page
    // while the chunk loaded.
    for (const f of ['notifications/ApprovalsInbox.tsx', 'notifications/NeedsYouInbox.tsx', 'agents/RecurringTasksPanel.tsx', 'agents/AgentHealthPanel.tsx']) {
      expect(readFileSync(join(SRC, f), 'utf8'), f).toMatch(/useTranslation\('assistantAction', \{ useSuspense: false \}\)/);
    }
    for (const f of ['notifications/ApprovalsInbox.tsx', 'notifications/NeedsYouInbox.tsx', 'chat/reviews/ReviewCard.tsx', 'agents/AgentDrawer.tsx']) {
      expect(readFileSync(join(SRC, f), 'utf8'), f).toMatch(/lazy\(\(\) => import\('\.\.\/(\.\.\/)?assistantAction\/AssistantActionFields\.js'\)/);
    }
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
    // The scanner case 1 relies on actually matches: 562 `useTranslation('ns')` hooks
    // across feature source, MEASURED 2026-10-16. A broken `namespacesIn` regex reads 0
    // and case 1 passes on nothing.
    const hooks = featureDirs().flatMap((f) => sourceFiles(join(FEATURES, f)).flatMap(namespacesIn));
    expect(hooks.length).toBeGreaterThanOrEqual(562);
  });
});
