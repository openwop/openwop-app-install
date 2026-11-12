/**
 * Docs service (ADR 0392) — the reference-docs surface composed over CMS +
 * Publishing. Owns NO store: docs are CMS pages with `collection:'docs'`
 * (authored + published through the existing editorial state machine), served
 * publicly through Publishing's published-only gate. This service is a thin
 * read projection: the published-docs nav tree, ordered by `docsNav`.
 */
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { publicDocsTenant } from '../../host/publicDocsLane.js';
import { listPages, type Page } from '../cms/cmsService.js';

const log = createLogger('docs');

export interface DocsNavItem {
  slug: string;
  title: string;
  /** The nav ordering key (`docsNav`), or the slug when unset. */
  order: string;
  /** When this doc last changed (the CMS page's `updatedAt`). Reference docs
   *  live or die on whether a reader can tell they're current, so the freshness
   *  signal ships with the nav read rather than needing a second fetch
   *  (UX_UPGRADE-docs D-G6). Already-public data — the same page's
   *  `updatedAt` is served on the public page read and in sitemap.xml. */
  updatedAt: string;
}

/** ADR 0392 — the ordering key for a docs page: its `docsNav` if set, else the
 *  slug (so unordered docs still sort deterministically). */
function orderKeyOf(p: Page): string {
  return typeof p.docsNav === 'string' && p.docsNav ? p.docsNav : p.slug;
}

/** The published docs pages for an org, ordered by `docsNav` then slug. */
/** Bounded response on an UNAUTHENTICATED route (grade pass D6 — the
 *  `capPublic` discipline publishing applies to sitemap/feed). Truncation is
 *  logged, never silent. */
const MAX_PUBLIC_DOCS = 500;

async function orderedPublishedDocs(orgId: string): Promise<{ tenantId: string; pages: Page[] } | null> {
  // ADR 1057 D1 — the ONE public-lane gate, shared with the crawler doors and the sitemap.
  const tenantId = await publicDocsTenant(orgId);
  if (!tenantId) return null;
  const all = (await listPages(tenantId, orgId, { collection: 'docs', status: 'published' }))
    .sort((a, b) => {
      const ao = orderKeyOf(a), bo = orderKeyOf(b);
      return ao === bo ? a.slug.localeCompare(b.slug) : ao.localeCompare(bo);
    });
  if (all.length > MAX_PUBLIC_DOCS) log.warn('public_docs_truncated', { orgId, total: all.length, cap: MAX_PUBLIC_DOCS });
  return { tenantId, pages: all.slice(0, MAX_PUBLIC_DOCS) };
}

/** The published docs nav tree for a public org, ordered by `docsNav` then slug.
 *  Published-only (the Publishing gate) + docs-collection-only.
 *
 *  An unknown org, the `docs` toggle OFF and a lapsed public lane all answer the
 *  SAME empty list, so the nav still reveals nothing about which orgs exist. It is
 *  not a 404: the public shell probes this on every page load to decide whether
 *  to show a Docs link, and "no docs here" is an answer, not an error. */
export async function listPublishedDocs(orgId: string): Promise<DocsNavItem[]> {
  return (await publishedDocsOrNull(orgId)) ?? [];
}

/** ADR 1057 D1 — the same projection, but NULL when the public lane is closed
 *  (unknown org, docs off, lapsed owner), so the crawler index can answer 404
 *  instead of an empty list. */
export async function publishedDocsOrNull(orgId: string): Promise<DocsNavItem[] | null> {
  const resolved = await orderedPublishedDocs(orgId);
  if (!resolved) return null;
  return resolved.pages.map((p) => ({ slug: p.slug, title: p.title, order: orderKeyOf(p), updatedAt: p.updatedAt }));
}

/**
 * ADR 0392 Phase 4 — the `llms.txt` artifact: a plain-text index of the
 * published docs (which the marketing sitemap deliberately excludes). Lives in
 * the docs feature (NOT publishing) so publishing stays docs-ignorant.
 *
 * Correction (2026-08-07, UX_UPGRADE-docs round 2): the ADR called this "a
 * checkbox — no major LLM provider consumes it". That premise no longer holds:
 * IDE agents (Cursor, Claude Code, Copilot, Cline) actively probe `/llms.txt`,
 * and agent requests now exceed human page loads on major hosted-docs
 * platforms. It is a channel; it is wired to the ROOT path and robots.txt, the
 * title is the operator's site name, and each line carries the doc's updated
 * date in the convention's description slot.
 */
export async function llmsTxt(
  orgId: string,
  baseUrl: string,
  siteTitle: string,
  /** ADR 0824 D5 — a site that can say what it IS opens with that (title,
   *  `>` summary, one paragraph) before the listing, per the llms.txt shape. */
  preamble?: { title: string; summary: string; body: string } | null,
): Promise<string> {
  const resolved = await orderedPublishedDocs(orgId);
  if (!resolved) throw new OpenwopError('not_found', 'No documentation site here.', 404, { orgId });
  const abs = (slug: string): string => `${baseUrl.replace(/\/+$/, '')}/docs/${encodeURIComponent(slug)}`;
  const lines = preamble
    ? [`# ${preamble.title}`, '', `> ${preamble.summary}`, '', preamble.body, '', '## Docs']
    : [`# ${siteTitle}`, '', '> Product documentation.', '', '## Docs'];
  // The date is the instant's UTC calendar date — machine-facing data for
  // agents (freshness ranking), not a locale-rendered display string.
  for (const p of resolved.pages) lines.push(`- [${p.title}](${abs(p.slug)}) - updated ${p.updatedAt.slice(0, 10)}`);
  return lines.join('\n') + '\n';
}
