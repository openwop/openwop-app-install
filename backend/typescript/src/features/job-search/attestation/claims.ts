/**
 * ADR 0544 P1/D1 — the claim set: only facts this host can prove from its own
 * records.
 *
 * The market this enters is losing signal: application volume is up ~45%, mostly
 * from agents, and high-volume applicants get auto-rejected and silently flagged.
 * Every incumbent sells "more applications, faster", which degrades the channel
 * for everyone including its own buyers. The scarce good is credible INTENT, and
 * almost nobody can sell it, because proving intent needs an audit chain the
 * applicant cannot forge. This host has one for reasons unrelated to job search.
 *
 * ## A fabricated claim is unrepresentable, not merely untested
 *
 * Every claim variant REQUIRES a `SourceRef` — an audit `seq` + `entryHash`, or a
 * session step. There is no exported way to make a claim without one, and
 * `buildClaimSet` derives every claim by reading records rather than by being
 * told. So "attest that they were reviewed by a human" is not a thing a caller
 * can ask for; it is a thing the records either support or do not.
 *
 * The audit chain is hash-linked and `verifyChain` detects any after-the-fact
 * edit, so a source reference is checkable rather than decorative.
 *
 * ## Nothing subjective
 *
 * No "strong match", no "highly motivated". One unfalsifiable field would poison
 * the credibility of every falsifiable one beside it, which is the whole asset.
 */
import { listChain } from '../../../host/auditChainService.js';
import { applyGrants } from '../../../host/applyGrant.js';

/** Where a claim's evidence lives. Every claim carries one. */
export type SourceRef =
  | { kind: 'audit'; seq: number; entryHash: string }
  | { kind: 'grant'; grantId: string }
  | { kind: 'session'; sessionId: string; stepIndex: number };

/**
 * The closed claim vocabulary.
 *
 * `humanReviewed` is deliberately per-APPLICATION and only ever emitted where a
 * human actually decided. Under Tier-A autopilot no human sees the application,
 * so asserting review unconditionally — as an earlier draft of ADR 0544 did —
 * would make the claim most likely to be checked the one most likely to be a
 * lie, taking every other claim down with it.
 */
export type Claim =
  | { type: 'authorised-by-person'; grantedBy: string; campaignId: string; maxSubmits: number; source: SourceRef }
  | { type: 'applications-in-window'; count: number; windowStart: string; windowEnd: string; source: SourceRef }
  | { type: 'warm-path-ratio'; warm: number; total: number; source: SourceRef }
  | { type: 'human-reviewed'; dealId: string; source: SourceRef }
  | { type: 'resume-guarded'; dealId: string; source: SourceRef };

export interface ClaimSet {
  campaignId: string;
  /** Frozen at issuance (matrix row 9). Recomputing at read would let a LATER
   *  application silently change a claim someone already relied on. */
  issuedAt: string;
  claims: Claim[];
}

/** Audit kinds this reads. Narrow on purpose: a claim derived from a kind
 *  nobody writes would be a claim about nothing. */
const GRANT_CONSUMED = 'job-search.grant.consumed';

/**
 * Derive the claim set for a campaign from records.
 *
 * Note what this function does NOT take: any claim, count or assertion from the
 * caller. Its inputs are a tenant and a campaign; everything else is read. That
 * is what makes fabrication structurally impossible rather than merely
 * discouraged.
 */
export async function buildClaimSet(
  tenantId: string,
  campaignId: string,
  now: number,
): Promise<ClaimSet> {
  const chain = await listChain(tenantId);
  const consumptions = chain.filter(
    (e) => e.kind === GRANT_CONSUMED && (e.payload as { campaignId?: string }).campaignId === campaignId,
  );

  const claims: Claim[] = [];

  // 1. WHO authorised it. Always true when a grant exists, and the strongest
  //    claim available under autopilot: an employer reading "authorised by a
  //    named person under a bounded policy" gets a real signal — arguably better
  //    than "a human clicked submit", which any fast-clicking spammer can say.
  const grants = (await applyGrants.listByPrefix(`${tenantId}:`)).filter((g) => g.campaignId === campaignId);
  for (const g of grants) {
    claims.push({
      type: 'authorised-by-person',
      grantedBy: g.grantedBy,
      campaignId: g.campaignId,
      maxSubmits: g.maxSubmits,
      source: { kind: 'grant', grantId: g.grantId },
    });
  }

  // 2. HOW MANY, scoped to the campaign window — never a lifetime total (D2).
  //    A figure that only grows is not a signal, it is a countdown.
  if (consumptions.length > 0) {
    const first = consumptions[0]!;
    const last = consumptions[consumptions.length - 1]!;
    claims.push({
      type: 'applications-in-window',
      count: consumptions.length,
      windowStart: first.at,
      windowEnd: last.at,
      source: { kind: 'audit', seq: last.seq, entryHash: last.entryHash },
    });
  }

  return {
    campaignId,
    issuedAt: new Date(now).toISOString(),
    claims,
  };
}

/**
 * Is every claim in a set backed by a record that still exists and still hashes?
 *
 * Used by the tests and available to a verifier. A claim whose source no longer
 * verifies is not "slightly stale" — it is unproven, and the honest answer is to
 * say so rather than to keep showing it.
 */
export async function claimsAreBacked(tenantId: string, set: ClaimSet): Promise<boolean> {
  const chain = await listChain(tenantId);
  const bySeq = new Map(chain.map((e) => [e.seq, e]));
  const grantIds = new Set((await applyGrants.listByPrefix(`${tenantId}:`)).map((g) => g.grantId));
  for (const c of set.claims) {
    if (c.source.kind === 'audit') {
      const row = bySeq.get(c.source.seq);
      if (!row || row.entryHash !== c.source.entryHash) return false;
    } else if (c.source.kind === 'grant') {
      if (!grantIds.has(c.source.grantId)) return false;
    }
  }
  return true;
}

/**
 * Which campaign does this application belong to, and whose conduct is it?
 *
 * ADDED IN P4, closing a hole D1 claimed to have shut. D1 says a fabricated
 * claim is unrepresentable because `buildClaimSet` derives everything by reading
 * records. That is true WITHIN a campaign — and the P2 route then took
 * `campaignId` FROM THE REQUEST BODY, next to an unrelated `dealId`. So a caller
 * could attach any campaign's numbers to any application: pick the campaign with
 * the flattering count, cite it on an application it never sent. The builder
 * could not be lied to; the CALLER chose which truth to tell, which is the same
 * outcome by a different route. Nothing checked that the deal was ever submitted
 * at all, so an attestation could be minted for a `deal:` string typed by hand.
 *
 * The audit row written by `consumeSubmit` already carries `dealId`,
 * `campaignId` and `subjectId` together, hash-linked. Deriving all three from it
 * makes the deal↔campaign link a READ rather than an assertion, and makes "this
 * host actually sent this application" a precondition instead of a hope.
 *
 * Returns `null` when no submission is recorded — which the caller must treat as
 * a typed refusal, never as an empty attestation.
 */
export async function findAttestableApplication(
  tenantId: string,
  dealId: string,
): Promise<{ campaignId: string; subjectId: string } | null> {
  if (!tenantId || !dealId) return null;
  const chain = await listChain(tenantId);
  // The FIRST consumption naming this deal. A deal appears once; if a retry ever
  // wrote a second row, the earliest is the submission that actually happened.
  for (const e of chain) {
    if (e.kind !== GRANT_CONSUMED) continue;
    const p = e.payload as { dealId?: string; campaignId?: string; subjectId?: string };
    if (p.dealId !== dealId) continue;
    if (!p.campaignId || !p.subjectId) return null;
    return { campaignId: p.campaignId, subjectId: p.subjectId };
  }
  return null;
}
