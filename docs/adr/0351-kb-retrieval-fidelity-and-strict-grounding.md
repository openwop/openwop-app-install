# ADR 0351 — KB retrieval fidelity + the strict grounded-generation contract

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–4, 2026-07-12; KB-8 closed 2026-07-12 — see corrections) |
| **Date** | 2026-07-12 |
| **Feature** | extends **`kb`** (ADR 0011/0107/0113 lineage) — toggle id stable, no new toggle |
| **Closes** | `CSG-KB-1..8` ([gap register](../CAMPAIGN-STUDIO-GAP-FINDINGS.md)) |
| **Composes** | aiProviders seam (BYOK/managed), `host/webResearchSurface.ts`, Connections (ADR 0024), notifications emit seam, campaign-brief `sourceDocIds` (ADR 0156) |
| **RFC verdict** | **Host-ext, no new RFC.** Citations stay in artifact shape (PRD Q5 stands); a normative wire citation field would be a separate RFC and is explicitly out of scope. |

## Context (boundaries audit)

The whole Campaign Studio value prop — "AI that doesn't guess" — rides on retrieval quality and
grounding honesty. Today:

- Embeddings are a **deterministic 256-dim SHA-256 feature hash** (`aiProviders/localEmbedding.ts`,
  `local-hash-v1`), wired at `kb/kbService.ts:200-202`. Chunks/vectors are re-derived on demand
  (`hydrate`, `kbService.ts:244-253`) — *no stored vectors to migrate*.
- **Grounding fails open**: kernel + channel nodes `catch { proceed ungrounded }`
  (`packs/feature.campaign-channels.nodes/index.mjs:100-105`,
  `packs/feature.campaign-brief.nodes/index.mjs:59-68`); "strict" is one prompt sentence
  (`kbService.ts:630`).
- No chunk contextual enrichment (`kbService.ts:209-216`), no source versioning
  (`kbService.ts:459-481` delete+replace), no KB-change→downstream-stale signal
  (`knowledgeSyncRunner.ts:87`), no URL ingest (webResearch surface exists, unwired), external
  reranker declared but not honored (`kbService.ts:315-336`), retrieval `score` exists but never
  classified (`kbService.ts:564,579`).
- Single owner confirmed: `kbService` owns collections/chunks/retrieval; the campaign packs consume
  `ctx.features.kb.rag` — no second RAG path exists or is introduced.

## Decision

1. **Provider embeddings (CSG-KB-1).** A per-tenant KB embedding config
   (`embedding: { provider: 'local-hash' | <aiProvider id>, model }`) resolved through the existing
   aiProviders seam (BYOK/managed, same credential rules as generation). `local-hash-v1` remains the
   zero-config fallback and the retrieval response **labels its mode** (honesty). Because vectors are
   derived-on-demand, switching embedder is a config change + re-hydrate — no migration.
2. **Strict grounding is a server-side contract (CSG-KB-2).** A `groundingPolicy:
   'off' | 'best-effort' | 'strict'` field on the campaign brief (default `best-effort`, today's
   behavior). Under `strict`: retrieval failure/empty/below-`scoreThreshold` ⇒ the generate node
   **fails closed** with a structured `grounding_insufficient` output (recorded as the node result —
   replay-safe), never a silent ungrounded draft. `kb.rag` gains `minScore` + returns
   `coverage: 'ok' | 'thin' | 'none'`.
3. **Confidence surfaced (CSG-KB-7).** The `coverage` classification + per-citation scores ride the
   artifact payload; FE renders a confidence chip on kernel/draft cards (chip + label, never color
   alone).
4. **Chunk contextual enrichment (CSG-KB-3).** Optional per-collection flag: at ingest, a
   budget-capped envelope prepends a 1–2 sentence document-context header to each chunk before
   embedding (the Anthropic contextual-retrieval pattern). Deterministic fallback = heading-path
   prefix (already derivable from the heading-aware chunker) when no provider.
5. **Source versioning + staleness (CSG-KB-4/5).** `KnowledgeDocument` gains monotonically
   increasing `revision` (re-ingest = new revision, prior row retained, capped history). A
   revision bump **fires a host-ext staleness event** consumed by campaign-brief: any kernel whose
   `sourceDocIds` include the doc sets `kernelStale=true` + emits a notification (existing emitter
   seam, deep-linked per ADR 0336). `knowledge-sync` re-ingests route through the same path.
6. **URL ingest (CSG-KB-6).** A `url` branch in `resolveSource` composing
   `host/webResearchSurface.ts` (existing egress/firewall discipline), content-trust `'untrusted'`.
7. **External reranker honored (CSG-KB-8).** The declared `connection` reranker resolves through
   Connections; honest-off (422 with reason) until a connection is configured.

## Phases

| Phase | Ships | Gaps |
|---|---|---|
| 1 | Embedding config + provider embed path + mode labeling; re-hydrate on switch | KB-1 |
| 2 | `groundingPolicy` + fail-closed strict gate in `kb.rag` & both campaign generate nodes + `coverage` | KB-2, KB-7 |
| 3 | Revisions + staleness event → `kernelStale` + notification | KB-4, KB-5 |
| 4 | Contextual enrichment (flagged) + URL ingest + external reranker | KB-3, KB-6, KB-8 |

## Matrix highlights

Toggle: `kb` (stable). `ctx.features.kb` surface extended (`rag` gains `minScore`/`coverage`) behind
the same toggle+RBAC. Node/agent packs: `feature.kb.nodes` version bump. Replay: strict refusals and
coverage are node outputs (deterministic on replay); embedding-mode is stamped on retrieval results.
RBAC unchanged (org-scoped, fail-closed). No public surface.

## Alternatives weighed

- *Persist vectors + background re-embed pipeline*: rejected for now — derived-on-demand is the
  established shape and avoids a migration; revisit if hydrate cost bites at scale (recorded risk).
- *Strict mode as a prompt-only instruction*: rejected — that is the current defect.
- *A wire-normative citation envelope field*: out of scope (needs an RFC; artifact-shape citations
  already interop).

## As-built corrections (2026-07-12)

- **Managed embeddings NOT offered** (open Q1 resolved): the managed sample provider rejects
  embedding mode; only the tenant's BYOK default (openai/google) qualifies. Zero-config tenants
  stay on `local-hash` (labeled).
- **Revision history is a COMPACT log** (hash/title/when — `kb:docrev`, cap 20), not retained
  full-text rows: a 400k-char body ×20 would strain the durable store for what staleness needs.
- **Contextual enrichment shipped DETERMINISTIC-only** (`heading-path` — `[title > nearest
  heading]` prefix on the *embedded* text; stored chunk text stays raw). The LLM-enrichment
  variant is deferred: real per-chunk cost for unproven lift here; the deterministic prefix
  captures the section-context win.
- **External reranker (CSG-KB-8) DEFERRED, not wired**: honoring `rerank:{kind:'connection'}`
  requires a real reranker provider integration (a vendor connection pack — e.g. a Cohere
  Rerank pack) that does not exist; wiring config acceptance without a provider would be a
  dishonest knob. Config-time rejection stands until a reranker pack ships.
  **RESOLVED (2026-07-12):** the trigger fired — the `cohere-rerank` connection pack shipped
  (`examples/connection-packs/cohere-rerank/`, api_key, loads at boot) and the knob is now
  honest end-to-end: `setRetrievalConfig` accepts `rerank:{kind:'connection', topN?}` only
  when a `cohere-rerank` connection EXISTS (else 422 with reason; a per-collection
  `connectionId` pin is rejected — the broker stays the one selection choke point);
  `searchDetailed` reranks hybrid candidates through Cohere `/v2/rerank` over the
  brokered-egress spine (`brokeredPost` — SSRF-guard, https-only, no-redirect, bounded
  timeout; run-less `BrokeredCallDeps`), and ANY failure degrades honestly to the local
  deterministic reranker with a `rerank:{requested,applied}` label on the response
  (`applied:'local-degraded'`). Replay posture matches the Phase 1 provider query-embed:
  the node boundary records `kb.rag` outputs, so run replay never re-dials the vendor.
  Endpoint/model are host config (`OPENWOP_KB_RERANK_ENDPOINT`/`_MODEL`, non-secret).
  Evidence: `features/kb/externalReranker.ts`, `kb-connection-rerank.test.ts` (honest-off
  422, vendor-order + Bearer witness, degrade label, zero-call local default). The KB UI
  exposes retrieval MODE only; selecting the connection reranker remains an API-level
  config knob (a UI select is cosmetic follow-up).

## Phase → implementation record

| Phase | Ships | Evidence |
|---|---|---|
| 1 | `dispatchEmbeddings` (openai/google, width-matched, L2-normalized) · `resolveHeadlessEmbedder` (SR-1 closure) · `retrievalConfig.embedder` · durable `kb:veccache` · `vectorSignature` wipe-on-switch · labeled lexical-only degrade · FE embedder select | `providers/dispatch.ts`, `host/headlessAi.ts`, `kb/kbService.ts`; `test/kb-provider-embeddings.test.ts` (7) |
| 2 | `RagCoverage` (count-based) + `minScore` · brief `groundingPolicy` (validated) · kernel+channel nodes FAIL CLOSED under strict (`grounding_insufficient`) + `grounding` label on outputs · pack bumps (brief.nodes 1.1.0 / channels.nodes 1.3.0) · FE policy select | `test/campaign-grounding-policy.test.ts` (8) |
| 3 | `revision` + compact `kb:docrev` · `host/knowledgeLifecycle.ts` seam + `host.kb.document.updated` event · campaign-brief `markKernelsStaleForDoc` + deep-linked notification | `test/kb-revisions-staleness.test.ts` (2) |
| 4 | URL ingest (SSRF-guarded readable extraction, UNTRUSTED-fenced, derived title) · `heading-path` enrichment (embed-side only, in the vector signature) · FE URL input + enrichment select | `test/kb-url-enrichment.test.ts` (3) |
