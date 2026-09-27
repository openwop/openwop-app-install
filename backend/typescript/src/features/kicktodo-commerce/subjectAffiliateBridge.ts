/**
 * Subject ⇄ affiliate-code bridge (ADR 0451 P1). A KickTodo referrer is an
 * opaque subject (ADR 0426); the commerce affiliate lane keys on a string
 * `code` and has no subject/owner column. This sidecar maps a referrer subject
 * to an affiliate code so an inviter becomes an affiliate WITHOUT a second money
 * system — the same "make the system more capable, not a second copy" ethic the
 * ADR 0449 subject→contact bridge follows (this mirrors its `link/resolve`
 * shape). No new ledger, no `Affiliate` schema change.
 *
 * The affiliate `code` is DERIVED from the subject (deterministic) so a re-mint
 * is idempotent, and a REVERSE index (`code → subject`) backs the P2
 * self-referral guard (refuse to credit a buyer for their own link). Collision
 * safety: the code is a truncated sha256 of `${tenant}::${subject}` — if a
 * candidate code is already claimed by a DIFFERENT subject, we disambiguate with
 * a bounded suffix loop, so two subjects can never share one code.
 *
 * Privacy: rows store the opaque subject + the affiliate id/code only — never
 * PII — and are tenant-in-content + `tenantOf` (KTD-1 purge-safe).
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { createAffiliate, affiliateByCode, type Affiliate } from '../commerce/affiliate.js';
import { resolveContactForSubject } from '../kicktodo-core/contactBridgeService.js';
import { OpenwopError } from '../../types.js';

const log = createLogger('kicktodo.subject-affiliate');

export interface SubjectAffiliateLink {
  tenantId: string;
  ownerSubject: string;
  orgId: string;
  affiliateId: string;
  code: string;
  createdAt: string;
}

interface CodeSubjectIndex {
  tenantId: string;
  code: string;
  ownerSubject: string;
  affiliateId: string;
}

/** Forward: the referrer subject → its affiliate. First-write-wins per (tenant, subject). */
const links = new DurableCollection<SubjectAffiliateLink>(
  'kicktodo-subject-affiliate',
  (l) => `${l.tenantId}::${l.ownerSubject}`,
  undefined,
  (l) => l.tenantId, // KTD-1 purge-safe
);

/** Reverse: affiliate code → the referrer subject (backs the self-referral guard). */
const codeIndex = new DurableCollection<CodeSubjectIndex>(
  'kicktodo-affiliate-code-subject',
  (c) => `${c.tenantId}::${c.code}`,
  undefined,
  (c) => c.tenantId, // KTD-1 purge-safe
);

const nowIso = (): string => new Date().toISOString();

/** Deterministic base code for a subject: `KT-<12 hex of sha256(tenant::subject)>`.
 *  URL-safe, uppercased, stable across re-mints. 48 bits — collisions are handled
 *  by the disambiguation loop, never by cross-attribution. */
function baseCodeFor(tenantId: string, ownerSubject: string): string {
  const h = createHash('sha256').update(`${tenantId}::${ownerSubject}`).digest('hex').slice(0, 12).toUpperCase();
  return `KT-${h}`;
}

/**
 * Resolve (or lazily mint) the affiliate for a referrer subject. Idempotent:
 * a subject always resolves to the SAME affiliate. Returns the link. The
 * `orgId` is the commerce org the referred purchase will settle in (the
 * challenge's Product org) — the affiliate must live in that org so the
 * checkout `ref → affiliateCodeExists(tenant, org, code)` path resolves it.
 */
export async function ensureAffiliateForSubject(
  tenantId: string,
  orgId: string,
  ownerSubject: string,
): Promise<SubjectAffiliateLink> {
  const existing = await links.get(`${tenantId}::${ownerSubject}`);
  if (existing) return existing;

  // Find a code this subject can own: the deterministic base, else a bounded
  // suffix if some OTHER subject already claimed it (hash collision or a manual
  // KT- code). We never adopt a code the reverse index binds to another subject.
  const base = baseCodeFor(tenantId, ownerSubject);
  let affiliate: Affiliate | null = null;
  let chosenCode = base;
  for (let attempt = 0; attempt < 8 && !affiliate; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const boundTo = await codeIndex.get(`${tenantId}::${candidate}`);
    if (boundTo && boundTo.ownerSubject !== ownerSubject) continue; // owned by someone else → try next
    if (boundTo && boundTo.ownerSubject === ownerSubject) {
      // Reverse index already binds this code to us but the forward link was
      // missing (a partial prior run) — adopt the existing affiliate.
      const adopted = await affiliateByCode(tenantId, orgId, candidate);
      if (adopted) {
        affiliate = adopted;
        chosenCode = candidate;
        break;
      }
      // grade-fix: a STALE reverse-index entry (the affiliate row is gone —
      // deleted or a partial prior run) must NOT brick minting forever. Fall
      // through to re-create the affiliate for this same candidate code below,
      // self-healing the dangling index instead of throwing 409 on every retry.
    }
    try {
      affiliate = await createAffiliate({
        tenantId, orgId, code: candidate, name: `KickTodo referrer`,
        commissionType: 'percentage', commissionRate: 0, // referral rate = the affiliate row's rate (OQ1); 0 until an operator sets it
      });
      chosenCode = candidate;
    } catch (err) {
      // 409 = the code exists in commerce but our reverse index didn't know it
      // (e.g. an operator hand-created a KT- code). Don't hijack it — disambiguate.
      if (err instanceof OpenwopError && err.httpStatus === 409) continue;
      throw err;
    }
  }
  if (!affiliate) {
    log.error('kicktodo_affiliate_code_exhausted', { ownerSubject, base });
    throw new OpenwopError('conflict', 'Could not mint a unique referral code.', 409, {});
  }

  const link: SubjectAffiliateLink = {
    tenantId, ownerSubject, orgId, affiliateId: affiliate.affiliateId, code: chosenCode, createdAt: nowIso(),
  };
  // grade-fix: first-write-wins via a real CAS (insert-if-absent), not a
  // read-then-blind-put (which is a TOCTOU — `DurableCollection.put` is
  // last-writer-wins). A concurrent same-subject mint therefore yields exactly
  // ONE forward link, and ONLY the winner writes the reverse index — so a
  // subject can never end up with two codes/identities. The loser's already-
  // created affiliate row is a benign orphan (rate 0, absent from the reverse
  // index, so it can never cross-attribute); the residual duplicate-code
  // possibility is the pre-existing non-CAS `createAffiliate` uniqueness check,
  // out of this bridge's scope.
  const claimed = await links.compareAndSwap(null, link);
  if (!claimed) {
    const winner = await links.get(`${tenantId}::${ownerSubject}`);
    if (winner) return winner; // a concurrent mint won — keep the first binding
  }
  await codeIndex.put({ tenantId, code: chosenCode, ownerSubject, affiliateId: affiliate.affiliateId });
  log.info('kicktodo_affiliate_linked', { ownerSubject, code: chosenCode });
  return link;
}

/** The referrer subject behind an affiliate code, or null. Backs the P2
 *  self-referral guard: refuse to credit a buyer for a code that maps to
 *  themselves. Fail-closed (null when the code is not a KickTodo referral code). */
export async function resolveSubjectForAffiliateCode(tenantId: string, code: string): Promise<string | null> {
  const row = await codeIndex.get(`${tenantId}::${code.trim().toUpperCase()}`);
  return row?.ownerSubject ?? null;
}

/** True when an order's affiliate code maps back to the BUYER — a self-referral
 *  (an inviter buying through their own link). ADR 0451 P2 registers this as a
 *  commerce accrual-veto guard so a self-referral never accrues commission (the
 *  affiliate analogue of the enroll-side `inviterSubject === ownerSubject` check).
 *  Only blocks a genuine KickTodo referral code; a non-KickTodo code resolves to
 *  null ⇒ not a self-referral ⇒ never blocks another feature's commission.
 *
 *  Two match paths (ADR 0451 P2b closed the original LEV-3 guest-checkout hole):
 *  (1) AUTHENTICATED self — `order.createdBy` is the referrer's own subject;
 *  (2) GUEST-checkout self — a public checkout has no subject, but it links the
 *      buyer's email to a CONTACT, so we match the referrer's own linked Contact
 *      against the buyer's `order.contactId` (same person, same email).
 *  Residual: a guest self-referral where the buyer used a DIFFERENT email than
 *  their linked Contact (no contact match, no subject) still isn't caught — the
 *  enroll-side guard and the rate-0 default remain the backstops. */
export async function isSelfReferralAccrual(order: { tenantId: string; createdBy?: string; contactId?: string; affiliateCode?: string }): Promise<boolean> {
  if (!order.affiliateCode) return false;
  const referrer = await resolveSubjectForAffiliateCode(order.tenantId, order.affiliateCode);
  if (referrer === null) return false; // not a KickTodo referral code
  // (1) Authenticated self: the buyer subject IS the referrer.
  if (order.createdBy && referrer === order.createdBy) return true;
  // (2) Guest-checkout self (ADR 0451 P2b, closes the LEV-3 hole): a public
  //     checkout has no subject, but it links the buyer's email to a CONTACT.
  //     If the referrer's own linked Contact equals the buyer's, it's the same
  //     person buying through their own link — refuse the accrual.
  if (order.contactId) {
    const referrerContact = await resolveContactForSubject(order.tenantId, referrer);
    if (referrerContact !== null && referrerContact === order.contactId) return true;
  }
  return false;
}

/** The subject's affiliate link, READ-ONLY (never mints — unlike
 *  `ensureAffiliateForSubject`). Null when the subject has never referred. */
export async function getAffiliateLinkForSubject(tenantId: string, ownerSubject: string): Promise<SubjectAffiliateLink | null> {
  return (await links.get(`${tenantId}::${ownerSubject}`)) ?? null;
}

export interface ReferralEarnings {
  /** The referrer's affiliate code, or null if they've never referred. */
  code: string | null;
  /** Live accrued commission owed (major units; the obligation-ledger projection). */
  balanceOwed: number;
  currency: string;
}

/** ADR 0451 P3 — a referrer's referral earnings for their OWN surface: resolve
 *  their affiliate link (read-only) → the affiliate's live `balanceOwed` (a
 *  ledger projection, ADR 0447). Zero + null code when they've never referred.
 *  Advisory (host never moves money); the operator settles via the payout run. */
export async function referralEarningsForSubject(tenantId: string, ownerSubject: string): Promise<ReferralEarnings> {
  const link = await getAffiliateLinkForSubject(tenantId, ownerSubject);
  if (!link) return { code: null, balanceOwed: 0, currency: 'USD' };
  const aff = await affiliateByCode(tenantId, link.orgId, link.code);
  return { code: link.code, balanceOwed: aff?.balanceOwed ?? 0, currency: aff?.currency ?? 'USD' };
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
/**
 * DSAR erasure: drop the subject↔affiliate-code linkage (the forward
 * `subject → affiliate` row and the reverse `code → subject` index). This severs the
 * PERSONAL linkage; the commerce `Affiliate` row itself is a money record (it carries
 * the earned-commission balance) and lives in the commerce package — it is NOT this
 * bridge's to destroy, and survives un-attributed to a person (the money-truth rule).
 * Idempotent; fail-closed on a falsy tenant/subject.
 */
export async function eraseSubjectAffiliateLinks(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  await links.delete(`${tenantId}::${subjectKey}`);
  for (const c of await codeIndex.listForTenantIndexed(tenantId)) {
    if (c.tenantId === tenantId && c.ownerSubject === subjectKey) {
      await codeIndex.delete(`${c.tenantId}::${c.code}`);
    }
  }
}

/** Test-only reset. */
export async function __resetSubjectAffiliateBridge(): Promise<void> {
  await links.__clear();
  await codeIndex.__clear();
}
