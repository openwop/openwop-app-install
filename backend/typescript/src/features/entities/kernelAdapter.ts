/**
 * ADR 0409/0410 — the shared kernel-adapter factory (KERNEL-5).
 *
 * cms.page, crm.company, crm.deal, and commerce.product are all `system`-type
 * façades over the content kernel (ADR 0408): the domain service keeps its logic
 * and stores the record as a kernel row (queryable scalars → `values`, the full
 * object → `ext.<domain>`, SoT). The four adapters were byte-for-byte identical
 * boilerplate — and had already drifted (crm.deal silently lacked the `cas` that
 * company/product carry). This factory is the single source of that adapter
 * shape: each façade supplies only its domain mappers; the kernel plumbing lives
 * here once. It stays generic over `T` (no domain type enters `entities/`) and
 * only consolidates the façade→kernel edge that already existed.
 *
 * `migrate({ overwriteIfNewer })` serves BOTH the id-preserving initial move
 * (skip-if-present — the default, unchanged behaviour of the shipped
 * migrateXToKernel) AND the post-rollout straggler re-sweep (KERNEL-6):
 * updatedAt-newer-wins, so a legacy row an old instance wrote DURING the deploy
 * window (fresher than the already-copied kernel row) is reconciled instead of
 * skipped. The re-sweep's MIGRATION ENTRY is deploy-sequenced (must land the
 * release AFTER the program deploys, per the v8 lesson) — but the capability
 * lives here, ready.
 */
import {
  getSystemEntity, listSystemEntities, putSystemEntity, deleteSystemEntity,
  casSystemEntity, __clearSystemEntities, type EntityRecord,
} from './entitiesService.js';

/** A domain object mapped to its kernel shape. `status` is forwarded verbatim;
 *  omit it (crm/commerce) to inherit the kernel default (live), or set
 *  `'draft'`/`'live'` (cms.page derives it from workflow status). */
export interface KernelMapped {
  values: Record<string, unknown>;
  ext: Record<string, unknown>;
  status?: 'draft' | 'live';
}

export interface KernelAdapterConfig<T> {
  typeName: string;
  ensureType: (tenantId: string) => Promise<void>;
  toKernel: (v: T) => KernelMapped;
  fromKernel: (rec: EntityRecord) => T;
  idOf: (v: T) => string;
  tenantOf: (v: T) => string;
  orgOf: (v: T) => string | undefined;
  actorOf: (v: T) => string;
  /** Domain `updatedAt` accessor — required ONLY for the newer-wins re-sweep
   *  (`migrate({ overwriteIfNewer: true })`); the default migrate never reads it. */
  updatedAtOf?: (v: T) => string | undefined;
  legacy: { list: () => Promise<T[]>; __clear: () => Promise<void> };
}

export interface KernelMigrateResult { migrated: number; skipped: number; updated: number }

export interface KernelAdapter<T> {
  get(tenantId: string, id: string): Promise<T | null>;
  listForTenant(tenantId: string): Promise<T[]>;
  put(v: T): Promise<void>;
  /** ADR 0754 — create-only: `409 conflict` if any row holds this id (tenant-wide),
   *  including one a concurrent writer lands between the read and the write. */
  create(v: T): Promise<void>;
  /** Byte-identical CAS over the stored `ext.<domain>` (merge / money-path safety). */
  cas(expected: T, next: T): Promise<boolean>;
  delete(tenantId: string, id: string): Promise<void>;
  __clear(): Promise<void>;
  /** Idempotent legacy→kernel move, id-preserving. `overwriteIfNewer` turns it
   *  into the straggler re-sweep (updatedAt-newer-wins); default is
   *  skip-if-present (the shipped migration behaviour). */
  migrate(opts?: { overwriteIfNewer?: boolean }): Promise<KernelMigrateResult>;
}

export function makeKernelAdapter<T>(cfg: KernelAdapterConfig<T>): KernelAdapter<T> {
  const { typeName, ensureType, toKernel, fromKernel, idOf, tenantOf, orgOf, actorOf, updatedAtOf, legacy } = cfg;

  const write = async (v: T, createOnly: boolean): Promise<void> => {
    await ensureType(tenantOf(v));
    const { values, ext, status } = toKernel(v);
    const orgId = orgOf(v);
    await putSystemEntity({
      tenantId: tenantOf(v), typeName, entityId: idOf(v), values, ext,
      ...(orgId !== undefined ? { orgId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(createOnly ? { createOnly: true } : {}),
      actor: actorOf(v),
    });
  };
  const put = (v: T): Promise<void> => write(v, false);

  const get = async (tenantId: string, id: string): Promise<T | null> => {
    await ensureType(tenantId);
    const rec = await getSystemEntity(tenantId, typeName, id);
    return rec ? fromKernel(rec) : null;
  };

  return {
    get,
    async listForTenant(tenantId) {
      await ensureType(tenantId);
      return (await listSystemEntities(tenantId, typeName)).map(fromKernel);
    },
    put,
    create: (v) => write(v, true),
    async cas(expected, next) {
      await ensureType(tenantOf(expected));
      const { values, ext, status } = toKernel(next);
      const orgId = orgOf(next);
      const expectedJson = JSON.stringify(expected);
      const rec = await casSystemEntity({
        tenantId: tenantOf(expected), typeName, entityId: idOf(expected),
        matches: (cur) => JSON.stringify(fromKernel(cur)) === expectedJson,
        values, ext,
        ...(orgId !== undefined ? { orgId } : {}),
        ...(status !== undefined ? { status } : {}),
        actor: actorOf(next),
      });
      return rec !== null;
    },
    async delete(tenantId, id) {
      await deleteSystemEntity({ tenantId, typeName, entityId: id });
    },
    async __clear() {
      await __clearSystemEntities(typeName);
      await legacy.__clear();
    },
    async migrate(opts) {
      const overwrite = opts?.overwriteIfNewer ?? false;
      let migrated = 0, skipped = 0, updated = 0;
      for (const v of await legacy.list()) {
        const existing = await get(tenantOf(v), idOf(v));
        if (existing) {
          // Straggler re-sweep (KERNEL-6): a legacy row FRESHER than the already
          // -copied kernel row is an update an old instance made during the
          // deploy window — reconcile it. Plain skip-if-present would drop it.
          if (overwrite && updatedAtOf) {
            const legacyAt = updatedAtOf(v);
            const kernelAt = updatedAtOf(existing);
            if (legacyAt !== undefined && (kernelAt === undefined || legacyAt > kernelAt)) {
              await put(v);
              updated += 1;
            } else {
              skipped += 1;
            }
          } else {
            skipped += 1;
          }
          continue;
        }
        await put(v);
        migrated += 1;
      }
      return { migrated, skipped, updated };
    },
  };
}
