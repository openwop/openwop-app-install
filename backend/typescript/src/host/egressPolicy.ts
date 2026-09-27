/**
 * ADR 0187 — application-layer egress firewall (per-tenant allow/deny rules).
 *
 * openwop-app brokers ALL outbound egress through its own host fetch paths
 * (`brokeredEgress`, the webhook worker, connectors, ads) — there is no local
 * subprocess whose network traffic could be MITM-proxied. So the host's egress
 * firewall is APPLICATION-LAYER: a per-tenant allow/deny host-rule policy
 * enforced at the brokered-fetch chokepoint, layered ON TOP of the always-on
 * SSRF baseline (private/loopback/metadata ranges are denied for every tenant,
 * regardless of rules — that guard is never relaxed by an allowlist).
 *
 * Precedence at a dispatch:
 *   1. SSRF baseline (`isDeniedWebhookHost`) — DENY private/loopback/metadata, EXCEPT
 *      when `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` (local dev / tests only; never prod).
 *      This mirrors the brokered-egress chokepoints, which already gate the identical
 *      loopback check behind that flag — keeping both SSRF checks consistent so a
 *      loopback mock server is reachable under the dev/test flag and denied without it.
 *   2. Tenant rules:
 *      - `off`        → allow (SSRF baseline still applies).
 *      - `denylist`   → DENY if the host matches any rule host (else allow).
 *      - `allowlist`  → DENY unless the host matches a rule host (default-deny).
 * A rule host matches its exact host AND any subdomain (suffix match), so
 * `example.com` covers `api.example.com`.
 *
 * Rules are operator/superadmin state (per tenant), stored in a DurableCollection
 * — NOT agent- or caller-settable. `assertEgressAllowed` is fail-closed: a
 * denied host throws `egress_blocked`/403 before any connection is dialed.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { isDeniedWebhookHost, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';
import { OpenwopError } from '../types.js';

export type EgressMode = 'off' | 'allowlist' | 'denylist';

/** Per-tenant egress rule set (superadmin-managed runtime state). */
export interface EgressRuleSet {
  tenantId: string;
  mode: EgressMode;
  /** Lower-cased hostnames; each matches itself + any subdomain (suffix). */
  hosts: string[];
}

const DEFAULT_RULES = (tenantId: string): EgressRuleSet => ({ tenantId, mode: 'off', hosts: [] });

const rulesByTenant = new DurableCollection<EgressRuleSet>('egress-rules', (r) => r.tenantId);

function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

/** True when `host` equals `rule` or is a subdomain of it (suffix match). */
function hostMatchesRule(host: string, rule: string): boolean {
  const h = normalizeHost(host);
  const r = normalizeHost(rule);
  return r.length > 0 && (h === r || h.endsWith(`.${r}`));
}

/**
 * Pure evaluation of an egress decision for a bare `host` under `rules`. Enforces
 * the SSRF baseline first (never relaxed), then the tenant mode. Never throws.
 * Shared by the HTTP path (`evaluateEgress`, via a parsed URL host) AND the SMTP
 * transport (`smtpEgress`, which has a host not a URL) so both honor ONE tenant
 * policy + ONE SSRF baseline — there is no second egress-firewall model.
 */
export function evaluateEgressHost(host: string, rules: EgressRuleSet): { allowed: boolean; reason: string } {
  // 1. SSRF baseline — private/loopback/metadata denied for everyone, always,
  // unless the dev/test flag is set (parity with the brokered-egress chokepoints).
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(host)) return { allowed: false, reason: 'ssrf_private_range' };
  // 2. Tenant rules.
  const matched = rules.hosts.some((r) => hostMatchesRule(host, r));
  if (rules.mode === 'denylist') {
    return matched ? { allowed: false, reason: 'denylist_match' } : { allowed: true, reason: 'ok' };
  }
  if (rules.mode === 'allowlist') {
    return matched ? { allowed: true, reason: 'ok' } : { allowed: false, reason: 'not_on_allowlist' };
  }
  return { allowed: true, reason: 'ok' }; // mode 'off' — SSRF baseline only.
}

/**
 * Pure evaluation of an egress decision for `url` under `rules`. Enforces the
 * SSRF baseline first (never relaxed), then the tenant mode. Never throws.
 */
export function evaluateEgress(url: string, rules: EgressRuleSet): { allowed: boolean; reason: string } {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }
  return evaluateEgressHost(host, rules);
}

/** Read a tenant's egress rules (defaults to `off` when unset). */
export async function getEgressRules(tenantId: string): Promise<EgressRuleSet> {
  return (await rulesByTenant.get(tenantId)) ?? DEFAULT_RULES(tenantId);
}

/** Persist a tenant's egress rules (superadmin). Normalizes + de-dupes hosts. */
export async function putEgressRules(tenantId: string, mode: EgressMode, hosts: string[]): Promise<EgressRuleSet> {
  const cleaned = [...new Set((hosts ?? []).map(normalizeHost).filter((h) => h.length > 0))];
  const next: EgressRuleSet = { tenantId, mode, hosts: cleaned };
  await rulesByTenant.put(next);
  return next;
}

/**
 * Fail-closed egress gate for the brokered-fetch chokepoints. Loads the tenant's
 * rules and throws `egress_blocked`/403 when `url` is denied — call BEFORE dialing.
 * A tenant on the default `off` policy pays only the SSRF-baseline check.
 */
export async function assertEgressAllowed(tenantId: string, url: string): Promise<void> {
  const rules = await getEgressRules(tenantId);
  const verdict = evaluateEgress(url, rules);
  if (!verdict.allowed) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* invalid_url */ }
    throw new OpenwopError(
      'egress_blocked',
      `Egress to "${host}" is blocked by the tenant egress policy (${verdict.reason}).`,
      403,
      { host, reason: verdict.reason, mode: rules.mode },
    );
  }
}
