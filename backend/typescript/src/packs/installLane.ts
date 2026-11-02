/**
 * The ONE registry-install lane (ADR 0826 D4).
 *
 * Three routes install a pack from the registry — the marketplace `/install`,
 * the agent-pack registry, and the workflow-chain-pack installer — plus the boot
 * installer. Each used to hand-copy its own preflight, and they had drifted: the
 * semver check lived on one of three, the tombstone check on two, the keys dir on
 * two, and error mapping on one (the chain lane echoed raw installer messages,
 * registry URLs included — `MKT2-29`). That is the sibling-lane shape this loop
 * has now met five times; the cure is structural, so every caller goes through
 * here and the ratchet in `adr0826-install-lane.test.ts` refuses a new direct caller.
 *
 * Core, not the marketplace feature: two of the callers are core routes, and core
 * must not import a feature (ADR 0001).
 */

import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { ARCHIVE_DIR, archivedVersionDir } from './agentPackArchive.js';
import { invalidatePackTrustVerdict } from '../host/packTrust.js';
import { OpenwopError } from '../types.js';
import { isTombstoned } from '../host/packTombstones.js';
import { isPackRevoked } from '../host/packRevocations.js';
import { installPackFromRegistry, isSafePackName, resolveDefaultPackDir, type InstallTarget } from './registryInstaller.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('packs.installLane');

/** SemVer 2.0.0 (with optional pre-release / build). `version` is interpolated
 *  into registry URL templates and the install marker, so it must be clean. */
export const PACK_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Refuse an install request before any byte is fetched: a path-unsafe name, a
 * malformed version, a pack the operator removed (tombstone — restore first), or
 * a REVOKED version (ADR 0826 D5: a kill-switched version never reinstalls).
 * Throws a canonical `OpenwopError`.
 */
export function assertInstallable(target: { name: unknown; version: unknown }): InstallTarget {
  const { name, version } = target;
  if (typeof name !== 'string' || !isSafePackName(name)) {
    throw new OpenwopError('validation_error', 'A pack name is required and must be path-safe.', 400, { field: 'name' });
  }
  if (typeof version !== 'string' || !PACK_SEMVER_RE.test(version)) {
    throw new OpenwopError('validation_error', '`version` must be a SemVer string.', 400, { field: 'version' });
  }
  if (isTombstoned(name)) {
    throw new OpenwopError('conflict', 'Pack is removed from this host. Restore it first.', 409, { packName: name });
  }
  if (isPackRevoked(name, version)) {
    throw new OpenwopError('conflict', `${name}@${version} is revoked on this host and cannot be installed.`, 409, { packName: name, version, reason: 'pack_revoked' });
  }
  return { name, version };
}

/** The operator's trusted-keys fallback dir. ONE resolution, here — it used to be
 *  re-derived (or forgotten) per route. Relative to the process cwd, as before. */
function trustedKeysDir(): string {
  return resolve('../../../registry/keys');
}

/** Raw installer messages carry registry URLs (`manifest_fetch_failed (404): https://…`);
 *  a client never needs the operator's registry topology (`MKT2-29`). */
function scrub(msg: string): string {
  return msg.replace(/https?:\/\/\S+/g, '<registry>');
}

/**
 * Translate the registry-installer's low-level failures (raw `Error`s, by design)
 * into clear, actionable canonical errors. Without this a pack that simply isn't
 * published to the registry (a 404 manifest fetch) surfaces as a bare 500
 * "unexpected error" — the operator can't tell a missing pack from a real fault.
 */
export function translateInstallError(err: unknown, packName: string, version: string): OpenwopError {
  if (err instanceof OpenwopError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const details = { packName, version };
  if (/^manifest_fetch_failed \(404\)|^tarball_fetch_failed \(404\)/.test(msg)) {
    return new OpenwopError(
      'not_found',
      `"${packName}@${version}" isn't published to the pack registry, so it can't be installed. A first-party pack vendored in the image must also be published to packs.openwop.dev before it is installable.`,
      404,
      details,
    );
  }
  if (/^(manifest|tarball|signature|public_key)_fetch_failed|^pack_registry_unreachable|^registry_endpoint/.test(msg)) {
    return new OpenwopError('runner_unavailable', `The pack registry is unavailable right now — couldn't install "${packName}". Try again shortly.`, 502, details);
  }
  if (/^pack_content_refused/.test(msg)) {
    return new OpenwopError('validation_error', `"${packName}" ships content this host refuses (${scrub(msg)}) and was not installed.`, 422, { ...details, reason: 'pack_content_refused' });
  }
  if (/(integrity_mismatch|signature_invalid|signature_unverifiable|unsupported_integrity|manifest_identity_mismatch)/.test(msg)) {
    return new OpenwopError('validation_error', `"${packName}" failed signature or integrity verification and was not installed.`, 422, details);
  }
  return new OpenwopError('runner_unavailable', `Couldn't install "${packName}": ${scrub(msg)}`, 502, details);
}

/**
 * Install `target` from the operator-configured registry (`OPENWOP_REGISTRY_URL`,
 * else the installer default), verifying exactly as the installer does, with
 * every failure mapped to a canonical error. Call `assertInstallable` first.
 */
export async function installFromConfiguredRegistry(target: InstallTarget): Promise<{ installed: boolean; reason?: string }> {
  const registry = process.env.OPENWOP_REGISTRY_URL;
  try {
    return await installPackFromRegistry(target, {
      packDir: resolveDefaultPackDir(),
      ...(registry ? { registry } : {}),
      trustedKeysDir: trustedKeysDir(),
    });
  } catch (err) {
    // The raw reason (registry URL included) is for the operator's logs only.
    log.warn('pack_install_failed', { name: target.name, version: target.version, reason: err instanceof Error ? err.message : String(err) });
    throw translateInstallError(err, target.name, target.version);
  }
}

// ── ADR 1014 D1 (corrected) — fetch an archived agent-pack version ──────────

/** A background fetch never outlives this; the run path never waits on it. */
export const ARCHIVE_FETCH_TIMEOUT_MS = 60_000;
/** After a failure, the same version is not fetched again for this long: a
 *  permanent refusal (404, integrity, signature, admission) for 6 h, anything else
 *  (unreachable, timeout) for 10 min. Bounds the load a missing version can cause. */
const PERMANENT_BACKOFF_MS = 6 * 3_600_000;
const TRANSIENT_BACKOFF_MS = 10 * 60_000;
const PERMANENT = /\b404\b|not.?found|integrity|signature|admission|admissible|revoked|tombstone|namespace|pack_content_refused|invalid/i;
const inflight = new Map<string, Promise<boolean>>();
const failedUntil = new Map<string, number>();

/** Test seam — clears the single-flight and backoff state. */
export function __resetArchiveFetchStateForTests(): void {
  inflight.clear();
  failedUntil.clear();
}

/** True when the version's install marker is in place (a whole, verified install). */
function hasMarker(dir: string): boolean {
  return existsSync(join(dir, '.openwop-installed.json'));
}

/**
 * Install exactly `name@version` into `<packDir>/.versions/<name>/<version>/`
 * through the same signed, verified installer the boot lane uses. Never touches
 * the head. It lands in a hidden temp dir first and is renamed into place, so a
 * reader sees the whole version or none of it.
 *
 * Bounded three ways: single-flight per version per instance, held until the
 * DOWNLOAD settles (not the timeout), so a slow registry never stacks downloads; a
 * per-version backoff after a failure; and a timeout on what the caller waits for.
 * Resolves `true` when the version is cached afterwards, `false` otherwise, and
 * never rejects: callers are background prefetches.
 */
export function fetchArchivedVersion(name: string, version: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const key = `${name}@${version}`;
  const running = inflight.get(key);
  const install = running ?? startArchiveFetch(key, name, version);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    install,
    new Promise<boolean>((res) => { timer = setTimeout(() => res(false), opts.timeoutMs ?? ARCHIVE_FETCH_TIMEOUT_MS); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function startArchiveFetch(key: string, name: string, version: string): Promise<boolean> {
  const p = (async (): Promise<boolean> => {
    let tmp: string | undefined;
    try {
      const packDir = resolveDefaultPackDir();
      const final = archivedVersionDir(packDir, name, version);
      if (final === null) return false;
      if (hasMarker(final)) return true;
      if ((failedUntil.get(key) ?? 0) > Date.now()) return false;
      const target = assertInstallable({ name, version });
      const parent = join(packDir, ARCHIVE_DIR, name);
      mkdirSync(parent, { recursive: true });
      tmp = join(parent, `.tmp-${version}-${randomBytes(4).toString('hex')}`);
      const registry = process.env.OPENWOP_REGISTRY_URL;
      await installPackFromRegistry(target, { packDir, destDir: tmp, ...(registry ? { registry } : {}), trustedKeysDir: trustedKeysDir() });
      // A dir without a marker is a partial or tampered leftover: replace it.
      if (existsSync(final) && !hasMarker(final)) rmSync(final, { recursive: true, force: true });
      if (!existsSync(final)) {
        try {
          renameSync(tmp, final);
          tmp = undefined;
        } catch (err) {
          // Another process won the race; its copy is as good if it is whole.
          if (!hasMarker(final)) throw err;
        }
      }
      invalidatePackTrustVerdict(final);
      failedUntil.delete(key);
      log.info('fetched archived agent pack version', { name, version });
      return hasMarker(final);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failedUntil.set(key, Date.now() + (PERMANENT.test(reason) ? PERMANENT_BACKOFF_MS : TRANSIENT_BACKOFF_MS));
      log.warn('archived agent pack version fetch failed', { name, version, reason });
      return false;
    } finally {
      if (tmp) {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
