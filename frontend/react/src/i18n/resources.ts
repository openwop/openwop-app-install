/**
 * Catalog aggregation (ADR 0065) — boundary-clean, multi-locale.
 *
 * The i18n CORE must not import features (ADR 0001), so catalogs are collected
 * with Vite `import.meta.glob` (a build pattern, not a named import) from three
 * places, per locale:
 *   core   →  src/i18n/locales/<locale>/<ns>.ts
 *   feature→  src/features/<id>/i18n/<locale>.ts   (ns = <id>)
 *   area   →  src/<area>/i18n/<locale>.ts          (ns = <area>)
 * Each exports `export const messages = { key: 'value', … } as const;`. The
 * namespace is derived from the path, so adding a feature/locale auto-registers
 * with no edit to a shared list. `check-i18n` enforces cross-locale key parity.
 */

type CatalogModule = { messages?: Record<string, unknown> };

function nsFromPath(path: string): string {
  let m = path.match(/\/features\/([^/]+)\/i18n\/[^/]+\.ts$/);
  if (m?.[1]) return m[1];
  m = path.match(/\/i18n\/locales\/[^/]+\/([^/]+)\.ts$/);
  if (m?.[1]) return m[1];
  m = path.match(/\/src\/([^/]+)\/i18n\/[^/]+\.ts$/);
  if (m?.[1]) return m[1];
  return path;
}

function build(modules: Record<string, unknown>): {
  resources: Record<string, Record<string, unknown>>;
  namespaces: string[];
} {
  const resources: Record<string, Record<string, unknown>> = {};
  const namespaces: string[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const ns = nsFromPath(path);
    const messages = (mod as CatalogModule).messages;
    if (!messages) continue;
    if (resources[ns]) {
      console.error(`[i18n] duplicate namespace '${ns}' (second source: ${path})`);
      continue;
    }
    resources[ns] = messages as Record<string, unknown>;
    namespaces.push(ns);
  }
  return { resources, namespaces };
}

// Literal glob patterns (Vite requirement) — one set per locale. `/src/*/i18n`
// matches only a single dir level, never overlapping the two-level `features/*`.
/**
 * ADR 0490 — `en` FEATURE namespaces are LAZY; the shell stays eager.
 *
 * `en` is the fallback locale, so it must paint with no round-trip — but that
 * argument only holds for copy the SHELL renders before any route resolves.
 * A feature's catalog is only needed once that feature's page is on screen, and
 * those pages are ALREADY `lazy(() => import(...))`, so the copy can ride the
 * same boundary the code does.
 *
 * The eager set below is EMPIRICAL, not a guess. Two facts were measured across
 * the whole tree before splitting:
 *   1. NO feature component uses another feature's namespace (0 occurrences), so
 *      a lazy feature catalog can only be needed by its own page.
 *   2. Exactly THREE feature namespaces are rendered by non-feature code, and
 *      they are listed in SHELL_FEATURE_NAMESPACES below with the reason.
 * If either fact stops holding, `i18nNamespaceSplit.test.ts` fails — the split
 * is guarded, not assumed.
 */
const SHELL_FEATURE_NAMESPACES: ReadonlySet<string> = new Set([
  // `src/chat/MessageComments.tsx` — comments render inside the chat feed, which
  // is shell, not a route.
  'comments',
  // `src/chat/artifacts/BomPreview.tsx` — the CAD bill-of-materials artifact
  // renders inline in chat, same reason.
  'cad',
  // `src/chat/artifacts/CampaignPreview.tsx` — the campaign artifact renders
  // inline in chat (R2 CS-SP-4 localizes its enum chips from this catalog).
  'campaign-studio',
  // NOT `notifications`: the bell is shell-rendered, but its catalog lives at
  // `src/notifications/i18n/` (an AREA, not a feature), so the area glob below
  // already keeps it eager. Checked rather than assumed — it was on this list
  // until the import failed and showed where the file actually is.
]);

// The three shell-rendered feature catalogs are imported STATICALLY so they land
// in the eager chunk. This cannot be an `{ eager: true }` glob with a filter:
// an eager glob imports every match at BUILD time, so filtering the resulting
// object afterwards changes nothing about what is bundled (measured — the chunk
// did not move). The literal imports are what actually keep the rest out.
import { messages as commentsEn } from '../features/comments/i18n/en.js';
import { messages as cadEn } from '../features/cad/i18n/en.js';
import { messages as campaignStudioEn } from '../features/campaign-studio/i18n/en.js';

const shellFeatureCatalogs: Record<string, unknown> = {
  '/src/features/comments/i18n/en.ts': { messages: commentsEn },
  '/src/features/cad/i18n/en.ts': { messages: cadEn },
  '/src/features/campaign-studio/i18n/en.ts': { messages: campaignStudioEn },
};

/** Lazy loaders for every OTHER feature's `en` catalog, keyed by namespace. */
const enFeatureLoaders: Record<string, () => Promise<unknown>> = {};
for (const [path, loader] of Object.entries(import.meta.glob('/src/features/*/i18n/en.ts'))) {
  const ns = nsFromPath(path);
  if (!SHELL_FEATURE_NAMESPACES.has(ns)) enFeatureLoaders[ns] = loader;
}

const en = build({
  ...import.meta.glob('/src/i18n/locales/en/*.ts', { eager: true }),
  ...shellFeatureCatalogs,
  ...import.meta.glob('/src/*/i18n/en.ts', { eager: true }),
});

/** Namespaces deferred out of the eager `en` bundle (feature pages own them). */
export const LAZY_EN_NAMESPACES: readonly string[] = Object.keys(enFeatureLoaders).sort();

/** Load one lazy `en` namespace. Resolves to its messages, or null if unknown. */
export async function loadEnNamespace(ns: string): Promise<Record<string, unknown> | null> {
  const loader = enFeatureLoaders[ns];
  if (!loader) return null;
  const mod = (await loader()) as CatalogModule;
  return mod.messages ?? null;
}

/** `{ <namespace>: { <key>: <value> } }` for the `en` locale (the source of truth). */
export const enResources = en.resources;
/** All discovered namespace names (from `en`). */
export const NAMESPACES = en.namespaces;
/**
 * EAGERLY-bundled locales: ONLY `en` (ADR 0329 — per-locale i18n chunks). `en`
 * is the fallback + the source-of-truth catalog, so it must paint with no
 * network round-trip; EVERY other locale — supported (pt-BR/fr/es) or preview —
 * is its own lazy chunk fetched on demand. (pt-BR was eager until 2026-07-10;
 * four budget bumps in two days showed the all-locales chunk grows ~4× faster
 * than any one user needs.) The bundling decision stays INDEPENDENT of the
 * advertise decision (`SUPPORTED_LOCALES`).
 */
export const resourcesByLocale: Record<string, Record<string, Record<string, unknown>>> = {
  en: en.resources,
};

/**
 * LAZY per-locale loaders (ADR 0329) — one async chunk per locale, fetched on
 * demand: an auto-negotiated or user-selected lazy locale loads via
 * `ensureLocaleLoaded` (index.ts) with `en` as the first-paint fallback. Vite
 * needs literal glob patterns, so register one non-eager set per locale. Keep
 * this list in sync with the lazy-locale regex in `vite.config.ts`.
 */
const lazyLocaleGlobs: Record<string, Record<string, () => Promise<unknown>>> = {
  'pt-BR': {
    ...import.meta.glob('/src/i18n/locales/pt-BR/*.ts'),
    ...import.meta.glob('/src/features/*/i18n/pt-BR.ts'),
    ...import.meta.glob('/src/*/i18n/pt-BR.ts'),
  },
  fr: {
    ...import.meta.glob('/src/i18n/locales/fr/*.ts'),
    ...import.meta.glob('/src/features/*/i18n/fr.ts'),
    ...import.meta.glob('/src/*/i18n/fr.ts'),
  },
  es: {
    ...import.meta.glob('/src/i18n/locales/es/*.ts'),
    ...import.meta.glob('/src/features/*/i18n/es.ts'),
    ...import.meta.glob('/src/*/i18n/es.ts'),
  },
};

/**
 * ADR 0490 § follow-up — the SAME namespace split, applied to the lazy locales.
 *
 * After the `en` split the three per-locale chunks (~214–221 kB gzip each)
 * became the largest assets in the build, because `loadLocaleResources` awaited
 * EVERY catalog for a locale at once. A pt-BR user paid for all ~90 feature
 * catalogs to read one page.
 *
 * The partition is identical to `en`'s and shares its justification: a feature's
 * catalog is only needed once that feature's page is on screen, and those pages
 * are already `lazy(() => import(...))`. The two SHELL_FEATURE_NAMESPACES stay in
 * the locale's shell chunk for the same reason they stay eager in `en` — they
 * render inside the chat feed, which is shell, not a route.
 *
 * NOTE on the filter, because it looks like the trap ADR 0490 documents: that
 * trap was filtering an `{ eager: true }` glob, which bundles every match at
 * build time no matter what you do with the object afterwards. These globs are
 * NON-eager — they only produce loaders — so filtering them genuinely decides
 * what gets fetched, and Rollup still splits each catalog into its own chunk.
 */
function partitionLocaleGlobs(globs: Record<string, () => Promise<unknown>>): {
  shell: Record<string, () => Promise<unknown>>;
  features: Record<string, () => Promise<unknown>>;
} {
  const shell: Record<string, () => Promise<unknown>> = {};
  const features: Record<string, () => Promise<unknown>> = {};
  for (const [path, loader] of Object.entries(globs)) {
    const isFeature = /\/src\/features\/[^/]+\/i18n\//.test(path);
    if (isFeature && !SHELL_FEATURE_NAMESPACES.has(nsFromPath(path))) features[nsFromPath(path)] = loader;
    else shell[path] = loader;
  }
  return { shell, features };
}

/**
 * Partitioned ON FIRST USE and memoised, so a locale a user never selects costs
 * no partition work.
 *
 * CORRECTION to an earlier note here: I first attributed the +1.9 kB gzip on the
 * eager `en` chunk to partitioning all three locales at module scope, and made it
 * lazy to reclaim it. Re-measuring showed the eager chunk **did not move** —
 * 126.2 kB either way against a 124.3 kB baseline. The real cause is structural
 * and cannot be refactored away here: splitting the locales turns ~3 shared
 * dynamic-import targets into ~280 per-namespace ones, so the stub table in this
 * (eager) module now carries ~280 distinct hashed chunk paths instead of 3.
 * Laziness is kept because it is better regardless, not because it saved bytes.
 * The trade is stated in the ADR: +1.9 kB for `en`-only users, −118 kB for every
 * user of any other locale.
 */
const partitionCache = new Map<string, ReturnType<typeof partitionLocaleGlobs>>();
function partsFor(locale: string): ReturnType<typeof partitionLocaleGlobs> | null {
  const globs = lazyLocaleGlobs[locale];
  if (!globs) return null;
  let parts = partitionCache.get(locale);
  if (!parts) { parts = partitionLocaleGlobs(globs); partitionCache.set(locale, parts); }
  return parts;
}

/**
 * Assemble a lazy locale's SHELL resources on demand; `null` if it isn't a lazy
 * locale. Feature namespaces for this locale arrive per-namespace via
 * `loadLocaleNamespace`, driven by the i18next backend in `index.ts`.
 */
export async function loadLocaleResources(
  locale: string,
): Promise<Record<string, Record<string, unknown>> | null> {
  const parts = partsFor(locale);
  if (!parts) return null;
  const loaded: Record<string, unknown> = {};
  await Promise.all(
    Object.entries(parts.shell).map(async ([path, load]) => {
      loaded[path] = await load();
    }),
  );
  return build(loaded).resources;
}

/** True when `ns` is deferred out of `locale`'s shell chunk. Cheap + sync, so the
 *  i18next backend can route without precomputing a namespace list per locale. */
export function isLazyLocaleNamespace(locale: string, ns: string): boolean {
  return !!partsFor(locale)?.features[ns];
}

/** Namespaces deferred out of `locale`'s shell chunk. Computed on demand (so it
 *  costs nothing for a locale nobody selects); used by the cross-locale parity
 *  test to reassemble a full locale. */
export function lazyLocaleNamespaces(locale: string): readonly string[] {
  return Object.keys(partsFor(locale)?.features ?? {}).sort();
}

/** Load ONE feature namespace for a lazy locale. `null` when not deferred here. */
export async function loadLocaleNamespace(
  locale: string,
  ns: string,
): Promise<Record<string, unknown> | null> {
  const loader = partsFor(locale)?.features[ns];
  if (!loader) return null;
  const mod = (await loader()) as CatalogModule;
  return mod.messages ?? null;
}
