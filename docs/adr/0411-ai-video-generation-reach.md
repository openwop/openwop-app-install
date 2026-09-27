# ADR 0411 — AI video-generation reach (make `aiProviders.videoGeneration` real)

| Field | Value |
|---|---|
| **Status** | Phase 1 implemented (2026-07-18); **P2 implemented (2026-07-18) — audio forwarding + governance video budget; native Veo LRO DEFERRED (see P2 correction)**; **P3 architect-decomposed 2026-07-18; P3a + P3b + P3c IMPLEMENTED 2026-07-18 — P3a reel backend + generate-reel node; P3b async-run launch route + reel workflow + FE editor; P3c ads video-dispatch leg (dry-run-honest + live gated `video_dispatch_live_pending`)**; P4 Proposed (RFC-blocked on `seedImage`) |
| **Feature** | host AI-provider seam (`aiProviders`) — no new toggle; the ADR 0401 image-gen-reach pattern for VIDEO |
| **RFC verdict** | **Host work, NO new RFC.** `aiProviders.videoGeneration: supported` + the full `ctx.callVideoGenerator(...)` contract are ALREADY in the accepted spec (`../openwop/spec/v1/host-capabilities.md §host.aiProviders`, incl. the `video_generation_{failed,timeout,cancelled}` error taxonomy). This ADR *honors* an accepted capability the host currently advertises `false` and does not implement. Text-to-video is the accepted shape ⇒ host work. **Image-to-video** (a `seedImage` field) is NOT in the spec shape → a spec addition (`../openwop` PR) FIRST → a follow-on, not Phase 1. |

## Context (boundaries audit)

The seam is **declared but unimplemented** — the exact pre-ADR-0401 state of image edit/upscale:

- **The node exists as a shim** — `packs/core.openwop.ai/index.mjs:370` `videoGenerate = delegateProvider('callVideoGenerator')`; `core.openwop.ai.video-generate` + its schemas. A vendor pack `vendor.myndhyve.ads-video-generate` drives `ctx.callVideoGenerator` and expects `{ video: { url } }`.
- **The host does NOT implement `callVideoGenerator`** — no binding in `executor.ts`, no method in `aiProvidersHost.ts`; the node throws `host_capability_missing` today.
- **Discovery advertises `videoGeneration: { supported: false }`** (`routes/discovery.ts:563`) — honest, but never flips.
- **The spec contract is fixed** (host-capabilities.md §host.aiProviders): request `{ provider?, model?, prompt, negativePrompt?, width, height, durationSeconds, includeAudio?, seed?, brandColors? }` → `{ video: { url, durationSeconds, width, height, mimeType, safetyFiltered, ... }, totalTimeMs?, usage? }`. **URL, never inline base64** ("videos are too large"). **Host hides async polling** (typical 30–120 s), honoring `ctx.signal`, capped by a host max-wait.
- **The node's `video-generate.output.json` says `videoBase64`** — STALE/wrong vs. the spec's URL contract (a correction: the node emits a media URL like image-gen, not bytes across the boundary).

Everything else is reuse: the ADR 0401 **Replicate dispatcher** (Prefer-wait create → poll to terminal → SSRF-pinned output fetch), `storeMediaAsset` (video/mp4), the ADR 0106 media budget, `runWithTimeout`, BYOK `resolveCredential`, and the executor ctx-binding spread.

## Decision

Implement `callVideoGenerator` as the `callImageGenerator` sibling, in phases.

### Providers (the Veo-3-and-others decision)
| Provider | How | Phase |
|---|---|---|
| **Replicate** | Reuse the ADR 0401 dispatcher pattern (a `dispatchVideoReplicate`: create prediction → poll to terminal → fetch the pinned `replicate.delivery` mp4). Replicate **hosts Veo 3** AND Kling / Luma Ray / Wan / Hunyuan / minimax — so ONE dispatcher yields Veo 3 + a dozen models (incl. cheaper ones) behind a single BYOK Replicate token. | **P1** |
| **Google Veo native** | The Gemini `:predictLongRunning` flow (start operation → poll `operations/{name}` → fetch the file with the key). Direct Google billing, no Replicate middle-man; bespoke LRO flow. | **P2** |
| Runway / Luma / Pika native | Bespoke APIs; Replicate already covers the demand. | Deferred |

### The host cap (P1)
`callVideoGenerator(scope, req)`: validate prompt + clamp `width/height/durationSeconds`; BYOK resolve (explicit ref → policy + key; else honest `host_capability_missing`); **budget pre-flight** (ADR 0106 `video` unit — video is expensive, a guardrail before any provider call); dispatch under a **long `runWithTimeout`** (host-hidden polling; `AbortError` → `provider_timed_out`); store the mp4 via `storeMediaAsset` (**video/mp4**, ≤ a hard cap); return the spec-shaped `{ video: { url, durationSeconds, width, height, mimeType, safetyFiltered } }`. Errors map to the spec taxonomy. `provider:'mock'` under `OPENWOP_TEST_SEAM_ENABLED` returns a deterministic tiny mp4 (test seam, the image-gen precedent). Bind into the adapter interface + the executor ctx spread.

### Honesty + replay
- **Discovery flip:** `videoGeneration: { supported: videoGenerationAdvertised() }` — `OPENWOP_VIDEO_PROVIDER_ENABLED === 'true'`; default false (production-honest; the mock is test-seam only). The capability is accepted, so the flip is legitimate host work.
- **Replay/fork (ADR 0083):** generation is non-deterministic — the run records the RESULT media asset id and reads it **verbatim** on replay/`:fork`; never re-generated. Cost metered post-dispatch ⇒ no replay double-charge.
- **Budget** (`video` unit, reused from ADR 0404): env `OPENWOP_MEDIA_DAILY_VIDEO_JOBS` — **default 0 = uncapped/off** (the shared `envBudget` convention; an operator enabling video SHOULD set a cap, since video is dollars, not cents), per-org `videoJobs` override in the same Governance panel, KV-counted (`creative-video:budget`, per-tenant per-day) and **fail-closed** on a usage-read outage. The P2 Governance-panel field surfaces this knob in the UI.

### SSRF / egress
Replicate output is an mp4 URL on `replicate.delivery` — the **same allowlist-pinned, uncredentialed fetch** the image dispatcher uses; a larger byte cap (video). No new egress host.

## Phased plan
| Phase | Ships |
|---|---|
| **P1** | `dispatchVideoReplicate` + `callVideoGenerator` host cap (mock seam + Replicate) + executor binding + discovery honest-flip + `video` budget unit + the node output-schema correction (url); mock-seam + dispatcher tests. |
| **P2** | ~~Google **Veo 3** native (`:predictLongRunning`)~~ **DEFERRED (correction below)**; `includeAudio`→Veo `generate_audio` forwarding (per-model gated); Governance panel `video` budget field. |
| **P3** | Editor surface — a creative-briefs "Generate reel" (run-scoped/async lane) + FE; the ads **video-upload** dispatch leg for campaign attach (Meta/TikTok chunked video upload — distinct from the image leg). |
| **P4** | **Image-to-video** (reel from the composed ad PNG) — gated on a `seedImage` **spec addition** (`../openwop` PR) FIRST, then the host field. |

## Phase 1 — shipped (2026-07-18)

| Piece | Where |
|---|---|
| `dispatchVideoReplicate` (create → poll@2s → SSRF-pinned mp4 fetch → base64) | `backend/typescript/src/providers/dispatchVideo.ts`; reuses the exported ADR 0401 primitives in `dispatchImages.ts` |
| `callVideoGenerator` host cap (validate/clamp, mock seam, BYOK, budget pre-flight, `runWithTimeout`, `storeMediaAsset` video/mp4, spec-shaped result) | `aiProviders/aiProvidersHost.ts` |
| `VideoGenerationRequest` / `VideoGenerationResult` + `ctx.callVideoGenerator?` | `executor/types.ts` |
| Executor ctx binding | `executor/executor.ts` (adapter spread) |
| Discovery honest-flip (`videoGenerationAdvertised()` ← `OPENWOP_VIDEO_PROVIDER_ENABLED`) | `routes/discovery.ts` |
| Node output-schema correction (`videoBase64` → `{ video: { url, … } }`) + pack bump 1.3.0 | `packs/core.openwop.ai/schemas/video-generate.output.json`, `pack.json` |
| Tests: dispatcher (Prefer-wait/poll/SSRF-pin/model-unavailable/abort/input-forward/pinned-default), advertise honesty, adapter mock-seam (host URL never base64, clamps, honest capability-missing) | `test/dispatch-video-replicate.test.ts`, `test/video-gen-advertise.test.ts`, `test/video-generation-adapter.test.ts` |

The `video` budget unit + `creative-video:budget` KV counter already existed on `main` (ADR 0404 built the budget scaffolding but not the host cap) — P1 reuses them, no `mediaBudget.ts` edit.

**Boot-smoke note:** P1's boot smoke first surfaced a `gifenc` named-import boot-crash in `renderCreative.ts` (ADR 0399 OQ-2) — a CJS/ESM interop trap (green vitest, red raw-Node ESM). The 0399/0404 lane landed the definitive feature-detecting fix independently on `main` before this branch rebased, so P1 carries no `renderCreative.ts` change. The lesson stands: only the Cloud Run boot smoke catches this class (`esbuild-banner-createrequire-collision`).

## Phase 2 — implemented (2026-07-18), with a scope correction

**Correction — the native Veo `:predictLongRunning` LRO is DEFERRED, not built.** The
phase table named P2 = "Veo native". The architect gate (this branch) overturned that:
**Replicate — the v1 provider — already hosts Veo 3** (`google/veo-3-fast` is
`DEFAULT_REPLICATE_VIDEO_MODEL`) **including audio**, so a native Google path would add
a SECOND provider (its own BYOK, a new SSRF surface, a second `provider !==
'replicate'` branch, untestable without a live Google key) for **zero incremental
capability today**. YAGNI + a boundary "second path to an already-reachable model"
concern. **Trigger to revisit:** an operator needing Google-direct billing, or a Veo
capability Replicate's wrapper doesn't expose.

**What P2 DID ship:**
- **Audio forwarding (the real honesty gap).** `includeAudio` → Veo `generate_audio`,
  forwarded ONLY for the audio-capable family (`isAudioCapableVideoModel`, the
  `google/veo-3` set, in `dispatchVideo.ts` — the single owner of Replicate-model
  facts). Replicate 422s unknown inputs, so non-Veo models never receive it; and the
  load-bearing case is `includeAudio:false` (suppress Veo's default-on audio). `includeAudio`
  is already in the *accepted* `VideoGenerationRequest` contract → this **improves wire
  honesty** (the host accepted-and-dropped it before), no RFC. `brandColors` confirmed a
  PROMPT-level concern the calling pack bakes in — no Replicate structured input; the
  host correctly forwards no separate param (comment corrected).
- **Governance `video` budget field.** The panel now sets the daily video-job cap. This
  also fixed a **latent gap**: `resolveBudget` read the `videoJobs` override key but the
  governance route + policy shape never let it be SET (read-with-no-writer) — now settable
  end-to-end (route GET/PUT + `governanceService` shape + FE, mirroring `images`). Tests:
  `dispatch-video-replicate` (audio matrix) + `governance` (video-override roundtrip).

## Phase 3 — architect-decomposed (2026-07-18); reuse boundary + build sequence decided

P3 is the one genuinely-large, not-yet-built follow-on. A verification pass first
established what is **already built** (so P3 does NOT rebuild it): video
*generation* is amply covered — `ads.video.generate` (this ADR's companion pack,
activates now the host cap is real), `feature.creative-video.nodes.generate` /
`.text-to-video` (ADR 0404), and `core.openwop.ai videoGenerate`. What P3 lacks,
confirmed absent: **(a) the creative-briefs "Generate reel" FE editor surface**
(no video path in `frontend/react/src/features/creative-briefs/`), and **(b) the
ads video-UPLOAD dispatch leg** (`host/adsAdapter.ts` has only the image-upload
leg — no chunked video upload to Meta/TikTok).

**Reuse boundary (the decisive ruling): do NOT add a 4th video-generate path.**
Three already exist. The creative-briefs "Generate reel" MUST ride one — the
right choice is `ctx.callVideoGenerator` via a **creative-briefs reel node**
(sibling to `renderAnimatedGif`, `render/renderCreative.ts`), reusing the host
cap exactly as `ads.video.generate` does. `brandColors`/style ride the prompt
(the pack precedent); duration/aspect from the brief's template
(`templates.ts:285` story/reel 9:16 exists). No bespoke MP4 encoder (that path —
compositing the ad PNG into video — is P4/`seedImage`, RFC-blocked).

**Decomposition + sequence (each independently shippable):**
- **P3a — creative-briefs reel-generate backend. IMPLEMENTED 2026-07-18.**
  *Core:* `reelPromptForBrief` (pure brief→text-to-video prompt) +
  `storeReelRender` (a `reel`-marked `CreativeRender` — `mediaAssetId` = the
  video's Media token, a REAL brand snapshot via `resolveBrandTokens`, empty
  `layerAssets`, sha256 provenance; shares the per-brief cap + Media-delete
  cascade; **deterministic-`renderId` idempotent** so a run re-run/`:fork`
  converges). *Node:* `feature.creative-briefs.nodes.generate-reel` (v1.2.0) —
  `reelPrompt` → `ctx.callVideoGenerator` (async lane, honors `ctx.signal`) →
  **`ctx.features.media.createAssetFromServeUrl`** (the architect-confirmed seam:
  `callVideoGenerator` already stores the video and returns a host serve URL, so
  this promotes it to a durable Media asset — SSRF-safe, hash-deduped) →
  `storeReel` with `crender:${runId}:${nodeId}`. Typed `host_capability_missing`
  when video isn't wired. Tests: `adr0411-reel-{render,node}.test.ts`
  (orchestration + replay-idempotency + the capability guard). The architect's
  one blocking finding (non-deterministic renderId → duplicate on replay) was
  fixed in the shipped core.
  *Historical note (superseded by the line above):* the video-URL→Media-asset
  question was the deep-discovery finding —
  resolution; a url-as-assetId would break both) → `storeReelRender`.
  Mock-testable via the `provider:'mock'` video seam.
- **P3b — the FE "Generate reel" editor. IMPLEMENTED 2026-07-18.** A pinned
  single-node reel workflow (`reelWorkflow.ts`, registered via `feature.ts
  builtinWorkflows`) + `POST …/briefs/:id/reel` launching it as a background run
  (202 + statusUrl; `buildRunRecord`/`insert`/`seed`/`dispatchRunInBackground`,
  the workflow-author precedent) + the FE: a "Generate reel" button that launches
  + polls (`runsClient.getRun`) + shows the reel as `<video>`. Verified END TO
  END (`adr0411-reel-route.test.ts` drives the run to completion over the mock
  video seam → the reel render lands). *The architect finding below drove the
  async-run choice:* — MUST use the async-run lane, not a sync route. A sync route (like `imageGenRoutes`) would force creative-briefs to
  cross-feature-import the **aiProviders video adapter** + media re-store
  internals — the coupling the P3a node deliberately avoids by using `ctx`
  surfaces. And video's 30–120 s latency makes a blocking HTTP request a
  timeout risk. So P3b **runs the P3a `generate-reel` node** (boundary-clean —
  uses `ctx.callVideoGenerator`/`ctx.features.media`) via a run: (1) register a
  1-node "reel" workflow in `creative-briefs/feature.ts`; (2) a
  `POST …/briefs/:id/reel` route launches a run of it with `{orgId,briefId,…}`,
  returns `{runId}`; (3) the FE polls `GET …/runs/:runId` and, on completion,
  refreshes the renders list — the reel render (a `reel?`-marked row) then shows
  as a `<video>`. `runWorkflowSync` is MCP-private + workflow-registered, so the
  launch reuses the run-creation service (`insertRunWithStartContext` + dispatch),
  not a one-call helper. This is the substantial, run-lifecycle part of P3 — the
  reachable capability already ships via the node (workflow/chat/builder-drivable);
  P3b is the dedicated in-editor polish.
- **P3c — ads video-upload dispatch leg. IMPLEMENTED 2026-07-18 (honest hybrid;
  live gated).** Web research (Meta Graph `ad-creative-video-data` + `advideos`;
  TikTok `/file/video/ad/upload/`) surfaced that the video leg is **not** a mirror
  of the image leg — it has three parts verifiable only against live ad accounts:
  (1) a **transport blocker** — Meta `adimages` takes base64 `bytes` in a JSON body
  (what `brokeredPost` sends), but `advideos` needs **multipart/chunked** upload
  the JSON transport cannot carry; (2) an **async `video_status=ready` poll** before
  the creative can reference the video; (3) a **thumbnail/cover** requirement (Meta
  `video_data.image_url|image_hash`, TikTok `SINGLE_VIDEO` cover `image_ids`).
  Because this is a **money path** (a wrong guess spends on a malformed creative),
  the honest scope is **NOT** a guessed live call:
  - `PublishAdArgs.mediaKind?: 'image' | 'video'` (default `image`; creative-affecting
    → idempotency key). Threaded through the `publish-ad-variants` node.
  - **Video DRY-RUN (Meta/TikTok):** the strategy builds the **documented** video
    plan — Meta `advideos` → `object_story_spec.video_data`; TikTok
    `/file/video/ad/upload/` → an `ad_format:'SINGLE_VIDEO'` creative — so an
    operator previews exactly the intended dispatch (bytes REDACTED, placeholder-id
    chaining), calling nothing.
  - **Video LIVE:** fails closed **`video_dispatch_live_pending`** at the outer
    guard, BEFORE any egress or spend-gate side effect. Never a guessed live call.
  - **Google/LinkedIn + video** → `video_unsupported_platform` (not reel targets).
  - **Misfire guard (the real hazard closed):** the LIVE image leg now fails closed
    `media_asset_wrong_kind` if the resolved asset is actually `video/*` — before
    P3c a reel dispatched via `useInCampaign` would POST video bytes to the image
    endpoint (`adimages` / `file/image/ad/upload/`) → an opaque platform failure.
  - Tests: `test/adr0411-ads-video-leg.test.ts` (dry-run video plan × Meta+TikTok;
    live fail-closed × Meta+TikTok; unsupported-platform × Google+LinkedIn; the
    wrong-kind misfire guard). Adapter tsc + the full ads-adapter suite green.

  **Live-smoke follow-on (the three unknowns to validate with live Meta/TikTok
  credentials before flipping video LIVE on):** (a) a **multipart/chunked upload
  transport** in the egress broker (`advideos` `source` / TikTok `video_file`);
  (b) the Meta **`video_status=ready` poll** loop after upload; (c) **thumbnail/
  cover** acquisition (Meta `advideos?fields=picture`; TikTok
  `/file/video/suggestcover/`). Each is a real API call the in-repo harness cannot
  falsify — so the leg ships dry-run-honest + live-gated, not live-guessed. This is
  the same posture as the operator-private / unfalsifiable surfaces elsewhere in
  the corpus (RFC 0108 harness-witness tier; CDP residency DEFERRED).

**P3 status: IMPLEMENTED 2026-07-18 (P3a + P3b + P3c).** No RFC, no deploy gate;
video LIVE dispatch is honestly gated pending the live smoke above. P4 (image-to-
video) remains RFC-blocked on the upstream `seedImage` spec addition.

### End-of-ADR grades (2026-07-18) — A− across all three, 0 blockers

`/grade-code`, `/grade-ux`, `/grade-data` all graded the ADR 0411 surface **A−**
with **no blockers**. Applied: the grade-ux reel-CTA a11y fixes (`aria-busy` +
an `aria-live` poll-status region, a visible `aria-describedby` hint, and an
unmount-safe poll guard). The remaining findings are tracked Improvements with
their risk stated (the A− posture), disposition recorded here:

- **Media telemetry (grade-code `VID-1`) — FIXED 2026-07-18.** `callVideoGenerator`
  / `callImageGenerator` emitted no span + no failure log, so the most expensive
  media calls were invisible in traces. Fixed by reusing the existing ADR 0118
  **`withLlmSpan`** primitive (`withLlmSpan(PROVIDER_DISPATCH_SPAN, {provider,
  model}, dispatch, 'LLM')`) on the video + both image dispatch paths — NOT the
  token-shaped `wrapInSpan` (its weak-type constraint TS-rejects a media-buffer
  result) and NOT a new helper. The media spans INHERIT ADR 0118's no-prompt/
  no-credential attribute allowlist (test-proven in
  `test/adr0411-media-dispatch-span.test.ts`), plus bounded failure logs. **Dollar-
  cost `emitCost` is honestly DEFERRED** — media providers return no inline cost and
  there is no per-model media pricing SSoT on this host; a hollow cost attr would be
  telemetry theater. tts/transcribe are the same one-line pattern (trivial
  consistency follow-on, not part of the VID-1 recommendation).
- **Reel video buffered in memory (grade-code `VID-2`) — HARDENED 2026-07-18.**
  `dispatchVideo` buffers the full video (≤cap) + base64-encodes it, then holds it
  again through `storeMediaAsset` — ~2–2.5× peak RSS per concurrent job, so a few
  concurrent 1080p reels could OOM a small instance. Fixed with two bounded, self-
  contained changes (the full streaming/non-base64 `storeMediaAsset` path stays a
  deeper cross-cutting follow-on):
  - **Concurrency semaphore** (`util/asyncSemaphore.ts`) around the video
    dispatch + store in `callVideoGenerator` → peak RSS is now **`slots × per-job`,
    predictable** instead of unbounded-by-traffic. `OPENWOP_VIDEO_MAX_CONCURRENT`
    (default **3**; `0` = unbounded for a large host). The run timeout is the
    slot-leak backstop (a hung dispatch aborts → releases).
  - **Streaming byte-cap** — the ≤cap check now runs **during** the download
    (`readBodyCapped`): a declared-oversized `content-length` rejects up front and
    the streamed read aborts + cancels the moment the running total crosses the cap,
    so an oversized/hostile CDN response can't balloon RSS before rejection (this
    also closed a latent bug — the cap was previously checked *after* buffering the
    whole body). Cap is operator-tunable via `OPENWOP_VIDEO_MAX_BYTES`.
  - Tests: `test/async-semaphore.test.ts` (bound/FIFO/release-on-throw/pass-through)
    + streaming-cap cases in `test/dispatch-video-replicate.test.ts`.
- **Retried-reel orphans a capacity-charged video asset (grade-data `VID-1`).**
  Accepted as the deliberate media-library-owns-lifecycle tradeoff — identical to
  how a superseded image render leaves its library asset (media owns asset
  lifecycle; a re-run mints a new non-deterministic video → new hash → no dedup
  collapse). Optional future GC on the media-delete sweep.
- **Video-budget double-count on live retry (grade-data `VID-2`).** Metering-only,
  self-correcting (a per-UTC-day rate meter; over-count only tightens), and the SAME
  accepted pattern as image-gen (ADR 0404) — diverging for video alone would be
  inconsistent. Accepted.
- **No reel-vs-image reporting split (grade-data `VID-3`).** None required — the
  `reel` discriminator makes it derivable; a note for future reel analytics.

## Alternatives weighed
- **Local H.264 encoder (frame-stitch to MP4)** — the deterministic in-tenant motion-graphics path (`h264-mp4-encoder` WASM over the ADR 0399 reveal frames). REJECTED as the *primary* video story: it produces a fade/pan of the composed ad, not generative footage, and the accepted `videoGeneration` capability + the Veo-3 steer point at generative video. Kept as a possible cheap/deterministic complement (a distinct, smaller decision) — NOT this ADR.
- **Native ffmpeg (`ffmpeg-static`)** — GPL-3.0 (white-label redistribution hazard) + a ~70 MB binary + subprocess: rejected on license AND the no-heavy-binary posture.
- **A new video-gen envelope/RFC** — unnecessary: the capability + method are already accepted spec.
