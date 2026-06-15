# ADR 0011 — Knowledge Base / RAG

**Status:** implemented (Phases 1–3 shipped — `src/features/kb/`, `test/kb-agent.test.ts`)
**Date:** 2026-06-09
**Depends on:** ADR 0001 (feature-package architecture), ADR 0004 (Orgs),
ADR 0006 (RBAC), ADR 0007 (Media Library — source documents)
**Toggle:** `kb` · **Surface:** host-extension `/v1/host/openwop-app/kb/*` (non-normative)

---

## Context (boundaries audit first)

The MyndHyve Media⇄Knowledge-Base pairing was **cut from ADR 0007 on purpose**
(Media shipped standalone); it's sequenced now because the source-document store
(Media) exists. Per the `/architect` scope rule, the corpus was audited before
claiming anything is missing — and **almost the entire substrate already exists**:

- **Vector store** — `buildHostSurfaceBundle({tenantId}).db.vector` exposes
  `upsert/query/delete`, **tenant-scoped automatically**, transparent in-memory
  (default, brute-force cosine) ↔ **pgvector** (`OPENWOP_SURFACE_VECTOR=pgvector`)
  routing. RFC 0018 §A normative surface. **Do NOT reinvent it.**
- **Embedder** — `embedText(text, dims=256)` in `aiProviders/localEmbedding.ts`:
  deterministic, L2-normalized, **replay-safe, synchronous, no provider needed**.
- **Source documents** — ADR 0007 Media assets (org-scoped, token-served).
- **RAG pack** (`core.openwop.rag`) + a seeded `host.knowledge` demo surface
  (hardcoded corpus, consumed by `vendor.myndhyve.knowledge-tools` nodes).

What's **missing** is the product feature itself: org-scoped **collections** of
documents, an **ingest** pipeline (chunk → embed → index), **semantic retrieval
with citations**, and the UI — none of which exist. That is what this ADR builds,
as a feature-package (ADR 0001) composing the surfaces above.

### One architecture-imposed constraint (correction to the roadmap note)

The roadmap row assumed ingestion could call a **BYOK embeddings provider** and
"degrade gracefully when absent." The audit overturns the premise: **provider
embeddings AND LLM generation are `ctx`-only** — reachable only inside a workflow
run (they need a per-node `AdapterScope`: runId/nodeId/attempt/secretResolver/
policyResolver), never from synchronous feature-route code. So:

- **The feature's floor is the deterministic local-hash embedder** (`embedText`),
  used for BOTH ingest and query — which is exactly what makes cosine similarity
  coherent (same embedder both sides). It needs no provider config, so there is
  no "degrade when absent" — it always works.
- **Real-provider embeddings + grounded LLM answers are the documented upgrade**,
  delivered as a **workflow-node ingest/answer path** (where `ctx.callAI` is
  available), not wedged into route code as a fragile out-of-run provider call.

This is honest capability: the feature ships **semantic retrieval with citations**
today; grounded generation is a workflow step fed by the feature's augmented
context (see Phase 2).

## Decision

A `kb` `BackendFeature` (org-scoped, RBAC-gated, toggle **default OFF** — a new
product surface, ADR 0001 §6) + a `kb` `FrontendFeature`, composing the existing
vector + embedder + media surfaces. Mirrors the ADR 0007/0009 org-scoped template
(`authorizeOrgScope`, `DurableCollection`, toggle-gated routes).

### Data model + the restart-safe indexing seam

- **`KnowledgeCollection`** (`DurableCollection 'kb:collection'`) — `{collectionId,
  tenantId, orgId, name, description?, documentCount, chunkCount, createdBy,
  updatedBy, createdAt, updatedAt}`.
- **`KnowledgeDocument`** (`DurableCollection 'kb:document'`) — `{documentId,
  collectionId, tenantId, orgId, title, source: {kind:'text'} | {kind:'media',
  mediaToken}, text, chunkCount, createdBy, createdAt}`. **`text` is the durable
  source of truth.**
- **Chunks are DERIVED, not separately stored.** Ingest splits `text` (bounded
  recursive splitter), embeds each chunk (`embedText`), and upserts to the vector
  surface at namespace = `collectionId`, with metadata `{documentId, chunkIndex,
  title, text}` (the snippet, for citations). `chunkId = "${documentId}:${index}"`
  — deterministic.
- **Why derived:** the default in-memory vector surface is **ephemeral** (module
  state, lost on restart; pgvector persists). Because `embedText` is deterministic,
  re-chunking + re-embedding a document's durable `text` reproduces the **identical**
  vectors. So a process-level `hydrate(collectionId)` lazily rebuilds the vector
  namespace from durable documents on first access — restart-safe, storage-light
  (no vector blobs persisted), and it still uses the **host vector store** for the
  actual similarity query (not a reinvented one).

### Phase 1 — Collections + documents + ingest (backend)

Routes under `/v1/host/openwop-app/kb/orgs/:orgId/*`, all `authorizeOrgScope`-gated:
- `POST/GET/DELETE …/collections[/:collectionId]` — CRUD; delete cascades its
  documents + clears its vector namespace.
- `POST …/collections/:collectionId/documents` — ingest pasted **text** or a
  **Media token** (text-like assets extracted via the media store; binary/complex
  formats → clear 4xx, deferred). Chunk → embed → upsert; bump counts.
- `GET/DELETE …/collections/:collectionId/documents[/:documentId]`.
- **RBAC:** read/search = `workspace:read`; ingest/manage/delete = `workspace:write`.
- **Caps:** per-org collections, per-collection documents, per-document text bytes,
  chunk size/count — all bounded (the Media/CRM lesson: bound every stored field).

### Phase 2 — Retrieval + RAG-augment (backend)

- `POST …/collections/:collectionId/search` `{query, topK?}` → `hydrate` → embed
  query → `vector.query` → top-k `{chunkId, documentId, title, chunkIndex, text,
  score}`. `workspace:read`. Empty collection → empty results (never an error).
- `POST …/collections/:collectionId/rag` `{query, topK?}` → retrieve + assemble a
  **grounded augmented prompt** (a context block of the top chunks) + **citations**
  (the source documents). Returns `{query, contexts, citations, augmentedPrompt}`.
  **Generation is explicitly a workflow step** — the `augmentedPrompt` is ready to
  feed to an agent/`ctx.callAI`; the feature does NOT call an LLM from route code
  (provider is run-scoped). Honest: retrieval + augmentation here, generation in a run.

### Phase 3 — Frontend feature

`KnowledgeBasePage` as a `FrontendFeature` route, nav-gated on `kb`: collections
list/create, document add (paste text or pick a Media asset), per-collection
semantic search with scored results + citation snippets. `kbClient.ts`. The
canonical `npm run build` gate must pass.

## Architectural constraints honored

- **Compose, don't reinvent (roadmap mandate):** retrieval rides the host
  `db.vector` surface (in-memory ↔ pgvector) + the existing `embedText`; the
  feature owns collections/documents/ingest/citations, not a parallel vector store.
- **Feature-package contract (ADR 0001):** `BackendFeature` + `FrontendFeature`,
  toggle-gated, registered in the two registries — no core route edits.
- **Org-scoped + fail-closed (ADR 0006/0007):** `authorizeOrgScope` on every
  route; cross-tenant/non-member → 404/403; vector namespaces are tenant-scoped by
  `buildHostSurfaceBundle`.
- **Media boundary (ADR 0007):** a doc references a Media token; bytes are not
  re-stored (the same boundary CMS sections use).
- **Honest capability:** the local-hash embedder is the always-on floor; provider
  embeddings + grounded answers are run-scoped and delivered via workflow nodes —
  not faked from route code.

## Alternatives considered

1. **In-process cosine over durable chunks (skip the host vector surface).**
   Rejected — the roadmap explicitly says reuse `host.db.vector`, and a parallel
   store would diverge from the pgvector production path.
2. **Persist chunk vectors durably (DurableCollection per chunk).** Rejected for
   v1 — `embedText` is deterministic, so re-deriving from durable `text` on
   hydrate is identical and far lighter than storing 256-float blobs per chunk.
   (Required only once a NON-deterministic provider embedder is used — that's the
   workflow-ingest upgrade, which will persist vectors.)
3. **Call a BYOK embeddings provider / LLM from the ingest+rag routes.** Rejected
   — architecturally impossible without a per-run `AdapterScope`; synthesizing a
   fake out-of-run scope would be exactly the fragile bandaid the review bar
   rejects. Deferred to a workflow-node path.
4. **Back the seeded `host.knowledge` surface with this store now** (so
   `vendor.myndhyve.knowledge-tools` nodes hit real collections). Deferred — it
   touches core surface wiring (`knowledgeSurface.ts` + `buildHostSurfaceBundle`)
   and needs a `setKnowledgeBackend` seam (the notifications `setNotificationBackend`
   pattern); a focused follow-on, not part of the feature's own surface.

## Open questions

- [ ] **Back `host.knowledge` with the real store** (alt. 4) — add a
  `setKnowledgeBackend` seam so workflow retrieval nodes use real collections.
- [ ] **Real-provider embeddings + grounded answers** via a workflow-node ingest/
  answer path (where `ctx.callAI` is available); persist vectors when the embedder
  is non-deterministic.
- [ ] **Text extraction for binary assets** (PDF/Office → text). v1 ingests
  pasted text + text-like Media assets only.
- [ ] **Hybrid (keyword+vector) search + re-ranking** — deferred; v1 is the
  vector floor.
