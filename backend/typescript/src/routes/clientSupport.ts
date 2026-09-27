/**
 * Client-support handshake (ADR 0413 — host-side delta, non-normative).
 *
 *   GET /v1/host/openwop-app/client-support?build=<int>&platform=<web|ios|android>
 *
 * A client asks, at startup, whether its build is still supported. The host
 * publishes the operator-configured minimum-supported build (a version FLOOR) and
 * an optional upgrade URL; the CLIENT self-gates (shows an upgrade prompt / reload).
 * This is deliberately **advertise-only** — there is NO enforcement middleware that
 * 426s live traffic: a mis-set floor must never lock users out, and forcing an
 * upgrade is the client's UX decision, not a hard request gate.
 *
 * Why it exists: ADR 0413 (native participant client) calls for a "host-private
 * minimum-supported-build handshake" so a shipped mobile build can be retired. It
 * ALSO serves the existing web/PWA — a stale cached SPA calling a newer backend is a
 * real skew hazard (see DEPLOY.md), and this lets the backend tell it to reload.
 *
 * Non-normative (`/v1/host/openwop-app/*`) — advertises nothing on the OpenWOP wire,
 * so no RFC. Public + unauthenticated by design: a client checks this BEFORE it has
 * a session, and the only thing disclosed is a build number the operator chose.
 * Default floor 0 ⇒ everything supported (a no-op until an operator sets a floor).
 */

import type { Express } from 'express';

type Platform = 'web' | 'ios' | 'android';
const PLATFORMS: readonly Platform[] = ['web', 'ios', 'android'];

/** A non-negative integer from an env var, else 0 (no floor). */
function envBuild(name: string): number {
  const v = Number(process.env[name] ?? '');
  return Number.isInteger(v) && v > 0 ? v : 0;
}

/** The effective floor for a platform: the per-platform override if set, else the
 *  global floor. Read at request time so an operator can retune without a redeploy. */
function minBuildFor(platform: Platform | 'unknown'): number {
  const global = envBuild('OPENWOP_MIN_CLIENT_BUILD');
  if (platform === 'unknown') return global;
  const perPlatform = envBuild(`OPENWOP_MIN_CLIENT_BUILD_${platform.toUpperCase()}`);
  return perPlatform > 0 ? perPlatform : global;
}

function upgradeUrlFor(platform: Platform | 'unknown'): string | undefined {
  if (platform === 'unknown') return process.env.OPENWOP_CLIENT_UPGRADE_URL || undefined;
  return process.env[`OPENWOP_CLIENT_UPGRADE_URL_${platform.toUpperCase()}`] || process.env.OPENWOP_CLIENT_UPGRADE_URL || undefined;
}

/** Parse the client's platform from the query or the `x-openwop-client-platform`
 *  header; anything not in the closed set is `unknown` (falls back to the global floor). */
function parsePlatform(raw: unknown): Platform | 'unknown' {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  return (PLATFORMS as readonly string[]).includes(s) ? (s as Platform) : 'unknown';
}

/** Parse the client's build from the query or `x-openwop-client-build`; a missing or
 *  non-integer build is `null` (treated as supported — we never gate an UNKNOWN build). */
function parseBuild(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null; // absent/empty ⇒ unknown (never gated), NOT build 0
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function registerClientSupportRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/client-support', (req, res) => {
    const platform = parsePlatform(req.query.platform ?? req.header('x-openwop-client-platform'));
    const build = parseBuild(req.query.build ?? req.header('x-openwop-client-build'));
    const minBuild = minBuildFor(platform);
    // Unknown build ⇒ supported (never lock out a client we can't classify). Known
    // build ⇒ supported iff at or above the floor. Floor 0 ⇒ always supported.
    const supported = build === null || minBuild === 0 || build >= minBuild;
    const upgradeUrl = supported ? undefined : upgradeUrlFor(platform);
    res.json({
      platform,
      minBuild,
      ...(build !== null ? { build } : {}),
      supported,
      ...(upgradeUrl ? { upgradeUrl } : {}),
    });
  });
}
