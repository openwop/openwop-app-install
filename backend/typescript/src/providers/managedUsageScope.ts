/**
 * ADR 0693 — WHERE the managed free tier's usage is charged.
 *
 * The tier meters on `tenantId` alone (`storage.ts:895`). That was exactly right
 * while every tenant held one person. ADR 0684 auto-joins participants into a
 * SHARED workspace and makes it their active tenant, so on a participant-facing
 * deployment one daily token allowance is now split across the whole population
 * and the first few active users exhaust it for everyone.
 *
 * This module is the ONE place that decides which bucket a charge lands in, and
 * the one place that composes a bucket key. ADR 0693 section 2 says a second
 * composer is the thing to refuse in review — the reason is that these keys ride
 * in the `tenantId` PARAMETER, and an overloaded field with two authors is how
 * this repo got the commerce-refund incident (`provider:'none'` meaning two
 * things, with a predicate over it permanently guessing).
 */
import { createHash } from 'node:crypto';
import { isSinglePrincipalTenant } from '../host/accessControlService.js';

/** The operator's cross-tenant ceiling. Pre-existing; re-exported here so the
 *  whole reserved namespace is visible in one file. */
export const GLOBAL_USAGE_BUCKET = 'managed:global';

/** Reserved prefix for every non-tenant bucket. No real tenant can collide: the
 *  live shapes are `anon:`, `user:`, `ws:`, `host-*` and `default`. */
const RESERVED_PREFIX = 'managed:';

/**
 * The bucket a charge for `(tenantId, subject)` belongs to.
 *
 * - single-principal tenant (`user:`/`anon:`/`default`) goes to the tenant
 *   itself. Its row is already per-subject by construction; re-keying it would
 *   be churn with a migration attached, and would drag every personal tenant
 *   into the ADR 0464 erasure surface for no benefit (section 4).
 * - multi-principal tenant WITH an acting subject goes to a per-subject bucket.
 * - multi-principal tenant WITHOUT one goes to the tenant. An absent subject is
 *   a PERMANENT legal state, not a gap to close: `chat-widget/publicGateway` is
 *   anonymous by design (ADR 0693 Open question 1). Falling back to the tenant
 *   is the correct scope there, and is fail-safe: the worst case is exactly
 *   today's behaviour.
 *
 * The subject is HASHED, never embedded raw. Per section 4 these rows become
 * subject-linked personal data the moment they exist, and a pseudonymous key is
 * the difference between a satisfiable DSAR obligation and a log of who asked
 * what, when.
 */
export function managedUsageBucket(tenantId: string, subject?: string): string {
  if (isSinglePrincipalTenant(tenantId)) return tenantId;
  if (!subject) return tenantId;
  const h = createHash('sha256').update(`${tenantId} ${subject}`).digest('hex').slice(0, 32);
  // THE TENANT RIDES IN THE KEY, IN CLEAR, AND THE SUBJECT DOES NOT.
  //
  // ADR 0284 tenant teardown (`deleteAllTenantData`) introspects every table
  // carrying a `tenant_id` column and deletes by EXACT match. These bucket ids
  // ride in that column. Without the tenant segment, tearing down a workspace
  // deleted the rows literally keyed to it and left every participant's row
  // behind — under a one-way hash nobody can enumerate, on a store §4 calls
  // subject-linked personal data. I bought DSAR-by-subject (re-derivable from
  // the subject) and paid for it in teardown-by-tenant, without noticing.
  //
  // WHY THIS COSTS NOTHING IN PSEUDONYMITY, which is the part to check rather
  // than assume. §4 requires that the SUBJECT not be recoverable from the
  // bucket. A workspace id is not personal data — it is in the URL of every
  // request that touches that workspace. The prefix reveals which workspace an
  // unreadable token count belongs to, which is exactly what teardown needs and
  // nothing more. The hash still protects the person.
  //
  // Chosen over denormalising an `owner_tenant_id` COLUMN onto both usage
  // tables (the `a2aTaskStore` precedent — "denormalized so tenant teardown can
  // REACH this row"). That also works and costs a contiguous migration in both
  // adapters. This costs a composer change, and the composer is already the one
  // place §2 allows a bucket to be built.
  return `${RESERVED_PREFIX}sub:${tenantId}:${h}`;
}

/**
 * The exact-match id and the LIKE pattern that together cover every usage row a
 * tenant owns — its own, and its participants' per-subject buckets.
 *
 * Returned as a pair rather than built at the call site so teardown cannot
 * accidentally cover one and miss the other, which is the failure this whole
 * change exists to fix.
 *
 * ESCAPING IS NOT OPTIONAL HERE. `_` and `%` are LIKE wildcards, and a tenant id
 * containing either would match wider than intended — on a DELETE. No live
 * tenant shape can contain them (`anon:`, `user:`, `ws:`, `host-*`, `default`),
 * so this is defence against a tenant id minted from user input in future, not
 * against today's data. A guarantee that rests on "no current caller does that"
 * is the kind this repo has had to re-learn; a DELETE is the wrong place to
 * learn it again.
 */
export function usageBucketMatchersForTenant(tenantId: string): {
  exact: string;
  likePattern: string;
  likeEscape: string;
} {
  const escaped = tenantId.replace(/([\\%_])/g, '\\$1');
  return {
    exact: tenantId,
    likePattern: `${RESERVED_PREFIX}sub:${escaped}:%`,
    likeEscape: '\\',
  };
}

/** True iff `id` is a reserved bucket rather than a real tenant. Lets a sweep or
 *  an erasure tell "operator accounting" from "a tenant's row". */
export function isReservedUsageBucket(id: string): boolean {
  return id.startsWith(RESERVED_PREFIX);
}

/**
 * Every per-subject bucket this subject owns across the tenants it belongs to.
 *
 * ADR 0693 section 4 — the erasure hook must NAME the keys it removes, and the
 * hash is one-way, so they are RE-DERIVED from the subject rather than
 * discovered by scanning. That is deliberate: a scan of the usage collection to
 * find a subject's rows would be the unbounded read ADR 0684 section 6 forbids,
 * on a path a DSAR can trigger.
 */
export function managedUsageBucketsForSubject(
  subject: string,
  tenantIds: readonly string[],
): readonly string[] {
  return tenantIds
    .filter((t) => !isSinglePrincipalTenant(t))
    .map((t) => managedUsageBucket(t, subject))
    .filter((b) => isReservedUsageBucket(b));
}
