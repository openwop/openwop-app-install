# Media + Creative-Video (unit C7) — chat-first port review

**Scope (single-feature/unit mode):** backend `backend/typescript/src/features/{media,creative-video}`,
frontend `frontend/react/src/features/{media,creative-video}`, plus the two node
packs (`packs/feature.media.nodes`, `packs/feature.creative-video.nodes`) and the
`openwop:media.list` agent tool. `media` is the always-on single media owner
(ADR 0007/0027); `creative-video` is the ADR 0404 §b avatar / §P4 text-to-video
generator (toggled OFF by default), which lands its output as a provenance-stamped
`media` asset.

**One-line verdict:** The media *owner-and-node* surface already rides the engine
cleanly (RIDES/ADAPTER); the **AI-generation surfaces do not** — video generation
claims "composes into workflows + the chat drive pattern" but has **zero agent
tools and zero workflow templates igniting its nodes** (THEATER), and image
generation has **no agent tool anywhere**, so the ONE chat cannot generate imagery
— the only AI path is a bespoke prompt-form dialog (PARALLEL).

---

## Verdict table

| # | Capability | Today (file:line) | Verdict | Port target |
|---|---|---|---|---|
| 1 | Library browse/search, collections CRUD, delete | `MediaLibraryPage.tsx`; `media/routes.ts:95-350` | **PAGE-LEGIT** | Keep — structural asset management, the single media owner |
| 2 | Upload / bulk upload | `media/routes.ts:126,178` | **PAGE-LEGIT** | Keep — file input, not intent-described |
| 3 | `openwop:media.list` agent tool | `media/agentTools.ts:24`; allowlisted `packs/feature.assistant.agents/pack.json:38` | **RIDES** | Leave — read tool, shares the route's `resolveEffectiveAccess` predicate, fails EMPTY without an acting user |
| 4 | `media.select` node + `POST /assets/select` | `packs/feature.media.nodes/index.mjs:20`; `media/routes.ts:227`; `media/surface.ts:48` | **RIDES** | Leave — deterministic catalog node over `ctx.features.media` |
| 5 | `createAssetFromServeUrl` write surface | `media/surface.ts:61` | **RIDES** | Leave — narrow node write surface, serve-token→durable asset, hash-dedup |
| 6 | **AI image GENERATE** (prompt→new library image) | `GenerateImageDialog.tsx` → `media/imageGenRoutes.ts:78`; embedded in `MediaRefWidget.tsx:114` + `creative-briefs/RendersSection.tsx:257` | **PARALLEL** | Register an image-gen **action tool** so the ONE chat generates into the library; keep the canvas widget ONLY as a prop-bound structural affordance (not a free-standing talk-to-AI form) |
| 7 | AI image EDIT / inpaint / upscale (derive ops on an asset) | `EditImageDialog.tsx` → `media/imageGenRoutes.ts:252,278` | **ADAPTER** | Keep — structural derive on a *specific* asset (edit-this-image), immutable `derivedFrom` lineage; watch for drift |
| 8 | AI autotag proposal (suggest→confirm via PATCH) | `media/routes.ts:303` → `mediaService.ts:841` | **ADAPTER** | Keep — proposal applied through the existing PATCH SSoT; honest 502-on-empty |
| 9 | AI alt-text proposal (suggest→confirm; `accessibility`-gated) | `media/routes.ts:317` → `mediaService.ts:901`; `AltTextDialog.tsx` | **ADAPTER** | Keep — same suggest-confirm shape; could also ride the accessibility agent tool (`accessibility/agentTools.ts`) but the inline dialog is defensible |
| 10 | Media picker / ref widget embedded in canvases | `MediaPickerDialog.tsx`/`MediaRefWidget.tsx`, consumed by cms/document-editor/slides/drawings/app-builder/creative-briefs | **ADAPTER** | Keep — correct reuse of the single owner inside structural editing |
| 11 | Asset "used-by" / usage tracking | `media/routes.ts:328,341` | **PAGE-LEGIT** | Keep — read-only provenance/reference graph |
| 12 | **AI video generate (avatar)** | `CreativeVideoPage.tsx:79` form → `creative-video/routes.ts:54` → `videoService.ts:130`; node `feature.creative-video.nodes.generate`; `surface.ts:36` | **THEATER** | The claimed "chat drive + workflow compose" is unwired (no agent tool, no template). Register a `creative-video.generate` action tool + allowlist the node into a creative agent pack; drive generation from the ONE chat |
| 13 | **AI text-to-video (frontier, §P4)** | `creative-video/routes.ts:73`; `surface.ts:48`; `creative-video.t2v` sub-toggle | **THEATER** | Same as #12 (sub-toggle-gated); provider still RFC-blocked (ADR 0411 P4 seedImage) — chat port inherits the fails-closed gate |
| 14 | Video job list + status + poll-resolve | `CreativeVideoPage.tsx:165` list; `creative-video/routes.ts:35,42`; `resolveVideoJob` `videoService.ts:341` | **PAGE-LEGIT** | Keep the job list as a status/provenance page; real reads (`listJobs`/`resolveVideoJob`) back every state |
| 15 | `video.generate`/`text-to-video`/`status` nodes | `packs/feature.creative-video.nodes/index.mjs` | **RIDES** | Correct primitives over `ctx.features['creative-video']`, replay-safe (asset id is the recorded output), `adapterOnly` — but **no consumer exists** (see B1) |
| 16 | Video→media delete cascade | `videoService.ts:360` `registerVideoMediaCascade` (keyed `onMediaAssetDeleted`) | **RIDES** | Leave — keyed lifecycle seam, idempotent, prunes jobs pinning a dead asset |

**Counts:** R=5 (#3,4,5,15,16) · A=4 (#7,8,9,10) · P=1 (#6) · T=2 (#12,13) · PL=4 (#1,2,11,14)

---

## Blockers (from scouting) — each with the honest alternative

**B1 — creative-video's headline orchestration claim has no igniter.**
`feature.ts:6-10` and `packs/feature.creative-video.nodes/pack.json` both claim the
node "composes into chains + the chat-drive pattern," but scouting confirms:
- **No agent tool** — `grep registerFeatureAgentTool backend/.../creative-video/` is
  empty; the ONLY media/creative agent tool in the whole app is `openwop:media.list`
  (read-only). A user cannot generate a video by describing intent.
- **No workflow template** references `feature.creative-video.nodes.generate` (grep
  across `backend/`, `packs/` finds only the pack itself + tests). Nobody calls
  `startWorkflowRun` on a chain containing it.
- The **only real igniter is the bespoke `CreativeVideoPage` form** →
  `POST …/generate` (`routes.ts:54`), a direct route, not the engine.
> **Honest alternative:** register `openwop:creative-video.generate` (+ `.status`)
> **action tools** that call `authorizeOrgScope(req, FEATURE, 'workspace:write')` —
> the SAME predicate `routes.ts:33` uses (one helper, route + tool both call it) —
> and allowlist the three video nodes into a creative agent pack so the ONE chat
> drives generation. The node stays the RIDES primitive; the tool is the igniter.

**B2 — image generation has no agent tool; the sole AI path is a talk-to-AI form.**
`imageGenRoutes.ts` (`/assets/generate`, `/ai-edit`, `/ai-upscale`) is reachable
ONLY through `GenerateImageDialog`/`EditImageDialog` — a prompt textarea + provider
picker + "Generate" button (`GenerateImageDialog.tsx`), the exact law-#1
anti-pattern ("a form that hides a model call behind a button"). There is no
image-gen `registerFeatureAgentTool` anywhere, so the ONE chat cannot generate a
library image even though `core.openwop.ai.image-generate` exists as a spec node.
> **Honest alternative:** register `openwop:media.generate-image` (action tool)
> over the same `requireOrgScope(req,'workspace:write')` predicate the route uses,
> returning the library asset view (id + serve URL, never bytes — the existing
> route already guarantees this). The canvas-embedded generate affordance
> (`MediaRefWidget`) is a *defensible structural prop-fill* and may stay; the
> free-standing `RendersSection` generate form is the demolition-leaning one.

**B3 — async submit→poll→pending bounds any chat port (chassis/executor).**
`videoService.ts:47-53` caps the poll at ~90s so a node/route never pins a Cloud
Run worker; a longer job returns `pending` and is resolved by `resolveVideoJob`
(single poll, `maxMs:0`, `routes.ts:48` / `surface.ts:61`). A chat-driven generate
therefore returns `pending`, NOT an instant video.
> **Honest alternative:** the chat port MUST expose the `status`/resolve tool and
> render the job as a typed status card ("generating… / ready — view in media"),
> not pretend synchronicity. The read already exists; only the tool wrapper is new.

**B4 — video spend has no confirm gate; it's the most expensive media kind.**
`videoService.ts:214-237` meters ADR 0106 `video` budget at submit; the page form
spends with no human checkpoint (the only brake is the 429 budget cap,
`routes.ts:24-29`). A chat-driven spend should ride the shared HITL machinery.
> **Honest alternative:** an interrupt/approval card ("this will spend N video
> units — proceed?") before submit, OR accept the existing budget cap as the brake
> (documented). Not strictly blocking — cost is already metered + capped — but the
> chat-first path is the right place to add the confirm if wanted.

---

## Card-mechanism note (test 10.5)

- Chat-driven **video/image job status** = app-known shape, trusted producer,
  i18n-critical (the `CreativeVideoPage` chips already localize `status_*`) →
  **typed registered renderer** (status chip + "view in media" link), NOT an A2UI
  surface.
- The **budget confirm** (B4) = a fixed approve/reject decision → **plain interrupt
  card** (`interrupt.<kind>`).
- A mid-conversation **avatar/voice structured ask** (the `avatarId`/`voiceId`
  fields the current form collects, `CreativeVideoPage.tsx:154-159`) is exactly
  where a **free-text prompt is wrong** — the sanctioned upgrade is an **A2UI
  clarification form** (the assistant feature's calendar/email precedent), so the
  agent can ask for the structured avatar/voice inputs it needs.

---

## Demolition list (with the regression pins to add)

Demolish ONLY after the chat/agent replacement works (skill law: never demolish
before the replacement lands).

1. **`CreativeVideoPage` generate form** (`CreativeVideoPage.tsx:132-163`) → once
   the chat drives video, demote the page to its job-list/status view (#14 stays
   PAGE-LEGIT). **Pin:** a test asserting the page renders no script/avatar/prompt
   generate `<form>` (a resurrected form fails the suite).
2. **Standalone image-gen form in `creative-briefs/RendersSection.tsx:257`** → route
   render-concept image generation through the chat/agent. **Pin:** RendersSection
   exposes no prompt-textarea generate surface.
3. **Keep** `MediaRefWidget` generate/edit affordances (`MediaRefWidget.tsx:114-121`)
   — prop-bound structural editing inside a canvas is legitimate; **pin** them as
   prop-scoped (they only ever set the widget's `mediaRef`, never open a free chat).

---

## New-code inventory (small — tools, an agent pack, reads that already exist)

- `openwop:creative-video.generate` + `openwop:creative-video.status` **action
  tools** — new `creative-video/agentTools.ts`, sharing `authorizeOrgScope(...,
  'workspace:write')` (B1). ~1 file.
- `openwop:media.generate-image` **action tool** — extend `media/agentTools.ts`,
  sharing `requireOrgScope('workspace:write')` (B2). ~1 method.
- A **creative agent pack** (persona) allowlisting the three video nodes + the
  image-gen tool (or extend an existing marketing/creative agent pack). ~1 pack.
- Typed status renderer for job cards in chat + optional budget interrupt kind. Thin.
- **No new reads** — `listJobs`, `resolveVideoJob`, `listAssets` already exist.
- **No new durable rows** — the port reuses `videoJob` (already tenant-keyed,
  erasure-covered via the cascade `videoService.ts:360`) and `media` assets.

---

## Phased plan (gated on real gates; compliance/parity first)

- **P0 — igniters + authority parity.** Add the three action tools (B1/B2) sharing
  the routes' predicates; allowlist into a creative agent pack (pack-allowlisted,
  never silent-added to the ADR 0315 baseline). Verify `npm run ci`; close with
  `/code-review` + `/ux-review`, apply fixes. *No demolition yet.*
- **P1 — honest async in chat.** Wire the `status`/resolve tool + a typed job-status
  card so a chat generate shows `pending → ready` (B3); poll-resolve reuses
  `resolveVideoJob`. Gate as P0.
- **P2 — demote the bespoke forms.** With chat driving generation, demote
  `CreativeVideoPage` to job-list/status and route `RendersSection` image gen
  through chat; add the regression pins (demolition list). Gate as P0.
- **P3 — structured input + spend gate (optional).** A2UI clarification form for
  avatar/voice structured input; budget-confirm interrupt (B4). Gate as P0.

---

## Deferred honestly

- **Text-to-video provider + `seedImage`** — ADR 0411 P4 is RFC-blocked; t2v
  fails-closed (`video_dispatch_live_pending`). The chat port of #13 inherits the
  same closed gate; it is honest deferral, not THEATER.
- **Provider webhook** — poll-only v1 by design (`videoService.ts:19-20`); a webhook
  is a documented latency optimization, deferred.
- **`request_failed` double-submit residual** — accepted v1 residual
  (`videoService.ts:220-227`): a POST that reached the provider before a response
  timeout could, on re-claim, submit a second paid job; the future hardening is a
  requestHash-derived idempotency key. Stated, not faked.
- **creative-video toggled OFF by default** (`feature.ts:31`) — reviewed on merits;
  OFF is not the finding. The THEATER verdict is about the unwired chat/workflow
  orchestration claim, which holds whether the toggle is on or off.
