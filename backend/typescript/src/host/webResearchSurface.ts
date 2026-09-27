/**
 * `ctx.webResearch` host surface (`host.webResearch`,
 * `spec/v1/host-capabilities.md` §host.webResearch) — the
 * `vendor.myndhyve.web-research` pack's search/fetch/research.
 *
 * `fetchBatch` is REAL: it concurrently HTTP-fetches the given URLs, extracts a
 * title + readable text, and truncates to a byte cap — no API key needed.
 *
 * `search` is provider-gated: when a search-provider API key is configured —
 * BYOK secret `web-search` for the tenant, or the host env
 * `OPENWOP_WEBSEARCH_API_KEY` — it queries a real provider (Brave-shaped JSON by
 * default; override the endpoint with `OPENWOP_WEBSEARCH_BASE_URL`). With no key
 * (or on a provider error) it falls back to an HONEST demo result: a real
 * search-engine query URL marked `engine: 'demo'`. `research` composes search →
 * fetchBatch, so it goes live automatically once a key is configured.
 *
 * ADR 0502 — that demo fallback is for `suitability: 'answer-only'` callers ONLY.
 * A caller storing these as citable evidence passes `suitability: 'durable'` and
 * gets a thrown `DurableSearchUnavailableError` instead, because a synthetic
 * source is worse than no source for anything that persists a claim.
 */

import { fetch as undiciFetch } from 'undici';
import { createLogger } from '../observability/logger.js';
import { resolveSecret } from '../byok/secretResolver.js';

/** The BYOK credential ref for the web-search key (ADR 0101 P3). Settable per
 *  TENANT or HOST-wide via the Secrets Vault on the Connections page. */
export const WEB_SEARCH_REF = 'web-search';
import { resolveNativeWebSearch } from './headlessAi.js';
import { resolveSearchVendor } from './searchVendors.js';
import {
  isDeniedWebhookHost,
  webhookPrivateEgressAllowed,
  webhookEgressDispatcher,
  WebhookEgressDeniedError,
} from './webhookEgressGuard.js';
import type { BundleScope } from './inMemorySurfaces.js';

const log = createLogger('host.webResearch');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY = 256 * 1024;

/**
 * SSRF-guarded fetch for web-research egress. The `urls`/search-result URLs
 * are RUN-CONTROLLABLE (a workflow node supplies them), so a bare `fetch`
 * here is an SSRF sink — a run could point the host at
 * `http://169.254.169.254/...` or a public URL that 30x-redirects there.
 * We route through the SAME pinned-resolution dispatcher the webhook layer
 * uses (RFC 0093 §A.1): it re-resolves at connect time and rejects ANY
 * resolved address in a denied range, on the initial request AND on every
 * redirect hop (same dispatcher), so there is no DNS-rebind / redirect TOCTOU.
 * A cheap hostname pre-check fails obvious internal targets fast with a clear
 * error before a socket is opened.
 */
type UndiciFetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

async function ssrfGuardedFetch(rawUrl: string, init: UndiciFetchInit) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`web-research: invalid URL: ${rawUrl.slice(0, 120)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web-research: refusing non-http(s) URL scheme '${parsed.protocol}'`);
  }
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(parsed.hostname)) {
    throw new WebhookEgressDeniedError(parsed.hostname, parsed.hostname);
  }
  // undici's RequestInit type includes `dispatcher` (the guarded Agent), so no
  // cast is needed — the helper + call sites use undici's own fetch types.
  return undiciFetch(rawUrl, { ...init, dispatcher: webhookEgressDispatcher() });
}

/** `url` is the FINAL location after redirects; `requestedUrl` is set only when
 *  they differ, so a caller can cite what it actually read while still showing
 *  what it asked for. */
interface Page { url: string; requestedUrl?: string; status: number; contentType?: string; title?: string; extractedText?: string; truncated?: boolean; fetchedAt?: string; error?: string }

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1]!.trim().slice(0, 300) : undefined;
}

/** Strip scripts/styles + tags → collapsed readable text. */
function extractReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface WebResearchSurface {
  search(args: { query: string; maxResults?: number; engine?: string; siteFilter?: string; suitability?: 'durable' | 'answer-only' }): Promise<{ results: Array<{ url: string; title: string; snippet?: string; rank?: number }>; engine: string; totalResults?: number }>;
  fetchBatch(args: { urls: string[]; concurrency?: number; perRequestTimeoutMs?: number; maxBodyBytes?: number; extractReadable?: boolean }): Promise<{ pages: Page[] }>;
  research(args: { query: string; maxResults?: number; perFetchTimeoutMs?: number; siteFilter?: string; suitability?: 'durable' | 'answer-only' }): Promise<{ citations: Array<{ url: string; title: string; snippet?: string; content: string; rank?: number; fetchedAt?: string }>; engine?: string; totalResults?: number }>;
}

/**
 * A caller that will STORE these results as citable evidence asked for
 * `suitability: 'durable'` and no such adapter is available.
 *
 * Why this is a THROW and not the honest demo marker (ADR 0502): `suitability`
 * used to gate only WHICH NATIVE PROVIDER qualified — both demo fallbacks below
 * fired regardless, so a durable caller was handed `engine: 'demo'` and a
 * synthetic `duckduckgo.com/?q=…` URL anyway. Verified live on 2026-07-29: the
 * Challenge Factory fetched that search-results page as if it were a source
 * (1 page, 0 failures) and paid a model call to extract claims from it before
 * `recordResearch`'s `engineIsDurable` guard finally refused, two nodes later.
 * The mechanism existed and was dormant on the exact pipeline it was built for.
 *
 * A durable consumer cannot degrade — "no evidence" and "synthetic evidence"
 * must not be the same value. Refusing here is what makes the demo marker safe
 * to keep for `answer-only` callers, which legitimately want it.
 */
export class DurableSearchUnavailableError extends Error {
  readonly code = 'research_adapter_unconfigured';
  constructor(readonly reason: 'no_adapter' | 'provider_failed') {
    super(
      // Names the FIX, not just the fault. This surfaces as a node failure on a
      // run someone is watching, so "misconfigured" without "here is where" just
      // relocates the dead end. Mirrors the Challenge Factory pre-flight copy.
      reason === 'provider_failed'
        ? 'The configured web-search provider failed, and these results would be stored as citable evidence. Refusing rather than substituting a demo result — retry once the provider recovers.'
        : 'This step stores what it finds as citable evidence, and no web-search provider is configured that it is allowed to cite from. '
          + 'A workspace admin can add a web-search key in Settings → Secrets Vault — Exa, Brave or Tavily all work.',
    );
    this.name = 'DurableSearchUnavailableError';
  }
}

type SearchResult = { results: Array<{ url: string; title: string; snippet?: string; rank?: number }>; engine: string; totalResults?: number };

/**
 * Is a HOST-LEVEL web-search key configured? Reports WHERE it resolves from, and
 * never returns or logs the key itself.
 *
 * Exists because search configuration was invisible until someone ran a workflow and
 * read `engine: 'demo'` off a run event — the exact problem `/readiness` already
 * solves for managed providers ("that used to be invisible until a user ran a
 * workflow… turns it into a deploy-time signal a smoke test can assert on",
 * `routes/health.ts`). An operator who sets the Vault key had no way to confirm it
 * landed; verified live 2026-08-02, a real run was the only check available.
 *
 * HOST scope only — deliberately no tenantId. A tenant's own BYOK key is that
 * tenant's business and must not be enumerable from an unauthenticated endpoint;
 * this answers "has the OPERATOR configured the deployment", which is what a deploy
 * smoke test needs.
 */
export async function hostWebSearchKeyStatus(): Promise<{
  configured: boolean;
  source: 'host-vault' | 'env' | null;
  /** Present only when the vault probe THREW — `configured:false` then means "unknown", not "no". */
  probeError?: string;
}> {
  let probeError: string | undefined;
  try {
    // Scopeless on purpose — the Vault's `host` scope. Requires
    // OPENWOP_BYOK_EPHEMERAL=false, under which a scopeless ref resolves normally;
    // under ephemeral mode it is null by design and the env lane below answers.
    if (await resolveSecret(WEB_SEARCH_REF)) return { configured: true, source: 'host-vault' };
  } catch (err) {
    // A resolver hiccup must not fail readiness — but it must not be reported as
    // "no key configured" either. A failed READ is not an absence: swallowing it
    // here would tell an operator who HAD set the key that they had not, which is
    // the exact false-negative this endpoint exists to eliminate. Carry the
    // uncertainty forward instead. (Message only — never the resolved value.)
    probeError = err instanceof Error ? err.message : String(err);
  }
  if (process.env.OPENWOP_WEBSEARCH_API_KEY) return { configured: true, source: 'env' };
  return { configured: false, source: null, ...(probeError ? { probeError } : {}) };
}

/** Resolve a search-provider key: BYOK secret `web-search` for the tenant first,
 *  then the host env key. Returns null when neither is configured. */
async function resolveSearchKey(tenantId: string): Promise<string | null> {
  // 1. The TENANT's own key — a workspace bringing its own quota overrides the
  //    host default. Scoped, so it can never be read by another tenant.
  try {
    const byok = await resolveSecret(WEB_SEARCH_REF, { tenantId });
    if (byok) return byok;
  } catch {
    // A lookup failure is non-fatal — fall through to the host key.
  }
  // 2. The HOST-GLOBAL key — what the Secrets Vault writes at `host` scope on the
  //    Connections page, and the lane an operator configuring one deployment-wide
  //    key actually uses.
  //
  //    Called SCOPELESS on purpose. `resolveSecret` deliberately does NOT fall back
  //    from a tenant scope to the host row (a generic fallback would leak host
  //    secrets to tenants — the vuln-scan M3 note in secretResolver.ts), so a
  //    host-scope secret is unreachable unless a call site asks for it EXPLICITLY.
  //    Without this the Vault's `host` scope silently did nothing for web search:
  //    an operator would set the key, see it listed, and every research run would
  //    still refuse. This mirrors `billing:stripe-key`, the established
  //    deliberately-host-global operator credential.
  //
  //    NOTE: like Stripe's, this requires `OPENWOP_BYOK_EPHEMERAL=false` — under
  //    ephemeral mode a scopeless ref resolves to null by design.
  try {
    const hostWide = await resolveSecret(WEB_SEARCH_REF);
    if (hostWide) return hostWide;
  } catch {
    // Non-fatal — fall through to the env key.
  }
  // 3. The host-operator ENV key — the pre-Vault lane, kept for existing deploys.
  return process.env.OPENWOP_WEBSEARCH_API_KEY ?? null;
}

/**
 * Is a LIVE search adapter configured for this tenant? Reads through the SAME
 * `resolveSearchKey` the search path uses, so a caller's pre-flight can never
 * disagree with what the surface will actually do (the "route and tool share one
 * predicate" rule).
 *
 * Exists because grounding-bound pipelines are fail-closed on demo sources: the
 * KickTodo Challenge Factory refuses a dossier built from `engine: 'demo'`
 * (`creatorService.StubSourceError`). Without a pre-flight, igniting one with no
 * key configured starts a run that is DOA by construction — it dies a node or
 * two in, and on 2026-07-25 an agent cheerfully narrated an approval gate that
 * could never arrive. Callers use this to refuse HONESTLY and up front.
 */
export async function liveWebSearchConfigured(
  tenantId: string,
  suitability: 'durable' | 'answer-only' = 'answer-only',
): Promise<boolean> {
  if ((await resolveSearchKey(tenantId)) !== null) return true;
  // ADR 0101 Phase 4 — a tenant with a capable native provider needs NO second
  // key, so the pre-flight must see that too or it would refuse a run that would
  // in fact have worked. It asks with the SAME suitability the search will use,
  // so the two can never disagree: a caller needing storable citations is told
  // "not configured" when the only native option is licensed for display only.
  // Guarded for the same reason `search()` guards it: resolving the native lane
  // touches durable storage and the BYOK resolver, either of which can throw. A
  // PRE-FLIGHT that throws is worse than one that says no — the caller's whole
  // job is to return a typed refusal, so an exception here would surface as an
  // unhandled tool error instead of the honest "not configured" message.
  // Fail CLOSED: if we cannot prove search is available, it is not.
  try {
    return (await resolveNativeWebSearch(tenantId, suitability)) !== null;
  } catch (err) {
    log.warn('native web search resolve failed during pre-flight', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Honest demo result — a real query URL, not fabricated content. */
function exampleSearch(query: string, maxResults: number): SearchResult {
  return {
    results: [{ url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`, title: `Web search: ${query}`, snippet: 'Demo result — configure a search provider (BYOK secret "web-search" or OPENWOP_WEBSEARCH_API_KEY) for live results.', rank: 1 }].slice(0, Math.max(1, maxResults)),
    engine: 'demo',
    totalResults: 1,
  };
}

/**
 * Live provider query, dispatched through the resolved vendor's descriptor
 * (`host/searchVendors.ts`). Throws on transport / non-2xx.
 *
 * The vendor is inferred from the key unless the operator names one, so a user
 * pastes whatever key they have (Brave, Tavily, Exa) and it works. An unknown key
 * shape falls back to Brave — the historical default — so an existing deployment
 * is unaffected by this change.
 */
async function searchLive(query: string, key: string, maxResults: number, siteFilter?: string): Promise<SearchResult> {
  const vendor = resolveSearchVendor(key);
  // The operator's base-URL override still wins (self-hosted / proxied endpoints).
  const baseUrl = process.env.OPENWOP_WEBSEARCH_BASE_URL ?? vendor.baseUrl;
  const q = siteFilter ? `${query} site:${siteFilter}` : query;
  const count = Math.max(1, Math.min(maxResults, 20));
  const req = vendor.request({ baseUrl, key, query: q, maxResults: count });
  const res = await ssrfGuardedFetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body ? { body: req.body } : {}),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  // §D endpoint non-disclosure (the imageProviderAdapter precedent): report the
  // status and the vendor, never the operator's configured URL.
  if (!res.ok) throw new Error(`search provider ${vendor.id} returned HTTP ${res.status}`);
  const results = vendor.parse(await res.json(), maxResults);
  return { results, engine: vendor.id, totalResults: results.length };
}

export function createWebResearchSurface(scope: BundleScope): WebResearchSurface {
  async function fetchOne(url: string, timeoutMs: number, maxBody: number, readable: boolean): Promise<Page> {
    const fetchedAt = new Date().toISOString();
    try {
      // redirect:'follow' is safe here: every hop re-resolves through the
      // guarded dispatcher, so a public→internal redirect is still denied.
      const res = await ssrfGuardedFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      const contentType = res.headers.get('content-type') ?? undefined;
      const raw = await res.text();
      const truncated = Buffer.byteLength(raw, 'utf8') > maxBody;
      const body = truncated ? raw.slice(0, maxBody) : raw;
      // Report the FINAL url after redirects (`res.url`), falling back to the
      // requested one. The fetch already follows redirects through the guarded
      // dispatcher, but the resolved location was being discarded — so a caller
      // that records a citation recorded the REDIRECTOR, not the page it read.
      const finalUrl = typeof res.url === 'string' && res.url ? res.url : url;
      const page: Page = { url: finalUrl, status: res.status, fetchedAt, ...(contentType ? { contentType } : {}), ...(truncated ? { truncated } : {}) };
      if (finalUrl !== url) page.requestedUrl = url;
      const title = extractTitle(body);
      if (title) page.title = title;
      if (readable) page.extractedText = extractReadableText(body).slice(0, maxBody);
      return page;
    } catch (err) {
      return { url, status: 0, fetchedAt, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const surface: WebResearchSurface = {
    // ADR 0101's resolution order, now honoured on the WORKFLOW leg too:
    // host key → NATIVE on the tenant's own LLM key → honest demo. The host key
    // stays first because it is the deliberate operator choice (search control,
    // caching, allow-lists) and costs no LLM tokens; native is the fallback that
    // means most BYOK tenants need no second key at all.
    //
    // `searchSuitability` is the LICENSING gate on the native leg: a caller that
    // will STORE these citations passes 'durable'. Default 'answer-only' keeps
    // ordinary lookups working on any capable provider while making a durable
    // consumer opt in explicitly. See `host/webSearchCapability.ts`.
    async search({ query, maxResults = 10, siteFilter, suitability = 'answer-only' }) {
      const key = await resolveSearchKey(scope.tenantId);
      if (key) {
        try {
          const live = await searchLive(query, key, maxResults, siteFilter);
          log.info('web search (live)', { query, engine: live.engine, results: live.results.length });
          return live;
        } catch (err) {
          // An operator who configured a host key did so deliberately — often for
          // egress control, allow-listing, or caching. A transient failure must
          // NOT silently reroute the request through a different egress path
          // (the tenant's LLM provider); that would defeat the reason the key
          // exists. Degrade to the honest demo marker instead, as before.
          //
          // ADR 0502 — EXCEPT for a durable caller, which is storing these as
          // citable evidence. A demo marker there is not a degraded answer, it
          // is a fabricated source that later nodes pay to process.
          if (suitability === 'durable') {
            log.warn('web search provider failed — refusing (durable caller)', { query, error: err instanceof Error ? err.message : String(err) });
            throw new DurableSearchUnavailableError('provider_failed');
          }
          log.warn('web search provider failed — falling back to demo result', { query, error: err instanceof Error ? err.message : String(err) });
          return exampleSearch(query, maxResults);
        }
      }
      // The whole native leg is best-effort: RESOLVING it touches durable storage
      // and the BYOK resolver, either of which can throw. A failure there must
      // degrade to the honest demo marker, never propagate — `search()` is also
      // the path an SSRF refusal falls through, and turning that refusal into an
      // unhandled throw would convert a contained denial into a broken node.
      let native: Awaited<ReturnType<typeof resolveNativeWebSearch>> = null;
      try {
        native = await resolveNativeWebSearch(scope.tenantId, suitability);
      } catch (err) {
        log.warn('native web search resolve failed', { error: err instanceof Error ? err.message : String(err) });
      }
      if (native) {
        try {
          const results = await native.search(query, maxResults);
          if (results.length > 0) {
            log.info('web search (native)', { query, engine: native.engine, results: results.length });
            return { results, engine: native.engine, totalResults: results.length };
          }
          // Zero citations is not an error, but it is also not evidence — fall
          // through so the caller gets the honest demo marker rather than an
          // empty list it might read as "nothing exists on this topic".
          log.warn('native web search returned no citations', { query, engine: native.engine });
        } catch (err) {
          log.warn('native web search failed', { query, error: err instanceof Error ? err.message : String(err) });
        }
      }
      // ADR 0502 — a durable caller gets a typed refusal, never the demo marker.
      // This is the branch that fired in production: no host key, no suitable
      // native provider, and the Factory took `engine: 'demo'` as evidence.
      if (suitability === 'durable') {
        log.info('web search refused (durable caller, no suitable adapter)', { query });
        throw new DurableSearchUnavailableError('no_adapter');
      }
      log.info('web search (demo — no search key and no suitable native provider)', { query, suitability });
      return exampleSearch(query, maxResults);
    },

    fetchBatch: ({ urls, concurrency = 4, perRequestTimeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY, extractReadable = true }) =>
      mapWithConcurrency(urls ?? [], concurrency, (u) => fetchOne(u, perRequestTimeoutMs, maxBodyBytes, extractReadable)).then((pages) => ({ pages })),

    // ADR 0502 — `suitability` is forwarded, not dropped. The composed op is the
    // one an evidence pipeline is most likely to reach for (search + fetch +
    // extract in a single call), so silently downgrading it to 'answer-only'
    // made the durable gate unreachable by exactly the caller that needed it.
    async research({ query, maxResults = 5, perFetchTimeoutMs = DEFAULT_TIMEOUT_MS, suitability = 'answer-only' }) {
      const { results, engine, totalResults } = await surface.search({ query, maxResults, suitability });
      const top = results.slice(0, maxResults);
      const { pages } = await surface.fetchBatch({ urls: top.map((r) => r.url), perRequestTimeoutMs: perFetchTimeoutMs, extractReadable: true });
      const citations = top.map((r, i) => {
        const p = pages[i];
        return {
          url: r.url,
          title: p?.title ?? r.title,
          ...(r.snippet ? { snippet: r.snippet } : {}),
          content: p?.extractedText ?? '',
          ...(r.rank !== undefined ? { rank: r.rank } : {}),
          ...(p?.fetchedAt ? { fetchedAt: p.fetchedAt } : {}),
        };
      });
      return { citations, ...(engine ? { engine } : {}), ...(totalResults !== undefined ? { totalResults } : {}) };
    },
  };
  return surface;
}
