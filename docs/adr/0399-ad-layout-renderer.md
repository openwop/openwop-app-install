# ADR 0399 — Static ad-layout renderer with platform safe-zones (brief → composed ad creative)

| Field | Value |
|---|---|
| **Status** | implemented (all 5 phases, 2026-07-17) |
| **Date** | 2026-07-17 |
| **Feature** | extends **`creative-briefs`** (ADR 0353) — toggle id **stable** (`creative-briefs`), no new toggle |
| **Closes** | MYNDHYVE-GAP-ANALYSIS §Ads "Static ad-layout renderer w/ platform safe-zones (M)" (the one real Ads Studio piece only partially ported — line 51 / §260) |
| **Composes** | creative-briefs entity + snapshot/versioning (ADR 0353), media assets + content-hash + renditions-geometry (ADR 0007 / 0352), image-generation seam for layer backgrounds/product shots (ADR 0115), ads-dispatch media-upload legs (ADR 0167 / 0223), brand kit logo/palette/typography (ADR 0155 / 0354), artifact projection into chat (ADR 0069 / 0083) |
| **RFC verdict** | **Host-ext, no new RFC.** In-tenant deterministic rendering that stores a Media asset and rides the already-Accepted ads-dispatch seam (RFC 0045/0046/0047/0079/0095). Nothing touches the OpenWOP wire. |

## Context (boundaries audit)

Today `creative-briefs` (ADR 0353) produces a **structured visual brief** — scene/composition/camera/lighting/`brandPalette`/`platformSpec` + 2–3 creative directions + a media mood board (`features/creative-briefs/types.ts:36-63`) — and PDF-exports a *markdown projection* of it (`routes.ts:59`). There is **no composed, rendered ad**: no pixels, no per-platform layout, no safe-zone check. The gap analysis names this the highest-value ad gap (MYNDHYVE-GAP-ANALYSIS §260: "captures the *brief* but doesn't render a composed static ad with platform safe-zone overlays").

Who owns what, and where the seam already exists:

- **The brief is the input, and it already carries the layout signal.** `CreativeBrief.platformSpec?: { platform, format, textRulePct? }` (`types.ts:29-34,50`), `brandPalette?: string[]` (`:48`), `directions[]` (`:52`), `moodBoard[]` (`:53`). `platformSpec` is admitted "advisory number, not enforced here" (`:32`) — this ADR is what enforces it geometrically. **creative-briefs stays the SoT of the brief; the renderer never mutates a brief**, it projects one.
- **Media owns assets + bytes + content hashing + rendition geometry** (`media/mediaService.ts:317` `createAsset`; SHA-256 dedup + `deriveRenditions` pure-geometry crops per ADR 0352). ADR 0352 §5 deliberately shipped renditions as **geometry, no native raster dependency**, and named the exception explicitly: *"raster derivation is a flagged follow-on if a platform upload leg needs real bytes (ads media legs currently upload originals)."* **This ADR is that named follow-on** — a composed ad is precisely a raster the upload leg needs. The renderer stores its output through `createAsset` (marketing facet, hash-dedup) — no new media store.
- **The ads-dispatch media leg already accepts a rendered asset by id.** ADR 0223: Meta's `adimages` leg and TikTok's image-upload leg resolve `mediaAssetId` → bytes **host-side** and thread the returned `image_hash` / `image_id` into the creative (`0223 §Per-platform deltas`; `PublishAdArgs.mediaAssetId`). **So attachment needs zero change to `host/adsAdapter.ts`** — a rendered creative stored as a media asset flows through the existing `publish-ad-variants` → media leg with only its `mediaAssetId`. That is the whole "attach to a real campaign" story, and it is already built.
- **Layer imagery is the image-gen seam.** `ctx.callImageGenerator` (ADR 0115, native BYOK dispatch as of 2026-07-17) produces backgrounds / product shots stored as Media assets — those become the renderer's background / product layers by `mediaAssetId`, same as mood-board items.
- **Brand tokens have an owner.** `brand` (`brandService.ts:275-322`): `logo.{markSrc,lockupSrc}`, `palette`, `typography.{serif,sans}` (CSS-safe stacks). The renderer READS the brand kit for logo + colors + font family; `brief.brandPalette` supplements/overrides. Never a second brand store.
- **Route/toggle:** stays `creative-briefs` (stable); the render surface is a submodule of the same feature package (the ADR 0352-extends-`media` precedent). `feature.creative-briefs.*` node namespace is **free** — ADR 0353 shipped with **no node/agent pack** (its as-built §"No node/agent packs in v1"), so this ADR lands the first `feature.creative-briefs.nodes` pack.

  > **Correction (implementation, 2026-07-17):** stale by the time of implementation — the NP-HOLE-CB-1 remediation had already landed `feature.creative-briefs.nodes@1.0.0` (create/list/get) with a `requiredPacks` pin in `feature.ts`. Phase 3 therefore **extends** the existing pack to **1.1.0** (adds `render`, `render-variants`, `list-render-templates`) instead of creating a first pack.

**Where does rendering live — server vs client, and with what?** (the load-bearing decision)

The output must become **real PNG/JPG bytes** (the ad platforms upload bytes; a client-only `<canvas>` preview can't feed the host-side dispatch leg, can't be replay-recorded, and can't be dedup-hashed). So the composed raster is produced **server-side, in-process**, mirroring the ADR 0328 slides export decision (pptx/pdf via `pdfkit`/`pptxgenjs` **in-process, no headless browser**). Library evaluation, honestly:

| Approach | Verdict | Why |
|---|---|---|
| **Deterministic SVG string → `@resvg/resvg-js` → PNG** | **CHOSEN** | We own every layer coordinate (template geometry), so we emit a deterministic SVG document and rasterize it. `@resvg/resvg-js` is a Rust/napi library shipping **prebuilt per-platform binaries** (no compile step, no Chromium — the `esbuild` model), loads embedded font buffers, and is byte-deterministic for a fixed input + font set. SVG is also the exact source we overlay safe-zones onto and hand the FE for preview (same document, no second renderer). **Correction (implementation):** the SVG stays a **server-internal intermediate** — `image/svg+xml` is deliberately excluded from storable media mimes (stored-XSS guard), so the FE preview shows the **PNG** and draws the safe-zone overlay from **template geometry JSON** (`GET /render-templates`), never from an injected SVG document. |
| **satori (JSX/flexbox → SVG) + resvg** | Rejected for v1 | Satori adds a flexbox layout engine we don't need (our templates are absolute-positioned by design) and introduces line-break/font-shaping variability that complicates the same-pixels replay guarantee. Kept as a **noted future** if free-form text-flow layouts are ever wanted. |
| **node-canvas (Cairo)** | Rejected | Requires a **native Cairo build** — the exact native-image dependency ADR 0352 §Alternatives refused; heavier ops surface than a prebuilt binary, no gain over SVG for absolute layout. |
| **Headless Chromium (puppeteer/playwright) screenshot** | Rejected | Ships a browser into Cloud Run (cold-start + memory + security surface), non-deterministic across Chromium versions (font hinting, sub-pixel AA) → breaks replay pixel-stability, and duplicates a rendering stack the app pointedly avoided in slides export. |

## Decision

Add a **deterministic ad-layout renderer** to the `creative-briefs` feature: `brief + platform layout-template + resolved asset bytes + brand tokens (+ optional per-layer nudges)` → a composed **SVG** → **PNG/JPG bytes** via `@resvg/resvg-js`, stored as a **Media asset** (marketing-faceted, hash-deduped), attachable to a real campaign through the **existing** ads media-upload leg. v1 is **template-driven render + preview with light nudge editing — NOT a free-form canvas editor** (justified below).

### 1. Layout-template model (static reference catalog, per platform+format)

A versioned, code-owned catalog (`features/creative-briefs/render/templates.ts` — a static SSoT like `providers.json`, NOT tenant data), one entry per `(platform, format)`:

```
AdLayoutTemplate {
  templateId, version,                       // e.g. "meta.feed.1x1@1"
  platform, format, width, height,           // exact platform pixel dimensions
  safeZones: [{ id, x, y, w, h, label }],    // platform UI-overlap rects (geometry)
  layers: [{                                 // absolute-positioned slots, z-ordered
    id: 'background'|'product'|'headline'|'body'|'cta'|'logo',
    kind: 'image' | 'text' | 'shape',
    box: { x, y, w, h }, anchor, z,
    type?: { fontRole:'sans'|'serif', sizePx, weight, align, maxLines, color:'token' },
    fit?: 'cover'|'contain', radiusPx?, padPx?,
  }],
}
```

Shipped set (v1): **Meta** feed 1:1 (1080×1080) · story/reel 9:16 (1080×1920); **TikTok** 9:16 (1080×1920); **LinkedIn** single-image 1.91:1 (1200×627); **Google Display** the fixed IAB sizes 300×250 / 728×90 / 160×600 / 300×600. Safe-zone rects are authored from each platform's published safe-area guidance (TikTok right-rail + bottom caption band; Meta story top/bottom system UI; etc.) and are **data**, not code branches.

### 2. Deterministic render function (replay-relevant)

```
renderCreative({ briefSnapshot, template, resolvedLayerAssets, brand, overrides? })
  → { svg, png|jpg bytes, warnings[] }
```

- **Layer resolution:** background/product ← `mediaAssetId` (mood-board item, image-gen output, or attached asset) resolved to bytes host-side + embedded as a `data:` URI in the SVG; headline/body/CTA ← the chosen direction's copy (brief fields) type-set into the text layers; logo ← brand `logo.markSrc/lockupSrc`; colors ← `brief.brandPalette` ⊕ brand `palette` (brief wins); fonts ← brand `typography` family mapped onto the **bundled font set** (§Open Q1).
- **Determinism (the same-pixels guarantee):** identical `(briefSnapshot content-hash, templateId+version, each layer asset SHA-256, brand snapshot hash, bundled-renderer version, overrides)` ⇒ **identical bytes**. Fonts are **embedded from bundled buffers** (never fetched at render — a network font would break determinism and add SSRF surface); asset bytes are **pinned by content hash** (the SHA-256 media already stores per ADR 0352). No wall-clock, no RNG, no locale-dependent shaping.

### 3. Variant generation across formats (one brief → many renders)

`renderVariants(brief, [templateId…])` fans the same brief content across a template family — Meta feed + story + TikTok + LinkedIn + Google sizes — each produced by its own template's geometry (re-flowed, not stretched). One approve, N platform-correct creatives. Each is an independent deterministic render (its own composite hash → its own media asset).

### 4. Safe-zone validation warnings (advisory, non-blocking)

After layout, a pure-geometry check: for each text/logo/CTA layer bbox, does it intersect any template `safeZone`? An intersection emits a `warnings[]` entry (`{ layerId, safeZoneId, overlapPct }`). Also surfaces the Meta 20%-text advisory (`platformSpec.textRulePct`) as a warning when the text layers exceed it (bbox-area heuristic). **Warnings never block render or dispatch** — they mirror ADR 0223's posture that spend-shaping / on-platform correctness is a human review step; they inform the reviewer before the ADR 0167 approval gate.

### 5. Brand-token application

Colors, logo, and font family come from the `brand` kit (`getBrand`) at render time; `brief.brandPalette` supplements. Missing brand kit ⇒ neutral defaults + a warning (honest degradation, never a hard fail). Logo raster embed follows the ADR 0328 SSRF-free rule: bytes only, resolved host-side from a brand asset / media id, never a render-time external fetch.

### 6. Attach to a real campaign (zero adapter change)

The composed PNG is stored via `media.createAsset` (marketing facet `{ product, angle, format }`, content-hash dedup). Its `mediaAssetId` is what `publish-ad-variants` already threads into the **existing** Meta `adimages` / TikTok image-upload leg (ADR 0223). Rendering and dispatch stay decoupled through the media library — the renderer never calls the ads adapter, and the adapter's created-PAUSED + approval-gate + fork-stable idempotency invariants are untouched.

### 7. Scope boundary — why NOT a free-form canvas editor in v1

An ad creative is a **deterministic projection of a brief**, not a hand-authored living document. The canvas chassis (ADR 0310) exists for free-form documents (slides, drawings, app-builder); adopting it here would (a) fork the brief↔render relationship into drift (a hand-edited canvas no longer tracks its brief), (b) duplicate three existing canvas surfaces, and (c) defeat the same-pixels replay guarantee. v1 therefore ships **template render + preview + bounded per-layer nudge** — `overrides: { [layerId]: { dx, dy, scale } }` clamped to a small range, stored on the render record, re-applied **deterministically** (they enter the composite hash). Free-form layout is a named future, gated on real demand, and would be a distinct canvas-type decision — not a scope creep of this ADR.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | Extends `creative-briefs` — a `render/` submodule (renderer, template catalog, safe-zone check). Same owner as the brief entity; no new package (the ADR 0352-extends-`media` precedent). |
| 2 | **Toggle + admin UI** | Toggle **`creative-briefs` STABLE** — no new toggle (rendering is depth on the existing feature). Off by default with the feature. |
| 3 | **Workflow surface (`ctx.features`)** | `ctx.features['creative-briefs'].render({ briefId, templateId, directionIndex?, overrides? })` + `.renderVariants(...)` behind toggle+RBAC; returns `{ mediaAssetId, warnings }`. |
| 4 | **Node pack** | **New `feature.creative-briefs.nodes`** (ADR 0353 shipped none): a `brief.render` node (brief+template → media asset + warnings) and a `brief.render-variants` node. Signed; manifest input-docs pin the template ids + fail-closed reasons. |
| 5 | **AI-chat envelopes** | **None new — honest.** Render is a **node/tool ask** returning a **Media artifact** via the existing projection (ADR 0069/0083), exactly the ADR 0115 image-gen precedent (image renders as Media, no new envelope). Per the three-lanes rule, a node/artifact schema is a **tool ask, not an envelope kind** — `brief.render` is NOT an RFC 0021 envelope kind. |
| 6 | **Agent pack** | **None new.** Driven through the existing chat via the ADR 0353 Creative Director / channel agents, allowlisting the render node (ADR 0058 agent+nodes). No new panel. |
| 7 | **Public surface** | None. The composed asset is shareable ONLY through the existing media/brief sharing resolvers (approved-only, tokened, uniform-404); no anonymous render route. |
| 8 | **RBAC + isolation (ADR 0006)** | Unchanged. Render requires `workspace:write` in the brief's org; brief read `workspace:read`; media reads authorize per-record via `resolveEffectiveAccess` (uniform-404 IDOR); asset bytes resolve tenant-checked host-side. Fail-closed. |
| 9 | **Replay / fork** | Deterministic: the composed PNG is a **recorded Media artifact** keyed on the composite render hash (§2); on replay/`:fork` it is read **verbatim, never re-rendered** (the ADR 0083/0115 record-and-read invariant). Assets pinned by content hash; fonts + renderer version bundled → pixel-stable across replays. **Correction (implementation):** the verbatim-read *mechanism* is the recorded **action-node result** (`runArtifactStore`'s first-write-wins `${runId}:${nodeId}` bookkeeping — the generic ADR 0083 invariant); the composite hash's jobs are **provenance** (which inputs produced these pixels) and **media dedup** (identical inputs land on the same asset row). Renderer-version + font-set + asset-hash sensitivity is test-pinned (`creative-briefs-render-pack.test.ts`). |
| 10 | **Frontend** | On the existing `/creative-briefs` page (ADR 0353): a **Renders** tab — a **format gallery** (one card per platform/format), a **preview with a safe-zone overlay toggle** (the SVG safe-zone rects drawn over the composed image), the warnings list, and the **light nudge editor** (per-layer dx/dy/scale sliders, clamped). Reuses `ui/` + the artifact workbench preview; 4-locale i18n (the `check-i18n` gate is FATAL). A "Use in campaign" action hands the `mediaAssetId` to `publish-ad-variants`. |

## Phased plan

| Phase | Ships | Gate |
|---|---|---|
| **1 — Renderer core** | `@resvg/resvg-js` dep + bundled font set; `render/templates.ts` (Meta feed/story, TikTok, LinkedIn); `renderCreative` (SVG→PNG, brand tokens, bundled fonts); determinism test (same input → identical bytes); store via `media.createAsset` (hash-dedup). | backend tsc + vitest |
| **2 — Safe-zones + warnings** | Safe-zone rects on every template; geometry intersection check + `textRulePct` advisory → `warnings[]`; tests (overlap detected / clean / advisory). | backend vitest |
| **3 — Node pack + surface** | `feature.creative-briefs.nodes` (`brief.render`, `brief.render-variants`); `ctx.features['creative-briefs'].render*`; Google Display fixed sizes; variant fan-out; agent allowlist. | backend vitest |
| **4 — Replay pinning** | Composite-hash keyed media artifact; replay/`:fork` reads verbatim (no re-render); asset-hash + font + renderer-version pinning test. | backend vitest |
| **5 — Frontend** | Renders tab: format gallery + preview + safe-zone overlay toggle + warnings + nudge editor + "Use in campaign" (→ `publish-ad-variants` `mediaAssetId`); 4-locale i18n. | `cd frontend/react && npm run build` |

Each phase: `/architect` before (replay determinism + the media/ads seam), `/code-review` after; `/ux-review` on Phase 5.

### As-built record (2026-07-17)

| Phase | Landed |
|---|---|
| 1 — Renderer core | `render/{templates,fonts,renderCreative,renderService}.ts`, routes, determinism + injection + IDOR tests (`creative-briefs-render.test.ts`) |
| 2 — Safe zones | `render/safeZones.ts`, story/TikTok rects, safe-by-design story geometry, advisory `textRulePct` |
| 3 — Node pack + surface | `feature.creative-briefs.nodes@1.1.0` (+`render`/`render-variants`/`list-render-templates`), `ctx.features['creative-briefs'].render*`, 4 Google Display templates, Channel Generator allowlist + prompt |
| 4 — Replay pinning | composite-hash sensitivity + exact-resvg-version tripwire + role:action pins (`creative-briefs-render-pack.test.ts`); ADR correction notes |
| 5 — Frontend | `RendersSection.tsx` (format chips, PNG preview + geometry-JSON safe-zone overlay, warnings, clamped nudge sliders → re-render, "Use in campaign" copy), 4-locale i18n |

## Alternatives weighed

- **Full free-form canvas editor in v1** — rejected (§7): forks the brief↔render link into drift, duplicates three canvas surfaces, defeats replay pixel-stability. Nudge-only in v1; free-form is a future canvas-type decision on real demand.
- **Headless-browser (Chromium) screenshot rendering** — rejected: ships a browser into Cloud Run (cold-start/memory/security), non-deterministic across Chromium/font versions (breaks the same-pixels replay guarantee), and duplicates a stack slides export deliberately avoided (ADR 0328 in-process pptx/pdf).
- **node-canvas (Cairo)** — rejected: the native-image dependency ADR 0352 §Alternatives explicitly refused; a prebuilt-binary rasterizer over deterministic SVG is lighter and sufficient for absolute layout.
- **satori + resvg** — rejected for v1 (flexbox layout we don't need + shaping variability vs. our absolute-positioned, deterministic templates); noted as the future path if free-form text-flow layouts are wanted.
- **External creative-automation API (Bannerbear / Creatomate / Templated.io)** — rejected: (a) it puts brief content + brand assets + logos on a third-party render service (a data-egress + BYOK-parity break — the app renders in-tenant everywhere else), (b) breaks the replay/determinism guarantee (opaque remote renderer, versioned externally), (c) adds a paid dependency + connection pack for something a ~200-line in-process SVG renderer covers, and (d) is the exact "external creative service" the in-process slides/pdf/pptx decisions already declined. A future adapter behind the same `render` surface is possible if a template-marketplace need appears, but it is not the v1 seam.

## Open questions

1. **Font licensing + rendering.** v1 bundles a small **open-licensed** family set (e.g. Inter / a serif + a condensed display face, SIL OFL) embedded as buffers → deterministic, redistributable. A **brand custom font** is a follow-on: it needs a font-file upload path + an operator license attestation before we embed a licensed face into an exported raster. Brand `typography` stacks map onto the bundled set until then (nearest-match + a warning when the brand font isn't bundled).

   > **Resolved (2026-07-17):** brand custom fonts shipped. A brand-owned `brand:font` store (attestation-gated) holds an uploaded TTF/OTF per role; the operator attests redistribution rights (hard 400 without it). The renderer extracts the font's REAL internal family from its `name` table (an operator typo can't silently fall back), embeds the buffer into the resvg set, and folds the font sha into the composite hash (a font change re-pixels; recorded renders read verbatim). `deleteBrand` cascades the font rows. WOFF/WOFF2 + collections rejected (resvg raw-font only). Brand settings gains an Ad-fonts upload section.
2. **Animated / video formats (reel video, animated display)** — **deferred.** v1 is **static** only. Motion is a distinct pipeline (frame sequencing + a video encoder + far heavier compute) and out of scope; the 9:16 "reel" template renders a static first-frame creative.

   > **Resolved (2026-07-17):** the IN-POSTURE slice shipped — **animated GIF** (the `reveal` preset: the foreground fades in over N deterministic resvg frames, encoded with the pure-JS `gifenc`; no heavy encoder, no native binary). Deterministic (resvg + gifenc both are), frame/fps clamped, 20 MiB cap, the last frame equals the static render, animation params fold into the composite hash, and the GIF previews natively in the Renders `<img>`. **MP4 / reel-video stays deferred** — it needs a heavy native encoder (ffmpeg-class), which violates the no-binary/in-process posture the static renderer and slides/pdf export deliberately hold; revisit only behind a demand + a distinct out-of-process encoding decision.
3. **Google Display size coverage.** Ship the four highest-traffic IAB sizes (300×250, 728×90, 160×600, 300×600) in v1; the long tail of display sizes is data-only additions later.

   > **Resolved (2026-07-17):** the long tail landed — added 336×280, 250×250, 970×250 (billboard), 468×60, 320×100, 320×50 (mobile). Data-only template-catalog entries; the pure-renderer test rasterizes the whole catalog and the node-manifest template vocabulary is parity-pinned.
4. **Raster product shots** — the image-gen seam (ADR 0115) can generate a background/product layer on demand; v1 consumes existing `mediaAssetId`s (mood board / attached / previously generated), with generate-into-a-layer as a Phase-3+ convenience.

   > **Resolved (2026-07-17):** the Renders gallery now has per-layer background/product pickers — **Choose** from the library (`MediaPickerDialog`) or **Generate** with AI (`GenerateImageDialog`, the ADR 0401 seam), unset falls back to the mood board. A nudge re-render preserves the original render's layer assets (threaded via `CreativeRender.layerAssets`). Backend already accepted explicit `layers` overrides for any org asset; this wires the FE. Composes ADR 0399 × ADR 0401.

## RFC verdict

**Host-ext, no new RFC.** Deterministic in-tenant rendering that persists a Media asset (ADR 0007/0352 surfaces) and attaches through the **already-Accepted** ads-dispatch seam (RFC 0045/0046/0047/0079/0095, ADR 0167/0223). No new run-event, capability flag, envelope kind, or endpoint contract touches the OpenWOP wire — the render node returns a Media artifact through the existing projection, and dispatch is unchanged. Host-extension routes stay under `/v1/host/openwop-app/*`.
