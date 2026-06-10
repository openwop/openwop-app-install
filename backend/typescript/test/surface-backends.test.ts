import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveBackendId,
  resolveSurface,
  registerSurfaceAdapter,
  hasAdapter,
  assertSelectedBackendsAvailable,
  effectiveImplementation,
  _resetSurfaceAdaptersForTesting,
  MEMORY_BACKEND,
} from '../src/host/surfaceBackends.js';

const SCOPE = { tenantId: 't1' } as const;

describe('host-surface backend seam', () => {
  afterEach(() => {
    _resetSurfaceAdaptersForTesting();
    delete process.env.OPENWOP_SURFACE_KV;
    delete process.env.OPENWOP_SURFACE_BACKEND;
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
    delete process.env.OPENWOP_SURFACE_VECTOR;
  });
});
