/**
 * ADR 0816 D3 — which URLs the host will POST a Web Push message to.
 *
 * A push "endpoint" is a URL the browser hands the page, and the page hands the
 * backend, which then POSTs to it on every notification. Before this policy the
 * only check was `/^https?:/`, so any signed-in caller could make the backend
 * POST to `169.254.169.254`, an RFC 1918 address, or any other host (blind
 * SSRF, NTFWF-3). Real endpoints come from a handful of browser push services,
 * so the policy is an allowlist, not a denylist:
 *
 *   - `https:` on port 443, no userinfo;
 *   - host dot-boundary-matches a known push service (Chrome/Edge-Chromium/
 *     Opera/Brave/Samsung → FCM, Firefox → Mozilla autopush, legacy Edge →
 *     WNS, Safari → Apple), extensible via `OPENWOP_PUSH_ENDPOINT_HOSTS` — and an
 *     operator-added host must still clear the webhook denied-range predicate;
 *   - OR an exact `scheme://host:port` origin in
 *     `OPENWOP_PUSH_ENDPOINT_ALLOW_ORIGINS` — the WHD-19 shape, the test lane's
 *     capture server, never a blanket private-egress switch.
 *
 * Applied at subscribe AND at delivery, so a row stored before the policy stops
 * egressing rather than being grandfathered.
 */
import { isDeniedWebhookHost, parseWebhookAllowOrigins, webhookOriginKey } from '../host/webhookEgressGuard.js';

/** The push services real browsers hand out. Each entry matches the host itself
 *  and any subdomain of it (dot-boundary, never a bare suffix). */
const KNOWN_PUSH_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

export const PUSH_ENDPOINT_HOSTS_ENV = 'OPENWOP_PUSH_ENDPOINT_HOSTS';
export const PUSH_ENDPOINT_ALLOW_ORIGINS_ENV = 'OPENWOP_PUSH_ENDPOINT_ALLOW_ORIGINS';

function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

function operatorHosts(): string[] {
  const raw = process.env[PUSH_ENDPOINT_HOSTS_ENV];
  if (!raw) return [];
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0 && !isDeniedWebhookHost(h));
}

/** `null` when the endpoint may be pushed to; otherwise the reason it may not. */
export function pushEndpointRefusal(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'endpoint is not a URL';
  }
  if (url.username || url.password) return 'endpoint must not carry credentials';
  const origin = webhookOriginKey(url.protocol, url.hostname, url.port);
  if (origin && parseWebhookAllowOrigins(process.env[PUSH_ENDPOINT_ALLOW_ORIGINS_ENV]).origins.has(origin)) return null;
  if (url.protocol !== 'https:') return 'endpoint must be https';
  if (url.port !== '' && url.port !== '443') return 'endpoint must use port 443';
  const host = url.hostname.toLowerCase();
  if (isDeniedWebhookHost(host)) return 'endpoint host is a private or reserved address';
  const allowed = [...KNOWN_PUSH_HOSTS, ...operatorHosts()];
  if (!allowed.some((entry) => hostMatches(host, entry))) return 'endpoint host is not a known Web Push service';
  return null;
}
