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

/**
 * ADR 0608 D5 (`CPC-3`) — a reconciler that runs when a SOURCE feature changes
 * something that alters which collections a kind resolves to (today: a project
 * flipping `org` <-> `private`).
 *
 * The visibility carve-out in `resolveCollectionIds` was applied at SHARE TIME
 * ONLY. Nothing re-ran it, so flipping a shared project to `private` left every
 * advisor still bound to its collection — retrieving the now-private corpus on
 * every turn, for any user who can chat with that agent — while the board's
 * shared-knowledge panel reported `shared:true, exists:false, count:0`. The
 * unbind machinery already existed (`forUnshare`); only the trigger was missing.
 *
 * The dependency still points the right way: the SOURCE feature announces "my
 * shareable set changed for this (org, kind)" through this core seam, and the
 * CONSUMER (advisory-board) registers the reconciliation. Projects never imports
 * advisory-board.
 */
export type ShareableKbReconciler = (tenantId: string, orgId: string, kind: string) => Promise<void>;

const reconcilers: ShareableKbReconciler[] = [];

/** Register a reconciler (call at boot). */
export function registerShareableKbReconciler(fn: ShareableKbReconciler): void {
  reconcilers.push(fn);
}

/**
 * Announce that `kind`'s shareable set may have changed for `orgId`. FAULT-ISOLATED
 * and best-effort by design: a reconcile failure must never fail the source
 * feature's own write (a visibility flip must land even if a board is unreachable),
 * and both bind and unbind are idempotent so the next trigger re-converges. The
 * caller MUST persist its change BEFORE calling — the reconciler re-resolves
 * through the provider and would otherwise see the pre-change state.
 */
export async function notifyShareableKbSourceChanged(tenantId: string, orgId: string, kind: string): Promise<void> {
  for (const fn of reconcilers) {
    try { await fn(tenantId, orgId, kind); } catch { /* best-effort; re-converges on the next trigger */ }
  }
}

