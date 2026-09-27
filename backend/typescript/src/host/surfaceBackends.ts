/**
 * Host-surface backend seam — the single point where a deployment chooses
 * which implementation backs each `ctx.*` host surface.
 *
 * Why this exists
 * ----------------
 * The in-memory surfaces in `inMemorySurfaces.ts` are non-durable: process-local
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
 *      non-durable badge self-clears (see CapabilitiesPanel + ARCHITECTURE.md
 *      §"Path to real backends").
 *   4. Re-run conformance against the new wiring.
 */

import type { BundleScope } from './inMemorySurfaces.js';
import { readDeployPosture } from './deployPosture.js';

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
  | 'observability'
  // RFC 0004 agent memory (DUR-2, ADR 0195). Not a bundle surface — the memory
  // API is module-level in inMemorySurfaces.ts — but backend SELECTION rides
  // this same seam (OPENWOP_SURFACE_MEMORY / OPENWOP_SURFACE_BACKEND), so the
  // boot assertions, the enterprise durability guard, and the honest
  // advertisement all treat it uniformly.
  | 'memory';

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

/** Every non-`memory` backend id with a registered adapter for `key`, sorted.
 *  Empty means the surface is structurally UNBACKABLE: no configuration an
 *  operator can set makes it durable, so no guard may demand that it be. */
export function registeredBackendIds(key: SurfaceKey): string[] {
  const prefix = `${key}:`;
  return [...adapters.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort();
}

/** True when no non-`memory` adapter is registered for the surface. */
export function isUnbackable(key: SurfaceKey): boolean {
  return registeredBackendIds(key).length === 0;
}

const envName = (key: SurfaceKey): string => `${ENV_PREFIX}${key.toUpperCase()}`;

/** Whether a surface's selection came from its own `OPENWOP_SURFACE_<KEY>` or
 *  fell through to the global `OPENWOP_SURFACE_BACKEND`. */
function selectionSource(key: SurfaceKey): 'per-surface' | 'global-default' | 'default' {
  const perSurface = process.env[envName(key)];
  if (perSurface && perSurface.trim()) return 'per-surface';
  const global = process.env.OPENWOP_SURFACE_BACKEND;
  if (global && global.trim()) return 'global-default';
  return 'default';
}

/**
 * Boot-time guard: for every surface whose selected backend is not `'memory'`,
 * fail loudly NOW if no adapter is registered — rather than at the first run
 * that touches the surface. Call once during host init, after any adapter
 * modules have registered.
 *
 * The message distinguishes a PER-SURFACE selection (the operator named a
 * backend this surface does not have) from a GLOBAL-DEFAULT one (the operator
 * asked for "everything durable" and this surface has no adapter under that
 * id). The second case is the common one — `OPENWOP_SURFACE_BACKEND=durable`
 * with `blob` (only `s3`) and `observability` (nothing) — and the fix is to opt
 * exactly those surfaces back out, so the message prints those lines. It never
 * falls back silently: a deployment that asked for a real backend and did not
 * get one is a durability lie, and the honest answer is a refused boot.
 */
export function assertSelectedBackendsAvailable(keys: readonly SurfaceKey[]): void {
  const missing: string[] = [];
  const fromGlobal: SurfaceKey[] = [];
  for (const key of keys) {
    const id = resolveBackendId(key);
    if (id !== MEMORY_BACKEND && !hasAdapter(key, id)) {
      const have = registeredBackendIds(key);
      const source = selectionSource(key);
      if (source === 'global-default') fromGlobal.push(key);
      missing.push(
        `${key} → '${id}' (${source === 'per-surface' ? envName(key) : 'via OPENWOP_SURFACE_BACKEND'}; ` +
          `registered adapters: ${have.length > 0 ? have.join(', ') : 'none'})`,
      );
    }
  }
  if (missing.length > 0) {
    const optOut = fromGlobal.map((k) => `${envName(k)}=${MEMORY_BACKEND}`).join(' ');
    // Only surfaces that COULD be durable need the auth-posture acknowledgement;
    // an unbackable one is excluded from that guard (see below).
    const needAck = fromGlobal.filter((k) => !isUnbackable(k));
    const hatch =
      readDeployPosture() === 'auth' && needAck.length > 0
        ? ` — then, in the auth posture, acknowledge those as ephemeral with ` +
          `OPENWOP_ALLOW_INMEMORY_SURFACES=${needAck.join(',')}`
        : '';
    throw new Error(
      `Host-surface backend(s) selected but not wired: ${missing.join('; ')}. ` +
        `Register the adapter(s) via registerSurfaceAdapter(), select a registered backend ` +
        `per surface with OPENWOP_SURFACE_<KEY>=<id>` +
        (fromGlobal.length > 0
          ? `, or opt these surfaces back out of the global default with: ${optOut}${hatch}`
          : `, or unset the OPENWOP_SURFACE_* override to fall back to the '${MEMORY_BACKEND}' demo store`) +
        `. Refusing to boot with an unbacked surface selection.`,
    );
  }
}

/** The parsed `OPENWOP_ALLOW_INMEMORY_SURFACES` acknowledgement. `true` accepts
 *  ephemeral surfaces EVERYWHERE (the pre-ADR-0636 all-or-nothing form); a
 *  comma-separated list of surface keys accepts exactly those. */
export type InMemoryAllowance =
  | { readonly all: true }
  | { readonly all: false; readonly surfaces: ReadonlySet<SurfaceKey> };

/**
 * Parse `OPENWOP_ALLOW_INMEMORY_SURFACES`. Unset / empty / `false` → nothing is
 * acknowledged. `true` → everything is. Otherwise a comma list of surface keys;
 * an unknown key is a refused boot, not a silently ignored typo — the whole
 * point of the list form is that it says exactly what the operator accepted.
 */
export function readInMemoryAllowance(known: readonly SurfaceKey[]): InMemoryAllowance {
  const raw = (process.env.OPENWOP_ALLOW_INMEMORY_SURFACES ?? '').trim();
  if (raw === '' || raw === 'false') return { all: false, surfaces: new Set() };
  if (raw === 'true') return { all: true };
  const knownSet = new Set<string>(known);
  const listed = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const unknown = listed.filter((s) => !knownSet.has(s));
  if (unknown.length > 0) {
    throw new Error(
      `OPENWOP_ALLOW_INMEMORY_SURFACES names unknown host surface(s): ${unknown.join(', ')}. ` +
        `Known surfaces: ${known.join(', ')}. Use a comma-separated list of those, or 'true' ` +
        `to accept ephemeral surfaces everywhere. Refusing to boot on an acknowledgement ` +
        `that does not name real surfaces.`,
    );
  }
  return { all: false, surfaces: new Set(listed as SurfaceKey[]) };
}

/**
 * Boot-time durability guard for the ENTERPRISE (auth) posture. A real
 * multi-tenant install must not silently run its `ctx.*` host surfaces on the
 * ephemeral in-memory tier — tenant data would reset on every restart/scale
 * event with no error. Mirrors the BYOK-KMS fail-closed guard (`index.ts`): in
 * `OPENWOP_DEPLOY_POSTURE=auth`, refuse to boot when a surface resolves to
 * `'memory'`. The public demo (`cookie-per-visitor`), local dev, and tests use a
 * non-auth posture and are unaffected.
 *
 * ADR 0636 — the guard asserts only what an operator can satisfy:
 *
 * - A surface with NO registered non-memory adapter (`isUnbackable`) is not a
 *   violation. Demanding durability for it was unsatisfiable by configuration,
 *   which made the escape hatch mandatory boilerplate for every auth deploy and
 *   destroyed its signal (measured on a real deploy: `observability` has no
 *   adapter; `blob` has none under the `durable` id).
 * - `OPENWOP_ALLOW_INMEMORY_SURFACES` acknowledges surfaces BY NAME
 *   (`blob`, or `blob,kv`), so "I accept ephemeral blob" and "I accept
 *   ephemeral everything" are different configurations. `true` still means
 *   everything, and is the dangerous form: all thirteen surfaces ephemeral with
 *   one line.
 * - The message names the failing surfaces, the adapters each one DOES have,
 *   the exact per-surface lines to select one, and the exact acknowledgement.
 */
export function assertDurableSurfacesInEnterprise(keys: readonly SurfaceKey[]): void {
  if (readDeployPosture() !== 'auth') return; // demo / anon / shared-bearer / dev / test
  const allowance = readInMemoryAllowance(keys);
  if (allowance.all) return; // explicit all-ephemeral acknowledgement
  const ephemeral = keys.filter((key) => resolveBackendId(key) === MEMORY_BACKEND);
  const unbackable = ephemeral.filter((key) => isUnbackable(key));
  const acknowledged = ephemeral.filter((key) => !isUnbackable(key) && allowance.surfaces.has(key));
  const violating = ephemeral.filter((key) => !isUnbackable(key) && !allowance.surfaces.has(key));
  if (violating.length === 0) return;
  const selectLines = violating
    .map((key) => `${envName(key)}=<${registeredBackendIds(key).join('|')}>`)
    .join(' ');
  throw new Error(
    `OPENWOP_DEPLOY_POSTURE=auth requires durable host surfaces, but ${violating.length} ` +
      `resolve to the ephemeral in-memory tier while a durable adapter IS registered for them: ` +
      `${violating.join(', ')}. Select one per surface (${selectLines}), or acknowledge exactly ` +
      `these as ephemeral with OPENWOP_ALLOW_INMEMORY_SURFACES=${violating.join(',')}. ` +
      (unbackable.length > 0
        ? `Not counted — no durable adapter exists, nothing to select: ${unbackable.join(', ')}. `
        : '') +
      (acknowledged.length > 0 ? `Already acknowledged: ${acknowledged.join(', ')}. ` : '') +
      `Refusing to boot: enterprise tenant data would silently reset on restart.`,
  );
}

/**
 * The advertised `implementation` tag for a surface: the selected backend id
 * when a real backend is chosen, else the descriptive demo tag passed in.
 * Keeps `/.well-known/openwop` honest — a non-demo value signals a real
 * backend and clears the UI non-durable badge.
 */
export function effectiveImplementation(key: SurfaceKey, demoTag: string): string {
  const id = resolveBackendId(key);
  return id === MEMORY_BACKEND ? demoTag : id;
}

/** Test affordance — drop all registered adapters. */
export function _resetSurfaceAdaptersForTesting(): void {
  adapters.clear();
}
