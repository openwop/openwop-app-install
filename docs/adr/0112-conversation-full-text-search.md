# ADR 0112 — Conversation & message full-text search (B1, HIGH)

**Status:** implemented (Phases 1–3 — 2026-06-24). Phase 4 (the optional `ctx.chatSearch` workflow op + node pack) **deferred-by-design** — it is conditional on a driving use-case per the plan ("only if a driving use-case appears"); shipping the surface + node + agent-allowlist with no consumer would be speculative dead infra. The **Meilisearch swap** is captured behind the engine's substrate seam (see correction note below). See § Implementation.
**Date:** 2026-06-23
**Toggle:** `conversation-search` · default **OFF** · `bucketUnit: user` (a per-user productivity surface — search quality/scope is a property of one person's conversation corpus, not a tenant data-pipeline; the index + results are owner-scoped, so a user is the natural bucket and rollout unit).
**Surface:** host-extension `GET/POST /v1/host/openwop-app/chat/search` (non-normative) + a search affordance in the chat Conversations rail (`frontend/react/src/chat/`). Optional read-only `ctx.chatSearch` workflow op (ADR 0014).
**Depends on / composes:**
- **ADR 0043 (persistent conversations)** — the single conversation/message store this searches. Reuses `ConversationMeta` (`host/conversationStore.ts:53`), `ConversationParticipant` (`:37`), and the chat-message store (`ChatMessageRecord` `types.ts:188`; `listChatSessionMessages` `storage/{sqlite,postgres}/index.ts`). **No parallel chat store; no second chat system** — search is a read-only index over the existing one.
- **ADR 0043 Phase 6 visibility** — reuses `requireVisibleAsync` / `isVisibleToAsync` (`routes/chatSessions.ts:118,133,143`) verbatim so search returns ONLY owner-or-participant conversations (no existence leak).
- **ADR 0006 (RBAC)** — `workspace:read`-equivalent intrinsic self-ownership; uniform 404 / participant-scoped filtering, fail-closed.
- **ADR 0011 (KB/RAG)** — the *adjacent* search that already exists is KB **semantic** retrieval over documents; this is the missing **lexical** search over **conversations**. Disjoint corpora, disjoint owners — this ADR does NOT touch `kbService`.
- **ADR 0001 (feature-package architecture)** — ships as `src/features/conversation-search/` (service + routes.ts + feature.ts); a feature may import core (`host/conversationStore`, `routes/chatSessions` helpers) but core must not import it.
**RFC verdict:** **host-ext, NO new RFC.** A read-only index + a `/v1/host/openwop-app/chat/search` query route are non-normative host extensions; nothing touches the openwop wire (no run-event field, no capability flag, no `MUST`). Search returns nothing replay-affecting. If a *normative cross-host* "search my conversations on a peer" capability were ever wanted, THAT earns an RFC — not now.

> **Origin.** From the competitive analysis `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9/§11, backlog id **B1 (HIGH)** — "search across conversations + messages." Exemplars: **LibreChat** `api/server/routes/search.js` (a Meilisearch index over messages/conversations), **Open WebUI** `backend/open_webui/routers/chats.py` (SQL `LIKE` over titles + content + a `tag:` filter), **LobeHub** `packages/database/src/repositories/search/` (a DB-backed message/topic search repository). Today this app has only KB **semantic** search (documents) + a client-side conversation-**list title** filter — no message full-text search.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a search service with its own message copy, its own index, and its own access rules." Every one of those already has a single owner; duplicating any is the `no-parallel-architecture` violation. The corpus to search (conversations + messages) and the rule for *who may see a result* both already exist (ADR 0043); this ADR adds only an **index + a query route + a sidebar affordance** over them.

| Concern | Existing owner (file:line) | How this reuses it |
|---|---|---|
| Conversation existence + metadata (title, type, owner, participants) | `host/conversationStore.ts:53` (`ConversationMeta`), `:37` (`ConversationParticipant`) | Search reads conversation metadata as the row to return + the title channel; never a second conversation table. |
| Message corpus (role/content/meta, per conversation) | `ChatMessageRecord` (`types.ts:188`); `listChatSessionMessages` (`storage/sqlite/index.ts:1217`, `storage/postgres/index.ts:1241`); `appendChatMessage` (`sqlite:1241`, `postgres:1290`) | The index is fed FROM these (incremental on append; backfill by replay of `listChatSessionMessages`). The durable message rows stay the source of truth — the index holds only `tsvector` + ids, never an authoritative copy. |
| Who may see a conversation (visibility) | `requireVisibleAsync`/`isVisibleToAsync`/`isVisibleTo` (`routes/chatSessions.ts:143,133,118`) — ADR 0043 Phase 6 | Every search hit is post-filtered through the SAME visibility gate before it leaves the route — owner-or-participant only, uniform absence (no existence leak). Not a new ACL. |
| Self-ownership / caller identity | `resolveCallerUser` (the `/profiles/me/*` precedent, ADR 0042) | The search scope is the caller's own `userId`; results are their owned/participant conversations in the active tenant. |
| Feature toggle + bucket | `features/kb/feature.ts:29` (`toggleDefault {id,bucketUnit,…}`) | Declares `conversation-search` OFF / `bucketUnit:'user'` the same way; the rail affordance + route self-hide on a 404 when off. |
| Workflow read op (optional) | `ctx.features.<id>` typed surface (ADR 0014, `features/kb/surface.ts`) | If exposed, `ctx.chatSearch` is a thin read-only projection of the same service — same boundary kbService's `ctx.knowledge` uses. |

**Net new (small):** a `conversation-search` feature-package (service + routes.ts + feature.ts), a **search index** keyed by `(tenantId, conversationId, messageId)` built on **Postgres FTS** (`tsvector` over message content + conversation title) with a **deterministic in-memory fallback** for the sqlite/in-memory backend (the same two-backend posture KB's vector surface has), an incremental indexer hooked at `appendChatMessage` + a lazy backfill, and the `/chat/search` route + the rail search box. Meilisearch is a **documented future swap** (the LibreChat shape), not v1.

---

## Decision

Ship a **`conversation-search` feature-package** that maintains a **lexical full-text index** over the caller's conversations (titles) and messages (content), exposes a single **`GET/POST /v1/host/openwop-app/chat/search`** query route, and renders a **search box in the Conversations rail** that lists matching conversations with a highlighted message snippet and jumps to that conversation. The corpus is the existing ADR 0043 store; results are **always** post-filtered through the existing participant-scoped visibility gate. It is a **read-only** surface — no run, no message mutation, replay-irrelevant.

**Postgres FTS first; Meilisearch documented as a future swap.** v1 uses `to_tsvector`/`websearch_to_tsquery` with a GIN index on a generated `tsvector` column over chat-message content (+ conversation title), because Postgres is already the production backend (`storage/postgres/index.ts`) and this avoids standing up a new service. The sqlite/in-memory dev backend gets a deterministic tokenized substring index (parity, not production). A pluggable `SearchIndex` port (`index(msg)` / `query(scope, q)`) keeps the engine swappable — a Meilisearch implementation (the LibreChat precedent) drops in behind the same port if/when fuzzy ranking + typo tolerance are wanted, with no route/UI change.

### Data model

```ts
// host-ext; the index is DERIVED from the ADR 0043 store (rebuildable), never authoritative.
interface SearchIndex {                                  // the swappable engine port
  // incremental — called on appendChatMessage / conversation title change
  index(entry: IndexedMessage): Promise<void>;
  remove(conversationId: string, messageId?: string): Promise<void>;  // on delete
  // query — already scoped to the caller's allowed conversation ids
  query(scope: SearchScope, q: string): Promise<SearchHit[]>;
}

interface IndexedMessage {
  tenantId: string;
  conversationId: string;
  messageId: string;
  ownerUserId?: string;        // ADR 0043 owner — the bucket/scope key
  role: string;                // user | assistant | agent — filterable
  title: string;               // the conversation title (denormalized for title hits)
  text: string;                // ChatMessageRecord content (plain-text projection)
  createdAt: string;
}

interface SearchScope {
  tenantId: string;
  callerUserId: string;
  visibleConversationIds: string[];   // resolved via ADR 0043 visibility BEFORE the query
  type?: ConversationType;            // optional 'agent'|'group'|'workspace' facet
  role?: string;                      // optional sender facet (the Open WebUI tag: precedent)
}

interface SearchHit {
  conversationId: string;
  title: string;
  type: ConversationType;
  messageId?: string;          // the best-matching message (absent ⇒ a title-only hit)
  snippet: string;             // ts_headline / highlighted excerpt
  score: number;
  matchedAt?: string;          // the matched message's createdAt — for "jump to"
}
```

### RBAC & isolation

Per ADR 0006 + ADR 0043 Phase 6. The index is keyed by `tenantId` and the query is **scoped to `visibleConversationIds`** — the route first resolves the caller's owned-or-participant conversations (the `isVisibleToAsync` set), passes ONLY those ids into `query`, and re-validates each returned hit through `requireVisibleAsync` (belt-and-suspenders) before serializing. A cross-tenant or non-participant conversation is never indexed into another user's scope and never surfaces; a hit the caller can't see is dropped with uniform absence (no existence leak). `bucketUnit:'user'` means the toggle + scope are per-user. Writes (indexing) are internal-only, triggered by the existing message-append path — there is no caller-facing index-mutation route.

### Replay / fork safety

**N/A — read-only query, nothing recorded.** Search is a synchronous host-ext read that returns conversation/message references; it composes nothing into a run, stamps no `run.metadata`, and is never read on `:fork`. (Contrast the KB-retrieval replay concern in ADR 0113, which IS in a recorded prompt path.) The optional `ctx.chatSearch` op is likewise a read-only projection — if it ever fed a recorded run, its results would be recorded by the existing run-recording (it returns durable message ids + text, deterministic for a given corpus), but v1 exposes it as a tool a workflow may call, not an auto-injected prompt block.

### Evaluation matrix

| # | Axis | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | **YES** — `src/features/conversation-search/` (service + routes.ts + feature.ts). Imports core chat store/visibility; core does not import it. |
| 2 | Toggle + admin UI | **YES** — `conversation-search`, default OFF, `bucketUnit:'user'`. Standard toggle admin row. |
| 3 | Workflow `ctx.<feature>` surface (ADR 0014) | **OPTIONAL** — a read-only `ctx.chatSearch` op (an agent can search the *owner's* conversations). Recommended as a Phase-4 follow-on; v1 is the route + UI. |
| 4 | Node pack (`feature.conversation-search.nodes`) | **N-A for v1** — ships only if axis 3 lands; a single `chat.search` read node over `ctx.chatSearch`. No write nodes (read-only feature). |
| 5 | AI-chat envelopes | **N/A** — not an AI-chat protocol change; it queries the existing chat store. No new envelope. |
| 6 | Agent pack (`feature.conversation-search.agents`) | **none** — not an AI surface; there is no persona for "search." (Honest "none.") |
| 7 | Public surface | **YES** — `GET/POST /v1/host/openwop-app/chat/search` (non-normative host-ext). |
| 8 | RBAC + isolation (ADR 0006) | **YES** — participant-scoped via ADR 0043 Phase 6 (`requireVisibleAsync`), tenant + per-user keyed, uniform 404 / drop-on-invisible, fail-closed. |
| 9 | Replay / fork safety | **N/A** — read-only; nothing recorded, nothing stamped, nothing read on fork. |
| 10 | Frontend | **YES** — a search box in the Conversations rail (`chat/conversations/`), result list with highlighted snippet + jump-to-conversation; self-hides on a 404 when the toggle is off. Reuses `ui/` primitives; the canonical `npm run build` gate. |

## Phased plan

1. **Index port + Postgres FTS backend + indexer.** Define `SearchIndex`; implement the Postgres `tsvector`/GIN backend (a generated column or a sidecar `chat_search` table) + the deterministic in-memory/sqlite parity backend. Hook the incremental indexer at `appendChatMessage` and on conversation title change; add a lazy backfill that replays `listChatSessionMessages` for a conversation on first query miss. Unit tests for tokenization parity + scoping.
2. **Feature-package + route.** `features/conversation-search/{service,routes,feature}.ts`: toggle `conversation-search` OFF/user; `GET/POST …/chat/search?q&type&role&limit` — resolve the caller's `visibleConversationIds` (ADR 0043), query, re-validate hits, return `{hits, nextCursor?}`. Route tests: visibility filtering (a co-tenant non-participant's conversation never returns), title-only vs message hits, empty query, facets.
3. **Frontend — rail search.** A search input atop the Conversations rail; debounced query; result list (title + type chip + highlighted snippet) that selects/opens the matching conversation and scrolls to `matchedAt`. Self-hides on a 404. i18n the 4 locales; `npm run build` gate.
4. **Core-app extension surface (optional).** The read-only `ctx.chatSearch` workflow op + a `feature.conversation-search.nodes` `chat.search` read node (axis 3/4), so an agent can search the owner's conversations — only if a driving use-case appears. Document the **Meilisearch swap** (LibreChat shape) behind the `SearchIndex` port as the future fuzzy/typo-tolerant engine.

## Alternatives weighed

1. **Client-side filter only (extend the existing list-title filter).** Rejected — it can't search message *content*, doesn't scale past the loaded page, and the rail only holds a window of conversations. The gap (B1) is specifically message FTS.
2. **A second/standalone chat store optimized for search.** Rejected — the `no-parallel-architecture` + "no second chat system" violation; it would drift from the ADR 0043 store and re-implement visibility. The index is derived and authoritative-free.
3. **Meilisearch in v1 (the LibreChat path).** Deferred — stands up a new service + ops surface for a capability Postgres FTS already covers at this scale. Kept as a documented swap behind the `SearchIndex` port so it's a drop-in later.
4. **Reuse the KB vector store for "semantic conversation search."** Rejected for v1 — semantic search over chat turns is a different (and noisier) problem; lexical FTS is what B1 asks for and what every cited competitor ships. A semantic mode could be a later facet, but it must not conflate the conversation corpus with KB collections (separate owners).

## Open questions

1. **OQ-1 — Backfill strategy.** Lazy per-conversation backfill on first miss (proposed) vs an eager one-time reindex job. Lazy is simpler + spreads cost; an admin "reindex" affordance may be wanted for large legacy corpora.
2. **OQ-2 — Snippet/highlight source.** Postgres `ts_headline` (server-rendered) vs client-side highlight of the matched terms. Lean `ts_headline` for parity; client highlight as a polish.
3. **OQ-3 — Group/agent message attribution in results.** Show which participant/agent authored the matched message (the ADR 0043 `agentId` column) as a result sub-label — a UI nicety, not v1-blocking.
4. **OQ-4 — Index of untrusted/tool content.** Should assistant tool-output or fenced untrusted content be searchable? Lean yes (it's still the user's conversation), but flag it so a future redaction policy can exclude classes of content.
5. **OQ-5 — `ctx.chatSearch` consent.** If an agent can search the owner's conversations (axis 3), is that scoped to the current conversation's owner only? Recommend gating it the way ADR 0042 gates self-read — defer until a use-case lands.

---

## Implementation (2026-06-24)

**Correction (substrate).** The plan said "Postgres FTS first / a custom `tsvector`
sidecar table." Implementation found the host **already owns the two-backend FTS
abstraction** — the `db.search` SearchSurface (RFC 0018, in-memory ↔ a future
persisted backend), the lexical analog of the `db.vector` surface KB rides. A
feature-local `tsvector` table would be a PARALLEL substrate (a `no-parallel-architecture`
violation). v1 therefore rides `db.search` and **lazily rebuilds the namespace from
the durable chat rows** (`listChatSessionMessages`), exactly as KB rebuilds vectors
from documents — so the index is structurally drift-free (a missed/edited/deleted
message self-heals on next query, watermarked by `messageCount`). A **persisted FTS
backend** (the Meilisearch/pgvector-class production path) becomes a **host-surface
follow-up** that benefits the vector surface too — NOT a feature-local table. The
pluggable-engine intent of the ADR is satisfied by the surface port itself.

| Phase | Status | Commit | Tests |
|---|---|---|---|
| 1 — engine (port on `db.search` + self-correcting backfill + scoping/facets) | ✅ | `searchEngine.ts` | 11 unit (`conversation-search-engine.test.ts`) |
| 2 — feature-package + `/chat/search` route + shared visibility extraction | ✅ | `routes.ts`/`feature.ts`/`host/conversationVisibility.ts` | 5 route (`conversation-search-route.test.ts`) + 14/14 chat-session regression |
| 3 — Conversations-rail message FTS (debounced, self-hides on 404) | ✅ | `ConversationsRail.tsx`/`chatSessionsClient.ts` + i18n ×4 | `npm run build` gate green |
| 4 — optional `ctx.chatSearch` op + node pack | ⏸ deferred-by-design | — | conditional on a use-case |

**Architect findings applied:** the ADR 0043 READ-visibility predicate was extracted
to `host/conversationVisibility.ts` so the feature gates results through the EXACT
same rule as the chat routes (no authz-drift copy). Every hit is post-filtered to the
caller's `visibleConversationIds` (no existence leak). Read-only — replay/fork N/A.

---

## Correction — surfacing audit (2026-06-24)

The Status line frames this as "default OFF / `bucketUnit` user," but the feature was
**graduated to always-on** under ADR 0134 (`conversation-search` ∈ `RETIRED_TOGGLE_IDS`):
no toggle ships and the gates are open. Recording the as-built posture per the ADR
"correct, don't rewrite" rule. The search input is live in the chat conversations rail
(`ConversationsRail.tsx`) — **fully usable, no follow-up needed.**
