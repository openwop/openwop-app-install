/**
 * ADR 0541 — the apply grant: bounded, revocable, attributable standing consent.
 *
 * `computer-use` gates every `commit`-class action (submit/purchase/download)
 * behind a per-action human approval. Auto-apply's premise is submitting without
 * one. The tempting move — a second browser driver not bound by that gate — is
 * the parallel-architecture violation the whole boundaries audit exists to
 * prevent. So instead the gate CONSULTS an authority object, and everything the
 * grant does not cover falls back to per-action approval exactly as today.
 *
 * This lives in `host/` rather than in the feature because it is an authority
 * object the commit gate consults; core must not import a feature to ask whether
 * an action is authorised.
 *
 * ## Every field is a bound
 *
 * A grant with no ceiling, no scope, or no expiry is not a grant — it is the
 * gate turned off wearing a grant's name. `createApplyGrant` therefore REFUSES
 * such input rather than defaulting it, because a defaulted bound is one nobody
 * chose.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { appendAudit } from './auditChainService.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

/** Which submission tiers a grant covers. `A` = documented API (no browser);
 *  `B` = a driven form; `C` is NEVER grantable — it is the human's by definition. */
export type ApplyTier = 'A' | 'B';

export interface ApplyGrant {
  grantId: string;
  tenantId: string;
  orgId: string;
  /** WHOSE applications (RFC 0048 opaque id) — the applicant, not the operator. */
  subjectId: string;
  /** WHO authorised it. Always a person: a grant minted by an agent would be an
   *  agent authorising itself. */
  grantedBy: string;
  campaignId: string;
  /** Hard ceiling on AUTOMATIC submissions. */
  maxSubmits: number;
  submitsUsed: number;
  /** Hard ceiling on tier-C items PARKED for the human. Two ceilings because two
   *  things need bounding: a user must never discover that "auto-apply" quietly
   *  became a 40-item review backlog. */
  maxPrepared: number;
  preparedUsed: number;
  /** Pacing. Velocity — not volume — is what correlates with auto-rejection and
   *  DNC flagging, so the grant carries a rate and not only a total. */
  ratePerHour: number;
  /**
   * The pace window (WF-JS-1 P1a). `paceHour` is the epoch-hour
   * (`floor(now / 3_600_000)`) of the most recent consumption; `paceUsed` counts
   * consumptions inside that hour. Both optional so pre-existing grant rows stay
   * valid — an absent window reads as "nothing spent this hour".
   *
   * This existed as a STORED number with no enforcement — the Authority UI
   * promised "at most N per hour" and nothing kept the promise (the exact
   * dishonesty ADR 0544 exists to forbid). Enforced in `consultApplyGrant`
   * (read: refusal `paced`) and inside `consumeSubmit`'s CAS (write: the same
   * compare-and-swap that spends the unit advances the window, so two racing
   * consumers cannot both fit into the hour's last slot).
   */
  paceHour?: number;
  paceUsed?: number;
  tiers: ApplyTier[];
  /** Scope: these origins only. */
  origins: string[];
  resumePolicy: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}

export const applyGrants = new DurableCollection<ApplyGrant>(
  'job-search:apply-grant',
  (g) => `${g.tenantId}:${g.grantId}`,
  undefined,
  (g) => g.tenantId,
);

/** Deterministic submission claims — `(subjectId, canonicalListingId)`. CAS-claimed
 *  BEFORE the send, so a duplicate application is refused at the store rather than
 *  discovered at the employer (D3b). */
interface SubmissionClaim {
  claimKey: string;
  tenantId: string;
  subjectId: string;
  listingId: string;
  grantId: string;
  claimedAt: string;
}

export const submissionClaims = new DurableCollection<SubmissionClaim>(
  'job-search:submission-claim',
  (c) => c.claimKey,
  undefined,
  (c) => c.tenantId,
);

export interface CreateApplyGrantInput {
  tenantId: string;
  orgId: string;
  subjectId: string;
  grantedBy: string;
  campaignId: string;
  maxSubmits: number;
  maxPrepared: number;
  ratePerHour: number;
  tiers?: ApplyTier[];
  origins: string[];
  resumePolicy: string;
  expiresAt: string;
}

const positiveInt = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
    throw new OpenwopError('validation_error', `${field} must be a positive integer — a grant without a ceiling is not a grant.`, 400, { field });
  }
  return v;
};

/**
 * Mint a grant. Every bound is mandatory and validated; nothing is defaulted.
 *
 * `tiers` defaults to `['A']` — and that is the ONE default, because it is the
 * conservative direction (documented APIs, no browser). Tier B is opt-in, and
 * tier C is not representable here at all: the type has no 'C'.
 */
export async function createApplyGrant(input: CreateApplyGrantInput): Promise<ApplyGrant> {
  const origins = Array.isArray(input.origins) ? input.origins.filter((o) => typeof o === 'string' && o.trim() !== '') : [];
  if (origins.length === 0) {
    throw new OpenwopError('validation_error', 'origins must be non-empty — an unscoped grant is the gate turned off.', 400, { field: 'origins' });
  }
  const expiresMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    throw new OpenwopError('validation_error', 'expiresAt must be an ISO timestamp — a grant always dies.', 400, { field: 'expiresAt' });
  }
  if (!input.grantedBy || !input.subjectId || !input.campaignId) {
    throw new OpenwopError('validation_error', 'subjectId, grantedBy and campaignId are required — a grant must be attributable.', 400, {});
  }

  const grant: ApplyGrant = {
    grantId: `grant:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    subjectId: input.subjectId,
    grantedBy: input.grantedBy,
    campaignId: input.campaignId,
    maxSubmits: positiveInt(input.maxSubmits, 'maxSubmits'),
    submitsUsed: 0,
    maxPrepared: positiveInt(input.maxPrepared, 'maxPrepared'),
    preparedUsed: 0,
    ratePerHour: positiveInt(input.ratePerHour, 'ratePerHour'),
    tiers: input.tiers && input.tiers.length > 0 ? [...input.tiers] : ['A'],
    origins,
    resumePolicy: input.resumePolicy,
    expiresAt: new Date(expiresMs).toISOString(),
    createdAt: new Date().toISOString(),
  };
  await applyGrants.put(grant);
  return grant;
}

export type GrantRefusal =
  | 'replay'
  | 'no-grant'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  /** The hour's `ratePerHour` budget is spent — try again next window. Pacing is
   *  the anti-flagging property the grant SELLS (ADR 0544), so it refuses like
   *  any other ceiling rather than queueing silently. */
  | 'paced'
  | 'out-of-scope'
  | 'wrong-class'
  | 'wrong-tier';

export interface GrantDecision {
  allowed: boolean;
  /** Why not. Every refusal falls back to per-action approval — a caller must
   *  NOT branch differently on the reason, and it exists for the audit row. */
  refusal: GrantRefusal | null;
  grantId: string | null;
}

/** Action classes the commit gate recognises. Only `submit` is ever grantable. */
export type CommitClass = 'submit' | 'purchase' | 'download' | 'new-origin' | 'credential';

export interface ConsultInput {
  tenantId: string;
  subjectId: string;
  campaignId: string;
  origin: string;
  commitClass: CommitClass;
  tier: ApplyTier | 'C';
  now: number;
  /**
   * ADR 0541 D4 — is this a replayed or forked run?
   *
   * A replay must not spend grant units and must not re-submit. `computer-use`
   * already reads the recorded trajectory rather than re-driving, and ADR 0531's
   * effect suppression is the backstop; this is the grant's OWN refusal, so the
   * property holds even if a caller reaches the grant by another path.
   *
   * Deliberately a REQUIRED-by-convention input rather than something inferred
   * here: the grant cannot see the run, and guessing would be worse than being
   * told. Callers on the live path pass `false`.
   */
  isReplay?: boolean;
  /**
   * JS-LANE-1 — the DISCOVERY scan hoisted, nothing else. A campaign run
   * consults once per submittable item with constant (subject, campaign), so
   * N items used to cost N tenant-wide scans returning the same candidates.
   * A caller may prefetch the candidate GRANT IDS once and pass them here;
   * consult still re-reads every row FRESH by point lookup, so revocation,
   * expiry, exhaustion and the pace window are exactly as live as before —
   * only the scan is skipped. Rows are re-filtered by (subject, campaign)
   * after the read, so a wrong id cannot cross subjects.
   */
  candidateGrantIds?: readonly string[];
}

const REFUSED = (refusal: GrantRefusal): GrantDecision => ({ allowed: false, refusal, grantId: null });

/** The pace window's quantum. Epoch-hour rather than a rolling window on
 *  purpose: it is deterministic from `now` alone (replay-safe — no hidden
 *  read-time state), and the worst case (a burst at :59 and another at :01)
 *  still bounds any 2-hour span at 2×`ratePerHour`, which is the property the
 *  anti-flagging evidence actually needs. */
const epochHour = (now: number): number => Math.floor(now / 3_600_000);

/** True when this grant's current epoch-hour budget is spent. */
function paceWindowFull(g: ApplyGrant, now: number): boolean {
  return g.paceHour === epochHour(now) && (g.paceUsed ?? 0) >= g.ratePerHour;
}

/**
 * Does a grant authorise this action? Read-only — the decrement is separate and
 * explicit (D3), so a caller cannot accidentally consume budget by asking.
 *
 * Every negative answer is the SAME outcome for the caller: per-action approval,
 * exactly as before grants existed. Missing, expired, revoked, exhausted,
 * out-of-scope and wrong-class are indistinguishable in effect.
 */
export async function consultApplyGrant(input: ConsultInput): Promise<GrantDecision> {
  // ADR 0541 D4 — replay/fork can never consume budget or re-submit. Refused
  // FIRST, before any store read, so a replayed run cannot even observe which
  // grants exist.
  if (input.isReplay) return REFUSED('replay');
  // `purchase` is NEVER grantable. A grant covers submitting an application; it
  // can never authorise spending money, and checking the class first makes that
  // structural rather than a convention someone can forget.
  if (input.commitClass !== 'submit') return REFUSED('wrong-class');
  // Tier C is the human's by definition and has no representation in `tiers`.
  if (input.tier === 'C') return REFUSED('wrong-tier');

  const all = input.candidateGrantIds
    ? (await Promise.all(input.candidateGrantIds.map((id) => applyGrants.get(`${input.tenantId}:${id}`)))).filter(
        (g): g is ApplyGrant => g !== null,
      )
    : await applyGrants.listByPrefix(`${input.tenantId}:`);
  const candidates = all.filter(
    (g) => g.subjectId === input.subjectId && g.campaignId === input.campaignId,
  );
  if (candidates.length === 0) return REFUSED('no-grant');

  let sawScope = false;
  for (const g of candidates) {
    if (!g.origins.includes(input.origin)) continue;
    sawScope = true;
    if (!g.tiers.includes(input.tier)) continue;
    if (g.revokedAt) return REFUSED('revoked');
    if (Date.parse(g.expiresAt) <= input.now) return REFUSED('expired');
    if (g.submitsUsed >= g.maxSubmits) return REFUSED('exhausted');
    // Pace (P1a): the current epoch-hour's budget. Read-only here — the
    // authoritative decrement is `consumeSubmit`'s CAS; this check exists so a
    // caller learns `paced` BEFORE claiming/preparing, the same way `exhausted`
    // stops it before work rather than after.
    if (paceWindowFull(g, input.now)) return REFUSED('paced');
    return { allowed: true, refusal: null, grantId: g.grantId };
  }
  return REFUSED(sawScope ? 'wrong-tier' : 'out-of-scope');
}

/**
 * Consume one submit unit through a compare-and-swap, BEFORE the work (D3).
 *
 * Order matters: a crash mid-flight costs one unit and loses nothing, whereas
 * decrementing after the send would let a retry storm run past the ceiling. The
 * ceiling is a TRUE ceiling, not an average.
 */
export async function consumeSubmit(tenantId: string, grantId: string, now: number, dealId?: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await applyGrants.get(`${tenantId}:${grantId}`);
    if (!current) return false;
    if (current.revokedAt) return false;
    if (Date.parse(current.expiresAt) <= now) return false;
    if (current.submitsUsed >= current.maxSubmits) return false;
    // Pace (P1a): refused INSIDE the CAS loop, against the row the swap will be
    // compared to — two consumers racing for the hour's last slot serialize on
    // the CAS, so at most `ratePerHour` can ever land in one epoch-hour.
    if (paceWindowFull(current, now)) return false;
    const hour = epochHour(now);
    const next: ApplyGrant = {
      ...current,
      submitsUsed: current.submitsUsed + 1,
      paceHour: hour,
      paceUsed: current.paceHour === hour ? (current.paceUsed ?? 0) + 1 : 1,
    };
    const ok = await applyGrants.compareAndSwap(current, next);
    if (ok) {
      // D5 — every consumption is attributable and visible. Written AFTER the
      // successful CAS so the ledger records units actually spent, never units
      // a lost race merely attempted.
      await appendAudit(tenantId, 'job-search.grant.consumed', {
        grantId: current.grantId,
        subjectId: current.subjectId,
        grantedBy: current.grantedBy,
        campaignId: current.campaignId,
        origins: current.origins,
        unit: 'submit',
        submitsUsed: next.submitsUsed,
        maxSubmits: next.maxSubmits,
        ...(dealId ? { dealId } : {}),
      });
      return true;
    }
  }
  // Six lost races means real contention. Refusing is the safe direction: an
  // un-decremented submit would be one over the ceiling.
  return false;
}

/** Consume one PREPARED unit (the tier-C backlog ceiling). */
export async function consumePrepared(tenantId: string, grantId: string, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await applyGrants.get(`${tenantId}:${grantId}`);
    if (!current) return false;
    if (current.revokedAt) return false;
    if (Date.parse(current.expiresAt) <= now) return false;
    if (current.preparedUsed >= current.maxPrepared) return false;
    const ok = await applyGrants.compareAndSwap(current, { ...current, preparedUsed: current.preparedUsed + 1 });
    if (ok) return true;
  }
  return false;
}

/**
 * Claim a submission for `(subjectId, listingId)` (D3b).
 *
 * Returns false when already claimed. A retry, re-dispatch or fork therefore
 * cannot produce a second application — the duplicate is refused at the store
 * rather than discovered at the employer, which is the single most embarrassing
 * failure mode this product has.
 */
export async function claimSubmission(
  tenantId: string,
  subjectId: string,
  listingId: string,
  grantId: string,
): Promise<boolean> {
  const claimKey = `${tenantId}:${subjectId}:${listingId}`;
  const claim: SubmissionClaim = { claimKey, tenantId, subjectId, listingId, grantId, claimedAt: new Date().toISOString() };
  // Insert-if-absent: `expected: null` is the CAS that makes two concurrent
  // claimants resolve to exactly one winner. Deliberately NO read-then-write
  // here — a get() followed by a put() is the TOCTOU this exists to close, and
  // it is precisely the race a retry storm produces.
  return submissionClaims.compareAndSwap(null, claim);
}

/**
 * Release a claim that never became an application (grade-trio finding 1).
 *
 * `claimSubmission` runs BEFORE the outside effect, and two later exits
 * (deal-creation refusal, board rejection) used to leave the claim held
 * forever — every later campaign pass then reported `already-applied` for a
 * job that was NEVER sent, the exact silent-skip class D6 forbids. Guarded
 * on the claiming grantId so a losing path's cleanup can never delete a
 * concurrent winner's claim.
 */
export async function releaseSubmission(
  tenantId: string,
  subjectId: string,
  listingId: string,
  grantId: string,
): Promise<boolean> {
  const claimKey = `${tenantId}:${subjectId}:${listingId}`;
  const current = await submissionClaims.get(claimKey);
  if (!current || current.grantId !== grantId) return false;
  await submissionClaims.delete(claimKey);
  return true;
}

/**
 * Revoke immediately. Revocation does not require the campaign to stop (D5).
 *
 * `orgId` is REQUIRED and checked. The key is tenant-scoped, so a cross-TENANT
 * id was already unreachable — but a grant also carries an org, and without this
 * check a caller authorised on org A could revoke org B's grant inside the same
 * tenant. The list route filters on `orgId`; revoke must agree with it, or read
 * and write disagree about who owns a grant. (Found by `/code-review`.)
 */
export async function revokeApplyGrant(tenantId: string, orgId: string, grantId: string, now: number): Promise<boolean> {
  const current = await applyGrants.get(`${tenantId}:${grantId}`);
  if (!current || current.revokedAt) return false;
  // Same 404 as "not found" — a caller must not learn that a grant exists in an
  // org they cannot see.
  if (current.orgId !== orgId) return false;
  return applyGrants.compareAndSwap(current, { ...current, revokedAt: new Date(now).toISOString() });
}


/**
 * ADR 0464 — subject erasure.
 *
 * Both stores are keyed to a PERSON: a grant is standing authority over a named
 * subject's applications, and a claim records that this subject applied to this
 * listing. Neither is a candidate for a "no subject" exemption.
 *
 * They are DELETED rather than redacted. A grant is an authorisation to act on
 * someone's behalf; leaving a tombstone that still authorises anything would be
 * worse than useless, and a redacted grant with an erased subject could not be
 * matched to a person to be honoured OR refused. The claim is deleted for the
 * same reason: its only purpose is to prevent a duplicate application for a
 * subject who no longer exists here.
 */
export async function eraseSubjectApplyGrants(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const g of await applyGrants.listByPrefix(`${tenantId}:`)) {
    // `grantedBy` too: the authoriser is also a person, and an erased grantor
    // must not be left named on a live authority record.
    if (!forms.has(g.subjectId) && !forms.has(g.grantedBy)) continue;
    await applyGrants.delete(`${g.tenantId}:${g.grantId}`);
  }
  for (const c of await submissionClaims.listByPrefix(`${tenantId}:`)) {
    if (!forms.has(c.subjectId)) continue;
    await submissionClaims.delete(c.claimKey);
  }
}

/**
 * WF-CONS-2 — registered from `registerHostSubjectErasers()` (the ONE explicit
 * host boot list), not at module scope.
 *
 * This module WAS the live instance of the defect that list exists to prevent:
 * it registered as an import side-effect, so an import-graph change could have
 * silently unregistered it — and `eraseSubject`'s `total: erasers.length`
 * against no expected set meant the loss would have read as `failed: 0`, i.e. a
 * clean erasure. Meanwhile the ADR 0464 coverage ledger claimed the two stores
 * it owns were covered BY it.
 */
export function registerApplyGrantErasure(): void {
  registerSubjectEraser(eraseSubjectApplyGrants);
}
