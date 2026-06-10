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
import { assignVariant } from './bucketing.js';
import { getToggleDefault, listToggleDefaults } from './registry.js';
import type { ResolvedAssignment, ToggleConfig, ToggleSubject } from './types.js';

/** Durable store of admin-saved toggle configs, keyed by toggle id. */
const store = new DurableCollection<ToggleConfig>('feature-toggle', (c) => c.id);

/** The effective config for one toggle: stored override, else feature default. */
export async function getEffectiveConfig(id: string): Promise<ToggleConfig | null> {
  const stored = await store.get(id);
  if (stored) return stored;
  return getToggleDefault(id);
}

/**
 * Every effective config: the union of declared defaults and stored overrides,
 * with stored winning per id. Sorted by id for a stable admin-screen order.
 */
export async function listEffectiveConfigs(): Promise<ToggleConfig[]> {
  const byId = new Map<string, ToggleConfig>();
  for (const d of listToggleDefaults()) byId.set(d.id, d);
  for (const s of await store.list()) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Persist an admin-saved config (upsert). Caller validates first. */
export async function saveConfig(config: ToggleConfig, savedBy: string): Promise<ToggleConfig> {
  const next: ToggleConfig = { ...config, updatedAt: new Date().toISOString(), updatedBy: savedBy };
  await store.put(next);
  return next;
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
