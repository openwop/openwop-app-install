/** Types for scripts/check-build-installs.mjs (consumed by backend tests). */

/** Build configs that MUST exist and MUST be scanned (the floor). */
export const REQUIRED: readonly string[];

/** One `npm install` occurrence in a build config. */
export interface BuildInstallFinding {
  /** Path relative to the scanned root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The raw line, trimmed. */
  text: string;
}

export interface BuildInstallScan {
  /** Every build config the walk read, relative to the root. */
  files: string[];
  findings: BuildInstallFinding[];
  /** REQUIRED entries the walk did not read. */
  missing: string[];
}

/** Is this a file whose contents describe how something gets built? */
export function isBuildConfig(name: string, relPath: string): boolean;

/** Scan `root` (default: the repo) for build configs that run `npm install`. */
export function scan(opts?: { root?: string; required?: readonly string[] }): BuildInstallScan;
