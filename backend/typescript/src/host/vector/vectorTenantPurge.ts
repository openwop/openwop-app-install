/**
 * KB-2 — tenant teardown for the VECTOR MIRROR.
 *
 * THE DEFECT. `deleteAllTenantData` is introspection-complete over Postgres tables
 * whose column is literally `tenant_id` (`storage/postgres/index.ts`), and
 * `host_vectors` names its column `tenant` (`pgVectorVector.ts`) — so the table was
 * never enumerated. It may not even live on the same database
 * (`OPENWOP_VECTOR_PG_DSN`). And `VectorSurface` exposes no namespace-clear or
 * tenant-clear at all: delete is by explicit id, which the KB service documents as a
 * constraint it works around. So there was no mechanism to call even if teardown had
 * known about the table. KB chunk rows carry the chunk's FULL TEXT in `metadata`, so
 * this was retained customer content surviving account deletion indefinitely.
 *
 * WHY A SEPARATE REGISTRY RATHER THAN A METHOD ON `VectorSurface`. `host.db.vector`
 * is the RFC 0018 PACK-FACING surface: every method on it is callable by any node
 * pack, so adding `purgeTenant` there would be a capability-surface change — a wire
 * concern needing an RFC, and a very sharp tool to hand to pack code. Teardown is a
 * HOST operation, so it gets a host-internal seam instead: each backend adapter
 * registers a purger for itself, and the account-deletion flow asks this module.
 *
 * Registering every CONFIGURED backend (not just the SELECTED one) is deliberate: a
 * deployment that has switched backends can hold residue in both, and a purge that
 * skipped the unselected one would leave exactly the durable residue this exists to
 * reclaim. Purgers are best-effort per backend — one failing backend must not abort
 * teardown of the others — but a failure is REPORTED, never swallowed into a success
 * count.
 *
 * CORRECTION (KB-3 R2). That sentence originally read "every backend", and
 * `pgVectorVector.ts` implemented it literally: a purger for a backend the host has
 * no DSN for. Every account delete on a default deployment then reported a partial
 * teardown it had not had — the honest signal below, inverted into permanent noise.
 * "Configured" is the operative word: a backend this host cannot reach holds nothing
 * to reclaim, and claiming otherwise is the same dishonesty in the other direction.
 */

import { createLogger } from '../../observability/logger.js';

const log = createLogger('host.vectorTenantPurge');

/** Deletes every vector row a tenant owns in one backend. Returns the row count. */
export type VectorTenantPurger = (tenantId: string) => Promise<number>;

const purgers = new Map<string, VectorTenantPurger>();

/** Register (or replace) the tenant purger for one vector backend id. */
export function registerVectorTenantPurger(backendId: string, purge: VectorTenantPurger): void {
  purgers.set(backendId, purge);
}

export interface VectorPurgeResult {
  /** Rows deleted across every backend that answered. */
  purged: number;
  /** Backends that ran, in registration order. */
  backends: string[];
  /** Backends that THREW — named, so a partial teardown is never reported as clean. */
  failed: string[];
}

/**
 * Purge every vector row belonging to `tenantId`, across every registered backend.
 * Fail-closed on a falsy tenant (never a wildcard delete).
 */
export async function purgeTenantVectors(tenantId: string): Promise<VectorPurgeResult> {
  if (!tenantId) return { purged: 0, backends: [], failed: [] };
  let purged = 0;
  const backends: string[] = [];
  const failed: string[] = [];
  for (const [backendId, purge] of purgers) {
    try {
      purged += await purge(tenantId);
      backends.push(backendId);
    } catch (err) {
      failed.push(backendId);
      log.error('vector_tenant_purge_failed', { backendId, tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { purged, backends, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR 0664 D1 — the same seam, one scope narrower: a NAMESPACE purge.
//
// Deleting a roster agent cleared its profile, its durable notes and its in-memory
// recall scope, and left the vector rows. `rosterId` is `host:${slugify(persona)}`
// (`rosterService.ts:145`) — DETERMINISTIC — and the duplicate-persona 409 only fires
// while the row exists, so re-creating an agent under the same name reuses the same
// namespace and its first recall returns the DELETED agent's private notes. Not
// orphaned storage: `subjectMemory.ts:139-157` returns `md.content` and the vector
// path WINS over recency, so it is a live recall.
//
// Why not id-collecting like the sibling eraser (`subjectMemory.ts:410-416`): it
// captures row ids BEFORE deleting them, and the roster cascade clears notes first
// and gets back only a COUNT. Even done in the right order it would be incomplete —
// dispatch turn-summaries are indexed with no durable note row (`persistAndIndex`),
// and on a pgvector deployment rows written by a previous process have no in-process
// id source at all. A namespace delete is the only complete mechanism, and it belongs
// here rather than on `host.db.vector` for the same reason the tenant purge does: that
// surface is pack-facing (RFC 0018), and a namespace-clear is far too sharp to hand to
// pack code.

/** Deletes every vector row in ONE namespace, in one backend. Returns the row count. */
export type VectorNamespacePurger = (tenantId: string, namespace: string) => Promise<number>;

const namespacePurgers = new Map<string, VectorNamespacePurger>();

/** Register (or replace) the namespace purger for one vector backend id. */
export function registerVectorNamespacePurger(backendId: string, purge: VectorNamespacePurger): void {
  namespacePurgers.set(backendId, purge);
}

/**
 * Purge one namespace across every registered backend. Fail-closed on a falsy tenant or
 * namespace — never a wildcard delete. Best-effort per backend, and a failure is
 * REPORTED rather than folded into the count, matching the tenant purge above: a caller
 * that cannot distinguish "nothing to delete" from "the delete failed" would re-create
 * the same lie one level up.
 */
export async function purgeNamespaceVectors(tenantId: string, namespace: string): Promise<VectorPurgeResult> {
  if (!tenantId || !namespace) return { purged: 0, backends: [], failed: [] };
  let purged = 0;
  const backends: string[] = [];
  const failed: string[] = [];
  for (const [backendId, purge] of namespacePurgers) {
    try {
      purged += await purge(tenantId, namespace);
      backends.push(backendId);
    } catch (err) {
      failed.push(backendId);
      log.error('vector_namespace_purge_failed', { backendId, tenantId, namespace, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { purged, backends, failed };
}

/** Test seam — drop registrations between suites. */
export function _resetVectorTenantPurgersForTest(): void {
  purgers.clear();
  namespacePurgers.clear();
}

/** Diagnostics: which backends can currently be purged. */
export function registeredVectorPurgeBackends(): string[] {
  return [...purgers.keys()];
}
