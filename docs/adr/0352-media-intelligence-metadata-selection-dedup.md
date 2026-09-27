# ADR 0352 — Media intelligence: marketing metadata, AI auto-tagging, weighted selection, dedup, renditions

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–6, 2026-07-12 — FE facet editor deferred, see corrections) |
| **Date** | 2026-07-12 |
| **Feature** | extends **`media`** (ADR 0007) — toggle id stable, no new toggle |
| **Closes** | `CSG-MED-1..6` ([gap register](../CAMPAIGN-STUDIO-GAP-FINDINGS.md)) |
| **Composes** | AI envelope surface (vision-capable model via aiProviders, honest-off), campaign-brief personas (ADR 0156), creative-briefs (ADR 0353 — the fallback "go shoot this" brief), Media usage-refs |
| **RFC verdict** | **Host-ext, no new RFC.** |

## Context (boundaries audit)

CS-002 is the largest unported pillar. Today `MediaAsset` = name/free-tags/lineage only
(`media/mediaService.ts:43-61`); listing is a plain filter (`:227-247`); upload is single-asset with
client tags (`routes.ts:116-147`); no hashing (`:82-91` counts bytes only); usage-refs are
`cms-page`-only (`:320-332`). The ONLY campaign↔media flow is write-in (generated concept images →
library with lineage, `packs/feature.campaign-channels.nodes/index.mjs:508-541`). Single owner
confirmed: `mediaService` owns assets/collections/bytes — this ADR extends it; nothing forks it.
FEATURES.md line 544 already *advertises* an "AI media-selection/mood-board matcher over `media`"
that does not exist — this ADR makes that row honest.

## Decision

1. **Marketing metadata facet (CSG-MED-1).** Optional typed `marketing` object on `MediaAsset`:
   `{ product?, sku?, angle?, background?, industry?, personaIds?, useCase?, palette?: string[] }`
   (closed enums where the source spec had them; length-capped). Additive + optional — zero
   migration; patchable via the existing asset PATCH.
2. **AI auto-tagging (CSG-MED-2 input).** A `media.autotag` envelope + `feature.media.nodes`
   `autotag` node: vision model → proposed `marketing` facet + free tags + subject bounding box +
   dominant palette. **Honest-off** without a vision-capable provider (422 reason, never fake tags).
   Proposals land as *suggestions* the user confirms (or auto-apply per collection flag). Filename
   parsing (deterministic `product_angle_persona.ext` convention) seeds tags on bulk upload.
3. **Weighted selection (CSG-MED-2).** `selectAssets(criteria)` on the media service + a
   `media.select` node + `ctx.features.media.select`: **deterministic** weighted score
   (product 40% / industry 25% / use-case 20% / persona 10% / recency 5% — weights as named
   constants) over the metadata facet, with the spec's 5-level fallback chain; the terminal
   fallback returns a **"needs new asset" signal** the creative-briefs feature (ADR 0353) turns
   into a visual brief. Deterministic ⇒ replay-safe as a node.
4. **SHA-256 dedup (CSG-MED-3→5).** Content hash computed at upload, stored on the asset;
   same-hash upload returns the existing asset (200 + `deduplicated: true`) instead of a copy.
   Bulk upload endpoint (`POST .../assets/bulk`, size/count-capped) wraps the same single-asset
   path per file — no second write path.
5. **Renditions as geometry, not rasters (CSG-MED-3).** The autotag subject box yields stored
   **crop geometries** for 16:9 / 1:1 / 9:16; the serve path accepts `?rendition=` and the FE crops
   via CSS/canvas from geometry. *No native image dependency* (sharp et al.) in v1 — raster
   derivation is a flagged follow-on if a platform upload leg needs real bytes (ads media legs
   currently upload originals).
6. **Campaign usage-refs (CSG-MED-6).** `MediaUsageRef.refKind` gains `campaign` + `creative-brief`;
   the channel generator + ADR 0353 stamp refs, giving "used in N campaigns" and feeding
   creative-fatigue correlation (ADR 0357).

## Phases

| Phase | Ships | Gaps |
|---|---|---|
| 1 | Metadata facet + PATCH + FE editor chips | MED-1 |
| 2 | SHA-256 dedup + bulk upload + filename parsing | MED-4, MED-5 |
| 3 | `media.autotag` envelope/node (honest-off) + suggestion review UI | MED-2 (input) |
| 4 | Deterministic `media.select` + fallback chain + `ctx.features.media.select` | MED-2 |
| 5 | Crop geometries + `?rendition=` serve + FE crop | MED-3 |
| 6 | usage-ref kinds `campaign`/`creative-brief` | MED-6 |

## Matrix highlights

Toggle `media` (stable). Packs: `feature.media.nodes` (`autotag`, `select`) — version bump, signed.
Envelope `media.autotag`. Agent: media-librarian verb added to the existing roster rather than a new
agent (AI-first through the ONE chat). RBAC: all new routes org-scoped read/write as siblings;
autotag is `workspace:write`. Replay: selection is deterministic; autotag proposals are node outputs.
No public surface change (serve path already tokened).

## Alternatives weighed

- *Native raster cropping in v1*: rejected — new native dep + image pipeline for a need the FE can
  meet with geometry; revisit when a dispatch leg requires derived bytes.
- *Auto-apply AI tags silently*: rejected — suggestions with confirm (or explicit per-collection
  opt-in) keep the library trustworthy.
- *A separate "media-intelligence" feature package*: rejected — would be a second owner over the
  same store (the `orgs`↔`accessControl` cautionary tale).

## As-built corrections (2026-07-12)

- **Dedup scoped to (org, collection-context)** — identical bytes aimed at a DIFFERENT
  collection are a deliberate organizational copy, not a duplicate; swallowing them would
  silently discard caller intent (review finding + test).
- **No `feature.media.nodes` pack** — media had no pack; the `select`/`createAssetFromServeUrl`
  surface ops are the workflow seam and the consumers are OTHER features' packs (channels,
  creative-briefs). A standalone media pack would add registry weight for nothing.
- **`?rendition=` serve param dropped** — crop geometry rides the asset record
  (`renditions`), the FE/consumer crops via CSS/canvas; the serve path stays byte-opaque.
- **Autotag is a suggest-confirm PROPOSAL route** (`POST /assets/:id/autotag` → apply via
  PATCH) rather than a chat envelope; chat drivability arrives with ADR 0353's Creative
  Director agent tools. Honest 422 without a vision-capable provider.
- **FE facet editor deferred** — no asset-edit UI exists at all today (even tags are
  API-only); the facet's primary consumers are programmatic (selection, mood boards). The
  editor ships with ADR 0353's mood-board UI where a human actually curates. Client fns
  (`autotagAsset`/`selectAssets`/typed facet) landed for it.
- Palette = free hex/name strings (bounded); weights = named constants, no tenant override.

## Phase → implementation record

| Phase | Ships | Evidence |
|---|---|---|
| 1 | `MediaMarketing` facet (create + PATCH replace-or-clear, bounded) | `mediaService.ts`; `test/media-intelligence.test.ts` |
| 2 | SHA-256 dedup pre-storage (collection-context-scoped) · `POST /assets/bulk` (≤20, 207 per-item) · `parseFilenameTags` | same |
| 3 | `autotagAsset` — one vision pass → tags/facet/palette/subject box (honest-off 422) | same |
| 4 | `selectAssets` — 40/25/20/10/5 named weights, facet=full/tag=half, 5-level fallback, `needsAsset` signal; surface op + route | same |
| 5 | `deriveRenditions` (pure geometry 16:9/1:1/9:16, centered+clamped) + `renditions` on the asset | same |
| 6 | `MediaUsageRefKind` gains `campaign` + `creative-brief` | same |

### P6 as-built — the campaign→asset edge is now durable (CS-DATA-5, 2026-07-12)

Phase 6 shipped the `creative-brief` kind (stamped by `stampMoodBoardUsage`) but left
`'campaign'` as declared-ahead vocabulary: no campaign→media-asset edge existed in the model, so
generated concept images lived only in `renderConcepts` run output and were orphaned forever.
CS-DATA-5 closes that:

- **Durable edge** — `MarketingCampaign` gains `assetIds?: string[]`
  (`campaign-orchestration/types.ts`): the media asset ids associated with a campaign (generated
  concepts + attached library assets).
- **Service** — `attachCampaignAssets(tenantId, campaignId, assetIds, actor?)`
  (`campaign-orchestration/campaignService.ts`) UNIONS ids into `campaign.assetIds` (dedupe, stable
  order) and stamps the media usage graph best-effort (the `stampMoodBoardUsage` precedent):
  resolve each assetId → serveToken via `media.getAsset`, then reconcile the FULL set with
  `syncUsageRefs({ kind: 'campaign', id, label })`. `deleteCampaign` now cascades via
  `clearUsageForRef('campaign', …)` before the row is deleted.
- **Surface** — `buildCampaignStudioSurface` gains `attachAssets` (resolve by campaignId, else
  briefId → `{ found: false }` for neither).
- **Node wiring** — `renderConcepts` (pack `feature.campaign-channels.nodes` 1.8.0) calls
  `ctx.features['campaign-orchestration'].attachAssets({ briefId, assetIds })` after concepts are
  built, best-effort (never fails a render); node return shape unchanged.
- **FE** — the media "used by" modal chip now labels per `refKind` (`campaign` /
  `creative-brief` / `cms-page`, ×4 locales) instead of always "CMS page".

The `'campaign'` kind is live vocabulary and orphan-free: rows are created when a campaign renders
or attaches assets and cleared on campaign delete.
