/**
 * The externally-visible origin a CALLER actually reached this backend on,
 * derived from the inbound request. Behind a TLS-terminating proxy (Cloud Run,
 * a load balancer) the real scheme/host arrive as `X-Forwarded-Proto` /
 * `X-Forwarded-Host`; `req.protocol`/`req.get('host')` alone would report the
 * internal `http`/host. Those forwarded values are client/proxy-influenceable,
 * so the host is sanitized to a valid host token (CR/LF + anything outside the
 * host charset stripped — header-injection defeat) and the scheme constrained to
 * http(s).
 *
 * This is the ONE place that derivation lives, so the policy can't drift across
 * the public surfaces that build absolute URLs (the `a2a.agentCardUrl`
 * advertisement, the synthesized A2A AgentCard `url`, the publishing/sharing
 * base URL). We deliberately do NOT flip a global `trust proxy` (it would change
 * `req.ip` rate-limit keying + `req.secure` cookie semantics app-wide) — the
 * forwarded headers are read locally here instead.
 */

import type { Request } from 'express';

/** The sanitized `scheme://host` the request arrived on (forwarded-aware). */
export function requestOrigin(req: Request): string {
  const rawHost = req.get('x-forwarded-host') ?? req.get('host') ?? 'localhost';
  const host = (rawHost.split(',')[0] ?? '').trim().replace(/[^A-Za-z0-9.:\[\]-]/g, '') || 'localhost';
  const rawProto = (req.get('x-forwarded-proto') ?? req.protocol ?? 'http').split(',')[0]!.trim().toLowerCase();
  return `${rawProto === 'https' ? 'https' : 'http'}://${host}`;
}
