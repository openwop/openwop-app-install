# ADR 0108 — Media → text for RAG via the managed provider (vision OCR + audio/video transcription)

**Status:** implemented (2026-06-23) — Phase 1 (image OCR, #685) + Phase 2 (audio transcription). Video + long-audio are documented open questions, not phases.
**Date:** 2026-06-23
**Toggle:** none new — gated by env (`OPENWOP_KB_OCR_ENABLED` for images, `OPENWOP_KB_TRANSCRIBE_ENABLED` for audio/video), both default OFF (they bill provider tokens).
**Capability:** none new on the wire (rides the already-accepted multimodal `callAI` / RFC 0091).
**Depends on / composes:** ADR 0011 (KB ingest — `extractTextFromBytes`), ADR 0107 (knowledge-sync — the runner already routes file bytes through the extractor), ADR 0106 (`mediaBudget` — the STT byte budget), the managed provider seam (`dispatchManagedChat`), ADR 0085 (the notebooks audio→transcript workflow — the recorded-run sibling).
**Surface:** host-internal (`kbService.extractTextFromBytes`); no new route.
**NON-NORMATIVE — no OpenWOP RFC.**

## Why this exists

ADR 0107 made the KB ingest every common *document* type (text/PDF/Office/ODF/RTF) into RAG, across five drives + manual upload. The remaining content classes — **images** (scans, screenshots, diagrams) and **audio/video** — carry text/speech that doesn't tokenize without OCR/transcription. This ADR closes that gap **with LLMs only** (a deliberate decision — see Alternatives): the host's MANAGED multimodal provider reads images (vision) and transcribes audio (speech), so "media → text" is one consistent, provider-governed capability rather than a bag of local engines.

## The decisive architectural insight

An earlier review assumed transcription *had* to be an asynchronous, recorded **workflow** run (the notebooks `transcribe-source` node via `ctx.callAI`), which would force the synchronous drive-sync runner to go async and reconcile `SyncFileState` after the run — a large, fiddly change. That assumption is **wrong for the ingest path**:

- Every path that reaches `kbService.extractTextFromBytes` is a **NON-recorded service operation** — the KB upload route, the knowledge-sync runner's `syncNow`, media-asset ingest, the project-knowledge route. **None is a recorded workflow run.** (`ctx.features.kb` exposes no media-ingest op; verified by audit.)
- Therefore a direct, **synchronous** `dispatchManagedChat` call there carries **no replay/event-log determinism concern** — there is no run to fork. This is the same in-service managed-dispatch pattern `cms/translate.ts` already uses.

So media → text is a **synchronous branch inside the single extraction owner** (`extractTextFromBytes`), not a new workflow. This collapses the async/sync-cursor complexity entirely and keeps it consistent with the document extractors (which are also synchronous, in the same function). The **recorded-run** media path (notebooks audio) is a *separate* concern and keeps using `ctx.callAI` (recorded, replay-safe) — unchanged by this ADR.

## Decision

`extractTextFromBytes(tenantId, buffer, contentType)` — the single extraction owner for KB file ingest — routes by MIME:

- **Documents** (text/PDF/Office/ODF/RTF) → local extractors (`unpdf`/`mammoth`/`officeparser`), unchanged, free, synchronous.
- **Images** → `mediaToTextViaLLM(tenantId, bytes, mime)` with a **vision** prompt → transcribed text. *(Phase 1, shipped.)*
- **Audio/video** → the same `mediaToTextViaLLM` with a **transcription** prompt + an `{type:'audio'}` content part → transcript. *(Phase 2.)*

`mediaToTextViaLLM` calls `dispatchManagedChat` (the host managed provider; composes its governance + daily usage cap). Off (env gate unset) ⇒ the type 415s like any un-tokenizable type. A non-multimodal managed model, or a provider error, ⇒ a clean **422** (never a silent empty ingest). The content is fenced **untrusted** (ADR 0027) downstream like any provider-derived text.

### Governance & cost
- **Env gates, default OFF** (these bill tokens): `OPENWOP_KB_OCR_ENABLED` (images), `OPENWOP_KB_TRANSCRIBE_ENABLED` (audio/video) — separate, so an operator controls the two cost profiles independently (an image is small; audio can be tens of MB).
- **Budget:** images ride the managed daily usage cap. Audio additionally pre-flights the **`mediaBudget('stt')` byte budget** (ADR 0106) before the call + records usage after — mirroring `notebooks/routes.ts` (the decoded-byte budget is the right governance for large audio; the managed token cap alone under-counts it).
- **Cap:** the existing 32 MiB decoded-upload cap bounds the payload.

### Applies everywhere the extractor is reached
Because it lives in `extractTextFromBytes`, **manual KB upload AND drive-sync both gain it for free** — the knowledge-sync runner already downloads file bytes and routes them through the extractor (ADR 0107 Phase 3). No sync-runner change, no async cursor.

## Phased plan

| Phase | Scope | Status |
|---|---|---|
| 1 | **Image OCR** via the managed vision model (`mediaToTextViaLLM`, `OPENWOP_KB_OCR_ENABLED`); tesseract.js removed. | **implemented** (#685) |
| 2 | **Audio transcription** — `mediaToTextViaLLM` (image+audio), `OPENWOP_KB_TRANSCRIBE_ENABLED`, `mediaBudget(stt)` pre-flight; video rejected (OQ); structural replay guard on ctx media-ingest. | **implemented** |

## Alternatives weighed

- **Local OCR/STT engines (tesseract.js, whisper.cpp).** Rejected per the maintainer's "LLMs only" directive — and on merit: heavy deps + model downloads, decompression-bomb surface, mediocre quality, and a *second* "media → text" philosophy that drifts from the `callAI` one. (Phase 1 originally shipped tesseract and was reverted to LLM vision in #685.)
- **Asynchronous transcribe→ingest workflow (the notebooks way) for the ingest path.** Rejected as over-built *for KB ingest*: the ingest path isn't a recorded run, so the async/`SyncFileState`-cursor machinery buys nothing here. The workflow path remains the right tool for *recorded-run* transcription (notebooks) — kept, not duplicated.
- **One combined env gate for both image + audio.** Rejected — the cost profiles differ enough that operators want independent control.

## Open questions

1. **OQ-1 — Provider fallback.** If the managed model isn't multimodal, media ingest 422s. A future enhancement could fall back to the tenant's BYOK vision/audio model when present. Out of scope; the 422 is honest.
2. **OQ-2 — Long audio.** Inline audio is bounded by the 32 MiB cap (~minutes). Long-form (chunked transcription / file-API upload) is a follow-on.
3. **OQ-3 — Drive-sync cost blast — ADDRESSED (2026-06-23).** `SyncSource.includeMedia` (default true / absent⇒true) lets a source opt OUT of media: the runner filters image/audio/video out of the folder listing BEFORE the diff, so they're never fetched/transcribed and any already-synced media is pruned on the next pass (the collection mirrors the folder's selected view). The STT byte budget + the default-OFF env gates remain the primary cost controls. A per-source UPDATE route (toggle on an existing source) is the remaining follow-on (create-only for now).

## Review hardening (full-implementation /architect review, 2026-06-23)

A retrospective architecture review of #685/#687/#688 confirmed **0 blocking issues** and that replay-safety is *robust* (every recorded-run ingest surface — `agent-knowledge`, notebooks `addSource` — is text-only; all media-capable ingest is on non-recorded HTTP routes). It produced these follow-up hardenings:

- **Binary-upload content is fenced UNTRUSTED (security).** Content extracted from any uploaded FILE or media token (`source.kind === 'media'`) is now `contentTrust: 'untrusted'` regardless of the caller — a PDF/DOCX can hide white-on-white text and an image/audio can carry adversarial text the uploader never reviewed (the parser/vision-LLM surfaces it). Only directly-pasted text may be `'trusted'`. This is broader than media (it covers PDF/DOCX too) and aligns KB upload with what notebooks/sync already do (RFC 0021 / ADR 0038 §C). An explicit `contentTrust:'trusted'` on a file upload is ignored (the fence is non-overridable). Untrusted content is still fully retrievable as RAG context — it is only fenced from agent-trusted injection.
- **Shared managed-ref constant.** `MANAGED_FREE_REF` (`managed:openwop-free`) is exported from `managedProvider` and reused by `kbService` + `cms/translate` instead of re-deriving the literal.
- **Image-OCR cost governance (review #3, closed).** Image OCR is governed by the **managed daily token cap** (`recordManagedUsage` inside `dispatchManagedChat`) plus OQ-3 skip-media — it is *not* unbounded. A *separate* image byte-budget (a new `MediaKind` + storage column) is intentionally omitted as disproportionate: images are small and already token-capped. Audio keeps its `mediaBudget('stt')` byte budget because audio payloads are large.

## RFC verdict (Step 5)

**Host-assembly over an Accepted RFC + a host service — NO new RFC.** Multimodal `callAI`/dispatch (image+audio parts) is accepted (RFC 0091); `dispatchManagedChat` + `mediaBudget` are existing host seams; `extractTextFromBytes` is host-internal. No wire surface changes. An ADR (this) suffices.
