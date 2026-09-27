/** ADR 0392 — the public docs nav-tree client (no auth; published-only). */
import { config, fetchOpts } from '../../client/config.js';

export interface DocsNavItem {
  slug: string;
  title: string;
  order: string;
  /** When this doc last changed (the CMS page's `updatedAt`) — the freshness
   *  signal reference docs live on (UX_UPGRADE-docs D-G6). */
  updatedAt: string;
}

const root = `${config.baseUrl}/host/openwop-app`;

/** Fetch the published docs nav tree. A 404 (docs off / unknown org) is the
 *  designed EMPTY state ([]); a network/5xx failure is NULL so the page can
 *  render an error state instead of masquerading as "no docs yet"
 *  (grade-ux UX-D2 — error/empty conflation). */
export async function getDocsNav(orgId: string): Promise<DocsNavItem[] | null> {
  try {
    const res = await fetch(`${root}/public/${encodeURIComponent(orgId)}/docs`, fetchOpts({}));
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { docs?: DocsNavItem[] };
    return Array.isArray(body.docs) ? body.docs : [];
  } catch {
    return null;
  }
}

/** R2-D12 — the page's markdown door (the append-`.md` convention), served by
 *  Publishing beside the JSON read. Used by the article's copy affordance. */
export function docMarkdownUrl(orgId: string, slug: string): string {
  return `${root}/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}.md`;
}
