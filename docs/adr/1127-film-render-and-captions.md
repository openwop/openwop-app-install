# ADR 1127 — Film render and captions

Status: Proposed (2026-11-15). Planning only. Part of ADR 1126.

## Context

A film creative (ADR 1126) must leave the app as video files: one per channel format, each with a
poster/still and captions. Nothing upstream renders a film to video today. `films` (ADR 1075) plays
FilmSpec as React DOM in the browser, the only ffmpeg reference is a comment saying the host has
none (`features/podcasts/audioMux.ts:4`), and there is no WebVTT/SRT code anywhere.

DeckTalk runs a working renderer (decktalk@8691c224 `render/render.mjs`, `mix-audio.mjs`,
`hosted-worker.mjs`; node `P/hosted-render.mjs`). Its deployed shape (decktalk
`hosting/targets.json`):
- **Image and job:** a Cloud Run job on a pinned headless-Chromium image with ffmpeg and tini,
  running as a non-root user. Node heap 1024 MB, `UV_THREADPOOL_SIZE=1`. 2 vCPU / 4 GiB, timeout
  900 s, `maxRetries 0`, parallelism 1. The worker has its own 870 s deadline and a heartbeat.
- **Dispatch:** the node dispatches once, then durably suspends on an external event keyed to the
  job id. It never polls and never launches a second worker after a lost response.
- **Security posture:** the renderer reads local files only, never downloads URLs, never holds
  provider keys, and never executes bundle-supplied HTML. It rebuilds the markup from data.
- **Shared core:** `render.mjs` is one frame-stepping core with two inputs, a deck-slide bundle and
  the FilmSpec path.

**User decision (2026-11-15):** support **both** a server-side Cloud Run job and a browser-side
export, chosen per install, and fully develop both.

## Decision

### D1 — One render contract, two backends

A host-local **RenderRequest** (`contracts/filmRender.ts`, pure, shared by backend and frontend
like `contracts/films.ts`):
- `{productionId, filmRef:{canvasId, version}, mixRef, format:'16:9'|'9:16'|'1:1', fps:30,
  captions:{sidecar:['vtt','srt'], burnIn:boolean}, poster:{atMs}}`
- plus a `specHash` over all of it, so an identical request reuses an existing export.

A **RenderResult**: `{mediaAssetId, posterAssetId, captionAssetIds, durationMs, frameCount,
specHash, backend}`.

The **render core** is a pure module, `renderCore`, ported from DeckTalk's FilmSpec path with the
slide path stripped. It turns FilmSpec v1, the cue timeline and a format into a sequence of frame
**states** (per-element poses), using `contracts/films.ts` cue evaluation. It reuses the ADR 1075
evaluator directly rather than DeckTalk's parity-tested copy, and the parity test moves upstream as
a guard. **The backends share frame state, not pixels.** Each has its own rasteriser:

- **Job:** real Chromium DOM, one screenshot per frame. This is DeckTalk's method
  (`render/render.mjs:117-126`: `window.render(t)`, JPEG screenshot, ffmpeg `image2pipe`). FilmSpec
  elements are DOM (container-query font sizes, wrapping, `object-fit` images).
- **Browser:** a **new canvas rasteriser** for FilmSpec, covering text layout and wrapping with font
  metrics, images and shapes. Browsers have no API that rasterises DOM into a `VideoFrame` short of
  screen capture. *Correction (DeckTalk review, 2026-11-15): an earlier draft said the browser
  "steps the same renderCore in an offscreen canvas". The state is shared; the pixels are not.*

**Parity is defined without hashes**, because pixels differ even between platforms on one backend.
DeckTalk measured that pinned visual baselines reproduce only on native amd64. Parity means:
(a) identical evaluator state at sampled times; (b) identical layout-fit diagnostics (DeckTalk
`film-layout.mjs`); and (c) a perceptual tolerance (SSIM) for each backend against a reference
render, checked by a test over a fixed film. Both backends load the **same bundled font files**,
never system fallbacks.

### D2 — Server backend: Cloud Run job `openwop-app-film-render`

DeckTalk's shape is adopted with upstream names:
- A second container image, built from `render/Dockerfile`, pinned by digest, non-root, with
  headless Chromium, ffmpeg and tini.
- The job is configured per install in `deploy.env` (`OPENWOP_FILM_RENDER_JOB`, region, resource
  limits). Defaults: 2 vCPU / 4 GiB, timeout 900 s, 0 retries.
- Inputs are staged by the backend into a per-job object prefix (the FilmSpec JSON, the narration
  mix, and image assets copied from Media). The worker reads only that prefix, writes outputs to its
  own output prefix, and signals completion through an authenticated callback that resumes the run.
- The node (`feature.film-creative.nodes.render`) dispatches once and suspends on the external
  event `film-render:<jobId>`. A lost callback times out typed (`render_timeout`) and can be
  retried by a person, never automatically.
- The worker holds no provider keys and no tenant credentials beyond a short-lived, render-only
  object-access grant scoped to its two prefixes (D4).
- **Deploy:** `deploy.sh` gains a third target, `run-job:<project>/<region>/openwop-app-film-render`,
  which the release bus already models as a target. DEPLOY.md documents it. An install that sets no
  job uses the browser backend only.

### D3 — Browser backend: export in the signed-in user's tab

`renderCore` supplies the frame states. The browser canvas rasteriser (D1) draws them in an
offscreen canvas. The Film tab's export view encodes the frames with WebCodecs `VideoEncoder` and
the narration mix with `AudioEncoder`, then muxes MP4 in the browser with a pure-JS muxer (a
vendored, pinned library, no CDN). The output streams to the Origin Private File System, never
holding three files in memory.

- **Fit check:** the browser runs the layout-fit diagnostics on **its own** layout and refuses on
  overflow (`layout_overflow`, naming the beat and element). A canvas wrap can overflow where
  Chromium's did not.
- **Codec gate:** before starting, it checks `VideoEncoder.isConfigSupported` (`avc1`) and
  `AudioEncoder.isConfigSupported` (`mp4a.40.2`). An unsupported browser is refused typed
  (`browser_codec_unsupported`) and offered the job backend if the install has one.
- **Mix:** an ffmpeg graph in the job (resample, volume, fades, sidechain ducking, amix,
  `loudnorm`). `OfflineAudioContext` has no sidechain input and no EBU R128 loudness
  normalisation, so the browser mix implements ducking and loudness normalisation in JS.

- **Captions:** burned in by drawing them into the frame. VTT/SRT sidecars are generated by the same
  shared module as the server.
- **Fallback:** where WebCodecs is unavailable, the view says so and offers the server backend if
  the install has one. It never records the screen and never silently downgrades quality.
- **Upload:** the result goes to Media as a normal asset, with the `specHash` and `backend:'browser'`
  recorded. The backend accepts it only when `durationMs`, `frameCount` and the `specHash` match the
  RenderRequest it issued. Anything else is refused typed (`render_result_mismatch`).
- **Trust:** those checks bind only metadata. The host cannot verify that a browser upload's pixels
  match the FilmSpec. A browser export is therefore recorded as **user-attested**
  (`attestation:'user'`), and the named-approver review of the final files is **mandatory** for it.
- **Limits:** the export is tab-bound. The UI shows progress and keeps the tab awake, and a closed
  tab cancels cleanly with nothing half-written to Media.

### D4 — Install configuration

`OPENWOP_FILM_RENDERER` = `job` | `browser` | `both` (default `browser` when no job is configured,
`both` when one is). With `both`, the export view offers both and defaults to the server job for
batches (all three formats). `/readiness` reports which backends are live. The Film tab never
offers a backend the install cannot run.

### D5 — Render meter (new spend control)

The existing caps (daily image budget, spend thresholds) do not cover rendering. A **render meter**
per tenant/day counts reserved frames, following DeckTalk's frame-count reservation
(`render/budget-client.mjs`):
- Before dispatch, the backend reserves `frameCount × formats` against
  `OPENWOP_FILM_RENDER_FRAMES_PER_DAY` (an operator setting).
- A reservation over the cap is refused typed (`render_budget_exhausted`), naming the remaining
  allowance.
- The worker receives a 15-minute render-only grant tied to the reservation. On completion the
  reservation is settled to the actual frame count, and on failure it is released.
- Browser exports reserve the same way (they still create Media assets), with a separate, higher
  default allowance because they cost the host nothing to compute.
- **Batch:** a batch series (ADR 1130 D4) reserves the whole batch's frames up front and is
  refused before starting if they don't fit. Batches run on the **job** backend only, because a
  tab-bound browser export cannot carry 177 films.

### D6 — Captions

A pure `captions` module in `contracts/` builds WebVTT and SRT from the narration alignment
(ADR 1128). It follows DeckTalk's `captions.mjs`: at most 6 words and 42 characters per cue,
breaking on pauses, under the beat ↔ clip invariant and reading-rate bounds. **New here:** at most
2 lines per cue. Without word alignment, captions fall back to timing per clip, and the file marks
itself `alignment: 'clip-fallback'` (DeckTalk's `scene-fallback`). Captions are stored as Media assets beside
the video. Burned-in captions draw the same cues with brand-token styling inside each format's safe
zone, reusing the ADR 0946 safe-zone table.

### D7 — Posters

A poster per format is rendered from the frame at `poster.atMs` (default: the first frame after the
title cue settles). It is a PNG Media asset and can serve as a page's `og:image`.

## Phases

| Phase | Scope |
|---|---|
| R0 | `contracts/filmRender.ts` + `renderCore` (pure) + captions module + evaluator parity test |
| R1a | Browser canvas rasteriser for FilmSpec + its own fit diagnostics + bundled fonts + SSIM parity test against the reference |
| R1b | Browser encode: codec gate, WebCodecs + MP4 mux to OPFS, JS ducking + loudness normalisation, burn-in, upload, mismatch refusal, user-attested record |
| R2 | Render meter + reservations (shared by both backends) |
| R3 | Cloud Run job image, dispatch + callback resume, staging prefixes, render-only grant |
| R4 | Deploy target, DEPLOY.md, `/readiness` reporting, backend chooser in the export view |
| R5 | Sizing measurement: render a 180 s film at each format on the job and record wall time and memory. Tune the defaults, or cap film length per install, from the data |

## Alternatives weighed

- **Render inside the backend container.** Rejected by the user in favour of the job + browser pair.
  A render would compete with API requests on the same instance.
- **Screen recording in the browser.** Rejected: tab-size dependent, includes UI chrome, not
  deterministic.
- **ffmpeg.wasm in the browser.** Kept as a fallback candidate if pure-JS muxing proves
  insufficient. Rejected as the default for its size (~30 MB) and memory use.

## Security notes

The worker is a privilege-reduced sandbox. It has no network egress except object storage and the
callback, no provider keys, and data-only inputs. The callback is authenticated with a per-job token
bound to the reservation and is single-use. Browser uploads are validated against the issued
request, and the content type is checked by magic bytes through the Media upload path.

## RFC verdict

**Host extension, no RFC.** RenderRequest and RenderResult are host-local contracts. No run-event
field changes: the render node suspends on an external event through the existing executor seam.

## Open questions

1. **Sizing (unmeasured):** one DeckTalk observation shows a 24.4 s film rendering in about 2
   minutes wall time, cold start included. Whether 900 s covers a 180 s film at three formats is
   unknown. R5 measures it before defaults are fixed.
2. Default frame allowances (`OPENWOP_FILM_RENDER_FRAMES_PER_DAY` for job and browser): operator
   settings, with defaults set after R5.
3. Which pinned muxer library to vendor (licence review needed).
4. **Browser feasibility (unmeasured, never tried in DeckTalk):** 180 s × 30 fps is 5,400 frames
   per format, 16,200 for three. Hardware H.264 in desktop Chromium looks sufficient (judgement).
   AAC `AudioEncoder` coverage varies by browser. R1b measures it on Chromium, Safari and Firefox
   before the browser backend is called complete.
5. SSIM tolerance per backend: set from the reference render in R1a.
