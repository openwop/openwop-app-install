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
const en = build({
  ...import.meta.glob('/src/i18n/locales/en/*.ts', { eager: true }),
  ...import.meta.glob('/src/features/*/i18n/en.ts', { eager: true }),
  ...import.meta.glob('/src/*/i18n/en.ts', { eager: true }),
});
const ptBR = build({
  ...import.meta.glob('/src/i18n/locales/pt-BR/*.ts', { eager: true }),
  ...import.meta.glob('/src/features/*/i18n/pt-BR.ts', { eager: true }),
  ...import.meta.glob('/src/*/i18n/pt-BR.ts', { eager: true }),
});
/** `{ <namespace>: { <key>: <value> } }` for the `en` locale (the source of truth). */
export const enResources = en.resources;
/** All discovered namespace names (from `en`). */
export const NAMESPACES = en.namespaces;
/**
 * EAGERLY-bundled locales: the default + the supported locales that fit the i18n
 * chunk budget (en + pt-BR ≈ 187 kB gzip < 260). They paint with no network
 * round-trip. The bundling decision is INDEPENDENT of the advertise decision
 * (`SUPPORTED_LOCALES`): further supported locales load lazily (see below), since
 * eager-bundling every locale (~+76 kB gzip each) would blow the chunk budget.
 */
export const resourcesByLocale: Record<string, Record<string, Record<string, unknown>>> = {
  en: en.resources,
  'pt-BR': ptBR.resources,
};

/**
 * LAZY per-locale loaders for locales kept OUT of the eager bundle so they don't
 * tax every user. These may be SUPPORTED (advertised + auto-negotiated, e.g. fr/es)
 * or PREVIEW — either way their catalog is fetched on demand: an auto-negotiated or
 * user-selected lazy locale loads via `ensureLocaleLoaded` (index.ts) with `en` as
 * the first-paint fallback. Vite needs literal glob patterns, so register one
 * non-eager set per locale; each becomes its own async chunk.
 */
const lazyLocaleGlobs: Record<string, Record<string, () => Promise<unknown>>> = {
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

/** Assemble a lazy locale's resources on demand; `null` if it isn't a lazy locale. */
export async function loadLocaleResources(
  locale: string,
): Promise<Record<string, Record<string, unknown>> | null> {
  const globs = lazyLocaleGlobs[locale];
  if (!globs) return null;
  const loaded: Record<string, unknown> = {};
  await Promise.all(
    Object.entries(globs).map(async ([path, load]) => {
      loaded[path] = await load();
    }),
  );
  return build(loaded).resources;
}
