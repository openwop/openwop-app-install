/**
 * kicktodo-community (ADR 0426) — creator profiles, proof-gated challenge
 * reviews, counts-only creator analytics.
 *
 * TRUST RULES: a profile is publicly visible only after a `community-profile`
 * approval COMPLETED BY A DIFFERENT IDENTITY (the KT-R1 separation-of-duties
 * rule); a review exists only with PROOF (a live entitlement or a completed
 * enrollment for that challenge version) and there is ONE review per buyer by
 * construction (deterministic key; edits overwrite); visible reviews project
 * NO reviewer PII — rating, body, provenance label only. Handles are claimed
 * atomically (CAS on a lowercase index row — no TOCTOU).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { createLogger } from '../../observability/logger.js';
import { createCommunityApproval, getApproval } from '../../host/approvalService.js';
import { getEntitlement } from '../kicktodo-commerce/entitlementService.js';
import { listEnrollmentsFor } from '../kicktodo-core/enrollmentService.js';
import { progressFor } from '../kicktodo-core/progressService.js';
import { getChallenge } from '../kicktodo-core/challengeService.js';
import { syncCreatorProfileProjection, CREATOR_PROFILE_TYPE } from './creatorProfileProjection.js';
import { syncReviewProjection, REVIEW_TYPE } from './reviewProjection.js';
import { readPublicEntity, resolveEntityPublicLocale } from '../entities/publicRead.js';
import { deleteSystemEntity } from '../entities/entitiesService.js';

const log = createLogger('kicktodo.community');

export type ProfileState = 'draft' | 'pending' | 'approved' | 'suspended';

export interface CreatorProfile {
  tenantId: string;
  creatorSubject: string;
  handle: string;
  displayName: string;
  bio: string;
  links: string[];
  /** ADR 0453 P2 — sparse per-locale overlays for the localizable public fields.
   *  BCP-47 key → { displayName?, bio? }. The base fields above stay the fallback. */
  localizations?: Record<string, { displayName?: string; bio?: string }>;
  state: ProfileState;
  approvalId?: string;
  createdAt: string;
  updatedAt: string;
}

const profiles = new DurableCollection<CreatorProfile>(
  'kicktodo-creator-profiles',
  (p) => `${p.tenantId}::${p.creatorSubject}`,
);

/** Atomic handle claims — CAS on `${tenant}::${handleLower}` kills the TOCTOU. */
const handleIndex = new DurableCollection<{ tenantId: string; handleLower: string; creatorSubject: string }>(
  'kicktodo-handle-index',
  (h) => `${h.tenantId}::${h.handleLower}`,
);

export type ReviewState = 'visible' | 'flagged' | 'removed';

export interface ChallengeReview {
  tenantId: string;
  challengeId: string;
  challengeVersion: number;
  reviewerSubject: string;
  rating: number;
  body?: string;
  state: ReviewState;
  provenance: 'entitlement' | 'completed-enrollment';
  /** ADR 0465 P1 — the RANDOM, non-subject-derived id of this review's public
   *  content-kernel entity (`kicktodo.review`). The SoT for the review→kernel-entity
   *  mapping; NEVER derived from `reviewerSubject` (that would leak the reviewer's
   *  opaque subject into the public URL — the ADR 0465 privacy invariant). Migration-
   *  free: a legacy row without it gets one minted on the next reconcile/re-put. */
  reviewEntityId?: string;
  flagApprovalId?: string;
  createdAt: string;
  updatedAt: string;
}

const reviews = new DurableCollection<ChallengeReview>(
  'kicktodo-challenge-reviews',
  (r) => `${r.tenantId}::${r.challengeId}::${r.reviewerSubject}`,
);

const nowIso = (): string => new Date().toISOString();

export class HandleTakenError extends Error {
  constructor(handle: string) {
    super(`The handle \`${handle}\` is already taken.`);
  }
}
export class ProfileInvalidError extends Error {}
export class ReviewProofError extends Error {
  constructor() {
    super('Reviews require a purchase or a completed enrollment for this challenge.');
  }
}
export class NotFoundError extends Error {
  constructor() {
    super('Not found.');
  }
}
export class SeparationOfDutiesError extends Error {
  constructor() {
    super('A different identity must resolve this approval.');
  }
}

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;

function validateLinks(links: unknown): string[] {
  if (links === undefined) return [];
  if (!Array.isArray(links) || links.length > 5) throw new ProfileInvalidError('Up to 5 links.');
  return links.map((l) => {
    if (typeof l !== 'string' || !/^https?:\/\//.test(l) || l.length > 300) {
      throw new ProfileInvalidError('Links must be http(s) URLs.');
    }
    return l;
  });
}

const LOCALE_KEY_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** ADR 0453 P2 — per-locale overlays for `displayName`/`bio` (the localizable
 *  public fields). Sparse: only the fields a creator translated; the base values
 *  stay the fallback. Same bounds as the base fields. Up to 10 locales. Returns
 *  undefined when empty so no `{}` is persisted. */
function validateProfileLocalizations(raw: unknown): Record<string, { displayName?: string; bio?: string }> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileInvalidError('localizations must be an object of locale → overlay.');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 10) throw new ProfileInvalidError('Up to 10 locale overlays.');
  const out: Record<string, { displayName?: string; bio?: string }> = {};
  for (const [locale, overlay] of entries) {
    if (!LOCALE_KEY_RE.test(locale)) throw new ProfileInvalidError(`Invalid overlay locale \`${locale}\`.`);
    if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) throw new ProfileInvalidError(`Overlay for \`${locale}\` must be an object.`);
    const o = overlay as Record<string, unknown>;
    const cleaned: { displayName?: string; bio?: string } = {};
    if (o.displayName !== undefined) {
      if (typeof o.displayName !== 'string') throw new ProfileInvalidError('Overlay displayName must be a string.');
      const dn = o.displayName.trim().slice(0, 80);
      if (dn) cleaned.displayName = dn;
    }
    if (o.bio !== undefined) {
      if (typeof o.bio !== 'string') throw new ProfileInvalidError('Overlay bio must be a string.');
      const b = o.bio.slice(0, 1000);
      if (b) cleaned.bio = b;
    }
    if (Object.keys(cleaned).length > 0) out[locale] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Create/update the caller's profile (returns to `draft`/`pending` — public
 *  visibility always rides a fresh approval). Handle claims are CAS-atomic. */
export async function upsertProfile(
  tenantId: string,
  creatorSubject: string,
  input: { handle: string; displayName: string; bio?: string; links?: string[]; localizations?: unknown },
): Promise<CreatorProfile> {
  const handle = input.handle.trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) throw new ProfileInvalidError('Handle: 3-30 chars, a-z 0-9 hyphen.');
  const displayName = input.displayName.trim().slice(0, 80);
  if (!displayName) throw new ProfileInvalidError('A display name is required.');
  const links = validateLinks(input.links);
  const localizations = validateProfileLocalizations(input.localizations);

  const existing = await profiles.get(`${tenantId}::${creatorSubject}`);
  if (!existing || existing.handle !== handle) {
    // Claim the handle atomically; release the old one only after the claim.
    const claimed = await handleIndex.compareAndSwap(null, { tenantId, handleLower: handle, creatorSubject });
    if (!claimed) {
      const holder = await handleIndex.get(`${tenantId}::${handle}`);
      if (holder?.creatorSubject !== creatorSubject) throw new HandleTakenError(handle);
    }
  }

  const profile: CreatorProfile = {
    tenantId,
    creatorSubject,
    handle,
    displayName,
    bio: (input.bio ?? '').slice(0, 1000),
    links,
    ...(localizations ? { localizations } : {}),
    state: 'draft',
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  await profiles.put(profile);
  // Release the OLD handle only after the profile write commits (grade-pass
  // KTD-2: a mid-way failure must fail CLOSED — old handle kept, never a
  // profile pointing at a released index).
  if (existing && existing.handle !== handle) await handleIndex.delete(`${tenantId}::${existing.handle}`);
  // ADR 0453 — an edit resets to `draft`, so a previously-approved profile is
  // pulled DOWN from the public kernel projection until it is re-approved.
  await syncCreatorProfileProjection(profile);
  // GC-2 — durable mutation. Log the PUBLIC handle + state; never the subject or
  // displayName (free text).
  log.info('kicktodo_profile_upserted', { tenantId, handle, state: profile.state });
  return profile;
}

export async function myProfile(tenantId: string, creatorSubject: string): Promise<CreatorProfile | null> {
  return await profiles.get(`${tenantId}::${creatorSubject}`);
}

/** Submit for public visibility → a `community-profile` approval. */
export async function submitProfile(tenantId: string, creatorSubject: string): Promise<CreatorProfile> {
  const p = await profiles.get(`${tenantId}::${creatorSubject}`);
  if (!p) throw new NotFoundError();
  if (p.state === 'approved') return p;
  const approval = await createCommunityApproval({
    tenantId,
    kind: 'community-profile',
    proposal: `Approve creator profile @${p.handle} (${p.displayName}) for public visibility.`,
    refId: creatorSubject,
    submittedBy: creatorSubject,
  });
  const pending: CreatorProfile = { ...p, state: 'pending', approvalId: approval.approvalId, updatedAt: nowIso() };
  await profiles.put(pending);
  log.info('kicktodo_profile_submitted', { tenantId, handle: p.handle, approvalId: approval.approvalId });
  return pending;
}

/** Approval outcome → profile state. SEPARATION OF DUTIES: the resolver
 *  identity must differ from the profile owner (KT-R1). */
export async function applyProfileDecision(
  tenantId: string,
  creatorSubject: string,
  decidedBy: string,
  approve: boolean,
): Promise<CreatorProfile> {
  const p = await profiles.get(`${tenantId}::${creatorSubject}`);
  if (!p || p.state !== 'pending' || !p.approvalId) throw new NotFoundError();
  if (decidedBy === creatorSubject) {
    // GC-2 — a governance denial worth a warn (someone tried to self-approve).
    log.warn('kicktodo_profile_decision_denied', { tenantId, reason: 'separation-of-duties' });
    throw new SeparationOfDutiesError();
  }
  const approval = await getApproval(p.approvalId);
  if (!approval || approval.tenantId !== tenantId) throw new NotFoundError();
  // Grade-pass COM-1: the APPROVAL (its own authz + CAS) is the decision
  // authority — this endpoint APPLIES a terminal outcome that already exists,
  // never mints one (previously any non-owner member could flip a pending
  // profile while the approval was still pending).
  const expected = approve ? 'approved' : 'rejected';
  if (approval.status !== expected) throw new SeparationOfDutiesError();
  const next: CreatorProfile = { ...p, state: approve ? 'approved' : 'draft', updatedAt: nowIso() };
  await profiles.put(next);
  // ADR 0453 — publish the public kernel projection on approval; a rejection
  // (→ draft) removes it. The kernel entity is the public-read + l10n surface.
  await syncCreatorProfileProjection(next);
  log.info('kicktodo_profile_decided', { handle: p.handle, approved: approve });
  return next;
}

/**
 * ADR 0453 P3 — re-derive every creator profile's kernel projection from the
 * write-model (the SoT). Idempotent: publishes an APPROVED profile that has no
 * projection yet (a straggler approved BEFORE P1 shipped) and pulls down any
 * projection that shouldn't be public. Also the DATA-LEV-3 reconciler — it heals
 * any divergence a best-effort `syncCreatorProfileProjection` failure left behind
 * (e.g. a rejected profile that stayed publicly live). Per-row best-effort so one
 * bad profile never aborts the sweep. Returns the count reconciled.
 */
export async function reconcileCreatorProfileProjections(): Promise<number> {
  let reconciled = 0;
  for (const p of await profiles.list()) {
    try {
      await syncCreatorProfileProjection(p);
      reconciled += 1;
    } catch (err) {
      log.warn('kicktodo_profile_reconcile_row_failed', { handle: p.handle, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.info('kicktodo_profile_projections_reconciled', { reconciled });
  return reconciled;
}

/**
 * ADR 0465 P3 — re-derive every review's kernel projection from the write-model
 * (the SoT). Mirrors `reconcileCreatorProfileProjections`: mints a missing
 * `reviewEntityId` on a legacy row (persisting the SoT mapping) then re-syncs, so a
 * VISIBLE review with no projection yet (a straggler written before P1) is
 * published and a flagged/removed one is pulled down. Per-row best-effort so one
 * bad review never aborts the sweep. Returns the count reconciled.
 */
export async function reconcileReviewProjections(tenantId?: string): Promise<number> {
  let reconciled = 0;
  for (const r of await reviews.list()) {
    if (tenantId && r.tenantId !== tenantId) continue;
    try {
      let row = r;
      if (!row.reviewEntityId) {
        // Backfill the random id (never subject-derived) + persist it as the SoT.
        row = { ...r, reviewEntityId: `rev:${randomUUID()}`, updatedAt: nowIso() };
        await reviews.put(row);
      }
      await syncReviewProjection(row);
      reconciled += 1;
    } catch (err) {
      log.warn('kicktodo_review_reconcile_row_failed', { challengeId: r.challengeId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.info('kicktodo_review_projections_reconciled', { reconciled });
  return reconciled;
}

/** Public projection: approved profiles only; closed field set.
 *  ADR 0453 P3 (read-switch) — the write-model stays the source of truth for the
 *  handle / links / approval gate, but `displayName`/`bio` are LOCALIZED from the
 *  kernel projection (the per-locale overlay P2 publishes) when the `entities`
 *  toggle is on and a content locale is requested. Toggle-SAFE: any kernel-read
 *  failure (toggle off, type not yet minted) falls back to the base values, so a
 *  profile never vanishes. `localePref` is the visitor's requested content locale. */
export async function publicProfileByHandle(
  tenantId: string,
  handle: string,
  localePref?: { explicit?: string; acceptLanguage?: string },
): Promise<{ handle: string; displayName: string; bio: string; links: string[] } | null> {
  const idx = await handleIndex.get(`${tenantId}::${handle.toLowerCase()}`);
  if (!idx) return null;
  const p = await profiles.get(`${tenantId}::${idx.creatorSubject}`);
  if (!p || p.state !== 'approved') return null;
  let displayName = p.displayName;
  let bio = p.bio;
  try {
    const locale = await resolveEntityPublicLocale(tenantId, localePref ?? {}).catch(() => undefined);
    const rec = await readPublicEntity({
      tenantId, typeName: CREATOR_PROFILE_TYPE, entityId: idx.creatorSubject,
      ...(locale ? { locale } : {}),
    });
    if (rec) {
      if (typeof rec.values.display_name === 'string') displayName = rec.values.display_name;
      if (typeof rec.values.bio === 'string') bio = rec.values.bio;
    }
  } catch { /* entities toggle off / type absent → serve the base values (write-model) */ }
  return { handle: p.handle, displayName, bio, links: p.links };
}

/** PROOF: a live entitlement (paid) or a completed enrollment (free). */
async function reviewProof(
  tenantId: string,
  reviewerSubject: string,
  challengeId: string,
  challengeVersion: number,
): Promise<'entitlement' | 'completed-enrollment' | null> {
  const ent = await getEntitlement(tenantId, reviewerSubject, challengeId, challengeVersion);
  if (ent && ent.state === 'active') return 'entitlement';
  const enrollments = await listEnrollmentsFor(tenantId, reviewerSubject);
  for (const e of enrollments) {
    if (e.challengeId !== challengeId || e.challengeVersion !== challengeVersion) continue;
    if (e.state === 'completed') return 'completed-enrollment';
    const progress = await progressFor(tenantId, e.id);
    if (progress && progress.completedActivities >= progress.totalRequiredActivities) return 'completed-enrollment';
  }
  return null;
}

/** Write (or overwrite — ONE per buyer by key construction) a review. */
export async function putReview(
  tenantId: string,
  reviewerSubject: string,
  input: { challengeId: string; challengeVersion: number; rating: number; body?: string },
): Promise<ChallengeReview> {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new ProfileInvalidError('Rating must be an integer 1-5.');
  }
  const challenge = await getChallenge(tenantId, input.challengeId, input.challengeVersion);
  if (!challenge) throw new NotFoundError();
  const provenance = await reviewProof(tenantId, reviewerSubject, input.challengeId, input.challengeVersion);
  if (!provenance) throw new ReviewProofError();
  const existing = await reviews.get(`${tenantId}::${input.challengeId}::${reviewerSubject}`);
  const review: ChallengeReview = {
    tenantId,
    challengeId: input.challengeId,
    challengeVersion: input.challengeVersion,
    reviewerSubject,
    rating: input.rating,
    ...(input.body ? { body: input.body.slice(0, 2000) } : {}),
    state: existing?.state === 'removed' ? 'removed' : 'visible', // removal sticks through edits
    provenance,
    // ADR 0465 P1 — mint a RANDOM, non-subject-derived kernel entity id on the
    // FIRST write (preserve it on re-put). Never derived from `reviewerSubject`.
    reviewEntityId: existing?.reviewEntityId ?? `rev:${randomUUID()}`,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  await reviews.put(review);
  // ADR 0465 — publish the anonymous public kernel projection when visible; a
  // `removed` re-put takes the delete branch. Best-effort (never fails the write).
  await syncReviewProjection(review);
  log.info('kicktodo_review_written', { tenantId, challengeId: input.challengeId, version: input.challengeVersion, provenance });
  return review;
}

/** Public projection — NO reviewer PII: rating, body, provenance label. */
export async function visibleReviews(
  tenantId: string,
  challengeId: string,
): Promise<Array<{ rating: number; body?: string; provenance: string; createdAt: string }>> {
  const rows = await reviews.listByPrefix(`${tenantId}::${challengeId}::`);
  return rows
    .filter((r) => r.state === 'visible')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({
      rating: r.rating,
      ...(r.body ? { body: r.body } : {}),
      provenance: r.provenance === 'entitlement' ? 'verified purchase' : 'verified participant',
      createdAt: r.createdAt,
    }));
}

/** ADR 0460 Phase 2 — the tenant's currently-flagged reviews (open moderation
 *  exceptions). Tenant-scoped prefix read; the caller bounds the result. */
export async function listFlaggedReviews(tenantId: string): Promise<ChallengeReview[]> {
  if (!tenantId) return [];
  return (await reviews.listByPrefix(`${tenantId}::`)).filter((r) => r.state === 'flagged');
}

const RATING_K_FLOOR = 3;

/** Discover's aggregate rating — renders only at ≥3 visible reviews. */
export async function aggregateRating(
  tenantId: string,
  challengeId: string,
): Promise<{ count: number; average: number | null }> {
  const rows = (await reviews.listByPrefix(`${tenantId}::${challengeId}::`)).filter((r) => r.state === 'visible');
  if (rows.length < RATING_K_FLOOR) return { count: rows.length, average: null };
  return { count: rows.length, average: Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 10) / 10 };
}

/** Flag a review → `community-review` moderation approval; hidden while flagged. */
export async function flagReview(
  tenantId: string,
  flaggerSubject: string,
  challengeId: string,
  reviewerSubject: string,
  reason: string,
): Promise<ChallengeReview> {
  const r = await reviews.get(`${tenantId}::${challengeId}::${reviewerSubject}`);
  if (!r || r.state !== 'visible') throw new NotFoundError();
  const approval = await createCommunityApproval({
    tenantId,
    kind: 'community-review',
    proposal: `Moderate a flagged review on challenge ${challengeId}: ${reason.slice(0, 300)}`,
    refId: `${challengeId}::${reviewerSubject}`,
    submittedBy: flaggerSubject,
  });
  const flagged: ChallengeReview = { ...r, state: 'flagged', flagApprovalId: approval.approvalId, updatedAt: nowIso() };
  await reviews.put(flagged);
  // ADR 0465 — a flagged review is hidden → pull the public kernel projection down.
  await syncReviewProjection(flagged);
  log.info('kicktodo_review_flagged', { tenantId, challengeId, approvalId: approval.approvalId });
  return flagged;
}

/** Moderation outcome: remove (approve the flag) or restore (reject it). */
export async function resolveReviewFlag(
  tenantId: string,
  challengeId: string,
  reviewerSubject: string,
  remove: boolean,
): Promise<ChallengeReview> {
  const r = await reviews.get(`${tenantId}::${challengeId}::${reviewerSubject}`);
  if (!r || r.state !== 'flagged') throw new NotFoundError();
  const next: ChallengeReview = { ...r, state: remove ? 'removed' : 'visible', updatedAt: nowIso() };
  await reviews.put(next);
  // ADR 0465 — remove → delete the projection; restore → re-publish it.
  await syncReviewProjection(next);
  log.info('kicktodo_review_flag_resolved', { tenantId, challengeId, outcome: next.state });
  return next;
}

/** Counts-only creator analytics (ADR 0426 P3): the caller's PRODUCT-LINKED
 *  challenges (link.createdBy — the revenueProjectionFor precedent; free-
 *  challenge attribution arrives with creator onboarding, recorded as an ADR
 *  correction) + rating histograms. Never a participant row. */
export async function creatorAnalytics(
  tenantId: string,
  creatorSubject: string,
  revenueProjection: (tenantId: string, creatorSubject: string) => Promise<Array<{
    challengeId: string; challengeVersion: number; activeEntitlements: number; revokedEntitlements: number;
  }>>,
): Promise<Array<{
  challengeId: string;
  challengeVersion: number;
  activeEntitlements: number;
  revokedEntitlements: number;
  reviewCount: number;
  averageRating: number | null;
}>> {
  const rows = await revenueProjection(tenantId, creatorSubject);
  return await Promise.all(rows.map(async (row) => {
    const agg = await aggregateRating(tenantId, row.challengeId);
    return { ...row, reviewCount: agg.count, averageRating: agg.average };
  }));
}

// ADR 0458 P0 — GDPR data-subject erasure (subjectErasure seam). A creator PROFILE and a
// challenge REVIEW are approval-gated public CONTENT, but the subject authored both AS
// THEMSELVES (their handle/displayName/bio; their rating/body) — this is the subject's own
// personal data, not a third-party record the tenant holds about someone else (contrast
// crm's DELIBERATELY-NOT eraser). So on a DSAR we DELETE them:
//   - the profile row, its handle-index claim (freeing the handle), and the public
//     content-kernel projection (via a `draft`-state sync → the unpublish path, so the
//     erased person can't linger publicly readable);
//   - every review the subject authored (keyed by `reviewerSubject`; no subject prefix, so
//     scan the tenant's reviews — the revokeConsent/comments scan precedent).
// (Flags carry no separate row — a flag lives on the review as `flagApprovalId` — so there
// is nothing flag-shaped to erase here.) Tenant-scoped, idempotent, no notifications.
export async function eraseCommunitySubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const profile = await profiles.get(`${tenantId}::${subjectKey}`);
  if (profile) {
    await profiles.delete(`${tenantId}::${subjectKey}`);
    await handleIndex.delete(`${tenantId}::${profile.handle}`);
    // Pull the public projection down (best-effort inside the sync; a non-approved state
    // takes the delete branch). Never leave an erased subject publicly readable.
    await syncCreatorProfileProjection({ ...profile, state: 'draft' });
  }
  for (const r of await reviews.list()) {
    if (r.tenantId === tenantId && r.reviewerSubject === subjectKey) {
      await reviews.delete(`${r.tenantId}::${r.challengeId}::${r.reviewerSubject}`);
      // ADR 0465 — the erasure must pull the public kernel projection down too, so
      // the erased subject's review can't linger publicly readable. Best-effort
      // (keyed by the random reviewEntityId; a legacy row without one had no
      // projection). Never let a projection failure abort the erasure.
      if (r.reviewEntityId) {
        try {
          await deleteSystemEntity({ tenantId, typeName: REVIEW_TYPE, entityId: r.reviewEntityId });
        } catch (err) {
          log.error('kicktodo_review_erase_projection_failed_may_stay_public', { challengeId: r.challengeId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
}
registerSubjectEraser(eraseCommunitySubject);

// NO registerRetentionPurger (deliberate OMIT + reason): profiles and reviews are
// approval-gated public CONTENT, not aged `confidential-pii`. Content is not time-purged
// (it is unpublished by state, or erased by the subject seam above); there is no
// abandoned-PII-aged-on-`updatedAt` row here for the time-based sweep to act on.

/** Test-only: the module-private collections, for erasure/seed assertions. */
export const __test = { profiles, handleIndex, reviews };
