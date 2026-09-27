/**
 * RFC 0121 §B.8 — the `subscription-credential-user-scope-only` invariant.
 *
 * A subscription-mode provider credential (a reused personal, non-metered
 * consumer subscription — e.g. Claude Pro/Max, ChatGPT Plus) is personal to
 * the human who owns it. Binding it at `tenant` or `workspace` scope would
 * silently share one person's personal subscription across an org — the exact
 * misuse the safety rail forbids. `user` is therefore the ONLY permitted scope
 * for a subscription binding.
 *
 * This is the acquisition-FREE half of RFC 0121: it enforces the scope
 * guarantee on the credential-binding path without advertising a live
 * `subscription` mode or performing any credential acquisition (both deferred
 * on RFC 0121 UQ1 — ToS/legal clearance). Pure + tiny by design.
 */

import { OpenwopError } from '../types.js';

/**
 * Throw `credential_scope_forbidden` (403) unless `scope === 'user'`. A
 * subscription-mode credential must bind at user scope; tenant/workspace
 * binding is forbidden (RFC 0121 §B.8).
 */
export function assertSubscriptionScopeAllowed(scope: string): void {
  if (scope !== 'user') {
    throw new OpenwopError(
      'credential_scope_forbidden',
      'A subscription-mode credential must bind at user scope; tenant/workspace binding is forbidden (RFC 0121 §B.8).',
      403,
      {},
    );
  }
}

/**
 * The STORAGE-side half of §B.8: a subscription credential must be persisted in the
 * caller's OWN user-scoped tenant (`user:<hash>`), never the ACTIVE workspace tenant —
 * which, per ADR 0015, may be a shared `ws:<uuid>`. `assertSubscriptionScopeAllowed`
 * only validates the request `scope` FIELD; without this a signed-in user who has
 * switched into a shared workspace would pass the field check yet have their personal
 * token written to a workspace-shared row, readable by every member — the exact
 * cross-user sharing §B.8 exists to forbid. Pass the caller's PERSONAL tenant
 * (`personalTenantOf(req)`), not `req.tenantId`. Mirrors `account.ts`'s `user:` guard.
 */
export function assertSubscriptionStorageTenant(personalTenant: string | undefined): asserts personalTenant is string {
  if (!personalTenant || !personalTenant.startsWith('user:')) {
    throw new OpenwopError(
      'credential_scope_forbidden',
      'A subscription credential can only be stored in your own signed-in (user-scoped) tenant, not a shared workspace (RFC 0121 §B.8).',
      403,
      {},
    );
  }
}

/** ADR 0756 — providers whose CURRENT terms explicitly prohibit a third-party
 *  application routing requests through a user's consumer-plan credentials:
 *   - Anthropic (code.claude.com/docs/en/legal-and-compliance, fetched
 *     2026-09-26): "Anthropic does not permit third-party developers to offer
 *     Claude.ai login into their own applications, or to route requests through
 *     Free, Pro, or Max plan credentials on behalf of their users."
 *   - Google (geminicli.com/docs/resources/tos-privacy, fetched 2026-09-26):
 *     using Gemini CLI OAuth with third-party software "is a violation of
 *     applicable terms and policies."
 *  The ADR 0180 at-own-risk waiver was a RISK waiver for an unresolved question;
 *  for these two the question is resolved against us, so no operator flag can
 *  advertise, store or dispatch them. */
const SUBSCRIPTION_PROHIBITED_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'google']);

export function isSubscriptionProhibitedProvider(provider: string): boolean {
  return SUBSCRIPTION_PROHIBITED_PROVIDERS.has(provider);
}

/** ADR 0757 — providers CLEARED for RFC 0121 `subscription` by their own
 *  sanctioned third-party integration docs (not the at-own-risk waiver). */
export const CLEARED_SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set(['github.copilot']);

/** ADR 0756 — refuse (403 `credential_forbidden`) any subscription use of a
 *  prohibited provider: a value-bearing bind, or a dispatch of a credential that
 *  may have been stored before the narrowing. */
export function assertSubscriptionProviderPermitted(provider: string): void {
  if (isSubscriptionProhibitedProvider(provider)) {
    throw new OpenwopError(
      'credential_forbidden',
      `Subscription credentials for '${provider}' cannot be used: the provider's current terms prohibit third-party applications routing requests through consumer-plan credentials.`,
      403,
      { provider },
    );
  }
}
