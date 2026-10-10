# ADR 0791 — The Workflow Architect reads the node catalog by search, not whole

Status: implemented (2026-09-30)

Relates to: ADR 0773 (Builder Pair Canvas, G-10b), ADR 0596 (workflow-author
honesty), ADR 0604 (schema-carrying tool outputs), the managed provider tier.

## Context

The Architect's catalog tool, `openwop:feature.workflow-author.nodes.draft`,
returned the WHOLE closed-world node catalog on every call. It is
schema-carrying, so compaction never shortens it (by design: a truncated schema
makes the model author against a catalog that is not this host's).

MEASURED 2026-09-30 on this host:

| | node types | tokens (bytes ÷ 4) |
|---|---:|---:|
| whole catalog, with schemas (what the tool returned) | 784 | ~232,000 |
| an index of id + label + category only | 784 | ~20,300 |
| index + a 120-char description | 784 | ~42,300 |

The G-10b live eval (ADR 0773) ran the Architect on the managed tier
(`openwop-free`, MiniMax-M3). Round 2 of a turn sent **221,620 prompt
tokens**: the first `draft` call. Consequences:

- **Free tier:** the managed daily cap is 50,000 tokens per workspace, and one
  catalog read is more than four times that. Pair — and any Architect authoring —
  gets about one turn per workspace per day, and the eval hit
  "Daily limit reached" mid-case.
- **Paid tiers:** ~$0.60 of input per catalog read on a Sonnet-class model,
  and the payload stays in context for every following round.
- **Quality:** the model had to find the right node in a 232k-token list.

An index-only listing does not fix it: 20k tokens is still 40% of the daily cap
per read.

## Decision

`draft` answers a QUESTION instead of dumping the catalog.

- `query` (a few words: what the step should do) returns the best-matching node
  types, **each with its full schemas**. The per-node closed-world contract is
  unchanged: nothing about a returned node is elided. Default 10, max 25.
- `typeIds` fetches exact types; ones this workspace's catalog does not list
  come back in `unknownTypeIds`.
- With neither, and on a search with no matches, it returns the category counts
  (~40 tokens) so the model can choose words, never a guessed id.
- `excluded` (the withheld nodes, with reasons; ~500 tokens) is returned every
  time, as before.

Ranking is a deterministic lexical score over typeId words, label, category and
description. It drops stopwords, and for words of 6+ letters a 5-letter stem
match counts at low weight ("deduplicate" finds "Deduplicates"). Measured on the
real catalog, the right node ranks first for "branch on a value", "send email",
"create CRM contact", "manual trigger", "form submitted", "approval",
"http request" and "wait delay". A search result is ~1.5–3.6k tokens; the
empty read is ~40.

**The closed-world guard does not depend on the model having seen every type.**
`validate` and `persist` still refuse any typeId the host cannot run
(`findUnknownTypeIds`), so a model that guesses gets a typed refusal it can
repair from, exactly as before.

The builder palette is unaffected: it uses the `/workflow-author/catalog` route,
which still returns the whole menu.

## Alternatives weighed

- **Index-only default** (id + label + category): ~20k tokens per read, still
  40% of the free tier's daily cap, and every step still needs a second read
  for its schemas. Rejected.
- **Compaction of the catalog result:** rejected by ADR 0604's reasoning. An
  elided enum or `required` list makes the model author against the wrong
  contract, and nothing in the result tells it so.
- **Raise the managed cap:** it treats the symptom. The paid-tier cost and the
  needle-in-a-haystack quality problem remain.
- **Embedding search:** better recall for synonyms, but it adds an embedding
  call per query and non-determinism across providers. The lexical ranker is
  deterministic, free, and good on the measured queries. It can be revisited if
  eval transcripts show the model failing to find nodes.

## Consequences

- The prompt tells the Architect to search once per KIND of step it needs, and
  to search again with other words when one is missing. Agent pack
  1.3.2 → 1.3.3; steward manifest regenerated.
- A multi-step authoring turn makes a few small reads instead of one huge one.
  Net tokens drop by roughly two orders of magnitude.
- The tool's output shape gains `matched`, `total`, and optional
  `unknownTypeIds` / `categories`. `nodes` and `excluded` keep their meaning.
  Host-extension tool, no wire impact, no RFC.

## Implementation record

| Piece | Where | Witness |
|---|---|---|
| Pure search | `features/workflow-author/catalogSearch.ts` | `__tests__/catalogSearch.test.ts` (ranking, stopwords, stem, id-first, limit cap, dedupe, determinism) |
| Tool contract | `features/workflow-author/agentTools.ts` (`draft`) | `test/workflow-author-agent-tools.test.ts` CFP-1: empty read, query, typeIds + unknown, and a **size guard** (< 200 KB for a broad query at an over-max limit). Restoring the whole-catalog return reddens all four. |
| Prompt | `packs/vendor.openwop-app.workflow-author.agents/prompts/workflow-architect.md` | `promptCatalogParity`, `agent-prompt-tool-ids` green |

## Open questions

- [ ] Re-run the G-10b eval once the machine is quiet, to measure tokens per turn
      and pass rate with scoped reads (expected: no daily-cap hits).
- [ ] If eval transcripts show missed nodes, consider a synonym table before
      reaching for embeddings.

> **Correction 2026-10-01.** The search default was 10 matches. Each match carries its full schemas (about 470 tokens), and a tool result is re-sent on every later round of the turn: a first draft made four searches in one round and added 18.8k prompt tokens. The default is now **5**; `limit` still accepts up to 25. Measured effect on a first draft: 73,420 → 57,144 prompt tokens over four rounds.

> **Correction 2026-10-03 (ADR 0773 plan B.2).** "`excluded` … is returned every time, as before" was a cost this ADR kept on purpose and should not have. The full withheld list (~500 tokens) rode every `draft` call, and every tool result is re-sent on each later round, so a turn with four searches paid for it many times over. `draft` now returns `excludedTotal` always, and in `excluded` only the withheld nodes the ask names (a requested `typeId`) or whose `typeId` words match the query. It returns ALL of them on an empty read and on a search with no matches, which are the moments "is the node I want withheld here?" is actually being asked. This filters which entries return, as the search already does for nodes; it never shortens an entry. Witness: `selectExcluded` in `__tests__/catalogSearch.test.ts` (returning the full list on every call reddens four of its five cases).

> **Correction 2026-10-04 (ADR 0773 G-10b) — the search needed a STOPPING POINT.** "Search again with other words when a step is missing" (prompt and tool description) had no bound and no fallback, and the catalog has no node made for some ordinary steps (no lead-dedupe node, no lead-scoring node; a lexical "score" search returns job-search, talent, idea and market scorers, which the model rightly rejects). MEASURED: MiniMax-M3 and Gemini 3.8 Flash both failed eval cases 2 and 4 by searching again and again (up to nine searches) and never drawing. A search now reports `noDedicatedMatch: true` when no returned node carries the ask in its own name (label or typeId words: two query words, or the word of a one-word query), and adds `generalBlocks` (`GENERAL_BLOCKS` in `catalogSearch.ts`: AI classify, AI transform, structured output, chat completion, If; filtered to the workspace's catalog; pointers only, the schema is fetched with `typeIds`) and a `hint`. The prompt now says at most two searches per kind of step, build from a general block on `noDedicatedMatch`, and never end a turn to search more (agent pack 1.3.6). Witnesses: `__tests__/catalogSearch.test.ts` "noDedicatedMatch" (disabling the hint reddens two cases; a one-shared-word rule reddens the near-miss case) and a pin that every `GENERAL_BLOCKS` id is a node in a vendored pack.

> **Correction 2026-10-04 (B.6).** `generalBlocks` are now FULL catalog entries (schemas included) plus their `use`, not pointers. The pointer form told the model to "fetch the schema with `typeIds`", and in 2 of 3 measured first drafts it called the separate `schema.lookup` tool instead, failed, and lost the turn. Cost: about 470 tokens per block on a search that has no dedicated match, against a whole extra round saved.
