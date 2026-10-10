/** Types for scripts/gen-distribution.mjs (consumed by backend tests). */
export function generate(name: string, opts?: { write?: boolean }): {
  name: string;
  generated: boolean;
  reason?: string;
  excludedBackend?: string[];
  excludedFrontend?: string[];
};

/** A `distributions/bundles.json`-shaped catalog (P4: core + bundles; ADR 0820
 *  §7 UI: the ordered store `groups` + each bundle's optional `group`). `unknown`
 *  where the checker must reject a malformed value rather than the type system. */
export interface BundleCatalog {
  core?: string[];
  groups?: unknown;
  bundles?: Record<string, { label?: string; group?: unknown; features?: string[] }>;
}

/** Validate the bundle catalog's P4 invariants; returns the error list
 *  (empty = valid). Pass an override to test synthetic catalogs. */
export function checkBundleCatalog(catalogOverride?: BundleCatalog): string[];

/** ADR 0820 §1 alt (b) — toggle id → the backend feature directory that registers it. */
export function toggleCatalog(): Map<string, string>;

/** ADR 0820 §4 — sub-toggle id (a toggle id that is not a feature id) → its parent feature. */
export function subToggleParents(registered?: Set<string>): Map<string, string>;
