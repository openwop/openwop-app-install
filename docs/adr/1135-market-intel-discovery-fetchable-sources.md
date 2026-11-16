# ADR 1135 — Market-intel discovery returns pages a server can read (CC-CHAIN-8)

Status: Accepted, implemented on branch fix/cc-chain-8-discovery-fetchable (PR #5984, 2026-11-15; the user chose "both A and B"; the registry publish and prod pin follow the merge)

## Context

Prod bff8b2dfd5, market-intel 1.3.0 (ADR 1116). Runs 9e0f809c and 4d6fa675 fail typed at
voc with `invalid_inputs "5 fetched, 0 readable"`. #5900's wiring holds. What fails:
- `market-intel.ai-discovery`'s prompt says "For Reddit: suggest specific subreddits", and it
  has no fetchability rule. The model returns only reddit.com URLs.
- The chain wires `discover.sources → fetch.urls`, and fetch takes the first 5 in order.
- www.reddit.com answers the server fetch with 403. URLs the model invents can also 404.

## Decision (the user chose "both A and B", 2026-11-15)

Both changes land in the discovery node (`vendor.myndhyve.market-intel-discovery` 1.0.2 →
1.1.0, node `market-intel.ai-discovery@1.1.0`), so the graph stays the same shape:

- **B. Real URLs from search.** If `ctx.webResearch` is present, discovery runs up to
  `searchLimit` of its own `searchQueries`: default 2, cap 3, `maxResults` 5,
  `suitability: 'answer-only'`. It collects the result URLs. Results whose `engine` is
  `demo` or `stub` are dropped (they are query URLs, not pages) and a warning says so.
  A search failure is a warning, never fatal. Spend: ≤ searchLimit platform `webSearch`
  units per run. Prod has a host-vault key (readiness `checks.webSearch.source: host-vault`).
- **A. Fetch ordering.** A new output, `fetchSources`, merges the search URLs (first) and
  the model's `urls`. It drops `r/<sub>` identifiers (they stay in `communities`), dedupes,
  and interleaves by host, one URL per host per round. Known login-walled or
  anti-bot hosts go last: reddit.com, x.com, twitter.com, quora.com, facebook.com,
  linkedin.com, instagram.com, tiktok.com. That list is in the pack as a named constant,
  and a warning names each demoted host. The prompt asks for public, server-readable
  discussion pages first (forums, HN items, StackExchange questions, review sites, blogs).
  `sources` is unchanged, for compatibility.
- **Honesty.** If `fetchSources` has no URL from a non-walled host, discovery fails typed
  (`invalid_output`, names the walled hosts) at discover, before any fetch or voc AI call.
  That beats spending 5 fetches to fail at voc.
- **Chain** (pack 1.3.0 → 1.3.1, both chains 1.2.0 → 1.2.1): the edge becomes
  `discover.fetchSources → fetch.urls`; discover pin @1.1.0; fetch `maxPages` 5 → 8, so voc
  can still find `maxPages` (3) readable pages. Cost ceiling: ≤ 8 fetches + ≤ 2 searches;
  voc AI calls stay ≤ maxPages.

Rejected: C, a Reddit API path. It needs an OAuth app or account, which is the user's
decision, plus a ToS review.

## Replay

Search and fetch outputs are run-cached node outputs, the same class as core.web.search
and core.web.fetch. Discovery's output now includes search results, so a replay reads
the cached output and never re-searches.

## Tests (red on 1.0.2 / 1.3.0)

- A Reddit-only model reply with search present: fetchSources leads with the search URLs
  and the reddit ones are last, with the walled-host warning in the output (76's note).
- A Reddit-only reply with search absent or demo: a typed failure at discover that names
  reddit.com. The chain stops at discover; voc is never called.
- Host interleave: 6 URLs from one host plus 2 others → the first 3 span 3 hosts.
- Search spend: searchLimit 2 → exactly 2 search calls; a search throw → a warning, not a failure.
- Chain e2e (stub webResearch: reddit 403, other hosts readable) reaches synthesize.
- Sabotage: revert the edge to discover.sources → red; drop the interleave → red.

## Shipping (decisions that are not mine)

1. One PR: discovery 1.1.0, chain 1.3.1, tests, this ADR, steward-manifest digests.
2. Registry publish of market-intel 1.3.1 (and discovery 1.1.0?) plus a prod pin bump.
   That is the user's call. Batch it with 81's CC-SEO-3 core.openwop.ai pin if the two are
   ready close together (76): one update-env, one deploy.
3. 81 retests on prod with the same two topics.

## Implementation record (2026-11-15, f2)

| Part | Commit | Evidence |
|---|---|---|
| Discovery 1.1.0 (live search, `fetchSources`, `NO_FETCHABLE_SOURCES`), chain pack 1.3.1, tests | e869f21e40 | `workflow-chain-market-intel-digest-execution.test.ts` (5 CHAIN-8 cases); targeted 6 files 70/70; 13 market-intel files 248/248 |
| Steward-manifest digest (discovery only) | b327a2decb | ADR 0555 P0 attestation |
| This record | (this commit) | `test/steward/adr-status-not-stale.test.ts` |

Changes from the decision text, found while building:

- **One URL per host per round, not two.** Two per round put two pages from one
  forum ahead of every other host, and reordered the existing 4-URL fixture for no
  benefit. A strict round-robin keeps input order when hosts are already distinct.
- **The typed failure is opt-in (`requireFetchable`).** Discovery also runs outside
  these chains, where the communities alone are the product, so a Reddit-only reply
  must stay a success there. Both digest chains set `requireFetchable: true`.
- **No `webResearch` peerDependency.** Search is optional (the node works without it,
  with a warning), so declaring the capability would wrongly refuse the pack on a
  host that has no search.

Sabotage, both RED: the edge reverted to `discover.sources` (1 failed); the
walled-host demotion disabled (3 failed).

Still to do after the merge (not this PR): the registry publish of market-intel
1.3.1, the prod pin 1.3.0 → 1.3.1 (user-approved in f2's session), the deploy, and
81's prod retest with the two CC-CHAIN-8 topics.
