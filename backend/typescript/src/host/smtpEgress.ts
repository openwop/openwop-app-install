/**
 * ADR 0201 — TCP-egress firewall for the SMTP transport.
 *
 * SMTP is raw TCP (465 implicit-TLS / 587 STARTTLS), so it CANNOT ride the
 * HTTPS-only brokered-egress chokepoint (`brokeredEgress.ts`) that the ADR 0187
 * firewall guards. This module is that firewall for the SMTP dial — reusing the
 * SAME predicates so there is ONE egress-security model, not a second:
 *   - the per-tenant ADR 0187 policy (`evaluateEgressHost` / `getEgressRules`), and
 *   - the always-on SSRF baseline (`isDeniedWebhookHost` — loopback / RFC1918 /
 *     link-local / metadata), the same one `webhookEgressGuard` enforces.
 *
 * Rebind-safety (RFC 0093 §A.1 pattern): `assertSmtpDialAllowed` resolves the
 * host and validates EVERY resolved address, then returns a **pinned IP** the
 * caller dials directly (`nodemailer` gets an IP literal for `host`, so it does
 * not re-resolve). Validation and connect therefore share one resolution — no
 * check-then-dial DNS-rebinding TOCTOU. Fail-closed: any denied host/port/address
 * throws `egress_blocked`/403 BEFORE a socket is opened.
 */

import { lookup as dnsLookupCb } from 'node:dns';
import { promisify } from 'node:util';
import { isDeniedWebhookHost, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import { evaluateEgressHost, getEgressRules } from './egressPolicy.js';
import { assertEffectAllowed } from './runEffectContext.js';
import { OpenwopError } from '../types.js';

const dnsLookup = promisify(dnsLookupCb);

/** SMTP submission ports only. 25 (plaintext MX) is excluded — cloud-blocked and
 *  unencrypted; revisit only on a concrete need (ADR 0201 open question). */
export const SMTP_ALLOWED_PORTS: ReadonlySet<number> = new Set([465, 587, 2525]);

/** A validated, pinned dial target — the caller connects to THIS address. */
export interface PinnedSmtpTarget {
  /** The original hostname (for TLS SNI / cert validation). */
  host: string;
  /** The resolved, SSRF-validated IP literal the socket dials (no re-resolution). */
  address: string;
  family: number;
  port: number;
}

/**
 * Fail-closed SMTP dial gate. Enforces, in order:
 *   1. port ∈ {465, 587, 2525};
 *   2. the per-tenant ADR 0187 host policy + SSRF baseline (`evaluateEgressHost`);
 *   3. rebind-safe resolution — every resolved address validated against the SSRF
 *      ranges; returns the pinned IP the caller MUST dial.
 * Throws `egress_blocked`/403 before any connection is opened.
 */
export async function assertSmtpDialAllowed(tenantId: string, host: string, port: number): Promise<PinnedSmtpTarget> {
  // ADR 0531 — SMTP is the second egress lane (raw TCP, so it cannot ride the
  // HTTPS chokepoint above). A replay must not send a real email.
  assertEffectAllowed('email', `smtp ${host}:${port}`);
  const block = (reason: string, detail?: Record<string, unknown>): never => {
    throw new OpenwopError('egress_blocked', `SMTP egress to "${host}:${port}" is blocked (${reason}).`, 403, { host, port, reason, ...detail });
  };

  if (!SMTP_ALLOWED_PORTS.has(port)) block('port_not_allowed', { allowed: [...SMTP_ALLOWED_PORTS] });

  // Same per-tenant policy + SSRF baseline the HTTP chokepoint uses (host-level).
  const rules = await getEgressRules(tenantId);
  const verdict = evaluateEgressHost(host.trim().toLowerCase(), rules);
  if (!verdict.allowed) block(verdict.reason, { mode: rules.mode });

  // Rebind-safe: resolve, validate EVERY address, pin the first allowed one so the
  // socket dials exactly what we approved (no second resolution to race).
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dnsLookup(host, { all: true });
  } catch {
    return block('dns_resolution_failed');
  }
  if (resolved.length === 0) return block('dns_no_address');
  if (!webhookPrivateEgressAllowed()) {
    const denied = resolved.find((r) => isDeniedWebhookHost(r.address));
    if (denied) block('ssrf_private_range', { resolvedAddress: denied.address });
  }
  const pinned = resolved[0]!;
  return { host, address: pinned.address, family: pinned.family, port };
}
