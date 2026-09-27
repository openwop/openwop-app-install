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
import { packPresence } from '../../packs/registryInstaller.js';
import { getFeatureDependencies, getFeatureDependents, getFeaturePacks, getFeatureRecommends, getToggleDefault, listToggleDefaults } from './registry.js';
import type { FeatureToggleStatus, ResolvedAssignment, ToggleConfig, ToggleSubject } from './types.js';

const log = createLogger('host.featureToggles');

/** Durable store of admin-saved toggle configs, keyed by toggle id. */
const store = new DurableCollection<ToggleConfig>('feature-toggle', (c) => c.id);

/*
 * INS-3's toggle-status lifecycle seam (`ToggleStatusListener` +
 * `registerToggleStatusListener` + `__resetToggleStatusListeners`) was REMOVED
 * here — ADR 0734. Its only registrant was insights-suite's
 * `teardownAllSchedules`, itself removed by ADR 0599 §6 (see the note at
 * `features/insights-suite/insightsSuiteService.ts`). With zero registrants the
 * two dispatch loops below iterated an array that could never be non-empty.
 * Restore the whole seam — registrar, array and dispatch — if a feature again
 * needs to tear down side-effects on an OFF flip; do not re-add the registrar
 * alone.
 */

/** The effective config for one toggle: stored override layered over the
 *  feature-declared default. A stored override only applies while the feature
 *  STILL declares a default — once a feature GRADUATES (its `toggleDefault` is
 *  removed: users/connections/assistant/profiles became always-on substrate), a
 *  lingering stored row is ORPHANED and must not resurface as a live toggle
 *  (it would show in admin and still resolve). Returns null then. */
/** Overlay a stored admin override onto the compiled default. The store holds only
 *  the admin's CHOICES — status, variants, cohort, per-tenant overrides, audit — while
 *  the feature-DECLARED metadata (label, description, category, bucketUnit, salt) ALWAYS
 *  resolves from code. Without this, a row saved before a feature was (re)categorized
 *  or renamed shadows the current metadata: e.g. a canvas toggle flipped before the
 *  `Canvases` category existed would keep resurfacing under "General" (the "store-first
 *  shadows default" bug). bucketUnit/salt from the default keep bucketing stable too. */
function mergeStoredOverDefault(def: ToggleConfig, stored: ToggleConfig): ToggleConfig {
  return {
    ...def, // id + declared metadata (label/description/category/bucketUnit/salt)
    status: stored.status,
    ...(stored.variants !== undefined ? { variants: stored.variants } : {}),
    ...(stored.betaCohort !== undefined ? { betaCohort: stored.betaCohort } : {}),
    ...(stored.tenantOverrides !== undefined ? { tenantOverrides: stored.tenantOverrides } : {}),
    ...(stored.updatedAt !== undefined ? { updatedAt: stored.updatedAt } : {}),
    ...(stored.updatedBy !== undefined ? { updatedBy: stored.updatedBy } : {}),
  };
}

export async function getEffectiveConfig(id: string): Promise<ToggleConfig | null> {
  const def = getToggleDefault(id);
  if (!def) return null; // graduated / removed feature — ignore any orphaned override
  const stored = await store.get(id);
  return stored ? mergeStoredOverDefault(def, stored) : def;
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
  for (const s of await store.list()) { const d = byId.get(s.id); if (d) byId.set(s.id, mergeStoredOverDefault(d, s)); }
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

/** Delete the stored override → the toggle reverts to its compiled default
 *  (architect 2026-07-13, finding 2 — the former path was psql surgery on the
 *  host_ext_kv row).
 *  Returns the now-effective (code-declared) config, or null if none stored. */
export async function deleteConfig(id: string, deletedBy: string): Promise<ToggleConfig | null> {
  const stored = await store.get(id);
  if (!stored) return null;
  const def = getToggleDefault(id);
  await store.delete(id);
  log.info('feature_toggle_override_deleted', { id, deletedBy, storedStatus: stored.status, revertsTo: def?.status ?? null });
  return def ?? null;
}

/** Admin projection of one effective config + provenance (finding 3): whether a
 *  stored row pins it, and whether the compiled default drifted under the pin. */
export async function getAdminConfig(id: string): Promise<(ToggleConfig & { overridden: boolean; defaultDrift: boolean }) | null> {
  const def = getToggleDefault(id);
  if (!def) return null;
  const stored = await store.get(id);
  const effective = stored ? mergeStoredOverDefault(def, stored) : def;
  const defaultDrift = Boolean(stored && stored.overriddenDefaultStatus !== undefined && stored.overriddenDefaultStatus !== def.status);
  return { ...effective, overridden: Boolean(stored), defaultDrift };
}

/** Persist an admin-saved config (upsert). Caller validates first. */
export async function saveConfig(config: ToggleConfig, savedBy: string): Promise<ToggleConfig> {
  const def = getToggleDefault(config.id);
  // Persist ONLY the admin's CHOICES (status/variants/cohort/overrides) + the
  // structural fields (bucketUnit/salt, taken from the def when available). The
  // declared DISPLAY metadata (label/description/category) is deliberately NOT
  // stored — it always resolves from code on read (mergeStoredOverDefault), so
  // persisting it just leaves dead fields that drift from the feature declaration
  // (the same shadowing class that mis-grouped the toggles page).
  const next: ToggleConfig = {
    id: config.id,
    status: config.status,
    bucketUnit: def?.bucketUnit ?? config.bucketUnit,
    salt: def?.salt ?? config.salt,
    ...(config.variants !== undefined ? { variants: config.variants } : {}),
    ...(config.betaCohort !== undefined ? { betaCohort: config.betaCohort } : {}),
    ...(config.tenantOverrides !== undefined ? { tenantOverrides: config.tenantOverrides } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: savedBy,
    // Finding 1 (architect 2026-07-13): remember which compiled default this
    // row overrode, so a later compiled-default change surfaces as drift.
    ...(def ? { overriddenDefaultStatus: def.status } : {}),
  };
  await store.put(next);
  // Return the EFFECTIVE config (declared metadata merged back from code) so the
  // API response is complete even though the stored row is lean.
  return def ? mergeStoredOverDefault(def, next) : next;
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

/**
 * Enable a feature FOR ONE TENANT via a per-tenant override, atomically
 * (ADR 0292 / SEED-RS-3). A naive get→merge→`saveConfig` loses writes when two
 * tenants are enabled against the SAME shared, toggle-id-keyed config row at
 * once (each reads the pre-write config, the second `put` clobbers the first's
 * override). This compare-and-swaps against the exact stored row and retries on
 * contention, so every per-tenant override lands. Uses the store directly (not
 * `saveConfig`): adding one tenant's override never changes the GLOBAL status,
 * so the status-listener seam must not fire. Returns:
 *   'enabled'    — an override was written this call
 *   'already-on' — already enabled for the tenant (global on/beta or an override)
 *   'unknown'    — no such toggle (graduated/removed feature)
 */
export async function enableTenantOverride(
  id: string,
  tenantId: string,
  actor: string,
): Promise<'enabled' | 'already-on' | 'unknown'> {
  const MAX_TRIES = 6;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const effective = await getEffectiveConfig(id);
    if (!effective) return 'unknown';
    if (resolveConfig(effective, { tenantId }).enabled) return 'already-on';
    const stored = await store.get(id); // exact CAS `expected` (null ⇒ insert-if-absent)
    const base = stored ?? effective; // when nothing's stored, persist the default as the base
    const next: ToggleConfig = {
      ...base,
      tenantOverrides: { ...base.tenantOverrides, [tenantId]: { status: 'on' } },
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    if (await store.compareAndSwap(stored, next)) return 'enabled';
    // Lost the race — another writer changed the row; re-read and retry.
  }
  throw new Error(`enableTenantOverride: CAS contention on toggle '${id}' after ${MAX_TRIES} attempts`);
}

/**
 * Set (or CLEAR) a tenant's per-tenant status override on ONE toggle
 * (ADR 0387 — the environments config-domain restore seam). CAS-safe like
 * `enableTenantOverride`: it mutates only `tenantOverrides[tenantId]` on the
 * shared config row, so two tenants restoring config snapshots concurrently
 * cannot clobber each other. `status: null` DELETES the tenant's override key
 * (semantically distinct from `'off'` — "no override" vs "override to off", the
 * distinction an exact-match snapshot restore must round-trip). Uses
 * `store.compareAndSwap` directly, NOT `saveConfig`, because changing ONE
 * tenant's override never alters the GLOBAL status — the status-listener seam
 * must not fire. Returns 'set' / 'cleared' / 'unchanged' / 'unknown'.
 */
export async function setTenantOverrideStatus(
  id: string,
  tenantId: string,
  status: FeatureToggleStatus | null,
  actor: string,
): Promise<'set' | 'cleared' | 'unchanged' | 'unknown'> {
  const MAX_TRIES = 6;
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const effective = await getEffectiveConfig(id);
    if (!effective) return 'unknown';
    const stored = await store.get(id); // exact CAS `expected` (null ⇒ insert-if-absent)
    const base = stored ?? effective; // persist the default as the base when nothing's stored
    const current = base.tenantOverrides?.[tenantId]?.status;
    const nextOverrides = { ...base.tenantOverrides };
    if (status === null) {
      if (current === undefined) return 'unchanged';
      delete nextOverrides[tenantId];
    } else {
      if (current === status) return 'unchanged';
      nextOverrides[tenantId] = { ...nextOverrides[tenantId], status };
    }
    const next: ToggleConfig = {
      ...base,
      tenantOverrides: nextOverrides,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    if (await store.compareAndSwap(stored, next)) return status === null ? 'cleared' : 'set';
    // Lost the race — re-read and retry.
  }
  throw new Error(`setTenantOverrideStatus: CAS contention on toggle '${id}' after ${MAX_TRIES} attempts`);
}

/** Read a tenant's COMPLETE effective per-tenant status-override set — every
 *  toggle whose `tenantOverrides[tenantId]` is set, with its status (ADR 0387
 *  snapshot export). Overrides only (not compiled defaults) — a faithful
 *  restore re-applies exactly these and clears the rest. */
export async function listTenantOverrides(tenantId: string): Promise<Record<string, FeatureToggleStatus>> {
  const out: Record<string, FeatureToggleStatus> = {};
  for (const cfg of await listEffectiveConfigs()) {
    const status = cfg.tenantOverrides?.[tenantId]?.status;
    if (status !== undefined) out[cfg.id] = status;
  }
  return out;
}

/**
 * Strip a tenant's per-tenant overrides from EVERY stored toggle config
 * (ADR 0292 lifecycle fix). Toggle configs are keyed by toggle id, not tenant,
 * so `purgeTenantHostExt`'s tenant-owned-row walk can't reach the nested
 * `tenantOverrides[tenantId]` entries — they'd otherwise linger forever after a
 * tenant is deleted (e.g. one that `provision-demo` enabled features for). The
 * account-deletion flow calls this beside the host-ext purge. Uses `store.put`
 * (not `saveConfig`): removing one tenant's override never changes the GLOBAL
 * status, so the status-listener seam must not fire. Returns the toggle ids
 * touched. Fail-closed on a falsy tenant.
 */
export async function purgeTenantOverrides(tenantId: string): Promise<string[]> {
  if (!tenantId) return [];
  const touched: string[] = [];
  for (const cfg of await store.list()) {
    if (!cfg.tenantOverrides || !(tenantId in cfg.tenantOverrides)) continue;
    const { [tenantId]: _removed, ...rest } = cfg.tenantOverrides;
    await store.put({ ...cfg, tenantOverrides: rest });
    touched.push(cfg.id);
  }
  return touched;
}

// ── Feature dependency lifecycle (ADR 0194) ───────────────────────────────────

/** The effective status of a config for one tenant: its override, else the global
 *  default. Mirrors `resolveConfig`'s override precedence. */
function statusForTenant(cfg: ToggleConfig, tenantId: string): FeatureToggleStatus {
  return cfg.tenantOverrides?.[tenantId]?.status ?? cfg.status;
}

/** Enabled (not `off`) in ANY scope — globally or via any tenant override. A null
 *  config is always-on substrate (no toggle) ⇒ enabled everywhere. Used to gate the
 *  admin console's global Off control conservatively (ADR 0194 Phase 5). */
function isEnabledAnywhere(cfg: ToggleConfig | null): boolean {
  if (!cfg) return true;
  if (cfg.status !== 'off') return true;
  return Object.values(cfg.tenantOverrides ?? {}).some((o) => (o.status ?? cfg.status) !== 'off');
}

/** One orphaning scope surfaced by the disable-lock (ADR 0194 Phase 5). */
export interface DisableBlocker {
  /** The dependent feature that would be orphaned. */
  dependentId: string;
  /** `null` = the GLOBAL default change orphans the dependent's default population;
   *  a tenant id = that workspace's resolved pair (override→default) orphans it. */
  tenantId: string | null;
}

/**
 * Disable-lock (ADR 0194 Phase 1; per-tenant coherence added in Phase 5): a feature
 * MUST NOT be turned OFF — globally OR for a specific workspace — while a feature
 * that hard-depends on it stays enabled in that same scope, which would orphan the
 * dependent. Given the config about to be saved (`next` = the dependency, with its
 * global status + per-tenant overrides), returns every orphaning scope; empty ⇒
 * allowed. The route maps a non-empty result to a `409 conflict`.
 *
 * Both sides are resolved per scope (override → global default), so this catches
 * the case Phase 1 missed: disabling a dependency via a tenant override, or the
 * global default, while a dependent is enabled only for that tenant. Always-on
 * dependents (no toggle) are enabled in every scope and can never be orphaned away.
 */
export async function computeDisableBlockers(next: ToggleConfig): Promise<DisableBlocker[]> {
  const out: DisableBlocker[] = [];
  for (const dependentId of getFeatureDependents(next.id)) {
    const dep = await getEffectiveConfig(dependentId);
    // Global default scope: dependent on globally, this dependency off globally.
    const depOnGlobal = dep ? dep.status !== 'off' : true;
    if (depOnGlobal && next.status === 'off') out.push({ dependentId, tenantId: null });
    // Per-tenant scopes: only tenants overridden on EITHER side can diverge from
    // the global pair above. For each, resolve both sides and flag an orphan.
    const tenants = new Set<string>([
      ...Object.keys(next.tenantOverrides ?? {}),
      ...Object.keys(dep?.tenantOverrides ?? {}),
    ]);
    for (const t of tenants) {
      const depOnT = dep ? statusForTenant(dep, t) !== 'off' : true;
      const nextOffT = statusForTenant(next, t) === 'off';
      if (depOnT && nextOffT) out.push({ dependentId, tenantId: t });
    }
  }
  return out;
}

/** One feature's row in the admin Plugins-console projection (ADR 0194 Phase 2):
 *  dependency graph + live disable-lock + declared packs with on-disk presence.
 *  Projected from the boot registries + effective toggle state + the pack dir —
 *  NOT a stored model (no second catalog to drift). */
export interface FeatureConsoleEntry {
  id: string;
  /** Ids this feature depends on (as declared). */
  dependsOn: string[];
  /** Ids that depend on this feature. */
  dependents: string[];
  /** The subset of `dependents` that is enabled in ANY scope (global or a tenant
   *  override) — turning this feature OFF is locked while this is non-empty
   *  (ADR 0194 Phase 5: conservative so the global Off pre-gate catches per-tenant
   *  orphans too; the route enforces the precise per-scope check). */
  blockedByDependents: string[];
  /** Soft dependencies (ADR 0194 Phase 5): ids this feature works better with but
   *  does not require. Advisory — the console shows them as a suggestion, never a
   *  lock. `recommendedOff` is the subset currently disabled (the actionable ones). */
  recommends: string[];
  recommendedOff: string[];
  /** The feature's pinned packs + presence tier (`registryInstaller.packPresence`).
   *  `onDiskVersion` is set ONLY when a pack is present at a version other than the
   *  pinned one — so the UI never claims the pinned version is installed. */
  packs: { name: string; version: string; status: 'installed' | 'mounted' | 'missing' | 'tombstoned'; onDiskVersion?: string }[];
}

/** Build the Plugins-console projection over the toggle-able feature set: the
 *  dependency graph annotated with the live disable-lock, plus each feature's
 *  declared packs with on-disk presence. One computation the admin panel reads to
 *  gate the Off control, render "required by …", and badge pack status. */
export async function buildFeatureConsole(): Promise<FeatureConsoleEntry[]> {
  const configs = await listEffectiveConfigs();
  const byId = new Map(configs.map((c) => [c.id, c]));
  // Enabled-anywhere (global OR any tenant override); a feature absent from the map
  // is always-on substrate ⇒ enabled everywhere.
  const enabledAnywhere = (id: string): boolean => (byId.has(id) ? isEnabledAnywhere(byId.get(id)!) : true);
  return configs.map((c) => {
    const dependents = getFeatureDependents(c.id);
    const blockedByDependents = dependents.filter((d) => enabledAnywhere(d));
    const recommends = getFeatureRecommends(c.id);
    // Actionable suggestions = recommended features that exist and are fully off.
    const recommendedOff = recommends.filter((r) => byId.has(r) && !isEnabledAnywhere(byId.get(r)!));
    const packs = getFeaturePacks(c.id).map((p) => {
      const presence = packPresence(p.name);
      return {
        ...p,
        status: presence.status,
        ...(presence.version && presence.version !== p.version ? { onDiskVersion: presence.version } : {}),
      };
    });
    return { id: c.id, dependsOn: getFeatureDependencies(c.id), dependents, blockedByDependents, recommends, recommendedOff, packs };
  });
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
