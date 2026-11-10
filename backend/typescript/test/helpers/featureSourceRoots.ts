/**
 * ADR 1031 — every directory that holds backend FEATURE-PACKAGE source: the
 * first-party `src/features/` and, in an adopter checkout, the adopter's
 * `src/adopter/features/` (absent in openwop-app). A ratchet that walks feature
 * source to find a class of construct (a store, a token mint) walks these, so an
 * adopter's feature packages are held to the same rule as first-party ones.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const FIRST_PARTY_FEATURES_ROOT = join(__dirname, '..', '..', 'src', 'features');
export const ADOPTER_FEATURES_ROOT = join(__dirname, '..', '..', 'src', 'adopter', 'features');

export function featureSourceRoots(): string[] {
  return [FIRST_PARTY_FEATURES_ROOT, ...(existsSync(ADOPTER_FEATURES_ROOT) ? [ADOPTER_FEATURES_ROOT] : [])];
}
