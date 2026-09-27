/**
 * Per-tenant pack visibility seam (ADR 0194 Phase 3 / ADR 0022 alt. 4).
 *
 * A tenant (workspace) can curate which INSTALLED packs are available to its
 * AUTHORING surfaces — the builder palette (`GET /node-catalog`), new workflow
 * registration, and the AI workflow-author's closed-world catalog. This is
 * availability curation, NOT runtime deactivation: existing definitions, runs,
 * replay, and `:fork` never consult it (pack presence stays decoupled from any
 * gate, the ARCHITECTURE.md replay invariant).
 *
 * Inversion seam (the `setSubjectOrgResolver` pattern): the owning feature
 * (marketplace) registers the resolver at module load; core consults it without
 * importing the feature. Unregistered ⇒ EMPTY set — nothing is hidden by
 * default, because enablement is curation, not a security gate (feature toggles
 * + RBAC remain the behavior authority).
 */

export type DisabledPacksResolver = (tenantId: string) => Promise<Set<string>>;

let resolver: DisabledPacksResolver | null = null;

/** Register (or replace) the resolver. The marketplace feature owns the store. */
export function setDisabledPacksResolver(fn: DisabledPacksResolver): void {
  resolver = fn;
}

/** Pack names the tenant has disabled for authoring surfaces (empty when no
 *  resolver is registered, or on resolver failure — curation must never take
 *  down the catalog). */
export async function resolveDisabledPacks(tenantId: string): Promise<Set<string>> {
  if (!resolver) return new Set();
  try {
    return await resolver(tenantId);
  } catch {
    return new Set(); // fail-open to "nothing hidden" — availability, not authz
  }
}

/** Test-only: drop the registered resolver. */
export function __resetDisabledPacksResolver(): void {
  resolver = null;
}
