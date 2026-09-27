# ADR 0353 — Creative Briefs: the visual-brief entity (lifecycle, mood boards, sharing, PDF)

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–4, 2026-07-12 — see corrections) |
| **Date** | 2026-07-12 |
| **Feature** | **NEW feature package `creative-briefs`** — toggle `creative-briefs`, OFF, bucket `tenant`, category `Marketing` |
| **Closes** | `CSG-CB-1..4` ([gap register](../CAMPAIGN-STUDIO-GAP-FINDINGS.md)) |
| **Composes** | media selection + usage-refs (ADR 0352), comments (ADR 0334 seam), sharing resolver registry (ADR 0013), documents render pipeline (ADR 0057 — PDF), campaign-channels `creative_briefs` channel (ADR 0157), brand voice (ADR 0155) |
| **RFC verdict** | **Host-ext, no new RFC.** |

## Context (boundaries audit)

CS-005 intended a managed visual-brief **entity** — lifecycle, versions, comments, mood board, PDF,
external share — closing the messaging→production handoff. Today the only artifact is a transient
`creative_briefs` **channel draft** (`packs/feature.campaign-channels.nodes/index.mjs:57-64`:
scene/composition/messaging only). No brief entity anywhere (grep clean); sharing's `ResourceType`
has no brief kind (`sharing/sharingService.ts:44-47`); **route/toggle `creative-briefs` is free**
(collision grep clean). Notable shelf-ware: `packs/vendor.myndhyve.ads-studio-core/` ships a real
deterministic `CreativeBriefBuilder` (manual/extraction/merge), `VariantPlanService`, video QA, and
winner-synthesize (`pack.json:4-24`, `index.mjs:40-141`) — wired into **nothing**.

## Decision

A self-contained `src/features/creative-briefs/` package owning the `CreativeBrief` entity:

```
CreativeBrief {
  briefId, tenantId, orgId, campaignId?, briefRunArtifact?,   // provenance
  title, assetType, sceneDescription, composition,
  cameraAngle?, lighting?, brandPalette?: string[],           // the spec fields the draft lacks
  messagingIntent, platformSpec?: { platform, format, textRulePct? },
  directions: [{ label, rationale, ... }],                    // 2–3 creative-direction variants
  moodBoard: [{ mediaAssetId, note? }],                       // auto-assembled via media.select
  status: 'draft' | 'review' | 'approved',                    // lifecycle
  versions (capped, field-diffable), createdBy/updatedBy/At
}
```

1. **Entity + lifecycle + versions (CSG-CB-1).** CRUD org-scoped; status transitions validated;
   version snapshots (cap 50) with a computed field-level diff view (FE renders changed fields —
   the campaign-brief `BriefVersion` precedent, plus the diff the spec asked for).
2. **Mood board via media selection (CSG-CB-2).** On create/generate, `ctx.features.media.select`
   (ADR 0352 Phase 4) assembles candidate assets from the brief's product/persona/industry; the
   selection's terminal "needs new asset" fallback records the gap **inside the brief** ("go shoot
   this"). Assets stamp `creative-brief` usage-refs.
3. **Sharing + PDF (CSG-CB-3).** A `creative_brief` `ResourceType` in the sharing resolver registry
   — **approved-only** resolution (the documents precedent, `sharingService.ts` uniform-404), so an
   external designer executes from a tokened link without an account. PDF export reuses the ADR
   0057 markdown→PDF renderer over a deterministic brief→markdown projection (no new render stack).
4. **The channel upgrades; the pack gets wired or retired (CSG-CB-4).** The `creative_briefs`
   channel generator now **creates entities** through `ctx.features['creative-briefs'].create`
   (behind the toggle; falls back to today's transient draft when OFF — no hard coupling).
   **Decision on the shelf-ware:** port the `CreativeBriefBuilder`'s three deterministic modes
   (manual/extraction/merge) into `feature.creative-briefs.nodes` and **retire the vendor pack**
   rather than wiring it — one owner, our signing pipeline, no orphaned vendor namespace. Recorded
   as a correction: the pilot pack was a migration experiment, not a foundation.

## Phases

| Phase | Ships | Gaps |
|---|---|---|
| 1 | Entity + CRUD + lifecycle + versions/diffs + FE page (`/creative-briefs`, `?brief=` deep-link per ADR 0336) | CB-1 |
| 2 | Channel generator creates entities (toggle-gated); brief.build node (3 modes ported); vendor pack retired | CB-4 |
| 3 | Mood board via `media.select` + usage-refs | CB-2 |
| 4 | Comments (compose the comments feature — new resource kind) + sharing resolver + PDF export | CB-1 (comments), CB-3 |

## Matrix highlights

Toggle `creative-briefs` OFF/tenant. Packs: `feature.creative-briefs.{nodes,agents}` (brief.build,
brief.moodboard; a Creative Director agent verb driven through the ONE chat — deep-link, no new
panel). `ctx.features['creative-briefs']` surface (create/get/list/transition) behind toggle+RBAC.
Public surface: only via the sharing resolver (existing PUBLIC_PATH_PREFIXES, approved-only, uniform
404, rate-limited). RBAC: read=`workspace:read`, write=`workspace:write`, approve transition mirrors
documents' shareable-status privilege. Replay: generation outputs are node results; entity writes are
idempotent on `briefId`.

## Alternatives weighed

- *Extend `campaign-brief` instead of a new package*: rejected — the messaging brief and the visual
  brief are different entities with different lifecycles/consumers; overloading one store is the
  drift risk.
- *Wire `vendor.myndhyve.ads-studio-core` as-is*: rejected (above) — port + retire.
- *PDF via a new HTML renderer*: rejected — ADR 0057's pipeline is the render owner.

## As-built corrections (2026-07-12)

- **Vendor pack retired, modes ported**: `vendor.myndhyve.ads-studio-core` removed; its
  deterministic build modes live on as `validateBriefContent` / `mergeBriefContent` /
  `extractBriefContent` in the service (exposed as `mode: manual|extraction|merge` on create).
- **Share link excludes mood-board images** (open Q2 resolved conservatively): the public
  projection is markdown listing directions/specs; media serve tokens never ride the public
  wire. Revisit if designers need the visuals in-link.
- **Comments backend-only for now**: the `creative_brief` resource kind is registered (threads
  + inbox notify via the comments feature's own machinery); an embedded comments UI on the
  brief page is a follow-on (open Q1 answered yes at the seam level).
- **PDF export returns bytes directly** (the doc-editor export precedent) — no media-token
  indirection.
- **No node/agent packs in v1**: the channel generator composes `ctx.features['creative-briefs']`
  (surface), and chat drivability rides the existing Channel Generator agent's outputs; a
  dedicated Creative Director agent pack is deferred until a real conversational need shows.

## Phase → implementation record

| Phase | Ships | Evidence |
|---|---|---|
| 1 | Entity + lifecycle (draft→review→approved, PRIVILEGED approval, edit-demotes) + versions w/ field diffs + FE page (`/creative-briefs`, `?brief=` deep link) | `features/creative-briefs/*`; `test/creative-briefs-route.test.ts` |
| 2 | `mode: extraction|merge` create + ported validator · channel generator creates entities via the surface (toggle-gated, falls back to transient drafts) · vendor pack retired · channels pack 1.4.0 | same + `packs/feature.campaign-channels.nodes` |
| 3 | Mood board via `media.select` + `needsAssetNote` gap + `creative-brief` usage-ref stamping | same |
| 4 | `creative_brief` sharing resolver (APPROVED-only, demotion purges links, toggle-dark) + comments resource kind + PDF export (ADR 0057 renderer) | same |
