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

import { recordRegistryInstallFailure, recordRegistryInstallSkip, recordRegistryInstallSuccess, registryInstallStatus, resetRegistryInstallStatus, setRegistryInstallAttempted } from '../host/registryInstallStatus.js';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createLogger } from '../observability/logger.js';
import { isTombstoned } from '../host/packTombstones.js';
import { isPackRevoked } from '../host/packRevocations.js';
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

/** ADR 0919 correction — feature packs by NAME, with the pin resolved only for a
 *  pack that is actually absent on disk. Every `createApp()` boot calls this, so
 *  resolving every pin here made every boot depend on every pin (a pin bump
 *  re-ran ~1,165 test files under Tracegate). */
export interface FeaturePackNames {
  names: readonly string[];
  resolve: (name: string) => InstallTarget;
}

export async function ensureRegistryPacksInstalled(featurePacksIn: InstallTarget[] | FeaturePackNames = []): Promise<void> {
  resetRegistryInstallStatus(0);
  const raw = process.env.OPENWOP_INSTALL_PACKS;
  const packDir = resolveDefaultPackDir();

  const envTargets = raw === 'none' ? [] : (raw ? parseInstallList(raw) : DEFAULT_PACKS);
  // Feature-declared packs not already present on disk — always attempted. The
  // presence test is by NAME, so a pin is read only for a pack this boot installs.
  const missingFeaturePacks = Array.isArray(featurePacksIn)
    ? featurePacksIn.filter((p) => !existsSync(join(packDir, p.name)))
    : featurePacksIn.names.filter((n) => !existsSync(join(packDir, n))).map((n) => featurePacksIn.resolve(n));

  // Dedupe by name@version (env list + missing feature packs).
  const seen = new Set<string>();
  const targets: InstallTarget[] = [];
  const strict = process.env.OPENWOP_STRICT_REGISTRY === 'true';
  // NP-V2 P7 (review) — which lane a target came from. A FEATURE-required pack
  // is absent from disk by definition, so its failure is not covered by a
  // vendored copy the way a pinned pack's is; the readiness report says which.
  const featureKeys = new Set(missingFeaturePacks.map((p) => `${p.name}@${p.version}`));
  let refused = 0;
  for (const t of [...envTargets, ...missingFeaturePacks]) {
    // Dedupe FIRST, so a pin listed twice is one attempt (and one refusal).
    const key = `${t.name}@${t.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lane = featureKeys.has(key) ? 'feature' as const : 'pinned' as const;
    // ADR 0194 P4: a tombstoned (removed-from-host) pack is never re-installed at
    // boot; a superadmin restore (or explicit marketplace install) lifts it.
    // Checked BEFORE the downgrade classification (grade-code C-2): a deliberately
    // removed pack must never be counted as a failed install.
    if (isTombstoned(t.name)) {
      log.info('registry pack install skipped (tombstoned)', { pack: t.name });
      recordRegistryInstallSkip(t.name, t.version, 'tombstoned');
      continue;
    }
    // ADR 0826 D5 (/architect A5) — a REVOKED version listed in the boot pins is
    // refused, never fetched: the kill switch must survive a cold start. Counted
    // as a refusal (an attempt that failed), so readiness reports it.
    if (isPackRevoked(t.name, t.version)) {
      log.error('registry pack install refused (revoked)', { pack: t.name, version: t.version });
      recordRegistryInstallFailure(t.name, t.version, lane, 'pack_revoked');
      refused += 1;
      continue;
    }
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
      recordRegistryInstallFailure(t.name, t.version, lane, 'pin_below_vendored');
      refused += 1;
      continue;
    }
    if (verdict === 'skip') {
      log.warn('registry pack install skipped (vendored newer)', { pack: t.name, pinned: t.version, vendored: onDisk });
      recordRegistryInstallSkip(t.name, t.version, 'vendored_newer');
      continue;
    }
    targets.push(t);
  }
  // Refusals are attempts too: `installed + failed.length === attempted` is the
  // invariant verify-deploy checks.
  setRegistryInstallAttempted(targets.length + refused);
  if (targets.length === 0) {
    if (raw === 'none') log.info('registry pack install disabled (OPENWOP_INSTALL_PACKS=none); no missing feature packs');
    logIfNoneInstalled(); // every pin was refused (below vendored / revoked)
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
        recordRegistryInstallSuccess();
      } catch (err) {
        // NP-V2 P7 — counted, so /readiness can report it (the warn line alone
        // hid 16 refusals for eight days).
        const errCode = (err as { code?: unknown } | null)?.code;
        const code = typeof errCode === 'string' ? errCode : 'install_failed';
        recordRegistryInstallFailure(target.name, target.version, featureKeys.has(`${target.name}@${target.version}`) ? 'feature' : 'pinned', code);
        log.warn('registry pack install failed; continuing without it', {
          name: target.name,
          version: target.version,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  logIfNoneInstalled();
}

/** ADR 0713 OQ1 — a boot that ATTEMPTED registry installs and landed none is an
 *  outage of the registry lane, not N unrelated warnings: say it once, at error.
 *  Boot continues (a registry outage must not take the app down — the user's call,
 *  D-20); `/readiness` already reports the counts as `checks.registryPacks`
 *  (`attempted` > 0 with `installed` 0) without failing readiness. Nothing
 *  attempted (`OPENWOP_INSTALL_PACKS=none`, nothing missing) is not an outage. */
function logIfNoneInstalled(): void {
  const st = registryInstallStatus();
  if (st.attempted === 0 || st.installed > 0) return;
  log.error('registry_install_none_succeeded', {
    reasonCode: 'registry_install_none_succeeded',
    attempted: st.attempted,
    failed: st.failed.length,
    codes: [...new Set(st.failed.map((f) => f.code))].sort(),
  });
}
