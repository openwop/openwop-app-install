# ADR 0685 — The engine's internal shape is the model-facing contract

Status: **implemented** (verified 2026-09-17, #3828)
Date: 2026-09-14
Feature loop 2026-09, iteration 32 (Conversation search, `FEATURES.md` ordinal 32)
Gap ids: `CSWF-2` (closed, upgraded to its generator); `CSWF-1` re-verified STALE

## Context — this feature is in good shape, and the iteration says so

The prior pass graded it **B+**, doctrine PASS, **0 Blockers**. Independent verification at this
commit agrees, and three of the checks that found defects elsewhere in this loop come back
**clean** here. They are recorded as negatives so the next pass does not re-spend them:

- **Erasure is correctly N/A, not missing.** The feature registers no `registerSubjectEraser`,
  which initially reads like the `H1` KB-leak shape. It is not: the `chat-search` index is
  `_searchState = new TenantMap<Map<string, SearchDoc>>()` (`host/inMemorySurfaces.ts:1254`) —
  **in-memory, dying with the process** — and `searchEngine.ts:74` says so ("ephemeral,
  rebuildable caches… can never disagree with the durable rows"). There is nothing durable to
  erase, so the absence is right. *What resolved this was tracing `db.search` to its backing
  store rather than assuming "index" implies "durable".*
- **Tenant scoping is present** (`metaByTenant`, `${tenant}${SEP}${conv}` keys), and a query can
  only return hits from `visibleConversationIds` resolved **before** the query
  (`searchEngine.ts:39-44`), so a stale doc is unreachable as well as non-durable.
- **Doctrine is N/A by construction** — read-only, no workflow, nothing stamped on runs.
- **`CSWF-1` is STALE.** It says the agent lane serves models content the human deleted. The
  `CSC-1` watermark landed (`searchEngine.ts:80`, labelled `(CSC-1)`) with a `TOMBSTONE_CONTENT`
  sentinel (`:83`) and a dedicated **born-red** test —
  `test/conversation-search-freshness.test.ts:86`, *"a tombstone DELETE removes the deleted
  content from the index (privacy)"*. Fourth carried row this session found already fixed.

## D1 (`CSWF-2`, upgraded from the instance to its generator) — the tool has no projection

`features/conversation-search/agentTools.ts` returns the engine's hits verbatim:
```ts
return { content: JSON.stringify({ hits }) };
```
There is **no allowlist**. So `SearchHit`'s shape *is* the model-facing contract, and any field
added to the engine for internal or UI reasons reaches a model automatically, with no decision
and no schema text explaining it.

**The filed instance is real:** `matchedAt` is declared (`searchEngine.ts:69`), populated
(`:284`), typed on the FE client (`client/chatSessionsClient.ts:146`) — and **read by nothing**.
Three occurrences repo-wide, all declaration or population, **zero consumers**. It ships to every
model that calls the tool as an undocumented timestamp.

**And its own comment is wrong about what it is for.** `:68` says *"for 'jump to'"* — but a
`createdAt` timestamp is not an anchor; the hit already carries `messageId`, which is. So the
field is not merely unused, it could not serve the purpose it documents.

**Decision:** project explicitly in the tool with a documented allowlist
(`conversationId`, `title`, `type`, `messageId`, `snippet`, `score`, `role`), dropping
`matchedAt` from the model-facing result — the second of the two options the row offers ("give
agents a documented use **or** drop it from the tool projection"). The engine keeps the field for
the FE client that types it.

**This is the generator fix, not the instance fix.** Removing `matchedAt` alone would leave the
next internal field to reach a model silently. The allowlist makes widening the model-facing
surface a deliberate edit — the ADR 0678/0679 lesson that a cure belongs where the defect is
produced.

**Witness:** a leg asserting the tool's serialized hit keys equal the allowlist exactly, so
adding a field to `SearchHit` fails the test rather than silently widening what a model reads.
Sabotage: add a field to the projection and the leg must go red.

## RFC verdict

**Host work, no RFC.** This narrows a host-internal tool projection; no wire facet, no envelope
kind, no pack change — so no re-attestation and no registry republish.

## Open question

`score` is kept in the allowlist. It is an internal relevance number and the ordering already
conveys rank, so it is arguably noise in a model's context — but it is at least *documented* and
plausibly a confidence signal, which `matchedAt` is not. Stated rather than silently decided.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3828**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** `features/conversation-search/agentTools.ts:60-71` projects an explicit allowlist; `matchedAt` absent; rationale at `:49-58`.

**Witness caveat:** 3 of the 4 legs in the cited test are source-text assertions over `agentTools.ts`, so they pin the current spelling; leg 1 is the behavioural one.
