/**
 * In-process registry of feature-toggle DEFAULTS (ADR §3.1).
 *
 * A feature package declares its toggle's default config once at boot
 * (`registerToggleDefault`), mirroring myndhyve's FEATURE_REGISTRY. The durable
 * store (service.ts) holds admin OVERRIDES layered over these defaults — so a
 * fresh deploy has every feature at its declared default with no DB rows, and
 * the admin screen lists defaults even before anyone has touched them.
 */

import { createLogger } from '../../observability/logger.js';
import type { ToggleConfig } from './types.js';

const log = createLogger('featureToggles.registry');

const defaults = new Map<string, ToggleConfig>();

/**
 * The feature dependency graph (ADR 0194): featureId → the ids it `dependsOn`.
 * Populated at boot from each `BackendFeature.dependsOn`. Kept beside the toggle
 * defaults because the disable-lock (service.ts `computeDisableBlockers`) resolves
 * against effective toggle state — one registry, no second source of truth for
 * "what features exist and how they relate".
 */
const dependencies = new Map<string, string[]>();

/**
 * Declare (or replace) a feature's default toggle config. Idempotent — calling
 * twice with the same id replaces the default (last declaration wins), which is
 * what we want when a feature manifest re-registers on hot-reload.
 */
export function registerToggleDefault(config: ToggleConfig): void {
  if (defaults.has(config.id)) {
    log.debug('toggle_default_replaced', { id: config.id });
  }
  defaults.set(config.id, config);
}

/** The default config for one toggle, or null if no feature declared it. */
export function getToggleDefault(id: string): ToggleConfig | null {
  return defaults.get(id) ?? null;
}

/** Every declared default, in declaration order. */
export function listToggleDefaults(): ToggleConfig[] {
  return [...defaults.values()];
}

/** Test-only: drop all declared defaults. */
export function __resetToggleDefaults(): void {
  defaults.clear();
}

// ── Feature dependency graph (ADR 0194) ───────────────────────────────────────

/**
 * Declare (or replace) a feature's hard dependencies. Idempotent — last wins,
 * mirroring `registerToggleDefault` on hot-reload. Empty/absent = no deps.
 *
 * § ADR 0439 — CYCLE GUARD. `computeDisableBlockers` is one-hop, so a dependency
 * cycle would not hang; it would SILENTLY make every feature in the cycle
 * permanently mutually undisableable (each is always "required by" the next), with
 * no error anywhere. Nothing previously prevented that.
 *
 * Two deliberate choices about how this fails:
 *
 * 1. **Drop the offending EDGE, never the key.** This map's KEYS are the
 *    authoritative backend feature-id set (`listRegisteredFeatureIds`, relied on by
 *    the bundle-catalog projection — see the note there). Refusing the whole
 *    registration would drop the id from that set, making the feature look
 *    UNREGISTERED and failing `gen-distribution --check` with "core names
 *    unregistered feature" — a worse failure than the cycle it prevents.
 * 2. **Log, never throw.** This runs at boot for every feature. A bad declaration
 *    must not take the whole service down over what is a lock-STRENGTH concern, not
 *    a safety one: dropping the edge yields exactly today's behaviour (the edge does
 *    not exist now either), so the runtime outcome is never worse than the status
 *    quo. The build-breaking half of this invariant belongs in CI, where a developer
 *    can act on it — `test/feature-dependency-parity.test.ts` asserts the declared
 *    graph is acyclic AND that no declared edge is silently dropped here, so the
 *    source can never claim a lock the runtime is not enforcing.
 */
export function registerFeatureDependencies(id: string, dependsOn: readonly string[]): void {
  const kept: string[] = [];
  for (const dep of new Set(dependsOn)) {
    const cyclePath = wouldCloseCycle(id, dep);
    if (cyclePath) {
      log.error('feature_dependency_cycle_dropped', {
        feature: id,
        dependency: dep,
        cycle: cyclePath.join(' → '),
        effect: 'edge dropped; the disable-lock will NOT protect this pair',
      });
      continue;
    }
    kept.push(dep);
  }
  dependencies.set(id, kept); // always set the key — it is the registered-feature set
}

/**
 * Would adding `from → to` close a cycle? True when `to` already reaches `from`
 * through the declared graph. Returns the offending path (for the log) or null.
 * Walks the CURRENT map, so registration order does not matter: whichever edge
 * closes the loop is the one dropped, and the parity test pins the final shape.
 */
function wouldCloseCycle(from: string, to: string): string[] | null {
  if (from === to) return [from, to];
  const seen = new Set<string>();
  const stack: Array<{ id: string; path: string[] }> = [{ id: to, path: [from, to] }];
  while (stack.length > 0) {
    const { id, path } = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of dependencies.get(id) ?? []) {
      if (next === from) return [...path, from];
      stack.push({ id: next, path: [...path, next] });
    }
  }
  return null;
}

/** Test-only: the edges this registry actually ENFORCES (post cycle-guard), so a
 *  test can prove the declared graph and the enforced graph agree. */
export function enforcedFeatureDependencies(): Record<string, string[]> {
  return Object.fromEntries([...dependencies].map(([k, v]) => [k, [...v]]));
}

/** Every registered backend feature id. `registerBackendFeatures` calls
 *  `registerFeatureDependencies(feature.id, …)` for EVERY feature (even with
 *  no deps), so this map's keys are the authoritative backend feature-id set —
 *  the cycle-free source the bundle-catalog projection needs (importing
 *  `BACKEND_FEATURES` would close an index → feature → routes cycle). */
export function listRegisteredFeatureIds(): string[] {
  return [...dependencies.keys()];
}

/** The ids this feature declares it depends on (empty if none). */
export function getFeatureDependencies(id: string): string[] {
  return dependencies.get(id) ?? [];
}

/** The ids of features that declare a dependency ON `id` (its dependents), sorted.
 *  These are what a disable-lock protects: turning `id` off would orphan them. */
export function getFeatureDependents(id: string): string[] {
  const out: string[] = [];
  for (const [featureId, deps] of dependencies) {
    if (deps.includes(id)) out.push(featureId);
  }
  return out.sort();
}

/** Test-only: drop the dependency graph. */
export function __resetFeatureDependencies(): void {
  dependencies.clear();
}

// ── Feature soft-dependencies / recommendations (ADR 0194 Phase 5) ────────────

/** featureId → ids it `recommends` (works better with, but does NOT require).
 *  Advisory only — surfaced as a console suggestion, NEVER a lock. */
const recommends = new Map<string, string[]>();

/** Declare (or replace) a feature's soft dependencies. Idempotent — last wins. */
export function registerFeatureRecommends(id: string, recs: readonly string[]): void {
  recommends.set(id, [...new Set(recs)]);
}

/** The ids this feature recommends (empty if none). */
export function getFeatureRecommends(id: string): string[] {
  return recommends.get(id) ?? [];
}

// ── Per-feature required packs (ADR 0194 Phase 2) ────────────────────────────

/** A pinned pack ref as declared by `BackendFeature.requiredPacks`. */
export interface FeaturePackRef {
  name: string;
  version: string;
}

/**
 * featureId → pinned pack refs, registered at boot beside the dependency graph
 * (the Phase 1 pattern — one registry, no second source of truth; core never
 * imports feature modules to learn this). The admin Plugins-console projection
 * (service.ts `buildFeatureConsole`) joins these with on-disk pack presence.
 */
const featurePacks = new Map<string, FeaturePackRef[]>();

/** Declare (or replace) a feature's required packs. Idempotent — last wins. */
export function registerFeaturePacks(id: string, refs: readonly FeaturePackRef[]): void {
  featurePacks.set(id, refs.map((r) => ({ name: r.name, version: r.version })));
}

/** The pinned pack refs a feature declares (empty if none). */
export function getFeaturePacks(id: string): FeaturePackRef[] {
  return featurePacks.get(id) ?? [];
}

/** Test-only: drop the per-feature pack registry. */
export function __resetFeaturePacks(): void {
  featurePacks.clear();
}
