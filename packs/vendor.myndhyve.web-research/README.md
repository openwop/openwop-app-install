# `vendor.myndhyve.web-research`

MyndHyve web-research pack. Search → fetch → research pipeline.

| Pack | `vendor.myndhyve.web-research` |
| peerDependencies | `host.webResearch: supported` |
| License | Apache-2.0 |

## Nodes (typeId-preserve)

| typeId | role | what it does |
|---|---|---|
| `core.webResearch.webSearch` | side-effect | Search via host's adapter (Google CSE / Bing / Brave / Perplexity / Kagi); returns top N results |
| `core.webResearch.fetchUrls` | side-effect | Bulk URL fetch with research-specific policy (robots.txt, body caps, readability extraction). Distinct from `core.openwop.http.fetch` (single raw request). |
| `core.webResearch.researchWeb` | side-effect | End-to-end: query → search → fetch top N → extract → citations |

All three side-effectful + cacheable. Engine Layer-2 cache covers replay cost-once.

## Host contract

```typescript
ctx.webResearch.search({ query, maxResults, engine?, language?, region?, safeSearch?, siteFilter? })
  → Promise<{ results: Array<{ url, title, snippet?, rank? }>, engine, totalResults? }>

ctx.webResearch.fetchBatch({ urls, concurrency?, perRequestTimeoutMs?, respectRobotsTxt?, maxBodyBytes?, extractReadable? })
  → Promise<{ pages: Array<{ url, status, contentType?, title?, extractedText?, rawBody?, truncated?, fetchedAt?, error? }> }>

ctx.webResearch.research({ query, maxResults, ...filters })
  → Promise<{ citations: Array<{ url, title, snippet?, content, rank?, fetchedAt? }>, engine?, totalResults? }>

```

## See also

- [`docs/plans/MYNDHYVE-TO-OPENWOP-PACK-MIGRATION.md`](https://github.com/openwop/openwop) (in myndhyve)
