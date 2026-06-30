/**
 * Shareable-KB registry (ADR 0100 — the inversion seam for the board "Shared
 * knowledge" affordance, decision D2).
 *
 * A feature that owns a KB shareable with a Board of Advisors registers a PROVIDER
 * at boot; the advisory-board feature iterates this registry to resolve/ensure the
 * collection ids to bind to its advisors. So the board NEVER imports the KB-owning
 * features' internals — the dependency points the right way (feature → core seam),
 * and adding a new shareable-KB kind is purely additive (register a provider; the
 * board picks it up automatically). Mirrors `registerToolResultTransform` /
 * `registerRunStartContributor`: core holds the registry, features register into it.
 *
 * @see docs/adr/0100-planning-knowledge-base.md (D2)
 */

export interface ShareableKbProvider {
  /** Kind id — matches the FE `sharedKind_<kind>` i18n + the board chip label. */
  kind: string;
  /**
   * The KB collection ids for an org that should be bound to advisors for this
   * kind. `forUnshare:true` MAY return a SUPERSET — collections that should be
   * UNBOUND even if no longer shareable (e.g. a project that went `private` after
   * being shared) — so unshare fully cleans up. The share/status path passes no
   * opts and applies the kind's normal visibility carve-out.
   */
  resolveCollectionIds(tenantId: string, orgId: string, opts?: { forUnshare?: boolean }): Promise<string[]>;
  /**
   * Ensure shareable collections EXIST before binding (a MANAGED KB pre-creates +
   * backfills its org's existing items so a board can pre-share an empty KB).
   * Returns the ids to bind. Omit when the collections already exist (e.g. the
   * user-curated project KBs) — the registry falls back to `resolveCollectionIds`.
   */
  ensureCollectionIds?(tenantId: string, orgId: string, actor: string): Promise<string[]>;
}

const providers = new Map<string, ShareableKbProvider>();

/** Register a shareable-KB provider (idempotent per kind; call at boot). */
export function registerShareableKb(provider: ShareableKbProvider): void {
  providers.set(provider.kind, provider);
}

/** The registered kinds (registration order). */
export function shareableKbKinds(): string[] {
  return [...providers.keys()];
}

export function getShareableKbProvider(kind: string): ShareableKbProvider | undefined {
  return providers.get(kind);
}

/** Test-only: clear the registry. */
export function __resetShareableKb(): void {
  providers.clear();
}
