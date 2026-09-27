/**
 * ADR 0544 D3/D4 P2 — the attestation token.
 *
 * The verifier is an unauthenticated third party we have no relationship with:
 * an employer who received an application and followed a link. That shapes every
 * decision here. It must leak nothing, need no onboarding, and be safe at
 * whatever volume a large employer hits it with.
 *
 * Copies the ADR 0448 capability-token shape used by `developer-keys`:
 *
 *  - `mintToken` returns `{ raw, hash }`; only the HASH is stored, so a database
 *    read does not yield a working token;
 *  - a separate hash-keyed INDEX makes verification a POINT LOOKUP. A scan would
 *    be O(tenant) per verification on a public endpoint — the shape that turns a
 *    popular applicant into an outage;
 *  - the raw token is returned exactly ONCE, at issuance.
 *
 * ## Indistinguishability is the property, not the 404
 *
 * Unknown, revoked, and cross-tenant must be the SAME answer. If revocation were
 * distinguishable from a bad token, an employer could learn that an attestation
 * once existed and was withdrawn — which is a fact about the applicant they were
 * never given. `resolveAttestation` therefore returns `null` for all three, and
 * the route layer turns that single null into one uniform response.
 *
 * ## Why the claims are stored, not recomputed
 *
 * Matrix row 9: the claim set is FROZEN at issuance. There is deliberately no
 * update path here — only issue and revoke — so a stored claim cannot drift.
 * Recomputing at verification would let an application sent tomorrow silently
 * change a statement an employer relied on today.
 */
import { createHash, randomBytes } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { hashToken, mintToken } from '../../../host/capabilityToken.js';
import { buildClaimSet, findAttestableApplication, type ClaimSet } from './claims.js';
import { registerSubjectEraser } from '../../../host/subjectErasure.js';
import { subjectKeyForms } from '../../../host/subjectErasureRedaction.js';

export interface AttestationRecord {
  attestationId: string;
  tenantId: string;
  /** The deal this attestation accompanies. Opt-in PER APPLICATION (D4). */
  dealId: string;
  campaignId: string;
  /** sha256 of the bearer secret. The secret itself is never stored. */
  tokenHash: string;
  /** FROZEN at issuance. No update path exists. */
  claims: ClaimSet;
  issuedBy: string;
  issuedAt: string;
  revokedAt?: string;
}

/**
 * What a verifier sees — a WHITELIST, not the stored claim minus a few fields.
 *
 * `/code-review` found the first version returned stored claims verbatim, which
 * handed an unauthenticated employer:
 *
 *  - `grantedBy`, an internal SUBJECT ID. The claim is "a named person
 *    authorised this"; the verifier needs the FACT, not the identifier. With the
 *    id, anyone holding two attestations can correlate them to the same
 *    authoriser, and an aggregator could build a graph across applicants.
 *  - `grantId` and the audit `seq`. The seq is a side channel: it reveals
 *    roughly how much governance activity the workspace has.
 *
 * The source is replaced by an opaque DIGEST. The issuer can recompute it to
 * prove correspondence; a correlator gets an opaque string.
 */
export interface VerifierClaim {
  type: ClaimSet['claims'][number]['type'];
  /** Facts the employer can act on. Never an identifier. */
  facts: Record<string, string | number | boolean>;
  /** sha256 of the source ref — checkable by the issuer, inert to anyone else. */
  sourceDigest: string;
}

/**
 * What a stranger receives.
 *
 * `campaignId` is NOT here, and its absence is the point. The P3 `/ux-review`
 * caught it still being returned: a free-text string the APPLICANT types into a
 * form field, handed verbatim to every unauthenticated verifier. That is the
 * identical correlation vector `grantedBy` was removed for — two attestations
 * carrying the same campaign string tie to one applicant — with the extra hazard
 * that a person names a campaign whatever they like ("moving-after-layoff"), so
 * it can carry PII nobody decided to disclose. Nothing consumed it. A field with
 * a correlation cost and no reader is not a trade-off, it is an oversight.
 *
 * It survived the P2 review because the P2 TEST asserted it — the leak was
 * written down as intended behaviour, so re-reading the code could not find it.
 *
 * `issuedAt` is truncated to the DAY for the same reason, one notch weaker: a
 * millisecond issuance stamp is a fingerprint two attestations can be matched
 * on. The verifier needs it to judge staleness, and the page only ever renders a
 * date, so the precision was pure correlation surface. (Hardening — no exploit
 * observed, unlike the campaign id, which was simply a leak.)
 */
export interface AttestationView {
  /** `YYYY-MM-DD`. Day precision: enough to judge staleness, too coarse to fingerprint. */
  issuedAt: string;
  claims: VerifierClaim[];
}

const digestOf = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/**
 * Project one stored claim for a stranger.
 *
 * Whitelisted per type on purpose: a "strip these fields" projection silently
 * leaks whatever a future claim variant adds, and this surface is exactly where
 * that mistake is unrecoverable — the data is already in the employer's hands.
 */
function toVerifierClaim(c: ClaimSet['claims'][number]): VerifierClaim {
  const sourceDigest = digestOf(c.source);
  switch (c.type) {
    case 'authorised-by-person':
      // The FACT, not the person: that a human authorised this campaign under a
      // bounded policy, and what the bound was.
      return { type: c.type, facts: { authorisedByNamedPerson: true, maxSubmits: c.maxSubmits }, sourceDigest };
    case 'applications-in-window':
      return { type: c.type, facts: { count: c.count, windowStart: c.windowStart, windowEnd: c.windowEnd }, sourceDigest };
    case 'warm-path-ratio':
      return { type: c.type, facts: { warm: c.warm, total: c.total }, sourceDigest };
    case 'human-reviewed':
      // NOT the dealId — that is the applicant's record id, useless to the
      // verifier and correlatable across attestations.
      return { type: c.type, facts: { reviewedByHuman: true }, sourceDigest };
    case 'resume-guarded':
      return { type: c.type, facts: { guardsEnforced: true }, sourceDigest };
  }
}

const attestations = new DurableCollection<AttestationRecord>(
  'job-search:attestation',
  (a) => `${a.tenantId}:${a.attestationId}`,
  undefined,
  (a) => a.tenantId,
);

/** Hash → record pointer, so verification never scans. */
const hashIndex = new DurableCollection<{ key: string; attestationId: string; tenantId: string }>(
  'job-search:attestation-hashidx',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

/** Why an issuance was refused. A REASON, not a null — the caller has to be able
 *  to tell an applicant which of these it was, and none of them is a bug. */
export type IssueRefusal =
  /** This host has no record of sending this application. */
  | 'not-attestable'
  /** The acting user is not the person whose conduct this would attest. */
  | 'not-the-subject';

export interface IssueResult {
  token: string;
  attestationId: string;
  claims: ClaimSet;
}

/**
 * Issue an attestation for one application. Returns the raw token ONCE.
 *
 * The caller supplies a `dealId` and NOTHING ELSE about the content — not the
 * campaign, not a claim, not a count. P2 took `campaignId` from the caller,
 * which let any campaign's numbers be attached to any application; it is now
 * derived from the audit row that recorded the submission, so the deal↔campaign
 * link is read rather than asserted (see `findAttestableApplication`).
 *
 * `issuedBy` must BE the subject of the grant that sent it (matrix row 8). An
 * attestation asserts a PERSON's conduct; an org-admin minting one on a
 * colleague's behalf would be signing a statement about someone else's job
 * search. Checked here rather than only at the route, so the rule cannot be lost
 * by a second caller.
 */
export async function issueAttestation(input: {
  tenantId: string;
  dealId: string;
  issuedBy: string;
  now: number;
}): Promise<IssueResult | { refused: IssueRefusal }> {
  const link = await findAttestableApplication(input.tenantId, input.dealId);
  if (!link) return { refused: 'not-attestable' };
  if (link.subjectId !== input.issuedBy) return { refused: 'not-the-subject' };
  const claims = await buildClaimSet(input.tenantId, link.campaignId, input.now);
  const { raw, hash } = mintToken('owatt');
  const rec: AttestationRecord = {
    attestationId: `att:${randomBytes(8).toString('hex')}`,
    tenantId: input.tenantId,
    dealId: input.dealId,
    campaignId: link.campaignId,
    tokenHash: hash,
    claims,
    issuedBy: input.issuedBy,
    issuedAt: new Date(input.now).toISOString(),
  };
  await attestations.put(rec);
  await hashIndex.put({ key: hash, attestationId: rec.attestationId, tenantId: rec.tenantId });
  return { token: raw, attestationId: rec.attestationId, claims };
}

/**
 * What WOULD be disclosed, without issuing anything.
 *
 * ADR 0544 matrix row 10: "the number is shown before consent, because
 * consenting to disclose an unseen number is not consent." That sentence is only
 * true if the preview is the SAME projection the employer will read — so this
 * runs `buildClaimSet` and `toVerifierClaim`, the identical pair
 * `resolveAttestation` runs. A separately-written summary would drift, and the
 * drift would land on the one screen whose entire purpose is telling someone
 * exactly what they are about to reveal.
 *
 * It applies the same refusals for the same reasons: previewing an application
 * this host never sent, or one belonging to someone else, must not be a way to
 * READ what could have been claimed.
 */
export async function previewAttestation(input: {
  tenantId: string;
  dealId: string;
  actingUser: string;
  now: number;
}): Promise<{ claims: VerifierClaim[] } | { refused: IssueRefusal }> {
  const link = await findAttestableApplication(input.tenantId, input.dealId);
  if (!link) return { refused: 'not-attestable' };
  if (link.subjectId !== input.actingUser) return { refused: 'not-the-subject' };
  const set = await buildClaimSet(input.tenantId, link.campaignId, input.now);
  return { claims: set.claims.map(toVerifierClaim) };
}

/**
 * Resolve a bearer token to what a verifier may see.
 *
 * Returns `null` for unknown, revoked, malformed AND cross-tenant. One return
 * value for every failure is what makes them indistinguishable — a caller that
 * branched on the reason would leak it back out through the response.
 *
 * Note there is no `tenantId` parameter: the tenant comes from the RESOURCE the
 * token resolves to, never from the request (D3). A tenant parameter here would
 * be the thing that makes cross-tenant probing possible at all.
 */
export async function resolveAttestation(rawToken: string): Promise<AttestationView | null> {
  if (typeof rawToken !== 'string' || rawToken.length < 8) return null;
  const ptr = await hashIndex.get(hashToken(rawToken));
  if (!ptr) return null;
  const rec = await attestations.get(`${ptr.tenantId}:${ptr.attestationId}`);
  if (!rec || rec.revokedAt) return null;
  // The projection is the leak boundary: no tenantId, no dealId, no issuer, no
  // hash, no campaign string. An employer learns the CLAIMS and nothing that
  // ties this attestation to any other one.
  return { issuedAt: rec.issuedAt.slice(0, 10), claims: rec.claims.claims.map(toVerifierClaim) };
}

/**
 * Revoke. Idempotent, and deliberately does NOT delete the row.
 *
 * Keeping a revoked record is what lets revocation be indistinguishable from an
 * unknown token: both resolve to null through the same path. Deleting it would
 * also destroy the applicant's own record of what they once attested.
 */
export async function revokeAttestation(tenantId: string, attestationId: string, now: number): Promise<boolean> {
  const rec = await attestations.get(`${tenantId}:${attestationId}`);
  if (!rec || rec.revokedAt) return false;
  await attestations.put({ ...rec, revokedAt: new Date(now).toISOString() });
  return true;
}

/** The applicant's own list. Never exposes the hash. */
export async function listAttestations(tenantId: string): Promise<Array<Omit<AttestationRecord, 'tokenHash'>>> {
  const rows = await attestations.listByPrefix(`${tenantId}:`);
  return rows.map(({ tokenHash: _omit, ...pub }) => pub);
}


/**
 * ADR 0464 — subject erasure.
 *
 * `/code-review` flagged this: the attestation record names a person twice, as
 * `issuedBy` and inside the frozen `authorised-by-person` claim. The ADR 0464
 * ratchet scans HOST stores and this lives in a feature, so nothing forced it.
 *
 * REVOKED and redacted, not deleted, and the ORDER is the point. Revoking first
 * means the token stops resolving immediately; deleting the row instead would
 * ALSO stop it resolving but would destroy the applicant's own record of what
 * they attested — and an erasure that silently removes someone's evidence of
 * their own conduct is not a privacy win.
 *
 * The frozen claim set is rewritten here, which is the one exception to "no
 * update path". That is deliberate: an erasure obligation outranks an
 * immutability convention, and the alternative is a permanent public record of a
 * person who asked to be forgotten.
 */
export async function eraseSubjectAttestations(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  const erasedIds = new Set<string>();
  for (const rec of await attestations.listByPrefix(`${tenantId}:`)) {
    const namesSubject =
      forms.has(rec.issuedBy) ||
      rec.claims.claims.some((c) => c.type === 'authorised-by-person' && forms.has(c.grantedBy));
    if (!namesSubject) continue;
    erasedIds.add(rec.attestationId);
    await attestations.put({
      ...rec,
      issuedBy: '[erased]',
      revokedAt: rec.revokedAt ?? new Date().toISOString(),
      claims: {
        ...rec.claims,
        claims: rec.claims.claims.map((c) =>
          c.type === 'authorised-by-person' && forms.has(c.grantedBy) ? { ...c, grantedBy: '[erased]' } : c,
        ),
      },
    });
  }
  // JS-DATA-3 / JS-RI-2 — the hash index must not outlive an ERASED record:
  // after erasure the person's tokens stop resolving entirely (verify reads
  // "unknown", the privacy-first answer for someone who asked to be
  // forgotten). REVOCATION deliberately keeps its index row — revoked must
  // stay distinguishable from unknown through the same lookup, and that is
  // why revoke never touches the index. Tenant-bounded via the armed index.
  if (erasedIds.size > 0) {
    for (const row of await hashIndex.listForTenantIndexed(tenantId)) {
      if (erasedIds.has(row.attestationId)) await hashIndex.delete(row.key);
    }
  }
}

registerSubjectEraser(eraseSubjectAttestations);

/** Test-only: the tenant's hash-index row count. Revoke keeps rows (revoked
 *  must stay distinguishable from unknown); erasure deletes them — the two
 *  states are indistinguishable through `resolveAttestation` BY DESIGN, so
 *  the index is the only place the difference is observable. */
export async function __hashIndexCountForTest(tenantId: string): Promise<number> {
  return (await hashIndex.listForTenantIndexed(tenantId)).length;
}
