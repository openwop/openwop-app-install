/**
 * ADR 1059 / RFC 0259 — `interrupt.resolved.resolvedVia`, the INSTRUMENT of a
 * resolution, beside `resolvedBy` (who authenticated).
 *
 * A resume token proves possession, not identity, so a token resolution
 * records no `resolvedBy` (ADR 0932 D2; RFC 0259 §A.1 makes that a MUST NOT on
 * every host). What this host CAN say is that a token was presented, and — when
 * the presentation carries this host's own MAC over `(token, voter)` (the
 * ADR 0478 / 0899 signed emailed link) — whom it addressed the link to. That is
 * `boundTo`: attribution, not authentication, because a signed link can be
 * forwarded.
 *
 * WHAT THE HOST ATTESTS for `boundTo` (RFC 0259 §A.4): the link was issued BY
 * THIS HOST to that person — the only signer of `(token, voter)` is the approval
 * email (`emailApprovalDelivery.ts`), so a token handed out by the decide-token
 * projector, copied or pasted carries no binding — and the MAC verified on this
 * request under the session secret. Expiry and invalidation are the token
 * lifecycle (`loadInterruptByTokenChecked`), and a quorum counts each voter once
 * (`assertTokenQuorumVote`). `mintedAt`/`expiresAt` ride with `boundTo` so a
 * consumer can apply its own window.
 *
 * `tokenRef` is never recorded. This host issues ONE token per interrupt, so a
 * reference to it identifies nothing the `interruptId` does not, and deriving
 * it from the token would make the log an oracle (RFC 0259 §A.3).
 *
 * BEHIND A FLAG, DEFAULT OFF (`OPENWOP_INTERRUPT_RESOLVED_VIA=true`). The RFC's
 * shape is not on the corpus `main` yet, and a host does not claim a behaviour
 * before the shape is locked (CLAUDE.md, the wire-advert rule). While the
 * vendored schema does not declare the member, the major-2 read boxes it under
 * `vendor.openwop-app` (`storage/vendorKeyCarry.ts`), so even a host with the
 * flag on makes no wire claim; `interrupt.resolvedVia` is advertised only with
 * the flag on.
 */
import type { InterruptRecord } from '../types.js';
import { verifyVoterBinding } from './interruptVoterBinding.js';
import { sessionSubjectV2, type RunSubjectV2 } from './runOwner.js';

export const RESOLVED_VIA_FLAG = 'OPENWOP_INTERRUPT_RESOLVED_VIA';

/** Read per call so a test (or an env update) can flip it without a reload. */
export function resolvedViaEnabled(): boolean {
  return process.env[RESOLVED_VIA_FLAG] === 'true';
}

/** RFC 0259 §A.2 — `scheme` is closed; `interrupt-token` is its only member. */
export interface InterruptResolvedVia {
  scheme: 'interrupt-token';
  boundTo?: RunSubjectV2;
  /** The token's issue time (the interrupt's `createdAt`); recorded with `boundTo`. */
  mintedAt?: string;
  /** The token's `expiresAt`, when it has one; recorded with `boundTo`. */
  expiresAt?: string;
}

/**
 * The `resolvedVia` for a resolution that PRESENTED `interrupt`'s resume token,
 * or undefined when the flag is off. `boundTo` is set only when `resumeValue`
 * carries a `voter` whose `voterSig` is this host's own binding of that voter to
 * this interrupt's token — a body `voter` alone binds no one (§A.4).
 */
export function tokenResolvedVia(interrupt: Pick<InterruptRecord, 'token' | 'createdAt' | 'expiresAt'>, resumeValue: unknown, runTenant: string): InterruptResolvedVia | undefined {
  if (!resolvedViaEnabled()) return undefined;
  const rv = resumeValue !== null && typeof resumeValue === 'object' && !Array.isArray(resumeValue) ? (resumeValue as Record<string, unknown>) : {};
  const voter = typeof rv['voter'] === 'string' ? rv['voter'] : '';
  const sig = typeof rv['voterSig'] === 'string' ? rv['voterSig'] : '';
  const bound = voter !== '' && typeof interrupt.token === 'string' && verifyVoterBinding(interrupt.token, voter, sig);
  if (!bound) return { scheme: 'interrupt-token' };
  return {
    scheme: 'interrupt-token',
    boundTo: sessionSubjectV2(voter, runTenant),
    ...(typeof interrupt.createdAt === 'string' ? { mintedAt: interrupt.createdAt } : {}),
    ...(typeof interrupt.expiresAt === 'string' ? { expiresAt: interrupt.expiresAt } : {}),
  };
}
