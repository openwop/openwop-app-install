/**
 * Marketplace reviews/ratings store (ADR 0022 Phase 3) — the ONLY new persistence
 * this feature owns. A `Review` is keyed by `(tenantId, orgId, reviewId)` and is
 * one-per-(org, pack, author): a second review by the same author for the same
 * pack UPDATES the existing one (no duplicate ratings inflating the aggregate).
 * Aggregate rating is computed on read, never stored (no denormalized drift).
 *
 * Tenant+org isolation (CTI-1): every read/write filters by (tenantId, orgId); a
 * cross-tenant or cross-org id simply isn't found. The route layer additionally
 * RBAC-gates read=`workspace:read` / write=`workspace:write`.
 *
 * @see docs/adr/0022-marketplace.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';

export interface Review {
  reviewId: string;
  tenantId: string;
  orgId: string;
  packName: string;
  rating: number; // 1..5 integer
  body?: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

/** Aggregate over a pack's reviews in one (tenant, org) — computed on read. */
export interface RatingSummary {
  packName: string;
  count: number;
  /** Mean rating rounded to one decimal, or null when there are no reviews. */
  average: number | null;
}

const MAX = { body: 4000 } as const;

const store = new DurableCollection<Review>('marketplace:review', (r) => r.reviewId);

/** Coerce + validate a 1..5 integer rating; throws the canonical envelope. */
function requireRating(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new OpenwopError('validation_error', 'Field `rating` is required and MUST be an integer in [1, 5].', 400, { field: 'rating' });
  }
  return value;
}

/** All reviews for one pack in one (tenant, org), newest first. */
export async function listReviews(tenantId: string, orgId: string, packName: string): Promise<Review[]> {
  const all = await store.list();
  return all
    .filter((r) => r.tenantId === tenantId && r.orgId === orgId && r.packName === packName)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Compute the aggregate rating for one pack in one (tenant, org). */
export async function ratingSummary(tenantId: string, orgId: string, packName: string): Promise<RatingSummary> {
  const reviews = await listReviews(tenantId, orgId, packName);
  if (reviews.length === 0) return { packName, count: 0, average: null };
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  return { packName, count: reviews.length, average: Math.round((sum / reviews.length) * 10) / 10 };
}

/**
 * Upsert the caller's review for a pack — ONE review per (tenant, org, pack,
 * author). A repeat submission updates the existing review (preserving its
 * reviewId + createdAt) rather than appending a duplicate that would skew the
 * aggregate. Idempotent-by-author, so a fork/replay never double-counts.
 */
export async function upsertReview(input: {
  tenantId: string;
  orgId: string;
  packName: string;
  rating: unknown;
  body?: unknown;
  authorId: string;
}): Promise<Review> {
  const rating = requireRating(input.rating);
  const body = cleanString(input.body, MAX.body) || undefined;
  const now = new Date().toISOString();

  const existing = (await store.list()).find(
    (r) => r.tenantId === input.tenantId && r.orgId === input.orgId && r.packName === input.packName && r.authorId === input.authorId,
  );

  if (existing) {
    const next: Review = { ...existing, rating, updatedAt: now };
    if (body !== undefined) next.body = body;
    else delete next.body;
    await store.put(next);
    return next;
  }

  const review: Review = {
    reviewId: `mkt-rev:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    packName: input.packName,
    rating,
    ...(body !== undefined ? { body } : {}),
    authorId: input.authorId,
    createdAt: now,
    updatedAt: now,
  };
  await store.put(review);
  return review;
}

/**
 * Delete a review. Tenant+org+author guarded (IDOR): the review is removed only
 * when it belongs to (tenantId, orgId) AND was authored by `authorId` OR the
 * caller `isAdmin`. Returns false (→ 404) when not found in scope.
 */
export async function deleteReview(
  tenantId: string,
  orgId: string,
  reviewId: string,
  actor: { authorId: string; isAdmin: boolean },
): Promise<boolean> {
  const review = await store.get(reviewId);
  if (!review || review.tenantId !== tenantId || review.orgId !== orgId) return false;
  if (review.authorId !== actor.authorId && !actor.isAdmin) {
    throw new OpenwopError('forbidden', 'Only the review author or an org admin may delete this review.', 403, { reviewId });
  }
  return store.delete(reviewId);
}

/** Test-only: clear all reviews. */
export async function __resetMarketplaceReviews(): Promise<void> {
  await store.__clear();
}
