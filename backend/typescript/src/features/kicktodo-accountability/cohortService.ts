/**
 * Cohorts + coach console + inert plan proposals (ADR 0419 P3).
 *
 *  - A cohort is a circle of type `cohort` plus a detail row: ONE pinned
 *    challenge version, a start date, and a CAS-held capacity (an exact seat
 *    count — the ADR 0420 P2 composition point).
 *  - The coach CASELOAD resolves across workspaces through a grantee-keyed
 *    pointer index (the same opaque-pointer pattern as the binding seam);
 *    every row is LIVE-grant-checked at read.
 *  - A coach PROPOSAL is INERT: the participant applies it (through the
 *    existing `applyPlanRevision`) or dismisses it — a coach never mutates a
 *    plan directly (PRD §13).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { purgeRowsByAge, type PurgeOutcome } from '../../host/retentionPurger.js';
import { createLogger } from '../../observability/logger.js';
// `applyPlanRevision` is deliberately NO LONGER imported: ADR 0501 step 3 deleted the
// blunt path from this surface. Accept now routes through `applyRevisionCommands`, which
// calls it internally as its trailing re-materialization step.
import { getEnrollment, listEnrollmentsFor } from '../kicktodo-core/enrollmentService.js';
import {
  createKicktodoPlanProposalApproval,
  resolveApproval,
  erasePlanProposalApprovalsForSubject,
} from '../../host/approvalService.js';
import { progressFor } from '../kicktodo-core/progressService.js';
// ADR 0501 step 3 — the ONE execution seam for a closed-world revision, shared with
// the participant's own replan route and the chat tool. `kicktodo-accountability`
// already `dependsOn: ['kicktodo-core']` (feature.ts) and imports its services
// directly, so this is the declared-dependency pattern, not a new cross-feature edge.
import { applyRevisionCommands, previewRevisionCommands, validateRevisionCommands, type RevisionCommand, describeRevisionCommands } from '../kicktodo-core/replanService.js';
import {
  acceptGrant,
  liveGrant,
  resolveCircleByOpaqueId,
  CircleDeniedError,
  type AccountabilityCircle,
  listGrantsInternal,
  inviteToCircle,
  revokeGrant,
  type GrantScope,
} from './circleService.js';

const log = createLogger('kicktodo.cohorts');

export interface CohortDetail {
  tenantId: string;
  circleId: string;
  challengeId: string;
  challengeVersion: number;
  startDateLocal: string;
  capacity: number;
  seatsTaken: number;
}

const cohorts = new DurableCollection<CohortDetail>(
  'kicktodo-cohorts',
  (c) => `${c.tenantId}::${c.circleId}`,
);

/** grantee → circle pointer (content-free) — the coach caseload's first hop. */
const granteeIndex = new DurableCollection<{ granteeSubject: string; circleId: string; tenantId: string }>(
  'kicktodo-grantee-index',
  (r) => `${r.granteeSubject}::${r.circleId}`,
);

export interface PlanChangeProposal {
  id: string;
  tenantId: string;
  circleId: string;
  enrollmentId: string;
  coachSubject: string;
  note: string;
  /**
   * ADR 0501 step 2 — the EXECUTABLE half of the proposal, closed-world over the
   * three ADR 0429 lanes (+ the ADR 0496 D1 move). `note` is advice for the human;
   * this is what `apply` actually runs.
   *
   * OPTIONAL, and the absence is load-bearing: proposals created before this shape
   * existed carry prose only. Those are **advice-only forever** — `resolveProposal`
   * refuses to `apply` them rather than running a generic revision and calling it
   * applied, which was the KT-HONESTY-1 defect. Never default this to `[]` to make
   * a legacy row "applyable": an empty list is an honest no-op in
   * `applyRevisionCommands`, so it would execute nothing and still persist
   * `state: 'applied'` — the durable lie, preserved.
   */
  commands?: RevisionCommand[];
  state: 'proposed' | 'applied' | 'dismissed';
  createdAt: string;
  resolvedAt?: string;
  /** ADR 0459 grade-fix — the participant-facing approval CARD this proposal raised
   *  (`createKicktodoPlanProposalApproval`). Present ⇒ the decision lives on a card,
   *  and the retained per-enrollment route reconciles it on resolve. ABSENT ⇒ the
   *  card-raise degraded (best-effort), so the FE renders honest apply/dismiss here. */
  approvalId?: string;
}

const proposals = new DurableCollection<PlanChangeProposal>(
  'kicktodo-plan-proposals',
  (p) => `${p.tenantId}::${p.enrollmentId}::${p.id}`,
);

// ADR 0458 Phase 0 — a coach proposal's `note` is author free-text about a
// participant's plan (personal data); declare it so the row classifies as
// `confidential-pii` for log-masking + the age-based retention sweep below.
declarePiiFields('kicktodo.plan-proposal', ['note']);

const PROPOSAL_KEY = (p: PlanChangeProposal): string => `${p.tenantId}::${p.enrollmentId}::${p.id}`;

const nowIso = (): string => new Date().toISOString();

export class CohortError extends Error {}
export class CohortFullError extends Error {
  constructor() {
    super('This cohort is full.');
  }
}

export async function createCohortDetail(input: {
  circle: AccountabilityCircle;
  actorSubject: string;
  capacity: number;
  startDateLocal: string;
}): Promise<CohortDetail> {
  const { circle } = input;
  if (circle.type !== 'cohort') throw new CohortError('Only a cohort-type circle carries cohort detail.');
  if (circle.ownerSubject !== input.actorSubject) throw new CircleDeniedError();
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 500) {
    throw new CohortError('Capacity must be an integer in [1, 500].');
  }
  const enrollment = await getEnrollment(circle.tenantId, circle.enrollmentId);
  if (!enrollment) throw new CircleDeniedError();
  const detail: CohortDetail = {
    tenantId: circle.tenantId,
    circleId: circle.id,
    challengeId: enrollment.challengeId,
    challengeVersion: enrollment.challengeVersion, // ONE pinned version for the whole cohort
    startDateLocal: input.startDateLocal,
    capacity: input.capacity,
    seatsTaken: 1, // the owner
  };
  if (!(await cohorts.compareAndSwap(null, detail))) {
    const existing = await cohorts.get(`${circle.tenantId}::${circle.id}`);
    if (existing) return existing;
  }
  return detail;
}

export async function getCohortDetail(tenantId: string, circleId: string): Promise<CohortDetail | null> {
  return (await cohorts.get(`${tenantId}::${circleId}`)) ?? null;
}

/** Join = accept the invitation + take a seat under CAS (exact capacity). */
export async function joinCohort(circleId: string, granteeSubject: string): Promise<CohortDetail> {
  const circle = await resolveCircleByOpaqueId(circleId);
  const detail0 = await cohorts.get(`${circle.tenantId}::${circleId}`);
  if (!detail0) throw new CircleDeniedError();

  // KTFULL-B11 — an ALREADY-ACTIVE member re-joining must not take a second
  // seat. Previously the CAS incremented first, so a repeated join inflated
  // `seatsTaken` and silently shrank the cohort.
  if (await liveGrant(circle.tenantId, circleId, granteeSubject)) return detail0;

  // KTFULL-B11 — accept the invitation BEFORE claiming the seat. The old order
  // incremented first, so a missing or revoked invitation threw from
  // `acceptGrant` and STRANDED the seat with nobody in it. Accepting first
  // means a refusal costs nothing; the seat is only taken once a real member
  // exists to occupy it.
  await acceptGrant(circleId, granteeSubject); // throws CircleDeniedError when not invited
  if (!(await claimSeat(circle.tenantId, circleId))) throw new CohortFullError();
  await recordSeat(circle.tenantId, circleId, granteeSubject); // ARCH-C2 ledger

  await granteeIndex.put({ granteeSubject, circleId, tenantId: circle.tenantId });
  const detail = await cohorts.get(`${circle.tenantId}::${circleId}`);
  log.info('kicktodo_cohort_joined', { circleId, seatsTaken: detail?.seatsTaken });
  return detail ?? detail0;
}

/** Record the grantee pointer at invite time (called from the route layer). */
/** ADR 0428 — a COUNTS-ONLY outcome aggregate for one cohort. Identities
 *  never leave this module: the org-programs feature consumes these numbers
 *  (and applies its own k-anonymity floor) — it can never enumerate members
 *  or read an individual's progress through this seam. */
export async function cohortOutcomeAggregate(
  tenantId: string,
  circleId: string,
): Promise<{ members: number; activeMembers: number; completedMembers: number } | null> {
  const detail = await cohorts.get(`${tenantId}::${circleId}`);
  if (!detail) return null;
  const rows = await listGrantsInternal(tenantId, circleId);
  const active = rows.filter((g) => g.state === 'active');
  let completed = 0;
  for (const g of active) {
    const enrollments = await listEnrollmentsFor(tenantId, g.granteeSubject);
    if (enrollments.some((e) =>
      e.challengeId === detail.challengeId && e.challengeVersion === detail.challengeVersion && e.state === 'completed',
    )) completed += 1;
  }
  return { members: rows.length, activeMembers: active.length, completedMembers: completed };
}

// ── ADR 0431 — seat HOLDS. The hold increments the SAME `seatsTaken` CAS that
// `joinCohort` uses (a second counter would drift), so a held seat is an
// occupied seat and two buyers can never both see the last one. Expiry is
// evaluated LAZILY on read/hold — no reaper, no new poller.

export interface SeatHold {
  tenantId: string;
  circleId: string;
  buyerSubject: string;
  heldAt: string;
  expiresAt: string;
}

const holds = new DurableCollection<SeatHold>(
  'kicktodo-seat-holds',
  (h) => `${h.tenantId}::${h.circleId}::${h.buyerSubject}`,
);

/**
 * ARCH-C2 — WHO OCCUPIES A SEAT, recorded explicitly.
 *
 * The first B12 fix derived occupancy from active GRANTS, which is the wrong
 * set in both directions: a coach invited with `coach-plan-proposal` accepts
 * through the generic `/accept` route and holds an active grant while never
 * claiming a seat (so reconcile counted a non-occupant and shrank the cohort),
 * and that same route lets any invitee bypass `joinCohort` entirely. A grant
 * conveys ACCESS; a seat is a CAPACITY claim. Different facts, so the seat
 * gets its own row instead of being inferred from a proxy.
 */
interface CohortSeat {
  tenantId: string;
  circleId: string;
  subject: string;
  claimedAt: string;
}
const seats = new DurableCollection<CohortSeat>(
  'kicktodo-cohort-seats',
  (x) => `${x.tenantId}::${x.circleId}::${x.subject}`,
);

async function recordSeat(tenantId: string, circleId: string, subject: string): Promise<void> {
  await seats.put({ tenantId, circleId, subject, claimedAt: new Date().toISOString() });
}
async function dropSeat(tenantId: string, circleId: string, subject: string): Promise<void> {
  await seats.delete(`${tenantId}::${circleId}::${subject}`);
}

/** Default hold window: long enough for a real checkout including 3DS, short
 *  enough that an abandoned browse does not strand a seat. */
export const SEAT_HOLD_TTL_MS = 15 * 60 * 1000;

export class CohortFullForHoldError extends Error {
  constructor() {
    super('That cohort is full.');
  }
}

const isExpired = (h: SeatHold, now: number): boolean => Date.parse(h.expiresAt) <= now;

/**
 * KTFULL-B12 — recompute `seatsTaken` from DURABLE TRUTH.
 *
 * Seat expiry, confirmation and refund are multi-owner sequences (hold rows,
 * the cohort counter, grant rows, the grantee index) with no transaction
 * spanning them. Every step used to adjust `seatsTaken` by ARITHMETIC, so a
 * failure between two steps left the counter permanently wrong in a way
 * nothing could detect or repair: a decrement that never ran stranded capacity
 * forever, and no amount of retrying fixed it because the retry re-applied a
 * delta rather than restating the truth.
 *
 * The fix is to stop treating the counter as authoritative. Occupancy is
 * DERIVABLE — the owner's seat, plus everyone holding a live grant, plus
 * everyone holding an unexpired reservation who is not already a member. This
 * recomputes it and CASes the result, so it is safe to call after ANY partial
 * failure and converges to the same number however many times it runs.
 *
 * `claimSeat` keeps its atomic increment: that is the oversell guard (B10) and
 * must stay on the hot path. This is the REPAIR, not a replacement for it.
 */
export async function reconcileSeats(tenantId: string, circleId: string): Promise<CohortDetail | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const detail = await cohorts.get(`${tenantId}::${circleId}`);
    if (!detail) return null;
    // ARCH-C3 — NO blanket catch. `resolveCircleByOpaqueId` does two storage
    // reads; swallowing a TRANSIENT miss dropped the owner from the occupant
    // set and durably CAS-wrote a count one too low, permanently inflating
    // capacity. A repair that silently corrupts on a flaky read is worse than
    // no repair, so this propagates and aborts.
    const circle = await resolveCircleByOpaqueId(circleId);
    // CR-1 — `resolveCircleByOpaqueId` is UNTENANTED by design (grantees accept
    // cross-workspace). The tenant check above (`cohorts.get`) already fails
    // closed, but that made cross-tenant safety rest on the unstated invariant
    // that circle ids are globally unique. State it.
    if (circle.tenantId !== tenantId) throw new CircleDeniedError();
    const occupants = new Set<string>([circle.ownerSubject]);

    // ARCH-C2 — occupancy is the INTERSECTION of "claimed a seat" and "still
    // has access", not either alone:
    //   - GRANTS alone counted coaches, who accept through the generic accept
    //     route and never claim a seat;
    //   - SEAT ROWS alone kept charging someone whose grant was revoked
    //     out-of-band, so a refund bypassing `releaseSeat` stranded capacity.
    const liveGrantees = new Set(
      (await listGrantsInternal(tenantId, circleId))
        .filter((g) => g.state === 'active' && !g.revokedAt
          && !(g.expiresAt && Date.parse(g.expiresAt) < Date.now()))
        .map((g) => g.granteeSubject),
    );
    for (const x of await seats.listByPrefix(`${tenantId}::${circleId}::`)) {
      if (liveGrantees.has(x.subject)) occupants.add(x.subject);
    }
    const now = Date.now();
    for (const h of await holds.listByPrefix(`${tenantId}::${circleId}::`)) {
      if (!isExpired(h, now)) occupants.add(h.buyerSubject);
    }

    const seatsTaken = occupants.size;
    if (seatsTaken === detail.seatsTaken) return detail;
    const next: CohortDetail = { ...detail, seatsTaken };
    if (await cohorts.compareAndSwap(detail, next)) {
      log.info('kicktodo_seats_reconciled', { circleId, from: detail.seatsTaken, to: seatsTaken });
      return next;
    }
  }
  throw new CohortError('Concurrent seat updates — retry.');
}

/** Release every EXPIRED hold on a cohort, then RESTATE occupancy.
 *  KTFULL-B12: the delete is the only destructive step, and the counter is
 *  derived afterwards — so a crash mid-loop leaves a count that the next
 *  reconcile corrects, rather than a permanently stranded seat. */
async function reapExpiredHolds(tenantId: string, circleId: string, nowMs: number): Promise<void> {
  let reaped = false;
  for (const h of await holds.listByPrefix(`${tenantId}::${circleId}::`)) {
    if (!isExpired(h, nowMs)) continue;
    await holds.delete(`${tenantId}::${circleId}::${h.buyerSubject}`);
    reaped = true;
  }
  if (reaped) await reconcileSeats(tenantId, circleId);
}

/** KTFULL-B10 — claim ONE seat with the capacity check INSIDE the CAS.
 *
 *  The previous shape checked `seatsTaken >= capacity` and then called a
 *  separate increment that did not re-check, so two buyers could both pass the
 *  pre-check and both increment — overselling a capacity-limited human
 *  service. Re-reading and re-checking on every attempt closes that window:
 *  the loser of the race sees the winner's incremented count and is refused.
 *
 *  Returns false when the cohort is genuinely full (not a transient CAS loss). */
async function claimSeat(tenantId: string, circleId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const detail = await cohorts.get(`${tenantId}::${circleId}`);
    if (!detail) return false;
    if (detail.seatsTaken >= detail.capacity) return false; // re-checked EVERY attempt
    if (await cohorts.compareAndSwap(detail, { ...detail, seatsTaken: detail.seatsTaken + 1 })) return true;
  }
  throw new CohortError('Concurrent seat claims — retry.');
}

/** ADR 0431 — take (or refresh) ONE hold for this buyer on this cohort.
 *  Idempotent by the deterministic key: re-holding extends the window rather
 *  than taking a second seat. */
export async function holdSeat(
  tenantId: string,
  circleId: string,
  buyerSubject: string,
  ttlMs: number = SEAT_HOLD_TTL_MS,
): Promise<SeatHold> {
  const now = Date.now();
  await reapExpiredHolds(tenantId, circleId, now);
  const key = `${tenantId}::${circleId}::${buyerSubject}`;
  const existing = await holds.get(key);
  if (existing && !isExpired(existing, now)) {
    const refreshed: SeatHold = { ...existing, expiresAt: new Date(now + ttlMs).toISOString() };
    await holds.put(refreshed);
    return refreshed; // already occupying a seat — do not double-count
  }
  const detail = await cohorts.get(`${tenantId}::${circleId}`);
  if (!detail) throw new CircleDeniedError();
  // KTFULL-B10 — the capacity check lives INSIDE the CAS; a pre-check here
  // would reopen the oversell window this fix exists to close.
  if (!(await claimSeat(tenantId, circleId))) throw new CohortFullForHoldError();
  const hold: SeatHold = {
    tenantId,
    circleId,
    buyerSubject,
    heldAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  await holds.put(hold);
  return hold;
}

export async function liveHold(tenantId: string, circleId: string, buyerSubject: string): Promise<SeatHold | null> {
  const h = await holds.get(`${tenantId}::${circleId}::${buyerSubject}`);
  return h && !isExpired(h, Date.now()) ? h : null;
}

/**
 * ADR 0431 — convert a paid order into a real seat. Idempotent by
 * `(circleId, buyerSubject)`: a replayed webhook converges.
 *  - a LIVE hold already occupies the seat ⇒ consume it and grant;
 *  - no hold (expired, or the buyer skipped the reserve step) ⇒ grant only if
 *    capacity is genuinely free; otherwise FAIL CLOSED so the caller can flag
 *    a refund. Never silently oversell, never silently swallow money.
 */
export async function confirmSeat(
  tenantId: string,
  circleId: string,
  buyerSubject: string,
  scopes: GrantScope[] = ['progress-summary'],
): Promise<{ granted: boolean; reason?: 'already-member' | 'cohort-full' }> {
  const detail = await cohorts.get(`${tenantId}::${circleId}`);
  if (!detail) return { granted: false, reason: 'cohort-full' };
  if (await liveGrant(tenantId, circleId, buyerSubject)) return { granted: true, reason: 'already-member' };

  const hold = await holds.get(`${tenantId}::${circleId}::${buyerSubject}`);
  const now = Date.now();
  const holdIsLive = Boolean(hold && !isExpired(hold, now));
  if (!holdIsLive) {
    // No live reservation: the seat must be genuinely free, or FAIL CLOSED so
    // the caller can flag a refund. Never silently oversell a coached group.
    if (hold) await holds.delete(`${tenantId}::${circleId}::${buyerSubject}`);
    await reapExpiredHolds(tenantId, circleId, now);
    // ARCH-C1 — CLAIM, never check-then-adjust. The previous shape read the
    // count, compared it to capacity, then called `adjustSeats` (no capacity
    // guard) — reintroducing the exact oversell race B10 exists to close, on
    // the MONEY path: two paid webhooks for the last seat both pass the
    // pre-check and both increment. `claimSeat` re-checks inside the CAS.
    if (!(await claimSeat(tenantId, circleId))) return { granted: false, reason: 'cohort-full' };
  }

  // KTFULL-B12 — ACCESS IS GRANTED BEFORE THE HOLD IS RELEASED.
  //
  // The old order deleted the hold first, so a failure between the delete and
  // `acceptGrant` left a buyer who had PAID with no hold, no grant, and a seat
  // still counted against them — money taken, access lost, capacity stranded.
  // Granting first inverts that: the worst partial state is a live grant
  // alongside a stale hold, which `reconcileSeats` counts as ONE occupant
  // (the same person) and the next reap clears. The buyer never loses what
  // they paid for.
  const circle = await resolveCircleByOpaqueId(circleId);
  await inviteToCircle(tenantId, circleId, circle.ownerSubject, buyerSubject, scopes);
  await acceptGrant(circleId, buyerSubject);
  await indexGrantee(buyerSubject, circleId, tenantId);
  // ARCH-C2 — record the seat BEFORE releasing the hold, so occupancy is never
  // momentarily unbacked: hold and seat overlap (reconcile counts the subject
  // once) rather than leaving a gap a concurrent reconcile could read.
  await recordSeat(tenantId, circleId, buyerSubject);
  if (holdIsLive) await holds.delete(`${tenantId}::${circleId}::${buyerSubject}`);
  log.info('kicktodo_seat_confirmed', { circleId });
  return { granted: true };
}

/** ADR 0431 — a refund releases the seat and revokes the grant, but NEVER
 *  deletes completed history (PRD §13 Commerce). Seats are released only
 *  BEFORE the cohort starts: a mid-cohort backfill disrupts a coached group. */
export async function releaseSeat(
  tenantId: string,
  circleId: string,
  buyerSubject: string,
  todayLocal: string,
): Promise<{ released: boolean }> {
  const detail = await cohorts.get(`${tenantId}::${circleId}`);
  if (!detail) return { released: false };
  const had = await liveGrant(tenantId, circleId, buyerSubject);
  const beforeStart = todayLocal < detail.startDateLocal;
  // ARCH-H4 — the revoke used to run UNCONDITIONALLY, before `beforeStart` was
  // consulted. A mid-cohort refund therefore stripped the participant's access
  // while returning `{released:false}` and leaving the seat counted: they lost
  // the cohort AND the seat stayed spent. Access and the seat now move
  // together, or neither moves.
  if (!(had && beforeStart)) return { released: false };
  // `detail` is already proven present above, so the owner always resolves.
  const owner = (await resolveCircleByOpaqueId(circleId)).ownerSubject;
  await revokeGrant(tenantId, circleId, owner, buyerSubject).catch(() => undefined);
  // KTFULL-B12 — RESTATE occupancy from the grant rows rather than applying a
  // -1 that is lost forever if this call dies between the revoke and the
  // decrement. The revoke already happened durably; reconcile derives the
  // count from it, so a retry converges instead of double-decrementing.
  await dropSeat(tenantId, circleId, buyerSubject); // ARCH-C2 ledger
  await holds.delete(`${tenantId}::${circleId}::${buyerSubject}`).catch(() => undefined);
  await reconcileSeats(tenantId, circleId);
  return { released: true };
}

/**
 * KTD-14 — release a seat whose grant was revoked OUT OF BAND.
 *
 * The generic revoke route (`POST /kicktodo/circles/:id/revoke`) kills the
 * grant directly, without `releaseSeat`. That left TWO things stale: the seat
 * ledger row lingered (inert — the reconcile intersection ignores it), AND
 * `seatsTaken` was never restated. The second is a WRONG COMPUTED VALUE, not
 * residue: `claimSeat` gates on `seatsTaken >= capacity`, so a stranded count
 * wrongly refuses a new buyer a seat that is actually free, and self-heals only
 * on some later incidental reconcile — of which there is no guarantee after a
 * manual revoke.
 *
 * This mirrors `releaseSeat`'s cleanup at the source (a targeted point-delete +
 * a reconcile that recomputes the now-changed count), rather than pruning
 * inside `reconcileSeats` (which would run on every reconcile and, because an
 * orphan row never contributes to the count, hit the early-return dead-spot
 * anyway). Safe for ANY circle type: `reconcileSeats` returns null for a
 * non-cohort and `dropSeat` on a missing key is a no-op.
 */
export async function releaseRevokedSeat(tenantId: string, circleId: string, subject: string): Promise<void> {
  await dropSeat(tenantId, circleId, subject);
  try {
    await reconcileSeats(tenantId, circleId);
  } catch (err) {
    // KTD-16 — best-effort by design (the revoke has already committed), but a
    // swallowed reconcile failure was invisible. Log it so the heal-late case
    // is observable; the count still converges on any later reconcile.
    log.warn('kicktodo_seat_reconcile_deferred', {
      circleId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function indexGrantee(granteeSubject: string, circleId: string, tenantId: string): Promise<void> {
  await granteeIndex.put({ granteeSubject, circleId, tenantId });
}

/** ADR 0501 (console) — the coach's OWN proposal, as the console shows it: state and
 *  note, never the participant's decision reasoning. `hasCommands` distinguishes an
 *  executable proposal from advice-only (the seam's absent-vs-present rule). */
export interface CoachProposalView {
  id: string;
  state: PlanChangeProposal['state'];
  note: string;
  hasCommands: boolean;
  createdAt: string;
  resolvedAt?: string;
}

export interface CaseloadRow {
  circleId: string;
  circleName: string;
  enrollmentId: string;
  summary: { currentDay: number; durationDays: number; completedActivities: number; totalRequiredActivities: number; state: string } | null;
  /** Deterministic attention flag: ≥3 days in with zero completions. */
  flagged: boolean;
  /** ADR 0501 (console) — this coach's own proposals for the row, oldest first. */
  proposals: CoachProposalView[];
}

/** The coach console: every circle where the caller holds a LIVE grant with
 *  the `coach-plan-proposal` scope (cross-workspace via the pointer index). */
export async function coachCaseload(coachSubject: string): Promise<CaseloadRow[]> {
  const pointers = await granteeIndex.listByPrefix(`${coachSubject}::`);
  const rows: CaseloadRow[] = [];
  for (const ptr of pointers) {
    const grant = await liveGrant(ptr.tenantId, ptr.circleId, coachSubject);
    if (!grant || !grant.scopes.includes('coach-plan-proposal')) continue;
    const circle = await resolveCircleByOpaqueId(ptr.circleId).catch(() => null);
    if (!circle) continue;
    const progress = await progressFor(ptr.tenantId, circle.enrollmentId);
    const summary = progress
      ? {
          currentDay: progress.currentDay,
          durationDays: progress.durationDays,
          completedActivities: progress.completedActivities,
          totalRequiredActivities: progress.totalRequiredActivities,
          state: progress.state,
        }
      : null;
    // ADR 0501 (console) — the coach's OWN proposals only (another coach's are theirs).
    const mine = (await listProposalsFor(ptr.tenantId, circle.enrollmentId))
      .filter((p) => p.coachSubject === coachSubject)
      .map((p): CoachProposalView => ({
        id: p.id, state: p.state, note: p.note, hasCommands: Array.isArray(p.commands), createdAt: p.createdAt,
        ...(p.resolvedAt ? { resolvedAt: p.resolvedAt } : {}),
      }));
    rows.push({
      circleId: ptr.circleId,
      circleName: circle.name,
      enrollmentId: circle.enrollmentId,
      summary,
      flagged: !!summary && summary.currentDay >= 3 && summary.completedActivities === 0,
      proposals: mine,
    });
  }
  return rows;
}

/** ADR 0501 (console) — a coach's DRY RUN of a proposal: the same grant check and the
 *  same closed-world validation as `proposePlanChange`, returning the humanized lines
 *  ("Move your sessions to the morning.") and NOTHING of the participant's plan — the
 *  owner-only `previewProposal` is the only thing that reads the plan, by design.
 *  Persists nothing. */
export async function dryRunProposal(
  circleId: string,
  coachSubject: string,
  commands: readonly unknown[],
): Promise<{ commands: RevisionCommand[]; lines: string[] }> {
  const circle = await resolveCircleByOpaqueId(circleId);
  const grant = await liveGrant(circle.tenantId, circleId, coachSubject);
  if (!grant || !grant.scopes.includes('coach-plan-proposal')) throw new CircleDeniedError();
  const validated = validateRevisionCommands(commands);
  return { commands: validated, lines: describeRevisionCommands(validated) };
}

/** A coach proposes; the record is the durable truth (page history). ADR 0459 P2
 *  additionally raises an approval CARD addressed to the participant — the decide
 *  path that applies it rides `resolveProposal` (the ONE applier). */
export async function proposePlanChange(
  circleId: string,
  coachSubject: string,
  note: string,
  commands?: readonly unknown[],
): Promise<PlanChangeProposal> {
  const circle = await resolveCircleByOpaqueId(circleId);
  const grant = await liveGrant(circle.tenantId, circleId, coachSubject);
  if (!grant || !grant.scopes.includes('coach-plan-proposal')) throw new CircleDeniedError();
  if (!note.trim()) throw new CohortError('A proposal needs a note.');
  const cleanNote = note.slice(0, 2000);
  // ADR 0501 step 2 — validate the commands HERE, at authoring time, so a coach
  // learns immediately that their ask falls outside the three lanes. Reusing
  // kicktodo-core's own validator keeps ONE closed world: a lane added there is
  // proposable here with no change, and a lane it rejects can never be persisted.
  // Deliberately NOT stored as `[]` when the coach sends nothing — see the
  // `commands?` doc on PlanChangeProposal; absent means advice-only.
  const validated = commands === undefined ? undefined : validateRevisionCommands(commands);
  const proposal: PlanChangeProposal = {
    id: `prop:${randomUUID()}`,
    tenantId: circle.tenantId,
    circleId,
    enrollmentId: circle.enrollmentId,
    coachSubject,
    note: cleanNote,
    ...(validated ? { commands: validated } : {}),
    state: 'proposed',
    createdAt: nowIso(),
  };
  await proposals.put(proposal);

  // ADR 0459 P2 — raise the participant-facing approval card. BEST-EFFORT
  // coupling by design: the proposal row above is the durable truth (the
  // read-only page history renders it regardless), so a card-raise failure
  // degrades to "history without a card" rather than losing the proposal. The
  // participant can still resolve via the (retained) proposals route. We look up
  // the enrollment owner as the sole decider + visibility key.
  try {
    const enrollment = await getEnrollment(circle.tenantId, circle.enrollmentId);
    if (enrollment) {
      const card = await createKicktodoPlanProposalApproval({
        tenantId: circle.tenantId,
        conversationId: circle.conversationId,
        circleId,
        enrollmentId: circle.enrollmentId,
        proposalId: proposal.id,
        coachSubject,
        participantSubject: enrollment.ownerSubject,
        note: cleanNote,
        proposal: `Plan change proposed by your coach: ${cleanNote}`,
      });
      // ADR 0459 grade-fix — remember the raised card on the proposal row so the
      // retained per-enrollment route can reconcile it (a route-resolved proposal
      // must never strand a pending card). Left absent when the raise above throws
      // — the degraded case the FE renders an honest apply/dismiss fallback for.
      proposal.approvalId = card.approvalId;
      await proposals.put(proposal);
    }
  } catch (err) {
    log.warn('kicktodo_plan_proposal_card_deferred', {
      circleId,
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return proposal;
}

/** ADR 0459 grade-fix — best-effort flip a proposal's linked approval CARD to match a
 *  decision taken through the retained per-enrollment route, so that route never
 *  strands a pending card (the dual-path desync). No-op when the proposal carries no
 *  card (the degraded raise). Log-and-continue: the proposal row is already the truth
 *  and the card handler is idempotent, so a missed flip self-heals on any later claim.
 *  `apply`→approved, `dismiss`→rejected. */
export async function reconcileProposalCard(proposal: PlanChangeProposal, action: 'apply' | 'dismiss'): Promise<void> {
  if (!proposal.approvalId) return;
  try {
    await resolveApproval(proposal.approvalId, { status: action === 'apply' ? 'approved' : 'rejected' });
  } catch (err) {
    log.warn('kicktodo_proposal_card_reconcile_deferred', {
      proposalId: proposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function listProposalsFor(tenantId: string, enrollmentId: string): Promise<PlanChangeProposal[]> {
  return (await proposals.listByPrefix(`${tenantId}::${enrollmentId}::`)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** ONLY the participant resolves a proposal: apply (→ the existing
 *  plan-revision path) or dismiss. */
/**
 * ADR 0501 step 4 — what accepting this proposal WOULD do, before deciding.
 *
 * A DISCRIMINATED UNION, not `PlanChange[]`, and the reason is the whole point of this
 * step. `previewRevisionCommands` returns one change per command, so a proposal with NO
 * commands and a proposal whose commands produce nothing would both surface as `[]` — and
 * an empty compare reads as "no changes to your plan", which is a confident answer the
 * system did not earn. That is `proposalApplied: 'Applied'` moved one step earlier in the
 * flow: the same defect, in the same feature, wearing a different hat.
 *
 *   'advice-only'  the proposal carries prose and nothing executable. There is nothing to
 *                  preview and `resolveProposal` will REFUSE to apply it. Distinct at the
 *                  type level so no caller can render it as an empty diff.
 *   'changes'      the real dry-run: zero writes, and `previewRevisionCommands` shares the
 *                  authority predicate, the closed-world validator AND the move-lane
 *                  guards with the apply path, so a preview can never show what apply
 *                  would refuse.
 *
 * Deliberately NOT a guarantee. Re-validation at accept is what actually protects the
 * participant — the plan can move between preview and decision (a card substituted, a day
 * already recovered). ADR 0501 notes no vendor documents staleness for suggestions; this
 * is where re-validating at decision time puts us ahead, and the preview must not imply
 * it is the thing providing that protection.
 */
export type ProposalPreview =
  | { kind: 'advice-only' }
  | { kind: 'changes'; changes: Awaited<ReturnType<typeof previewRevisionCommands>>['changes'] };

export async function previewProposal(
  tenantId: string,
  enrollmentId: string,
  proposalId: string,
  participantSubject: string,
): Promise<ProposalPreview> {
  // Same ownership boundary as resolveProposal, for the same reason: a preview leaks the
  // coach's note and the plan's shape, so it is the participant's to see and nobody
  // else's. A uniform 404 (not 403) keeps proposal existence unobservable to a stranger.
  const enrollment = await getEnrollment(tenantId, enrollmentId);
  if (!enrollment || enrollment.ownerSubject !== participantSubject) throw new CircleDeniedError();
  const p = await proposals.get(`${tenantId}::${enrollmentId}::${proposalId}`);
  if (!p) throw new CircleDeniedError();
  if (!p.commands || p.commands.length === 0) return { kind: 'advice-only' };
  // Subject is the PARTICIPANT — they are the one who would execute it. Identical to the
  // apply path, so the preview's authority check cannot diverge from the apply's.
  const { changes } = await previewRevisionCommands(tenantId, {
    enrollmentId,
    subject: participantSubject,
    commands: p.commands,
  });
  return { kind: 'changes', changes };
}

export async function resolveProposal(
  tenantId: string,
  enrollmentId: string,
  proposalId: string,
  participantSubject: string,
  action: 'apply' | 'dismiss',
): Promise<PlanChangeProposal> {
  const enrollment = await getEnrollment(tenantId, enrollmentId);
  if (!enrollment || enrollment.ownerSubject !== participantSubject) throw new CircleDeniedError();
  const p = await proposals.get(`${tenantId}::${enrollmentId}::${proposalId}`);
  if (!p) throw new CircleDeniedError();
  if (p.state !== 'proposed') return p; // idempotent
  if (action === 'apply') {
    // ADR 0501 step 3 — route through the ONE execution seam, with the PARTICIPANT as
    // the acting subject. This is the whole point of the trust model: a coach advises,
    // the participant executes on their own enrollment. `applyRevisionCommands`
    // re-checks `hasKicktodoEnrollmentAuthority(tenantId, enrollmentId, subject)`, which
    // the ownership check above already established — so the coach never gains an
    // execution path, and the authority boundary is enforced twice.
    //
    // Re-validated HERE, at decision time, not trusted from the stored row: the plan may
    // have moved since the coach wrote it (a card substituted, a day already recovered),
    // and a lane refusal must surface as a typed failure rather than a silent no-op.
    if (!p.commands || p.commands.length === 0) {
      // KT-HONESTY-1, structurally closed. A prose-only proposal has NOTHING to execute.
      // The old code ran `applyPlanRevision` here — a generic re-materialization from the
      // PARTICIPANT'S OWN settings that ignored the coach's note entirely — and then
      // stored `state: 'applied'`. The CTA lied for a second; that stored string lied
      // forever, to a participant reading their history weeks later.
      //
      // Refusing is the honest answer, and it must be a typed refusal rather than a
      // no-op success: a silent no-op would still persist 'applied'.
      throw new CohortError(
        'This proposal is advice only — it carries no plan changes to apply. Ask your coach to re-send it as a change, or dismiss it.',
      );
    }
    await applyRevisionCommands(tenantId, { enrollmentId, subject: participantSubject, commands: p.commands });
  }
  const next: PlanChangeProposal = { ...p, state: action === 'apply' ? 'applied' : 'dismissed', resolvedAt: nowIso() };
  await proposals.put(next);
  return next;
}

// ── ADR 0458 Phase 0 — compliance (subject erasure + retention) ──
/**
 * DSAR erasure for the cohort-owned subject-keyed rows:
 *  - the coach caseload POINTERS keyed by the subject (`granteeIndex`);
 *  - the subject's SEAT occupancy + reservation HOLDS (their participation in any
 *    cohort — a seat is re-derivable occupancy truth, not a money record; the money
 *    record is the commerce order, retained there);
 *  - PROPOSALS the subject authored as a coach (`coachSubject`, whose `note` is their
 *    free-text) AND proposals ABOUT the subject's own enrollments (which would
 *    otherwise orphan once kicktodo-core deletes those enrollments);
 *  - the approval CARD COPIES of that note (`createKicktodoPlanProposalApproval` copies
 *    it into `planProposal.note` + the rendered `proposal`, and the approvals store has
 *    no age-out for pending rows): as COACH the note is redacted in place (the card
 *    stays decidable for the still-present participant); as PARTICIPANT
 *    (`approverRefs[0]`) their cards are deleted outright.
 * `subjectEnrollmentIds` is resolved by the caller (compliance.ts, via kicktodo-core)
 * so this module never re-reads the core enrollment store. Idempotent; fail-closed on
 * a falsy tenant/subject. Deliberately leaves `cohorts` detail (operational capacity,
 * keyed by circle — self-heals via `reconcileSeats` once the grant is gone).
 */
export async function eraseSubjectCohortData(
  tenantId: string,
  subjectKey: string,
  subjectEnrollmentIds: readonly string[],
): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const ownEnrollments = new Set(subjectEnrollmentIds);
  for (const ptr of await granteeIndex.listByPrefix(`${subjectKey}::`)) {
    if (ptr.tenantId === tenantId && ptr.granteeSubject === subjectKey) {
      await granteeIndex.delete(`${ptr.granteeSubject}::${ptr.circleId}`);
    }
  }
  for (const s of await seats.listByPrefix(`${tenantId}::`)) {
    if (s.tenantId === tenantId && s.subject === subjectKey) {
      await seats.delete(`${s.tenantId}::${s.circleId}::${s.subject}`);
    }
  }
  for (const h of await holds.listByPrefix(`${tenantId}::`)) {
    if (h.tenantId === tenantId && h.buyerSubject === subjectKey) {
      await holds.delete(`${h.tenantId}::${h.circleId}::${h.buyerSubject}`);
    }
  }
  for (const p of await proposals.listByPrefix(`${tenantId}::`)) {
    if (p.tenantId !== tenantId) continue;
    if (p.coachSubject === subjectKey || ownEnrollments.has(p.enrollmentId)) {
      await proposals.delete(PROPOSAL_KEY(p));
    }
  }
  // ADR 0459 grade-fix / ADR 0464 — reach the plan-proposal APPROVAL copies of the
  // note. The proposal-row deletes above don't touch the approvals store, so without
  // this the coach's free-text survives on pending cards (which never age out). Now
  // driven by the store's redactor registry (kind-scoped here): as COACH → redact
  // both note copies in place; as PARTICIPANT (approverRefs[0]) → delete the cards.
  await erasePlanProposalApprovalsForSubject(tenantId, subjectKey);
}

/** Time-based retention (ADR 0077 seam): delete this tenant's coach proposals whose
 *  `createdAt` (a proposal is resolved-in-place, not renewed; its authored `note` is
 *  the stale PII) is strictly older than the cutoff. Bounded tenant-prefix scan;
 *  fail-closed on a falsy tenant. */
export async function purgeProposalsByAge(tenantId: string, cutoffIso: string): Promise<PurgeOutcome> {
  return purgeRowsByAge('kicktodo-accountability', await proposals.listByPrefix(`${tenantId}::`), tenantId, cutoffIso,
    (p) => ({ tenantId: p.tenantId, updatedAt: p.createdAt, id: PROPOSAL_KEY(p) }),
    (id) => proposals.delete(id));
}
