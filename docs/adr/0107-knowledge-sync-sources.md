# ADR 0107 — Knowledge sync sources (scheduled diff-sync of external drives → KB)

**Status:** implemented (2026-06-22) — **all phases complete; one-way Google Drive + OneDrive + SharePoint + Dropbox + Box folder→KB sync, scheduled.** Phase 1 `listFolder` (Drive #649 + OneDrive #655), Phase 2 feature-package CRUD (#650), Phase 3 pure diff (#651) + `knowledgeSyncRunner` orchestration + 'Sync now' (#652), Phase 3b the cadence daemon (`knowledgeSyncDaemon.ts` — #656: polls active sources, runs `syncNow` when due, per-source `claimIdempotency` lease for multi-instance safety), Phase 4 built-in `google` provider + `microsoft-graph` Files.Read (#654/#655), Phase 5 the KB-collection 'Add sync' UI (#653), Phase 6 OneDrive via Graph (#655). **Architectural correction (Phase 3b):** the ADR proposed riding ADR-0025's scheduler, but that fires *workflows* (a feature-service node = a signed node pack, the podcasts/insights precedent — disproportionate); Phase 3b is instead a focused cadence daemon in the feature package (the `heartbeat`/`refreshDaemon` class — NOT a parallel job system). Known limits (follow-ons): 'Sync now' runs inline at the 1000-file cap (a prod host enqueues a run); Google Drive binary sync ingests all extractor-supported types (PDF/Office/ODF via the bytes path → extractTextFromBytes, 2026-06-23); OneDrive/SharePoint binary ingests too (2026-06-23) via @microsoft.graph.downloadUrl fetched un-credentialed through the existing webhookEgressGuard SSRF guard — private-IP block + the pinned dispatcher re-validates each redirect hop, https-only, 32MB cap; the UI accepts a pasted Google Drive folder URL (server normalizes via `extractDriveFolderId` → bare id, reject-on-unparseable; OneDrive keeps the raw item id) — implemented 2026-06-22; a richer folder *browser* picker remains a follow-on.
**Date:** 2026-06-22
**Toggle:** `knowledge-sync` · default **OFF** · `bucketUnit: tenant` (a B2B data-pipeline surface). The sync *plumbing* is feature-gated; an individual sync still requires a live Connection + write access to the target collection.
**Surface:** host-extension `/v1/host/openwop-app/knowledge-sync/*` (non-normative) — a `SyncSource` config entity + a scheduled diff-sync **executor run**; the **"Add sync" UI** lives in the KB / project **Sources** surface. No new wire contract.
**Depends on / composes (all Accepted/implemented — this is assembly, not new infra):**
- **ADR 0024 (Connections / credential broker)** — OAuth + secret broker (`connectionsService`, `oauthFlow`, `refreshDaemon`); provider packs incl. **microsoft365** (OneDrive). Google needs a connection pack. **No new credential store.**
- **ADR 0038 (`knowledgeSourceFetch`)** — already fetches a **Google Drive** doc → `{title,text}` → `kbService.ingestDocument`. Extended here with **folder listing** + a **OneDrive** fetch path. **No new fetch seam.**
- **ADR 0025 (schedules) / the scheduler daemon** — the heartbeat. A sync is a **scheduled executor run**, NOT a new job queue. **No new job runner.**
- **ADR 0034 / RFC 0099 (external-event trigger ingestion)** — the precedent for "external content → KB", incl. the `trigger-ingestion-ssrf` + content-redaction invariants this reuses.
- **ADR 0027 (connected-content-source trust)** — synced content is **untrusted** (fenced at dispatch), exactly like every external source.
- **KB ingest (ADR 0011) + the file-upload extraction (this same change set)** — `ingestDocument({contentBase64,contentType})` extracts text/PDF/DOCX; sync reuses it verbatim. **Stable `documentId`** makes re-ingest a deterministic delete+re-ingest (the diff primitive, ADR 0100).
- **RFC 0076 (SSRF-guarded egress)** — every provider fetch rides the host-mediated guard.

**RFC verdict:** **host assembly over Accepted RFCs (0046 credentials, 0099 ingestion, 0076 egress) + implemented ADRs — NO new RFC.** Folder-listing + diff are host-internal connector ops; nothing touches the openwop wire. (If a future need wants a *normative* "sync source" capability advertised cross-host, that earns an RFC then — not now.)

> **Origin.** Requested: an **"add sync" list** — bind a Google Drive / OneDrive folder to a knowledge base; a heartbeat/scheduled task diffs the external folder and syncs new/changed files into the KB. The boundaries audit (below) shows this is ~90% existing seams.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a Drive-sync service with its own poller, OAuth, fetch, and ingest." Every one of those already has a single owner here; re-implementing any is the `no-parallel-architecture` violation.

| Concern | Existing owner (file) | How sync reuses it |
|---|---|---|
| External-account auth | Connections (`features/connections/*`, ADR 0024) — OAuth + refresh daemon | The `SyncSource` references a `connectionId`; the fetch resolves the live credential via `resolveConnectionCredential`. No token handling in the sync code. |
| Fetch a Drive file → text | `host/knowledgeSourceFetch.ts` (ADR 0038) — Google Drive doc → `{title,text}` | Extended with `listFolder(connection, folderId)` + a OneDrive (`microsoft365`) fetch case. |
| The poller / heartbeat | The scheduler daemon (ADR 0025) | A `SyncSource` owns a schedule; each tick **enqueues a `knowledge-sync.run` executor run** for due sources. NOT a new queue. |
| Run state / retry / cancel | The executor run model | The sync run is a normal run — status, retry, replay all ride it. |
| Binary → text | `kbService` extraction (text/PDF/DOCX, this change set) | The sync run calls `ingestDocument({contentBase64,contentType})` — identical to a manual upload. |
| Diff / idempotent re-ingest | KB stable `documentId` (ADR 0100) | `documentId = \`sync:<sourceId>:<externalFileId>\`` → a changed file re-ingests deterministically (delete+re-ingest); a removed file → delete that doc. |
| Trust marking | ADR 0027 | Synced docs are `contentTrust:'untrusted'` (fenced at dispatch). |

**Net new (small):** one `SyncSource` config entity + per-source diff state, the `knowledge-sync.run` workflow + its REST routes, `listFolder` + OneDrive fetch in `knowledgeSourceFetch`, and the "Add sync" UI in the Sources surface.

---

## Decision

Ship a **`knowledge-sync` feature-package** that binds an external-drive **folder** (via a Connection) to a **target KB collection** (a project's Sources collection, or any KB collection), and a **scheduled executor run** that diffs the folder against per-source state and syncs changes into the KB through the existing ingest+extraction path. Content is untrusted; egress is SSRF-guarded; the run is the state machine.

### Data model — one config entity + per-file diff state

```
SyncSource                          // org-scoped config
  { id, tenantId, orgId,
    connectionId,                   // → ADR 0024 Connection (provider: google | microsoft365)
    provider,                       // 'google' | 'microsoft365' (OneDrive)
    externalFolderId,               // the Drive/OneDrive folder to watch
    collectionId,                   // target KB collection (a project's Sources collection or any KB col)
    cadence,                        // schedule (ADR 0025) — e.g. every 15m / hourly / daily
    status,                         // active | paused | error
    lastSyncedAt?, lastError?,
    runId? }                        // the most recent sync run

SyncFileState                       // per (sourceId, externalFileId) — the diff cursor
  { sourceId, externalFileId,
    documentId,                     // the KB doc id this file maps to (`sync:<sourceId>:<fileId>`)
    revision }                      // etag / modifiedTime last ingested
```

### The sync run (NOT sync)

`knowledge-sync.run` (executor run, ADR 0025-scheduled or manual "Sync now"):
1. **list** — `knowledgeSourceFetch.listFolder(connection, externalFolderId)` → `[{fileId, name, mimeType, revision}]` (paginated, capped).
2. **diff** — vs `SyncFileState`: NEW (no state) / CHANGED (revision differs) / DELETED (state exists, file gone).
3. **fetch + ingest** each NEW/CHANGED file → bytes → `ingestDocument({collectionId, title:name, contentBase64, contentType:mimeType, contentTrust:'untrusted', documentId:\`sync:<sourceId>:<fileId>\`})` (extraction reused). Update `SyncFileState.revision`.
4. **prune** — DELETED files → `deleteDocument(documentId)` + drop the state row.
5. record `lastSyncedAt` + per-file outcomes on the `SyncSource`.

Long-running / paginated → the run handles retry + cancel. Cost/rate-limit caps per OQ-3.

### RBAC & isolation
Org-scoped (ADR 0006): managing a `SyncSource` needs `workspace:write` in the collection's org + USE rights on the Connection (ADR 0024 §use-gate). The scheduled run is tenant-trusted (the strategy precedent), scoped to the source's org/collection. Uniform 404 on insufficient scope.

---

## Phased plan

1. **`knowledgeSourceFetch` — folder listing + OneDrive.** Add `listFolder(connection, folderId)` for Google Drive (Files API) + the OneDrive (`microsoft365`/Graph) fetch+list case. SSRF-guarded; size/page caps. — **Google Drive `listFolder` IMPLEMENTED 2026-06-22** (`host/knowledgeSourceFetch.ts`, paginated, `MAX_LIST_FILES`/`MAX_LIST_PAGES` caps per OQ-3, rides the existing `brokeredFetch` SSRF/credential broker; +`test/knowledge-source-list-folder.test.ts`). OneDrive (`microsoft-graph` Files.Read) IMPLEMENTED 2026-06-22 (Phase 6).
2. **Feature-package + REST.** `features/knowledge-sync/`: `SyncSource` CRUD + diff-state store; routes under `/v1/host/openwop-app/knowledge-sync/*` (create/list/get/delete/pause + "Sync now"). Toggle `knowledge-sync` OFF/tenant. — **IMPLEMENTED 2026-06-22** (`features/knowledge-sync/{knowledgeSyncService,routes,feature}.ts`: `SyncSource`+`SyncFileState` tenant/source-prefixed `DurableCollection`s, create/list/get/delete/pause/resume, org-scoped RBAC + toggle gate + uniform-404 IDOR + connection/collection existence validation; +`test/knowledge-sync.test.ts`. "Sync now" + scheduler binding ride the Phase-3 workflow, not yet wired.)
3. **The `knowledge-sync.run` workflow** (list → diff → fetch+ingest → prune) + the scheduler binding (ADR 0025) so each source ticks on its cadence; "Sync now" enqueues the same run. — **IMPLEMENTED 2026-06-22** — (a) the pure `diffFolder` + `syncDocumentId` (NEW/CHANGED/DELETED/UNCHANGED, stable documentId; +10 `knowledge-sync.test.ts` cases); (b) the run orchestration `knowledgeSyncRunner.ts` (`runKnowledgeSyncOnce`/`syncNow`): list→diff→fetch+ingest(untrusted, delete-then-ingest for clean re-ingest)→prune, per-file failure isolation, status/lastSyncedAt/lastError bookkeeping; (c) the `POST …/knowledge-sync/:id/sync` "Sync now" route (workspace:write, IDOR-404). +4 `knowledge-sync-runner.test.ts` cases. **Remaining:** "Sync now" runs INLINE (fine at the 1000-file cap; a production host would enqueue an executor run) and the **scheduler cadence auto-tick** (ADR 0025 binding) is not yet wired — both Phase 3b.
4. **Google connection pack** (`core.openwop.connections.google`) for Drive OAuth (read-only scope) — microsoft365 exists. — **ALREADY SATISFIED** (verified 2026-06-22): `google` is a BUILTIN provider (`providerRegistry.ts`) with the `drive.readonly` read-scope + `apiHosts:['googleapis.com']`, so the OAuth PKCE flow mints a working read-only Drive connection that `listFolder`/`fetchKnowledgeSource` use. No new pack needed.
5. **"Add sync" UI** in the KB / project **Sources** surface: connect a drive, pick a folder, set cadence; a list of sync sources with last-sync status + "Sync now" + pause/remove. (ADR 0084 correction surfaced Sources in projects — sync lives there.) — **IMPLEMENTED 2026-06-22** (`features/knowledge-sync/{knowledgeSyncClient,KnowledgeSyncPanel}.tsx` + 4-locale i18n; mounted in the KB collection view `KnowledgeBasePage`, self-hiding on a 404 when the toggle is off; lists the collection's sources w/ status + Sync-now/pause/remove + an add form gated on a connected Google account; +4 component tests; FE build gate green). Follow-on: a folder PICKER (v1 takes a raw folder id) + embedding in the project Sources tab specifically.
6. **Tests + docs.** Diff correctness (new/changed/deleted), idempotent re-ingest (stable documentId), untrusted-marking, org-scope/IDOR, SSRF on the fetch path, large-folder pagination cap.

## Alternatives weighed
1. **A bespoke sync daemon + OAuth + fetch.** Rejected — quadruple `no-parallel-architecture` violation (Connections + scheduler + knowledgeSourceFetch + KB ingest already exist).
2. **Webhook/push (Drive change notifications) instead of polling.** A good *future* optimization (Drive `changes.watch`), but adds a public webhook + channel lifecycle. v1 = scheduled diff (simple, works for both providers); push is OQ-4.
3. **Real-time per-file watch.** Out of scope; the heartbeat cadence is the contract.

## Open questions
1. **OQ-1 — Deletion semantics.** Hard-delete the KB doc when the source file is removed, or soft-archive? Propose hard-delete (the KB mirrors the folder) with a per-source "keep on delete" opt-out.
2. **OQ-2 — Folder recursion + filters.** Recurse subfolders? MIME/type filters (only PDFs)? Propose: top-level by default, optional recursion + an extension allowlist.
3. **OQ-3 — Cost / rate-limit / large folders.** A 10k-file folder × frequent cadence is expensive. Propose: per-source file cap + min cadence + incremental pagination across runs; honor provider rate limits.
4. **OQ-4 — Push vs poll.** Drive/Graph change-notification webhooks (lower latency, less egress) as a follow-on once the polling baseline is proven.
5. **OQ-5 — Conflict (edited in both places).** The external drive is the source of truth (one-way sync, drive→KB). A two-way sync is explicitly out of scope.
6. **OQ-6 — Native format extraction.** Google Docs export as text/markdown (existing path); binary Office files via the DOCX/PDF extractor. Spreadsheets/slides → CSV/text export TBD.

## RFC verdict (Step 5)
**Host assembly over Accepted RFCs + implemented ADRs — NO new RFC.** Connections (RFC 0046 credentials), the scheduler, trigger-ingestion (RFC 0099), and SSRF egress (RFC 0076) are all Accepted; folder-listing + diff + the `SyncSource` config are non-normative host extensions under `/v1/host/openwop-app/*`. A new RFC is warranted only if a normative cross-host "sync source" advertisement is later required.

> **Image OCR via a vision LLM (2026-06-23, opt-in):** `extractTextFromBytes` OCRs images (png/jpeg/webp/bmp/tiff/gif) by asking the host MANAGED provider's VISION model to transcribe them (`ocrImageViaLLM` → `dispatchManagedChat`, the in-service pattern `cms/translate.ts` uses) when `OPENWOP_KB_OCR_ENABLED=true` (default OFF — it bills provider tokens, governed by the managed daily usage cap). No local OCR engine (tesseract.js removed). Off ⇒ images 415; a non-vision managed model or provider error ⇒ 422. Replay-safe: every path that reaches it is a non-recorded service op (KB routes + the sync runner); the recorded-run media path (notebooks audio) stays on `ctx.callAI`. Applies to manual upload + drive sync alike. Follow-on: audio/video transcription (the recorded-run `callAI` path) + a vision-provider fallback.
