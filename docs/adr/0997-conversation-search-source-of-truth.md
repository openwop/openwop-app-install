# ADR 0997 — Conversation search queries the message store, not a derived index

Status: implemented (merged #5349 `88bb552fb`, live on rev `01071-2hh` 2026-10-28; see § Implementation record)

**Date:** 2026-10-28 · **Feature:** `conversation-search` (feature loop round 2, row 63)
**Amends:** ADR 0112 (conversation full-text search), whose Phase 1 "ADR CORRECTION"
moved the index onto the host `db.search` surface. **Related:** ADR 0043 (conversation
visibility), ADR 0195 (message tombstones), ADR 0685 (the tool's explicit projection),
ADR 0992 (chat export, `CX2CD-R1`).
**RFC verdict:** host work only. `/v1/host/openwop-app/chat/search` is a non-normative
host-extension route; the `truncated` field added below is host-extension shape. The
agent tool is a chat-time tool (ADR 0308 seam), not an envelope kind. Nothing reaches
the OpenWOP wire.

## Context

ADR 0112 Phase 1 built a **derived lexical index**: on each query the engine lazily
copied the text of every message in every conversation the caller can see into the
tenant's `db.search` host surface (index `chat-search`). It then queried that index,
filtered the hits to the caller's conversations, and ranked them. It kept the ids it
had written, plus a freshness watermark, in process memory.

The round-2 baseline measured four defects in that design. All four probes in
`test/conversation-search-privacy.test.ts` are red on `82233a042`:

| Probe | Defect | Why the design produces it |
|---|---|---|
| CSP-1 | A deleted message's text comes back as a snippet after a restart. | Prod runs `OPENWOP_SURFACE_BACKEND=durable`, so `db.search` is a DURABLE store (`host/durable/durableData.ts:105`, rows `hostsurf:search:<tenant>:chat-search:<conv>%00<msg>` in `host_ext_kv`). The ids to clean up lived in process memory (`searchEngine.ts:84-87`). A new process, or a second instance (prod `maxScale` 3), never knows a stale doc exists, so it never deletes it. The snippet is read from the doc. CSC-1's fix (2026-08-30) holds only within one process. |
| CSP-2 | The same for a DSAR erasure (`redactChatMessagesByAuthor`). | The same. Nothing in the erasure path knows about `hostsurf:search:*`. |
| CSP-3 | Any workflow run in the tenant can read other members' private message text. | `db.search` is the GENERIC surface every run gets (`executor/executor.ts:754` builds the same bundle). `core.db.search-query` (pack `core.openwop.db`, mounted by default) passes its config straight to `ctx.db.search.query`, so `index: "chat-search"` returns the docs, text included. `search-index` and `search-delete` can also plant or erase entries other members' searches would then show. |
| CSP-4 (= CSC-2) | Another member's matches crowd the caller's own result out. | The query takes the tenant-wide top `limit × 8` (`searchEngine.ts:264`), then filters to the caller's conversations. |
| CSP-5 | Thoughts, run state and interrupt resume tokens are searchable, and come back as the snippet (and to a model through the tool). | Found by the pre-code architect pass. The engine reads rows through its own `extractText`, a second projection beside ADR 0992 D1's `messageView`. The SPA stores the whole `ChatMessage` (`encodeMessageForStore`). When `content` is empty (a run card, a tool-only turn), `extractText` falls back to the RAW envelope string (`searchEngine.ts:101`). |

It also cost more than it should. Each query made a serial `getChatSession` for every
visible conversation (`searchEngine.ts:255`). The durable query lists and re-tokenises
every doc in the tenant (`durableData.ts:118`). An in-memory map held the text of every
message ever indexed, with no eviction (CSC-4). Docs of deleted conversations stayed
forever (CSC-3).

**Prod exposure, measured read-only on 2026-10-28:** 0 rows match
`hostsurf:search:%:chat-search:%`. The floor is 3,831 `hostsurf:%` rows found by the
same `LIKE`, and 0 workflows reference `core.db.search`. So CSP-3 is latent in prod
today: nobody's search has written a durable doc yet, and no workflow reads one. It
does not need its own hotfix, but any white-label deployment on a durable surface
backend may hold such rows. Only 56 chat sessions exist in prod in total.

The root cause is one decision: **a second copy of private text in a store with
different access rules and a different lifecycle from the original.** Every defect
above is a way the copy disagrees with the source. ADR 0112's correction chose
`db.search` to avoid a parallel substrate. That substrate is shared with workflow runs
and has no notion of conversation visibility, deletion or erasure.

## Decision

### D1 — No derived index. Search queries the message store at request time.

The engine stops writing anywhere. It reads the durable chat rows, which deletion
(ADR 0195 tombstone), DSAR erasure (`redactChatMessagesByAuthor`) and conversation
delete (FK cascade) already keep correct. This deletes `ensureConversationIndexed`, the
watermark, the three process-local maps, `__resetSearchEngine`, and every
`buildHostSurfaceBundle` call in the feature. CSP-1/2/3 and CSC-3/4 close because
there is no copy left to be stale, readable by runs, or orphaned.

**Rows are read through `messageView` (ADR 0992 D1,
`features/chat-export/transcriptRenderer.ts:93`), THE projection every other exit
uses.** Only `view.text` is searchable and shown. A row whose view is `deleted` or
a `card` (server-written structured JSON) is not searchable. `extractText` and
`flattenText` are deleted. Both features are in `distributions/bundles.json`
`core[]`, so the import defeats no distribution (`sharing` already imports the same
module).

A new `Storage` method does the filtering in the database:

```ts
/** ADR 0997 — candidate messages for conversation search. Rows in `sessionIds`
 *  whose stored content contains EVERY needle (case-insensitive substring), excluding
 *  ADR 0195 tombstones, newest first, at most `limit`. A prefilter only: the caller
 *  re-checks each row against its extracted text. */
searchChatMessages(
  sessionIds: readonly string[],
  needles: readonly string[],
  opts: { limit: number },
): Promise<readonly ChatMessageRecord[]>;
```

- **Postgres:** `session_id = ANY($1::text[]) AND content <> '{"deleted":true}' AND
  content ILIKE ALL($2::text[]) ORDER BY created_at DESC, message_id DESC LIMIT $3`.
  Each needle is `%` + the LIKE-escaped token + `%`. It uses the existing
  `idx_chat_messages_session` and needs no new index at today's volume (see
  Consequences).
- **SQLite:** `session_id IN (SELECT value FROM json_each(?))` and one
  `content LIKE ? ESCAPE '\'` per needle. SQLite `LIKE` folds ASCII case only, which
  is a documented dev-backend limit.
- The memory backend is SQLite (`memory://`), so there is no third implementation.

The database matches the RAW stored content, which is a JSON `ChatMessage` envelope.
A needle can therefore match a JSON key (`content`, `role`, `text`), so the engine
re-checks every candidate against `messageView(row).text`. It drops non-matches, so a
false positive costs a candidate slot and never produces a wrong hit. This re-check is
the ONLY thing between envelope internals (a thought, a resume token) and the
output. The database prefilter matches them by design, so CSP-5 pins the re-check.

### D2 — Visibility: unchanged, and stated once

`searchVisibleConversations` stays the ONE helper the route and the
`openwop:conversations.search` tool share (XCH-HOLE-5). It resolves the caller's
conversations through `isVisibleToAsync`, the predicate behind
`features/chat-export/access.ts` `authorizeConversationRead` and the rail list
(`routes/chatSessions.ts:323`). Only those session ids reach `searchChatMessages`.
CSP-4 closes structurally: a conversation the caller cannot see never enters the
query, so it cannot occupy a result slot.

Search uses the READ predicate, not the rail's narrower `isRailListed`. A public
channel the caller has not joined is readable (ADR 0195) and therefore searchable.
That matches Slack's channel search and is unchanged from ADR 0112.

### D3 — Query semantics and bounds

- **Tokens:** Unicode runs `/[\p{L}\p{N}]+/gu`, lower-cased, de-duplicated, at most 8
  tokens; a query over 200 characters is cut to 200 characters. This replaces the ASCII
  `[^a-z0-9]` split in `snippetFor`, which broke `café` into `caf`.
- **Match:** ALL tokens, each as a case-insensitive substring of the extracted text
  (prefix and infix match: `deploy` finds `deployment`). ADR 0112 used OR. With OR,
  each extra word widened the result set; AND narrows it, which is what typing more
  words means in every chat product's search.
- **Title hits:** all tokens are substrings of the live title, the same rule. A title
  hit adds a conversation with no message hit, as before. The role facet still
  excludes title-only hits.
- **Score:** for each token, `1 + ln(1 + occurrences)`, summed. Ties go to the newer
  message. Each conversation keeps its best message.
- **Bounds:** `CANDIDATE_LIMIT = 500` rows per query. The visible-id list is the same
  set the rail list materialises, so it adds no scan. The result limit is still at
  most 50.
- **`truncated: true`** in the response when the candidate cap was reached. The
  newest 500 matching messages were considered and older ones were not. The UI says so
  (D5), and the tool projection carries it (D4) so a model does not report "no
  results" as absence.

### D4 — The agent tool

The tool keeps its access rule and its empty result with no acting user. It keeps
`contentTrust: 'untrusted'`, so `host/toModelToolResult.ts` fences it. Its explicit
projection (ADR 0685) gains exactly one field, `truncated`, pinned by
`conversation-search-model-projection.test.ts`. Its description changes "Full-text
search" to state that all words must match.

### D5 — UX: every state designed

In `chat/conversations/ConversationsRail.tsx`:

- **Loading:** a quiet "Searching messages…" line while the debounced request is in
  flight.
- **Error:** `searchChatConversations` throws instead of returning `[]`. The rail
  shows a `Notice` with a retry, so a failure no longer reads as "no matches"
  (CSU-2).
- **No matches:** when neither titles nor messages match, the rail shows one line,
  "No conversations or messages match", instead of a blank rail.
- **Status:** a polite live region announces the count of message matches (CSU-3).
- **Highlight:** the matched tokens are wrapped in `<mark>` by splitting the snippet
  text. It is never `innerHTML`.
- **Markup:** the hit body uses `<span>` blocks, so there is no `<div>` inside
  `<button>`.
- **Truncated:** a muted note, "Showing matches from the most recent messages".
- All copy goes in the 4 locales.

### D6 — Remove the legacy rows

A best-effort boot task deletes rows under `hostsurf:search:` whose index segment is
`chat-search`. It pages through them, so a deployment that ran the old engine on a
durable backend does not keep private text readable by `core.db.search-query`. The task
is idempotent, logs a count, and never throws into boot. The in-memory surface's copy
goes with the process.

### D7 — Observability

One structured `info` log per search records counts only, never the query or any
text: `{ visible, candidates, hits, truncated, ms }`.

## Architect pass (pre-code, 2026-10-28)

Track A: host code only, with no wire. The findings and how each was folded in:

| # | Sev | Dimension | Finding | Fold |
|---|---|---|---|---|
| A1 | **Blocker** | Security / data handling | Search is an exit that bypassed ADR 0992 D1. `extractText` falls back to the raw envelope when `content` is empty, so thoughts, `workflowRun` state and interrupt resume tokens are matched, shown as snippets and handed to models (CSP-5, red on `82233a042`). | D1 reads every row through `messageView` and searches `text` only. `extractText` is deleted. |
| A2 | High | Performance / correctness | The DB prefilter runs over the raw envelope, so a needle that names an envelope key or internal (`content`, `role`, a thought) selects rows that the re-check then discards. A broad query can fill the 500-row cap with non-matches and report `truncated`. | Stated in D1 and D3. `truncated` is computed from the candidate count, so it is honest about what was examined. The trigger for Alternative 2 (FTS over extracted text) covers it. |
| A3 | High | Data integrity | D6 as first written did not say how it scans. A direct `Storage.kvList` is refused by a ratchet (`host/durable/durableStore.ts:45`), and the durable store exists only when `initDurableSurfaces` ran. | D6 uses `scanPrefix` from `durableStore`, runs only when the durable store is initialised, deletes only keys whose index segment is exactly `chat-search`, and is idempotent across the three instances. |
| A4 | High | Testability / contract | OR→AND and whole-token→substring change the agent tool's behaviour silently. | D4 updates the tool description. The projection test pins `truncated`, and the route test pins AND and `truncated`. |
| A5 | Medium | Performance | Visibility still costs one tenant-wide `listChatSessions` plus a per-session predicate per query. | Same cost as the rail list. Left as is, and the D7 log measures it. |

## Alternatives

1. **Keep the index, fix its edges.** That would mean namespacing the index so runs
   cannot address it, persisting the id sets, and wiring DSAR and conversation delete
   into it. Each fix patches one way the copy diverges, and the next new mutation path
   (an import, a moderator edit) would need the same wiring again. Rejected: CSC-1
   was exactly such a patch, and it held only within one process.
2. **Postgres FTS (`tsvector` + GIN) on `chat_messages`.** The right next step at
   scale. It ranks better and uses an index. But it needs a generated column over
   extracted text, because the stored content is a JSON envelope. That is a schema
   migration plus a SQLite equivalent, at a volume (56 sessions in prod) where
   `ILIKE` over the caller's sessions is fast. Deferred, with its trigger in
   Consequences. D1's `Storage` method is the seam it would replace, so the swap does
   not touch the engine.
3. **Reserve host-internal index names on `db.search`.** This closes CSP-3 only, and
   the other defects remain. It may still be worth doing for KB and subject memory,
   which share the vector surface the same way. That is filed, not done here.

## Consequences

- No private text is ever copied out of `chat_messages` by this feature.
- Cost per query is one prefiltered SQL read, bounded at 500 rows, plus the
  visibility pass the rail list already does. **The trigger to revisit (Alternative 2):**
  a p95 over 300 ms in the D7 log, or any tenant over 50,000 messages.
- Search semantics change from OR to AND, and from whole-token to substring. Existing
  tests that assert the OR behaviour are updated, with this ADR cited.
- `__resetSearchEngine` and `ensureConversationIndexed` are deleted. Tests that used
  them are rewritten.
- A candidate row is the whole stored envelope, and a run card can be large. A
  broad query that matches 500 large rows reads all of them. The D7 log records the
  candidate count and the time, and the Alternative 2 trigger covers this case too.
- **Residue, filed:** jump to the matched message (CSU-5) needs the feed to page to a
  message cursor. Today a hit opens the conversation at its latest messages. SQLite
  folds case for ASCII only. `CX2CD-R1` (DSAR keeps titles) is unchanged: search shows
  the same titles the rail already shows the same caller, so it adds no exposure.

## Implementation plan

| Phase | Change | Witness |
|---|---|---|
| P1 | `Storage.searchChatMessages` in postgres and sqlite | storage tests on both backends, including LIKE-escape and tombstone exclusion |
| P2 | Engine rewrite (D1–D3, D7), route `truncated`, tool projection (D4) | CSP-1..4 go green, plus the existing engine, route and freshness tests |
| P3 | Legacy row purge (D6) | test: seeded `hostsurf:search:*:chat-search:*` rows are deleted and other indexes are kept |
| P4 | Rail states (D5) and 4 locales | frontend vitest for loading, error, empty, count and highlight |

## Open questions

- [ ] OQ1 Should `db.search` and `db.vector` refuse host-internal index or namespace
  names from run-scoped bundles (Alternative 3)? KB and subject memory share the
  vector surface the same way. Filed for the owners of those features.

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| reservation | `36ec1c669` | — |
| P1–P4 | `baef0fda8` | `conversation-search-privacy.test.ts` CSP-1..5 are red on `origin/main`'s engine, route and tool (all 5, run 2026-10-28) and green after. `adr0997-chat-search-storage.test.ts` covers the SQLite adapter and the D6 purge. `adr0997-chat-search-postgres-live.test.ts` covers the Postgres SQL, run against a PGlite socket server (live-infra lane, skipped in `npm run ci`). Engine, route, freshness and projection tests are updated. Frontend: `MessageSearchResults.test.tsx` and `searchChatConversations.test.ts`. |

**Sabotage witnesses (each went red, then was restored):**
- the raw row instead of `messageView`: CSP-5 and the route test;
- OR instead of AND: engine and route;
- `>=` → `>` on the cap: the engine's `truncated` case;
- an ASCII tokenizer: the engine's Unicode case;
- dropping the `view.deleted` guard: the engine's meta-tombstone case;
- the purge matching every key, or deleting none: the storage test;
- the SQLite LIKE escape removed, or the tombstone clause removed: the storage test;
- the Postgres escape removed and `ILIKE` → `LIKE`: the postgres-live test, on PGlite;
- `truncated` dropped from the tool, or from the route: the projection and route tests;
- frontend: errors swallowed (both in the component and in the client), the live
  region, the title-match condition, the loading line, the truncated note and the
  highlight each removed.

The same-millisecond edit case in the freshness test was `it.fails` while the
watermark existed. It is now a plain `it`.

**Post-deploy (2026-10-28, rev `01071-2hh`, `88bb552fb`, verified 09:13Z by the lead, read-only).** Anon search returns an empty 200. A query with LIKE metacharacters and an 11-word query both return cleanly (the 8-token cap holds). The new rail strings are served. 0 ERROR log entries. There were 0 legacy `hostsurf:search:%:chat-search:%` rows to purge.

Two log facts matter for reading prod:
- The D6 purge logs `conversation_search_legacy_index_purged` only when it deleted rows, so silence means nothing was found.
- The D7 counts line is not written for a search that returns before the query: an empty query, or a caller with 0 visible conversations (`searchConversations` returns early). A missing line for those is expected, not a dropped log.

The #5350 namespace-move hotfix was a fallback for CSP-3. It was closed as superseded, because this ADR removes the index.

