/**
 * ADR 0942 D10.2 — no self-approval on an autonomy gate.
 *
 * The requesting principals of a run are its acting user (`actingUserId`, the
 * person whose request started it), else its causing member, and its RFC 0165 owner. Neither may cast a
 * counting vote on an autonomy gate of that run. Unlike `approvalSelfCheck.ts`
 * there is **no sole-approver escape**: if nobody else is eligible the gate waits,
 * escalates (P4) and expires as rejected. It is never self-approved.
 *
 * Identities are compared after canonicalisation: a delegated key resolves to its
 * issuer (`canonicalDecider`, an unresolvable one is treated as the requester —
 * fail closed), and a scheme-prefixed subject to its userId.
 */
import { canonicalDecider } from '../delegatedSubject.js';
import { canonicalReviewerUserId } from '../approverResolution.js';
import { isRunOwnedBy } from '../runOwner.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the interrupt is an ADR 0942 autonomy gate (its data carries the host-written block). */
export function isAutonomyGateData(data: unknown): boolean {
  return isObj(data) && isObj(data.autonomy) && typeof data.autonomy.actionClass === 'string';
}

/** Is `voter` (or the principal a delegate acts for) one of the run's requesters? */
export async function isAutonomyRequester(
  run: { tenantId: string; metadata?: Record<string, unknown> | null },
  voters: ReadonlyArray<string | undefined>,
): Promise<boolean> {
  const metadata = run.metadata ?? {};
  const actor = typeof metadata.actingUserId === 'string' && metadata.actingUserId.trim() ? metadata.actingUserId : undefined;
  const cause = typeof metadata.orgScopeSubject === 'string' && metadata.orgScopeSubject.trim() ? metadata.orgScopeSubject : undefined;
  // Same actor-else-cause precedence as the run membership floor. This identity
  // only DENIES a vote; it grants no role, credential or notice authority.
  const requester = actor ?? cause;
  const requesters = new Set<string>();
  if (requester) {
    const decider = await canonicalDecider(run.tenantId, requester);
    if (decider === null) return true;
    requesters.add(requester); requesters.add(decider);
    requesters.add(await canonicalReviewerUserId(run.tenantId, decider));
  }
  for (const raw of voters) {
    if (!raw) continue;
    // The opaque owner can name the raw API key rather than its issuer.
    if (isRunOwnedBy(run, raw)) return true;
    const decider = await canonicalDecider(run.tenantId, raw);
    if (decider === null) return true;
    const userId = await canonicalReviewerUserId(run.tenantId, decider);
    if ([raw, decider, userId].some((alias) => requesters.has(alias) || isRunOwnedBy(run, alias))) return true;
  }
  return false;
}
