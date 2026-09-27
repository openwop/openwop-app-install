/**
 * Webhook HMAC secret at-rest codec (closes the long-standing TODO on
 * `types.ts` — "stored in plaintext in this sample (use KMS in production)").
 *
 * Tiered, matching the BYOK posture:
 *   - KMS configured (MANDATORY in the enterprise/auth posture — the boot
 *     guard in `index.ts` refuses to boot `auth` without it): secrets are
 *     sealed with the SAME KMS envelope as BYOK credentials
 *     (`byok/kmsEncryption.ts`) and stored as `wsec:kms:v1:<json>`.
 *   - No KMS (local dev / anon demo): stored plaintext, exactly as before —
 *     honest for a throwaway posture, and the read path passes legacy rows
 *     through, so no migration is needed.
 *
 * The plaintext secret still returns ONCE in the registration response (the
 * webhooks.md contract — the subscriber needs it to verify signatures); only
 * the AT-REST copies (the subscription row + the per-delivery snapshot the
 * enqueue path copies) are sealed. `openWebhookSecret` runs at signing time in
 * the delivery worker.
 */

import { isKmsConfigured, kmsEncrypt, kmsDecrypt, type KmsEncryptedRecord, type KmsAadContext } from '../byok/kmsEncryption.js';

const KMS_PREFIX = 'wsec:kms:v1:';

/** Webhook secrets are not per-tenant BYOK credentials (they weren't the vuln-scan
 *  M2 finding), and these codec functions don't receive a subscription identity —
 *  so they use a fixed, stable AAD context. seal + open use the SAME context, so v3
 *  records round-trip; legacy v2 rows (no AAD) still open. Follow-up: thread the
 *  subscription's (tenantId, subscriptionId) here for real per-webhook binding. */
const WEBHOOK_AAD: KmsAadContext = { tenantId: 'host', credentialRef: 'webhook-signing-secret' };

/** Seal a webhook secret for storage. KMS envelope when configured; plaintext
 *  passthrough otherwise (local/demo posture — same as the prior behavior). */
export async function sealWebhookSecret(plaintext: string): Promise<string> {
  if (!isKmsConfigured()) return plaintext;
  const record = await kmsEncrypt(plaintext, WEBHOOK_AAD);
  return `${KMS_PREFIX}${JSON.stringify(record)}`;
}

/** Open a stored webhook secret. Sealed rows decrypt via KMS; anything without
 *  the prefix is a legacy/dev plaintext row and passes through verbatim. */
export async function openWebhookSecret(stored: string): Promise<string> {
  if (!stored.startsWith(KMS_PREFIX)) return stored;
  const record = JSON.parse(stored.slice(KMS_PREFIX.length)) as KmsEncryptedRecord;
  return kmsDecrypt(record, WEBHOOK_AAD);
}
