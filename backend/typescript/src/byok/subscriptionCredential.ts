/**
 * RFC 0121 AT-OWN-RISK subscription credential — user-scoped storage + resolve +
 * the operator-configured dispatch endpoint (ADR 0180, extending the ADR 0179
 * scope-safety rail).
 *
 * MECHANISM-ONLY / HONESTY CONSTRAINT: this module ships NO integration against
 * any provider's private consumer API (Claude.ai / ChatGPT web endpoints). It
 * stores a user-scoped credential, resolves it for dispatch, and hands it to the
 * EXISTING OpenAI-compatible dispatcher pointed at an OPERATOR-configured base URL
 * (`OPENWOP_SUBSCRIPTION_ENDPOINT`, off by default). The operator points that at
 * whatever endpoint they accept the risk of — the host does no reverse
 * engineering, no scraping, no session-cookie handling.
 *
 * §B.8 (`subscription-credential-user-scope-only`) is enforced at the bind seam
 * BEFORE any store here — this module only ever writes at the requesting
 * principal's OWN tenant scope, never a shared tenant/workspace.
 */

import { resolveSecret, setSecret, type SecretScope } from './secretResolver.js';

/** The credentialRef namespace for a subscription-mode credential. A run/chat
 *  that carries `subscription:<provider>` as its `credentialRef` routes to the
 *  at-own-risk dispatch path. */
const SUBSCRIPTION_REF_PREFIX = 'subscription:';

/** Whether a credentialRef is a subscription-kind ref (routes to the at-own-risk
 *  operator-endpoint dispatch, not a metered BYOK/managed key). */
export function isSubscriptionCredentialRef(ref: string): boolean {
  return ref.startsWith(SUBSCRIPTION_REF_PREFIX);
}

/** The provider id a subscription-kind credentialRef names (`subscription:<p>` → `<p>`). */
export function subscriptionProviderOfRef(ref: string): string {
  return ref.slice(SUBSCRIPTION_REF_PREFIX.length);
}

/** The user-scoped credentialRef for a provider's subscription credential. */
export function subscriptionCredentialRef(provider: string): string {
  return `${SUBSCRIPTION_REF_PREFIX}${provider}`;
}

/**
 * Store a subscription-mode credential at USER scope (RFC 0121 §B.8). `scope`
 * is the requesting principal's OWN tenant — for a signed-in user that is
 * `user:<hash>` (KMS-partitioned), so the credential is user-bound by
 * construction. The bind seam rejects tenant/workspace RFC-scope binds BEFORE
 * this is reached, so this never writes at a shared scope. NEVER returns/echoes
 * the value — only the ref NAME.
 */
export async function storeSubscriptionCredential(input: {
  provider: string;
  value: string;
  scope: SecretScope;
}): Promise<{ credentialRef: string }> {
  const credentialRef = subscriptionCredentialRef(input.provider);
  await setSecret(credentialRef, input.value, input.scope);
  return { credentialRef };
}

/**
 * Resolve a subscription-kind credentialRef to its USER-scoped stored token for
 * dispatch. The token is handed ONLY to the operator-configured endpoint
 * (mechanism-only); it never enters an event/prompt/result (SR-1, same as BYOK).
 */
export async function resolveSubscriptionCredential(
  credentialRef: string,
  tenantId: string,
): Promise<string | null> {
  return resolveSecret(credentialRef, { tenantId });
}

/**
 * The OPERATOR-configured subscription dispatch endpoint (borrowed-session shape
 * 1, endpoint-agnostic). OFF by default (dark) — the public demo leaves it unset.
 * The operator points this at whatever OpenAI-compatible endpoint they accept the
 * risk of; the host ships NO provider-private-API integration (ADR 0180 honesty
 * constraint). Host-only — never echoed on the wire.
 */
export function subscriptionDispatchEndpoint(): string | undefined {
  return process.env.OPENWOP_SUBSCRIPTION_ENDPOINT?.trim() || undefined;
}
