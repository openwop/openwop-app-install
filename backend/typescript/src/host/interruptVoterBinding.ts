/**
 * ADR 0478 §2 correction (grade-code H1) — voter identity binding for the
 * decide-by-email lane.
 *
 * The RFC 0093 interrupt token is a SHARED capability: every emailed approver
 * receives links carrying the SAME token, and the quorum vote's `voter` field
 * was previously client-chosen (constrained only to `approverRefs`
 * membership). One recipient could therefore replay the token with each
 * listed approver's id and satisfy an N-approver gate alone — voter identity
 * forgery.
 *
 * The fix: every emailed link additionally carries an HMAC over
 * `(token, voter)` keyed by the session secret (the `runStreamToken` SEC-1
 * pattern — ONE signing secret, fail-closed in production). A quorum vote on
 * a gate with an EXPLICIT approver list is accepted on the capability-token
 * lane only when the claimed `voter` is accompanied by a valid binding — so
 * a token holder can cast exactly the vote(s) they were individually mailed.
 * Open quorum gates (empty approver list) and non-quorum interrupts are
 * unchanged (the `openwop-interrupt-quorum` conformance contract), as is the
 * authenticated in-app lane (`assertEligibleApprover` pins the real subject).
 *
 * Stateless, verifiable on any instance; domain-separated by the message
 * prefix.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readSessionSecret } from '../middleware/cookieSession.js';

const PREFIX = 'interruptvoter:v1:';

/** Sign the (token, voter) pair for an emailed decide link. */
export function signVoterBinding(token: string, voter: string): string {
  return createHmac('sha256', readSessionSecret())
    .update(`${PREFIX}${token}:${voter}`)
    .digest('base64url');
}

/** Constant-time verify of an emailed link's (token, voter) binding. */
export function verifyVoterBinding(token: string, voter: string, sig: string): boolean {
  if (!token || !voter || !sig) return false;
  const expected = Buffer.from(signVoterBinding(token, voter));
  const presented = Buffer.from(sig);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}
