/**
 * vendor.myndhyve.web-research — search → fetch → research pipeline.
 *
 * Three nodes on one host capability: host.webResearch (search, fetch and
 * research orchestration).
 *
 * typeId-preserve: matches in-tree names verbatim per migration plan §4
 *   data.source.webSearch
 *   data.transform.fetchUrls
 *   ai.research.web
 *
 * @see docs/plans/MYNDHYVE-TO-OPENWOP-PACK-MIGRATION.md
 */

function ensureWebResearch(ctx) {
  if (!ctx.webResearch || typeof ctx.webResearch.search !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.webResearch'),
      { code: 'host_capability_missing' }
    );
  }
}

/* ─── core.webResearch.webSearch ─────────────────────────── */

export async function webSearch(ctx) {
  ensureWebResearch(ctx);
  const { engine, maxResults = 10, language, region, safeSearch = 'moderate' } = ctx.config;
  const { query, siteFilter } = ctx.inputs;

  const result = await ctx.webResearch.search({
    query,
    maxResults,
    safeSearch,
    ...(engine !== undefined ? { engine } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(siteFilter !== undefined ? { siteFilter } : {}),
  });

  return {
    status: 'success',
    outputs: {
      results: Array.isArray(result?.results) ? result.results : [],
      engine: result?.engine ?? engine ?? 'default',
      query,
      ...(typeof result?.totalResults === 'number' ? { totalResults: result.totalResults } : {}),
    },
  };
}

/* ─── core.webResearch.fetchUrls ─────────────────────────── */

export async function fetchUrls(ctx) {
  ensureWebResearch(ctx);
  if (typeof ctx.webResearch.fetchBatch !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.webResearch.fetchBatch'), { code: 'host_capability_missing' });
  }
  const { concurrency, perRequestTimeoutMs, respectRobotsTxt, maxBodyBytes, extractReadable } = ctx.config;
  const { urls } = ctx.inputs;

  const result = await ctx.webResearch.fetchBatch({
    urls,
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(perRequestTimeoutMs !== undefined ? { perRequestTimeoutMs } : {}),
    ...(respectRobotsTxt !== undefined ? { respectRobotsTxt } : {}),
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    ...(extractReadable !== undefined ? { extractReadable } : {}),
  });

  const pages = Array.isArray(result?.pages) ? result.pages : [];
  const succeeded = pages.filter((p) => p?.status >= 200 && p?.status < 300).length;
  return {
    status: 'success',
    outputs: {
      pages,
      succeeded,
      failed: pages.length - succeeded,
    },
  };
}

/* ─── core.webResearch.researchWeb ───────────────────────── */

export async function researchWeb(ctx) {
  ensureWebResearch(ctx);
  if (typeof ctx.webResearch.research !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.webResearch.research'), { code: 'host_capability_missing' });
  }
  const { engine, maxResults = 5, language, region, perFetchTimeoutMs } = ctx.config;
  const { query, siteFilter } = ctx.inputs;

  const result = await ctx.webResearch.research({
    query,
    maxResults,
    ...(engine !== undefined ? { engine } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(region !== undefined ? { region } : {}),
    ...(perFetchTimeoutMs !== undefined ? { perFetchTimeoutMs } : {}),
    ...(siteFilter !== undefined ? { siteFilter } : {}),
  });

  return {
    status: 'success',
    outputs: {
      citations: Array.isArray(result?.citations) ? result.citations : [],
      query,
      ...(result?.engine ? { engine: result.engine } : {}),
      ...(typeof result?.totalResults === 'number' ? { totalResults: result.totalResults } : {}),
    },
  };
}

/* ─── core.webResearch.synthesize ────────────────────────── */

export const nodes = {
  'data.source.webSearch': webSearch,
  'data.transform.fetchUrls': fetchUrls,
  'ai.research.web': researchWeb,
};

export default nodes;
