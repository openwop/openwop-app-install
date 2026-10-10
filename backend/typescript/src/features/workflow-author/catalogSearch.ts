/**
 * ADR 0791 — the Workflow Architect reads the node catalog BY SEARCH, not whole.
 *
 * The closed-world catalog is 784 node types and ~232k tokens with their
 * schemas (measured 2026-09-30). Returned whole on every `draft`, one read blew
 * the managed tier's 50k daily token cap by itself and cost ~$0.60 on a paid
 * model — so a Pair turn on the free tier could not complete (ADR 0773 G-10b).
 * Even an index of just id + label + category is ~20k tokens.
 *
 * So the tool answers a QUESTION: the node types that match what the model is
 * looking for, each with its full schemas (the closed-world contract per node is
 * unchanged — nothing about a returned node is elided). The closed-world GUARD
 * does not depend on the model having seen every type: `validate` and `persist`
 * still refuse any typeId the host cannot run (`findUnknownTypeIds`).
 *
 * Pure and deterministic: same catalog + same query ⇒ same result and order.
 */

import type { AuthorCatalogNode } from './workflowAuthorService.js';

// 5, not 10: every match carries its full schemas (~470 tokens each, measured
// 2026-10-01), and a tool result is re-sent on every later round of the turn.
// A first draft made four searches in one round and added 18.8k prompt tokens.
export const CATALOG_SEARCH_DEFAULT_LIMIT = 5;
export const CATALOG_SEARCH_MAX_LIMIT = 25;
export const CATALOG_SEARCH_MAX_TYPE_IDS = 25;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'i', 'if', 'in', 'into', 'is', 'it',
  'me', 'my', 'node', 'nodes', 'of', 'on', 'or', 'our', 'so', 'step', 'steps', 'that', 'the', 'then', 'this', 'to',
  'we', 'when', 'with', 'you', 'your',
]);

/** Lowercase word tokens, stopwords removed. `feature.crm.nodes.create-contact` → crm, create, contact, … */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreNode(node: AuthorCatalogNode, tokens: readonly string[], phrase: string): number {
  const idWords = new Set(tokenize(node.typeId));
  const labelWords = new Set(tokenize(node.label));
  const label = node.label.toLowerCase();
  const typeId = node.typeId.toLowerCase();
  const description = node.description.toLowerCase();
  const category = node.category.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (labelWords.has(t)) score += 4;
    else if (label.includes(t)) score += 2;
    if (idWords.has(t)) score += 3;
    else if (typeId.includes(t)) score += 1;
    if (category === t) score += 3;
    if (description.includes(t)) score += 1;
    // A light stem for longer words ("deduplicate" ↔ "dedupe", "scheduling" ↔
    // "schedule"): a 5-letter prefix match, weighted below any whole-word hit.
    if (t.length >= 6) {
      const stem = t.slice(0, 5);
      if (!label.includes(t) && label.includes(stem)) score += 1;
      if (!typeId.includes(t) && typeId.includes(stem)) score += 1;
      if (!description.includes(t) && description.includes(stem)) score += 1;
    }
  }
  if (phrase.length > 2 && label.includes(phrase)) score += 5;
  if (typeId === phrase) score += 20;
  return score;
}

/**
 * ADR 0773 G-10b / ADR 0791 correction (2026-10-04) — the general building
 * blocks a step is composed from when the catalog has nothing MADE for it.
 *
 * MEASURED: two models (MiniMax-M3 and Gemini 3.8 Flash) failed the same two
 * eval cases the same way — "tag duplicate leads" and "score the lead" — by
 * searching the catalog again and again (up to nine searches) and never
 * drawing. The catalog has no lead-dedupe or lead-scoring node; a lexical
 * search for "score" returns other features' scorers (job-search fit, talent,
 * idea, market opportunity), which the model rightly rejects; and nothing told
 * it to stop. These are the nodes such a step is built from, returned as full
 * catalog entries (schemas included, never shortened — ADR 0604) plus what each
 * is for. Filtered to what the workspace's catalog actually lists; a test pins
 * every id to a vendored pack.
 */
export const GENERAL_BLOCKS: ReadonlyArray<{ typeId: string; use: string }> = [
  { typeId: 'core.openwop.ai.classify', use: 'judge, label, tag or score an item with a model (lead quality, is-duplicate, sentiment)' },
  { typeId: 'core.openwop.ai.transform', use: 'reshape, extract or rewrite fields with a model' },
  { typeId: 'core.ai.structuredOutput', use: 'ask a model for a typed JSON answer (a score plus a reason)' },
  { typeId: 'core.ai.chatCompletion', use: 'free-form model step (summarise, draft, decide)' },
  { typeId: 'core.flow.if', use: 'branch on a value (a score above a threshold, a duplicate flag)' },
];

/** What the result says when nothing in the catalog is made for the ask. */
export const NO_DEDICATED_MATCH_HINT =
  'No node in this catalog is made for this. Build the step from one of `generalBlocks` '
  + '(each carries its full schemas, like a search hit) and say so in the op\'s `why`. Do not keep searching for a dedicated node.';

/** A hit is DEDICATED when its own name — label or typeId words, not only its
 *  description or a stem — carries the ask: at least two query words, or the
 *  one word of a one-word query. "score lead" against `job-search.score-fit`
 *  shares only "score", so that is a near-miss, not a match. */
function isDedicated(node: AuthorCatalogNode, tokens: readonly string[], phrase: string): boolean {
  if (node.typeId.toLowerCase() === phrase) return true;
  const own = new Set([...tokenize(node.typeId), ...tokenize(node.label)]);
  const hits = new Set(tokens.filter((t) => own.has(t))).size;
  return hits >= Math.min(2, new Set(tokens).size);
}

export interface CatalogSearchInput {
  query?: string | undefined;
  typeIds?: readonly string[] | undefined;
  limit?: number | undefined;
}

export interface CatalogSearchResult {
  /** The matching node types, each WITH its full schemas. */
  nodes: AuthorCatalogNode[];
  /** How many node types matched the query (before `limit`). */
  matched: number;
  /** How many node types the whole catalog has (for "search again" judgement). */
  total: number;
  /** Requested typeIds this workspace's catalog does not list. */
  unknownTypeIds?: string[];
  /** Present on an EMPTY read (no query, no typeIds): what exists, and how to ask. */
  categories?: Record<string, number>;
  /** A query whose matches are all near-misses (or none): nothing here is made for it. */
  noDedicatedMatch?: true;
  /** With `noDedicatedMatch`: the general nodes to compose the step from, and what to do. */
  generalBlocks?: Array<AuthorCatalogNode & { use: string }>;
  hint?: string;
}

export function searchAuthoringCatalog(catalog: readonly AuthorCatalogNode[], input: CatalogSearchInput): CatalogSearchResult {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? CATALOG_SEARCH_DEFAULT_LIMIT), 1), CATALOG_SEARCH_MAX_LIMIT);
  const byId = new Map(catalog.map((n) => [n.typeId, n]));

  const picked: AuthorCatalogNode[] = [];
  const seen = new Set<string>();
  const unknownTypeIds: string[] = [];
  for (const id of (input.typeIds ?? []).slice(0, CATALOG_SEARCH_MAX_TYPE_IDS)) {
    const node = byId.get(id);
    if (!node) { unknownTypeIds.push(id); continue; }
    if (!seen.has(id)) { seen.add(id); picked.push(node); }
  }

  const phrase = (input.query ?? '').trim().toLowerCase();
  const tokens = tokenize(phrase);
  let matched = picked.length;
  if (tokens.length > 0 || byId.has(phrase)) {
    const ranked = catalog
      .map((n) => ({ n, s: scoreNode(n, tokens, phrase) }))
      .filter((r) => r.s > 0 && !seen.has(r.n.typeId))
      .sort((a, b) => b.s - a.s || a.n.typeId.localeCompare(b.n.typeId));
    matched += ranked.length;
    for (const r of ranked) {
      if (picked.length >= limit + (input.typeIds?.length ?? 0)) break;
      picked.push(r.n);
    }
  }

  const result: CatalogSearchResult = { nodes: picked, matched, total: catalog.length };
  // A query was asked and nothing returned is MADE for it — say so, and point at
  // the general blocks instead of letting the model search forever.
  if (tokens.length > 0 && !picked.some((n) => isDedicated(n, tokens, phrase))) {
    // FULL catalog entries, schemas included — exactly what a search hit carries.
    // B.5 returned pointers and said "fetch the schema with `typeIds`"; MEASURED
    // 2026-10-04 the model read that as the separate `schema.lookup` tool, failed,
    // and spent its turn recovering (2 of 3 first-draft runs). Nothing to fetch now.
    const blocks = GENERAL_BLOCKS.flatMap((b) => {
      const n = byId.get(b.typeId);
      return n ? [{ ...n, use: b.use }] : [];
    });
    if (blocks.length > 0) {
      result.noDedicatedMatch = true;
      result.generalBlocks = blocks;
      result.hint = NO_DEDICATED_MATCH_HINT;
    }
  }
  if (unknownTypeIds.length > 0) result.unknownTypeIds = unknownTypeIds;
  // What exists and how to ask: on an EMPTY read, and on a search that found
  // nothing (so the model can pick other words instead of guessing a typeId).
  if ((tokens.length === 0 && !byId.has(phrase) && (input.typeIds ?? []).length === 0) || picked.length === 0) {
    const categories: Record<string, number> = {};
    for (const n of catalog) categories[n.category] = (categories[n.category] ?? 0) + 1;
    result.categories = categories;
  }
  return result;
}

export interface ExcludedEntry { typeId: string; reason: string }

/**
 * ADR 0791 correction (ADR 0773 B.2) — which withheld nodes a `draft` answer
 * carries. The full list (~500 tokens) used to ride EVERY call, and every tool
 * result is re-sent on each later round of the turn, so four searches paid for
 * it four times over, then again each round after.
 *
 * `excluded` exists to answer "is the node I want withheld here?". So it carries:
 * - ALL withheld nodes on an empty read and on a search that matched nothing
 *   (the moments that question is actually being asked);
 * - otherwise, only the withheld nodes this ask names (a requested typeId) or
 *   whose typeId words match the query.
 * `excludedTotal` always says how many there are, so a filtered list never
 * reads as the whole. This filters which ENTRIES return, as the search already
 * does for nodes; it never shortens an entry.
 */
export function selectExcluded(
  excluded: readonly ExcludedEntry[],
  input: CatalogSearchInput,
  result: CatalogSearchResult,
): { excluded: ExcludedEntry[]; excludedTotal: number } {
  const excludedTotal = excluded.length;
  if (result.categories) return { excluded: [...excluded], excludedTotal };
  const requested = new Set(input.typeIds ?? []);
  const phrase = (input.query ?? '').trim().toLowerCase();
  const tokens = tokenize(phrase);
  const relevant = excluded.filter((e) => {
    if (requested.has(e.typeId) || e.typeId.toLowerCase() === phrase) return true;
    const idWords = new Set(tokenize(e.typeId));
    return tokens.some((t) => idWords.has(t) || (t.length >= 6 && [...idWords].some((w) => w.startsWith(t.slice(0, 5)))));
  });
  return { excluded: relevant, excludedTotal };
}
