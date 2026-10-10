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

import { resolve } from 'node:path';
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
