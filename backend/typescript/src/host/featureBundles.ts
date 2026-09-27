/**
 * Feature-bundle catalog reader (ADR 0366 + ADR 0419) — the ONE host-level
 * reader of `distributions/bundles.json`, so both the marketplace catalog
 * projection (`features/marketplace/bundleCatalog.ts`) AND the billing
 * entitlement resolver (`features/billing/billingService.ts`) resolve a
 * bundle → its feature ids WITHOUT importing each other (the ADR 0001 boundary
 * — billing must not depend on the marketplace feature).
 *
 * Pure fs + path; no feature import. Raw parse only — the marketplace module
 * layers toggle-registry enrichment on top; billing needs only the id lists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from './_repoPath.js';

export interface RawBundle { label?: string; features: string[] }
export interface RawBundleCatalog {
  core: string[];
  bundles: Record<string, RawBundle>;
}

interface BundlesFile {
  core?: unknown;
  bundles?: Record<string, { label?: unknown; features?: unknown }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `<repo>/distributions/bundles.json` — resolved the same way the packs dir is
 *  (sibling of the located schemas dir; `/app/distributions` in the image, the
 *  repo root in dev). */
function bundlesJsonPath(): string {
  const schemasDir = locateRepoSchemasDir(__dirname, 'frontend-plugin-manifest.schema.json');
  return join(dirname(schemasDir), 'distributions', 'bundles.json');
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string') : [];
}

// `bundles.json` is an immutable build artifact — parse it ONCE per process.
// This read is on the entitlement hot path (resolveEntitlements → bundleFeatureIds),
// so a per-call readFileSync+JSON.parse would be wasteful. `undefined` = not yet
// read; `null` = read and absent/malformed.
let cached: RawBundleCatalog | null | undefined;

function loadBundleCatalog(): RawBundleCatalog | null {
  const path = bundlesJsonPath();
  if (!existsSync(path)) return null;
  let parsed: BundlesFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as BundlesFile;
  } catch {
    return null;
  }
  const bundles: Record<string, RawBundle> = {};
  for (const [id, def] of Object.entries(parsed.bundles ?? {})) {
    bundles[id] = {
      ...(typeof def.label === 'string' ? { label: def.label } : {}),
      features: stringArray(def.features),
    };
  }
  return { core: stringArray(parsed.core), bundles };
}

/** Parse `distributions/bundles.json` (memoized per process), or `null` when the
 *  deployment ships none (or it is malformed). Both consumers treat `null` as
 *  "no bundles". */
export function readBundleCatalog(): RawBundleCatalog | null {
  if (cached === undefined) cached = loadBundleCatalog();
  return cached;
}

// The set of every bundled feature id — the "sellable" universe (ADR 0419). A
// feature gates on entitlement iff it belongs to a bundle; core/standalone
// features never do (so the central gate can't over-gate core). Memoized off the
// immutable catalog; on the entitlement hot path.
let bundledSet: Set<string> | undefined;

/** Whether a feature belongs to a sellable bundle (⇒ it is entitlement-gated on
 *  authenticated routes). False for core/standalone features and when no catalog. */
export function isSellableBundleFeature(featureId: string): boolean {
  if (bundledSet === undefined) {
    const cat = readBundleCatalog();
    bundledSet = new Set(cat ? Object.values(cat.bundles).flatMap((b) => b.features) : []);
  }
  return bundledSet.has(featureId);
}

/** The feature ids in a bundle (empty when the bundle is unknown / no catalog). */
export function bundleFeatureIds(bundleId: string): string[] {
  return readBundleCatalog()?.bundles[bundleId]?.features ?? [];
}

/** Every declared bundle id (empty when no catalog). */
export function knownBundleIds(): string[] {
  const cat = readBundleCatalog();
  return cat ? Object.keys(cat.bundles) : [];
}
