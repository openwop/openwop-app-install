/**
 * ADR 0757 — GitHub Copilot, the RFC 0121 CLEARED `subscription` provider.
 *
 * Cleared by the provider's own sanctioned third-party integration docs (RFC 0121
 * UQ1, steward's named go 2026-09-26): GitHub's Copilot SDK auth guide describes a
 * GitHub OAuth App that "enables your application to make Copilot API requests on
 * behalf of users who authorize your app", for "SaaS applications building on top
 * of Copilot" and "any multi-user application"
 * (docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate). A citation of
 * the provider's documentation — not a legal review.
 *
 * It does NOT ride the ADR 0180 at-own-risk flags or its ToS-risk consent: it is
 * advertised only when THIS host is actually configured to serve it (RFC 0121
 * §B.9) — a GitHub OAuth client AND a loopback Copilot sidecar. Dark by default.
 *
 * Pure + env-only (no store reads), so discovery can evaluate it synchronously.
 */

/** Vendor-prefixed RFC 0067 provider id (clients MUST tolerate unknown ids). */
export const COPILOT_PROVIDER_ID = 'github.copilot';

/** The GitHub OAuth App client, from env only:
 *  `OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID` / `…_CLIENT_SECRET`. A dedicated app
 *  (not the connections `github` pack's), so its requested scope stays minimal. */
export function copilotOAuthClient(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_ID?.trim();
  const clientSecret = process.env.OPENWOP_OAUTH_GITHUB_COPILOT_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * The Copilot sidecar base URL (`OPENWOP_COPILOT_ENDPOINT`, e.g.
 * `http://127.0.0.1:8791/v1`), or `null`.
 *
 * LOOPBACK ONLY, by construction (ADR 0757 architect CRITICAL-1): the user's
 * GitHub OAuth token is sent to this URL, so it must never be one config typo
 * away from an arbitrary host. A non-loopback value is ignored — the provider
 * then stays dark rather than sending a GitHub credential off-box.
 */
export function copilotEndpoint(): string | null {
  const raw = process.env.OPENWOP_COPILOT_ENDPOINT?.trim();
  if (!raw) return null;
  return isLoopbackHttpUrl(raw) ? raw.replace(/\/+$/, '') : null;
}

export function isLoopbackHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return LOOPBACK_HOSTS.has(u.hostname);
}

/** RFC 0121 §B.9 — advertise `subscription` for Copilot ONLY when both halves of
 *  the mechanism are configured: the OAuth client (acquisition) and the loopback
 *  sidecar (dispatch). */
export function copilotSubscriptionConfigured(): boolean {
  return copilotOAuthClient() !== null && copilotEndpoint() !== null;
}
