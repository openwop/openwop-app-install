/**
 * RFC 0200 §A/§B — the protected-resource metadata URL, and the `WWW-Authenticate`
 * challenge that points a generic OAuth client at it.
 *
 * A LEAF MODULE ON PURPOSE. Both `middleware/auth.ts` (which refuses) and
 * `routes/discovery.ts` (which serves the document) need the same URL, and the two
 * import each other's neighbourhood freely. Deriving it in either would put a cycle in
 * the other's path — the failure this repo hit hours before this file was written, where
 * an ESM cycle left `undefined` in a module-level registry and surfaced as an unrelated
 * test. So: no imports from this module except types.
 *
 * @see RFCS/0200-host-as-oauth-protected-resource.md §A.2, §B
 * @see RFC 9728 §3.1 (the URL form), RFC 6750 §3.1 (the error codes)
 */

import type { Request, Response } from 'express';
import { requestOrigin } from '../host/requestOrigin.js';

/** RFC 9728 §3 — inserted between the host component and any path of the resource id. */
export const PRM_SEGMENT = '/.well-known/oauth-protected-resource';

/**
 * The resource identifier this request reached us as — origin plus the path prefix the
 * caller used, which behind the Hosting rewrite is `/api` and locally is empty.
 *
 * DERIVED FROM THE REQUEST rather than from `OPENWOP_PUBLIC_BASE_URL`, for the same
 * reason the A2A card is (`routes/discovery.ts`): that env is the SPA/OAuth origin, and
 * the SPA host routes only `/api/**` to this backend. The suite forms the URL from ITS
 * base URL and compares `resource` to it, so echoing the identifier the caller actually
 * used is what makes the document a projection instead of a second declaration.
 */
export function resourceIdentifier(req: Request, apiPathPrefix: string): string {
  return `${requestOrigin(req)}${apiPathPrefix}`;
}

/** RFC 9728 §3.1 — `https://h/api` → `https://h/.well-known/oauth-protected-resource/api`. */
export function prmUrlFor(resource: string): string {
  const u = new URL(resource);
  const path = u.pathname.replace(/\/$/, '');
  return `${u.origin}${PRM_SEGMENT}${path}`;
}

/**
 * The path prefix the caller reached this backend on: `/api` behind the Hosting rewrite
 * (which strips nothing — `/api/v1/runs` arrives as `/api/v1/runs` only when the proxy
 * preserves it), else empty. Read from the ORIGINAL url so a router mount cannot hide it.
 */
export function apiPathPrefixOf(req: Request): string {
  return (req.originalUrl ?? req.url ?? '').startsWith('/api/') ? '/api' : '';
}

export interface ChallengeOptions {
  /**
   * Whether the request PRESENTED a credential. RFC 6750 §3.1 and RFC 0200 §B: a 401 for
   * a request that presented none MUST NOT carry an `error` — an error code describes a
   * credential that was refused, and inventing one tells a client its absent token was
   * rejected.
   */
  readonly presented: boolean;
  /** Set only on a 403 for scope; `invalid_token` is implied by `presented` on a 401. */
  readonly error?: 'insufficient_scope';
  /** Every scope the operation requires — RFC 6750 §3.1, space-delimited. */
  readonly scope?: readonly string[];
}

const quote = (v: string): string => `"${v.replace(/["\\]/g, '\\$&')}"`;

/**
 * Attach the `Bearer` challenge. NEVER changes the status and NEVER creates a response —
 * RFC 0200 §B.3: a challenge must not replace a non-disclosure 404 nor turn one status
 * into another. Callers add it to a refusal they have already decided on, which is why
 * this takes a `Response` and sets one header rather than sending anything.
 */
export function setBearerChallenge(req: Request, res: Response, opts: ChallengeOptions): void {
  const params: string[] = [];
  if (opts.error !== undefined) params.push(`error=${quote(opts.error)}`);
  else if (opts.presented) params.push(`error=${quote('invalid_token')}`);
  if (opts.scope !== undefined && opts.scope.length > 0) params.push(`scope=${quote(opts.scope.join(' '))}`);
  params.push(`resource_metadata=${quote(prmUrlFor(resourceIdentifier(req, apiPathPrefixOf(req))))}`);
  res.setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`);
}
