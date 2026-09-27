/**
 * Brand-alias search expansion (day-1 UX P4 / defect-list B2).
 *
 * Users search the palette by the BRAND they use ("gmail", "outlook",
 * "jira") — but this host deliberately ships provider-agnostic nodes
 * (ADR 0186 capability-dispatch): work runs through generic steps
 * (Email Send, openapi-call, chat message) bound to a connection. A raw
 * brand query therefore returned 0 matches and read as "doesn't
 * integrate with my stack" — the opposite of the truth.
 *
 * This module is the ONE owner of the brand→capability-term dictionary.
 * `expandQuery` unions the raw query with the capability terms its
 * brand tokens imply; the palette matches an entry when ANY term hits,
 * and shows an explainer line so the substitution is honest, not
 * magical. Presentation-only — no node, catalog, or wire change.
 */

/** Lower-case brand token → capability terms that hit today's catalog. */
const BRAND_ALIASES: Record<string, readonly string[]> = {
  gmail: ['email'],
  outlook: ['email'],
  microsoft: ['email', 'calendar', 'openapi'],
  m365: ['email', 'calendar', 'openapi'],
  office: ['email', 'calendar', 'openapi'],
  teams: ['message', 'chat'],
  onedrive: ['file', 'storage'],
  sharepoint: ['file', 'knowledge'],
  drive: ['file', 'storage'],
  dropbox: ['file', 'storage'],
  box: ['file', 'storage'],
  sheets: ['csv', 'table'],
  excel: ['csv', 'table'],
  salesforce: ['crm'],
  hubspot: ['crm'],
  jira: ['ticket', 'incident', 'openapi'],
  servicenow: ['ticket', 'incident'],
  workday: ['hr', 'openapi'],
  netsuite: ['finance', 'openapi'],
  notion: ['document', 'knowledge'],
  zoom: ['meeting', 'voice'],
  gcal: ['calendar'],
};

export interface ExpandedQuery {
  /** All lower-case terms to match (the raw query first). */
  terms: readonly string[];
  /** The brand tokens that contributed aliases (drives the explainer). */
  brands: readonly string[];
}

/** Expand a palette query with brand aliases. The raw query always stays a
 *  match term (aliases ADD recall, never replace); tokens are looked up
 *  individually so "gmail send" still aliases on "gmail". */
export function expandQuery(query: string): ExpandedQuery {
  const raw = query.trim().toLowerCase();
  if (!raw) return { terms: [], brands: [] };
  const terms = new Set<string>([raw]);
  const brands: string[] = [];
  for (const token of raw.split(/\s+/)) {
    const aliases = BRAND_ALIASES[token];
    if (!aliases) continue;
    brands.push(token);
    for (const a of aliases) terms.add(a);
  }
  return { terms: [...terms], brands };
}
