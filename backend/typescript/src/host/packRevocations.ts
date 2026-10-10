/**
 * Pack revocations (ADR 0555 P0) — "this pack version must never execute again".
 *
 * ── READ THIS BEFORE REACHING FOR `packTombstones.ts` ─────────────────────
 *
 * These two look alike and mean OPPOSITE things. Conflating them is the single
 * most likely way to break either one, so the contrast is spelled out here and
 * mirrored in the tombstone module's header.
 *
 *   packTombstones  — "removed from this host". The bytes STAY, and its own
 *                     header pins the guarantee: "historical runs/replay/loader
 *                     resolution untouched — the ARCHITECTURE.md replay
 *                     invariant". It hides a pack from AUTHORING surfaces
 *                     (catalog, palette, marketplace) and stops it being
 *                     re-mounted. It is a PRODUCT action and fully reversible.
 *
 *   packRevocations — "never loads or executes, including on replay". A
 *                     SECURITY action against code believed malicious or
 *                     compromised. It DELIBERATELY BREAKS REPLAY of historical
 *                     runs that used the revoked version, and that is the point:
 *                     re-executing known-bad code to reproduce an old run is
 *                     not a trade this host makes. ADR 0555 records the
 *                     trade-off explicitly so a later reader does not "fix"
 *                     revocation into preserving replay and quietly restore the
 *                     hole.
 *
 * So: a tombstoned pack still runs. A revoked pack does not, ever.
 *
 * ── NOT THE ONLY REVOCATION SOURCE ────────────────────────────────────────
 *
 * `host/packSignature.ts` (ADR 0367) already had one: the pinned keyring's
 * `revoked` set, loaded from `OPENWOP_TRUSTED_PACK_REVOCATIONS`, keyed
 * `name@version` — the same format used here. That list is STATIC operator
 * config baked into a deployment; this store is a RUNTIME action that
 * propagates across instances. Both are legitimate, and both answer the same
 * question, which is exactly when two answers drift apart.
 *
 * So neither is read directly by a loader. `host/packTrust.ts` is the single
 * consumer of both, and a hit in EITHER revokes. Do not add a third reader.
 *
 * ── VERSION-SCOPED, WITH AN EXPLICIT WILDCARD ─────────────────────────────
 *
 * The key is `name@version`, not a bare name: revoking 1.2.3 must not stop
 * 1.2.4 (the fix) from installing and running — otherwise the remediation path
 * is blocked by the remediation. A row whose version is `*` revokes every
 * version of that pack, which is the compromised-publisher case; it is a
 * separate, deliberate act rather than the default reading of a bare name.
 *
 * ── BOOT ORDERING IS LOAD-BEARING ─────────────────────────────────────────
 *
 * Sync consumers (`host/packTrust.ts`, called from the pack loaders) read the
 * in-process cache without awaiting. The cache MUST be loaded before any pack
 * loads, in the same boot slot as `loadPackTombstones()`. Get that wrong and
 * revocation fails OPEN on every cold start — a revoked pack executes once per
 * instance and then starts refusing, which is both a real bypass and almost
 * impossible to reproduce from a bug report. `pack-trust-boot-order.test.ts`
 * pins it by asserting refusal on the FIRST dispatch after a cold boot.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.packRevocations');

/** Revoke every version of a pack (compromised publisher). */
export const REVOKE_ALL_VERSIONS = '*';

export interface PackRevocation {
  /** `name@version`, or `name@*` for every version. The deterministic row key. */
  key: string;
  packName: string;
  /** A concrete version, or `*`. */
  version: string;
  revokedAt: string;
  revokedBy: string;
  /** Operator-supplied rationale, surfaced in Operations. Never a secret. */
  reason: string;
}

export function revocationKey(packName: string, version: string): string {
  return `${packName}@${version}`;
}

const store = new DurableCollection<PackRevocation>('pack-revocation', (r) => r.key);

/** Exact `name@version` keys. */
let cachedKeys = new Set<string>();
/** Pack names revoked at every version. */
let cachedWildcards = new Set<string>();

/** ADR 0826 D5 — listeners told when the revocation SET changes (`packTrust`
 *  drops its cached verdicts: any pack may now be `revoked`). An inversion seam,
 *  because `packTrust` already imports this module. */
const changeListeners: Array<() => void> = [];
export function onPackRevocationsChanged(fn: () => void): void {
  changeListeners.push(fn);
}

const fingerprint = (keys: Set<string>, wildcards: Set<string>): string =>
  JSON.stringify([[...keys].sort(), [...wildcards].sort()]);

/** Load (or reload) revocations. Called at boot BEFORE the pack loaders, after
 *  every mutation, and on the cross-instance refresh tick (ADR 0826 D5). */
export async function loadPackRevocations(): Promise<number> {
  const rows = await store.list();
  const keys = new Set<string>();
  const wildcards = new Set<string>();
  for (const r of rows) {
    if (r.version === REVOKE_ALL_VERSIONS) wildcards.add(r.packName);
    else keys.add(r.key);
  }
  const changed = fingerprint(keys, wildcards) !== fingerprint(cachedKeys, cachedWildcards);
  cachedKeys = keys;
  cachedWildcards = wildcards;
  if (changed) for (const fn of changeListeners) fn();
  return rows.length;
}

/**
 * ADR 0826 D5 — the CROSS-INSTANCE half the header always claimed and nothing
 * did: a revocation written on instance A reached instance A's cache only, so
 * every other instance kept dispatching the revoked pack until it restarted.
 * One process-wide poll (idempotent across `createApp` calls; `unref`'d so it
 * never holds a process open). The store is a handful of host-global rows.
 */
let refreshTimer: ReturnType<typeof setInterval> | null = null;
export const DEFAULT_REVOCATION_REFRESH_MS = 30_000;

export function startPackRevocationRefresh(): void {
  if (refreshTimer) return;
  const raw = Number(process.env.OPENWOP_PACK_REVOCATION_REFRESH_MS);
  const every = Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_REVOCATION_REFRESH_MS;
  refreshTimer = setInterval(() => {
    loadPackRevocations().catch((err: unknown) => {
      // Keep the LAST known set — never degrade to "nothing revoked" on a blip.
      log.error('pack_revocation_refresh_failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, every);
  refreshTimer.unref?.();
}

/** Test affordance: stop the poll. */
export function __stopPackRevocationRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Sync revocation check for the trust classifier.
 *
 * An UNKNOWN version (a pack dir whose `pack.json` has no readable version)
 * counts as revoked when the pack name is wildcard-revoked. It does NOT count
 * as revoked otherwise — an unreadable manifest already fails steward and
 * operator-trusted attestation, so it is `untrusted` and non-dispatchable by
 * that route. Reporting it as `revoked` would misattribute the reason.
 */
export function isPackRevoked(packName: string, version: string | null): boolean {
  if (cachedWildcards.has(packName)) return true;
  if (version === null) return false;
  return cachedKeys.has(revocationKey(packName, version));
}

/** All revocations, for the Operations surface. */
export async function listPackRevocations(): Promise<PackRevocation[]> {
  return await store.list();
}

/** Revoke (idempotent — deterministic key). Refreshes the cache. */
export async function revokePack(input: {
  packName: string;
  version: string;
  by: string;
  reason: string;
}): Promise<PackRevocation> {
  const row: PackRevocation = {
    key: revocationKey(input.packName, input.version),
    packName: input.packName,
    version: input.version,
    revokedAt: new Date().toISOString(),
    revokedBy: input.by,
    reason: input.reason,
  };
  await store.put(row);
  await loadPackRevocations();
  return row;
}

/** Un-revoke (idempotent). Returns whether a revocation existed. Refreshes the cache. */
export async function unrevokePack(packName: string, version: string): Promise<boolean> {
  const existed = await store.delete(revocationKey(packName, version));
  await loadPackRevocations();
  return existed;
}

/** Test-only: clear revocations + cache. */
export async function __clearPackRevocations(): Promise<void> {
  await store.__clear();
  cachedKeys = new Set();
  cachedWildcards = new Set();
  for (const fn of changeListeners) fn();
}

/** Test-only: reset ONLY the in-process cache, simulating a cold boot whose
 *  `loadPackRevocations()` has not run yet. Used to prove the fail-open
 *  ordering bug stays fixed. */
export function __resetPackRevocationCacheForTests(): void {
  cachedKeys = new Set();
  cachedWildcards = new Set();
}
