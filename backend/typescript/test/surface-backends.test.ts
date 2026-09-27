import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveBackendId,
  resolveSurface,
  registerSurfaceAdapter,
  hasAdapter,
  assertSelectedBackendsAvailable,
  assertDurableSurfacesInEnterprise,
  readInMemoryAllowance,
  registeredBackendIds,
  isUnbackable,
  effectiveImplementation,
  _resetSurfaceAdaptersForTesting,
  MEMORY_BACKEND,
  type SurfaceKey,
} from '../src/host/surfaceBackends.js';
import { initDurableSurfaces } from '../src/host/durable/durableKv.js';
import { registerS3BlobAdapter } from '../src/host/blob/s3Blob.js';
import { registerOpenSearchAdapter } from '../src/host/search/openSearchSearch.js';
import { registerPgVectorAdapter } from '../src/host/vector/pgVectorVector.js';
import { registerPgSqlAdapter } from '../src/host/sql/pgSql.js';
import type { Storage } from '../src/storage/index.js';

const SCOPE = { tenantId: 't1' } as const;

/** Mirrors DURABILITY_REQUIRED_SURFACES in inMemorySurfaces.ts — the list the
 *  boot passes to both guards. Kept in sync by the "every key" test below. */
const ALL_KEYS: readonly SurfaceKey[] = [
  'kv', 'table', 'cache', 'blob', 'queue',
  'sql', 'vector', 'search', 'nosql',
  'fs', 'queueBus', 'observability', 'memory',
];

/** Register exactly what `index.ts` registers at boot, in its order, with no
 *  backend selected (so the registrars' own env checks stay quiet). */
function wireLikeBoot(): void {
  initDurableSurfaces({} as unknown as Storage);
  registerS3BlobAdapter();
  registerOpenSearchAdapter();
  registerPgVectorAdapter();
  registerPgSqlAdapter();
}

function clearSurfaceEnv(): void {
  for (const key of ALL_KEYS) delete process.env[`OPENWOP_SURFACE_${key.toUpperCase()}`];
  delete process.env.OPENWOP_SURFACE_BACKEND;
  delete process.env.OPENWOP_DEPLOY_POSTURE;
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  delete process.env.OPENWOP_ALLOW_INMEMORY_SURFACES;
}

describe('host-surface backend seam', () => {
  afterEach(() => {
    _resetSurfaceAdaptersForTesting();
    clearSurfaceEnv();
  });

  it('defaults every surface to the in-memory backend', () => {
    expect(resolveBackendId('kv')).toBe(MEMORY_BACKEND);
    expect(resolveBackendId('blob')).toBe(MEMORY_BACKEND);
  });

  it('per-surface override beats the global default beats memory', () => {
    process.env.OPENWOP_SURFACE_BACKEND = 'postgres';
    expect(resolveBackendId('kv')).toBe('postgres');
    process.env.OPENWOP_SURFACE_KV = 'redis';
    expect(resolveBackendId('kv')).toBe('redis'); // per-surface wins
    expect(resolveBackendId('blob')).toBe('postgres'); // global still applies
  });

  it('resolveSurface uses the memory factory when no override is set', () => {
    const built = resolveSurface('kv', () => ({ marker: 'memory-impl' }), SCOPE);
    expect(built).toEqual({ marker: 'memory-impl' });
  });

  it('resolveSurface throws when a real backend is selected but unwired', () => {
    process.env.OPENWOP_SURFACE_KV = 'redis';
    expect(() => resolveSurface('kv', () => ({ marker: 'memory-impl' }), SCOPE)).toThrow(
      /No 'redis' adapter registered for host surface 'kv'/,
    );
  });

  it('a registered adapter is used instead of the memory factory', () => {
    process.env.OPENWOP_SURFACE_KV = 'redis';
    registerSurfaceAdapter('kv', 'redis', () => ({ marker: 'redis-impl' }));
    expect(hasAdapter('kv', 'redis')).toBe(true);
    const built = resolveSurface('kv', () => ({ marker: 'memory-impl' }), SCOPE);
    expect(built).toEqual({ marker: 'redis-impl' });
  });

  it('cannot register an adapter under the reserved memory id', () => {
    expect(() => registerSurfaceAdapter('kv', MEMORY_BACKEND, () => ({}))).toThrow(/reserved/);
  });

  it('assertSelectedBackendsAvailable fails fast for an unwired selection', () => {
    process.env.OPENWOP_SURFACE_KV = 'redis';
    expect(() => assertSelectedBackendsAvailable(['kv', 'blob'])).toThrow(/not wired/);
    registerSurfaceAdapter('kv', 'redis', () => ({}));
    expect(() => assertSelectedBackendsAvailable(['kv', 'blob'])).not.toThrow();
  });

  it('effectiveImplementation reports the demo tag for memory, the id otherwise', () => {
    expect(effectiveImplementation('vector', 'brute-force-cosine')).toBe('brute-force-cosine');
    process.env.OPENWOP_SURFACE_VECTOR = 'pgvector';
    expect(effectiveImplementation('vector', 'brute-force-cosine')).toBe('pgvector');
  });
});

// ADR 0636 — the durability guard asserts only what an operator can satisfy.
// The premise the whole decision rests on is pinned FIRST, against the real
// registrars, so a future adapter (or a removed one) re-opens the question here
// instead of on an adopter's failed deploy.
describe('ADR 0636 — durability guard vs the adapters that actually exist', () => {
  afterEach(() => {
    _resetSurfaceAdaptersForTesting();
    clearSurfaceEnv();
  });

  it('PREMISE: with the boot registrars loaded, observability is unbackable and blob has only s3', () => {
    wireLikeBoot();
    expect(registeredBackendIds('observability')).toEqual([]);
    expect(isUnbackable('observability')).toBe(true);
    expect(registeredBackendIds('blob')).toEqual(['s3']);
    expect(isUnbackable('blob')).toBe(false);
    for (const key of ALL_KEYS) {
      if (key === 'observability' || key === 'blob') continue;
      expect(registeredBackendIds(key), key).toContain('durable');
    }
  });

  it('SABOTAGE (wiring guard): OPENWOP_SURFACE_BACKEND=durable alone is refused, and the message hands over the exact opt-out lines', () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.OPENWOP_SURFACE_BACKEND = 'durable';
    let message = '';
    try {
      assertSelectedBackendsAvailable(ALL_KEYS);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/not wired/);
    // Names exactly the two surfaces with no 'durable' adapter, and why.
    expect(message).toMatch(/blob → 'durable' \(via OPENWOP_SURFACE_BACKEND; registered adapters: s3\)/);
    expect(message).toMatch(/observability → 'durable' \(via OPENWOP_SURFACE_BACKEND; registered adapters: none\)/);
    expect(message).not.toMatch(/\bkv →/);
    // The fix is spelled out, not left to a grep of registerSurfaceAdapter().
    expect(message).toContain('OPENWOP_SURFACE_BLOB=memory OPENWOP_SURFACE_OBSERVABILITY=memory');
    // Only the BACKABLE surface needs the auth-posture acknowledgement.
    expect(message).toContain('OPENWOP_ALLOW_INMEMORY_SURFACES=blob');
    expect(message).not.toMatch(/OPENWOP_ALLOW_INMEMORY_SURFACES=[a-z,]*observability/);
  });

  it('wiring guard: a per-surface miss is attributed to its own variable and gets no opt-out hint', () => {
    wireLikeBoot();
    process.env.OPENWOP_SURFACE_KV = 'redis';
    let message = '';
    try {
      assertSelectedBackendsAvailable(ALL_KEYS);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/kv → 'redis' \(OPENWOP_SURFACE_KV; registered adapters: durable\)/);
    expect(message).not.toContain('=memory');
    expect(message).toContain("unset the OPENWOP_SURFACE_* override");
  });

  it('SABOTAGE (durability guard): auth posture on all-memory is refused, names the backable surfaces only, and hands over the acknowledgement', () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    let message = '';
    try {
      assertDurableSurfacesInEnterprise(ALL_KEYS);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/requires durable host surfaces, but 12 resolve to the ephemeral in-memory tier/);
    expect(message).toContain('OPENWOP_SURFACE_BLOB=<s3>');
    expect(message).toContain('OPENWOP_SURFACE_KV=<durable>');
    expect(message).toContain('Not counted — no durable adapter exists, nothing to select: observability');
    // The acknowledgement it proposes is the exact violating set, never 'true'.
    const ack = /OPENWOP_ALLOW_INMEMORY_SURFACES=([a-zA-Z,]+)/.exec(message)?.[1] ?? '';
    expect(ack.split(',').sort()).toEqual(
      ALL_KEYS.filter((k) => k !== 'observability').slice().sort(),
    );
  });

  it('the contradiction is gone: the only auth config that used to boot still boots, with a NAMED acknowledgement instead of true', () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.OPENWOP_SURFACE_BACKEND = 'durable';
    process.env.OPENWOP_SURFACE_BLOB = 'memory';
    process.env.OPENWOP_SURFACE_OBSERVABILITY = 'memory';
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = 'blob';
    expect(() => assertSelectedBackendsAvailable(ALL_KEYS)).not.toThrow();
    expect(() => assertDurableSurfacesInEnterprise(ALL_KEYS)).not.toThrow();
  });

  it('a fully durable auth deploy needs NO acknowledgement (blob on s3, observability opted out)', () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.OPENWOP_SURFACE_BACKEND = 'durable';
    process.env.OPENWOP_SURFACE_BLOB = 's3';
    process.env.OPENWOP_SURFACE_OBSERVABILITY = 'memory';
    expect(() => assertSelectedBackendsAvailable(ALL_KEYS)).not.toThrow();
    expect(() => assertDurableSurfacesInEnterprise(ALL_KEYS)).not.toThrow();
  });

  it('the acknowledgement excuses ONLY the surfaces it names', () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = 'blob';
    let message = '';
    try {
      assertDurableSurfacesInEnterprise(ALL_KEYS);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/but 11 resolve to the ephemeral in-memory tier/);
    expect(message).toContain('Already acknowledged: blob');
    expect(message).not.toMatch(/tier while a durable adapter IS registered for them: [^.]*\bblob\b/);
  });

  it("'true' is still the all-ephemeral acknowledgement — it boots, and that is the dangerous form", () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = 'true';
    expect(() => assertDurableSurfacesInEnterprise(ALL_KEYS)).not.toThrow();
    expect(readInMemoryAllowance(ALL_KEYS)).toEqual({ all: true });
  });

  it('an acknowledgement naming an unknown surface is a refused boot, not an ignored typo', () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = 'blob,blobb';
    expect(() => assertDurableSurfacesInEnterprise(ALL_KEYS)).toThrow(
      /names unknown host surface\(s\): blobb\. Known surfaces: kv, table/,
    );
  });

  it('readInMemoryAllowance: unset, empty and false acknowledge nothing; lists are trimmed', () => {
    expect(readInMemoryAllowance(ALL_KEYS)).toEqual({ all: false, surfaces: new Set() });
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = '';
    expect(readInMemoryAllowance(ALL_KEYS)).toEqual({ all: false, surfaces: new Set() });
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = 'false';
    expect(readInMemoryAllowance(ALL_KEYS)).toEqual({ all: false, surfaces: new Set() });
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = ' blob , kv ';
    expect(readInMemoryAllowance(ALL_KEYS)).toEqual({ all: false, surfaces: new Set(['blob', 'kv']) });
  });

  it('a surface with no registered adapter is never a durability violation', () => {
    // Nothing registered at all → every surface is unbackable → nothing demandable.
    process.env.OPENWOP_DEPLOY_POSTURE = 'auth';
    expect(() => assertDurableSurfacesInEnterprise(ALL_KEYS)).not.toThrow();
    // Register ONE durable adapter and that one surface becomes demandable.
    registerSurfaceAdapter('kv', 'durable', () => ({}));
    expect(() => assertDurableSurfacesInEnterprise(ALL_KEYS)).toThrow(
      /but 1 resolve to the ephemeral in-memory tier while a durable adapter IS registered for them: kv\./,
    );
  });

  it('outside the auth posture the durability guard is a no-op, even on an unknown acknowledgement', () => {
    wireLikeBoot();
    process.env.OPENWOP_DEPLOY_POSTURE = 'cookie-per-visitor';
    process.env.OPENWOP_ALLOW_INMEMORY_SURFACES = 'nonsense';
    expect(() => assertDurableSurfacesInEnterprise(ALL_KEYS)).not.toThrow();
  });
});
