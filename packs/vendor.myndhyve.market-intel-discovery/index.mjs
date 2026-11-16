/**
 * vendor.myndhyve.market-intel-discovery
 *
 * Single typeId: `market-intel.ai-discovery`
 *
 * Lifted from src/core/market-intel/prompts/discoveryPrompt.ts (~300 LOC TS)
 * + executor wrapper in src/canvas-types/campaign-studio/nodes/marketIntel/
 * aiDiscoveryExecutor.ts (~200 LOC).
 *
 * Use case: given a topic + optional industry/audience/platforms, AI-discovers
 * relevant communities, URLs, and search queries — replaces the manual URL
 * input step of the marketIntel research pipeline.
 *
 * One AI call, plus up to `searchLimit` (default 2) live searches through
 * ctx.webResearch when the host has one (ADR 1135). Pure-JS, Node-20 stdlib only.
 */

function makeLog(ctx) {
  const fn = typeof ctx?.log === 'function' ? ctx.log : null;
  return {
    debug: (msg, data) => { if (fn) fn('debug', msg, data); },
    info: (msg, data) => { if (fn) fn('info', msg, data); },
    warn: (msg, data) => { if (fn) fn('warn', msg, data); },
    error: (msg, data) => { if (fn) fn('error', msg, data); },
  };
}

function ensureCallAI(ctx) {
  if (typeof ctx.callAI !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.callAI — workflow-register should have refused this pack at peerDependency resolution time'),
      { code: 'host_capability_missing', capability: 'aiProviders' },
    );
  }
}

const VALID_PLATFORMS = ['reddit', 'hackernews', 'stackexchange', 'quora', 'twitter', 'other'];

const SYSTEM_PROMPT = `You are an expert market researcher. Your task is to identify the best online sources for understanding customer sentiment, pain points, and behaviors around a given topic.

You MUST output valid JSON matching this schema:
{
  "urls": ["string"],
  "communities": [
    {
      "platform": "reddit|hackernews|stackexchange|quora|twitter|other",
      "name": "string",
      "url": "string",
      "relevanceScore": 0.0-1.0,
      "estimatedPostCount": number,
      "description": "string"
    }
  ],
  "searchQueries": ["string"]
}

Guidelines:
- Focus on communities where real users discuss the topic (not marketing/press)
- Prioritize active communities with recent discussions
- Include a mix of high-traffic and niche communities
- Suggest specific search queries that would surface VoC-rich content
- For Reddit: suggest specific subreddits (e.g., r/SaaS, r/startups) as communities
- In "urls", put PUBLIC pages a server can read without logging in FIRST: forum threads, Hacker News items, StackExchange questions, review sites, blogs. Reddit, X/Twitter, Quora, Facebook, LinkedIn, Instagram and TikTok block automated reads, so list them last or leave them to "communities"
- For HackerNews: suggest search terms that work with HN search
- For StackExchange: suggest relevant sites and tags
- relevanceScore: 0.9+ = highly relevant, 0.7-0.9 = relevant, 0.5-0.7 = tangential`;

function buildUserPrompt(inputs) {
  const parts = [`Research Topic: ${inputs.topic}`];
  if (inputs.industry) parts.push(`Industry: ${inputs.industry}`);
  if (inputs.audience) parts.push(`Target Audience: ${inputs.audience}`);
  if (Array.isArray(inputs.platforms) && inputs.platforms.length > 0) {
    parts.push(`Focus Platforms: ${inputs.platforms.join(', ')}`);
  } else {
    parts.push('Focus Platforms: Any (suggest the best ones)');
  }

  const minUrls = inputs.minUrls ?? 10;
  const minCommunities = inputs.minCommunities ?? 5;
  const minQueries = inputs.minQueries ?? 5;

  parts.push(
    '',
    'Find the most relevant online communities and specific URLs where real users discuss this topic.',
    `Return at least ${minCommunities} communities and ${minUrls} specific URLs if possible.`,
    `Also suggest ${minQueries}+ search queries that would find high-quality VoC content.`,
  );

  return parts.join('\n');
}

function parseJSONFromAI(content) {
  const cleaned = String(content ?? '').replace(/```json?\s*/g, '').replace(/```/g, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function isValidUrl(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  // Accept full URLs OR reddit-style 'r/subreddit' identifiers (per source guidance).
  if (/^https?:\/\//.test(s)) return true;
  if (/^r\/[A-Za-z0-9_]+$/.test(s)) return true;
  return false;
}

function clampRelevance(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function validateCommunity(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.name !== 'string' || c.name.length === 0) return null;
  if (typeof c.url !== 'string' || c.url.length === 0) return null;
  const platform = VALID_PLATFORMS.includes(c.platform) ? c.platform : 'other';
  return {
    platform,
    name: c.name,
    url: c.url,
    relevanceScore: clampRelevance(c.relevanceScore),
    estimatedPostCount: Number.isFinite(Number(c.estimatedPostCount)) ? Number(c.estimatedPostCount) : null,
    description: typeof c.description === 'string' ? c.description : '',
  };
}

function validateOutput(raw) {
  if (!raw || typeof raw !== 'object') {
    return { urls: [], communities: [], searchQueries: [], warnings: ['Output was not an object'] };
  }
  const warnings = [];

  const urls = Array.isArray(raw.urls)
    ? raw.urls.filter((u) => {
        if (isValidUrl(u)) return true;
        warnings.push(`Dropped invalid URL: ${String(u).slice(0, 80)}`);
        return false;
      })
    : [];

  const communities = [];
  if (Array.isArray(raw.communities)) {
    for (let i = 0; i < raw.communities.length; i++) {
      const v = validateCommunity(raw.communities[i]);
      if (v) communities.push(v);
      else warnings.push(`Dropped invalid community at index ${i}`);
    }
  }
  // Sort communities by relevanceScore descending (stable)
  communities.sort((a, b) => b.relevanceScore - a.relevanceScore);

  const searchQueries = Array.isArray(raw.searchQueries)
    ? raw.searchQueries.filter((q) => typeof q === 'string' && q.length > 0)
    : [];

  return { urls, communities, searchQueries, warnings };
}

/* ─── ADR 1135 (CC-CHAIN-8): a fetch list a server can actually read ────────
 *
 * The digest chains fetch the first N discovered URLs. A model that returns only
 * reddit.com links (the prompt used to steer it there) fills every slot with a
 * host that answers server fetches with 403, so voc saw "5 fetched, 0 readable".
 * `fetchSources` is ordered for fetching: live-search URLs first (real pages,
 * not guesses), then the model's URLs, interleaved by host, with hosts that block
 * automated reads last and NAMED in a warning. `sources` is unchanged. */

/** Hosts that refuse server-side reads (login wall or anti-bot). Demoted, never dropped. */
export const WALLED_HOSTS = Object.freeze([
  'reddit.com', 'x.com', 'twitter.com', 'quora.com', 'facebook.com',
  'linkedin.com', 'instagram.com', 'tiktok.com',
]);

/** Search engines whose results are query URLs, not pages. */
const NON_PAGE_ENGINES = new Set(['demo', 'stub']);

const SEARCH_LIMIT_DEFAULT = 2;
const SEARCH_LIMIT_MAX = 3;
const SEARCH_RESULTS_PER_QUERY = 5;
const PER_HOST_PER_ROUND = 1;

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export function walledHostOf(url) {
  const h = hostOf(url);
  if (!h) return null;
  return WALLED_HOSTS.find((w) => h === w || h.endsWith(`.${w}`)) ?? null;
}

/** A chain param may arrive as a string (ADR 0507); anything unusable → default. */
function searchLimitOf(raw) {
  if (raw === undefined || raw === null || raw === '') return SEARCH_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.floor(n));
}

/**
 * Order candidate URLs for fetching. Keeps input order within a host and takes
 * one URL per host per round (round-robin), so one site cannot fill the first N
 * slots; walled hosts follow every open one.
 */
export function orderForFetch(candidates) {
  const seen = new Set();
  const open = new Map();
  const walled = [];
  for (const u of candidates) {
    if (typeof u !== 'string' || !/^https?:\/\//.test(u) || seen.has(u)) continue;
    const h = hostOf(u);
    if (!h) continue;
    seen.add(u);
    if (walledHostOf(u)) { walled.push(u); continue; }
    if (!open.has(h)) open.set(h, []);
    open.get(h).push(u);
  }
  const ordered = [];
  const queues = [...open.values()];
  while (queues.some((q) => q.length > 0)) {
    for (const q of queues) ordered.push(...q.splice(0, PER_HOST_PER_ROUND));
  }
  return { ordered: [...ordered, ...walled], openCount: ordered.length, walled };
}

async function searchForPages(ctx, queries, limit, warnings, log) {
  const urls = [];
  const wr = ctx.webResearch;
  if (limit === 0) return urls;
  if (!wr || typeof wr.search !== 'function') {
    if (queries.length > 0) warnings.push('Live search unavailable on this host (no webResearch); fetch order uses the model\'s URLs only');
    return urls;
  }
  for (const query of queries.slice(0, limit)) {
    try {
      const r = await wr.search({ query, maxResults: SEARCH_RESULTS_PER_QUERY, suitability: 'answer-only' });
      if (NON_PAGE_ENGINES.has(String(r?.engine ?? ''))) {
        warnings.push(`Search for "${query.slice(0, 60)}" returned ${r.engine} results (no live provider); ignored`);
        continue;
      }
      for (const item of Array.isArray(r?.results) ? r.results : []) {
        if (typeof item?.url === 'string') urls.push(item.url);
      }
    } catch (err) {
      log.warn('discovery search failed', { error: String(err?.message ?? err) });
      warnings.push(`Search for "${query.slice(0, 60)}" failed: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return urls;
}

export async function aiDiscovery(ctx) {
  ensureCallAI(ctx);
  const log = makeLog(ctx);
  const inputs = ctx.inputs ?? {};
  const config = ctx.config ?? {};

  const topic = String(inputs.topic ?? '').trim();
  if (topic.length === 0) {
    return {
      status: 'error',
      error: { code: 'INVALID_INPUTS', message: 'inputs.topic is required (non-empty string)', retryable: false },
    };
  }

  log.debug('Discovering sources', { topic, industry: inputs.industry, platforms: inputs.platforms });

    // XCH-MI-1 (Wave 4): hoisted so the bounded repair can replay the prompt.
  const promptMessages = [{ role: 'user', content: buildUserPrompt(inputs) }];
  let aiResult;
  try {
    aiResult = await ctx.callAI({
      provider: config.provider,
      model: config.model,
      systemPrompt: SYSTEM_PROMPT,
      messages: promptMessages,
      responseSchema: { type: 'object' },
      temperature: config.temperature ?? 0.3,
      maxTokens: config.maxTokens ?? 2048,
    });
  } catch (err) {
    log.error('AI source discovery failed', { error: String(err?.message ?? err) });
    return {
      status: 'error',
      error: { code: 'AI_DISCOVERY_FAILED', message: String(err?.message ?? err), retryable: true },
    };
  }

  let parsed = (aiResult && typeof aiResult.data === 'object' && aiResult.data !== null)
    ? aiResult.data
    : parseJSONFromAI(aiResult?.content);
  if (!parsed) {
    // XCH-MI-1 (LLM-EXCHANGE-AUDIT Wave 4): ONE bounded repair — replay the
    // prompt with the failed reply and a corrective instruction before the
    // Wave-2 typed failure. responseSchema engages provider-native JSON mode
    // where supported, making this path rare.
    log.warn('AI response could not be parsed as JSON — attempting one bounded repair');
    try {
      const retry = await ctx.callAI({
        provider: config.provider,
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          ...promptMessages,
          { role: 'assistant', content: String(aiResult?.content ?? '') },
          { role: 'user', content: 'Your previous reply was not parseable JSON. Return ONLY the JSON object the instructions describe — no prose, no code fences.' },
        ],
        temperature: 0,
        responseSchema: { type: 'object' },
      });
      parsed = (retry && typeof retry.data === 'object' && retry.data !== null) ? retry.data : parseJSONFromAI(retry?.content);
    } catch { /* fall through to the typed failure */ }
  }
  if (!parsed) {
    // XCH-MI-2 (Wave 2): an unparseable model reply is a FAILURE, not an
    // empty result.
    log.warn('AI response could not be parsed as JSON after repair — failing typed');
    return { status: 'error', error: { code: 'AI_OUTPUT_UNPARSEABLE', message: 'AI response could not be parsed as JSON (after one repair attempt)', retryable: true } };
  }

  const validated = validateOutput(parsed);

  const warnings = validated.warnings;
  const searchLimit = searchLimitOf(inputs.searchLimit ?? config.searchLimit);
  const searched = await searchForPages(ctx, validated.searchQueries, searchLimit, warnings, log);
  const { ordered: fetchSources, openCount, walled } = orderForFetch([...searched, ...validated.urls]);
  if (walled.length > 0) {
    const hosts = [...new Set(walled.map(walledHostOf))];
    warnings.push(`Moved ${walled.length} URL(s) on hosts that block automated reads to the end of fetchSources: ${hosts.join(', ')}`);
  }

  // Opt-in (the digest chains set it): with nothing a server can read, fail here,
  // typed and named, before the fetch and voc steps spend on pages that will 403.
  const requireFetchable = (inputs.requireFetchable ?? config.requireFetchable) === true
    || (inputs.requireFetchable ?? config.requireFetchable) === 'true';
  if (requireFetchable && openCount === 0) {
    const hosts = [...new Set(walled.map(walledHostOf))];
    return {
      status: 'error',
      error: {
        code: 'NO_FETCHABLE_SOURCES',
        message: hosts.length > 0
          ? `Discovery found no page a server can read: every URL is on a host that blocks automated reads (${hosts.join(', ')}), and live search added none.`
          : 'Discovery found no fetchable http(s) URL, and live search added none.',
        retryable: true,
      },
    };
  }

  log.info('AI source discovery completed', {
    urlCount: validated.urls.length,
    searchUrlCount: searched.length,
    fetchSourceCount: fetchSources.length,
    walledCount: walled.length,
    communityCount: validated.communities.length,
    queryCount: validated.searchQueries.length,
    warnings: warnings.length,
  });

  return {
    status: 'success',
    outputs: {
      sources: validated.urls,
      fetchSources,
      communities: validated.communities,
      searchQueries: validated.searchQueries,
      warnings,
      model: aiResult?.model,
      usage: aiResult?.usage,
      success: true,
    },
  };
}

export const nodes = {
  'market-intel.ai-discovery': aiDiscovery,
};

export default nodes;
