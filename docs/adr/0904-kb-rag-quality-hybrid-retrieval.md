# ADR 0904 — KB retrieval quality: a real default embedder, query-aware embeddings, fair cross-collection fusion, layout-aware parsing

**Status:** Accepted (2026-10-17) — plan only, no code. Architect-reviewed (§ Architect review). Live spend, vendor accounts and IAM wait on § Open decisions for David.
**Date:** 2026-10-17
**Feature:** `kb` (extends ADRs 0011, 0113, 0351, 0398, 0643; ALWAYS-ON, no toggle, none added)
**Origin:** MyndHyve port, capability 1 of 4 (gap analysis 2026-10-17,
`/Users/david/dev/yc/MYNDHYVE-OPENWOP-APP-GAP-ANALYSIS.md` row "Knowledge base / document search").
MyndHyve baseline read at `7246fb1ce`.
**RFC verdict:** **host-extension — no RFC.** Every change is inside `kbService`, the embedder
resolver, the vector adapter and host routes under `/v1/host/openwop-app/kb/*`. `ctx.knowledge`
already exists and keeps its shape; no run-event field, capability flag or envelope kind is added.

## Context

The gap report says "openwop-app's default embedder is a lexical hash" and that MyndHyve's RAG is
better. Both halves are true, but the report undersells what openwop-app already has. Read from code:

### MyndHyve baseline (`7246fb1ce`)

| Stage | What it does | Citation |
|---|---|---|
| Trigger | Firestore `onDocumentWritten` starts a `knowledge.document-processing` run per asset; scheduled retry ×5 | `functions/src/knowledge/triggers.ts:49-68,78,155`; `retry.ts:26-33` |
| Workflow | parse → chunk → enrich → embed → persist → update-asset-metadata, 300 s budget | `src/seeds/workflows/knowledge/documentProcessingWorkflow.ts:59-184,289` |
| Parse | PDF/PPTX → Document AI online `processDocument` (location `us`) when `DOCUMENT_AI_PROCESSOR_ID` set; DOCX → `mammoth.convertToHtml` keeping h1–h6, tables, lists; md split on headings | `src/core/workflow/knowledge/parseDocument.ts:33-74`; `parsers/documentAIParser.ts:20,57-66`; `parsers/docxParser.ts:115-152` |
| Chunk | 512-token target / 75 overlap / 1024 cap; tables and lists kept whole; heading change forces a split | `chunking/headingAwareChunker.ts:38-44,132-174` |
| Enrich | Anthropic-style contextual retrieval: LLM writes a 2–3 sentence "situate this chunk" prefix from the doc (≤32k chars); default `gemini-2.5-flash` via ADC | `enrichment/contextualEnrichment.ts:54-63,79-105,130-174` |
| Embed | default Vertex `gemini-embedding-001` @ **768** via ADC; workspace OpenAI/Gemini key decrypted with KMS | `embedding/embeddingService.ts:93-99,116-143,157-168` |
| Retrieve | Firestore `findNearest` COSINE + keyword (`array-contains-any` match count — not BM25), **RRF k=60**, Vertex `semantic-ranker-default-004` rerank, 15 s timeout, order fallback; no score floor | `functions/src/knowledge/retrieval/retrieveKnowledge.ts:98,119,217-253`; `keywordSearch.ts:47-99`; `vertexReranker.ts:59-106` |

**MyndHyve warts — never inherit (port, not clone):**

1. The **query is embedded as a document** (`taskType: RETRIEVAL_DOCUMENT` for queries,
   `embeddingService.ts:280,343` called from `retrieveKnowledge.ts:98`).
2. Without Document AI, a PDF is decoded as UTF-8 bytes (`parseDocument.ts:47-51`).
3. Online Document AI only; the 15-page limit is a comment, batch mode absent (`documentAIParser.ts:22`).
4. "Layout-aware" headings are an all-caps/numbering heuristic over `paragraphs`, not the Layout
   Parser's own blocks (`documentAIParser.ts:171-175,239-257`).
5. Chunk id lacks the collection, so an asset in two collections clobbers itself (`persistChunks.ts:98`).
6. Keywords come from raw, not enriched, text (`headingAwareChunker.ts:204-206`).
7. A non-768 BYOK model silently mismatches the fixed 768 index.
8. BYOK uses the workspace **owner's personal key**.
9. Its own `TODO.md:897,1110` says the `knowledge.retrieve` node has no executor; retrieval is chat-only.

### openwop-app today (`origin/main` `4cdb132c3`)

| Concern | Owner | Finding |
|---|---|---|
| Ingest + parse | `features/kb/kbService.ts:2150-2210` | `officeparser`, `unpdf` with `mergePages:true` (`:2190`, flat text), `mammoth.extractRawText` (`:2195`, no structure); image OCR / audio via LLM behind env flags. `pageNumber: null` hard-coded (~`:1926`). No tables. |
| Chunk | `kbService.ts:126-127,680,693-716` | 1200 chars / 150 overlap, `CHUNKER_VERSION = 2`; splits on markdown `#` only, so PDF/DOCX get an empty `headingPath`. |
| Enrich | `kbService.ts:458-465` | deterministic `[title > headings]` prefix, opt-in. LLM enrichment deferred (ADR 0351 as-built). |
| Embed — default | `aiProviders/localEmbedding.ts:15,44-56` | **`local-hash-v1`** (SHA-256 bucket/sign, sublinear TF). Confirmed. |
| Embed — BYOK | `host/headlessAi.ts:445-531`; `providers/dispatch.ts:1384-1445` | openai `text-embedding-3-small`, google `gemini-embedding-001` (**Gemini API key, not Vertex**), cohere `embed-english-v3.0`. Width requested = deployment width (`dimensions` / `outputDimensionality` / Matryoshka truncate+renormalise). **No query/document input type** (Google sends none; Cohere uses `search_document` for queries too). |
| Width | `localEmbedding.ts:16,23-26` `effectiveEmbedDims()`; `DEPLOY.md:225` | **Production `OPENWOP_VECTOR_PG_DIM=256`.** One width per deployment (ADR 0867 D5); pgvector boot probe rejects a different column width. |
| Vector store | `host/vector/pgVectorVector.ts:9-15,60-72` | exact scan; HNSW deferred to the ADR 0871 T3 trigger. |
| Model change | `kbService.ts:901,946,2357-2360` | namespace signature `mode:model:dims:enrich:vN`; mismatch ⇒ budgeted versioned reindex (ADR 0398 P3, self-driving per ADR 0643). Provider vectors cached per (model, text hash). |
| Retrieval | `kbService.ts:469-472,1764-1840`; `lexicalIndex.ts:25-64`; `reranker.ts:18-48`; `externalReranker.ts:22-55` | modes `dense | hybrid | hybrid+rerank`, **default `dense`** (`OPENWOP_KB_RETRIEVAL_MODE`). BM25 is real Okapi but **re-chunks the whole collection per query** (`kbService.ts:853-856`). RRF k=60, 24 candidates/channel. Rerankers: local lexical scorer; Cohere `rerank-v3.5` via a brokered connection. No embedder ⇒ labelled keyword-only. |
| Multi-collection | `kbService.ts:1905-1920` `tenantRetrieve` | **Bug:** concatenates per-collection hits and sorts by **raw score** (`:1917`). Scales differ by mode (cosine ≈0–1, RRF ≈0.03, local rerank up to ≈8, Cohere 0–1), so a `hybrid+rerank` collection always outranks a `dense` one regardless of relevance. Default `scoreThreshold` 0 (`:1905`). |
| Consumers | `kb/feature.ts:25`; `host/agentKnowledgeComposition.ts:356`; `host/agentToolProvider.ts:249` | `ctx.knowledge` (= `tenantRetrieve`), agent knowledge composition, the `openwop:knowledge.search` chat tool, `feature.kb.nodes@1.2.1` (`search`, `rag`, `list-collections`, `reindex-drain`), `vendor.myndhyve.knowledge-tools@1.0.3` (`knowledge.retrieve`, `knowledge.augment-prompt`). |
| GCP access | `host/blob/gcsBlob.ts:34`; `features/app-builder/deploy/adapter.ts:110-130` | metadata-server token + REST is the house pattern. No Vertex client exists. `@google-cloud/kms` is the only `@google-cloud/*` dep (optional). |

So the real gaps are not "add hybrid + RRF + rerank" — those exist. They are: **(a)** the
zero-config default is lexical; **(b)** no query-side input type, on any provider; **(c)**
cross-collection ranking is unfair; **(d)** default mode is `dense`; **(e)** parsing throws away
structure (headings, tables, pages) for PDF/DOCX; **(f)** BM25 is O(corpus) per query; **(g)** no
LLM contextual enrichment; **(h)** no Vertex reranker option.

### Boundaries audit

- **One retrieval owner:** `kbService.search` / `tenantRetrieve` (ADR 0113 alt. 1 — no parallel
  `kb-rerank` package). Every change lands there, so all consumers improve at once.
- **One embedder resolver:** `host/headlessAi.ts` (`resolveHeadlessEmbedder`, `resolveHeadlessEmbedderForSpec` `:503`).
  The new default is a new **arm** of that resolver, not a second resolver.
- **One reindex path:** ADR 0398 P3 + ADR 0643 self-driving reindex. A default-embedder switch is
  a signature change and rides it; no new migration machinery.
- **One budget:** `embedBudget.ts` (ADR 0398). Enrichment and parser spend are metered through it.
- **Reranker seam:** the `RetrievalConfig.rerank.kind` union (`'local' | 'connection'`,
  `kbService.ts:374`; adapters `reranker.ts`, `externalReranker.ts`). Vertex is a third arm,
  recorded for replay exactly as the Cohere `connection` arm is.
- **Route collision:** no new route prefix. New admin read `GET …/kb/orgs/:orgId/quality` (see P0)
  sits under the existing `kb` router; `git grep "kb/orgs/:orgId/quality"` → none.

## Decision

**D1 — A host-tier default embedder, resolved after BYOK and before local-hash.** The resolution
order becomes: per-collection `embeddingSpec` → tenant BYOK headless default → **operator host
embedder** → `local-hash-v1`. The operator embedder is configured by
`OPENWOP_KB_HOST_EMBEDDER=<provider>:<model>` and is off unless set. P5 ships one adapter,
`vertex:gemini-embedding-001`, authenticated by **ADC via the metadata-server token** (house REST
pattern, no new dependency), region `OPENWOP_VERTEX_LOCATION` (default `us-central1`). The model is
multilingual, which matters for the 4-locale product (ADR 0398 open question). Off GCP the arm is
absent and the chain falls through exactly as today. White-label adopters opt in; nothing changes
for them by default.

*Throughput (architect A2).* Vertex `gemini-embedding-001` accepts **one input text per
`:predict` request** (Google docs). The existing batching (`EMBED_BATCH_CHUNKS`, `kbService.ts:995+`)
assumes multi-input calls, so the Vertex adapter fans a batch out over a bounded concurrency pool
(default 8) with 429/`Retry-After` backoff, and budget estimates count **calls**, not batches.

*Spend guard (architect A3).* Today the daily embed cap defaults to 0 = uncapped
(`embedBudget.ts:18-21`) and is consulted only on hydrate/drain (`kbService.ts:1011,2996`), so
query-time embeds are unmetered. Turning the host arm on changes the signature of every non-BYOK
collection in every tenant at once. Therefore: boot **refuses** `OPENWOP_KB_HOST_EMBEDDER` with the
cap unset or 0; query embeds are metered against the same cap; `anon:` tenants never get the host
arm (they stay on `local-hash`); and the arm is rolled out per tenant through the ADR 0398 budgeted
reindex, never as one fleet-wide re-embed.

*This corrects ADR 0351's as-built "managed embeddings NOT offered".* That decision refused the
*managed sample LLM provider* as an embedder, because it had no embeddings mode. An operator-funded
embedder is a different thing: a deployment-level default with its own budget line. A correction
note goes on 0351 in P5.

**D2 — Query-aware embeddings on every provider.** `EmbeddingsRequest` gains
`inputType: 'query' | 'document'`. Google/Vertex send `taskType: RETRIEVAL_QUERY | RETRIEVAL_DOCUMENT`;
Cohere sends `search_query | search_document`; OpenAI ignores it. Document-side vectors change for
Google/Vertex, so their namespace signature gains a `q1` token and the ADR 0398 reindex re-embeds
those collections in the background. MyndHyve wart 1 is fixed, not ported.
- **The provider-vector cache must learn the input type (architect A1, CRITICAL).** A cache row is
  valid when `model` + `textHash` match (`VecCacheRow`, `kbService.ts:606-611`, checked `:983`), so a
  `q1` reindex would find the old no-task-type Google vectors under the same model and reuse them —
  the reindex would run and change nothing. `VecCacheRow` gains `embedVersion` (`'q1'`), and
  validity requires it. Red test: a reindex after `q1` calls the provider for every chunk.
- **Only providers whose document side changed re-embed.** Cohere already embeds documents as
  `search_document` (`dispatch.ts:1432`); only its query side changes, so Cohere collections keep
  their vectors and their signature. OpenAI has no input type and is unchanged.

**D3 — Keep one width per deployment; do NOT move production to 768 by default.** All three API
providers and Vertex serve Matryoshka-truncated widths, so 256 is a valid request today. Moving to
768 means a second pgvector table, a full re-embed and 3× vector storage. That is justified only by
a measured lift, so P0 builds the measurement and P8 is a gated, measured migration. Google's own
published retrieval numbers for `gemini-embedding-001` show a small drop from 768 to 256; we will
measure it on our corpus, not cite theirs.

**D4 — Fair cross-collection fusion, with a calibrated 0–1 relevance kept.** `tenantRetrieve`
stops sorting raw scores; it **orders** by RRF over the per-collection ranked lists (k=60) and
exposes `fusedRank`. It does **not** replace the 0–1 score consumers already threshold on
(architect A4): `vendor.myndhyve.knowledge-tools/index.mjs:38-41` filters `relevanceScore >=
scoreFloor` and its manifest promises a "host-normalized relevance score" — raw RRF (≈0.016–0.033)
would silently drop every chunk. So each chunk carries one calibrated `relevanceScore` in [0,1],
chosen in this order: a provider reranker's score (Cohere/Vertex return calibrated relevance) →
the chunk's dense cosine clamped to [0,1] when a dense channel ran → BM25 divided by that
collection's top BM25 score (keyword-only). `scoreThreshold` and `scoreFloor` apply to
`relevanceScore`; `nativeScore` keeps the mode's raw number for display. Parity test against the
vendor pack. This is a defect fix, independent of everything else.

**D5 — Default retrieval mode `hybrid`.** Changing the default from `dense` is gated on the P0
eval: it ships only if hybrid beats dense on recall@5 and MRR on the fixture corpus with both the
local-hash and a provider embedder. `hybrid+rerank` stays opt-in until a provider reranker is
configured; the local lexical reranker can hurt a semantic dense channel, and the eval decides.

**D6 — Structure-preserving parsing in-process first; Document AI as an opt-in operator parser.**
- In-process (P2): DOCX via `mammoth.convertToHtml` with the heading stack, tables as markdown and
  lists (MyndHyve's `docxParser` shape); PDF via `unpdf` **per page** so `pageNumber` is real;
  the chunker learns markdown tables as atomic blocks and heading-change splits for all formats.
- Operator parser (P6): a `DocumentParser` port with a `document-ai-layout` adapter (Layout Parser
  processor, ADC REST, `OPENWOP_KB_DOCAI_PROCESSOR`), used for PDF/PPTX when configured, with the
  in-process parser as fallback. Use the Layout Parser's own `documentLayout` blocks (headings,
  tables, lists) — **not** MyndHyve's all-caps heuristic (wart 4). Files over the online page
  limit go through batch processing via a GCS staging prefix on the existing blob bucket, polled
  by the reindex drain — wart 3 fixed. Scanned PDFs (no text layer) are the main beneficiary,
  closing ADR 0398's open question.
- Spend: metered per page through `embedBudget.ts` and capped per tenant per day.

ADR 0398 alt. 1 (an out-of-process parsing *service*) stays rejected; this is a provider call
from the existing in-process ingest, which 0398 alt. 2 explicitly deferred, not rejected.

**D7 — LLM contextual enrichment, opt-in per collection, cost-governed.** Port MyndHyve's
contextual-retrieval step: per chunk, an LLM writes a ≤ 2-sentence situating prefix from the
document (capped at 32k chars), embedded with the chunk. Stored chunk text stays raw (ADR 0351
as-built rule); BM25 indexes raw + prefix so keywords include the enrichment (wart 6 fixed).
- Model: the collection's chosen BYOK provider, else the operator host model if configured; never
  silently. No model ⇒ the option is refused at config time, not degraded at ingest.
- Cache: keyed by `(chunk hash, document hash, model)`, so a re-index without content change
  costs nothing.
- Budget: per-chunk calls go through `embedBudget.ts` with a per-collection estimate shown before
  enabling (chunks × prompt tokens).
- Signature gains `enrich:llm:<model>`; enabling it triggers the background reindex.

**D8 — Vertex reranker as a third `rerank.kind` arm.** `rerank:{kind:'vertex'}`
calls the Discovery Engine ranking API (`semantic-ranker-default-004`, 15 s timeout) with ADC,
degrading to the local scorer on error, exactly like the Cohere adapter. Recorded-run rule from
ADR 0113 P4 applies unchanged: the reranked result is recorded at the node boundary and replayed
verbatim on `:fork`. Operator-enabled only (`OPENWOP_KB_VERTEX_RERANK=1`).

**D9 — Persisted lexical index behind a growth trigger.** BM25 over a re-chunked collection is
O(corpus) per query. P3 adds a Postgres side table `kb_lexical (tenant, namespace, chunk_id,
tsv tsvector)` with a GIN index and `ts_rank_cd` scoring using the `simple` configuration (locale-
neutral), written by the same ingest/reindex path that writes vectors. RRF uses ranks, so swapping
BM25 for `ts_rank_cd` changes only rank order, which the P0 eval checks. Following ADR 0871, it
switches on per collection above a measured size trigger (initially 5,000 chunks); below that the
in-memory BM25 stays. SQLite/durable deployments keep in-memory BM25.

**D10 — Ingestion stays a service, not a workflow chain.** MyndHyve runs ingestion as a workflow
because a Cloud Function has a 540 s ceiling and no other retry primitive. Here the ADR 0398/0643
reindex is already a budgeted, resumable, self-driving drain, and knowledge-sync (ADRs 0107, 0605)
already feeds `ingestDocument`. A run per document would burn the daily run quota and fork the
single ingest owner. The workflow lane is the existing `feature.kb.nodes.reindex-drain` node.
This is consistent with the CLAUDE.md chain doctrine: nothing here is a hard-coded workflow.

**D11 — Model-facing text tells the truth (architect A5).** `openwop:knowledge.search` describes
itself as "lexical RAG… (deterministic, no network)" (`agentToolProvider.ts:242,251`), and the
`knowledgeRetrieverTool` docs say the same (`:350-367`). That is already false under BYOK and becomes
false for everyone under D1/D5. P0 rewrites both from the resolved configuration and pins them in
`agent-prompt-tool-ids.test.ts` (CLAUDE.md non-negotiable: schema text reaching a model is generated
or test-pinned).

**D12 — One GCP ADC helper (architect X1).** Four metadata-token fetchers exist already
(`host/blob/gcsBlob.ts:34`, `host/certificationEvidence.ts:77,420-518` — the only one that caches
until expiry — `features/app-builder/deploy/adapter.ts:111`, `features/runtime-posture/liveRead.ts:29`).
Whichever of ADR 0904 / 0906 lands first extracts `host/gcpAdc.ts` from the caching version, moves
all four callers onto it, and adds a ratchet test that no other file fetches
`metadata.google.internal`. The token fetch goes direct (the metadata host is blocklisted by
`webhookEgressGuard.ts:246`); the `*.googleapis.com` calls go through the guarded fetch.

### Rejected

- **Port Firestore KNN / keyword-array retrieval.** pgvector + real BM25 are already better.
- **Move production to 768 now.** Unmeasured lift, certain migration cost (D3).
- **Owner-key BYOK (MyndHyve wart 8).** openwop's per-collection spec + tenant default is the
  owner-independent shape; keep it.
- **Score-normalise instead of RRF across collections (D4).** Min-max normalisation is unstable
  for small hit lists and still compares unlike scorers; RRF only compares ranks.
- **Vertex reranker as default.** Breaks zero-config and needs a recorded result for replay (ADR
  0113 alt. 3 still holds).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | All changes inside `features/kb/`, `host/headlessAi.ts`, `providers/dispatch.ts`, `host/vector/`. New files: `features/kb/parsers/{docx,pdfPages,documentAi}.ts`, `features/kb/vertexReranker.ts`, `host/gcpAdc.ts` (shared metadata-token helper, also used by ADR 0906). No core route/nav edits. |
| 2 | Toggle + admin UI | `kb` stays always-on (no toggle). New knobs are **operator env** (`OPENWOP_KB_HOST_EMBEDDER`, `OPENWOP_KB_DOCAI_PROCESSOR`, `OPENWOP_KB_VERTEX_RERANK`, `OPENWOP_VERTEX_LOCATION`) listed in FEATURES § "Env-gated operational flags". Per-collection choices (enrichment, reranker) in the existing collection settings panel. Provenance shows **provider + model** (Vertex and BYOK-Gemini share a model id). |
| 3 | Workflow surface | `ctx.knowledge` unchanged in shape; returns fused scores + `nativeScore`. `mode` arg already threaded (ADR 0113 P5). |
| 4 | Node pack | `feature.kb.nodes` 1.3.0: `search`/`rag` outputs gain `nativeScore` and `embedder` provenance. No new nodes. |
| 5 | AI chat + envelopes | None new. `openwop:knowledge.search` inherits D2/D4/D5. Grounding stays tool-mediated. |
| 6 | Agent pack | `vendor.openwop-app.kb.agents` unchanged; its prompt's description of retrieval modes is test-pinned (`promptCatalogParity`), so the mode list update rides that test. |
| 7 | Public surface | None. |
| 8 | RBAC | Unchanged: org-scoped vectors on every read path (ADR 0581), `contentTrust` fencing (0583), managed collections indexer-only (0643). The new `…/quality` route is `workspace:read`. |
| 9 | Replay / fork | Inside a run, retrieval output is recorded at the node boundary (`kb/surface.ts:7-8`, ADR 0351) and a forked run reads it verbatim. The `openwop:knowledge.search` chat tool and agent-knowledge composition run **live**: they are chat-turn state, not run state, so they are not replayed — stated here, not claimed as recorded. Default changes (D1, D5) affect new runs only. |
| 10 | Frontend | Collection settings: embedder provenance chip (local / BYOK / host), enrichment toggle with cost estimate, reranker select, "re-indexing N%" status (exists). |

## Implementation plan — one mergeable PR per phase

Each phase is an independently mergeable PR off `origin/main`, gated by `npm run ci`, citing
`ADR 0904 P<k>` in its commits, and adding a row to an implementation record in this ADR when it
lands. **Track 1 needs no new spend, vendor account or credential and is ordered first so it ships
regardless; Track 2 phases wait on the named Open decision.** Phases within one ADR that touch
the same large file (noted) merge serially, not in parallel. A pack version bump in any phase
needs the registry republish that `check-pack-version-bump` names.

### Track 1 — no new spend (ship in this order)

**P0 — retrieval eval + cross-collection fairness + model-text honesty.** (S–M, 3–4 d) · David: no.
- Owns: `backend/typescript/scripts/eval-kb-retrieval.mjs` + `package.json` script `eval:kb-retrieval`;
  `backend/typescript/test/fixtures/kb-eval/` (corpus + labelled queries, 4 locales);
  `features/kb/kbService.ts` (`tenantRetrieve` only — D4); `features/kb/routes.ts` (`GET …/quality`);
  `host/agentToolProvider.ts` (D11 tool text); `packs/vendor.myndhyve.knowledge-tools` untouched
  (parity only).
- Tests: `test/kb-cross-collection-fusion.test.ts` (red first: an irrelevant `hybrid+rerank` hit
  outranks an exact `dense` hit); `test/kb-relevance-score-parity.test.ts` (0–1 `relevanceScore`,
  vendor `scoreFloor` keeps working); `test/kb-eval-determinism.test.ts` (local-hash numbers
  byte-stable); `agent-prompt-tool-ids.test.ts` pin for D11; route test for `…/quality`
  (`workspace:read`, org IDOR).
- Toggle: none (defect fix; `kb` always-on).

**P1a — query-aware embeddings on existing BYOK providers.** (S–M, 2–3 d) · David: no.
- Owns: `providers/dispatch.ts` (`inputType` on Google/Cohere/OpenAI bodies);
  `host/headlessAi.ts` (pass-through); `features/kb/kbService.ts` (`VecCacheRow.embedVersion`,
  signature `q1` for Google only). Serial after P0 (same file).
- Tests: `test/kb-embed-input-type.test.ts` (wire body per provider); `test/kb-q1-reindex.test.ts`
  (red first: reindex after `q1` calls the provider for every Google chunk; Cohere/OpenAI
  collections keep their vectors and signature); existing `kb-hydrate-batching`,
  `kb-hybrid-retrieval` stay green.

**P1b — shared GCP ADC helper (ADR 0904 D12 / 0906).** (S, 1 d) · David: no.
- Owns: new `host/gcpAdc.ts` (from the caching fetcher in `host/certificationEvidence.ts`);
  callers `host/blob/gcsBlob.ts`, `host/certificationEvidence.ts`,
  `features/app-builder/deploy/adapter.ts`, `features/runtime-posture/liveRead.ts`.
- Tests: `test/gcp-adc-helper.test.ts` (cache until expiry, refresh, failure is typed);
  `test/gcp-adc-single-fetcher-ratchet.test.ts` (no other file fetches `metadata.google.internal`).
- Whichever of 0904-P1b / 0906-P0 merges first owns this; the other rebases onto it.

**P2 — structure-preserving in-process parsing.** (M, 3–4 d) · David: no.
- Owns: new `features/kb/parsers/{docx,pdfPages}.ts`; `features/kb/kbService.ts` (extractor
  dispatch, table-atomic + heading-split chunker, `CHUNKER_VERSION = 3`). Serial after P1a.
- Tests: `test/kb-parse-docx-structure.test.ts` (headings, tables, lists survive);
  `test/kb-parse-pdf-pages.test.ts` (real `pageNumber`); `test/kb-chunker-v3.test.ts`; eval re-run
  recorded in the PR.

**P3 — default `hybrid` (eval-gated) + persisted lexical index.** (M, 3–4 d) · David: no.
- Owns: `features/kb/kbService.ts` (`resolveRetrievalMode` default, only if the P0 eval shows hybrid
  ≥ dense on recall@5 and MRR — numbers in the PR); new `host/vector/pgLexical.ts` (`kb_lexical`
  side table, GIN, `ts_rank_cd` `simple`); `features/kb/lexicalIndex.ts` (size-trigger switch,
  default 5,000 chunks, env `OPENWOP_KB_LEXICAL_PERSIST_MIN_CHUNKS`).
- Tests: `test/kb-default-mode.test.ts`; `test/kb-pg-lexical.test.ts` (testcontainer lane; rank-set
  agreement with in-memory BM25 on the eval corpus); erasure/retention coverage for the side table
  added to `kb-erasure-retention.test.ts`.

**P4 — LLM contextual enrichment (BYOK-billed, opt-in per collection).** (M, 3 d) · David: no
(uses the tenant's own key; refused without one).
- Owns: new `features/kb/contextualEnrichment.ts`; `features/kb/kbService.ts` (signature
  `enrich:llm:<model>`, cache by `(chunk hash, doc hash, model)`); `features/kb/embedBudget.ts`
  (per-chunk metering); FE `frontend/react/src/features/kb/KbViews.tsx` + `i18n/*` (toggle with cost
  estimate, 4 locales).
- Tests: `test/kb-enrichment.test.ts` (refused without a model; cache hit on unchanged content;
  budget stop; BM25 sees raw + prefix); FE `__tests__` for the settings control.

### Track 2 — needs David (Open decisions 1–4)

**P5 — operator Vertex default embedder.** (M, 3–4 d) · David: **yes** — Vertex spend (Q1) +
`aiplatform` API + `roles/aiplatform.user` (Q4).
- Owns: new `features/kb/vertexEmbeddings.ts` (or `providers/vertexEmbeddings.ts` beside
  `dispatch.ts`); `host/headlessAi.ts` (resolver arm after BYOK, before local-hash; `anon:` excluded);
  `features/kb/embedBudget.ts` (boot refusal with cap 0; query-embed metering); 0351 correction note.
  Env `OPENWOP_KB_HOST_EMBEDDER` unset ⇒ zero behaviour change (merge-safe before David decides).
- Tests: `test/kb-host-embedder-resolution.test.ts` (spec > BYOK > host > local; `anon:` never host);
  `test/kb-host-embedder-boot-guard.test.ts`; `test/kb-vertex-fanout.test.ts` (one input per call,
  bounded pool, 429 backoff); ADC failure ⇒ labelled fallback, never a wrong-width vector.

**P6 — Document AI Layout Parser (operator opt-in).** (M, 4–5 d) · David: **yes** — spend + page cap
(Q2), `documentai` API + processor + role (Q4).
- Owns: new `features/kb/parsers/documentAi.ts` (`documentLayout` blocks; batch via GCS staging on
  the existing blob bucket, polled by the reindex drain); `features/kb/kbService.ts` (parser port);
  `features/kb/embedBudget.ts` (per-page metering). Env-off by default.
- Tests: `test/kb-docai-parser.test.ts` (fake processor: layout blocks → headings/tables; scanned PDF
  yields text; batch resumes after restart; budget stop; fallback to in-process on error).

**P7 — Vertex reranker arm.** (S, 2 d) · David: **yes** — ranking spend (Q3), `discoveryengine` API (Q4).
- Owns: new `features/kb/vertexReranker.ts`; `features/kb/kbService.ts` (`rerank.kind:'vertex'`);
  FE reranker select. Env `OPENWOP_KB_VERTEX_RERANK` off by default.
- Tests: `test/kb-vertex-rerank.test.ts` (degrade to local on error; recorded result replayed on a
  `mode:'replay'` fork with no network call).

**P8 — 768-dimension migration (conditional).** (M, 3–4 d) · David: **yes** — storage + re-embed
spend, and only if P0/P5 eval shows ≥ 2 pts recall@5. Otherwise this phase is closed as "no".

## Tests

Per-phase tests are named in the implementation plan above. Every phase lands red-first:
the failing test is committed before the fix, so each PR shows the defect and its closure.

## Open decisions for David

1. **Spend: operator embeddings.** Vertex `gemini-embedding-001` on the operator's bill for every
   tenant without BYOK. Order of magnitude: about $0.15 per 1M input tokens (verify on the live
   Vertex price page before enabling); a 1,000-page corpus is roughly 0.5M tokens. Enable on
   `openwop-dev` / a MyndHyve staging build, or BYOK-only?
2. **Spend: Document AI Layout Parser** — about $10 per 1,000 pages (Google pricing page,
   2026). Enable per deployment, and at what per-tenant daily page cap?
3. **Spend: Vertex ranking API** — roughly $1 per 1,000 queries (third-party aggregator figure;
   Google's page did not state it). Enable, or leave Cohere (BYOK) as the only provider reranker?
4. **GCP API enablement** on the target project (`aiplatform`, `documentai`, `discoveryengine`) and
   the runtime service account's roles (`roles/aiplatform.user`, `roles/documentai.apiUser`,
   `roles/discoveryengine.viewer`). An account/IAM action only David can take.

## Architect review (2026-10-17)

`/architect`, Track A (app architecture) + Track B check of the RFC verdict. An independent
adversarial reviewer re-read every cited file; every finding below was verified in code and is
**already folded into the decisions above**.

| # | Sev | Dimension | Finding | Resolution |
|---|---|---|---|---|
| A1 | CRITICAL | Data integrity | The provider-vector cache is valid on `model`+`textHash` only (`kbService.ts:606-611,983`), so the D2 `q1` reindex would reuse the old vectors and change nothing. | D2: `VecCacheRow.embedVersion`; red test that the reindex calls the provider for every chunk. |
| A2 | HIGH | Performance | Vertex `gemini-embedding-001` takes one input per request; existing batching assumes many. | D1: bounded fan-out pool + 429 backoff; budget counts calls. |
| A3 | HIGH | Failure modes / spend | Embed cap defaults to uncapped (`embedBudget.ts:18-21`) and query embeds are unmetered; enabling the host arm re-embeds the whole fleet. | D1 spend guard: boot refusal without a cap, query metering, `anon:` excluded, per-tenant rollout. |
| A4 | HIGH | Coupling | RRF scores would break `vendor.myndhyve.knowledge-tools` `scoreFloor` (`index.mjs:38-41`). | D4: order by RRF, keep a calibrated 0–1 `relevanceScore`; parity test. |
| A5 | MEDIUM | AI exchange | Tool text claims "lexical… no network" (`agentToolProvider.ts:242,251,350-367`). | D11: generated + test-pinned. |
| A6 | MEDIUM | Replay | The chat tool and agent composition are live, not recorded. | Matrix row 9 now states it. |
| A7 | MEDIUM | Over-reindex | Cohere documents already `search_document`. | D2: Cohere and OpenAI keep their vectors. |
| X1 | HIGH | Duplication | Four metadata-token fetchers already exist. | D12: extract one `host/gcpAdc.ts`, ratchet. |
| A8 | LOW | Accuracy | `resolveSpecEmbedder` is `resolveHeadlessEmbedderForSpec`; provenance needs the provider. | Fixed. |

**Boundaries:** one retrieval owner, one resolver, one reindex, one budget — no parallel system.
**RFC (Track B):** confirmed host-extension. `ctx.knowledge` keeps its shape (fields added, none
changed); nothing is advertised in `/.well-known/openwop`; no envelope or event.
**Verdict:** Accepted as a plan. A4 is designed into P0, A1 into P1a, A3 into P5 (before any operator spend).

## P3 recovery correction — shared lexical freshness (2026-10-25)

The original P3 branch and its two recovery prototypes are retained as merge
ancestry. Their process-local complete/dirty sets and upsert-only mirror were
insufficient: another replica could miss an ingest, and a paused rebuild could
restore deleted text. This corrects D9's publication mechanism, not the KB's
source owner or retrieval contract.

The existing Postgres pool owns the derived lexical table and its content-free
state rows. Before changing a durable document, the KB invalidates its stable
collection generation and records a bounded operation claim. Acknowledged
primary writes clear only their own claim. Uncertain operations leave the index
unavailable across restarts/replicas; reads use authoritative BM25. They do not
clear another caller's claim or certify an incomplete index.

A rebuild reads durable documents after taking its generation, then replaces
the complete namespace under the matching, non-pending SQL owner row. Empty
rebuilds delete stale rows too. Search readiness and ranked candidates share
one SQL snapshot. Bounded primary document reads validate every returned
chunk's identity, text, title and trust rather than accepting copied metadata.
SQL errors or stale candidates fall back to the existing BM25 channel.

Collection deletion retires the owner before purging active, staging and legacy
lexical namespaces. Document deletion invalidates before deleting every stored
chunk for the document, including old chunker tails. Tenant teardown retires a
content-free tenant row, waits for earlier publishers, then deletes content with
a fresh SQL snapshot. Opaque retirement rows remain to fence late publishers;
they retain no document text or subject attribution. Configured-index maintenance
continues after a vector-backend switch, matching the existing purge registry.

Architecture review: Track A; existing KB service/document primaries, adapter
runner, durable collection writer and tenant/namespace purge registry remain
the owners. No second pool, source document store, workflow, provider, public
endpoint or wire shape is added. New SQL and service race/lost-ack witnesses
are authored; focused checks, the real Postgres lane and canonical CI must pass
before this recovery is a release claim.

P3 ranking correction: the first real Postgres run passed all five structural
and concurrency cases but measured only 0.25 mean top-five overlap with BM25
(required ≥ 0.5). `ts_rank_cd` does not preserve inverse document frequency.
The derived index now stores term frequencies and corpus length totals with
the same generation-fenced publication, and SQL applies the existing BM25
formula (k1=1.5, b=.75), stable id tiebreak and existing score saturation. GIN
selects candidate rows and counts matching documents per term; raw corpus
text and aggregate corpus statistics are not reloaded on each query. This
corrects D9's ranker choice. Additive columns preserve any prototype data,
while a format stamp prevents old readiness from certifying missing statistics.
The original failed result and unchanged quality gate remain in recovery
evidence; the revised live lane must pass before release.

P3 validation checkpoint (2026-10-25): revised backend TypeScript and all 40
focused regression files / 294 cases pass on qualified-lead main `100756d50`.
The native Postgres fixture passes all 7 cases: full replacement/isolation,
cross-replica delete fencing, lost acknowledgements, collection retirement,
actual SQL lock contention during tenant teardown, additive prototype upgrade
and the unchanged 60-query ranking comparison (mean overlap ≥ 0.5). Fixture
shutdown is verified; peak owned memory 0.41 GiB with no swap growth. The first
failed 0.25 run remains retained. Canonical full CI is still required.

The two original recovery parity branches are preserved as merge ancestry.
Their only branch-local changes regenerated the parity fixture against stale
SLA/qualification source. The current main fixture has 302 asserted pairs and
0 `knownDrift`, and correctly classifies the repaired methods. Both history
merges retain that current fixture byte-for-byte; no old opaque-method
allowance or stale line inventory is restored.

## P4/P5 source recovery checkpoint (2026-10-25, not a release)

Original P4/P5 ancestry is retained in a separate integration branch. The P3
source generation/retirement fences and revised BM25 ranker are preserved.
The existing embedusage counter now has a pre-dispatch CAS reservation path;
unknown commit acknowledgements refuse provider dispatch and retain possible
spend. Hydrate, query, reindex and enrichment call sites use that path, with
real SQLite last-slot/lost-ack/malformed-output witnesses authored. Vertex
vectors additionally require finite numeric values before normalization.

These phases are NOT ready to merge: enrichment cache publication must move
under the live document's CAS so deletion/erasure cannot be followed by a late
raw prefix write. Cache identity must include provider, model and exact title
plus prompt document/chunk hashes. Operator embedding retries and non-KB
consumers also need the same counter at each actual paid transport attempt,
without double charging the outer KB batch. Do not enable the operator flag or
claim the daily cap is complete until those seams and tests are green. The
original default-off flags, positive-cap boot guard and tenant-BYOK boundary
remain intact. All new source and tests here are unvalidated.

P4/P5 budget repair checkpoint (source authored, not validated): the existing
KB daily counter now supplies a concrete admission callback to the shared host
embedder. Every actual Vertex transport attempt, including retries and non-KB
consumers, must reserve through that owner before dispatch. Outer KB batches
only preflight the host budget and do not charge it twice; BYOK embeddings and
enrichment reserve before their own calls. A missing callback refuses spending.
SQLite witnesses cover last-slot writers, lost acknowledgements, malformed
outputs, retry admission and a host embedder used outside KB. Finite vector
entries and overflow-safe normalization are required. These changes still need
types, focused tests and canonical CI; raw enrichment cache publication remains
a release blocker until it is fenced by the live document primary.


P4/P5 recovery correction (2026-10-25): the earlier raw-cache blocker is now
addressed in source. New prefixes live only on the document primary, under an
internal incarnation and exact-row CAS. Provider/model, title and prompt
content hashes define each immutable cached response. Late responses cannot
recreate a deleted document or cross an identical-id replacement; public
projections omit both internal fields. Dense-vector metadata omits raw prefixes.
The legacy independent cache is deletion-only. SQL lexical readiness now also
fences the resolved enrichment/chunker revision within a physical namespace.
This extends the existing primary and SQL index, without another store or queue.

Backend types and 44 focused files/323 cases pass, including real SQLite
last-slot contention, lost acknowledgements, deletion/erasure interleaves,
provider/title/org identity and non-KB host spending. Cancellation still forbids
vector/cursor publication, while a provider attempt already dispatched retains
its budget reservation. Canonical CI and frontend verification remain required;
no operator flag, IAM permission, API or production budget has been enabled.


P6/P7 source recovery checkpoint (2026-10-25, not validated): original parsing
and ranking ancestry is preserved alongside the P4/P5 repair. Each operator API
now reserves its existing daily usage row with expected-row CAS immediately
before dispatch. Unknown acknowledgements refuse the call and retain possible
spend; HTTP, timeout and malformed responses do not refund attempts. Anonymous
tenants cannot use these operator-funded arms. No new budget store or process
mutex is introduced. Ranking responses require unique input ids and finite
0–1 scores; layout page spans are bounded by the online page limit and actual
file count. PDF page-count probes release their parser document in `finally`.
SQLite concurrency/restart/failure witnesses are authored but not yet executed.
Both flags remain off, no API/IAM/spend is enabled, and the >15-page batch path
is still explicitly unimplemented. These changes are not release-qualified.


P7 control and replay review checkpoint (2026-10-25, unvalidated): the existing
retrieval-config PATCH and quality report now back a reranker selector, with
server-derived availability and the same optimistic/failure handling as the
other controls. Provider choices are absent unless available (an already-stored
unavailable choice remains visible but disabled). Copy is translated in all four
KB locales. Backend policy excludes anonymous operator-funded selections.

The prototype's statement that `role:action` makes KB reads replay recorded
outputs is incorrect: the executor consults the derived side-effect served set,
not the action role (see the ADR 0645 correction in `featureSurfaces.ts`). Search
can now perform contextual model and operator-ranking calls. A real HTTP
run/fork test is authored for both search and RAG, changing model identity after
the source run to make cache-only reasoning insufficient. This follow-up must
pass, with zero new provider attempts and identical recorded outputs, before the
recovered paid retrieval paths are deployed. No replay coverage is claimed yet.


Paid-retrieval replay correction (2026-10-25): real HTTP source/fork probes
failed for both KB search and RAG because the action reads re-executed after a
model change and returned different outputs. `feature.kb.nodes` 1.3.0 retains
the action role and adds the protocol's existing `side-effectful` capability to
these two nodes. The generated floor and served set now include both; no manual
classifier list or new replay store is added. The pack's schema ids and
reviewed content digest are regenerated. Both probes now pass with identical
recorded outputs, one live ranking call and two live enrichment calls, and zero
additional calls after the fork. List collections remains a current-state read.
Unclassified replay entry paths refuse headless paid reservations before even
mutating their counters, using the existing run-effect context/backstop.

P6/P7 backend types and 41 operator/PDF cases pass, including real SQLite
contention and uncertain-spend witnesses. The PDF cleanup initially exposed
unpdf typings that described a removed proxy method; the patched pdf.js source
owns cleanup at `document.loadingTask.destroy()`, which is now exercised by
successful scanned-PDF ingest and both fallback paths. Frontend and complete
canonical qualification of this follow-up remain pending. Both operator flags
remain disabled and the online parser still explicitly excludes batch parsing.


Provider-contract cross-check (2026-10-25): Google's
[ranking API documentation](https://docs.cloud.google.com/generative-ai-app-builder/docs/ranking)
states the 0–1 score range and still lists the prototype's pinned
`semantic-ranker-default-004` as supported; the recovery does not switch to a
moving model alias. The
[Document API reference](https://docs.cloud.google.com/document-ai/docs/reference/rest/v1/Document#LayoutPageSpan)
defines integer page spans. Unspecified/zero spans retain their text without
inventing a page citation; negative, fractional or out-of-limit spans refuse
the provider response. These are static contract checks, not live qualification.
