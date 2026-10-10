/**
 * ADR 0858 P4 — the `negotiation.decided` audit event (`spec/v2/core/interop.md`
 * §"The audit event", RFC 0175 §D.3).
 *
 * "Every negotiation outcome, including the refused one, MUST emit a
 * `negotiation.decided` event on the host's own event log." The event is a RUN
 * event (`schemas/v2/run-event.schema.json` lists it; its payload is
 * `run-event-payloads.schema.json#/$defs/negotiationDecided`, closed), and the
 * corpus witnesses it on `GET /runs/{runId}/events/poll`. So "the host's own
 * event log" here is the log of the run the negotiation happened inside — the
 * run whose node called `ctx.a2a.*` / `ctx.mcp.*`, or the run the §22/§23 invoke
 * seam plants to stand in for one.
 *
 * NOT the host-event dispatcher (`hostEventDispatcher.ts`): that carries only
 * host-extension-namespaced types and is "deliberately NOT the run event log".
 *
 * ONE builder, so every emitter writes the same closed shape:
 *   - `peerDigest` is the SHA-256 (hex) of the peer ORIGIN, never the origin in
 *     clear, and no other field may carry it;
 *   - `outcome` is the schema's closed `accepted | refused`. The prose example
 *     in `interop.md` also names `downgraded` (and different field names), but
 *     the closed payload schema does not admit it — an explicit downgrade above
 *     the floor is recorded `accepted` with the version actually used. ADR 0858
 *     P4 reports that prose/schema disagreement to the steward.
 *   - `reason` is the schema's closed `below-floor | unauthenticated |
 *     unsupported | ok`.
 *
 * Emitters supply a {@link NegotiationRecorder}; a caller with no run passes
 * none, and the decision then has no run log to land on (ADR 0858 P4 records
 * that runless — inbound — negotiations are a corpus question, not solved here).
 * A recorder failure never changes the negotiation's outcome: the audit write
 * is attempted, logged on failure, and the protocol answer stands.
 */
import { createHash } from 'node:crypto';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.negotiationDecided');

export const NEGOTIATION_DECIDED_EVENT = 'negotiation.decided';

export type NegotiationProtocol = 'a2a' | 'mcp';
export type NegotiationOutcome = 'accepted' | 'refused';
export type NegotiationReason = 'below-floor' | 'unauthenticated' | 'unsupported' | 'ok';

/** The closed payload (`negotiationDecided`). Key set pinned by its test. */
export interface NegotiationDecidedPayload {
  protocol: NegotiationProtocol;
  outcome: NegotiationOutcome;
  version?: string;
  floor?: string;
  peerDigest?: string;
  reason: NegotiationReason;
  at: string;
}

/** Writes one payload onto the run log of the negotiation's run. */
export type NegotiationRecorder = (payload: NegotiationDecidedPayload) => Promise<void>;

/** SHA-256 (hex) of `url`'s origin; `undefined` for a value that is not a URL. */
export function peerOriginDigest(url: string): string | undefined {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return undefined;
  }
  if (!origin || origin === 'null') return undefined;
  return createHash('sha256').update(origin, 'utf8').digest('hex');
}

export function negotiationDecidedPayload(input: {
  protocol: NegotiationProtocol;
  outcome: NegotiationOutcome;
  reason: NegotiationReason;
  /** Present only when a version was actually decided (never on a refusal). */
  version?: string;
  floor?: string;
  /** The peer URL; only its origin's DIGEST leaves this function. */
  peerUrl?: string;
  now?: () => Date;
}): NegotiationDecidedPayload {
  const digest = input.peerUrl !== undefined ? peerOriginDigest(input.peerUrl) : undefined;
  return {
    protocol: input.protocol,
    outcome: input.outcome,
    ...(input.outcome === 'accepted' && input.version !== undefined ? { version: input.version } : {}),
    ...(input.floor !== undefined ? { floor: input.floor } : {}),
    ...(digest !== undefined ? { peerDigest: digest } : {}),
    reason: input.reason,
    at: (input.now ?? (() => new Date()))().toISOString(),
  };
}

/** Record one decision through `recorder`, if any. Never throws. */
export async function recordNegotiationDecided(
  recorder: NegotiationRecorder | undefined,
  input: Parameters<typeof negotiationDecidedPayload>[0],
): Promise<void> {
  if (!recorder) return;
  const payload = negotiationDecidedPayload(input);
  try {
    await recorder(payload);
  } catch (err) {
    log.warn('negotiation_decided_record_failed', {
      protocol: payload.protocol,
      outcome: payload.outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
