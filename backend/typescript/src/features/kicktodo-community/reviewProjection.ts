/**
 * Challenge-review → content-kernel projection (ADR 0465). A VISIBLE, proof-gated
 * review is public content — exactly the kernel's shape — so it rides the ONE
 * public-read gate (published + publicRead + !neverPublic) as a `kicktodo.review`
 * system-type entity.
 *
 * CRITICAL — reviewer anonymity (the privacy divergence from ADR 0453). Unlike a
 * creator profile — whose OPAQUE subject IS the public identity, so
 * `creatorProfileProjection` keys the entity by `creatorSubject` — a review is
 * meant to be publicly ANONYMOUS (`visibleReviews` drops the reviewer entirely).
 * Keying a `publicRead` review entity by anything subject-derived would leak the
 * opaque subject into the public URL, enabling who-reviewed-what enumeration and
 * cross-challenge correlation of a single reviewer (a real PII/consent leak — ADR
 * 0426). So the kernel entity is keyed by a RANDOM, per-review, non-subject-derived
 * id (`reviewEntityId`, minted on the write-model) and carries `rating`/`body`/
 * `provenance`/`challenge_id` ONLY — NEVER `reviewerSubject` as an entity id OR a
 * value.
 *
 * Boundary: the review write-model + proof-gating + moderation stay in
 * `communityService` (KickTodo policy the kernel has no opinion on). This module
 * owns only the published PROJECTION, kept in sync on every state change.
 * Best-effort: a projection failure must never fail the review write/flag/erase.
 */

import { mintSystemType, updateEntityType, putSystemEntity, deleteSystemEntity } from '../entities/entitiesService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('kicktodo.review-projection');

export const REVIEW_TYPE = 'kicktodo.review';

/** Scalars mirrored to the kernel — the intended-public review content ONLY.
 *  There is deliberately no reviewer field: reviews are publicly anonymous. */
const REVIEW_SCALARS = [
  { key: 'rating', label: 'Rating', type: 'number', required: true },
  { key: 'body', label: 'Body', type: 'string', required: false },
  { key: 'provenance', label: 'Provenance', type: 'string', required: true },
  { key: 'challenge_id', label: 'Challenge', type: 'string', required: true },
];

/** Idempotent: mint the type + flip its `publicRead` opt-in (visible reviews are
 *  public). `mintSystemType` reconciles on re-mint; `publicRead` is the one
 *  operator-mutable flag on a system type. */
export async function ensureReviewType(tenantId: string): Promise<void> {
  await mintSystemType({
    tenantId, name: REVIEW_TYPE, displayName: 'Challenge review',
    fields: REVIEW_SCALARS, actor: 'system:kicktodo-community',
  });
  await updateEntityType({ tenantId, name: REVIEW_TYPE, patch: { publicRead: true }, actor: 'system:kicktodo-community' });
}

interface ProjectableReview {
  tenantId: string;
  /** The random, non-subject-derived kernel entity id (the SoT mapping). Absent on
   *  a legacy row that predates ADR 0465 P1 → skip (defensive; a reconcile mints one). */
  reviewEntityId?: string;
  challengeId: string;
  rating: number;
  body?: string;
  provenance: 'entitlement' | 'completed-enrollment';
  state: 'visible' | 'flagged' | 'removed';
}

/**
 * Sync the kernel projection to a review's current state: publish (status `live`
 * + publicRead) when VISIBLE, else remove it. Keyed by the RANDOM `reviewEntityId`
 * (NEVER the reviewer subject — the privacy invariant), so the public URL is
 * unlinkable to the reviewer or across their reviews. Best-effort (a projection
 * failure must never fail the review write/flag/erase itself).
 *
 * This IS the write-model→projection RECONCILE primitive: idempotent, derived
 * purely from the review's current state, so a boot sweep re-heals any divergence
 * a swallowed failure below left behind.
 *
 * As in ADR 0453: a swallowed failure on the UN-PUBLISH direction is the dangerous
 * one — it can leave a flagged/removed/erased review still publicly readable (a
 * visibility/consent divergence), whereas a failed publish only WITHHOLDS a public
 * row. So the two directions log at different severities.
 */
export async function syncReviewProjection(r: ProjectableReview): Promise<void> {
  // Defensive: a legacy row without the random id has no stable projection key —
  // skip (a reconcile/re-put mints one, then this publishes it).
  if (!r.reviewEntityId) return;
  const publishing = r.state === 'visible';
  try {
    if (publishing) {
      await ensureReviewType(r.tenantId);
      await putSystemEntity({
        tenantId: r.tenantId,
        typeName: REVIEW_TYPE,
        entityId: r.reviewEntityId,
        values: {
          rating: r.rating,
          ...(r.body ? { body: r.body } : {}),
          provenance: r.provenance,
          challenge_id: r.challengeId,
        },
        status: 'live',
        actor: 'system:kicktodo-community',
      });
    } else {
      // Not visible → pull the projection down (no-op when it was never published,
      // incl. a tenant whose type was never minted — swallowed as best-effort).
      await deleteSystemEntity({ tenantId: r.tenantId, typeName: REVIEW_TYPE, entityId: r.reviewEntityId });
    }
  } catch (err) {
    const detail = { challengeId: r.challengeId, state: r.state, error: err instanceof Error ? err.message : String(err) };
    if (publishing) {
      log.warn('kicktodo_review_projection_publish_failed', detail); // withholds a public row — benign
    } else {
      // The projection may still be LIVE while the review is non-public — surface
      // it loudly so a reconcile (re-running this sync) closes the divergence.
      log.error('kicktodo_review_projection_unpublish_failed_may_stay_public', detail);
    }
  }
}
