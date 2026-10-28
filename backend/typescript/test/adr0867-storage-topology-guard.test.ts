/**
 * ADR 0867 D2 — a scale-out host never advertises a storage family whose backend
 * lives in one process.
 *
 * MEASURED 2026-10-09: production `dc929e5d1` (rev 00918) ran two instances during
 * its major-2 cut; kv was on the memory tier, the probe's write landed on one
 * instance and tenant A's own read on the other, and
 * `v2-storage-cross-tenant-isolation` failed. The other memory-tier families
 * passed by placement luck. This pins:
 *   - the topology: explicit `OPENWOP_INSTANCE_TOPOLOGY` wins, a platform marker
 *     means `multi`, nothing means `single`, and a typo refuses;
 *   - which backends are shared: memory never; durable only on Postgres Storage
 *     and never for sql (a per-node SQLite file); the engines always;
 *   - the v2 document: on `multi`, every process-local family is withheld from
 *     `buildV2Advertisement`, and a shared one is kept; on `single`, nothing is.
 *
 * Tracker TST-BFB-5. Red when: a platform marker stops meaning multi; the explicit value is
 * case-sensitive; a typo is accepted; durable sql counts as shared; a sqlite
 * Storage counts as shared; process-local families are not withheld on multi.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { AppConfig } from '../src/index.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { isBackendShared, readInstanceTopology } from '../src/host/instanceTopology.js';
import { STORAGE_FAMILIES, processLocalStorageFamilies, v2AdvertisedStorageFamilies } from '../src/host/storageFamilyAdvert.js';

const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };
const PG = 'postgresql://u:p@/db?host=/cloudsql/x';

const ENV_KEYS = [
  'OPENWOP_INSTANCE_TOPOLOGY', 'K_SERVICE', 'KUBERNETES_SERVICE_HOST', 'OPENWOP_STORAGE_DSN',
  'OPENWOP_SURFACE_BACKEND', 'OPENWOP_SURFACE_SQL', 'OPENWOP_SURFACE_VECTOR', 'OPENWOP_SURFACE_QUEUEBUS',
  'OPENWOP_SURFACE_BLOB', 'OPENWOP_SURFACE_KV', 'OPENWOP_SURFACE_TABLE', 'OPENWOP_SURFACE_CACHE',
] as const;
type Key = (typeof ENV_KEYS)[number];
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const restore = (): void => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
function setEnv(env: Partial<Record<Key, string>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}
const advertised = (): string[] => {
  const doc = buildV2Advertisement(CONFIG);
  return STORAGE_FAMILIES.filter((f) => f in doc);
};

beforeAll(async () => {
  restore();
  await createApp(CONFIG); // registers the storage probe, so every probed family is eligible
}, 120_000);
afterEach(restore);

describe('ADR 0867 D2 — instance topology', () => {
  it('explicit OPENWOP_INSTANCE_TOPOLOGY wins over a platform marker', () => {
    expect(readInstanceTopology({ OPENWOP_INSTANCE_TOPOLOGY: 'single', K_SERVICE: 'svc' })).toBe('single');
    expect(readInstanceTopology({ OPENWOP_INSTANCE_TOPOLOGY: 'MULTI' })).toBe('multi');
  });
  it('a managed scale-out platform marker means multi; none means single', () => {
    expect(readInstanceTopology({ K_SERVICE: 'openwop-app-backend' })).toBe('multi');
    expect(readInstanceTopology({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })).toBe('multi');
    expect(readInstanceTopology({})).toBe('single');
  });
  it('an unrecognised value refuses rather than guessing', () => {
    expect(() => readInstanceTopology({ OPENWOP_INSTANCE_TOPOLOGY: 'many' })).toThrow(/single' or 'multi/);
  });
});

describe('ADR 0867 D2 — which backends are shared across instances', () => {
  it('memory is never shared', () => {
    setEnv({ OPENWOP_STORAGE_DSN: PG });
    expect(isBackendShared('kv')).toBe(false);
  });
  it('durable is shared on Postgres Storage, not on a sqlite file', () => {
    setEnv({ OPENWOP_SURFACE_BACKEND: 'durable', OPENWOP_STORAGE_DSN: PG });
    expect(isBackendShared('kv')).toBe(true);
    expect(isBackendShared('vector')).toBe(true);
    setEnv({ OPENWOP_SURFACE_BACKEND: 'durable', OPENWOP_STORAGE_DSN: 'sqlite://./data/x.db' });
    expect(isBackendShared('kv')).toBe(false);
  });
  it('durable sql is a per-node SQLite file, so never shared; postgres sql is', () => {
    setEnv({ OPENWOP_SURFACE_BACKEND: 'durable', OPENWOP_STORAGE_DSN: PG });
    expect(isBackendShared('sql')).toBe(false);
    setEnv({ OPENWOP_SURFACE_SQL: 'postgres' });
    expect(isBackendShared('sql')).toBe(true);
  });
  it('the network engines are always shared', () => {
    setEnv({ OPENWOP_SURFACE_VECTOR: 'pgvector', OPENWOP_SURFACE_BLOB: 's3' });
    expect(isBackendShared('vector')).toBe(true);
    expect(isBackendShared('blob')).toBe(true);
  });
});

describe('ADR 0867 D2 — the v2 document withholds process-local families on a multi-instance host', () => {
  it('single instance (no marker): the memory tier advertises every family, as before', () => {
    setEnv({});
    expect(processLocalStorageFamilies()).toEqual([]);
    expect(advertised().sort()).toEqual([...v2AdvertisedStorageFamilies(true)].sort());
    expect(advertised()).toHaveLength(STORAGE_FAMILIES.length);
  });
  it('multi instance on the memory tier (the dc929e5d1 shape): every storage family is withheld', () => {
    setEnv({ K_SERVICE: 'openwop-app-backend', OPENWOP_STORAGE_DSN: PG });
    expect(advertised()).toEqual([]);
  });
  it('production before ADR 0867 (only kv durable): kv stays, the other six are withheld', () => {
    setEnv({ K_SERVICE: 'openwop-app-backend', OPENWOP_STORAGE_DSN: PG, OPENWOP_SURFACE_KV: 'durable' });
    expect(advertised()).toEqual(['kvStorage']);
  });
  it('the ADR 0867 phase 1 config: durable + postgres sql keeps all but memory blob', () => {
    setEnv({
      K_SERVICE: 'openwop-app-backend', OPENWOP_STORAGE_DSN: PG,
      OPENWOP_SURFACE_BACKEND: 'durable', OPENWOP_SURFACE_SQL: 'postgres', OPENWOP_SURFACE_BLOB: 'memory',
    });
    expect(processLocalStorageFamilies()).toEqual(['blobStorage']);
    expect(advertised().sort()).toEqual(STORAGE_FAMILIES.filter((f) => f !== 'blobStorage').sort());
  });
  it('the ADR 0867 phase 2 config (pgvector + s3) advertises every family', () => {
    setEnv({
      K_SERVICE: 'openwop-app-backend', OPENWOP_STORAGE_DSN: PG, OPENWOP_SURFACE_BACKEND: 'durable',
      OPENWOP_SURFACE_SQL: 'postgres', OPENWOP_SURFACE_VECTOR: 'pgvector', OPENWOP_SURFACE_BLOB: 's3',
    });
    expect(advertised()).toHaveLength(STORAGE_FAMILIES.length);
  });
  it('an operator pinned to one instance says so and keeps the memory tier advertised', () => {
    setEnv({ K_SERVICE: 'openwop-app-backend', OPENWOP_INSTANCE_TOPOLOGY: 'single' });
    expect(advertised()).toHaveLength(STORAGE_FAMILIES.length);
  });
});
