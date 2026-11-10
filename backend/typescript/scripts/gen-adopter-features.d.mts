/** Types for scripts/gen-adopter-features.mjs (ADR 1031; consumed by tests and vitest.config.ts). */
export const ADOPTER_FEATURE_ID_RE: RegExp;
export const GENERATED_FEATURES_REL: string;
export const GENERATED_PINS_REL: string;
export const ADOPTER_FEATURES_REL: string;
export const ADOPTER_PACK_PINS_REL: string;
export function adopterExportName(id: string): string;
export function scanAdopterBackendFeatures(pkgRoot?: string): Array<{ id: string; exportName: string; importPath: string }>;
export function hasAdopterPackPins(pkgRoot?: string): boolean;
export function adopterDependsOn(pkgRoot?: string): Record<string, string[]>;
export function renderFeaturesModule(features: Array<{ id: string; exportName: string; importPath: string }>): string;
export function renderPinsModule(withPins: boolean): string;
export function generateAdopterFeatures(opts?: { pkgRoot?: string; write?: boolean }): {
  features: string[];
  withPins: boolean;
  featuresSource: string;
  pinsSource: string;
  changed: boolean;
};
