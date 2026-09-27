// Types for schemaDrift.mjs. The implementation stays plain ESM JavaScript because
// `scripts/*.mjs` are run directly by node (no build step); this declaration exists so
// the vitest suite importing it is fully typed — an untyped .mjs import would resolve
// to `any`, which is banned in this repo.

export declare function leafSet(node: unknown, prefix?: string, out?: Set<string>): Set<string>;

export declare const AHEAD: 'vendored AHEAD of canonical';
export declare const BEHIND: 'vendored BEHIND canonical';
export declare const DIVERGED: 'diverged (both sides differ)';
export declare const UNKNOWN: 'unknown';

export declare function suiteCertifiesCorpusTag(
  vendoredTag: string,
  suiteVersion: string,
  certifiedCorpusTag?: string | null,
): boolean;

export type DriftDirection =
  | typeof AHEAD
  | typeof BEHIND
  | typeof DIVERGED
  | typeof UNKNOWN;

/**
 * Classify drift between the vendored copy and canonical by CONTAINMENT.
 * Non-string input (or unparseable JSON) degrades to `UNKNOWN`, which never
 * green-lights the destructive `sync-schemas.sh` remedy.
 */
export declare function classifyDrift(vendoredText: unknown, canonicalText: unknown): DriftDirection;
