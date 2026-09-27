# ADR 0401 — Image-generation reach (editors + edit ops + Replicate + budget composition)

**Status:** implemented (P1-P4 + hardening, 2026-07-17; drawings affordance deferred per the correction in §Depends) — **Date:** 2026-07-17
**Toggle:** none new — rides the **`slides`**, **`drawings`**, and **`media`** feature toggles + the existing **`image-gen` capability gate** (`imageGenerationAdvertised()` / a wired provider). Justified in matrix row 2.
**Surface:** host-extension only. Wires the **already-implemented** `callImageGenerator` dispatch (ADR 0115 § Correction 2026-07-17, `providers/dispatchImages.ts` + `aiProviders/aiProvidersHost.ts:960`) into the **slides** and **drawings** editors; implements the **already-declared-but-unwired** `callImageEditor` / `callImageUpscaler` host capabilities (edit/inpaint, background-remove, upscale); adds a **Replicate-class** BYOK provider (SDXL/FLUX) alongside OpenAI + Google Imagen; and **converges the image budget onto the ADR 0106 media budget**. No new wire contract (RFC verdict below).

**Decision rationale (docs/steward/MYNDHYVE-DECISIONS.md §4):** the port decision is *no raster/brush engine* — openwop drawings stays vector-first (ADR 0333); the **entire raster value proposition is AI image generation/editing** (generate, inpaint/generative-fill, background removal) wired into slides/drawings. This ADR is the completion of that lane. The gap analysis (`docs/steward/MYNDHYVE-GAP-ANALYSIS.md` rows 312/322, "AI image gen reach — M") scopes it: *OpenAI + Google Imagen only, not wired into slides/drawings, edit/upscale stubbed → wire the ADR 0115 seam into slides/drawings; add Replicate.*

**Depends on / composes (all implemented — this is reach + governance, not new infra):**
- **ADR 0115 (native image providers)** — implemented 2026-07-17. `providers/dispatchImages.ts` dispatches OpenAI Images + Google Imagen natively with a BYOK key (`dispatchSpeech` sibling); `callImageGenerator` (`aiProvidersHost.ts:960`) is the host seam. This ADR **extends that dispatch**, it does not re-open it.
- **ADR 0106 (media-generation cost governance)** — the per-org media budget (`aiProviders/mediaBudget.ts`, `estimateMediaCost`, editable `GovernancePolicy.mediaBudget`). Image ops **converge onto it** (the ADR 0115 plan that did NOT ship — see the budget audit finding below).
- **ADR 0007 (Media) + ADR 0083 (run-artifact producer)** — `storeMediaAsset` mints the `media:` asset; the producer captures base64/url image arrays. **No new store.**
- **ADR 0352 (media intelligence / renditions / smart-crop)** — an edited/generated image **re-enters media as a first-class asset**, so renditions, smart-crop, dedup, and weighted selection apply to it unchanged.
- **ADR 0108 (media→text / operator compat-endpoint seam)** — the operator-gateway adapter (`host/imageProviderAdapter.ts`) remains the bespoke-shaping escape hatch and keeps precedence when configured.
- **ADR 0024 (Connections) + RFC 0076 / `host/brokeredEgress.ts`** — provider credentials are brokered Connections (BYOK); Replicate's async output-URL fetch rides the SSRF-guarded broker.
- **ADR 0328 (slides) + ADR 0333 (drawings vector-first) + RFC 0130 (canvas framework)** — the editors this reach lands in; the generated image is a `media:` ref set on an existing **slide `image` block** (`blockCatalog.ts:46`, `{ src: mediaRef }`) or a **drawings image object**.

  > **Correction (implementation, 2026-07-17):** drawings has **no image object** — its closed shape
  > world is the 9 kinds pinned in `DRAWING_SHAPE_KINDS` (validator + artifact schema + the
  > illustrator prompt's parity test). Adding a 10th `image` kind is a drawings doc-model decision
  > (schema + exporters + prompt world) deserving its own change, so the drawings affordance is
  > **deferred** with this note. The v1 editor reach is **every `mediaRef` surface** — the slides
  > `image` block AND the app-builder image — via ONE hook in `features/media/MediaRefWidget.tsx`
  > (the `propertyWidgets` seam), which is strictly wider than the two bespoke per-editor
  > affordances the ADR sketched.
  >
  > **Follow-up (same day):** the deferred drawings affordance LANDED as its own focused
  > change — a 10th `image` shape kind in the closed world (validator + artifact schema +
  > `ShapeEl` + rect-family geometry + illustrator prompt, all parity-pinned), `src`
  > constrained to HOST media-asset serve paths (external URLs = per-viewer beacons, the
  > CODE-D4 class), the `mediaRef` property widget wired into the drawings definition (so
  > Generate/Edit-with-AI reach drawings too), and an export pre-pass inlining hrefs as
  > data URIs (SVG-as-image rasterization forbids resource loads — a PNG export would have
  > silently dropped placed images).

---

## Context — boundaries audit first (MANDATORY)

The decisive finding: **the dispatch exists and is honest; the reach does not.** Image generation is fully wired end-to-end for the *workflow-node / agent* path, but (1) no **editor** surface calls it (slides/drawings have no "generate image" or "edit selection" affordance), (2) the **edit/upscale** host capabilities are declared-but-unimplemented shims, (3) only **two** vendors dispatch, and (4) the **image budget is a separate counter**, not the ADR 0106 media budget the ADR 0115 plan promised. Four reach gaps, one shared dispatch.

| Concern | Existing owner (file:line) | Gap / how this ADR reaches it |
|---|---|---|
| **The image-gen dispatch (ONE)** | `providers/dispatchImages.ts:65/96` (`dispatchImagesOpenAI` / `dispatchImagesGoogle`) + `aiProviders/aiProvidersHost.ts:960` (`callImageGenerator`) | **Exists.** Providers own it; editors CONSUME it. This ADR adds `replicate` to the dispatcher + `callImageEditor`/`callImageUpscaler` siblings — **no second dispatch path.** |
| Who consumes it today | The `core.openwop.ai.image-generate` node (`packs/core.openwop.ai/index.mjs`) driven by the `feature.image-gen.agents` "Image Designer" persona (ADR 0115 Phase 6) | **Node/agent only.** No editor affordance. `docs/steward/MYNDHYVE-GAP-ANALYSIS.md:312` — "used by creative-briefs, **not slides/drawings**." (Note: creative-briefs references the *asset type* "image", not the dispatch — the honest current consumer is the node/agent.) |
| Edit / inpaint | `packs/core.openwop.ai/schemas/image-edit.{config,input,output}.json` — input already declares `imageBase64` + optional **`maskBase64`** + `prompt`; shim `imageEdit` (`index.mjs:361`) throws `HOST_CAPABILITY_MISSING` | **Schema exists, host does not.** Implement `callImageEditor` (mask ⇒ inpaint/generative-fill; no mask ⇒ whole-image edit). |
| Background remove | none | New op. Ship as an **`image-edit` op mode** (`op:'background-remove'`, no prompt) routed to a provider that supports it — NOT a new node family. |
| Upscale | `image-upscale.config.json` (`scale: 2|4`); shim `imageUpscale` (`index.mjs:367`) delegates to unimplemented `callImageUpscaler` | **Schema exists, host does not.** Implement `callImageUpscaler`. |
| Provider set | `dispatchImages.ts:35` `NATIVE_IMAGE_PROVIDERS = ['openai','google']`; `aiProvidersHost.ts:878` `IMAGE_PROVIDERS = ['openai','google','mock']` | Add **`replicate`** (SDXL/FLUX family) — BYOK Connection, async-prediction dispatch, output-URL fetch via broker. |
| Persist as a durable asset | `host/runArtifactStore.ts` + `storeMediaAsset` (ADR 0083/0007) — base64/url→`media:` mint, org-quota asserted | **Media owns storage.** Every generated/edited image is a `media:` asset; editors set the ref. No new store. |
| Re-enter media pipeline | ADR 0352 renditions / smart-crop / dedup (`features/media/surface.ts:45`) | Edited/generated assets are ordinary media → renditions/crop/dedup apply unchanged. |
| Cost / spend ceiling | **Split today:** image path uses `host/imageGenBudget.ts` (`checkImageBudget`/`recordImages`, per-tenant daily COUNT, `OPENWOP_IMAGE_MAX_PER_DAY`), NOT `aiProviders/mediaBudget.ts` (ADR 0106 per-org media budget) | **The audit finding.** ADR 0115's plan said "add an `images` unit to `mediaBudget`" — it shipped a **separate** counter (`aiProvidersHost.ts:49,1014,1051`). This ADR **converges** image metering onto ADR 0106 (matrix row + Phase (d)). |
| Egress | `providers/dispatchImages.ts` native (fixed vendor hosts ⇒ no SSRF) + `host/brokeredEgress.ts:114` (`brokeredFetch`) | OpenAI/Google/Replicate API hosts are fixed (native). Replicate returns output **image URLs** (`replicate.delivery`) — that fetch rides `brokeredFetch` (SSRF-guarded). Broker owns egress. |
| Capability honesty | `routes/discovery.ts:562` `imageGeneration:{ supported: imageGenerationAdvertised() }` | Edit/upscale, if cross-host-observable, extend the SAME honest-flip (advertise only when wired) — see RFC verdict. |

**Net new (bounded):** three editor affordances (slides + drawings, generate + edit-selection), the `callImageEditor`/`callImageUpscaler` host siblings (mask-inpaint, background-remove, upscale) with a provider capability matrix, a `replicate` native dispatcher, the budget convergence onto ADR 0106, and asset-provenance metadata. The dispatch, node schemas, media store, renditions, broker, and agent pack are all reuse.

> **Boundary law (no-parallel-architecture memory).** There is ONE image dispatch. Editors, nodes, and agents all funnel through `callImageGenerator`/`callImageEditor`/`callImageUpscaler`; media owns every byte; the broker owns every egress. A per-canvas bespoke provider call is the exact violation this ADR forecloses (Alternatives §1).

---

## Decision

Extend the ADR 0115 image dispatch to its full reach, in four moves that all ride the single seam:

### (a) Wire the dispatch into the slides + drawings editors

A host-ext route — `POST /v1/host/openwop-app/images/generate` and `.../images/edit` — that the editor calls; it invokes `callImageGenerator`/`callImageEditor` and returns the minted **`media:` asset id** (never raw bytes across the boundary, ADR 0115 §D). The editor then sets that ref on the canvas object through the **existing doc-mutation path** — a slide `image` block's `src` (`blockCatalog.ts:46`) or a drawings image object — persisted and validated by the existing `validateSlidesDoc` / `validateDrawingDoc` closed-world validators. No new mutation channel, no new envelope kind (justified in matrix row 5).

**Editor UX contract (per canvas):**
- **Insert-generated** — a "Generate image" affordance in the block/object insert menu opens a prompt + provider/model/size picker (BYOK-gated via the existing Connections chooser; honest-off card when no provider is wired). On success the returned `media:` asset is inserted as a new image block/object.
- **Edit-selection → mask flow** — with an existing image block/object selected, "Edit with AI" offers: **generative-fill/inpaint** (the user paints a mask over the selection → `maskBase64` + prompt), **background-remove** (one click, no prompt), **upscale** (2×/4×). The result mints a **new** `media:` asset (never mutates the source asset in place — dedup/rendition lineage and replay both depend on immutability) and swaps the block/object's ref.

### (b) Edit operations — the `callImageEditor` / `callImageUpscaler` siblings

`ctx.callImageEditor({ image, op, prompt?, mask?, provider?, model? })` → `{ images: [{ mediaRef, mimeType }] }`, the `callImageGenerator` sibling:
- `op:'inpaint'` (aka generative-fill) — requires `mask`; provider paints the masked region from `prompt`.
- `op:'edit'` — whole-image edit from `prompt`, no mask.
- `op:'background-remove'` — no prompt; returns a transparent-background PNG.

`ctx.callImageUpscaler({ image, scale, provider?, model? })` → same result shape (`scale ∈ {2,4}`, the existing `image-upscale.config.json`).

**Provider capability matrix — honest, with typed failures.** Not every provider does every op; an unsupported (provider, op) pair is a **typed `host_capability_missing`** (never success-with-empty, never a silent fallback to another provider):

| op | OpenAI (`gpt-image-1`) | Google Imagen | Replicate (SDXL/FLUX + task models) |
|---|---|---|---|
| generate | ✓ | ✓ | ✓ |
| edit (whole-image, prompt) | ✓ (`/images/edits`) | ✗ → typed fail | ✓ (img2img models) |
| inpaint / generative-fill (mask) | ✓ (mask param) | ✗ → typed fail | ✓ (inpaint models, e.g. SDXL-inpaint) |
| background-remove | ✗ → typed fail | ✗ → typed fail | ✓ (dedicated model, e.g. rembg/BiRefNet) |
| upscale (2×/4×) | ✗ → typed fail | ✗ → typed fail | ✓ (Real-ESRGAN-class) |

The editor's op menu is **capability-gated per the connected provider** — an op the provider can't do is disabled with a "not supported by <provider>" hint, not offered-then-failed. The default provider for edit/upscale/bg-remove is **Replicate** (the only vendor covering the full raster op set), with OpenAI as the inpaint/edit alternative.

### (c) Replicate-class provider (SDXL / FLUX family)

Add `replicate` to `NATIVE_IMAGE_PROVIDERS` (`dispatchImages.ts`) as a BYOK Connection (ADR 0024). Two wrinkles the dispatcher handles, both mirroring existing patterns:
- **Async prediction model.** Replicate is create-prediction → poll `GET prediction`; the dispatcher polls under the host `runWithTimeout` wall-clock (the same timeout wrapper the native path already uses), typed `provider_timed_out` on exhaustion.
- **Output is a URL, not base64.** Replicate returns `output: [<image-url>]` on `replicate.delivery`. The dispatcher fetches those bytes via `brokeredFetch` (SSRF-guarded — this is the one image path touching a non-fixed host) and hands base64 to `storeMediaAsset`, so raw bytes still never cross the node/result boundary.

Model selection is BYOK + `model` param (e.g. `stability-ai/sdxl`, `black-forest-labs/flux-*`, a background-remove model, an upscale model). The provider's fixed API host (`api.replicate.com`) is pinned; the discovery advert stays honest (§ RFC verdict).

### (d) Budget / quota composition — converge onto ADR 0106

Close the split the audit found. Image ops meter under the **ADR 0106 media budget** (`aiProviders/mediaBudget.ts`), not the standalone `imageGenBudget.ts`:
- Add an **`images` unit** to `checkMediaBudget` / `recordMediaUsage` and to the editable `GovernancePolicy.mediaBudget` (`{ ttsChars?, sttBytes?, images? }`), so an operator caps image spend in the **same** Governance panel + `PUT …/governance/media-budget` route as TTS/STT (read-modify-write, superadmin, audited — ADR 0106 §Editable-override).
- **Pre-flight** at the editor routes + the enqueue path: `estimateMediaCost({ kind:'images', n, provider, model })` returns the unit projection `{ used, cap, nextTotal, exceeded }` (the ADR 0106 unit-projection posture — NOT a fabricated USD figure); over-budget ⇒ synchronous `429` before any provider call (no dispatch, no charge).
- **Metered by images returned, post-dispatch** (the real figure), so replay double-charges nothing (ADR 0106 §9).
- `imageGenBudget.ts` is **retired** in the same phase (its `OPENWOP_IMAGE_MAX_PER_DAY` maps to a per-org `mediaBudget.images` default) — one budget module, no drift. This corrects, in code, the ADR 0115 plan-vs-ship divergence.

### Asset-provenance metadata

Every generated/edited asset records provenance on the Media asset (extending the `metadata` already stamped at `aiProvidersHost.ts:1036/1077`): `{ prompt, provider, model, op?, seed?, sourceAssetId?, costUnit:'images' }`. This makes the Library/workbench show *how* an image was made, lets dedup treat a regenerate as distinct, and gives the safety surface (OQ-2) an audit trail. `sourceAssetId` links an edit/upscale result to its input for lineage.

### Safety-filter handling (passthrough)

Provider-side moderation (OpenAI/Google/Replicate all refuse disallowed prompts) surfaces as a **typed `provider_content_filtered`** failure carrying the provider's refusal reason (never the key, never a fabricated image). The editor shows a clear "the provider declined this prompt" state. A host-side content policy on *generated* images stays OQ-2 (ADR 0115 OQ-4 carried forward) — v1 is provider-passthrough, consistent with ADR 0115.

### RBAC & isolation (ADR 0006)

Unchanged from ADR 0115. The editor routes require `workspace:write` in the canvas's org (`accessControlService.ts`) + the per-tool gate (ADR 0102) for the image ops; the provider credential resolves from the run/tenant Connection, never request input; minted asset URLs are tenant-scoped (uniform-404 IDOR-safe). Editing another tenant's canvas or reading its asset is a uniform 404.

### Replay / fork safety — the load-bearing invariant

**Generation and editing are non-deterministic; a run stores the RESULT `media:` asset id, and replay/`:fork` reads it verbatim — the image is NEVER re-generated.** This is the ADR 0083 invariant exactly (the base64/url→`media:` mint is guarded by a bookkeeping row on the deterministic `${runId}:${nodeId}`; a re-exec returns the existing asset id without re-minting; producer hook gated `forkMode !== 'replay'`). The editor affordances run through nodes/host routes that persist the asset id into the canvas doc, so opening a slide/drawing never re-calls a provider. `:fork` in `branch` mode legitimately mints a new image under the new runId. Cost metered post-dispatch ⇒ no replay double-charge.

Recommend `/architect` (the editor↔dispatch seam + Replicate async/broker path + budget convergence) + `/nfr` (SSRF on the Replicate output fetch, capability honesty, spend) at implementation.

---

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | **Reach across existing packages, no new one.** The dispatch/host caps live in `providers/` + `aiProviders/` (where ADR 0115 put them — there is no `features/image-gen/` dir, by design); the editor affordances live in `features/slides/` + `features/drawings/`; the budget in `aiProviders/mediaBudget.ts`. Zero new core route/nav. |
| 2 | Toggle + admin UI | **No new toggle.** Affordances gate on the host `slides`/`drawings`/`media` toggles they live in + the existing `image-gen` capability gate (`imageGenerationAdvertised()` / a wired provider). A fourth toggle would gate a capability that is already gated twice (feature toggle + provider-configured honesty) — redundant. Budget config is the ADR 0106/0077 Governance panel (now with an `images` field). Optional admin: an image-gen quota/moderation readout (gap-analysis "imagegen quota/moderation panel — S"). |
| 3 | Workflow surface (`ctx.<feature>`, ADR 0014) | **No new `ctx.<feature>`.** `callImageEditor`/`callImageUpscaler` are host AI-provider seams on the existing `aiProviders` adapter (the `callImageGenerator`/`callSpeechSynthesizer` precedent), not `ctx.features.X`. |
| 4 | Node pack | **Already shipped, now filled.** `core.openwop.ai.image-generate`/`image-edit`/`image-upscale` exist as delegate shims; this ADR implements the `callImageEditor`/`callImageUpscaler` host caps two of them delegate to. Background-remove is an `op` on `image-edit`, not a new node. A `replicate` provider is config, not a pack. |
| 5 | AI-chat envelopes | **None new — and a new envelope kind is explicitly rejected.** Editor mutations ride the existing **doc-validate persist** path (a `media:` ref set on a slide `image` block / drawings image object → `validateSlidesDoc`/`validateDrawingDoc` closed-world validation); agent-driven insertion rides the existing **`slides.design` node pipeline** (whole-doc validate/repair). Per the CLAUDE.md hard rule ("node/component/artifact schemas are tool asks, NOT envelope kinds; a new envelope kind = OpenWOP RFC first"), a `slide.image.generate` envelope would force a wire RFC for zero benefit — images already have a home (a media asset id on a validated block). Schema SSoT + parity is enforced where it belongs: the node I/O schemas (`image-edit.*.json`, `image-generate.*.json`) are the SSoT, pinned by the existing `promptCatalogParity`/`agent-prompt-tool-ids` tests, and the LLM-EXCHANGE-AUDIT rows below track the model-facing edit ops. |
| 6 | Agent pack | **Extend the existing `feature.image-gen.agents` "Image Designer"** — add `openwop:core.openwop.ai.image-edit` / `.image-upscale` to its allowlist so the persona can edit/inpaint/upscale, driven through the existing chat (ADR 0058). No new persona. |
| 7 | Public surface | **None** — authenticated, org-scoped editor routes only. No anonymous image generation (abuse/cost surface). |
| 8 | RBAC + isolation (ADR 0006) | **Unchanged.** `workspace:write` + per-tool gate; credential from the tenant Connection; tenant-scoped asset URLs; uniform-404 IDOR. Editing/reading a cross-tenant canvas or asset → 404. |
| 9 | Replay / fork | **Store the result asset id; read verbatim on replay/`:fork`; never re-generate** (ADR 0083 deterministic-key bookkeeping). Cost metered post-dispatch (no double-charge). The invariant is stated normatively above. |
| 10 | Frontend | Two canvases × two affordances: **slides** (insert-generated block + edit-selection on an `image` block) and **drawings** (insert-generated object + edit-selection on an image object), sharing ONE `ui/` image-gen dialog component (prompt/provider/model/size + mask painter + op picker), BYOK-gated, honest-off card, capability-gated op menu, all-locale copy (**i18n ×4**, FATAL if any locale is missing per the frontend-i18n gate). Governance panel gains an `images` budget field (×4 locales). Reuse `ArtifactPreviewModal`/`LibraryPage` for the result — no new renderer. |

---

## Phased plan

Ordered per the prompt: **(a) wiring → (c) Replicate → (b) edit ops → (d) budget polish.** (Replicate lands before the edit ops because it is the only provider covering the full raster op set, so (b) has a real backend to target — faking edit support on OpenAI/Imagen would violate advertise-only-honored-behavior.)

1. **(a) Editor wiring — generate.** `POST …/images/generate` (invokes `callImageGenerator`, returns `media:` id); slides + drawings **insert-generated** affordance → media ref set on a new block/object via the existing doc-validate persist. One shared `ui/` dialog, BYOK-gated, honest-off, i18n ×4. Tests: route auth + budget pre-flight; media asset minted; block/object ref persisted + validates; replay reads verbatim (no re-gen); FE dialog states.
2. **(c) Replicate provider.** Add `replicate` to `NATIVE_IMAGE_PROVIDERS`; async-prediction dispatch under `runWithTimeout`; output-URL fetch via `brokeredFetch`; BYOK Connection registration; provenance `provider:'replicate'`. Discovery advert stays honest. Tests: prediction poll → base64 → media asset; timeout → `provider_timed_out`; broker fetch SSRF-guarded; honest-off without credential; key-never-echoed.
3. **(b) Edit ops.** Implement `callImageEditor` (`op: inpaint|edit|background-remove`, mask threading) + `callImageUpscaler` (scale 2/4); the provider capability matrix with **typed `host_capability_missing`** for unsupported (provider, op); wire the shims (`index.mjs:361/367`); the editor **edit-selection → mask** flow (mask painter, bg-remove, upscale), capability-gated op menu; result mints a NEW asset with `sourceAssetId` lineage. Extend the Image Designer allowlist. Tests: inpaint roundtrip (mask honored), bg-remove (transparent PNG), upscale (2×/4×), unsupported-op typed fail, new-asset-not-mutate, lineage metadata, edit replay verbatim, `provider_content_filtered` passthrough.
4. **(d) Budget convergence.** Add `images` unit to `mediaBudget` + `GovernancePolicy.mediaBudget.images` + `estimateMediaCost({kind:'images'})`; pre-flight at the editor/enqueue routes (429 over-budget); retire `imageGenBudget.ts` (default carried over); Governance panel `images` field (i18n ×4). Tests: cap-hit 429 pre-dispatch, under-cap, off-by-default, replay-no-double-charge, override read-modify-write preserves other fields, migration from `OPENWOP_IMAGE_MAX_PER_DAY`.
5. **Hardening.** `/architect` (editor seam + Replicate async/broker + budget convergence) + `/nfr` (SSRF on the Replicate output fetch, capability honesty, spend); LLM-EXCHANGE-AUDIT rows for the edit ops + their tripwires; asset-provenance surfaced in the Library/workbench; DEPLOY.md operator config for the Replicate Connection + the `images` budget.

---

## As-built record (2026-07-17)

| Move | Landed |
|---|---|
| (a) Editor wiring | `features/media/imageGenRoutes.ts` (generate + image-providers listing, synthetic AdapterScope — the voice/chat precedent), `GenerateImageDialog` + ONE `MediaRefWidget` hook reaching slides + app-builder; **drawings deferred** (no image kind exists — correction note in §Depends). |
| (c) Replicate | `dispatchImagesReplicate` + shared `dispatchReplicateTask` (Prefer-wait + poll under the host signal); output URLs **allowlist-pinned** (`replicate.delivery`/`api.replicate.com`, https, uncredentialed, 25 MiB cap) — **correction:** the fixed-host allowlist provides the brokeredFetch SSRF guarantee without threading Connection deps into the dependency-free dispatcher. |
| (b) Edit ops | `callImageEditor`/`callImageUpscaler` (the generator siblings) + `IMAGE_OP_SUPPORT` honest matrix (typed `host_capability_missing`); OpenAI multipart `/images/edits`; curated Replicate task-model defaults (OQ-3); media `ai-edit`/`ai-upscale` routes minting NEW `derivedFrom`-lineage assets; `EditImageDialog` w/ capability-gated op menu + taint-free mask painter (per-provider mask encoding: white=repaint for replicate, alpha punch-out for openai); executor now binds the image caps into node ctx (**closing the latent gap** — `callImageGenerator` was never in the spread). |
| (d) Budget | **Policy/override/panel converged onto ADR 0106** (`mediaBudget.ts` gains the `images` unit — env default `OPENWOP_IMAGE_MAX_PER_DAY`=50 carried over; Governance panel + PUT route + per-org override incl. explicit-0-uncapped); `host/imageGenBudget.ts` **retired**, its CAS counter absorbed with the SAME `imagegen:budget` collection/keys (purge/fold continuity). **Correction:** the counter stays KV, not a `media_usage` SQL column — the kb embed-budget precedent (a count does not justify a 2-adapter storage migration). |
| Provenance | Media lineage schema extended (`provider`, `op`) + `derivedFrom` for edit/upscale lineage. |

## Alternatives weighed

1. **Per-canvas bespoke image integrations** (slides calls OpenAI directly, drawings calls Replicate directly). **Rejected** — the `no-parallel-architecture` violation; fragments credentials/egress/budget/replay across surfaces. Both editors consume the ONE `callImageGenerator`/`callImageEditor` dispatch; media owns storage; the broker owns egress.
2. **Client-side provider calls** (the editor calls OpenAI/Replicate from the browser with the user's key). **Rejected** — breaks BYOK secret handling (a key in the SPA), bypasses the SSRF broker, the ADR 0106 budget, and the replay/asset-id invariant. All dispatch is host-side; only a `media:` id crosses to the client.
3. **A new `slide.image.generate` envelope kind** (per the task's initial framing). **Rejected** — CLAUDE.md hard rule (new envelope kind = OpenWOP RFC first) + no benefit: images are Media, they ride the existing block/object doc-validate path and the `slides.design` node pipeline. Matrix row 5.
4. **A fourth `image-gen-editor` toggle.** **Rejected** — the capability is already gated by the owning editor's toggle AND the provider-configured honesty flip; a third gate is redundant surface.
5. **Keep the separate `imageGenBudget.ts` counter.** **Rejected** — it is the exact fork ADR 0106 §Alternatives rejected; the split is a drift liability (two budget modules, two override surfaces). Converge onto ADR 0106.
6. **Re-generate on replay/fork.** **Rejected** — non-deterministic + double-spend; record-and-read-verbatim is the ADR 0083/0106 invariant.

---

## Open questions

1. **OQ-1 — Vertex vs Google-API Imagen duplication.** `dispatchImages.ts` uses the **Gemini Developer API** (`generativelanguage.googleapis.com`, `x-goog-api-key`). MyndHyve's baseline used **Vertex Imagen** (`aiplatform.googleapis.com`, OAuth/service-account). Do we add Vertex as a *distinct* provider entry (`google-vertex`, service-account auth) or stay Gemini-API-only? Lean: **Gemini-API-only for v1** (BYOK-simple, already shipped); add Vertex behind the same `callImageGenerator` only if an operator needs the enterprise auth/quota path — avoid two Google entries that dispatch the same model family.
2. **OQ-2 — Content-safety policy surface.** Provider-passthrough (v1, `provider_content_filtered`) vs a host-side content policy on generated images (a moderation hook + an operator-configurable policy). Carries ADR 0115 OQ-4 forward. Propose provider-passthrough v1; a host hook + the "imagegen quota/moderation panel" (gap-analysis S) as a fast follow if abuse surfaces.
3. **OQ-3 — Replicate model curation.** Ship a curated model allowlist (a known-good SDXL/FLUX + inpaint + bg-remove + upscale set) vs let BYOK operators pass any `owner/model`? Lean: a curated **default set** per op (so the editor op menu is populated) + an operator override — the model-allowlist surface in the gap backlog.
4. **OQ-4 — Mask authoring UX.** A freehand brush mask (matches the "no raster brush engine" decision ironically — but a *mask* is not a *drawing*) vs rectangle/lasso region select vs auto-subject-mask (SAM-class). Lean: brush + rectangle v1; auto-subject-mask as a follow-on if providers expose it cheaply.
5. **OQ-5 — Upscale as a rendition vs a new asset.** Upscale produces a strictly-derived image; does it belong in the ADR 0352 rendition pipeline (a "4x" rendition of the source asset) rather than a new top-level asset? Lean: **new asset with `sourceAssetId`** for v1 (simpler lineage, replay-clean); revisit folding into renditions if the Library clutters.

---

## RFC verdict (Step 5)

**Default host-extension — NO new RFC.** This ADR (a) wires an **already-implemented** host capability into two editors via non-normative `/v1/host/openwop-app/*` routes, (b) implements the **already-declared** `callImageEditor`/`callImageUpscaler` host caps (the `callImageGenerator`/`callSpeechSynthesizer` siblings), (c) adds a provider *behind* the existing dispatch, and (d) extends the ADR 0106 budget. Nothing new touches the openwop wire; no new envelope kind (Alternatives §3).

**EVALUATE — advertising honesty (`/.well-known/openwop`).** `discovery.ts:562` advertises `imageGeneration:{ supported }` as a cross-host-observable claim, honest-flipped by `imageGenerationAdvertised()`. If **edit/upscale** is to be advertised as a *distinct* cross-host capability (so a remote A2A agent relies on "image-edit"), it must extend the **same honest-flip** (advertise `imageEdit:supported` only when a provider that does the op is wired) AND — because that would be a **new normative capability claim not covered by an existing RFC** — earn a **new openwop RFC ≥ Accepted before advertising `supported:true`** (exactly how `imageGeneration` rides the ADR 0115 EVALUATE line and `speechSynthesis` rides RFC 0105). Until/unless we make that cross-host claim, edit/upscale stays an **in-tenant capability only** (BYOK editor use is not a wire advert) — no advert, no RFC. Adding `replicate` changes no advert (it is one more provider behind the same `imageGeneration` flag). Host-ext routes never need an RFC.
