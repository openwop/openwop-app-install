/**
 * ADR 1031 — the FRONTEND half of the adopter feature seam.
 *
 * An adopter repo (a white-label downstream such as KickTodo) ships its own
 * feature packages at `src/adopter/features/<id>/routes.tsx`, a path openwop-app
 * never writes. Each exports `<camelId>Feature: FrontendFeature`, exactly like a
 * first-party `src/features/<id>/routes.tsx`. They are discovered here with an
 * EAGER glob, so the adopter never edits an upstream-owned file to register one.
 *
 * Eager, like the first-party registry's static imports: a `routes.tsx` is the
 * feature's route + nav METADATA (its pages are `lazy(...)`), and the shell needs
 * every route before first paint. An empty glob (openwop-app itself has no
 * `src/adopter/`) yields `{}`, so `FRONTEND_FEATURES` is unchanged upstream.
 *
 * Survives every distribution build: `registry.ts` imports this module by a name
 * the ADR 0366 filter never matches, so the generated `registry.distribution.ts`
 * keeps it. Adopter features are not excludable by a manifest — they ship in
 * every build of the repo that wrote them.
 */
import type { FrontendFeature } from './registry.js';

const PATH_RE = /\/adopter\/features\/([^/]+)\/routes\.tsx$/;
const camel = (kebab: string): string => kebab.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function isFrontendFeature(v: unknown): v is FrontendFeature {
  return typeof v === 'object' && v !== null
    && typeof (v as { id?: unknown }).id === 'string'
    && Array.isArray((v as { routes?: unknown }).routes);
}

/**
 * Turn the glob's `{ path → module }` map into features, sorted by directory.
 * Throws (at module load = app boot) on a module that does not export
 * `<camelDir>Feature` — the export the distribution tooling keys on.
 *
 * ADR 1031 P2 correction: the directory is NOT required to equal `feature.id`.
 * On the frontend, `FrontendFeature.id` names the BACKEND feature the package
 * belongs to (its nav-message prefix, `ownerFeatureId`, tab `featureId`, offline
 * entitlement), and one backend feature legitimately has several frontend
 * packages: first-party KickTodo's `kicktodo` and `kicktodo-admin` are both
 * `kicktodo-core`, `kicktodo-studio` is `kicktodo-creator`. The P1 rule would
 * have refused six of KickTodo's nine packages at P3. The directory/export name
 * is the package's key, exactly as for first-party packages.
 */
export function collectAdopterFrontendFeatures(modules: Readonly<Record<string, unknown>>): FrontendFeature[] {
  const out: FrontendFeature[] = [];
  for (const path of Object.keys(modules).sort()) {
    const dir = PATH_RE.exec(path)?.[1];
    if (!dir) continue;
    const exportName = `${camel(dir)}Feature`;
    const mod = modules[path] as Record<string, unknown> | undefined;
    const feature = mod?.[exportName];
    if (!isFrontendFeature(feature)) {
      throw new Error(`adopter feature '${dir}': routes.tsx must export ${exportName} (ADR 1031)`);
    }
    out.push(feature);
  }
  return out;
}

/**
 * Append the adopter features to the first-party list. A duplicate id — an
 * adopter feature reusing a first-party id or another adopter's — throws: two
 * features under one id would fight over its toggle, nav entry and routes in
 * whatever order the array held. Returns the first-party array's elements
 * unchanged when there are no adopter features.
 */
export function composeFrontendFeatures(firstParty: readonly FrontendFeature[], adopter: readonly FrontendFeature[]): FrontendFeature[] {
  if (adopter.length === 0) return [...firstParty];
  // An adopter package may not attach to a backend feature a FIRST-PARTY package
  // already owns (it would merge nav messages and tabs into a feature it does not
  // own). Several adopter packages of one adopter backend feature are fine — the
  // id is the owner, not the package (ADR 1031 P2).
  const taken = new Set(firstParty.map((f) => f.id));
  const dupes = [...new Set(adopter.filter((f) => taken.has(f.id)).map((f) => f.id))];
  if (dupes.length > 0) {
    throw new Error(`duplicate adopter feature id: ${dupes.join(', ')} (ADR 1031)`);
  }
  return [...firstParty, ...adopter];
}

/** The adopter's frontend features (none in openwop-app). */
export const ADOPTER_FRONTEND_FEATURES: FrontendFeature[] = collectAdopterFrontendFeatures(
  import.meta.glob('/src/adopter/features/*/routes.tsx', { eager: true }),
);
