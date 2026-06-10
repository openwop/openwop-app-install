/**
 * Feature-toggle + multivariant types (host-extension, NON-NORMATIVE).
 *
 * Models the myndhyve ON/OFF/BETA toggle plus weighted multivariant
 * traffic-splitting. See docs/adr/0001-feature-first-package-architecture.md
 * §3. This surface is a vendor host-extension — it never touches the OpenWOP
 * wire contract (no run-event field, no /.well-known/openwop entry).
 */

/** A toggle's coarse state. `on` == 100% of eligible traffic. */
export type FeatureToggleStatus = 'on' | 'off' | 'beta';

/** Which stable id a sticky variant assignment hashes on (ADR §3.3). */
export type BucketUnit = 'user' | 'tenant';

/** A bindable behavior selected by a variant. The candidate set is declared by
 *  the owning FeatureManifest; the admin UI wires the choice dynamically. */
export interface VariantBinding {
  /** Logical slot, e.g. `crm.triageAgent`. */
  slot: string;
  ref: {
    kind: 'agent' | 'node' | 'prompt';
    /** Pack-namespaced ref name, e.g. `feature.crm.agents/triage-v2`. */
    name: string;
    /** Pinned version so a run stamp stays deterministic (ADR §3.5). */
    version: string;
  };
}

/** One weighted variant of a multivariant toggle. */
export interface Variant {
  /** Variant key, e.g. `A` / `B` / `control`. */
  key: string;
  /** Integer weight; all weights in a toggle MUST sum to exactly 100. */
  weight: number;
  /** Admin-administered bindings active for this variant (ADR §3.5). */
  bindings?: VariantBinding[];
}

/** A per-tenant override of the global default (ADR §3.1: per-tenant-overridable
 *  global). Only the fields present override; the rest fall back to the global. */
export interface ToggleOverride {
  status?: FeatureToggleStatus;
  variants?: Variant[];
}

/** The full configuration for one toggle. Global default + optional per-tenant
 *  overrides. Stored in host_ext_kv; seeded from feature defaults. */
export interface ToggleConfig {
  id: string;
  label?: string;
  description?: string;
  category?: string;
  /** Global default state. */
  status: FeatureToggleStatus;
  /** Randomization unit for sticky bucketing (default `user`). */
  bucketUnit: BucketUnit;
  /** Per-toggle salt — decorrelates experiments / kills carryover bias. */
  salt: string;
  /** Weighted variants. Absent/empty ⇒ a plain on/off toggle (single 100%). */
  variants?: Variant[];
  /** When `status:'beta'`, the eligible cohort: tenant ids and/or user ids.
   *  Empty/absent ⇒ nobody is eligible (fail-closed). */
  betaCohort?: string[];
  /** Per-tenant overrides of the global default. */
  tenantOverrides?: Record<string, ToggleOverride>;
  updatedAt?: string;
  updatedBy?: string;
}

/** The subject a toggle is resolved against — the authenticated caller. */
export interface ToggleSubject {
  /** Tenant id (req.tenantId). In this app each visitor has its own tenant. */
  tenantId: string;
  /** Stable per-principal id (req.principal.principalId). Falls back to
   *  tenantId for `user` bucketing when absent. */
  userId?: string;
  tier?: 'anon' | 'user';
}

/** The resolved view of a toggle for one subject — what the FE/BE consume. */
export interface ResolvedAssignment {
  id: string;
  status: FeatureToggleStatus;
  /** True when the feature is active for this subject (on, or beta+eligible). */
  enabled: boolean;
  /** Assigned variant key, or null when the toggle has no variants / is off. */
  variant: string | null;
  /** Resolved bindings for the assigned variant (for run-stamping, ADR §3.5). */
  bindings?: VariantBinding[];
}
