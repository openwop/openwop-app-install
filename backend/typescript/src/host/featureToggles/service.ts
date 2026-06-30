/**
 * Feature-toggle evaluation service (backend authority — ADR §3.4).
 *
 * The BACKEND is the sole authority for toggle/variant resolution: a client
 * cannot be trusted to assert which variant it is in when that variant gates
 * server routes, pack activation, or run behavior. The frontend consumes a
 * resolved-assignments map read-only.
 *
 * Storage: admin overrides live in the durable host_ext_kv store
 * (DurableCollection) — cross-instance correct, no schema migration. Effective
 * config = stored override (if any) layered over the feature-declared default
 * (registry.ts). Resolution is pure given the effective config + subject
 * (bucketing.ts), so a run can stamp its variant and replay it verbatim.
 */

import { DurableCollection } from '../hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { assignVariant } from './bucketing.js';
import { getToggleDefault, listToggleDefaults } from './registry.js';
import type { FeatureToggleStatus, ResolvedAssignment, ToggleConfig, ToggleSubject } from './types.js';

const log = createLogger('host.featureToggles');

/** Durable store of admin-saved toggle configs, keyed by toggle id. */
const store = new DurableCollection<ToggleConfig>('feature-toggle', (c) => c.id);

/**
 * INS-3 — toggle-status lifecycle seam. A listener fires when a toggle's effective STATUS
 * changes via `saveConfig`, letting a feature tear down side-effects it armed while enabled
 * (scheduled jobs, trigger subscriptions) when its toggle flips OFF. Host owns the seam;
 * features register at module load (the `registerSubjectEraser` inversion pattern — core
 * never imports features, so no cycle). Best-effort: a listener error never blocks the save.
 */
export type ToggleStatusListener = (id: string, prev: FeatureToggleStatus | null, next: FeatureToggleStatus) => void | Promise<void>;
const statusListeners: ToggleStatusListener[] = [];
export function registerToggleStatusListener(fn: ToggleStatusListener): void {
  if (!statusListeners.includes(fn)) statusListeners.push(fn);
}
/** Test-only: clear registered status listeners. */
export function __resetToggleStatusListeners(): void { statusListeners.length = 0; }

/** The effective config for one toggle: stored override layered over the
 *  feature-declared default. A stored override only applies while the feature
 *  STILL declares a default — once a feature GRADUATES (its `toggleDefault` is
 *  removed: users/connections/assistant/profiles became always-on substrate), a
 *  lingering stored row is ORPHANED and must not resurface as a live toggle
 *  (it would show in admin and still resolve). Returns null then. */
export async function getEffectiveConfig(id: string): Promise<ToggleConfig | null> {
  const def = getToggleDefault(id);
  if (!def) return null; // graduated / removed feature — ignore any orphaned override
  return (await store.get(id)) ?? def;
}

/**
 * Every effective config: the declared defaults, with a stored override winning
 * per id. A stored row whose feature has GRADUATED (no declared default) is
 * orphaned and excluded — `pruneOrphanedConfigs()` deletes those at boot, but the
 * filter is the safety net so a graduated feature can never reappear in admin.
 * Sorted by id for a stable admin-screen order.
 */
export async function listEffectiveConfigs(): Promise<ToggleConfig[]> {
  const byId = new Map<string, ToggleConfig>();
  for (const d of listToggleDefaults()) byId.set(d.id, d);
  for (const s of await store.list()) if (byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Delete stored toggle configs whose feature no longer declares a default (it
 * GRADUATED to always-on, or was removed). Called at boot — without it, the
 * admin-saved row for a since-graduated feature lingers in the store forever
 * (e.g. the `assistant`/`profiles` rows after their toggles were removed).
 * Idempotent; returns the number pruned. */
export async function pruneOrphanedConfigs(): Promise<number> {
  const known = new Set(listToggleDefaults().map((d) => d.id));
  const stored = await store.list();
  let pruned = 0;
  for (const s of stored) {
    if (!known.has(s.id)) {
      await store.delete(s.id);
      pruned += 1;
    }
  }
  return pruned;
}

/** Persist an admin-saved config (upsert). Caller validates first. Fires the INS-3
 *  toggle-status seam when the effective status changes (best-effort, never blocks). */
export async function saveConfig(config: ToggleConfig, savedBy: string): Promise<ToggleConfig> {
  const prevStatus = (await store.get(config.id))?.status ?? getToggleDefault(config.id)?.status ?? null;
  const next: ToggleConfig = { ...config, updatedAt: new Date().toISOString(), updatedBy: savedBy };
  await store.put(next);
  if (prevStatus !== next.status) {
    for (const fn of statusListeners) {
      try {
        await fn(config.id, prevStatus, next.status);
      } catch (err) {
        log.warn('toggle_status_listener_failed', { id: config.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return next;
}

/**
 * ADR 0027: delete any durable override for a toggle id that has been RETIRED
 * (a feature that became always-on and dropped its `toggleDefault`). Without
 * this, `getEffectiveConfig` would keep returning the stored override (store
 * wins over default) — leaving `resolveOne` returning stale state and a ghost
 * row in the admin panel (`listEffectiveConfigs` unions store over defaults).
 * Idempotent; returns the ids whose lingering override was removed.
 */
export async function retireToggleOverrides(ids: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const id of ids) {
    if (await store.delete(id)) removed.push(id);
  }
  return removed;
}

/** The unit id a toggle buckets on for this subject (ADR §3.3). */
function unitIdFor(config: ToggleConfig, subject: ToggleSubject): string {
  if (config.bucketUnit === 'tenant') return subject.tenantId;
  // `user` unit: stable per-principal id, falling back to tenantId (in this app
  // each visitor already has its own tenant, so the fallback is per-visitor).
  return subject.userId ?? subject.tenantId;
}

function inBetaCohort(config: ToggleConfig, subject: ToggleSubject): boolean {
  const cohort = config.betaCohort;
  if (!cohort || cohort.length === 0) return false; // fail-closed
  return cohort.includes(subject.tenantId) || (subject.userId !== undefined && cohort.includes(subject.userId));
}

/** Resolve one effective config against a subject. Pure given (config, subject). */
export function resolveConfig(config: ToggleConfig, subject: ToggleSubject): ResolvedAssignment {
  // Apply the per-tenant override (ADR §3.1: tenant override → global default).
  let status = config.status;
  let variants = config.variants;
  const override = config.tenantOverrides?.[subject.tenantId];
  if (override) {
    if (override.status !== undefined) status = override.status;
    if (override.variants !== undefined) variants = override.variants;
  }

  if (status === 'off') {
    return { id: config.id, status, enabled: false, variant: null };
  }
  if (status === 'beta') {
    // OPEN beta by default: a `beta` toggle with NO cohort is enabled for
    // everyone (the FE renders a Beta badge from `status`). A non-empty
    // `betaCohort` narrows it to a CLOSED beta — eligible ids only, everyone
    // else sees it off (ADR §3.6, corrected 2026-06-09 per maintainer:
    // open-beta-with-badge matches the myndhyve reference).
    const cohort = config.betaCohort;
    const closedBeta = cohort !== undefined && cohort.length > 0;
    if (closedBeta && !inBetaCohort(config, subject)) {
      return { id: config.id, status, enabled: false, variant: null };
    }
  }

  // status 'on', or 'beta' (open, or closed + eligible) ⇒ enabled. Split traffic.
  const variant =
    variants && variants.length > 0
      ? assignVariant(unitIdFor(config, subject), config.id, config.salt, variants)
      : null;
  const bindings = variant ? variants?.find((v) => v.key === variant)?.bindings : undefined;
  return { id: config.id, status, enabled: true, variant, ...(bindings ? { bindings } : {}) };
}

/** Resolve every toggle for a subject — the FE assignments payload. */
export async function resolveAssignments(subject: ToggleSubject): Promise<ResolvedAssignment[]> {
  const configs = await listEffectiveConfigs();
  return configs.map((c) => resolveConfig(c, subject));
}

/** Resolve a single toggle by id for a subject (null if no such toggle). */
export async function resolveOne(id: string, subject: ToggleSubject): Promise<ResolvedAssignment | null> {
  const config = await getEffectiveConfig(id);
  return config ? resolveConfig(config, subject) : null;
}

/** Test-only: clear durable overrides. */
export async function __clearToggleStore(): Promise<void> {
  await store.__clear();
}
