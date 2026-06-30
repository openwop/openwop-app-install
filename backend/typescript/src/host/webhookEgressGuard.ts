/**
 * Webhook egress guard — the single denied-range predicate shared by the
 * registration-time SSRF check (`routes/webhooks.ts assertReachableUrl`) and
 * the delivery-time pinned-resolution re-validation (`webhookDeliveryWorker`).
 * One predicate, two call sites, so the two checks can't drift (RFC 0093 §A.1).
 *
 * Delivery-time enforcement (RFC 0093 §A.1-A.2 + `spec/v1/webhooks.md`
 * §"Delivery-time egress validation"): registration-time validation alone
 * leaves a DNS-rebinding TOCTOU window — an attacker registers a public
 * hostname, then flips its A record to `169.254.169.254`. The dispatcher MUST
 * re-resolve at delivery time, validate EVERY resolved address against the
 * same denied ranges, and connect to the validated address (pinned
 * resolution). We implement this with an undici `Agent` whose
 * `connect.lookup` callback validates inside the actual connection's
 * resolution — the addresses the guard approves are exactly the addresses
 * `net.connect` dials, so there is no second resolution to race (no TOCTOU).
 *
 * `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` (local dev / tests only) disables the
 * denied-range check at BOTH layers, consistently. The no-redirect policy
 * (RFC 0093 §A.2) is NOT env-bypassable — it lives in the worker's
 * `redirect: 'error'` fetch policy.
 */

import { lookup as dnsLookup } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.webhookEgressGuard');

/** True when the operator explicitly allows private/loopback egress
 *  (local development / tests only). Read per-call so tests can flip it. */
export function webhookPrivateEgressAllowed(): boolean {
  return process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE === 'true';
}

/**
 * Denied-range predicate per `spec/v1/webhooks.md` §"SSRF protection":
 * loopback, RFC 1918 private, link-local (incl. cloud metadata), IPv6
 * ULA/link-local, and the well-known metadata hostnames. Accepts either a
 * hostname (registration-time check) or a resolved IP literal
 * (delivery-time check); IPv4-mapped IPv6 forms (`::ffff:10.0.0.1`) are
 * unwrapped before matching.
 */
export function isDeniedWebhookHost(hostRaw: string): boolean {
  let host = hostRaw.toLowerCase();
  // Strip brackets from IPv6 literals (URL.hostname keeps them).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (['localhost', '0.0.0.0', '::1', '::', 'metadata', 'metadata.google.internal'].includes(host)) return true;
  if (host === 'localhost.' || host.endsWith('.localhost')) return true;
  // IPv4-mapped IPv6 (dns.lookup family 6 can surface v4 targets this way).
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  // IPv4 dotted-quad
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true;            // 127.0.0.0/8 loopback
    if (a === 10) return true;             // 10.0.0.0/8 RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local + GCP/AWS metadata
    if (a === 0) return true;                          // 0.0.0.0/8
  }
  // IPv6 link-local + ULA
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  return false;
}

/** Error raised when a delivery-time resolution lands in a denied range.
 *  Carries a stable `code` so the worker's failure detail (and tests) can
 *  distinguish an egress refusal from an ordinary network error. */
export class WebhookEgressDeniedError extends Error {
  readonly code = 'OPENWOP_WEBHOOK_EGRESS_DENIED';
  constructor(hostname: string, address: string) {
    super(
      `webhook egress denied: ${hostname} resolved to ${address} (loopback / link-local / private range; RFC 0093 §A.1)`,
    );
    this.name = 'WebhookEgressDeniedError';
  }
}

/**
 * `lookup` implementation passed to undici's connector: runs the system
 * resolver, then rejects the connection when ANY resolved address falls in
 * a denied range. Because the addresses returned here are exactly what the
 * socket dials, validation and connect share one resolution (pinned).
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, address, family);
      return;
    }
    if (!webhookPrivateEgressAllowed()) {
      // `address` is a string for single-answer lookups and a
      // LookupAddress[] when the connector asked for `all` answers
      // (e.g. Happy Eyeballs). Validate every address either way.
      const resolved = Array.isArray(address) ? address.map((a) => a.address) : [address];
      const denied = resolved.find((a) => typeof a === 'string' && isDeniedWebhookHost(a));
      if (denied) {
        // INT-2: surface SSRF-guard denials as a structured signal (not just a
        // thrown error the caller may swallow) so ops can see blocked egress —
        // a denial at delivery time can indicate DNS-rebind or a misconfig.
        log.warn('webhook_egress_denied', { hostname, resolvedAddress: denied });
        callback(new WebhookEgressDeniedError(hostname, denied), address, family);
        return;
      }
    }
    callback(null, address, family);
  });
};

let dispatcher: Agent | null = null;

/**
 * The undici dispatcher every webhook delivery MUST go through. Lazy
 * singleton: one Agent for the worker's lifetime (connection reuse of an
 * already-validated address is fine — the pinned resolution was checked at
 * connect time, which is the property RFC 0093 §A.1 demands).
 */
export function webhookEgressDispatcher(): Agent {
  if (!dispatcher) {
    dispatcher = new Agent({ connect: { lookup: guardedLookup } });
  }
  return dispatcher;
}
