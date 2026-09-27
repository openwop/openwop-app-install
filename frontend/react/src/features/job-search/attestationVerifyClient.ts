/**
 * ADR 0544 P3 — the client half of the PUBLIC attestation verification route.
 *
 * Deliberately a SEPARATE module from `jobSearchClient.ts`, which imports
 * `authedHeaders` and the CRM org client. Two reasons, and the second is the
 * one that matters:
 *
 *  1. the public chunk stays lean — an employer following a link should not
 *     download the workspace's org picker;
 *  2. it is structurally impossible for this path to acquire an authed header
 *     by a later edit. The `PublicFormRenderer` posture ("no authed clients, no
 *     feature-access hooks") expressed as an import boundary rather than a
 *     comment.
 *
 * ## Why a BARE fetch, not `fetchOpts`
 *
 * `fetchOpts` adds `credentials: 'include'` whenever the deployment is in cookie
 * mode — which is production. That would send a signed-in visitor's session
 * cookie along with an anonymous verification read, letting the backend
 * correlate WHO checked WHICH applicant's attestation. The token is the only
 * credential this request has any business carrying, so it is the only one it
 * carries — the `sharingClient.resolveSharedPublic` precedent.
 */
import { config } from '../../client/config.js';

/** One projected claim. Mirrors the backend `VerifierClaim` (facts, never ids). */
export interface VerifierClaim {
  type:
    | 'authorised-by-person'
    | 'applications-in-window'
    | 'warm-path-ratio'
    | 'human-reviewed'
    | 'resume-guarded';
  facts: Record<string, string | number | boolean>;
  /** Opaque to a verifier; recomputable by the issuer to prove correspondence. */
  sourceDigest: string;
}

export interface AttestationView {
  /** `YYYY-MM-DD`. Day precision by design — see the backend projection. */
  issuedAt: string;
  claims: VerifierClaim[];
}

/** What the page renders. `unavailable` is NOT a statement about the applicant. */
export type VerifyOutcome =
  | { kind: 'ok'; view: AttestationView }
  | { kind: 'not-found' }
  | { kind: 'unavailable' };

/**
 * Resolve a token to one of three outcomes.
 *
 * ## Why `unavailable` is separate — and why that is not a leak
 *
 * The obvious reading of "uniform refusal" is that the client should collapse
 * every failure into one answer. That is wrong, and getting it wrong would
 * reintroduce the SR-2 defect the sharing client already paid for: a network
 * blip told a quote recipient the offer was revoked. Here it would be worse —
 * the page would tell an employer an applicant's link is invalid on the
 * strength of a dropped connection, which is a statement about a person made
 * from no evidence at all.
 *
 * Indistinguishability is a property of the SERVER'S answers about a token:
 * unknown, revoked, malformed and cross-tenant must be one response, because
 * telling them apart reveals something about the applicant. A transport failure
 * is not one of those — it is a fact about the connection, known to the client
 * before the server has said anything, and it discloses nothing.
 *
 * So: a 404 (whatever produced it) is ONE outcome; a thrown fetch or a 5xx is a
 * different one. Nothing below branches on anything finer.
 */
export async function resolveAttestation(token: string): Promise<VerifyOutcome> {
  const url = `${config.baseUrl}/host/openwop-app/public-attestations/${encodeURIComponent(token)}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { kind: 'unavailable' };
  }
  if (res.status === 404) return { kind: 'not-found' };
  if (!res.ok) return { kind: 'unavailable' };
  try {
    return { kind: 'ok', view: (await res.json()) as AttestationView };
  } catch {
    // A 200 whose body will not parse is a broken service, not a bad link.
    return { kind: 'unavailable' };
  }
}
