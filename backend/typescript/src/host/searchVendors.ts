/**
 * Search-vendor descriptors — the wire shapes `webResearchSurface.searchLive`
 * can speak, expressed declaratively.
 *
 * WHY THIS EXISTS. `searchLive` spoke exactly ONE dialect: Brave's
 * (`x-subscription-token` header, `body.web.results`, Brave's base URL). A tenant
 * holding a Tavily or Exa key could not use it — the key resolved fine and was
 * then sent to Brave's endpoint with Brave's header. Since the app's
 * evidence-bound pipelines are fail-closed without live search, that single
 * hard-coded dialect is what kept research effectively gated behind an operator
 * step almost nobody takes.
 *
 * It matters which vendors: as of 2026 the free tiers differ by an order of
 * magnitude — Exa ~20,000 requests/month, Brave ~2,000, Tavily ~1,000 credits —
 * (CORRECTED 2026-09-17: Exa's is now a $20 starter credit plus $10/month per
 * exa.ai/pricing; each descriptor's `freeTier` below is the current claim) —
 * so supporting more than one is the difference between "configure a key" being a
 * two-minute self-serve step and a real adoption wall.
 *
 * SHAPE. This mirrors `host/imageProviderAdapter.ts` (ADR 0115/0244), the
 * established precedent for "one host capability, several third-party backends":
 * ONE adapter with an explicit vendor map, never a module per vendor. ADR 0101's
 * "ONE owner" rule is about the CAPABILITY (`host.webResearch`) — a vendor map
 * lives INSIDE that owner and does not fork it.
 *
 * A descriptor is data, not code: request shaping in, result normalization out.
 * Adding a vendor is a table entry, so no call site branches on vendor identity.
 *
 * SUITABILITY. Every entry declares `suitability` (see `webSearchCapability.ts`).
 * Search APIs are SOLD for programmatic retrieval and return real publisher URLs,
 * so they are `durable` — unlike an LLM provider's native grounding, whose links
 * may be licensed for display only. The field is the same on both so one predicate
 * governs both lanes.
 *
 * PERPLEXITY — evaluated 2026-08-02, deliberately NOT added. Read this before
 * adding it, because the technical fit is good enough to be misleading.
 *
 *   Wire shape maps 1:1 onto this descriptor and would need no call-site change:
 *   `POST https://api.perplexity.ai/search`, `Authorization: Bearer <key>`, body
 *   `{ query, max_results }` (1–20, default 10), response
 *   `{ results: [{ url, title, snippet, date?, last_updated? }] }` — simpler than
 *   Exa's, whose `contents.highlights` quirk already cost us one snippet-less bug.
 *
 *   Two things stop it, and only the FIRST is a real blocker:
 *
 *   1. SUITABILITY IS UNDETERMINED, and this module may not guess it. Perplexity
 *      puts the Search API under its OWN terms, separate from the main API terms,
 *      and states that Search Services are EXCLUDED from the zero-data-retention
 *      obligations covering Chat Completions — so the Search terms differ
 *      materially and must be read, not inferred from the Sonar/chat terms. The
 *      ToS page refuses automated fetch (403), so this needs a human to open it.
 *      Until someone does, the honest value is `none` (the fail-closed default in
 *      `providerSuitability`), which would make the entry useless. Marking it
 *      `durable` on the strength of "it returns real URLs" is the exact inference
 *      the Gemini analysis in `webSearchCapability.ts` exists to warn against:
 *      capability is technical, suitability is licensing, and they are independent.
 *
 *   2. NO FREE TIER — $5.00 per 1,000 requests, no free allowance found. Note what
 *      that does to the paragraph above: the stated reason for having a vendor map
 *      at all is that free tiers differ by an order of magnitude and that gap is
 *      "the difference between a two-minute self-serve step and a real adoption
 *      wall". Perplexity does not serve that goal. It is a fourth option for an
 *      operator already paying, not another on-ramp — which is a fine thing to add
 *      but should not be mistaken for progress on adoption.
 *
 *   Also unresolved: the docs do not publish a key prefix, and `resolveSearchVendor`
 *   infers the vendor from one. An unknown shape falls back to Brave, so a
 *   Perplexity key would be POSTed at Brave's endpoint. Adding it needs either a
 *   verified prefix or a documented `OPENWOP_WEBSEARCH_ENGINE=perplexity` opt-in.
 */

/** A normalized result row — the shape `WebResearchSurface.search` returns. */
export interface VendorResult {
  url: string;
  title: string;
  snippet?: string;
  rank?: number;
}

export interface SearchVendor {
  /** The `engine` tag stamped on results, and the id used in config/logs. */
  id: string;
  /** Human label for operator-facing copy. */
  label: string;
  /** Default endpoint; an operator may override via OPENWOP_WEBSEARCH_BASE_URL. */
  baseUrl: string;
  /** May results be STORED as durable citations? See `webSearchCapability.ts`. */
  suitability: 'durable' | 'answer-only';
  /** Where to get a key, for the not-configured message. */
  signupUrl: string;
  /** Rough free allowance, for operator copy. Informational only. */
  freeTier: string;
  /** Build the HTTP request for one query. */
  request(input: { baseUrl: string; key: string; query: string; maxResults: number }): {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
  };
  /** Normalize the vendor's JSON into result rows. Returns [] on an unexpected
   *  shape — the CALLER decides what an empty result means, never this module. */
  parse(body: unknown, maxResults: number): VendorResult[];
}

/** Snippet budget per result. Long enough to judge relevance, short enough that a
 *  page of results stays a context-friendly payload. Applied CLIENT-side so it
 *  holds for every vendor and depends on no vendor-specific parameter. */
const SNIPPET_MAX_CHARS = 500;

/** Cap a snippet to the shared budget, preserving `undefined` for "no snippet". */
function clip(v: string | undefined): string | undefined {
  return v === undefined ? undefined : v.slice(0, SNIPPET_MAX_CHARS);
}

/** Narrow an unknown JSON value to a record without casting through `any`. */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Map raw rows → normalized results, dropping anything without a usable URL.
 *  A row with no URL is not a citation, so it is discarded rather than
 *  back-filled with a placeholder. */
function normalize(
  rows: unknown[],
  pick: (r: Record<string, unknown>) => { url?: string; title?: string; snippet?: string },
  maxResults: number,
): VendorResult[] {
  const out: VendorResult[] = [];
  for (const raw of rows) {
    const { url, title, snippet } = pick(asRecord(raw));
    if (!url) continue;
    out.push({ url, title: title ?? url, ...(snippet ? { snippet } : {}), rank: out.length + 1 });
    if (out.length >= maxResults) break;
  }
  return out;
}

const BRAVE: SearchVendor = {
  id: 'brave',
  label: 'Brave Search',
  baseUrl: 'https://api.search.brave.com/res/v1/web/search',
  suitability: 'durable',
  signupUrl: 'https://brave.com/search/api/',
  freeTier: '~2,000 queries/month',
  request: ({ baseUrl, key, query, maxResults }) => ({
    url: `${baseUrl}?q=${encodeURIComponent(query)}&count=${maxResults}`,
    method: 'GET',
    headers: { accept: 'application/json', 'x-subscription-token': key },
  }),
  parse: (body, maxResults) =>
    normalize(asArray(asRecord(asRecord(body).web).results), (r) => ({
      url: str(r.url), title: str(r.title), snippet: str(r.description),
    }), maxResults),
};

const TAVILY: SearchVendor = {
  id: 'tavily',
  label: 'Tavily',
  baseUrl: 'https://api.tavily.com/search',
  suitability: 'durable',
  signupUrl: 'https://app.tavily.com/',
  freeTier: '~1,000 credits/month',
  request: ({ baseUrl, key, query, maxResults }) => ({
    url: baseUrl,
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: maxResults }),
  }),
  parse: (body, maxResults) =>
    normalize(asArray(asRecord(body).results), (r) => ({
      url: str(r.url), title: str(r.title), snippet: str(r.content),
    }), maxResults),
};

const EXA: SearchVendor = {
  id: 'exa',
  label: 'Exa',
  baseUrl: 'https://api.exa.ai/search',
  suitability: 'durable',
  signupUrl: 'https://dashboard.exa.ai/',
  // exa.ai/pricing, read 2026-09-17 (ADR 0706 §8 Phase E): $20 in credits for a new
  // account, then $10/month on the free tier, searches at $7 / 1,000. This used to say
  // "~20,000 requests/month", which the current pricing does not support.
  freeTier: '$20 starter credit (~2,800 searches), then $10/month',
  request: ({ baseUrl, key, query, maxResults }) => ({
    url: baseUrl,
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': key },
    // `highlights` is Exa's snippet field — an array of query-relevant passages,
    // returned ONLY when requested via `contents`. An earlier revision sent
    // `contents:{text:false}`, which suppressed the very field it then parsed, so
    // every Exa result came back snippet-less.
    //
    // Sent as plain `true` per Exa's coding-agent guide, NOT as a nested object:
    // the guide documents `maxCharacters` under `text` only and lists the old
    // per-highlight knobs (`numSentences`, `highlightsPerUrl`) as deprecated, so a
    // nested highlights object risks a 400. The snippet is capped client-side
    // instead — same budget, no dependence on a contested parameter.
    //
    // `type:'auto'` is the guide's recommended default (~1s, balanced relevance).
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: maxResults,
      contents: { highlights: true },
    }),
  }),
  parse: (body, maxResults) =>
    normalize(asArray(asRecord(body).results), (r) => ({
      url: str(r.url),
      title: str(r.title),
      // Prefer the first highlight; fall back to `text` for a caller that
      // configured full contents, then `summary`.
      snippet: clip(str(asArray(r.highlights)[0]) ?? str(r.text) ?? str(r.summary)),
    }), maxResults),
};

const VENDORS: readonly SearchVendor[] = [BRAVE, TAVILY, EXA];

/** Every supported vendor, for operator-facing copy and the keys page. */
export function listSearchVendors(): readonly SearchVendor[] {
  return VENDORS;
}

export function getSearchVendor(id: string): SearchVendor | undefined {
  return VENDORS.find((v) => v.id === id.trim().toLowerCase());
}

/**
 * Which vendor should a given key talk to?
 *
 * Explicit configuration wins (`OPENWOP_WEBSEARCH_ENGINE`), because an operator
 * pointing at a self-hosted or proxied endpoint must not be second-guessed by a
 * heuristic. Otherwise infer from the key's own prefix — vendors issue
 * distinguishable keys, and inferring means a user pastes a key and it works
 * rather than also having to know which env var names their vendor.
 *
 * Unknown ⇒ Brave, preserving the historical default exactly, so a deployment
 * that was working before this change keeps working with no config.
 */
export function resolveSearchVendor(key: string): SearchVendor {
  const configured = process.env.OPENWOP_WEBSEARCH_ENGINE?.trim().toLowerCase();
  if (configured) {
    const v = getSearchVendor(configured);
    // An unrecognized explicit setting falls through to inference rather than
    // failing the search: the operator may have set a custom label alongside a
    // custom base URL, which is a supported (Brave-shaped) configuration.
    if (v) return v;
  }
  // A configured BASE URL with no named engine is a pre-existing operator setup
  // (a proxy or a self-hosted Brave-shaped endpoint). Inferring a vendor from the
  // key would change the REQUEST SHAPE sent to that endpoint — e.g. a UUID-shaped
  // key would start POSTing Exa's body at it. Historical behaviour wins.
  if (process.env.OPENWOP_WEBSEARCH_BASE_URL?.trim()) return BRAVE;

  const k = key.trim();
  if (k.startsWith('tvly-')) return TAVILY;           // Tavily keys are `tvly-…`
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k)) return EXA; // Exa issues UUID-shaped keys
  if (k.startsWith('BSA')) return BRAVE;              // Brave keys are `BSA…`
  return BRAVE;
}
