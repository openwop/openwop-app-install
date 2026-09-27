/**
 * Site client (ADR 0027). The homepage is the host-level SYSTEM site page. Its
 * CONTENT is edited through the standard CMS routes on the reserved `host-site`
 * org (a super admin reaches them via `requireCmsScope` — the "Front page" scope
 * in the CMS Page Builder); this client owns only the on/off switch + the public
 * pointer.
 *
 * - `resolveFrontPage()` — PUBLIC (unauthed) read: is the front page on, and the
 *   fixed system-site pointer to fetch.
 * - `getSiteConfig` / `putSiteConfig` — superadmin on/off toggle.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export interface FrontPagePointer { enabled: boolean; orgId: string; slug: string }
export interface SiteConfig { id: 'site'; enabled: boolean; updatedBy: string; updatedAt: string }

// Resolve once per page load — the pointer changes only when a superadmin saves,
// and an anonymous visitor doesn't need live updates. Cached so the App-root gate
// and FrontPage don't double-fetch.
let cached: Promise<FrontPagePointer> | null = null;

async function fetchPointer(): Promise<FrontPagePointer> {
  try {
    const res = await fetch(`${root}/public-site-config`); // PUBLIC: no auth
    if (res.ok) {
      const j = (await res.json()) as { enabled?: boolean; orgId?: string; slug?: string };
      if (j?.enabled && j.orgId) return { enabled: true, orgId: j.orgId, slug: j.slug || 'home' };
    }
  } catch { /* backend unreachable — treat as off */ }
  return { enabled: false, orgId: '', slug: 'home' };
}

export function resolveFrontPage(): Promise<FrontPagePointer> {
  if (!cached) cached = fetchPointer();
  return cached;
}

/** Drop the cached pointer (after an admin save) so the next read re-resolves. */
export function invalidateFrontPage(): void { cached = null; }

/** An API error that carries the HTTP status, so callers can branch on 403
 *  (superadmin gate) without regex-matching the message prose. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new ApiError(detail || `${ctx} returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export async function getSiteConfig(): Promise<SiteConfig> {
  const res = await fetch(`${root}/site-config`, fetchOpts({ headers: authedHeaders() }));
  return asJson<SiteConfig>(res, 'getSiteConfig');
}

export async function putSiteConfig(input: { enabled: boolean }): Promise<SiteConfig> {
  const res = await fetch(`${root}/site-config`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<SiteConfig>(res, 'putSiteConfig');
}
