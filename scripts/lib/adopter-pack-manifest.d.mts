/**
 * Types for `adopter-pack-manifest.mjs` (ADR 1048), so the backend's generator
 * and parity tests import the generator-side rules under `tsc --noEmit` — the
 * `pack-content-digest.d.mts` pairing. The runtime twin is
 * `backend/typescript/src/host/adopterPackManifest.ts`.
 */
export interface AdopterManifestEntry {
  version: string | null;
  files: number;
  digest: string;
  declared: string[];
  served: string[];
  held: Record<string, string[]>;
  servedUnresolved?: string[];
  replayClass?: Record<string, string>;
}
export interface AdopterManifest { version: 1; packs: Record<string, AdopterManifestEntry> }
export interface AdopterManifestViolation { code: string; detail: string }
export interface AdopterValidationContext {
  stewardKeys: ReadonlySet<string>;
  pins: Readonly<Record<string, string>> | null;
  upstreamDeclared: ReadonlySet<string>;
  packNameOf: (dir: string) => string | null;
}
export const ADOPTER_MANIFEST_FILE: string;
export const RESERVED_PREFIXES: readonly string[];
export const UPSTREAM_VENDOR_PREFIXES: readonly string[];
export const GRANDFATHERED_ADOPTER_PACK_IDS: readonly string[];
export const ADOPTER_NAMESPACE: RegExp;
export const REPLAY_CLASSES: readonly string[];
export const HELD_BUCKETS: readonly string[];
export const ADOPTER_SRC_REL: string;
export const ADOPTER_PINS_REL: string;
export function validateAdopterManifest(m: unknown, ctx: AdopterValidationContext): AdopterManifestViolation[];
export function readAdopterManifest(root: string): AdopterManifest | null;
export function adopterClaimedDirs(root: string): Set<string>;
export function readStewardKeys(root: string): Set<string>;
export function readAdopterPins(root: string): Record<string, string> | null;
export function packDirNames(root: string): string[];
export function buildAdopterManifest(root: string): AdopterManifest;
export function checkCommittedAdopterManifest(root: string, committed: unknown): AdopterManifestViolation[];
export function serialiseManifest(m: unknown): string;
export function adopterCensus(m: AdopterManifest | null): string[];
