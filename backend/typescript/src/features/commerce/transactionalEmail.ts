/**
 * Transactional email seam (ADR 0177 deferred — order-confirmation to the customer).
 * The `email` feature is campaign-oriented, so a one-off customer send needs its own
 * path. Real delivery needs an operator SMTP/provider (last-mile), so this is a
 * PLUGGABLE TRANSPORT: tests inject a mock; a deployment wires the real sender. The
 * compose/route logic — resolving the recipient + composing the message — is the
 * net-new code, fully testable here.
 */

export interface TransactionalEmail {
  to: string;
  subject: string;
  text: string;
  /** Resolution context for a brokered transport (gap plan §5B B4): the tenant/org
   *  whose sender-address setting applies, the acting human whose email Connection
   *  the broker resolves, and a deterministic key for the ONE email sent-ledger
   *  (a webhook re-delivery must never re-send). Absent ⇒ a context-needing
   *  transport reports an honest no-op. */
  context?: { tenantId: string; orgId: string; actingUserId: string; idempotencyKey?: string };
}
export type EmailTransport = (email: TransactionalEmail) => Promise<boolean>;

let transport: EmailTransport | null = null;
/** Wire the transactional sender (a deployment sets the real one; unwired ⇒ honest no-op). */
export function setTransactionalEmailTransport(t: EmailTransport | null): void { transport = t; }

/** Send a transactional email. Returns `sent` (false when no recipient or no transport —
 *  an honest no-op, never a throw; a failure must never block the order flow). */
export async function sendTransactionalEmail(email: TransactionalEmail): Promise<{ sent: boolean; reason?: 'no_recipient' | 'no_transport' }> {
  if (!email.to || !email.to.includes('@')) return { sent: false, reason: 'no_recipient' };
  if (!transport) return { sent: false, reason: 'no_transport' };
  try { return { sent: await transport(email) }; } catch { return { sent: false, reason: 'no_transport' }; }
}

export function __resetTransactionalEmail(): void { transport = null; }
