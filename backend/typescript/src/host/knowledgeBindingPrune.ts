/**
 * The ONE rule for pruning a knowledge binding on a READ path.
 *
 * Three features self-heal a dangling KB binding the same way: resolve the bound
 * `collectionId[]` against `listAllTenantCollections(tenantId)`, treat a miss as
 * DELETED, and rewrite the binding without it. That is a **durable write on a
 * GET**, and the inference it rests on — "not in the listing" ⇒ "deleted" — is
 * only sound when the listing is authoritative.
 *
 * It often is not. `listAllTenantCollections` reads `listForTenant`, a secondary
 * INDEX scan whose own contract admits a silent short answer: *"the worst case is
 * a missing marker (the row is simply not enumerated this pass)"*
 * (`hostExtPersistence.ts`), and the prefix-scan primitive below it **skips any
 * row whose decode fails** without throwing. So one corrupt or schema-drifted
 * index row is enough to produce a listing that is short — or empty — and looks
 * exactly like a successful read of a tenant that deleted everything. The prune
 * then fires and the whole binding is overwritten with `[]`: the read returns 200
 * with an empty knowledge panel, and the user's documents are unbound for good.
 *
 * `TWIN-UX-10` (ADR 0589) hardened `profile-memory` against this and named the
 * harm. `ADR 0603 R1 H1` found the two siblings still open — `agent-knowledge`
 * (`getAgentKnowledge`) and `projects` (`getProjectKnowledge`, which is what backs
 * a **notebook's** bound collections) — and moved the rule here rather than
 * hand-copying it a third time.
 *
 * The generalisation, from the ADR 0042 ruling: **any prune-on-read that infers
 * deletion from a scoped lookup is a landmine.** "Not visible from here" is
 * indistinguishable from "gone". Which is also why the cure is this guard and
 * **never a widening of the lookup's scope** — widening the candidate set alone
 * turns the same self-heal into a data-loss machine (bind a collection, read from
 * a scope that cannot see it, binding destroyed).
 *
 * NOT a guard on the WRITE layer. Length-gating the merge in
 * `agentProfileService.setAgentKnowledge` / `subjectKnowledge.setSubjectKnowledge`
 * was considered and REJECTED: `unbindCollection` legitimately writes `[]` when
 * the last collection is removed, so a blanket length gate would make that a
 * silent no-op — trading a destructive write for a success-with-empty lie one
 * layer up. The read path is where the *inference* is made, so the read path is
 * where it is checked.
 */

/** Inputs to the prune decision. All counts are of the SAME read. */
export interface KnowledgeBindingPruneInput {
  /** The ids currently stored on the binding. */
  readonly boundIds: readonly string[];
  /** How many rows the tenant-wide collection listing returned. */
  readonly listingSize: number;
  /** The subset of `boundIds` that resolved against that listing. */
  readonly liveIds: readonly string[];
  /**
   * `false` when the listing did not resolve at all (it threw, and the caller
   * chose to degrade rather than propagate). A caller that lets the throw
   * propagate never reaches here, so it may omit this.
   */
  readonly authoritative?: boolean;
}

/**
 * `true` only when the listing can be trusted to prove a deletion.
 *
 * Refuses in two cases, both resolved in the NON-DESTRUCTIVE direction — an
 * unpruned dangling binding is inert and recoverable; an unbound document set is
 * not:
 *
 *  - the listing did not resolve (`authoritative === false`);
 *  - the listing came back EMPTY while the binding is non-empty
 *    (`listingLooksWiped`). This is the catastrophic case and it is
 *    indistinguishable from "every collection really was deleted", so a tenant
 *    that genuinely deleted all of its collections keeps a stale binding list
 *    until one collection exists again. That is a cosmetic cost.
 *
 * It does NOT claim to catch a PARTIAL short listing (2 of 3 rows enumerated
 * while all 3 are bound) — nothing available on this path can distinguish that
 * from two genuine deletions without a per-id lookup the binding has no `orgId`
 * for. Stated so the limit is inherited rather than rediscovered.
 */
export function mayPruneKnowledgeBinding(input: KnowledgeBindingPruneInput): boolean {
  if (input.authoritative === false) return false;
  const listingLooksWiped = input.boundIds.length > 0 && input.listingSize === 0;
  if (listingLooksWiped) return false;
  return input.liveIds.length < input.boundIds.length;
}
