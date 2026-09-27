/**
 * KickTodo lifecycle → CDP collect seam (ADR 0456 P1). Emits participant
 * lifecycle events into the ONE CDP collect front door (`collectEvent`) so the
 * existing segment/journey/email machinery can run KickTodo marketing — with NO
 * new identity store and NO PII leaving the opaque-subject boundary.
 *
 * Two hard invariants:
 *  - **Consent gate (Gate 0):** emit ONLY when the subject has a linked CRM
 *    Contact (ADR 0449) — i.e. it already crossed a consent touchpoint (paid
 *    checkout / reminder consent / leaderboard opt-in). A subject with no
 *    Contact produces NO event (the D3 privacy floor extended to marketing).
 *  - **PII boundary (ADR 0426):** the opaque `ownerSubject` NEVER enters the
 *    payload; the join key is the opaque `contactId` (an internal id, not PII),
 *    resolved host-side. Payload carries only non-PII props.
 *
 * Best-effort: an emit failure must never affect the primary action (enroll,
 * completion, purchase). Schema registration is deferred (the payload is
 * closed-world here — helper-constructed from typed args — and `registerEventSchema`
 * mints a new version per call, so it must not run on this path).
 */

import { resolveContactForSubject } from './contactBridgeService.js';
import { collectEvent } from '../cdp/collectService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('kicktodo.lifecycle');

export type KicktodoLifecycleEvent = 'enrolled' | 'completed' | 'stalled' | 'purchased';

const EVENT_TYPE: Record<KicktodoLifecycleEvent, string> = {
  enrolled: 'kicktodo.participant.enrolled',
  completed: 'kicktodo.participant.completed',
  stalled: 'kicktodo.participant.stalled',
  purchased: 'kicktodo.challenge.purchased',
};

export interface LifecycleProps {
  challengeId?: string;
  challengeVersion?: number;
}

/**
 * Emit a consent-gated KickTodo lifecycle event keyed to the participant's CRM
 * Contact. Returns true if an event was collected, false if suppressed (no
 * linked Contact) or on a swallowed error. Deterministic `dedupeKey` so a
 * retry/replay of the same transition never double-counts.
 */
export async function emitKicktodoLifecycle(
  tenantId: string,
  ownerSubject: string,
  event: KicktodoLifecycleEvent,
  props: LifecycleProps = {},
): Promise<boolean> {
  try {
    const contactId = await resolveContactForSubject(tenantId, ownerSubject);
    if (!contactId) return false; // Gate 0 — no consented Contact ⇒ no marketing signal

    const dedupeKey = `${ownerSubject}:${props.challengeId ?? ''}:${props.challengeVersion ?? ''}:${event}`;
    await collectEvent(
      tenantId,
      EVENT_TYPE[event],
      {
        contactId, // opaque CRM id — the marketing join key, never PII
        ...(props.challengeId ? { challengeId: props.challengeId } : {}),
        ...(props.challengeVersion !== undefined ? { challengeVersion: props.challengeVersion } : {}),
      },
      dedupeKey,
    );
    return true;
  } catch (err) {
    log.warn('kicktodo_lifecycle_emit_failed', { event, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
