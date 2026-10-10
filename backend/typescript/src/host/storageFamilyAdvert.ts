/**
 * ADR 0858 P3 (storage slice) — the facets of the seven host-storage families,
 * `kvStorage`, `tableStorage`, `queueBus`, `sql`, `vectorStore`, `blobStorage`
 * and `cache`. ONE builder for both majors' records (the `artifactTypesAdvert`
 * precedent), so v1 and v2 cannot drift.
 *
 * The rule each facet passes: it is TRUE on every backend this host can select
 * for that surface (`surfaceBackends.ts`: `memory` plus every
 * `registerSurfaceAdapter` id), or it is DERIVED per request from
 * `resolveBackendId()`. A backend with no value in the v2 schema enum OMITS the
 * facet; it is never rounded to the nearest one.
 *
 * DROPPED, because no backend enforces them (MEASURED 2026-10-07 across
 * `inMemorySurfaces.ts`, `durable/*`, `sql/pgSql.ts`, `vector/pgVectorVector.ts`,
 * `blob/s3Blob.ts`, and the `core.openwop.storage` pack schemas):
 * `kvStorage.maxKeyBytes` / `maxValueBytes` / `maxTtlSeconds`,
 * `tableStorage.maxRowsPerTable` / `maxColumnsPerRow`, `blobStorage.maxObjectBytes`,
 * and `cache.maxValueBytes` / `maxTtlSeconds`. `storage.md` §Size limits makes
 * each a MUST-refuse, so advertising one is a false claim. (s3's
 * `OPENWOP_BLOB_S3_MAX_GET_BYTES` is a READ cap, not an object-size limit.)
 * `queueBus.stream` is also omitted: `streamSubscribe` without `fromBeginning`
 * returns an empty snapshot on both backends, with no live delivery.
 */
import { resolveBackendId, MEMORY_BACKEND, type SurfaceKey } from './surfaceBackends.js';
import { isBackendShared, readInstanceTopology } from './instanceTopology.js';
import { S3_BACKEND_ID } from './blob/s3Blob.js';
import { GCS_BACKEND_ID } from './blob/gcsBlob.js';
import { DURABLE_BACKEND_ID } from './durable/durableKv.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { CONFORMANCE_STORAGE_PROBE_TYPE_ID, PROBED_STORAGE_FAMILIES } from '../bootstrap/conformanceStorageProbe.js';

type Facets = Record<string, unknown>;

export const STORAGE_FAMILIES = [
  'kvStorage', 'tableStorage', 'queueBus', 'sql', 'vectorStore', 'blobStorage', 'cache',
] as const;
export type StorageFamily = (typeof STORAGE_FAMILIES)[number];

/**
 * The storage families the v2 document ADVERTISES.
 *
 * `queueBus` always: its scenario records `inapplicable` without its probe pair.
 *
 * The probed families (`PROBED_STORAGE_FAMILIES`: kvStorage, cache,
 * tableStorage, vectorStore, sql, blobStorage) ONLY while `core.conformance.storage-probe`
 * resolves, which is exactly when the `conformance-storage-probe` fixture is
 * advertised (`listLoadedConformanceFixtures` derives that from the same
 * registry). Advertising a family without the fixture makes
 * `v2-storage-cross-tenant-isolation` record its leg `blocked`, and a bundle with
 * a blocked row does not certify (RFC 0168 §E.1). MEASURED 2026-10-07,
 * `--certify` at major 2: six blocked rows before the probe existed. The fixture
 * contract also forbids advertising the fixture unless the probe implements every
 * advertised storage family, so the two lists are tied here rather than in prose.
 *
 * `blobStorage` joined the probed list once its surface gained `list` and
 * `delete` (ADR 0858 P3 blob); before that it was withheld for want of them.
 *
 * ADR 0867 D2 — on a multi-process host a family whose backend is process-local
 * is withheld too (`processLocalStorageFamilies`).
 */
export function v2AdvertisedStorageFamilies(
  probeResolvable: boolean = getNodeRegistry().isResolvable(CONFORMANCE_STORAGE_PROBE_TYPE_ID),
): readonly StorageFamily[] {
  const families: readonly StorageFamily[] = probeResolvable
    ? ['queueBus', ...PROBED_STORAGE_FAMILIES]
    : ['queueBus'];
  const local = new Set(processLocalStorageFamilies());
  return families.filter((f) => !local.has(f));
}

/** The host surface behind each storage family (`surfaceBackends.ts` keys). */
export const STORAGE_FAMILY_SURFACE: Readonly<Record<StorageFamily, SurfaceKey>> = {
  kvStorage: 'kv',
  tableStorage: 'table',
  queueBus: 'queueBus',
  sql: 'sql',
  vectorStore: 'vector',
  blobStorage: 'blob',
  cache: 'cache',
};

/**
 * ADR 0867 D2 — the storage families this host must NOT advertise because it can
 * run as several processes (`readInstanceTopology() === 'multi'`) while the
 * family's backend is not shared across them (`isBackendShared`). Empty on a
 * single-process host, where a process-local backend is still consistent.
 *
 * Withholding is the honest answer, not a fix: the fix is selecting a shared
 * backend (`OPENWOP_SURFACE_BACKEND=durable` on Postgres Storage,
 * `OPENWOP_SURFACE_SQL=postgres`, `OPENWOP_SURFACE_VECTOR=pgvector`,
 * `OPENWOP_SURFACE_BLOB=gcs` or `s3`). `main()` logs the withheld list at boot with
 * those lines.
 */
export function processLocalStorageFamilies(): StorageFamily[] {
  if (readInstanceTopology() !== 'multi') return [];
  return STORAGE_FAMILIES.filter((f) => !isBackendShared(STORAGE_FAMILY_SURFACE[f]));
}

/** `sql.drivers` — the engine behind each selectable `sql` backend. */
const SQL_DRIVER: Readonly<Record<string, string>> = {
  [MEMORY_BACKEND]: 'sqlite', // better-sqlite3 `:memory:`, one DB per tenant (inMemorySurfaces.ts createSql)
  [DURABLE_BACKEND_ID]: 'sqlite', // better-sqlite3 per-tenant FILE (durable/durableSql.ts)
  postgres: 'postgres', // pg, schema-per-tenant (sql/pgSql.ts)
};

/** `vectorStore.backends`. `durable` has no enum value: brute-force cosine over
 *  the shared `Storage` kv rows (durable/durableData.ts) — not in-memory, not pgvector. */
const VECTOR_BACKEND: Readonly<Record<string, string>> = {
  [MEMORY_BACKEND]: 'in-memory',
  pgvector: 'pgvector', // vector/pgVectorVector.ts
};

/** `queueBus.backends`. `durable` has no enum value: a FIFO over the shared
 *  `Storage` kv rows (durable/durableQueue.ts). */
const QUEUE_BUS_BACKEND: Readonly<Record<string, string>> = {
  [MEMORY_BACKEND]: 'in-memory',
};

const listed = (table: Readonly<Record<string, string>>, backendId: string): string[] | undefined => {
  const v = table[backendId];
  return v === undefined ? undefined : [v];
};

/**
 * `blobStorage.presignSupported` — whether a presigned URL this host issues
 * actually resolves. `s3` signs a real SigV4 URL the client uses against the
 * bucket. The `memory` tier issues a host token whose resolver route
 * (`/host/openwop-app/blob/presigned/:token`) is mounted ONLY by
 * `registerTestSeamRoutes`, so without the test seam the URL 404s and the
 * facet is false.
 */
function blobPresignSupported(backendId: string): boolean {
  if (backendId === S3_BACKEND_ID || backendId === GCS_BACKEND_ID) return true; // both sign a real URL against the bucket
  if (backendId === MEMORY_BACKEND) return process.env.OPENWOP_TEST_SEAM_ENABLED === 'true';
  return false;
}

/** The facets of each storage family, without the record envelope or `supported`. */
export function storageFamilyFacets(): Record<StorageFamily, Facets> {
  const sqlDrivers = listed(SQL_DRIVER, resolveBackendId('sql'));
  const vectorBackends = listed(VECTOR_BACKEND, resolveBackendId('vector'));
  const busBackends = listed(QUEUE_BUS_BACKEND, resolveBackendId('queueBus'));
  return {
    // memory: synchronous read-modify-write with no await between (one event-loop
    // turn); durable: `Storage.kvCompareAndSwap`, atomic across instances.
    kvStorage: { atomicIncrement: true, compareAndSwap: true },
    // Both backends query by an O(n) prefix scan with exact-match filters.
    tableStorage: { indexable: false, fullTextSearch: false },
    // Both backends route `deadLetter` to `<subject>.dlq`.
    queueBus: { ...(busBackends ? { backends: busBackends } : {}), deadLetterSupported: true },
    // All three backends roll the whole batch back on a failing statement
    // (better-sqlite3 `db.transaction`; pg BEGIN/ROLLBACK).
    sql: { transactions: true, ...(sqlDrivers ? { drivers: sqlDrivers } : {}) },
    vectorStore: vectorBackends ? { backends: vectorBackends } : {},
    blobStorage: { presignSupported: blobPresignSupported(resolveBackendId('blob')) },
    cache: {},
  };
}
