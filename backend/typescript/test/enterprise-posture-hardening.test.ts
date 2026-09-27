/**
 * Phase 1 production-hardening follow-ups (DUR-1/2/3/5, ADR 0195).
 *
 *  - DUR-1/5: `enterprisePostureStartupError` — the main()-only startup guard
 *    that refuses an auth-posture deploy without NODE_ENV=production and/or a
 *    durable control-plane DSN, each with its own loud escape hatch.
 *  - DUR-2: the durable RFC 0004 memory store — rows survive across store
 *    instances (restart-equivalence), CAS-atomic append, upsert-on-explicit-id
 *    (the executor's `runsummary:<runId>` idempotency).
 *  - DUR-3: `OPENWOP_DEMO_SEED_ENABLED` defaults OFF in the auth posture
 *    (opt-in), stays ON elsewhere; an explicit value always wins.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { _setDurableStorageForTesting } from '../src/host/durable/durableKv.js';
import { createDurableMemory } from '../src/host/durable/durableMemory.js';
import { enterprisePostureStartupError, enterprisePosture } from '../src/host/deployPosture.js';
import { exampleDataSeedEnabled } from '../src/host/exampleDataSeed.js';
import type { MemoryRow } from '../src/host/inMemorySurfaces.js';

const ENV_KEYS = [
  'OPENWOP_DEPLOY_POSTURE', 'OPENWOP_AUTH_ENFORCE_BEARER', 'NODE_ENV',
  'OPENWOP_ALLOW_INSECURE_AUTH_POSTURE', 'OPENWOP_ALLOW_EPHEMERAL_STORAGE',
  'OPENWOP_DEMO_SEED_ENABLED', 'OPENWOP_DEMO_MODE',
] as const;
const saved = new Map<string, string | undefined>();

beforeAll(() => { for (const k of ENV_KEYS) saved.set(k, process.env[k]); });
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('DUR-1/5 — enterprisePostureStartupError (main()-only startup guard)', () => {
  it('non-auth postures never error (demo/dev/test unaffected)', () => {
    delete process.env.OPENWOP_DEPLOY_POSTURE;
    delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    expect(enterprisePosture()).toBe(false);
    expect(enterprisePostureStartupError('memory://')).toBeNull();
    expect(enterprisePostureStartupError('sqlite://./data/x.db')).toBeNull();
  });

  it('auth + NODE_ENV!=production → fatal (DUR-5), escape hatch honored', () => {
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.NODE_ENV = 'test';
    expect(enterprisePostureStartupError('postgres://u:p@h/db')).toMatch(/NODE_ENV=production/);
    process.env.OPENWOP_ALLOW_INSECURE_AUTH_POSTURE = 'true';
    expect(enterprisePostureStartupError('postgres://u:p@h/db')).toBeNull();
  });

  it('auth + ephemeral DSN → fatal (DUR-1) for BOTH sqlite and memory; postgres passes', () => {
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.NODE_ENV = 'production';
    expect(enterprisePostureStartupError('sqlite://./data/x.db')).toMatch(/durable control-plane/);
    // memory:// is MORE ephemeral than sqlite — the allowlist must catch it too.
    expect(enterprisePostureStartupError('memory://')).toMatch(/durable control-plane/);
    expect(enterprisePostureStartupError('postgres://u:p@h/db')).toBeNull();
    expect(enterprisePostureStartupError('postgresql://u:p@h/db')).toBeNull();
  });

  it('auth + ephemeral DSN passes only with the explicit escape hatch', () => {
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.NODE_ENV = 'production';
    process.env.OPENWOP_ALLOW_EPHEMERAL_STORAGE = 'true';
    expect(enterprisePostureStartupError('sqlite://./data/x.db')).toBeNull();
  });
});

describe('DUR-3 — seed capability defaults OFF in the auth posture (opt-in)', () => {
  it('default ON outside auth; default OFF in auth; explicit value always wins', () => {
    delete process.env.OPENWOP_DEMO_SEED_ENABLED;
    delete process.env.OPENWOP_DEPLOY_POSTURE;
    delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
    expect(exampleDataSeedEnabled()).toBe(true); // demo/dev default preserved

    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    expect(exampleDataSeedEnabled()).toBe(false); // hardened default: opt-in

    process.env.OPENWOP_DEMO_SEED_ENABLED = 'true';
    expect(exampleDataSeedEnabled()).toBe(true); // explicit opt-in wins in auth

    process.env.OPENWOP_DEMO_SEED_ENABLED = 'false';
    delete process.env.OPENWOP_DEPLOY_POSTURE;
    expect(exampleDataSeedEnabled()).toBe(false); // explicit off wins anywhere
  });
});

describe('DUR-2 — durable RFC 0004 memory store', () => {
  let storage: Storage;
  const TENANT = 'dur2-tenant';
  const REF = 'agent:dur2-test';

  beforeAll(async () => {
    storage = await openStorage('memory://');
    _setDurableStorageForTesting(storage);
  });
  afterAll(async () => {
    _setDurableStorageForTesting(null);
    await storage.close();
  });

  it('rows written by one store instance are visible from a fresh instance (restart-equivalence)', async () => {
    const a = createDurableMemory({ tenantId: TENANT });
    await a.mutateRows(REF, (rows) => [...rows, { id: 'r1', content: 'hello', tags: [], createdAt: new Date().toISOString() } satisfies MemoryRow]);
    // A brand-new store instance over the same Storage sees the row — the
    // process-restart equivalence the in-memory tier cannot provide.
    const b = createDurableMemory({ tenantId: TENANT });
    const rows = await b.getRows(REF);
    expect(rows.map((r) => r.id)).toEqual(['r1']);
  });

  it('concurrent appends never lose a row (CAS append under contention)', async () => {
    const store = createDurableMemory({ tenantId: TENANT });
    const REF2 = `${REF}:contention`;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.mutateRows(REF2, (rows) => [...rows, { id: `c${i}`, content: `n${i}`, tags: [], createdAt: new Date().toISOString() } satisfies MemoryRow]),
      ),
    );
    const rows = await store.getRows(REF2);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r) => r.id)).size).toBe(20);
  });

  it('tenant isolation: a scope key never crosses tenants', async () => {
    const a = createDurableMemory({ tenantId: 'dur2-a' });
    const b = createDurableMemory({ tenantId: 'dur2-b' });
    await a.mutateRows(REF, (rows) => [...rows, { id: 'only-a', content: 'x', tags: [], createdAt: new Date().toISOString() } satisfies MemoryRow]);
    expect(await b.getRows(REF)).toHaveLength(0);
  });

  it('clearScope reports the removed count and empties the scope', async () => {
    const store = createDurableMemory({ tenantId: TENANT });
    const REF3 = `${REF}:clear`;
    await store.mutateRows(REF3, () => [
      { id: 'x1', content: 'a', tags: [], createdAt: new Date().toISOString() },
      { id: 'x2', content: 'b', tags: [], createdAt: new Date().toISOString() },
    ]);
    expect(await store.clearScope(REF3)).toBe(2);
    expect(await store.getRows(REF3)).toHaveLength(0);
  });
});

describe('LEAK-10 — ctx.knowledge demo corpus is demo-gated (regression guard)', () => {
  it('outside demo mode a tenant with no knowledge gets an honest EMPTY result, never the demo corpus', async () => {
    delete process.env.OPENWOP_DEMO_MODE; // clean/enterprise install
    const { initInMemorySurfaces, buildHostSurfaceBundle } = await import('../src/host/inMemorySurfaces.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-leak10-')) });
    const knowledge = buildHostSurfaceBundle({ tenantId: 'leak10-clean-tenant' }).knowledge;
    // 'security' is a strong hit in the seeded demo corpus — with demo mode off
    // it must NOT surface fabricated chunks the tenant never ingested.
    const res = await knowledge.retrieve({ query: 'security credentials handling' }) as { hasResults: boolean; chunks: unknown[] };
    expect(res.hasResults).toBe(false);
    expect(res.chunks).toHaveLength(0);
  });

  it('in demo mode the seeded corpus still serves (showcase preserved)', async () => {
    process.env.OPENWOP_DEMO_MODE = 'true';
    const { initInMemorySurfaces, buildHostSurfaceBundle } = await import('../src/host/inMemorySurfaces.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-leak10b-')) });
    const knowledge = buildHostSurfaceBundle({ tenantId: 'leak10-demo-tenant' }).knowledge;
    const res = await knowledge.retrieve({ query: 'security credentials handling' }) as { hasResults: boolean };
    expect(res.hasResults).toBe(true);
    delete process.env.OPENWOP_DEMO_MODE;
  });
});

describe('DUR-2 — writeMemoryEntry upsert-on-explicit-id (via the module API, in-memory tier)', () => {
  it('re-writing the same explicit id replaces the row instead of duplicating (runsummary idempotency)', async () => {
    const { initInMemorySurfaces, writeMemoryEntry, listMemoryEntries } = await import('../src/host/inMemorySurfaces.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-dur2-')) });
    const T = 'dur2-upsert';
    await writeMemoryEntry(T, 'tenant-memory', { id: 'runsummary:run-1', content: 'first attempt', tags: ['run-summary'] });
    await writeMemoryEntry(T, 'tenant-memory', { id: 'runsummary:run-1', content: 'retry attempt', tags: ['run-summary'] });
    const rows = await listMemoryEntries(T, 'tenant-memory');
    const matches = rows.filter((r) => r.id === 'runsummary:run-1');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.content).toBe('retry attempt');
  });
});
