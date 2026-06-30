# ADR 0085 — Audio / video source ingestion + transcription (perceive the bytes, store the transcript)

**Status:** **implemented** (Phase 1 — `audio` added to `INPUT_MODALITIES` and `discovery.ts` now DERIVES `input.modalities` from that constant, so advertise+accept flip in lockstep; Phase 2 — the Media MIME allowlist gained the inert audio/video container types + `MAX_DECODED_BYTES` is env-parameterized, 32 MiB default; Phase 3 — `feature.notebooks.nodes.transcribe-source` (ctx.callAI audio part, RFC 0091); Phase 4 — `feature.notebooks.nodes.fetch-youtube-source` (caption track via `ctx.http.safeFetch`; **the audio-track STT fallback is now implemented** — when a video has no captions, the node best-effort extracts a directly-fetchable audio stream from `ytInitialPlayerResponse`, downloads it ≤24 MiB, and transcribes via the same `ctx.callAI` audio path; streams behind a `signatureCipher` need a JS-VM deciphering step (yt-dlp-class) and still throw `no_transcript`); Phase 5 — `feature.notebooks.nodes.ingest-source` + the narrow `ctx.features.notebooks.ingestSource` surface write + the `notebooks.ingest-audio` / `notebooks.ingest-youtube` built-in workflows; routes `POST …/notebooks/:id/sources/{audio,youtube}` enqueue them; Phase 6 — the Sources panel gained an audio/video upload + a YouTube-URL paste, i18n en/es/fr/pt-BR; Phase 7 — tests: `ai-input-modalities` / `ai-call-multimodal-route` updated for `audio`, `media-route` still rejects text/html+svg, `notebooks-ingest-nodes` covers the three nodes. The `ingest-source` node is wired ONLY into the upload-route workflows — deliberately NOT in any chat agent's allowlist, preserving ADR 0084's injection-surface guard. **Hardening (2026-06-22):** `transcribe-source` now rejects audio over a 32 MiB decoded cap up front (`audio_too_large`) rather than firing a doomed costly model call (OQ-3); `fetch-youtube-source` also resolves the caption track from the parsed `ytInitialPlayerResponse.captions.…captionTracks` when the unescaped `"captionTracks"` literal is absent.)
**Date:** 2026-06-20
**Toggle:** none new. The MIME-allowlist extension + the transcription node are **always-on host plumbing**; the user-facing "upload an audio/video source" surface is gated by the **`notebooks`** toggle (ADR 0084, default OFF, `bucketUnit: tenant`). No second toggle — this is a capability *behind* notebooks, not a feature in its own right.
**Surface:** extends ADR 0007 Media (`features/media`) + adds a transcription node usable by the `notebooks` node pack (ADR 0084 Phase 3) + advertises the `audio` input modality at `/.well-known/openwop`.
**Depends on / composes:**
- ADR 0084 (Research Notebooks — the consumer; this closes its explicitly-deferred audio/video source row)
- **RFC 0091** *Multimodal perception input on `ctx.callAI`* — **Status: Accepted** — the keystone; audio is already on the wire
- ADR 0007 (Media Library — stores the source bytes; owns the MIME allowlist this ADR extends)
- ADR 0011 (Knowledge Base / RAG — the transcript becomes a KB document: chunk → embed → retrieve-with-citations over the RFC 0018 `ctx.db.vector` surface)
- ADR 0024 (Connections — BYOK credential for the multimodal/transcription model)
- ADR 0042 (knowledge binding — the transcript KB doc is bound to the notebook Subject)
- RFC 0076 (SSRF-guarded host egress — `ctx.http.safeFetch` for YouTube caption fetch)
**RFC verdict:** **host work that RIDES the already-Accepted RFC 0091 — NO new RFC.** Audio input on `ctx.callAI` was standardized + accepted by RFC 0091; this ADR is the honest host implementation of an advertised modality. The only normative obligation is honesty: advertise `aiProviders.input.modalities: [… , "audio"]` *and actually accept it*, per `OPENWOP_REQUIRE_BEHAVIOR=true`.

> **Origin.** Continues the `lfnovo/open-notebook` product-design port begun in ADR 0084. NotebookLM ingests audio/video sources and transcribes them into the corpus; ADR 0084 deferred that row ("Multi-modal bytes (PDF/img) … audio/video deferred to ADR 0085"). This ADR delivers it — **not** by inventing a transcription wire surface, but by riding the perception layer RFC 0091 already accepted.

---

## Context — boundaries audit first (MANDATORY, per the scope rule)

The naive port treats "transcribe audio" as a new service (a `/transcribe` REST handler calling Whisper). The audit overturns that on two counts: (1) the audio→model path is **already a standardized, accepted wire surface**, and (2) provider model calls are **`ctx`-only**, so a sync handler is architecturally impossible.

**Finding 1 — audio is already on the wire, and this host already enforces it (just doesn't yet *accept* it).**
- RFC 0091 §A widens a `callAI` message `content` to `string | ContentPart[]` where a part can be `{ type:'audio', mimeType, url?|mediaRef?|data? }`, gated behind the additive `capabilities.aiProviders.input.modalities[]` advertisement. **Status: Accepted.**
- This host **already implements the gate**: `backend/typescript/src/aiProviders/aiProvidersHost.ts:229` `assertModalitiesAdvertised()` rejects any part whose modality is not advertised with `unsupported_modality` (RFC 0091 §A — never silently dropped). The `audio` part type is **already mapped** in `PART_TO_MODALITY` at `aiProvidersHost.ts:225` (`audio: 'audio'`).
- But the advertisement at `aiProvidersHost.ts:224` is `INPUT_MODALITIES = ['text', 'image', 'document']` — **`audio` is absent**, so an audio part is correctly rejected *today*. Turning audio on is therefore a **one-line, honest** change: add `'audio'` to that constant — which simultaneously flips both the advertisement and the acceptance, keeping them in lockstep (no dishonest-wire window).
- **Second advertisement site to keep in lockstep:** `backend/typescript/src/routes/discovery.ts:463` hardcodes `input: { modalities: ['text', 'image', 'document'] }` independently of the constant. This duplication is a latent honesty hazard (two sources of truth for one advertisement). Phase 1 makes `discovery.ts` derive from `INPUT_MODALITIES` so they can never drift.

**Finding 2 — the Media MIME allowlist excludes all audio/video (file:line).**
- The single allowlist lives at `backend/typescript/src/host/allowedUploadMime.ts:12` — `ALLOWED_UPLOAD_MIME`, a `ReadonlySet` of `image/png · image/jpeg · image/gif · image/webp · application/pdf · text/plain · text/markdown · application/json · text/csv` (lines 13–21). **No `audio/*` or `video/*` entry exists.** It is the single source of truth shared by the chat/avatar upload route (`routes/mediaAssets.ts:139`) and the media library (`features/media/routes.ts:60`).
- Its security comment (lines 7–10) is the load-bearing constraint: the serve route reflects the stored `Content-Type` verbatim (no `nosniff`/`Content-Disposition`), so `text/html`/`image/svg+xml` are excluded to prevent stored-XSS. **Audio/video container types (`audio/mpeg`, `audio/mp4`, `audio/wav`, `video/mp4`, `video/webm`) are inert when reflected** — they don't execute script in a browser — so adding them does **not** widen the stored-XSS surface. This is the safety reasoning the ADR must record so the extension isn't read as eroding the allowlist's purpose.

**Finding 3 — `ctx`-only AI (ADR 0011) → transcription is a workflow run, never a sync route.** Provider model calls need a per-node `AdapterScope` (runId/nodeId/attempt/secretResolver/policyResolver) and are reachable only inside a run. So "transcribe this source" **enqueues a run**; the REST route orchestrates, it never calls the model. Same correction ADR 0084 recorded for transformations/Ask.

**Namespace check** — `grep -rni "transcrib"` already shows a *placeholder* host-extension route `POST /v1/host/openwop-app/media/transcribe` (`routes/mediaAssets.ts:213`) in the sample media-generation family. That is a stub, not the real transcription path; this ADR's transcription is a **node**, not that route. (Open question OQ-5 records reconciling/removing the stub.)

**Net:** delivering audio/video sources is (a) one constant edit to advertise `audio`, (b) a handful of inert MIME types added to one allowlist, (c) one new transcription node that feeds bytes to a multimodal model via `ctx.callAI` and writes the transcript to KB, and (d) a YouTube-caption fetch fallback. No new wire surface, no new toggle, no new store.

---

## Decision

Implement audio/video source ingestion as **host work on top of RFC 0091**: the host advertises `audio` as an accepted `callAI` input modality, and a workflow node feeds the source's audio bytes to a multimodal model (Gemini / GPT-4o-audio class, BYOK via ADR 0024) as a `{ type:'audio' }` ContentPart, receiving a **transcript** which is then ingested as an ordinary KB document — identical downstream to any text source.

### Data flow (a transcribed source is just a KB document)

```
upload .mp3/.mp4/.wav            (or paste a YouTube URL)
   │
   ▼  ADR 0007 Media — store bytes               [MIME allowlist EXTENDED to audio/video]
mediaRef (RFC 0019 blob handle)  ──────────────────────────────────────────┐
   │                                                                        │
   │  enqueue transcription RUN (ctx-only; ADR 0011)                        │
   ▼                                                                        │
node: notebooks.transcribe-source                                          │
   │   ctx.callAI({ messages:[{ role:'user', content:[                      │
   │     { type:'text',  text:'Transcribe this audio verbatim.' },          │
   │     { type:'audio', mimeType:'audio/mpeg', mediaRef } ]}] })  ◄────────┘  (RFC 0091 §A)
   │   → transcript: string
   ▼
KB ingest (ADR 0011): chunk → embed → ctx.db.vector       (RFC 0018)
   │   → KnowledgeDocument { sourceType:'audio'|'video'|'youtube', mediaRef, transcript }
   ▼
bind to the notebook Subject (ADR 0042)  →  appears as a Source in the notebook (ADR 0084)
```

- **YouTube path.** A pasted YouTube URL first attempts **caption/transcript extraction** via `ctx.http.safeFetch` (SSRF-guarded egress, RFC 0076) — captions, when present, are higher-fidelity and far cheaper than STT. **Fallback:** when no captions exist, fetch the audio track and run it through the same `notebooks.transcribe-source` (audio-via-RFC-0091) path. Either way the output is a transcript → KB document.
- **The transcript is the durable artifact**, stored as the KB document body; the original bytes remain in Media (`mediaRef`) for playback/re-transcription. Retrieval, citations, and per-source context level (Full/Summary/Excluded, ADR 0084) all work unchanged because downstream it *is* a KB doc.

### Node identity

The node is **`notebooks.transcribe-source`** (in the `feature.notebooks.nodes` pack, ADR 0084 Phase 3) — **not** a `core.openwop.ai.transcribe`. Rationale: transcription here is not a distinct *capability* (it is `ctx.callAI` with an audio part — already core), it is a *notebook ingest step*. Promoting a generic transcribe node to `core` would imply a transcription capability the wire doesn't separately model; keeping it feature-scoped keeps the `agent-capability-core-not-named` discipline honest (the core capability is "callAI accepts audio", which already lives at core). If a second feature later needs transcription, extract the *body* to a shared helper, not a named core node.

### RBAC & isolation

Inherits ADR 0084: the source upload route gates on `workspace:write` in the notebook's org (uniform 404 on insufficient scope, no existence leak). Media bytes are org-scoped (ADR 0007). The transcription run uses the caller-org's BYOK credential (ADR 0024); no managed-key fallback for workflow runs (the BYOK/replay invariant). The `audio` modality advertisement is global (host-level), but *uploading* audio is reachable only through the `notebooks`-gated surface.

---

## Phased plan

**Phase 1 — Advertise `audio` + de-dup the advertisement.** Add `'audio'` to `INPUT_MODALITIES` (`aiProviders/aiProvidersHost.ts:224`); make `routes/discovery.ts:463` derive `input.modalities` from that constant instead of a second hardcoded literal (kills the drift hazard found in the audit). This single change flips both *advertise* and *accept* together — no dishonest-wire window. Verify the gated conformance scenario `callai-multimodal.test.ts` now exercises audio non-vacuously under `OPENWOP_REQUIRE_BEHAVIOR=true`.

**Phase 2 — Extend the Media MIME allowlist.** Add inert audio/video container types to `ALLOWED_UPLOAD_MIME` (`host/allowedUploadMime.ts:12`): `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/webm`, `video/mp4`, `video/webm`. Record the stored-XSS reasoning (these are inert when reflected; the existing `text/html`/`svg` exclusion is untouched) in the file's security comment. Raise/parameterize `MAX_DECODED_BYTES` (`features/media/routes.ts:45`, currently 8 MiB) for the audio/video path, or route large media to the URL-served path (`maxInlineMediaBytes`, `discovery.ts:469`) — see OQ-3 (long-audio).

**Phase 3 — Transcription node `notebooks.transcribe-source`.** In `feature.notebooks.nodes` (signed; Ed25519 + SRI): take a `mediaRef`, call `ctx.callAI` with an `{ type:'audio', mediaRef }` part, return the transcript. Deterministic-replay-safe via the observable-result cache (the transcript is the cached result). Map the model failure modes (`unsupported_modality` should be impossible post-Phase-1; surface provider/credential errors as the canonical codes).

**Phase 4 — YouTube caption fetch + STT fallback.** A `notebooks.fetch-youtube-source` node (or a branch in transcribe-source): `ctx.http.safeFetch` (RFC 0076) the caption track; on success ingest the caption text directly (no model call); on absence, fetch the audio and fall through to Phase 3. Honor egress allowlist/SSRF guards; never fetch from an unguarded path.

**Phase 5 — Ingest wiring.** Compose Phase 3/4 output into KB ingest (reuse `notebooks.ingest-source`, ADR 0084 Phase 3): the transcript becomes a `KnowledgeDocument` (`sourceType: 'audio'|'video'|'youtube'`, carrying `mediaRef`), chunk→embed→`ctx.db.vector`, bound to the notebook Subject (ADR 0042). Per-source context level (ADR 0084) applies verbatim.

**Phase 6 — Frontend "add audio/video source."** In `src/features/notebooks/` (ADR 0084 Phase 6), extend the Sources panel's "add source" affordance with an audio/video upload + a YouTube-URL paste, behind the `notebooks` toggle. Show transcription progress as the async run surfaces (a Source row appearing once ingest completes — same async pattern as ADR 0084). Reuse `ui/` cohesion (`.surface-card`/`.chip`/`<StateCard>`), Lucide icons, i18n keys (ADR 0065). No new chat panel.

**Phase 7 — Tests + `/.well-known` verification.** Backend: allowlist accepts the new MIME types + still rejects `text/html`/`svg`; transcribe node round-trips an audio part through a stub adapter; YouTube caption path + STT fallback; org-scope/IDOR on the upload route. Conformance: confirm `/.well-known/openwop` now advertises `audio` in `aiProviders.input.modalities` and that `callai-multimodal.test.ts` (audio-gated) passes. Frontend smoke for the upload affordance.

---

## Alternatives weighed

1. **A dedicated STT adapter — `ctx.callTranscriber(mediaRef) → { transcript, segments[], speakers[] }`.** This would be a **new wire surface** (a new `ctx` method + a new capability advertisement + a transcript-shape contract with timestamps/diarization). **Per the spec-change rule it would require its OWN RFC in `openwop`** (a new `ctx` capability is normative wire). **Rejected for v1** in favor of riding the already-Accepted RFC 0091: a multimodal model fed audio returns a transcript today, with zero new spec surface. We keep it as a **named future option**: if notebooks later require reliable **word-level timestamps or speaker diarization** (which the freeform `callAI` transcript does not guarantee), that capability genuinely *is* new wire and earns an RFC then (see OQ-1/OQ-2). Until that need is real, a new RFC would be premature spec.
2. **A synchronous `/transcribe` REST handler calling Whisper.** Architecturally impossible — model calls are `ctx`-only (ADR 0011). The existing `media/transcribe` stub route (`mediaAssets.ts:213`) is exactly this shape and is not the real path; OQ-5 covers it.
3. **A new `audiovideo` (or `transcription`) feature toggle.** Rejected — there is no standalone product here; audio/video sources only exist *inside* notebooks. The honest gating is: plumbing always-on, user surface behind `notebooks`. A new toggle would be a parallel-feature illusion.
4. **Promote a generic `core.openwop.ai.transcribe` node.** Rejected for v1 (see "Node identity") — transcription isn't a separate core capability; it's `callAI` + an audio part. Feature-scope it; extract a helper only when a second consumer appears.
5. **Pre-transcribe out-of-band before upload (client-side STT).** Rejected — loses the model's native audio fidelity (the exact failure RFC 0091's motivation calls out), fragments the credential story, and pushes model cost/keys to the browser.

## PRD-vs-architecture corrections (recorded)

- Transcription is **not** a new service/route → a workflow run via `ctx.callAI` + an RFC 0091 audio part (`ctx`-only constraint).
- A transcribed source is **not** a new entity → an ordinary KB document (ADR 0011) bound to the notebook Subject.
- Audio support is **not** new wire → RFC 0091 already accepted it; the host merely advertises + honors it honestly.

## Open questions

1. **OQ-1 — Diarization (who-spoke-when).** A freeform `callAI` transcript has no reliable speaker labels. NotebookLM doesn't strictly need them for RAG, but a "podcast with two hosts" source reads better diarized. Deferred; if required → the dedicated-STT-adapter RFC (Alt 1).
2. **OQ-2 — Word/segment timestamps.** Citations back to a *timecode* in the audio (click-to-play-at) need timestamps `callAI` won't reliably emit. Same disposition as OQ-1 — an RFC'd transcriber if/when the product needs deep-linking into media.
3. **OQ-3 — Long-audio chunking + context window.** A 2-hour recording exceeds a single model context. Propose: window the audio (e.g. N-minute segments via a host-side splitter), transcribe each as a separate `callAI`, concatenate, then KB-chunk the joined transcript. The 8 MiB `MAX_DECODED_BYTES` cap (Phase 2) interacts here — large media should ride the URL-served path (`maxInlineMediaBytes`) and a streaming/segmented fetch.
4. **OQ-4 — Cost + abuse.** Audio transcription is markedly more expensive than text ingest, and it's BYOK on the caller's key. Should a notebook surface an estimated cost / a per-org transcription budget before enqueuing the run? Propose: show a duration-based estimate; rely on existing provider-policy caps (ADR 0024) rather than a new budget primitive in v1.
5. **OQ-5 — Reconcile the `media/transcribe` stub.** `routes/mediaAssets.ts:213` is a placeholder sync route in the sample media-generation family. Once `notebooks.transcribe-source` lands, either remove the stub or redefine it to enqueue the node-run. Resolve before Phase 7 so there's one transcription path, not two.
6. **OQ-6 — Model routing per modality.** RFC 0091 deliberately keeps model routing host-internal (its Unresolved Q2). Which BYOK model handles audio (Gemini vs GPT-4o-audio) is a host config choice; default + override TBD with the Connections team.

## RFC verdict (Step 5)

**Host work that RIDES the already-Accepted RFC 0091 — NO new RFC.** Audio input on `ctx.callAI` is standardized and `Accepted`; this ADR is the conformant host implementation of an advertised modality (advertise `aiProviders.input.modalities: [… , "audio"]` *and* accept it, in lockstep, per `OPENWOP_REQUIRE_BEHAVIOR=true`). The MIME-allowlist extension, the transcription node, the YouTube fetch, and the frontend affordance are all non-normative host extensions. **A new RFC is required only if** v1's freeform-transcript fidelity proves insufficient and notebooks need a dedicated `ctx.callTranscriber` with diarization/timestamps (Alt 1 / OQ-1 / OQ-2) — a genuinely new wire surface, RFC'd in `openwop` *before* that host work, not now.
