/**
 * NP-V2 P7 — what the boot-time registry install actually did, readable after the
 * fact.
 *
 * WHY THIS EXISTS. On 2026-09-20 the v2 install gate began refusing all 16
 * `core.openwop.workflows.*` packs in `OPENWOP_INSTALL_PACKS` at every boot. The
 * only trace was a `warn` line — "registry pack install failed; continuing without
 * it" — and nothing else noticed for eight days: readiness stayed 200 (correctly:
 * the vendored copies served) and `verify-deploy.sh` checks only the commit. A
 * failure that is survivable by design is also invisible by design unless
 * something counts it. This counts it, `/readiness` reports it, and the deploy
 * verifier refuses a revision that reports any.
 *
 * Process-local on purpose: it describes THIS instance's boot, which is what a
 * post-deploy probe of this revision is asking about.
 */

export interface RegistryInstallFailure {
  name: string;
  version: string;
  /** `pinned` = named in OPENWOP_INSTALL_PACKS (a vendored copy may still serve);
   *  `feature` = required by a feature and absent from disk (nothing serves it). */
  lane: 'pinned' | 'feature';
  /** Why it failed (grade-code C-3): `pin_below_vendored` (ADR 0655 D5 strict
   *  refusal), the install gate's refusal code (`validation_error`,
   *  `pack_engine_unsupported`, …) or `install_failed` (fetch / verify error). */
  code: string;
}

/** A pin the boot deliberately did not attempt (grade-data D-4). Not a failure:
 *  `tombstoned` = an operator removed the pack; `vendored_newer` = non-strict
 *  mode kept a newer image-vendored copy (strict mode refuses instead). */
export interface RegistryInstallSkip {
  name: string;
  version: string;
  reason: 'tombstoned' | 'vendored_newer';
}

export interface RegistryInstallStatus {
  /** When this instance's boot install ran (grade-data D-4): a probe that hits a
   *  different instance, or an instance that re-booted, can tell. */
  bootAt: string;
  /** Targets the boot attempted to install (after vendored/tombstone filtering). */
  attempted: number;
  installed: number;
  /** Install threw — refused by a gate, unreachable, unverifiable. The detail is in the log line. */
  failed: RegistryInstallFailure[];
  /** Pins not attempted, and why — so a pin that "did nothing" is explained. */
  skipped: RegistryInstallSkip[];
}

let status: RegistryInstallStatus = { bootAt: new Date(0).toISOString(), attempted: 0, installed: 0, failed: [], skipped: [] };

export function resetRegistryInstallStatus(attempted: number): void {
  status = { bootAt: new Date().toISOString(), attempted, installed: 0, failed: [], skipped: [] };
}

export function recordRegistryInstallSkip(name: string, version: string, reason: RegistryInstallSkip['reason']): void {
  status.skipped.push({ name, version, reason });
}

export function setRegistryInstallAttempted(attempted: number): void {
  status.attempted = attempted;
}

export function recordRegistryInstallSuccess(): void {
  status.installed += 1;
}

export function recordRegistryInstallFailure(name: string, version: string, lane: RegistryInstallFailure['lane'], code: string): void {
  status.failed.push({ name, version, lane, code });
}

/** A copy — callers must not be able to edit the record. */
export function registryInstallStatus(): RegistryInstallStatus {
  return {
    bootAt: status.bootAt,
    attempted: status.attempted,
    installed: status.installed,
    failed: status.failed.map((f) => ({ ...f })),
    skipped: status.skipped.map((s) => ({ ...s })),
  };
}
