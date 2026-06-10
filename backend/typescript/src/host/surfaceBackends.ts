/**
 * Host-surface backend seam — the single point where a deployment chooses
 * which implementation backs each `ctx.*` host surface.
 *
 * Why this exists
 * ----------------
 * The in-memory surfaces in `inMemorySurfaces.ts` are demo-grade: process-local
 * Maps + `sqlite :memory:`, wiped on restart, single-instance. Turning the app
 * "production-grade" does NOT mean changing any wire shape — the surface
 * interfaces (`KvSurface`, `SqlSurface`, … per RFC 0014–0019) ARE the contract.
 * It means swapping the *implementation* behind each interface for a durable,
 * shared backend. This module is the seam that makes that swap a one-file
 * change per surface, with NO edit to pack code, the executor, or the wire.
 *
 * Cloud-agnostic by design
 * ------------------------
 * Backends are keyed by a portable id — `'redis'`, `'s3'`, `'postgres'`,
 * `'sql'` — never a vendor product name. The same adapter is meant to run
 * against any S3-compatible blob store, any Redis-protocol cache, any
 * SQL-standard database, on any cloud or self-hosted. The built-in id is
 * `'memory'` (the demo tier).
 *
 * Selection
 * ---------
 * Per surface, resolved highest-precedence first:
 *   1. `OPENWOP_SURFACE_<KEY>`   e.g. `OPENWOP_SURFACE_KV=redis`
 *   2. `OPENWOP_SURFACE_BACKEND` global default for every surface
 *   3. `'memory'`                the demo default
 *
 * A selected non-`memory` backend MUST have a registered adapter, or the app
 * refuses to boot (`assertSelectedBackendsAvailable`). A deployment that asks
 * for a real backend must never silently fall back to the ephemeral demo store
 * — that would be a correctness + durability lie.
 *
 * Adding a real backend (Phase 2+)
 * --------------------------------
 *   1. Implement the surface interface (e.g. a `KvSurface`) against the real
 *      store in `host/<backend>/<surface>.ts`.
 *   2. `registerSurfaceAdapter('kv', 'redis', (scope) => createRedisKv(scope))`
 *      — typically from that adapter module, imported at boot.
 *   3. Re-advertise: the adapter (or init) calls `registerHostSurface` so the
 *      `implementation` tag flips from a demo tag to `'redis'`; the UI
 *      demo-grade badge self-clears (see CapabilitiesPanel + ARCHITECTURE.md
 *      §"Path to real backends").
 *   4. Re-run conformance against the new wiring.
 */

import type { BundleScope } from './inMemorySurfaces.js';

/** The portable host surfaces selectable via this seam. Vendor surfaces
 *  (kanban/chat/canvas/…) are out of scope — they have their own stores. */
export type SurfaceKey =
  | 'kv'
  | 'table'
  | 'cache'
  | 'blob'
  | 'queue'
  | 'sql'
  | 'vector'
  | 'search'
  | 'nosql'
  | 'fs'
  | 'queueBus'
  | 'observability';

/** The built-in demo backend id. */
export const MEMORY_BACKEND = 'memory';

const ENV_PREFIX = 'OPENWOP_SURFACE_';

/** A run-scoped factory for a single surface, already bound to its backing
 *  store. Identical in shape to the in-memory `create*` functions once
 *  partially applied with their state, so adapters drop straight in. */
export type BoundFactory<S> = (scope: BundleScope) => S;

/** Registry of real-backend adapters, keyed by `surface:backendId`. The
 *  in-memory tier is NOT registered here — it is the implicit default passed
 *  to `resolveSurface` so the demo path carries zero registry overhead. */
const adapters = new Map<string, BoundFactory<unknown>>();

const adapterKey = (key: SurfaceKey, backendId: string): string => `${key}:${backendId}`;

/** Resolve which backend a surface should use (env-driven, see file header). */
export function resolveBackendId(key: SurfaceKey): string {
  const perSurface = process.env[`${ENV_PREFIX}${key.toUpperCase()}`];
  if (perSurface && perSurface.trim()) return perSurface.trim();
  const global = process.env.OPENWOP_SURFACE_BACKEND;
  if (global && global.trim()) return global.trim();
  return MEMORY_BACKEND;
}

/** Register a real-backend adapter for a surface. Called by adapter modules
 *  (Phase 2+). Idempotent-overwrite: last registration for a given
 *  `(surface, backendId)` wins, which keeps boot order from mattering. */
export function registerSurfaceAdapter<S>(
  key: SurfaceKey,
  backendId: string,
  factory: BoundFactory<S>,
): void {
  if (backendId === MEMORY_BACKEND) {
    throw new Error(
      `Cannot register an adapter under the reserved '${MEMORY_BACKEND}' backend id ` +
        `for surface '${key}'. The in-memory tier is the built-in default.`,
    );
  }
  adapters.set(adapterKey(key, backendId), factory as BoundFactory<unknown>);
}

/** True when a real adapter is registered for the surface's selected backend. */
export function hasAdapter(key: SurfaceKey, backendId: string): boolean {
  return adapters.has(adapterKey(key, backendId));
}

/**
 * Resolve the selected factory for a surface and build a run-scoped instance.
 * `memoryFactory` is the built-in in-memory impl, used when the resolved id is
 * `'memory'` (the default). Any other id MUST have a registered adapter — we
 * throw rather than fall back to the ephemeral demo store.
 */
export function resolveSurface<S>(
  key: SurfaceKey,
  memoryFactory: BoundFactory<S>,
  scope: BundleScope,
): S {
  const id = resolveBackendId(key);
  if (id === MEMORY_BACKEND) return memoryFactory(scope);
  const adapter = adapters.get(adapterKey(key, id));
  if (!adapter) {
    throw new Error(
      `No '${id}' adapter registered for host surface '${key}'. ` +
        `Set ${ENV_PREFIX}${key.toUpperCase()} to a registered backend, register one via ` +
        `registerSurfaceAdapter('${key}', '${id}', …), or unset it to use the built-in ` +
        `'${MEMORY_BACKEND}' demo store.`,
    );
  }
  return adapter(scope) as S;
}

/**
 * Boot-time guard: for every surface whose selected backend is not `'memory'`,
 * fail loudly NOW if no adapter is registered — rather than at the first run
 * that touches the surface. Call once during host init, after any adapter
 * modules have registered.
 */
export function assertSelectedBackendsAvailable(keys: readonly SurfaceKey[]): void {
  const missing: string[] = [];
  for (const key of keys) {
    const id = resolveBackendId(key);
    if (id !== MEMORY_BACKEND && !hasAdapter(key, id)) {
      missing.push(`${key} → '${id}'`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Host-surface backend(s) selected but not wired: ${missing.join(', ')}. ` +
        `Register the adapter(s) via registerSurfaceAdapter(), or unset the ` +
        `OPENWOP_SURFACE_* override to fall back to the '${MEMORY_BACKEND}' demo store. ` +
        `Refusing to boot with an unbacked surface selection.`,
    );
  }
}

/**
 * The advertised `implementation` tag for a surface: the selected backend id
 * when a real backend is chosen, else the descriptive demo tag passed in.
 * Keeps `/.well-known/openwop` honest — a non-demo value signals a real
 * backend and clears the UI demo-grade badge.
 */
export function effectiveImplementation(key: SurfaceKey, demoTag: string): string {
  const id = resolveBackendId(key);
  return id === MEMORY_BACKEND ? demoTag : id;
}

/** Test affordance — drop all registered adapters. */
export function _resetSurfaceAdaptersForTesting(): void {
  adapters.clear();
}
