# ADR 0113 — KB reranking + hybrid (BM25 + dense) retrieval (B3, CRITICAL)

**Status:** implemented (Phases 1–3 + 5 — 2026-06-24). **Phase 4 (external-provider reranker) deferred-by-design** per the OQ-1 `/architect` call: the deterministic LOCAL reranker (Phase 2) already delivers B3's quality lift at zero replay cost; an external reranker injects nondeterminism into the recorded chat-turn prompt path, requiring the `run.metadata` record-and-replay stamp — correct, but to be built WITH a concrete reranker-provider Connection + the record-and-replay conformance test, not speculatively (same scope-discipline as ADR 0112 Phase 4). The `setRetrievalConfig` route already **rejects `rerank.kind:'connection'`** (only `local` honored) — the honest gate. See § Implementation.
**Date:** 2026-06-23
**Toggle:** **none new** (extends the existing `kb` feature, ADR 0011). The hybrid/rerank behavior is a **kb sub-config** (per-collection retrieval mode + env defaults), NOT a new feature-package or a `kb` toggle variant. The deterministic floor is always-on; the external-reranker path is gated by a live Connection (ADR 0024), not a toggle.
**Surface:** host-internal — an EXTENSION of `kbService.search`/`tenantRetrieve` (`features/kb/kbService.ts:409,436`) behind the `resolveSubjectKnowledgeRetrieve` seam (`host/agentKnowledgeComposition.ts:128`). No new public route shape (the existing `…/kb/…/search` + `ctx.knowledge`/`ctx.features.kb` paths gain a `mode`/`rerank` option).
**Depends on / composes:**
- **ADR 0011 (KB/RAG)** — the owner of collections, the chunk store, and the single-stage top-k cosine query (`kbService.search` `:409`; `vector.query` `:415`; `embedText` chunking `:182`). This ADR adds channels + a rerank stage *inside* that retrieval, reusing the durable chunk text + the host `db.vector` surface — **no parallel index**.
- **ADR 0042 (`resolveSubjectKnowledgeRetrieve`)** — the single subject-agnostic retrieval composition (`:128`, KB call at `:162`). Because every agent/human/notebook path delegates here (ADR 0038 wrapper `:107`; ADR 0043 Phase 5B `composeAgentKnowledgeContext` `:40` → `bootstrap/nodes.ts:1508`), upgrading retrieval *once* here lifts ALL of them — the no-fork proof.
- **ADR 0024 (Connections / credential broker)** — the OPTIONAL external reranker rides an existing Connection (`resolveConnectionCredential` `features/connections/connectionsService.ts:207`; provider registry `providerRegistry.ts`) + the SSRF-guarded egress, exactly as ADR 0107's sync fetch does. No new credential store.
- **ADR 0027 (connected-content-source trust)** — reranking preserves each chunk's `contentTrust` (`kbService.ts:173,183`) end-to-end; fusion/rerank never launders an untrusted chunk into trusted.
- **ADR 0001** — extends a feature; core stays uncoupled.
**RFC verdict:** **host-ext, NO new RFC.** Hybrid fusion + a rerank stage are host-internal retrieval mechanics over the already-Accepted RFC 0018 vector surface; nothing changes the openwop wire (no run-event field, capability flag, or normative MUST). The external reranker is a host-mediated provider call over RFC 0046 credentials + RFC 0076 egress (both Accepted). A new RFC is warranted only if a *normative cross-host* "reranked retrieval" capability is ever advertised — not now.

> **Origin.** From the competitive analysis `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9/§11, backlog id **B3 (CRITICAL)** — "reranking + hybrid retrieval," called out as the single biggest quality lever on a CORE capability we already ship. Exemplars: **Open WebUI** `backend/open_webui/retrieval/utils.py` (BM25 + dense fusion) + `retrieval/models/{colbert,base_reranker}.py` (a cross-encoder/ColBERT reranker stage); **AnythingLLM** `server/utils/EmbeddingRerankers/native/` (a bundled local reranker); **LobeHub** BM25 in `packages/.../builtin-tool-knowledge-base/`. Today this app does **single-stage top-k cosine** over the deterministic local-hash embedder (`embedText`) — no lexical channel, no reranker.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a new retrieval service with its own index, its own BM25 store, and its own model client." Every piece already has an owner; the win is that **one seam** (`resolveSubjectKnowledgeRetrieve`) fans out to every retrieval consumer, so the upgrade is centralized — duplicating retrieval per-consumer would be the `no-parallel-architecture` violation. The dense channel, the chunk store, and the trust marking all already exist; this ADR adds a **lexical channel + a fusion step + an optional rerank stage** in front of the existing return.

| Concern | Existing owner (file:line) | How this reuses it |
|---|---|---|
| Collections, chunks, durable chunk text | `kbService` (ADR 0011) — `chunkRows` (`kbService.ts:178`), durable `text` is source of truth | BM25 indexes the SAME durable chunk text; no second corpus. The dense channel is unchanged. |
| Dense retrieval (cosine top-k) | `kbService.search` (`:409`) → `vector.query` (`:415`) on the host `db.vector` surface (RFC 0018) | Becomes the **dense channel** of hybrid; retains `embedText` (`:182`) determinism. |
| Multi-collection retrieval composition | `tenantRetrieve` (`:436`) — per-collection concurrent search + score sort/threshold (`:458–470`) | Fusion replaces the bare `score` sort with RRF across the dense+lexical channels; the cap/threshold/trust projection stay. |
| The single retrieval seam every consumer uses | `resolveSubjectKnowledgeRetrieve` (`agentKnowledgeComposition.ts:128`), KB call at `:162` | The new retrieval mode is selected HERE / in `kbService` so agents (`:107`), humans (ADR 0042), notebooks (ADR 0084), and chat-turn (`:40`→`nodes.ts:1508`) all inherit it unchanged — one upgrade, every caller. |
| Chunk content-trust fencing | `kbService.ts:173,183` (per-chunk `contentTrust`) | Carried through fusion + rerank verbatim; an untrusted chunk stays untrusted in the final ranking. |
| External provider credential + egress | Connections `resolveConnectionCredential` (`connectionsService.ts:207`) + SSRF-guarded brokered fetch (RFC 0076) | The OPTIONAL external reranker resolves a Connection + calls out through the existing guard — the ADR 0107 fetch precedent. No new broker. |
| Replay-safe embedder | `embedText` (`localEmbedding.ts:34`) — deterministic, synchronous | The DEFAULT reranker is likewise deterministic + local (a cross-encoder-shaped scorer over local features), preserving the replay invariant (see § Replay). |

**Net new (small):** a **BM25/lexical channel** over the existing durable chunk text (a per-collection inverted index, derivable + rebuildable like the vector namespace's `hydrate`), a **Reciprocal-Rank-Fusion** combiner, a **rerank stage** with a **deterministic local default** + an **optional external-reranker** adapter via a Connection, and a per-collection/env **retrieval `mode`** (`dense` | `hybrid` | `hybrid+rerank`). Default mode preserves today's behavior until opted in.

---

## Decision

Extend ADR 0011 retrieval **in place** (no new feature-package) with a two-improvement pipeline, selectable via a retrieval `mode` and centralized so every `resolveSubjectKnowledgeRetrieve` consumer inherits it:

1. **Hybrid (BM25 + dense) via Reciprocal-Rank-Fusion.** Add a **lexical BM25 channel** over the same durable chunk text that the dense `embedText` channel already indexes. Run both channels, then fuse their ranked lists with **RRF** (`score = Σ 1/(k + rank_i)`, a parameter-light, score-scale-free combiner — the Open WebUI/standard hybrid pattern) to produce the candidate set. This directly addresses the local-hash embedder's lexical blind spots (exact terms, rare tokens, IDs) without replacing it.
2. **An optional reranker stage.** Over the fused candidates, an optional cross-encoder-style rerank reorders the top-N before truncation to top-k. **The default reranker is DETERMINISTIC and LOCAL** (a local feature-based cross-encoder scorer — no provider, synchronous, replay-safe — the AnythingLLM "native reranker" posture). An **external provider reranker** (e.g. a hosted Cohere/Jina-style rerank endpoint) is available **as an option via a Connection** (ADR 0024) for higher quality, gated by a live connection + SSRF-guarded egress.

The mode is a **per-collection retrieval sub-config** (with env-level defaults), defaulting to today's `dense` so nothing changes until opted in. This is honest capability: hybrid + the local reranker are an always-available quality lift on the existing floor; the external reranker is a documented upgrade gated on a credential.

### Data model

```ts
// Extends KnowledgeCollection retrieval config (ADR 0011) — host-ext, no wire change.
type RetrievalMode = 'dense' | 'hybrid' | 'hybrid+rerank';

interface RetrievalConfig {
  mode?: RetrievalMode;            // default 'dense' (today's behavior; opt-in upgrade)
  rrfK?: number;                   // RRF constant (default 60, the common value)
  rerank?: {
    kind: 'local' | 'connection';  // 'local' = deterministic default; 'connection' = external
    connectionId?: string;         // ADR 0024 Connection — required iff kind==='connection'
    topN?: number;                 // rerank the top-N fused candidates, then take top-k
  };
}

// The lexical channel — DERIVED from durable chunk text (rebuildable like the vector hydrate).
interface LexicalIndex {
  index(collectionId: string, chunks: Array<{ chunkId: string; text: string }>): Promise<void>;
  bm25(collectionId: string, query: string, topK: number): Promise<Array<{ chunkId: string; score: number }>>;
}

// The rerank port — local default OR a brokered external provider.
interface Reranker {
  // returns a reordered subset; MUST preserve each chunk's contentTrust + chunkId
  rerank(query: string, candidates: SearchHit[], topN: number): Promise<SearchHit[]>;
}
```

`SearchHit` (ADR 0011) is unchanged; fusion/rerank only reorder and rescore it, carrying `contentTrust`/`documentId`/`text` through.

### RBAC & isolation

Unchanged from ADR 0011/0006. Retrieval stays org-scoped (`mustGetCollection`, `kbService.ts:410`); the lexical index is tenant/collection-namespaced exactly like the vector namespace (rebuildable from the same durable docs, so no new persistence-trust surface). The external reranker requires **USE rights on the Connection** (ADR 0024 use-gate) for whoever configures `rerank.kind:'connection'` on a collection; the call rides the SSRF guard. A missing/revoked connection ⇒ best-effort fall back to the local reranker (never a silent quality cliff that leaks another tenant's credential).

### Replay / fork safety — the head-on concern

**This is the critical design point** (recommend `/architect` for the final call). Chat-turn prompt composition (ADR 0043 Phase 5B, `composeAgentKnowledgeContext` `:40` → `bootstrap/nodes.ts:1508`) injects retrieval results into the **recorded run**. ADR 0011's whole replay invariant is that retrieval is **deterministic** (the local-hash `embedText` both sides), so a `:fork`/replay reproduces the identical augmented prompt. A reranker that calls an **EXTERNAL model is nondeterministic** → on replay the injected context (and therefore the recorded prompt) would differ, breaking fork-equivalence.

**Decision (to preserve the invariant):**
- **The default reranker is DETERMINISTIC + LOCAL**, and BM25 + RRF are deterministic. So `dense`, `hybrid`, and `hybrid+rerank(local)` ALL keep the existing replay invariant with **nothing extra recorded** — a fork re-derives the identical ranking.
- **The external reranker (`rerank.kind:'connection'`) is nondeterministic, so its result MUST be recorded in the run and read verbatim on `:fork`/replay.** Concretely: when a chat-turn's knowledge composition uses an external reranker, the **resolved retrieval result (the final ordered chunk set injected into the prompt) is stamped into `run.metadata` at creation** (the ADR 0001 replay-stamp pattern: stamp-on-create, read-verbatim-on-fork) — replay reads the recorded chunks instead of re-calling the external model. This keeps fork-equivalence even with a nondeterministic stage, at the cost of recording the retrieval output (a bounded, already-in-prompt payload).
- **Recommendation:** default OFF for the external reranker in any **recorded-run** path until the record-and-replay shape is reviewed by `/architect` (see OQ-1). The non-recorded service paths (the `…/kb/…/search` route, KB UI) may use the external reranker freely — they record nothing.

### Evaluation matrix

| # | Axis | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | **N/A (extends ADR 0011 `kb`)** — no new package; retrieval mechanics live inside the existing `kb` feature + the shared `resolveSubjectKnowledgeRetrieve` seam. |
| 2 | Toggle + admin UI | **N/A (no new toggle)** — a per-collection retrieval sub-config + env defaults; the external reranker is gated by a Connection, not a toggle. (A KB collection settings UI exposes the `mode`.) |
| 3 | Workflow `ctx.<feature>` surface (ADR 0014) | **EXTENDS** `ctx.features.kb` / `ctx.knowledge` (`features/kb/surface.ts`, `tenantRetrieve` `:436`) — the same retrieve op, now mode-aware. No new surface id. |
| 4 | Node pack (`feature.kb.nodes`) | **EXTENDS** the existing `feature.kb.nodes` retrieve node with an optional `mode` arg; no new node pack. |
| 5 | AI-chat envelopes | **N/A** — retrieval is composed into the prompt host-side (ADR 0043 5B); no chat-protocol envelope change. |
| 6 | Agent pack (`feature.kb.agents`) | **none new** — the existing KB agent inherits better retrieval transparently; no new persona. |
| 7 | Public surface | **EXTENDS** — `…/kb/…/search` (+ `ctx` paths) gain a `mode`/`rerank` option; no new route shape. Non-normative host-ext. |
| 8 | RBAC + isolation (ADR 0006) | **YES (inherited + extended)** — org-scoped retrieval unchanged; external reranker adds an ADR 0024 Connection USE-gate + SSRF egress; trust fencing preserved. |
| 9 | Replay / fork safety | **CRITICAL — addressed.** Local/BM25/RRF deterministic (invariant preserved, nothing recorded). External reranker ⇒ record the retrieval result in `run.metadata`, read verbatim on fork; default OFF in recorded-run paths pending `/architect` (OQ-1). |
| 10 | Frontend | **YES (small)** — a per-collection retrieval-mode selector in the KB collection settings + optional connection picker for the external reranker; reuses `ui/`; the `npm run build` gate. |

## Phased plan

1. **Lexical BM25 channel + RRF fusion (deterministic).** Add the `LexicalIndex` over durable chunk text (rebuildable like the vector `hydrate`, `kbService.ts:195`) + an RRF combiner; wire `mode:'hybrid'` into `kbService.search` (`:409`) and the multi-collection fuse in `tenantRetrieve` (`:458–470`). Deterministic ⇒ replay-safe, nothing recorded. Unit tests: lexical recall on exact-term/ID queries the dense floor misses; RRF correctness; trust carried through.
2. **Local deterministic reranker (`hybrid+rerank(local)`).** A local cross-encoder-style scorer over the fused candidates (synchronous, deterministic). Wire it as the default `rerank.kind:'local'`. Still replay-safe — fork re-derives. Tests: rerank improves ordering on a fixture set; determinism (same input ⇒ same order); trust + chunkId preserved.
3. **Per-collection `RetrievalConfig` + settings UI.** Add `mode`/`rrfK`/`rerank` to the collection config + env defaults (default `dense`); a retrieval-mode selector in the KB collection settings. RBAC unchanged. Route/UI tests.
4. **External reranker via a Connection (opt-in) + the replay record-and-replay.** The `rerank.kind:'connection'` adapter over `resolveConnectionCredential` (`:207`) + SSRF-guarded egress; in any **recorded-run** path, stamp the resolved retrieval result into `run.metadata` on create and read it verbatim on `:fork` (the ADR 0001 replay-stamp). Default OFF for recorded runs pending the `/architect` decision (OQ-1). Tests: external rerank path, credential/SSRF gating, **replay equivalence** (a forked run with an external reranker reproduces the recorded chunks without re-calling the model), best-effort fallback to local on a missing connection.
5. **Core-app extension surface.** Thread `mode` through `ctx.features.kb` / `ctx.knowledge` (axis 3) + the `feature.kb.nodes` retrieve node arg (axis 4) so workflow retrieval inherits hybrid/rerank; document the external-reranker provider options behind the `Reranker` port (the AnythingLLM/Cohere/Jina shape) as drop-in adapters. No `/.well-known` change (non-normative).

## Alternatives weighed

1. **A new `kb-rerank` feature-package.** Rejected — retrieval has one owner (`kbService` + the `resolveSubjectKnowledgeRetrieve` seam); a parallel package would fork retrieval and only one of the many consumers (agents/humans/notebooks/chat) would get it. Centralizing at the seam upgrades all at once (the no-fork win).
2. **Replace the local-hash embedder with a provider embedder.** A separate, larger lever (ADR 0011's standing open question) — it changes the dense channel's determinism + requires persisting vectors. Out of scope here; hybrid+rerank lifts quality on the *existing* deterministic floor with no embedder swap. The two are composable later.
3. **External reranker as the default (the highest raw quality).** Rejected as default — it breaks the recorded-run replay invariant unless the result is recorded, and it requires a credential (not always present). The deterministic local reranker is the always-on default; external is the opt-in, replay-recorded upgrade.
4. **Skip BM25; rerank the dense top-k only.** Rejected — the local-hash embedder's lexical blind spots (exact terms/IDs/rare tokens) are exactly what a reranker over a dense-only candidate set can't recover (the relevant chunk never enters the candidate pool). BM25 widens the candidate set first; that's the point of hybrid.

## Open questions

1. **OQ-1 — `/architect` replay decision (external reranker in recorded runs).** Confirm the record-and-replay shape: stamp the resolved retrieval result into `run.metadata` on create, read verbatim on `:fork`. Open sub-questions: payload bound (the injected chunk set is already prompt-bounded), whether to record per-turn or per-run, and whether to forbid the external reranker entirely in recorded runs for v1 (simplest, deterministic) and ship it only in the non-recorded service/UI paths. **Recommend `/architect` before Phase 4 lands.**
2. **OQ-2 — Lexical index persistence vs rebuild.** Rebuild the BM25 index from durable chunk text on `hydrate` (like the vector namespace — storage-light, deterministic) vs persist it. Lean rebuild for parity with the existing model; revisit if rebuild cost is material at scale.
3. **OQ-3 — RRF vs weighted-score fusion.** RRF (rank-only, scale-free) is the proposed default; a tunable weighted dense/lexical blend is an alternative. Lean RRF (no per-collection tuning); expose `rrfK` only.
4. **OQ-4 — Default `mode` rollout.** Keep `dense` as the global default (zero behavior change) and let collections opt in, or flip new collections to `hybrid` (deterministic, replay-safe) by default? Lean: `hybrid` safe to default (deterministic); `rerank` opt-in.
5. **OQ-5 — Cross-collection rerank.** `tenantRetrieve` fuses across collections; should the reranker run once over the merged candidate set (proposed) or per-collection then merge? Once-over-merged is simpler and better-ranked; confirm cost.
6. **OQ-6 — Provider reranker honesty.** Which external rerank providers ship day-1 vs are documented adapters? Be honest (ADR 0001 day-1-honesty rule) — v1 ships the local reranker + the Connection-gated adapter seam; a named provider only when its Connection pack + a live test exist.

---

## Implementation (2026-06-24)

| Phase | Status | Where | Tests |
|---|---|---|---|
| 1 — BM25 lexical channel + RRF fusion (deterministic) | ✅ | `lexicalIndex.ts`; `kbService.search(mode:'hybrid')` | `kb-hybrid-retrieval.test.ts` |
| 2 — local deterministic reranker (`hybrid+rerank`) | ✅ | `reranker.ts`; `search` rerank stage | same |
| 3 — per-collection `RetrievalConfig` + env default + settings UI | ✅ | `resolveRetrievalMode`/`setRetrievalConfig`; `PATCH …/retrieval`; KB selector + i18n ×4 | `kb-route.test.ts` |
| 4 — external reranker via a Connection + record-and-replay | ⏸ deferred-by-design (OQ-1 architect call) | route rejects `connection` kind | — |
| 5 — thread mode through `ctx.features.kb` / `ctx.knowledge` + node | ✅ | `tenantRetrieve` (Phase 3) + `surface.ts` search | `kb-surface.test.ts` |

**The single-seam win (ADR 0042):** `ctx.knowledge.retrieve` is backed by
`tenantRetrieve`, which Phase 3 made mode-aware — so **every retrieval consumer**
(agents, humans, notebooks, chat-turn composition) inherits hybrid/rerank from one
upgrade, no per-consumer fork. `ctx.features.kb.search` was the lone gap and now
resolves the collection mode too (Phase 5).

**Replay invariant preserved:** BM25 + RRF + the local reranker are PURE +
DETERMINISTIC (id-stable tiebreak), so `hybrid` / `hybrid+rerank(local)` re-derive an
identical ranking on `:fork`/replay with NOTHING recorded — the ADR 0011 invariant
holds. The nondeterministic external reranker (Phase 4) is the only path that would
need record-and-replay, and it is deferred + route-gated. Content-trust is carried
through fusion + rerank verbatim (an untrusted chunk stays untrusted).
