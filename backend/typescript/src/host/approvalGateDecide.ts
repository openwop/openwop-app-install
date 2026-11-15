/**
 * ADR 1120 (Book AI P53) — `decide: 'signed-in'`: an approval gate that is decided
 * only by a signed-in person.
 *
 * A config key on `core.approvalGate` and `core.chat.approvalGate`, copied into the
 * interrupt RECORD's data, where the token doors read it. Under `'signed-in'`:
 *  - every door that resolves by PRESENTING the resume token (`POST /interrupts/{token}`
 *    and the email confirm form) refuses with `403`, reason `interrupt_requires_session`,
 *    keyed on this recorded value, so a leaked or minted token cannot bypass it;
 *  - the approval email carries no token, only a Review link into the inbox.
 * The run-scoped door (`POST /runs/{runId}/interrupts/{nodeId}`, a session holding
 * `approvals:respond`) is the way to decide, so `resolvedBy` is an authenticated Subject
 * (RFC 0259 §A.1). `interrupt.md` §Tokens already allows a host to refuse a token
 * resolve this way, so this is host policy: nothing is advertised and there is no RFC.
 *
 * `'link'` (the default) writes nothing, so a gate without the key is byte-identical to
 * before. Closed-world, refused at the writer like `rejectionPolicy` (ADR 0600 §6).
 */

export const GATE_DECIDE_KEY = 'decide';
export const REQUIRES_SESSION_REASON = 'interrupt_requires_session';

type Failure = { status: 'failure'; error: { code: string; message: string } };

/** Read and validate `decide`. Returns the data to merge (empty for `'link'`), or a failure. */
export function readApprovalGateDecide(typeId: string, cfg: { decide?: unknown }): { decide?: 'signed-in' } | Failure {
  const v = cfg.decide;
  if (v === undefined || v === 'link') return {};
  if (v === 'signed-in') return { decide: 'signed-in' };
  return {
    status: 'failure',
    error: { code: 'invalid_config', message: `${typeId}: decide must be "signed-in" or "link" (got ${JSON.stringify(v)}).` },
  };
}

export function isDecideFailure(v: { decide?: 'signed-in' } | Failure): v is Failure {
  return (v as Failure).status === 'failure';
}

/** Does this interrupt's recorded data require a signed-in decision? */
export function gateRequiresSession(data: unknown): boolean {
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && (data as Record<string, unknown>)[GATE_DECIDE_KEY] === 'signed-in';
}
