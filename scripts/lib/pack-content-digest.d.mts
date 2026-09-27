/**
 * Types for `pack-content-digest.mjs` so the backend's parity test can import
 * the generator-side implementation under `tsc --noEmit`.
 *
 * Same `.mjs` + `.d.mts` pairing the repo already uses for `gen-distribution`,
 * `gen-feature-deps` and `schemaDrift`. The runtime twin with the full
 * rationale is `backend/typescript/src/packs/packContentDigest.ts`.
 */

export interface PackDigestEntry {
  path: string;
  kind: 'f' | 'l' | 'o';
  leaf: string;
}

export function listPackEntries(packDir: string): PackDigestEntry[];
export function packContentDigest(packDir: string): string;
