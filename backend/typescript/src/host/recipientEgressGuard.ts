/**
 * ADR 0655 D1 — the recipient egress guard seam.
 *
 * Every outbound message to a person funnels through ONE host adapter per channel
 * (`makeEmailAdapter` today; `makeSmsAdapter` is the recorded next registrant —
 * `EMWF-19`). The adapter is host code and must not import the features that own
 * suppression (`crm`), consent and erasure tombstones (`consent`) — ADR 0446 keeps
 * the import direction host ← features. So the OWNING feature registers a guard at
 * boot and the adapter consults it per message, the same registered-seam shape as
 * `analytics/experimentStampResolver.ts` (ADR 0651 D3) and `hostEventDispatcher`.
 *
 * Posture (review B3 / ADR 0651 D4 lesson — a fail-open default is a shape): with
 * NO guard registered for a channel, a `marketing` message is REFUSED with
 * `<channel>_egress_guard_missing`; a `transactional` one proceeds with a warn.
 * All-or-nothing (review S6): a refusal for ANY recipient refuses the message —
 * one `to[]` is one provider call, and the verdict carries a COUNT, never an
 * address.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.recipientEgressGuard');

export type EgressChannel = 'email' | 'sms';
export type EgressPurpose = 'marketing' | 'transactional';

export type RecipientEgressRefusal =
  | 'email_recipient_suppressed'
  | 'email_recipient_erased'
  | 'email_recipient_no_consent'
  | 'email_suppression_unreadable'
  | 'email_egress_guard_missing';

export type RecipientEgressVerdict =
  | { ok: true }
  | { ok: false; code: RecipientEgressRefusal; refused: number };

/** One recipient's verdict — the guard is asked per ADDRESS; the seam folds. */
export type RecipientVerdict = { ok: true } | { ok: false; code: Exclude<RecipientEgressRefusal, 'email_egress_guard_missing'> };

export type RecipientEgressGuard = (input: {
  tenantId: string;
  address: string;
  purpose: EgressPurpose;
}) => Promise<RecipientVerdict>;

const guards = new Map<EgressChannel, RecipientEgressGuard>();

/** Called once from the owning feature's boot path. Last registration wins. */
export function registerRecipientEgressGuard(channel: EgressChannel, guard: RecipientEgressGuard): void {
  guards.set(channel, guard);
}

/**
 * Fold the per-address verdicts for one message. The FIRST refusal code wins
 * (the order is the registrant's: tombstone → suppression → consent), the count
 * is every refused address. Never throws: a guard that throws refuses
 * (`<channel>_suppression_unreadable` for email — an unreadable store is not a
 * permission to send).
 */
export async function consultRecipientEgressGuard(input: {
  channel: EgressChannel;
  tenantId: string;
  addresses: readonly string[];
  purpose: EgressPurpose;
}): Promise<RecipientEgressVerdict> {
  const guard = guards.get(input.channel);
  if (!guard) {
    if (input.purpose === 'marketing') {
      log.warn('egress refused: no guard registered', { channel: input.channel, tenantId: input.tenantId, purpose: input.purpose });
      return { ok: false, code: 'email_egress_guard_missing', refused: input.addresses.length };
    }
    log.warn('transactional egress with no guard registered', { channel: input.channel, tenantId: input.tenantId });
    return { ok: true };
  }
  let first: RecipientVerdict & { ok: false } | null = null;
  let refused = 0;
  for (const address of input.addresses) {
    let v: RecipientVerdict;
    try { v = await guard({ tenantId: input.tenantId, address, purpose: input.purpose }); }
    catch (e) {
      log.error('egress guard threw; refusing', { channel: input.channel, tenantId: input.tenantId, error: e instanceof Error ? e.message : String(e) });
      v = { ok: false, code: 'email_suppression_unreadable' };
    }
    if (!v.ok) { refused += 1; if (!first) first = v; }
  }
  if (first) return { ok: false, code: first.code, refused };
  return { ok: true };
}

/** Test affordance — never routed. */
export function __resetRecipientEgressGuardsForTests(): void { guards.clear(); }
/** Test affordance — a guard that admits everyone, for adapter-level transport tests. */
export function __registerPermissiveEgressGuardForTests(channel: EgressChannel = 'email'): void {
  guards.set(channel, async () => ({ ok: true }));
}
