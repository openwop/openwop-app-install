/**
 * ADR 0858 P3 (storage slice) — the seven host-storage families are built by one
 * builder with each facet true on the SELECTED backend. `queueBus` is advertised
 * at v2, plus the six the storage probe implements while it is registered
 * (blobStorage joined once its surface gained list + delete), and every record
 * is validated here as a v2 record.
 *
 * The v1 records stated `sql.drivers: ['sqlite']`, `vectorStore.backends` and
 * `queueBus.backends: ['in-memory']` as literals, which were false on production
 * (`OPENWOP_SURFACE_BACKEND=durable`), and limits no adapter enforced. This pins:
 *   - the backend facets follow `resolveBackendId()` for every selectable backend,
 *     and are OMITTED where the backend has no v2 enum value;
 *   - the dropped limits stay dropped;
 *   - every backend's document validates against the vendored v2 schema;
 *   - a new registered adapter for one of these surfaces reds until it is mapped.
 *
 * Tracker TST-BFA-9. Red when: the memory presign facet ignores the test seam; durable sql is
 * named postgres or durable queueBus gains a backend name; pgvector maps to
 * another enum; the probed families stop reaching the document; a dropped limit
 * comes back.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createApp } from '../src/index.js';
import type { AppConfig } from '../src/index.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { registeredBackendIds } from '../src/host/surfaceBackends.js';
import { STORAGE_FAMILIES, v2AdvertisedStorageFamilies, storageFamilyFacets } from '../src/host/storageFamilyAdvert.js';

type Rec = Record<string, unknown>;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const V2 = join(ROOT, 'schemas', 'v2');
const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };

const ENV_KEYS = [
  'OPENWOP_SURFACE_BACKEND', 'OPENWOP_SURFACE_SQL', 'OPENWOP_SURFACE_VECTOR', 'OPENWOP_SURFACE_QUEUEBUS',
  'OPENWOP_SURFACE_BLOB', 'OPENWOP_SURFACE_KV', 'OPENWOP_SURFACE_TABLE', 'OPENWOP_SURFACE_CACHE',
  'OPENWOP_TEST_SEAM_ENABLED',
] as const;
const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const restore = (): void => {
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
/**
 * The v2 document under `env`, with the WITHHELD storage families added as the
 * records projection would emit (same envelope as the advertised `queueBus`), so
 * the schema validates every family's facets on every backend.
 */
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): Rec {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const doc = buildV2Advertisement(CONFIG);
  const { status, since, until, witness } = doc['queueBus'] as Rec;
  const facets = storageFamilyFacets();
  for (const f of STORAGE_FAMILIES) {
    if (!(f in doc)) doc[f] = { status, since, until, witness, ...facets[f] };
  }
  return doc;
}

function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const f of readdirSync(V2)) {
    if (!f.endsWith('.json')) continue;
    try { ajv.addSchema(JSON.parse(readFileSync(join(V2, f), 'utf8')) as Rec, f); } catch { /* sibling's own test */ }
  }
  const root = JSON.parse(readFileSync(join(V2, 'capabilities.schema.json'), 'utf8')) as { $id?: string };
  const fn = (root.$id ? ajv.getSchema(root.$id) : undefined) ?? ajv.getSchema('capabilities.schema.json');
  if (!fn) throw new Error('capabilities.schema.json did not register');
  return fn;
}
const validate = validator();
const expectValid = (doc: Rec, label: string): void => {
  const ok = validate(doc);
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);
  expect(errors, `${label}: ${errors.join('\n')}`).toEqual([]);
  expect(ok).toBe(true);
};
const rec = (doc: Rec, family: string): Rec => doc[family] as Rec;

/** Facets v1 copied that no backend enforces (storage.md §Size limits makes each a MUST-refuse). */
const DROPPED: Readonly<Record<string, readonly string[]>> = {
  kvStorage: ['maxKeyBytes', 'maxValueBytes', 'maxTtlSeconds'],
  tableStorage: ['maxRowsPerTable', 'maxColumnsPerRow'],
  blobStorage: ['maxObjectBytes'],
  cache: ['maxValueBytes', 'maxTtlSeconds'],
  queueBus: ['stream'],
};

beforeAll(async () => {
  restore();
  await createApp(CONFIG); // registers every real adapter, so the coverage leg reads the real set
}, 120_000);
afterEach(restore);

describe('ADR 0858 P3 — storage families: backend facets are derived per selected backend', () => {
  it('memory (the default): sqlite / in-memory / in-memory; presign only with the resolver route mounted', () => {
    const doc = withEnv({});
    expectValid(doc, 'memory');
    expect(rec(doc, 'sql')['drivers']).toEqual(['sqlite']);
    expect(rec(doc, 'vectorStore')['backends']).toEqual(['in-memory']);
    expect(rec(doc, 'queueBus')['backends']).toEqual(['in-memory']);
    expect(rec(doc, 'blobStorage')['presignSupported']).toBe(false);
    const seams = withEnv({ OPENWOP_TEST_SEAM_ENABLED: 'true' });
    expectValid(seams, 'memory+seams');
    expect(rec(seams, 'blobStorage')['presignSupported']).toBe(true);
  });

  it('durable (production): sql is a sqlite FILE; vector and queueBus have no enum value, so the facet is omitted', () => {
    const doc = withEnv({ OPENWOP_SURFACE_BACKEND: 'durable', OPENWOP_SURFACE_BLOB: 's3' });
    expectValid(doc, 'durable');
    expect(rec(doc, 'sql')['drivers']).toEqual(['sqlite']);
    expect(rec(doc, 'vectorStore')).not.toHaveProperty('backends');
    expect(rec(doc, 'queueBus')).not.toHaveProperty('backends');
    expect(rec(doc, 'blobStorage')['presignSupported']).toBe(true);
    // queueBus is still advertised: the family is honoured, only the backend name has no seat.
    expect(rec(doc, 'queueBus')['deadLetterSupported']).toBe(true);
  });

  it('only the listed families reach the real v2 document: queueBus, plus the probed six while the storage probe resolves', () => {
    // createApp registered the conformance nodes (test posture), so the probe resolves.
    expect([...v2AdvertisedStorageFamilies()]).toEqual(['queueBus', 'kvStorage', 'cache', 'tableStorage', 'vectorStore', 'sql', 'blobStorage']);
    for (const env of [{}, { OPENWOP_SURFACE_BACKEND: 'durable' }]) {
      withEnv(env);
      const real = buildV2Advertisement(CONFIG);
      for (const f of STORAGE_FAMILIES) {
        expect(f in real, `${f} under ${JSON.stringify(env)}`).toBe(v2AdvertisedStorageFamilies().includes(f));
      }
    }
  });

  it('without the storage probe (conformance nodes off) only queueBus is advertised: a probed family without its fixture blocks certification', () => {
    expect([...v2AdvertisedStorageFamilies(false)]).toEqual(['queueBus']);
  });

  it('the scale engines: postgres / pgvector / s3', () => {
    const doc = withEnv({ OPENWOP_SURFACE_SQL: 'postgres', OPENWOP_SURFACE_VECTOR: 'pgvector', OPENWOP_SURFACE_BLOB: 's3' });
    expectValid(doc, 'engines');
    expect(rec(doc, 'sql')['drivers']).toEqual(['postgres']);
    expect(rec(doc, 'vectorStore')['backends']).toEqual(['pgvector']);
    expect(rec(doc, 'blobStorage')['presignSupported']).toBe(true);
  });

  it('the honoured facets hold on every backend, and the unenforced limits are dropped', () => {
    for (const env of [{}, { OPENWOP_SURFACE_BACKEND: 'durable' }]) {
      const v2 = withEnv(env);
      expect(rec(v2, 'kvStorage')).toMatchObject({ atomicIncrement: true, compareAndSwap: true });
      expect(rec(v2, 'tableStorage')).toMatchObject({ indexable: false, fullTextSearch: false });
      expect(rec(v2, 'queueBus')['deadLetterSupported']).toBe(true);
      expect(rec(v2, 'sql')['transactions']).toBe(true);
      for (const [family, facets] of Object.entries(DROPPED)) {
        for (const facet of facets) {
          expect(rec(v2, family), `v2 ${family}.${facet}`).not.toHaveProperty(facet);
        }
      }
      // ADR 0812 P4: the v1-vs-v2 "one builder" leg went with the v1 builder.
    }
  });

  it('gcs blob (ADR 0867): presignSupported is true and the document validates', () => {
    const doc = withEnv({ OPENWOP_SURFACE_BACKEND: 'durable', OPENWOP_SURFACE_BLOB: 'gcs' });
    expectValid(doc, 'durable+gcs');
    expect(rec(doc, 'blobStorage')['presignSupported']).toBe(true);
  });

  it('every registered backend for these surfaces is mapped — a new adapter reds until it is dispositioned', () => {
    // MEASURED 2026-10-07 (`grep registerSurfaceAdapter`). Adding an id here is the
    // decision: give it a v2 enum value in storageFamilyAdvert.ts, or confirm omission.
    expect(registeredBackendIds('sql')).toEqual(['durable', 'postgres']);
    expect(registeredBackendIds('vector')).toEqual(['durable', 'pgvector']);
    expect(registeredBackendIds('queueBus')).toEqual(['durable']);
    // ADR 0867 2b: `gcs` (keyless) — dispositioned as presignSupported:true (it signs
    // a real V4 URL via signBlob), pinned in the leg below.
    expect(registeredBackendIds('blob')).toEqual(['gcs', 's3']);
    expect(registeredBackendIds('kv')).toEqual(['durable']);
    expect(registeredBackendIds('table')).toEqual(['durable']);
    expect(registeredBackendIds('cache')).toEqual(['durable']);
  });
});
