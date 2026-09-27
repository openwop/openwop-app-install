# ADR 0398 — KB ingestion depth: structural chunking, per-collection embedding-model pinning + reindex, media→KB bridge

| Field | Value |
|---|---|
| **Status** | implemented — all 3 phases landed (see §Implementation log) |
| **Date** | 2026-07-17 |
| **Feature** | extends **`kb`** (ADR 0011 → 0107 → 0113 → 0351 lineage) — toggle id stable, no new toggle |
| **Depends on** | ADR 0011 (KB/RAG), ADR 0351 (retrieval fidelity + provider embeddings), ADR 0007/0352 (Media), ADR 0106 (media cost governance), ADR 0148 (token-budgeted assembly), ADR 0110 (headless AI default) |
| **Closes (gap analysis)** | the *remaining* depth in `docs/steward/MYNDHYVE-GAP-ANALYSIS.md:53,337,340` — the "PDF/DOCX parse" + "learned embeddings" claims there are **STALE** (see correction below); the live deltas are per-collection model pinning, an honest reindex, and collections-as-KB |
| **RFC verdict** | **Host-ext, no new RFC.** The vector surface is already host-owned (`ctx.db.vector`, RFC 0018 §A); collections/parsing/embedding-selection/reindex are all feature-internal to the non-normative `/v1/host/openwop-app/kb/*` surface. No wire field, capability flag, or event type is added to the normative surface. |

---

## Context (boundaries audit first)

Per the `/architect` scope rule, the corpus was audited before claiming anything is
missing — and the two headline items the gap analysis names as gaps **already ship.**
This ADR corrects the record and scopes itself to what is genuinely open.

### What already exists (gap-analysis rows are stale)

- **Rich document parsing is DONE.** `kbService.extractTextFromBytes`
  (`features/kb/kbService.ts:1085-1147`) is the single extraction owner and already
  handles PDF (`unpdf`, :1104-1108), DOCX (`mammoth`, :1110-1113), PPTX/XLSX/ODT/ODP/ODS/RTF
  (`officeparser`, :1089-1102), image OCR (managed vision, flag-gated, :1118-1123), audio
  transcription (managed/BYOK, flag-gated + budgeted, :1124-1140), and URL ingest
  (`resolveSource`, :1212-1225). It is reached from the upload route, media-token ingest,
  and drive-sync — one owner, no second parser. So `docs/steward/MYNDHYVE-GAP-ANALYSIS.md:337` ("no
  PDF/DOCX parse") and the parse half of `:53` are **already closed** by the ADR 0111/0350
  lineage. The DOCX parser choice the task asked us to reuse (`mammoth`, per
  `documents/render.ts`) is the one already wired here.
- **Learned (provider) embeddings are DONE.** `resolveHeadlessEmbedder`
  (`host/headlessAi.ts:184-208`) resolves a tenant's BYOK default to a real embeddings
  API via `dispatchEmbeddings` (`providers/dispatch.ts:1223`; `EMBEDDINGS_PROVIDERS =
  ['openai','google']`, `:1221`). A collection pins `retrievalConfig.embedder:
  'local'|'provider'` (`kbService.ts:127-133`); `hydrate` (`:399-481`) batch-embeds only
  cache misses into the durable `kb:veccache` (`:234-235`), stamps a `vectorSignature`
  (`:105-112`), **wipes + rebuilds on signature mismatch** (`:410-416`, `:432-435`), and
  degrades **honestly to lexical-only** when no embedder resolves (`:423-426`,
  `:820-830`). The deterministic `local-hash` embedder (`embedText`) is the zero-config
  floor. So `:337` ("hash embeddings (not learned)") and the embeddings half of `:53` are
  **already closed** by ADR 0351 Phase 1.

### What is genuinely open (this ADR's scope)

Three depth deltas remain once the stale rows are set aside:

1. **Chunking is not structure-aware.** `chunkText` (`kbService.ts:282-306`) is a
   char-window splitter that *prefers* a paragraph/sentence boundary near the window
   edge, but it does not respect document structure: a heading and its section can split
   across chunks, and a heading can be orphaned at a window tail. The heading context
   exists only as an *enrichment prefix* on the embedded text (`enrichChunkText`,
   `:151-157`), not as a split boundary. MyndHyve's ingestion chunked on heading
   structure; that fidelity is the open half of the "doc-parsing" gap.
2. **Embedding selection is tenant-wide and provider-only.** `embedder: 'provider'`
   resolves to the tenant's **one** headless default (`getHeadlessAiDefault`), so every
   provider-mode collection shares a single model, there is **no per-collection model
   pin**, and **Cohere is absent** (`EMBEDDINGS_PROVIDERS` omits it). Two collections
   cannot sit in different embedding spaces, and switching a tenant's default silently
   invalidates every provider-mode collection at once.
3. **Reindex is a hidden synchronous rebuild with no progress and no cost cap.** Switching
   `embedder` (or model, or `dims`, or `enrichment`) changes the `vectorSignature`; the
   *next search* pays for a full wipe-and-re-embed of the whole collection inline in
   `hydrate` (`:432-477`) — a 1000-doc collection re-embeds thousands of chunks in one
   blocking request, **unbudgeted** (`mediaBudget` covers `tts`/`stt` only,
   `aiProviders/mediaBudget.ts:22`; embeddings have no cap), with no visible progress and
   a cold-search latency cliff. There is no cost estimate before committing, no dual-read
   window, and no background job. This is the hard part the task names.
4. **Collections-as-KB is MISSING.** Media collections (`media:collection`,
   `features/media/mediaService.ts:19-27`) are plain groupings with **no KB linkage**
   (`docs/steward/MYNDHYVE-GAP-ANALYSIS.md:340`, an `S` item). There is no way to mark a media
   collection as a knowledge source and have its documents parsed (through the extractor
   above) into a KB collection.

### Boundary ownership (unchanged, restated)

- **`kb` owns** collections, chunks, retrieval, embedding selection, and now the reindex
  job + the bridge *consumer* side. It composes `ctx.db.vector` for storage/similarity
  (never a parallel store) and the aiProviders seam for embeddings.
- **`media` owns** blobs + media collections. The bridge is a **kb→media read**: kb lists
  a media collection's assets and resolves their bytes through the existing media
  boundary (a doc references a media token; bytes are not re-stored — the ADR 0011
  media-boundary rule). Media does **not** learn about KB (no reverse dependency, the
  submission-sink lesson of ADR 0330).
- **`providers` owns** model dispatch (`dispatchEmbeddings`). kb requests embeddings; it
  never talks to a vendor SDK directly.
- **Parsing stays in-process.** New parsers are **not** introduced — the extractor
  already covers PDF/DOCX/Office. The gap-analysis "SKIP new Cloud Run services" line
  holds: in-process is justified by (i) the extractor already lives here, (ii) the
  decoded-byte caps (`MAX_UPLOAD_DECODED_BYTES = 32 MiB`, `kbService.ts:1045`) that bound
  a per-request parse, and (iii) per-request isolation (a zip-bomb OOMs its own request,
  never the store, `:1041-1044`). A separate ingestion service would buy nothing the caps
  don't already give and would add an operator surface the reference host avoids.

## Decision

Extend `kb` (no new toggle) along four axes. Every model-facing failure is a **typed
error, never success-with-empty** (the LLM-EXCHANGE rule) — an unparseable file 422s, an
embedder that can't resolve degrades to a *labeled* lexical mode, and a reindex that
exceeds its cost cap **stops and reports**, it does not half-embed silently.

### 1. Structural, heading-aware chunking (upgrade, replay-safe)

Replace the char-window splitter with a **structure-first** chunker that remains
**deterministic** (same text → same chunks, so hydrate/re-chunk still matches ingest —
the invariant `chunkText` protects at `:280-281`):

- **Segment on markdown/heading structure first.** Split the document into sections at
  `^#{1,6}` headings (and, for extracted Office/PDF text, on the blank-line-delimited
  block runs the extractors already emit). Each section carries its heading path.
- **Then pack sections into token-ish windows** (`chunkChars` = 1200, `chunkOverlap` =
  150 unchanged) — a section shorter than the window becomes one chunk; a section longer
  than the window is sub-split at paragraph/sentence boundaries (today's logic, reused),
  never orphaning its heading. Overlap is applied *within* a section, not across heading
  boundaries, so a chunk never straddles two unrelated sections.
- **Heading path becomes intrinsic**, not just an enrichment prefix: each `ChunkRow`
  gains `headingPath: string[]` in metadata, populated from the structural walk (this
  also fills the `KnowledgeResult.headingPath` that `tenantRetrieve` currently hardcodes
  to `[]`, `:960`, and improves citation display). `enrichment: 'heading-path'` still
  controls whether the path is *prepended to the embedded text*; the structural split is
  unconditional.
- **Versioning:** the chunker's identity is folded into the `vectorSignature` as a
  `chunkerVersion` component (`local:<model>:<dims>:<enrich>:<chunkerV>`), so upgrading
  the chunker on an already-indexed collection is caught as a signature mismatch and
  drives a reindex (§3) rather than silently mixing chunk shapes. Existing collections
  read back with `chunkerV=1` (today's splitter) and are re-chunked lazily/by reindex.

### 2. Per-collection embedding spec + Cohere

Replace the coarse `embedder: 'local'|'provider'` with an explicit **per-collection
embedding spec** (additive; the old field reads forward):

```
embeddingSpec?: {
  provider: 'local' | 'openai' | 'google' | 'cohere';
  model?: string;      // provider-specific; defaults per provider
  dims?: number;       // requested width (Matryoshka truncation), else the deployment default
}
```

- `provider: 'local'` = today's deterministic hash floor (zero-config). A learned
  provider pins **that collection's** model independent of the tenant's headless default
  and of other collections — different collections can occupy different embedding spaces.
- **Cohere is added** to `EMBEDDINGS_PROVIDERS` and `dispatchEmbeddings`
  (`embed-english-v3.0` / `embed-multilingual-v3.0`), same BYOK credential rules and
  L2-normalization as openai/google. `resolveHeadlessEmbedder` gains a spec-aware form
  that honors the collection's pin (falling back to the tenant default only when the spec
  says `provider` generically).
- **The key rule embeddings from different models are incomparable is made structural:**
  a namespace only ever holds vectors from *one* `embeddingSpec`, enforced by the
  `vectorSignature` (which already carries `provider:model:dims`, now also `chunkerV`).
  Changing the spec does not overwrite in place — it triggers a **reindex** (§3).
- **Validation** at config time: an unknown provider/model 400s; selecting a learned
  provider with no resolvable BYOK key is accepted but the collection **reports
  `denseAvailable:false` / lexical-only** on search until a key exists (honest-degrade,
  matching today's `:423-426`), never a silent wrong-vector fallback.

### 3. Versioned reindex machinery (the hard part)

Make the today-implicit "wipe on signature change in the next search" into an **explicit,
observable, budgeted job**. Design:

- **Versioned embedding spaces.** The `vectorSignature` is the space identity (already
  the seed). A reindex targets a *new* signature; the collection tracks
  `activeSignature` (serving reads) and, during a migration, `pendingSignature` (being
  built). This is the versioning the task calls for — no schema churn, the signature
  string is the version.
- **Background build, not inline hydrate.** A new admin-gated op
  `POST …/collections/:collectionId/reindex { embeddingSpec?, enrichment? }` enqueues a
  reindex job (a `DurableCollection<ReindexJob>` row: `{collectionId, fromSig, toSig,
  totalChunks, embeddedChunks, status: 'estimating'|'running'|'paused'|'done'|'failed'|
  'cancelled', costEstimate, costSpent, error?, startedAt, updatedAt}`). The job embeds in
  batches on a background tick (the ADR 0313 heartbeat/work-loop seam or an explicit
  drain endpoint on hosts with the loop off), writing new-signature vectors into a
  **staging namespace** (`${collectionId}#${toSig}`) so the active space is untouched.
- **Progress.** `GET …/collections/:collectionId/reindex` returns
  `{status, embeddedChunks, totalChunks, costEstimate, costSpent}` → the FE renders a
  determinate progress bar + cost meter. Progress is `embeddedChunks/totalChunks`.
- **Cost estimate + cap (ADR 0106/0148 precedent).** Before running, the job estimates
  cost from `totalChunks × avgTokensPerChunk × model-rate` and records `costEstimate`. A
  new **`embed` budget kind** is added to `mediaBudget` (`MediaKind` gains `'embed'`,
  measured in tokens) with a per-tenant daily cap (`OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY`)
  — `checkMediaBudget('embed', …)` is called **before each batch**; hitting the cap
  **pauses** the job (`status:'paused'`) with an honest reason rather than half-embedding
  and lying about coverage. Resumes next window / next day. A per-reindex hard ceiling
  (`OPENWOP_KB_REINDEX_MAX_CHUNKS`) refuses estimation-time-obvious runaways with a 4xx.
- **Cutover, with a dual-read window.** When the staging namespace is complete, cutover
  is atomic: set `activeSignature = toSig`, point reads at the staged namespace, delete
  the old namespace + stale `kb:veccache` rows. **During the build**, reads continue to
  serve the *old* space (no downtime, no half-migrated results). We choose **hard cutover
  after a fully-built staging space** over live dual-scoring both spaces per query:
  cross-space score fusion is meaningless (incomparable spaces — the very invariant we're
  protecting), so "dual-read" here means *old space serves until new space is whole*, not
  *both scored at once*. Recorded as a deliberate trade-off (see Alternatives).
- **Idempotency + replay.** The job is keyed by `(collectionId, toSig)` and driven by
  content hash (`kb:veccache` already keys `${tenantId}:${documentId}:${chunkIndex}` on
  `textHash`), so a re-run resumes rather than double-billing; a crash mid-build leaves
  the active space intact and the job resumable. Reindex is a **service op, never a
  recorded workflow node** (live provider embedding is replay-unsafe — the same boundary
  as `hydrate`'s provider path today, `:460-476`).

### 4. Media-collection → KB bridge

A kb-side op to mark a media collection as a knowledge source and ingest its documents:

- `POST …/collections/:collectionId/ingest-media-collection { mediaCollectionId }`
  (`workspace:write`) — kb lists the media collection's assets
  (`mediaService.listCollection`, tenant/org-checked), and for each asset with an
  extractable MIME calls the **existing** `resolveSource`/`extractTextFromBytes` path via
  a stable `documentId = 'media:' + assetId` (so re-running is an idempotent `upsertDocument`
  — no orphan/duplicate docs, the ADR 0100 stable-id pattern already in `kbService`).
- **Content-trust:** media-sourced docs are fenced `untrusted` (already the rule for
  `source.kind !== 'text'`, `:672`) — extracted file content is never human-reviewed.
- **Non-extractable assets** (images/audio without OCR/transcription enabled, archives)
  are **skipped with a per-asset reason** in the response summary
  (`{ingested, skipped: [{assetId, reason}]}`) — a typed, itemized result, never a silent
  drop. This is a one-shot ingest (a snapshot), **not** a live subscription; keeping the
  KB in sync as the media collection changes is an open question (below), consistent with
  the `S` sizing.
- **No reverse dependency:** media exposes only its existing read API; the bridge lives
  entirely in `kb`.

## Full matrix

| # | Axis | Decision |
|---|---|---|
| 1 | **Feature-package / toggle** | Extends `kb` — **toggle id stable**, no new toggle. All new ops under the existing `/v1/host/openwop-app/kb/*` surface + `ctx.features.kb`. |
| 2 | **ctx surface ops** | Existing `search`/`rag`/`retrieve` **unchanged** (signatures + outputs stable; `headingPath` now populated instead of `[]`). New ops are **not** on the run-facing `ctx` surface (reindex + media-bridge are service/admin paths, replay-unsafe). |
| 3 | **Node pack** | `feature.kb.nodes` version bump only if the `kb.search`/`kb.rag` node *inputs/outputs* change — they do not (chunking/embedding are internal; citations gain `headingPath`, additive). **No new node** for reindex/bridge (service ops, not run steps). |
| 4 | **Envelopes** | **None.** No RFC 0021 envelope kind/field — embeddings are model-facing but **not prompt-facing** (they never reach a model as schema/text), so no schema.request surface and **no LLM-EXCHANGE tracker row** is needed (embedding vectors aren't a model↔app *conversation*; the retrieval *chunks* that do reach a model are already tracked under the `kb`/RAG rows). |
| 5 | **Agent pack** | **None.** No new persona; the `feature.kb.agents` pack is untouched. |
| 6 | **Public surface** | **None.** No unauthenticated route. |
| 7 | **RBAC** | Read/search `workspace:read`; ingest/manage/media-bridge `workspace:write`; **reindex = admin** (`workspace:admin`) — it spends provider budget and rewrites a whole namespace, so it sits above ordinary write, matching the cost-governance posture of ADR 0106. Embedding-spec change that *implies* a reindex is admin-gated for the same reason. |
| 8 | **Replay/fork** | Ingestion is **idempotent by content hash** (`kb:veccache` textHash keying; stable `documentId` on media-bridge + drive-sync). Reindex + provider embedding are **service ops, never recorded nodes** (live provider calls are non-deterministic on `:fork` — the established `hydrate`/`mediaToTextViaLLM` boundary). Local-hash + structural chunking are deterministic, so re-derivation on hydrate reproduces identical vectors. |
| 9 | **Data model** | Additive: `KnowledgeCollection.embeddingSpec?`, `activeSignature?`, `pendingSignature?`; `ChunkRow.metadata.headingPath`; new `DurableCollection<ReindexJob>` (`kb:reindex`, tenant-scoped key). New `mediaBudget` kind `'embed'`. No SQL migration (KV blob), matching the ADR 0383 pattern. Existing rows read forward (absent spec ⇒ `local`; absent signature components ⇒ v1 defaults). |
| 10 | **Frontend** | Collection settings gains: an **embedding-model select** (provider + model, with a "changing this reindexes N chunks (~$X)" confirm), a **reindex progress bar + cost meter** (polls the reindex GET), and a **per-document parse-status/source badge** (parsed / untrusted / skipped-reason). Media-collection picker on the "add source" flow. All via existing `ui/` primitives; the canonical `npm run build` gate must pass (4-locale i18n parity is fatal). |

## Phased plan

| Phase | Ships | Closes |
|---|---|---|
| **1 — Structural chunking** | Heading-aware deterministic chunker + intrinsic `headingPath` metadata + `chunkerVersion` in the signature; populate `KnowledgeResult.headingPath`. Reindex of existing collections deferred to Phase 3's machinery (lazy re-chunk in the meantime). | parse-depth half of `:53`/`:337` |
| **2 — Media→KB bridge** | `ingest-media-collection` op (stable-id, untrusted-fenced, itemized skip report) + FE media-source picker. | `:340` (collections-as-KB, `S`) |
| **3 — Per-collection embedding spec + reindex machinery** | `embeddingSpec` (per-collection provider+model pin) + Cohere in `dispatchEmbeddings`; the versioned reindex job (staging namespace, background build, progress, `embed` budget kind + cost estimate/cap, hard cutover with old-space-serves dual-read window) + admin route + FE progress/cost UI. | embeddings-depth of `:53`/`:337`; the hard reindex story |

Rationale for ordering: chunking (Phase 1) is the foundation both embeddings and the
bridge sit on (re-embedding under a better chunker is wasted if done first); the bridge
(Phase 2) exercises the parse path at volume before we attach the costly reindex; the
embedding pin + reindex (Phase 3) is the largest surface and benefits from the earlier
two being stable.

## Alternatives weighed

1. **External ingestion service (unstructured.io / a dedicated parse Cloud Run).**
   Rejected. The in-process extractor already covers PDF/DOCX/Office with byte caps + per-
   request isolation; a service adds an operator surface, egress/secret plumbing, and a
   network hop for zero fidelity gain at reference-host scale. The gap analysis explicitly
   scoped out new Cloud Run services. Revisit only if a format the in-process libs can't
   handle (e.g. complex scanned-PDF layout) becomes a hard requirement.
2. **Document-AI-style cloud parser (Google Document AI / Textract) for layout + OCR.**
   Deferred, not rejected. Scanned-PDF OCR + table-structure extraction is a real fidelity
   ceiling on the in-process path, but it is a *new provider integration with its own cost
   governance* — out of scope here; the image-OCR flag (`OPENWOP_KB_OCR_ENABLED`) already
   covers image files, and scanned-PDF OCR is an open question below.
3. **Embedding switch without a reindex path (config-only, like today's lazy hydrate).**
   Rejected as the *product* answer. The lazy rebuild is fine for small collections but is
   the exact defect for large ones: an unbudgeted, invisible, blocking re-embed on the next
   search. Honest per-collection model pinning *requires* an observable, budgeted, non-
   blocking migration — that is the point of Phase 3.
4. **Live dual-space scoring during migration (score old + new space per query, fuse).**
   Rejected. The invariant we are protecting is that vectors from different models are
   incomparable — fusing their scores is exactly the mistake. "Dual-read" is therefore
   *old space serves reads until the new space is fully built*, then atomic cutover — never
   two spaces scored against one query.

## Open questions

- [ ] **Scanned-PDF / image-heavy PDF OCR.** In-process `unpdf` extracts the text layer;
  a scanned PDF has none. Defer to a Document-AI-style integration (alt. 2) or route such
  PDFs through the existing image-OCR path page-by-page? Deferred — flag if it bites.
- [ ] **Multilingual embeddings × the 4-locale product.** Cohere `embed-multilingual-v3.0`
  and `gemini-embedding-001` are multilingual; the local-hash floor is language-agnostic
  (character features). Should a non-en collection default to a multilingual model, and
  does the FE surface that? For now the pin is explicit; no per-locale auto-selection.
- [ ] **Live media-collection sync.** The bridge is a one-shot snapshot. A subscription
  (media asset added/removed → KB re-ingest/delete) would ride the media lifecycle-event
  seam if one exists — sized separately, consistent with the `S` estimate.
- [ ] **Reindex drain on loop-off hosts.** When the ADR 0313 work-loop is pinned off, the
  reindex needs an explicit admin drain endpoint (documented) rather than a heartbeat tick.

## Implementation log

| Phase | Status | Where | Notes |
|---|---|---|---|
| 1 — Structural chunking | ✅ landed | `kbService.ts` — `chunkStructured` (the ONE chunker: `splitIntoSections` + `windowSplit`), `chunkText` wraps it, `ChunkRow.metadata.headingPath` + `SearchHit.headingPath` plumbed through both search channels into `tenantRetrieve`, `enrichWithPath` (intrinsic-path enrichment), `CHUNKER_VERSION` folded into the `vectorSignature`, `staleWipeIds` + `reconcileChunkCounts` | **Architect fixes folded in:** (CRITICAL) the hydrate wipe deletes the UNION of old (`doc.chunkCount`) + new chunk ids so a chunker change that shrinks the count can't orphan the old tail (the vector surface has no namespace-clear); `doc.chunkCount`/`col.chunkCount` reconciled + persisted so the invariant holds across successive reindexes. (HIGH) the enrichment prefix now consumes the chunk's INTRINSIC `headingPath` — one derivation, so display-path == embed-path and the fragile `indexOf(chunk)` is gone. Existing collections read `v1` and re-chunk lazily on next hydrate (the chunkerV signature mismatch drives the existing wipe+rebuild). Tests: `kb-structural-chunking.test.ts` (determinism, nesting, no-orphan, CRLF, heading-less, sub-split, end-to-end headingPath). |
| 2 — Media→KB bridge | ✅ landed | `kbService.ts` (`ingestMediaCollection` + widened `upsertDocument` input), `routes.ts` (`POST …/ingest-media-collection`, workspace:write + `assertNotManaged`), FE `KnowledgeBasePage` media-collection picker + `kbClient.ingestMediaCollection` + i18n×4 | **Architect fix:** the bridge uses `upsertDocument` (stable-id `media:<assetId>`, delete-prior+re-ingest) NOT `ingestDocument` — the latter unconditionally bumps `documentCount`/`chunkCount`, so a re-run would double-count (verified idempotent: re-run keeps documentCount=2). Reuses the existing media-ingest path via `asset.serveToken` so the extractor stays the ONE MIME authority (no second table); a per-asset extraction failure is an itemized `{assetId, name, reason}` skip (typed, never silent); unexpected errors surface. Untrusted-fenced automatically (source.kind='media'). kb→media READ only (imports `listAssets`/`getCollection`; media never imports kb — no cycle). Tests: `kb-media-bridge.test.ts` (ingest+skip, idempotency, 404). |
| 3 — Embedding spec + reindex | ✅ landed | `kbService.ts` (`EmbeddingSpec` + `collectionNamespace` routing of all 8 vector-op sites + versioned reindex: `startReindex`/`drainReindex`/`cancelReindex`/`getReindexJob`), `providers/dispatch.ts` (Cohere `/v1/embed`), `host/headlessAi.ts` (`resolveHeadlessEmbedderForSpec` + Cohere model), `features/kb/embedBudget.ts` (daily token counter), `routes.ts` (admin `POST/GET …/reindex[/drain,/cancel]`), FE `ReindexPanel` + client + i18n×4 | **Design (architect-validated):** the collection's `embeddingSpec` flips only at CUTOVER, so `hydrate` keeps serving the old namespace with no special-casing; the reindex builds the target signature in a STAGING namespace (`${collectionId}#${toSig}`), then flips `activeSignature` atomically (reads move to the fully-built staged space) and GCs the old namespace — fail-closed. `collectionNamespace(col)` is a no-op (`= collectionId`) for every existing collection (backward-compatible; only reindexed ones version). The `embed` budget is a **kb-owned KV daily counter, NOT a `media_usage` SQL column** (a correction to the ADR's "add an `embed` kind to mediaBudget" — that store's tts/stt columns are SQL-hardcoded, and a 2-adapter migration violates the KB migration-free rule). The budget PAUSES the job on cap (never half-embeds-and-lies — the old space keeps serving until 100%). Reindex is admin-gated via **`host:org:manage`** (the ADR's `workspace:admin` does not exist). Cohere v3 needs `input_type` + client-side truncate/renormalize (no native `dimensions`). **Deferred (OQ):** per-collection `dims` is forward-compat only (the vector-store fixed width wins); Cohere query-vs-doc `input_type` uses `search_document` uniformly. Tests: `kb-reindex.test.ts` (cutover, resume, budget-pause, cancel, ceiling, already-active). |

---

### Review-pass hardening (2026-07-17, post-implementation `/code-review` + `/grade-data`)

Both reviews converged on one ship-blocking data-integrity issue + several storage-leak fixes, all applied:

- **CRITICAL — no concurrent document mutation during a reindex build.** A concurrent `ingest`/`delete`/`upsert` lands only in the ACTIVE namespace, so the staging build (a one-pass resume cursor) would resurrect a deleted doc, miss an added one, or skew its cursor (a removed doc could even trigger a premature cutover onto an incomplete space). Fix: `assertNoLiveReindex` rejects document writes with **409** while a job is `running`/`paused` (a reindex is admin-triggered and drains fast; managed collections can't reindex, so their indexers never hit it). Test-pinned.
- **Cutover / cancel / deleteCollection GC now use `staleWipeIds`** (union of durable `doc.chunkCount` + current count) so a chunker-count skew can't orphan the old tail; `deleteCollection` also GCs the in-flight **staging** namespace (else it leaked permanently on pgvector).
- **Legacy pre-0351 rows** (no `vectorSignature`) now take the wipe+reconcile path on the v1→v2 re-chunk (the `changed` guard no longer requires a truthy signature) — a signature-less row's stale v1 tail no longer serves on pgvector.
- **`kb:embedusage`** prunes a tenant's older daily rows on write (only today's counter is read) — no unbounded accretion.
- **Cohere dispatch fails closed** when the model's native width < the namespace width (never pad a short vector into a fixed-width store).
- **Enrichment baked into the reindex job** (`job.enrich`) so a mid-build config change can't embed with a different enrichment than `toSig` assumes.

## RFC verdict

**Host-ext, no new RFC.** The vector surface is already host-owned (`ctx.db.vector`, the
RFC 0018 §A normative surface) and this ADR adds nothing to the normative wire: no run-
event field, capability flag, event type, endpoint contract, or `MUST`. Parsing, embedding
selection, the reindex job, and the media bridge are all internal to the non-normative
`/v1/host/openwop-app/kb/*` surface + `ctx.features.kb`. Cohere embeddings extend an
existing internal provider-dispatch map, not the advertised capability vocabulary.
