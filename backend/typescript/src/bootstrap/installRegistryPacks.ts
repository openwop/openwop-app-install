/**
 * Boot-time pack installer for the workflow-engine sample.
 *
 * Default: installs `core.openwop.ai@1.0.0` and `core.openwop.http@1.0.0`
 * from packs.openwop.dev so the builder palette has real registry nodes
 * (in addition to the locally-defined sample nodes).
 *
 * Overrides:
 *   OPENWOP_INSTALL_PACKS=core.openwop.ai@1.0.0,core.openwop.http@1.0.0
 *   OPENWOP_REGISTRY_URL=https://packs.openwop.dev
 *   OPENWOP_PACK_DIR=./packs
 *
 * Set OPENWOP_INSTALL_PACKS=none to disable. Install failures are
 * logged but never block startup — the sample falls back to its
 * locally-registered nodes when the registry is unreachable.
 */

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createLogger } from '../observability/logger.js';
import {
  installPackFromRegistry,
  parseInstallList,
  resolveDefaultPackDir,
  type InstallTarget,
} from '../packs/registryInstaller.js';

const log = createLogger('bootstrap.installRegistryPacks');

const DEFAULT_PACKS: InstallTarget[] = [
  { name: 'core.openwop.ai', version: '1.0.0' },
  { name: 'core.openwop.http', version: '1.0.0' },
];

/**
 * Install registry packs. `featurePacks` (from `featurePackRefs()`, ADR 0014
 * Phase 0) are packs a composed BackendFeature DECLARED via `requiredPacks` —
 * they are ALWAYS honored (even under `OPENWOP_INSTALL_PACKS=none`), because a
 * feature requiring a pack must get it. In-tree feature packs are already on
 * disk from the local mount / vendored image, so those are skipped (no pointless
 * registry round-trip); only genuinely-absent declared packs hit the registry.
 */
export async function ensureRegistryPacksInstalled(featurePacks: InstallTarget[] = []): Promise<void> {
  const raw = process.env.OPENWOP_INSTALL_PACKS;
  const packDir = resolveDefaultPackDir();

  const envTargets = raw === 'none' ? [] : (raw ? parseInstallList(raw) : DEFAULT_PACKS);
  // Feature-declared packs not already present on disk — always attempted.
  const missingFeaturePacks = featurePacks.filter((p) => !existsSync(join(packDir, p.name)));

  // Dedupe by name@version (env list + missing feature packs).
  const seen = new Set<string>();
  const targets: InstallTarget[] = [];
  for (const t of [...envTargets, ...missingFeaturePacks]) {
    const key = `${t.name}@${t.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(t);
  }
  if (targets.length === 0) {
    if (raw === 'none') log.info('registry pack install disabled (OPENWOP_INSTALL_PACKS=none); no missing feature packs');
    return;
  }

  const registry = process.env.OPENWOP_REGISTRY_URL;
  const trustedKeysDir = resolve('../../../registry/keys');

  // Install in parallel — each pack is independent, and serial waits
  // burn boot latency proportional to the slowest network round-trip.
  // Promise.allSettled so one failed install never poisons the others.
  await Promise.allSettled(
    targets.map(async (target) => {
      try {
        const result = await installPackFromRegistry(target, {
          packDir,
          registry,
          trustedKeysDir,
        });
        if (result.installed) {
          log.info('registry pack ready', { name: target.name, version: target.version });
        } else {
          log.info('registry pack already installed', { name: target.name, version: target.version });
        }
      } catch (err) {
        log.warn('registry pack install failed; continuing without it', {
          name: target.name,
          version: target.version,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
