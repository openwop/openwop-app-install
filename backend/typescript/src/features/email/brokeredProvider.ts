/**
 * Campaign email provider over the EXISTING transactional send spine —
 * `host/emailAdapter.ts` (ctx.email.send, ADR 0024 §4 Phase 3 / the ADR 0193
 * Phase 1 provider table): the acting user's `api_key` Connection resolved
 * per-request by the broker, dispatched via `brokeredPost` (egress firewall +
 * provenance stamp). NO parallel HTTP client, no second egress path — this
 * file only adapts that spine to the campaign `EmailProvider` seam.
 *
 * Provider selection (ADR 0193 convergence): campaigns are NOT pinned to
 * SendGrid — the preflight walks `emailSendProviders()` (host default first)
 * and dispatches through the FIRST provider the acting user has a Connection
 * for, so a new adapter-table row widens campaigns automatically.
 *
 * Error semantics: the adapter RETURNS `{sent:false, error}`; `sendCampaign`
 * counts failures via throw (partial-failure stats), so this wrapper CONVERTS
 * a false return into a throw. A missing connection is preflighted ONCE before
 * the loop (`credential_required`, 409) rather than N per-recipient failures.
 *
 * BYOK: the provider key never enters this module — the broker resolves it
 * per-request inside `brokeredPost` and only status/error strings surface.
 */

import type { Storage } from '../../storage/storage.js';
import { OpenwopError } from '../../types.js';
import { makeEmailAdapter, emailSendProviders } from '../../host/emailAdapter.js';
import type { EgressPurpose } from '../../host/recipientEgressGuard.js';
import { resolveConnectionCredential } from '../connections/connectionsService.js';
import { getEmailSettings, type EmailProvider } from './emailService.js';

export interface BrokeredProviderDeps {
  storage: Storage;
  tenantId: string;
  orgId: string;
  /** The authenticated route user — the broker resolves THEIR connection
   *  (or an org-shared one they're granted), exactly like a run's acting human. */
  actingUserId: string;
  /** ADR 0622 D2 — when the send is brokered from INSIDE a run (the orgs
   *  invite surface), the real run id, so `stampConnectionUse` records the
   *  connection use on that run. Absent ⇒ the synthetic route id below. */
  runId?: string;
  /** ADR 0655 D1 (review B2) — REQUIRED: the campaign route is `'marketing'`, an org
   *  invite is `'transactional'`. The adapter's own default is marketing (fail-closed). */
  purpose: EgressPurpose;
}

/**
 * Build the campaign `EmailProvider` bound to the acting user's brokered
 * transactional-email connection (first supported provider that resolves,
 * host default first). Throws `credential_required` (409) when none resolves —
 * checked ONCE up front so the caller gets one actionable error, not a
 * failed-stat per recipient.
 */
export async function makeBrokeredCampaignProvider(deps: BrokeredProviderDeps): Promise<EmailProvider> {
  const candidates = emailSendProviders();
  let provider: string | undefined;
  for (const p of candidates) {
    const resolved = await resolveConnectionCredential({
      tenantId: deps.tenantId,
      provider: p,
      actingUserId: deps.actingUserId,
      orgId: deps.orgId,
    });
    if (resolved) { provider = p; break; }
  }
  if (!provider) {
    throw new OpenwopError(
      'credential_required',
      `Connect a transactional email account (Connections → ${candidates.join(' / ')}) before sending campaigns.`,
      409,
      { providers: [...candidates] },
    );
  }

  const adapter = makeEmailAdapter({
    storage: deps.storage,
    tenantId: deps.tenantId,
    // Route action, not a run — stampConnectionUse no-ops on an unknown runId
    // (verified: host/connectionInjection.ts getRun→return), so this synthetic
    // id is provenance-neutral while keeping the deps shape honest. A run-lane
    // caller threads its real `runId` instead (ADR 0622 D2).
    runId: deps.runId ?? 'route:email-campaign',
    actingUserId: deps.actingUserId,
    orgId: deps.orgId,
  });

  const chosen = provider;
  return {
    id: `${chosen}-brokered`,
    async send(msg) {
      if (!msg.from) throw new Error('sender_address_missing');
      const out = await adapter.send({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.body,
        ...(msg.html ? { html: msg.html } : {}),
        provider: chosen,
        purpose: deps.purpose,
        ...(msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : {}),
      });
      if (!out.sent) throw new Error(out.error ?? 'send_failed');
    },
  };
}

/**
 * One-off TRANSACTIONAL sender over the same spine (ecommerce gap plan §5B B4 —
 * commerce order confirmations). Unlike `makeBrokeredCampaignProvider` this
 * NEVER throws for a missing credential/sender — a transactional confirmation is
 * best-effort by contract (an unconfigured operator gets the honest no-op the
 * commerce seam already documents). Returns `true` only on an accepted send.
 */
export async function sendBrokeredTransactionalEmail(input: {
  storage: Storage;
  tenantId: string;
  orgId: string;
  actingUserId: string;
  to: string;
  subject: string;
  text: string;
  idempotencyKey?: string;
}): Promise<boolean> {
  try {
    const settings = await getEmailSettings(input.tenantId, input.orgId);
    const from = settings?.senderAddress;
    if (!from) return false; // no verified sender configured — honest no-op
    let provider: string | undefined;
    for (const p of emailSendProviders()) {
      const resolved = await resolveConnectionCredential({
        tenantId: input.tenantId,
        provider: p,
        actingUserId: input.actingUserId,
        orgId: input.orgId,
      });
      if (resolved) { provider = p; break; }
    }
    if (!provider) return false; // no email Connection — honest no-op
    const adapter = makeEmailAdapter({
      storage: input.storage,
      tenantId: input.tenantId,
      runId: 'route:commerce-transactional', // provenance-neutral (stampConnectionUse no-ops)
      actingUserId: input.actingUserId,
      orgId: input.orgId,
    });
    const out = await adapter.send({
      from, to: input.to, subject: input.subject, text: input.text, provider,
      purpose: 'transactional', // ADR 0655 D1 — receipts/invoices reach a bounced address's owner; never an erased one
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return out.sent;
  } catch {
    return false; // best-effort by contract — never propagate into the order flow
  }
}
