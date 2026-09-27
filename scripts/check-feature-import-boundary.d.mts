/** Types for scripts/check-feature-import-boundary.mjs (consumed by backend tests). */
export const INVARIANT: string;

export interface FeatureImport {
  /** Repo-relative importer path (forward slashes). */
  file: string;
  line: number;
  /** The import specifier as written. */
  spec: string;
  /** The `features/<dir>` segment the specifier resolves into. */
  dir: string;
}

export interface AllowlistEntry {
  file: string;
  feature: string;
  owner: string;
  why: string;
  since?: string;
  tracking?: string;
}

export type Verdict = 'excludable' | 'frontend-unregistered' | 'unregistered';

export interface Violation extends FeatureImport {
  id: string | null;
  kind: Verdict;
  detail: string;
}

export interface Report {
  violations: Violation[];
  allowlisted: (Violation & { entry: AllowlistEntry })[];
  stale: AllowlistEntry[];
  permittedCore: (FeatureImport & { id: string })[];
}

export function registryDirToId(registrySource: string): Map<string, string>;
export function registryIds(registrySource: string): Set<string>;
export function scanFeatureImports(srcDir: string, root?: string): FeatureImport[];
export function classify(deps: {
  imports: FeatureImport[];
  dirToId: Map<string, string>;
  backendIds?: Set<string>;
  core: string[];
  bundleOf: Map<string, string>;
  exclusions: { frontend: Map<string, string[]>; backend: Map<string, string[]> };
  allowlist: AllowlistEntry[];
}): Report;
export function checkFeatureImportBoundary(opts?: { root?: string; allowlistPath?: string }): Report;
export function formatReport(r: Report): string;
