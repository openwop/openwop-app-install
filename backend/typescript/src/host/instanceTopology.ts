/**
 * ADR 0867 D2 — whether this host can run as MORE THAN ONE process, and which
 * storage backends are SHARED across those processes.
 *
 * WHY. A storage family whose backend lives in process memory is only correct
 * while one process serves every request. MEASURED 2026-10-09 on production
 * (`dc929e5d1`, rev 00918, two instances during the cut): the kv probe's write
 * landed on one instance and tenant A's own read on the other, so the read
 * returned `[]` and `v2-storage-cross-tenant-isolation` failed. The four other
 * memory-tier families passed only because their write and read happened to
 * share an instance. Advertising such a family on a scale-out host is a claim
 * the host keeps only by luck, so `storageFamilyAdvert.ts` withholds it.
 *
 * TOPOLOGY. `OPENWOP_INSTANCE_TOPOLOGY=single|multi` wins when set. Otherwise a
 * managed scale-out platform marker (`PLATFORM_MARKERS`: Cloud Run, Kubernetes,
 * Fly, ECS, …) means `multi`, and anything else (local dev, tests, one VM) means
 * `single`. A deployment pinned to one instance sets `single` to say so.
 *
 * SHARED. `memory` is never shared. `durable` is shared when the host Storage is
 * Postgres (a `sqlite://` file is one node's disk), EXCEPT for `sql`, whose
 * durable backend is a per-tenant SQLite file on the local disk
 * (`durable/durableSql.ts`). The engine backends (`postgres`, `pgvector`, `s3`, `gcs`,
 * `opensearch`) are network stores and always shared.
 */
import { PLATFORM_MARKERS } from './oidcTrustGuard.js';
import { MEMORY_BACKEND, resolveBackendId, type SurfaceKey } from './surfaceBackends.js';

export type InstanceTopology = 'single' | 'multi';

export function readInstanceTopology(env: NodeJS.ProcessEnv = process.env): InstanceTopology {
  const explicit = (env.OPENWOP_INSTANCE_TOPOLOGY ?? '').trim().toLowerCase();
  if (explicit === 'single' || explicit === 'multi') return explicit;
  if (explicit !== '') {
    throw new Error(`OPENWOP_INSTANCE_TOPOLOGY must be 'single' or 'multi', got '${env.OPENWOP_INSTANCE_TOPOLOGY}'.`);
  }
  return PLATFORM_MARKERS.some(([key]) => Boolean(env[key])) ? 'multi' : 'single';
}

function storageIsPostgres(): boolean {
  const dsn = (process.env.OPENWOP_STORAGE_DSN ?? '').trim();
  return dsn.startsWith('postgres://') || dsn.startsWith('postgresql://');
}

/** True when every process of this host reads and writes the same store for
 *  `key`. Reads `process.env`, as `resolveBackendId` does. */
export function isBackendShared(key: SurfaceKey): boolean {
  const id = resolveBackendId(key);
  if (id === MEMORY_BACKEND) return false;
  if (id === 'durable') return key !== 'sql' && storageIsPostgres();
  return true;
}
