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
import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '../observability/logger.js';
import { isTombstoned } from '../host/packTombstones.js';
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
/** ADR 0655 D5 — pure, so the rule is a unit witness. `onDisk` null ⇒ nothing
 *  vendored ⇒ install. A vendored copy STRICTLY newer than the pin is never
 *  overwritten: strict ⇒ refuse (loud), non-strict ⇒ skip. */
export function classifyRegistryInstall(input: { onDisk: string | null; requested: string; strict: boolean }): 'install' | 'skip' | 'refuse' {
  if (!input.onDisk) return 'install';
  if (compareSemverLoose(input.onDisk, input.requested) <= 0) return 'install';
  return input.strict ? 'refuse' : 'skip';
}
function compareSemverLoose(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0); const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d; }
  return 0;
}
function readOnDiskVersion(dir: string): string | null {
  try { const m = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf-8')) as { version?: unknown }; return typeof m.version === 'string' ? m.version : null; }
  catch { return null; }
}

export async function ensureRegistryPacksInstalled(featurePacks: InstallTarget[] = []): Promise<void> {
  const raw = process.env.OPENWOP_INSTALL_PACKS;
  const packDir = resolveDefaultPackDir();

  const envTargets = raw === 'none' ? [] : (raw ? parseInstallList(raw) : DEFAULT_PACKS);
  // Feature-declared packs not already present on disk — always attempted.
  const missingFeaturePacks = featurePacks.filter((p) => !existsSync(join(packDir, p.name)));

  // Dedupe by name@version (env list + missing feature packs).
  const seen = new Set<string>();
  const targets: InstallTarget[] = [];
  const strict = process.env.OPENWOP_STRICT_REGISTRY === 'true';
  for (const t of [...envTargets, ...missingFeaturePacks]) {
    // ADR 0655 D5 (EMWF-2) — a registry install must never DOWNGRADE below the
    // image-vendored copy. The mount symlinks the vendored pack first; a symlink
    // carries no install marker, so the installer used to rmSync it and write the
    // OLDER pin every boot (measured 2026-09-11: `core.openwop.integration` 1.1.2
    // vendored, 1.1.0 pinned — the WF-EM-6 fix never served). In STRICT mode the
    // policy holds (the pin is what ships, signed) and the drift is REFUSED loudly
    // — `preflight-deploy.sh` fails on it before the build; non-strict keeps the
    // vendored copy and skips the install.
    const onDisk = readOnDiskVersion(join(packDir, t.name));
    const verdict = classifyRegistryInstall({ onDisk, requested: t.version, strict });
    if (verdict === 'refuse') {
      log.error('registry pin below vendored — install refused, the drift must be fixed by publish + re-pin (ADR 0655 D5)', { pack: t.name, pinned: t.version, vendored: onDisk });
      continue;
    }
    if (verdict === 'skip') { log.warn('registry pack install skipped (vendored newer)', { pack: t.name, pinned: t.version, vendored: onDisk }); continue; }
    // ADR 0194 P4: a tombstoned (removed-from-host) pack is never re-installed
    // at boot; a superadmin restore (or explicit marketplace install) lifts it.
    if (isTombstoned(t.name)) { log.info('registry pack install skipped (tombstoned)', { pack: t.name }); continue; }
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
