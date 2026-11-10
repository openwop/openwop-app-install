/**
 * ADR 1031 P2 — collect every feature package's `ratchetDeclarations`
 * (`FeatureRatchetDeclarations`, src/features/types.ts) from every feature root:
 * `src/features/<dir>/ratchetDeclarations.ts` and, in an adopter checkout,
 * `src/adopter/features/<dir>/ratchetDeclarations.ts`. A ratchet merges these
 * with its own host table, so a feature package (first-party or adopter) carries
 * its own reviewed exceptions and an upstream table never has to name it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FeatureRatchetDeclarations } from '../../src/features/types.js';
import { featureSourceRoots } from './featureSourceRoots.js';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

export interface CollectedRatchetDeclarations {
  /** The feature directory name (the feature id by convention). */
  featureDir: string;
  /** The directory relative to `src/`, `/`-separated (`features/x`, `adopter/features/x`). */
  srcRel: string;
  declarations: FeatureRatchetDeclarations;
}

export async function collectFeatureRatchetDeclarations(): Promise<CollectedRatchetDeclarations[]> {
  const out: CollectedRatchetDeclarations[] = [];
  for (const root of featureSourceRoots()) {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = join(root, dir.name, 'ratchetDeclarations.ts');
      if (!existsSync(file)) continue;
      const mod = (await import(file)) as { ratchetDeclarations?: FeatureRatchetDeclarations };
      if (!mod.ratchetDeclarations) throw new Error(`${file} must export \`ratchetDeclarations\` (ADR 1031 P2)`);
      out.push({
        featureDir: dir.name,
        srcRel: relative(SRC_ROOT, join(root, dir.name)).split(sep).join('/'),
        declarations: mod.ratchetDeclarations,
      });
    }
  }
  return out;
}
