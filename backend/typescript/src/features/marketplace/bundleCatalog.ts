/**
 * Feature-bundle catalog projection (ADR 0366 Phase 3 + Phase 4) — the
 * READ-ONLY source the marketplace bundle shop renders.
 *
 * Single source of truth stays `distributions/bundles.json` (the same file
 * `scripts/gen-distribution.mjs` validates and include-mode manifests resolve
 * against) — this module only PROJECTS it into the THREE tiers the shop shows:
 *   - `bundles`    — sellable feature GROUPINGS (one per toggle category),
 *                    selected as a group;
 *   - `standalone` — every registered feature that is neither core nor bundled
 *                    (DERIVED from the toggle registry, not listed in the JSON),
 *                    individually selectable;
 *   - `core`       — the always-included substrate, shown read-only.
 * Each feature id is enriched from the compiled toggle registry with
 * label/description/category, a `registered` honesty flag (a build that
 * excludes a feature shows the honest gap, not a fabricated label), and its
 * `dependsOn` edges (so the shop can close the dependency graph over the
 * operator's selection and never export an un-buildable manifest — the
 * ADR 0366 P4 buildability ruling).
 *
 * The registered UNIVERSE is sourced from `listRegisteredFeatureIds()`
 * (host-level; the ADR 0194 dependency-graph keys, populated for EVERY feature
 * at boot), NOT `BACKEND_FEATURES` — importing the feature registry here would
 * close an `index → marketplace → routes → bundleCatalog → index` cycle. That
 * gives the true feature-package id set (toggle ids are not feature ids — a
 * feature can register several toggles, or none and be always-on).
 *
 * Deliberately no write path: a distribution manifest becomes real ONLY via a
 * repo commit reviewed in a PR and the gated `gen-distribution` build — the
 * shop composes and EXPORTS a manifest, it never mutates the host (the ADR
 * 0366 P3 pipeline-security ruling).
 */
import { getToggleDefault, getFeatureDependencies, listRegisteredFeatureIds } from '../../host/featureToggles/registry.js';
import { readBundleCatalog } from '../../host/featureBundles.js';

export interface BundleFeatureInfo {
  id: string;
  /** Compiled toggle label when THIS build registers the feature. */
  label?: string;
  description?: string;
  /** The feature's toggle category (its "grouping"), when declared. */
  category?: string;
  /** Hard dependencies (ADR 0194) — the shop closes these over the selection. */
  dependsOn: string[];
  /** False when the feature is not in this build's registry (e.g. a slim
   *  distribution serving the shop) — the UI shows the id, honestly. */
  registered: boolean;
}

export interface FeatureBundleInfo {
  id: string;
  label: string;
  features: BundleFeatureInfo[];
}

export interface FeatureBundleCatalog {
  /** False when this deployment ships no `distributions/bundles.json`. */
  available: boolean;
  bundles: FeatureBundleInfo[];
  /** Non-core, non-bundled registered features — individually selectable. */
  standalone: BundleFeatureInfo[];
  /** The always-included substrate — read-only on the shop. */
  core: BundleFeatureInfo[];
}

function enrich(id: string, registeredIds: Set<string>): BundleFeatureInfo {
  const reg = getToggleDefault(id);
  return {
    id,
    registered: registeredIds.has(id),
    dependsOn: getFeatureDependencies(id),
    ...(reg?.label ? { label: reg.label } : {}),
    ...(reg?.description ? { description: reg.description } : {}),
    ...(reg?.category ? { category: reg.category } : {}),
  };
}

export function featureBundleCatalog(): FeatureBundleCatalog {
  const empty: FeatureBundleCatalog = { available: false, bundles: [], standalone: [], core: [] };
  const parsed = readBundleCatalog();
  if (!parsed) return empty;

  const registeredIds = new Set(listRegisteredFeatureIds());
  const coreIds = parsed.core;
  const coreSet = new Set(coreIds);
  const bundledSet = new Set<string>();
  const bundles: FeatureBundleInfo[] = [];
  for (const [id, def] of Object.entries(parsed.bundles)) {
    const featureIds = def.features;
    for (const f of featureIds) bundledSet.add(f);
    bundles.push({
      id,
      label: def.label ?? id,
      features: featureIds.map((fid) => enrich(fid, registeredIds)),
    });
  }

  // Standalone = every registered feature that is neither core nor bundled.
  // Derived (not enumerated) so a NEW feature is auto-selectable.
  const standalone = [...registeredIds]
    .filter((id) => !coreSet.has(id) && !bundledSet.has(id))
    .sort()
    .map((id) => enrich(id, registeredIds));

  const core = coreIds.slice().sort().map((id) => enrich(id, registeredIds));

  return { available: true, bundles, standalone, core };
}
