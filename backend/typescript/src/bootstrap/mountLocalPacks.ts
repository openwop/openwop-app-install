/**
 * Dev-mode: mount unsigned local pack directories from the openwop
 * repo's `packs/` tree into the same `OPENWOP_PACK_DIR` that registry-
 * installed packs use.
 *
 * Why: the workflow-engine sample is the example builder. We want its
 * palette to surface every `core.openwop.*` pack in the repo, even the
 * ones not yet published to packs.openwop.dev. The catalog route
 * (`routes/nodeCatalog.ts`) and resolver (`bootstrap/nodePackResolver`)
 * already scan that dir, so once a pack appears there it shows up in
 * the palette automatically.
 *
 * Trust model: this is DEV ONLY. We only mount packs that are NOT
 * already present at the destination — registry-installed (signed,
 * trust-marked) packs always win. The mount is a symlink so editing
 * pack source in the repo is reflected without a re-run.
 *
 * Opt-out: `OPENWOP_MOUNT_LOCAL_PACKS=false`.
 * Override path: `OPENWOP_LOCAL_PACKS_DIR=<abs-path-to-packs-dir>`.
 * Strict registry mode: `OPENWOP_STRICT_REGISTRY=true` — disables the
 *   "newer local version shadows older registry install" behavior. Use
 *   for prod-like runs where only signed registry packs may execute.
 *
 * Future phase: when all core packs are published with proper Ed25519
 * signing, drop this mount in favor of `DEFAULT_PACKS` in
 * installRegistryPacks.ts. See ARCHITECTURE.md §"Path to real packs".
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../observability/logger.js';
import { isTombstoned } from '../host/packTombstones.js';
import { resolveDefaultPackDir } from '../packs/registryInstaller.js';

const log = createLogger('bootstrap.mountLocalPacks');

// Pack-name prefixes the dev mount surfaces from the workspace `packs/` tree.
// `core.openwop.*` are the protocol's own packs; `vendor.myndhyve.*` are the
// reference vendor packs whose host surfaces the reference app implements
// (host.kanban/chat/canvas/knowledge/launchStudio/webResearch) — mounting them
// makes those nodes available in the builder so the wired surfaces are runnable.
// `feature.*` are feature-package packs (ADR 0001 §2.3/§3 Phase 3) so a
// separately-distributed feature's packs dev-mount through the SAME pipeline.
//
// Config-driven (ADR §2.4 — unblocks the hardcoded-prefix limitation):
// OPENWOP_LOCAL_PACK_PREFIXES (CSV) REPLACES this default set when present, so
// a deploy can widen (e.g. add `vendor.acme.`) or narrow the mount surface
// without a code change. No loader change — the registry/signing path is
// untouched; this only governs which dev-mounted local packs are surfaced.
const DEFAULT_LOCAL_PACK_PREFIXES = ['core.openwop.', 'vendor.myndhyve.', 'feature.'] as const;

export function localPackPrefixes(): string[] {
  const raw = process.env.OPENWOP_LOCAL_PACK_PREFIXES;
  if (raw && raw.trim().length > 0) {
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [...DEFAULT_LOCAL_PACK_PREFIXES];
}

/**
 * A directory PARKED by the shadow pass below (`<name>.registry-<version>`) —
 * preserved so the superseded registry install is recoverable, but it must
 * NEVER be loaded: its pack.json still declares the ORIGINAL pack name, so a
 * scanner that iterates it loads a stale manifest that (iterating after the
 * live dir alphabetically) overwrites the fresh registration. Every
 * `readdirSync(<pack dir>)` scanner must skip entries matching this.
 */
export function isParkedPackDirName(name: string): boolean {
  return /\.registry-[0-9]/.test(name);
}

export interface MountResult {
  /** Directories mounted on this run (excludes pre-existing). */
  mounted: string[];
  /** Directories already present at the destination (registry-installed or previously mounted). */
  skipped: string[];
  /** Registry-installed dirs we shadowed with a newer local version
   *  (when not in OPENWOP_STRICT_REGISTRY=true mode). The old dir is
   *  renamed to `<name>.registry-<version>` so it's recoverable. */
  shadowed: string[];
  /** WF-CMNT-10 — packs whose local copy DIFFERS from the registry install at the
   *  SAME declared version: somebody edited a pack and forgot the bump.
   *
   *  DETECTED, not acted on. This is deliberately NOT a subset of `shadowed`: the
   *  registry install keeps serving and this list is the diagnostic. See the long
   *  note at the detection site for why reporting is the whole remedy here. */
  driftDetected?: string[];
  /** Symlinks removed because their source checkout no longer exists. */
  pruned?: string[];
  /** Whether mounting was disabled via env. */
  disabled: boolean;
}

export function ensureLocalPacksMounted(): MountResult {
  if (process.env.OPENWOP_MOUNT_LOCAL_PACKS === 'false') {
    log.info('local pack mount disabled (OPENWOP_MOUNT_LOCAL_PACKS=false)');
    return { mounted: [], skipped: [], shadowed: [], disabled: true };
  }
  // Example builder defaults to dev-friendly behavior: a newer local
  // pack shadows an older registry install so the palette shows every
  // node in the repo. Set OPENWOP_STRICT_REGISTRY=true for prod-style
  // behavior where only registry-installed (signed) packs are honored.
  const preferLocal = process.env.OPENWOP_STRICT_REGISTRY !== 'true';

  const localDir = resolveLocalPacksDir();
  if (!localDir || !existsSync(localDir)) {
    log.info('no local packs dir to mount', { searched: localDir ?? '<not-found>' });
    return { mounted: [], skipped: [], shadowed: [], pruned: [], disabled: false };
  }

  const destDir = resolveDefaultPackDir();
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const mounted: string[] = [];
  const skipped: string[] = [];
  const shadowed: string[] = [];
  /** WF-CMNT-10 — same-version content drift, DETECTED (never acted on). */
  const driftDetected: string[] = [];

  for (const entry of readdirSync(localDir)) {
    if (!shouldMount(entry)) continue;
    // ADR 0194 P4: a tombstoned (removed-from-host) pack is never re-mounted.
    if (isTombstoned(entry)) { skipped.push(entry); continue; }
    const src = join(localDir, entry);
    if (!statSync(src).isDirectory()) continue;
    if (!existsSync(join(src, 'pack.json'))) continue;

    const dest = join(destDir, entry);

    // A symlink at the destination is a PRIOR dev-mount (registry installs are
    // real directories carrying `.openwop-installed.json` — never symlinks). If it
    // already points at THIS repo it's a no-op. Otherwise it's stale: either
    // DANGLING (a removed worktree, e.g. under /tmp) or pointing at ANOTHER
    // checkout's `packs/` (the parallel-worktree hazard). `existsSync` follows the
    // link, so a dangling one reads as ABSENT and the create below would throw
    // EEXIST and skip the pack — silently breaking every node/agent/surface it
    // ships. Re-point any stale symlink at this repo so the running instance always
    // mounts its OWN vendored packs (a symlink is never a signed registry dir, so
    // this can't clobber one). Fixes node-pack/runtime tests that otherwise fail
    // on a machine whose ~/.openwop-packs links into other/removed checkouts.
    const destLink = symlinkTarget(dest);
    if (destLink !== null) {
      if (destLink === src) { skipped.push(entry); continue; }
      try {
        rmSync(dest, { force: true });
        symlinkSync(src, dest, 'dir');
        mounted.push(entry);
        log.info('re-pointed stale local-pack symlink to this repo (parallel-worktree hygiene)', { pack: entry, was: destLink });
      } catch (err) {
        log.warn('local pack mount failed', { pack: entry, error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    if (existsSync(dest)) {
      // Idempotent: if a previous boot already shadowed this pack, the
      // dest is now a symlink into the repo. Nothing to do.
      if (isSymlinkToRepo(dest, src)) {
        skipped.push(entry);
        continue;
      }
      // A destination with NO READABLE MANIFEST is rubble, not an install.
      //
      // `shouldShadow()` returns false when either side's version is
      // unreadable, so a registry dir whose `pack.json` is missing or corrupt
      // could never be shadowed — and the `existsSync(dest)` branch below then
      // skips it. Net effect: the broken directory permanently blocks the
      // vendored copy, with no repair path short of deleting it by hand.
      //
      // MEASURED 2026-08-13: `~/.openwop-packs/core.openwop.ai` held ONLY
      // `.openwop-installed.json` — no `pack.json`, no `index.mjs`. That pack
      // provides `core.ai.structuredOutput`, so eight conformance scenarios
      // failed for want of a node type and were quarantined as undiagnosed host
      // failures. The host was fine; the directory was rubble that nothing could
      // clear.
      //
      // "Don't clobber registry installs" is the right instinct and still holds
      // for every dir that HAS a manifest — shadowing there stays version-gated.
      // This branch only fires when there is nothing to protect. It is also
      // deliberately NOT gated on `preferLocal`: `OPENWOP_STRICT_REGISTRY=true`
      // means "prefer the signed registry copy", not "keep an unloadable one".
      // Under ADR 0555 P0 the replacement is still trust-classified like any
      // other mount, so this cannot launder untrusted code into a trusted slot.
      if (readManifestVersion(dest) === null) {
        try {
          rmSync(dest, { recursive: true, force: true });
          symlinkSync(src, dest, 'dir');
          mounted.push(entry);
          log.warn('replaced an unloadable pack dir (no readable pack.json) with the vendored copy', {
            pack: entry,
            destDir: dest,
            localVersion: readManifestVersion(src),
          });
        } catch (err) {
          log.warn('failed to replace unloadable pack dir', {
            pack: entry,
            error: err instanceof Error ? err.message : String(err),
          });
          skipped.push(entry);
        }
        continue;
      }
      // WF-CMNT-10 — same-version content drift is REPORTED, never acted on.
      //
      // THE OBSERVATION. The node lane's only precedence rule is `shouldShadow`,
      // a STRICT `>`, so an EQUAL version leaves the registry-installed copy in
      // place and records the miss in `skipped` with no WARN and no content
      // compare. Every pack is born at 1.0.0, so a pack FIX that forgot a version
      // bump is inert on a registry-installing host — and that host looks
      // identical to one that never received it.
      //
      // ── WHY THIS IS A LOG LINE AND NOT A SHADOW (corrected before merge) ──
      //
      // The first version of this code ALSO shadowed on drift: it renamed the
      // registry install aside and symlinked the repo copy over it. That was
      // wrong in three independent ways, and it is worth recording all three so
      // the idea is not re-proposed.
      //
      //  1. It DOWNGRADES TRUST, and under ADR 0555 P0 that means it can kill a
      //     working pack. The parked dir is `operator-trusted` — Ed25519 + SRI
      //     verified at install and RE-verified on every load
      //     (`registryInstaller.verifyInstalledPack`). The symlink replacing it is
      //     only `steward` if `packs/.steward-manifest.json` carries a MATCHING
      //     digest (`host/packTrust.classifyPackDir`); otherwise it is
      //     `no_attestation` → `untrusted` → `dispatchable: false`. The manifest
      //     is a SEPARATE CI-gated artifact (`scripts/ci.sh` → `gen-steward-
      //     manifest.mjs --check`), so a developer who edited a pack and forgot
      //     the version bump has, with the same keystroke, almost certainly not
      //     regenerated it. The pack would go from STALE to DEAD — and the parked
      //     `<name>.registry-<version>` dir is skipped by every scanner
      //     (`isParkedPackDirName`), so the working copy is present-but-unloadable
      //     by design and the operator sees a pack that vanished.
      //
      //  2. It is a THIRD opinion on a question two seams already own, and the
      //     only one that mutates state to express it. `check-pack-version-bump.mjs`
      //     (run from `scripts/ci.sh`) refuses the MERGE on exactly this mistake —
      //     fail-closed, repo-wide, and explicitly de-vacuumed for node packs.
      //     `check-pack-pin-drift.mjs` covers repo-vs-production. A boot-time WARN
      //     cannot refuse anything, so it must not pretend to be the enforcement.
      //
      //  3. It was not needed by its own motivating change: the pack that prompted
      //     this (`feature.comments.nodes`) bumped 1.0.0 → 1.1.0, which the
      //     pre-existing `shouldShadow` already handles. And `feature.*` packs are
      //     never registry-installed at all (`check-pack-pin-drift.mjs`'s MANAGED =
      //     `/^(core\.openwop\.|vendor\.)/`), so for that pack there is never a
      //     marker-carrying dir here to shadow.
      //
      // ── REACHABILITY, STATED PLAINLY (do not overclaim this) ──
      //
      // This branch needs `dest` to already EXIST. Mount runs BEFORE the registry
      // installer (`index.ts`), so on a fresh Cloud Run container the pack dir is
      // empty and this cannot fire — `OPENWOP_STRICT_REGISTRY` is irrelevant to
      // that. It is NOT production coverage. Its real population is hosts with a
      // PERSISTENT pack dir: dev boxes, and self-hosted white-label operators
      // running a volume. For production the cure is unchanged and lives
      // elsewhere: republish to the registry and advance the pin (DEPLOY.md,
      // "Vendoring a pack is NOT shipping it").
      //
      // NOT gated on `preferLocal`. It is a pure log line with no blast radius,
      // and under `OPENWOP_STRICT_REGISTRY=true` the state it names — the repo
      // vendors one thing, the host runs another — is precisely the pin-drift
      // class that is worth the most. Gating the diagnostic on the flag would
      // silence it exactly where it is most informative.
      //
      // Identical content is silent: there is nothing to say and nothing to fix.
      const drift = sameVersionContentDrift(src, dest);
      if (drift) {
        // The message states the FACT and the remedy. It deliberately does not
        // say "shadowing it" — nothing is shadowed here, and a log line that
        // asserts an action it did not take is worse than no log line.
        log.warn('local pack DIFFERS from the registry install at the SAME version — the REGISTRY copy is being served; bump the pack version, republish, and advance the pin', {
          pack: entry,
          version: readManifestVersion(src) ?? 'unknown',
          localDir: src,
          registryDir: dest,
        });
        driftDetected.push(entry);
      }
      if (preferLocal && shouldShadow(src, dest)) {
        const installedVer = readManifestVersion(dest) ?? 'unknown';
        const newName = `${entry}.registry-${installedVer}`;
        const newPath = join(destDir, newName);
        try {
          // A previous shadow pass may have already preserved this same
          // registry version. If so, just discard the freshly-installed
          // dir rather than failing on rename collision.
          if (existsSync(newPath)) {
            rmSync(dest, { recursive: true, force: true });
          } else {
            renameSync(dest, newPath);
          }
          symlinkSync(src, dest, 'dir');
          shadowed.push(entry);
          log.warn('local pack shadows registry install (dev mode; set OPENWOP_STRICT_REGISTRY=true to disable)', {
            pack: entry,
            registryVersion: installedVer,
            localVersion: readManifestVersion(src),
            preservedAs: newName,
          });
          continue;
        } catch (err) {
          log.warn('failed to shadow registry pack with local', {
            pack: entry,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Don't clobber registry installs or a prior mount. Registry-
      // installed packs carry `.openwop-installed.json`; mounted packs
      // are symlinks — either way, leave them alone unless dev-mode
      // shadowing kicked in above.
      skipped.push(entry);
      continue;
    }
    try {
      symlinkSync(src, dest, 'dir');
      mounted.push(entry);
    } catch (err) {
      log.warn('local pack mount failed', {
        pack: entry,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── PRUNE DANGLING MOUNTS (worktree-teardown hygiene) ────────────────────
  //
  // The re-point branch above only heals packs THIS repo also has. A pack that
  // exists solely in some other checkout leaves a symlink here that outlives
  // that checkout: `git worktree remove` deletes the target and nothing ever
  // revisits the link.
  //
  // OBSERVED, not hypothetical (2026-08-06): all 180 symlinks in a developer's
  // `~/.openwop-packs` were dangling at once — 174 of them from a single
  // worktree removed minutes earlier. Every non-vitest boot reading those packs
  // fails, and the failure points at a path that no longer exists, which reads
  // as a corrupt install rather than a stale link. (Vitest is unaffected:
  // `test/setup/isolatePackDir.ts` gives each worker its own dir.)
  //
  // A dangling symlink is useless BY DEFINITION — it resolves to nothing — so
  // removing it cannot lose data. It also restores the honest signal: an absent
  // pack is reported as not installed, rather than as an install that explodes
  // on read.
  const pruned: string[] = [];
  for (const entry of readdirSync(destDir)) {
    const dest = join(destDir, entry);
    if (symlinkTarget(dest) !== null && !existsSync(dest)) {
      try {
        rmSync(dest, { force: true });
        pruned.push(entry);
      } catch (err) {
        log.warn('failed to prune dangling local-pack symlink', {
          pack: entry, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (pruned.length > 0) {
    log.warn('pruned dangling local-pack symlinks (their source checkout is gone)', {
      count: pruned.length, packs: pruned.slice(0, 10),
    });
  }

  log.info('local packs mounted', {
    mounted: mounted.length,
    skipped: skipped.length,
    shadowed: shadowed.length,
    // WF-CMNT-10 — non-zero means at least one pack was edited without a
    // version bump. Surfaced in the summary so it is visible without grepping.
    sameVersionDrift: driftDetected.length,
    pruned: pruned.length,
    preferLocal,
    sourceDir: localDir,
    destDir,
  });
  return { mounted, skipped, shadowed, driftDetected, pruned, disabled: false };
}

/** The link target if `p` is a symlink (dangling or not), else null. Unlike
 *  `existsSync`, this does NOT follow the link — so a dangling dev-mount left by a
 *  removed worktree is detected rather than mistaken for an absent destination. */
function symlinkTarget(p: string): string | null {
  try {
    return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
  } catch {
    return null;
  }
}

function isSymlinkToRepo(dest: string, expectedTarget: string): boolean {
  try {
    if (!lstatSync(dest).isSymbolicLink()) return false;
    const target = readlinkSync(dest);
    return target === expectedTarget;
  } catch {
    return false;
  }
}

function shouldShadow(srcDir: string, destDir: string): boolean {
  const local = readManifestVersion(srcDir);
  const installed = readManifestVersion(destDir);
  if (!local || !installed) return false;
  return compareSemver(local, installed) > 0;
}

/**
 * WF-CMNT-10 — true when the two copies declare the SAME version and their
 * CONTENT differs: the state that means somebody edited a pack and forgot the
 * bump. The chain lane's `workflow_chain_pack_duplicate_content_drift` answers
 * the same question by canonicalising the parsed chain; there is no equivalent
 * parsed form for a node pack, so this digests the directory.
 *
 * Bounded on purpose: it is reached ONLY when both versions are readable and
 * EQUAL (so a real upgrade never pays for it), it walks the pack dir once, and
 * it SKIPS registry bookkeeping (`.openwop-installed.json`, `.openwop-*`) which
 * exists on one side only and would make every comparison report drift.
 *
 * Unreadable ⇒ FALSE. An IO failure must not be reported as drift: that would
 * shadow a signed registry install on the strength of a failed read, which is a
 * worse outcome than the miss this exists to surface.
 */
function sameVersionContentDrift(srcDir: string, destDir: string): boolean {
  const local = readManifestVersion(srcDir);
  const installed = readManifestVersion(destDir);
  if (!local || !installed || compareSemver(local, installed) !== 0) return false;
  const a = digestPackDir(srcDir);
  const b = digestPackDir(destDir);
  return a !== null && b !== null && a !== b;
}

/** A stable digest of a pack directory's content (sorted relative paths + bytes),
 *  ignoring registry bookkeeping files. `null` on any read failure — see above. */
function digestPackDir(dir: string): string | null {
  try {
    const h = createHash('sha256');
    for (const rel of walkPackFiles(dir, '').sort()) {
      h.update(rel);
      h.update('\0');
      h.update(readFileSync(join(dir, rel)));
      h.update('\0');
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Files that are NOT pack content and must never read as drift.
 *
 * The first version of this excluded only `.openwop*` (registry bookkeeping,
 * which exists on the installed side only). That is too narrow by a wide margin:
 * the two sides are a REPO WORKING TREE and an UNPACKED TARBALL, and the working
 * tree accumulates files the tarball never carries. A `.DS_Store` from opening
 * the folder in Finder, a `.pack.json.swp` from an editor session, an `index.mjs~`
 * backup, a stray `node_modules/` — each of those would have been reported as
 * "somebody edited this pack and forgot the version bump."
 *
 * A false WARN is cheap; a false WARN that fires on most developers' machines is
 * not, because it trains everyone to ignore the real one. Anything dot-prefixed
 * is excluded (it covers `.openwop*`, `.DS_Store`, `.git`, `.#emacs-lock`),
 * plus editor swap/backup suffixes and dependency dirs.
 */
function isIncidentalPackFile(name: string): boolean {
  return (
    name.startsWith('.')
    || name === 'node_modules'
    || name.endsWith('~')
    || /\.(swp|swo|swn|tmp|orig|rej|bak|log)$/i.test(name)
  );
}

function walkPackFiles(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    if (isIncidentalPackFile(name)) continue;
    const next = rel ? join(rel, name) : name;
    if (statSync(join(root, next)).isDirectory()) out.push(...walkPackFiles(root, next));
    else out.push(next);
  }
  return out;
}

function readManifestVersion(packDir: string): string | null {
  try {
    const raw = readFileSync(join(packDir, 'pack.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Returns >0 if a > b, <0 if a < b, 0 if equal. Pre-release / build
 *  metadata is ignored — best-effort semver compare only. */
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n.split('-')[0]) || 0);
  const pb = b.split('.').map((n) => Number(n.split('-')[0]) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function shouldMount(name: string): boolean {
  return localPackPrefixes().some((p) => name.startsWith(p));
}

/**
 * Resolve `<repo>/packs/`. Preference order:
 *   1. OPENWOP_LOCAL_PACKS_DIR (absolute path).
 *   2. Walk up from this module's directory looking for `packs/`
 *      adjacent to a workspace marker (`package.json` with name
 *      `openwop` or a `spec/v1` dir).
 */
function resolveLocalPacksDir(): string | null {
  const override = process.env.OPENWOP_LOCAL_PACKS_DIR;
  if (override) return resolve(override);

  // Start from this file's location so we work regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 10; i++) {
    const candidate = join(cur, 'packs', 'core.openwop.ai', 'pack.json');
    if (existsSync(candidate)) return join(cur, 'packs');
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
