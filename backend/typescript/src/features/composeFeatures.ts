/**
 * ADR 1031 — compose the backend feature registry from the first-party list and
 * the adopter features `scripts/gen-adopter-features.mjs` discovered under
 * `src/adopter/features/<id>/`.
 *
 * The composition is checked at MODULE LOAD, which is boot: `features/index.ts`
 * is imported by every entry point (server, tests, conformance), so a bad
 * adopter registration cannot reach a serving process. Two rules:
 *
 *  1. An adopter feature's `id` equals its directory name. The generator derives
 *     the export name from the directory, and the distribution tooling reads
 *     `dependsOn` by directory, so a mismatch would make both lie.
 *  2. Feature ids are unique across the composed registry. A duplicate (an
 *     adopter re-declaring a first-party id, or two features sharing one) would
 *     register one toggle default over another and mount two route sets under
 *     the same `/host/openwop-app/<id>/` prefix — silently, in whatever order the
 *     array happened to hold. It fails fast instead, naming both sides.
 *
 * In openwop-app itself the adopter list is empty, so this returns the
 * first-party array unchanged (same elements, same order).
 */
import type { BackendFeature } from './types.js';

export function composeBackendFeatures(
  firstParty: readonly BackendFeature[],
  adopter: readonly BackendFeature[],
  adopterDirs: readonly string[],
): BackendFeature[] {
  const errors: string[] = [];
  if (adopter.length !== adopterDirs.length) {
    errors.push(`adopter registry is out of step with its directory list (${adopter.length} features, ${adopterDirs.length} dirs) — re-run backend/typescript/scripts/gen-adopter-features.mjs`);
  }
  adopter.forEach((f, i) => {
    const dir = adopterDirs[i];
    if (f !== undefined && dir !== undefined && f.id !== dir) {
      errors.push(`adopter feature in src/adopter/features/${dir}/ declares id '${f.id}' — the directory name IS the feature id`);
    }
  });
  const owner = new Map<string, string>();
  const describe = (f: BackendFeature, isAdopter: boolean): string => (isAdopter ? `adopter feature (src/adopter/features/${f.id})` : 'first-party feature');
  const all: Array<[BackendFeature, boolean]> = [
    ...firstParty.map((f) => [f, false] as [BackendFeature, boolean]),
    ...adopter.map((f) => [f, true] as [BackendFeature, boolean]),
  ];
  for (const [f, isAdopter] of all) {
    // An entry can be `undefined` while this module is still evaluating inside an
    // import cycle (a test that imports a feature module first). The array has always
    // tolerated that transient hole; the registry is complete by the time anything
    // reads it. Validate only what is defined, and return the array unchanged.
    if (f === undefined) continue;
    const prior = owner.get(f.id);
    if (prior) errors.push(`duplicate feature id '${f.id}': ${prior} and ${describe(f, isAdopter)} — feature ids are never shared or renamed`);
    else owner.set(f.id, describe(f, isAdopter));
  }
  if (errors.length > 0) {
    throw new Error(`backend feature registry is invalid (ADR 1031):\n  ${errors.join('\n  ')}`);
  }
  return [...firstParty, ...adopter];
}
