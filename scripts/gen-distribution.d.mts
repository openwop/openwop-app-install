/** Types for scripts/gen-distribution.mjs (consumed by backend tests). */
export function generate(name: string, opts?: { write?: boolean }): {
  name: string;
  generated: boolean;
  reason?: string;
  excludedBackend?: string[];
  excludedFrontend?: string[];
};

/** A `distributions/bundles.json`-shaped catalog (P4: core + bundles). */
export interface BundleCatalog {
  core?: string[];
  bundles?: Record<string, { label?: string; features?: string[] }>;
}

/** Validate the bundle catalog's P4 invariants; returns the error list
 *  (empty = valid). Pass an override to test synthetic catalogs. */
export function checkBundleCatalog(catalogOverride?: BundleCatalog): string[];
