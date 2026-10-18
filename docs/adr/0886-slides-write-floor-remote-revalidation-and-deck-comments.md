# ADR 0886 — Slides: the canvas write floor, a re-checked present remote, DSAR on `producedBy`, and per-slide comments

Status: implemented (2026-10-13; adversarial /architect pass before code: 1 CRITICAL, 3 HIGH, 5 MEDIUM, 4 LOW folded in below)

Feature-loop round 2, row 43 (`slides`, default ON). Extends ADR 0328 (slides
best-in-class), ADR 0610 D3′ (owner-subject read doors), ADR 0359 (collab), ADR
0464 (DSAR), ADR 0881 (comments). Host-extension only: no wire change, no RFC.

## Context

Round 1 graded Slides A / A / A. Re-measured on `origin/main` @ `be43deb34`, the
workflow axis holds (chain-backed `slides.design`, real-loader witness). The code
axis does not. Every finding below is a RED leg in
`backend/typescript/test/adr0886-slides-floors.test.ts` on that commit.

### S1 — a canvas write is decided in the wrong org

The canvas editor factory (`features/canvasEditorRoutes.ts`) gates every verb
with `authorizeOrgScope(req, feature, scope)` on the PATH org, then
`loadCanvas` → `canvasReadAllowed` (`host/canvasSurface.ts:296`) on the owner
subject at **READ** level, for reads and writes alike. ADR 0054 puts write in the
SUBJECT's org: `levelFor` (`features/projects/projectsService.ts:441`) answers
`'write'` only for `workspace:write` in the **project's** org, and the advisory
board resolver (`advisory-board/service.ts:559`) does the same for a board.

So in a tenant with two orgs, a person who is an Editor in org A and a Viewer in
org B can PATCH, DELETE, restore and mint a present remote for a deck owned by a
project in org B, through `…/slides/orgs/<A>/…`. MEASURED: PATCH returns 200.
Through `…/orgs/<B>/…` the same write is refused (403), which is the control.

The same READ-for-write gate sits on every other write lane:

| Lane | Site | Gate today |
|---|---|---|
| REST editor verbs (all canvas types) | `canvasEditorRoutes.ts` `loadCanvas` | read |
| `ctx.canvas.write` (run lane) | `canvasSurface.ts:703` `assertCanvasRunAccess(…, 'write')` | tenant-wide `workspace:write` + read |
| Slide Designer render (update) | `slides/agentTools.ts:286` | read |
| drawings / cad / campaign-studio / app-builder agent tools + `app-builder/surface.ts` | `getCanvasForCaller` before `updateCanvasForTenant` | read |
| ui-plugin RPC write | `routes/uiPlugins.ts:87` | read |
| documents canvas delete | `documents/routes.ts:140` | read |
| collab ticket / claim-seed / WS upgrade | `collab/collabServer.ts:113` | read (and see S4) |

### S4 — a workspace Viewer can live-edit any collab canvas

The canvas collab doors (`collabServer.ts:201` ticket, `:225` claim-seed, the
cookie WS lane `:462`) check the tenant, the toggles and READ access to an owned
canvas. None asks for `workspace:write`. A room is read-write (the derive writes
`host.canvas`, `collabRoom.ts:268`), so a Viewer who mints a ticket rewrites the
deck. The workflow collab lane closed exactly this (ADR 0770 D1, WBCD-3, the
`assertTenantScope(…, 'workspace:write')` at `:415`); the canvas lane was not
given the same check. Bounded by `realtime-collab` (default OFF, per tenant).

### S2 — the present remote outlives what it was minted under

`POST …/present-remote` requires write, then mints a stateless HMAC token over
`{tenantId, canvasId}` with a 4 h TTL (`host/presentRemote.ts:46`). The public
routes (`routes/presentRemote.ts`) check only the signature and that the canvas
exists. MEASURED: after the minter is removed from the org, and after `slides`
is turned off, `/outline` still answers 200 with the LIVE deck's speaker notes,
and `/command` still drives the show.

### S3 — DSAR leaves the person's id in `metadata.producedBy`

The Slide Designer render tool stamps `metadata.producedBy = {kind:'user', id}`
when no agent profile is set (`slides/agentTools.ts:269`); drawings, cad and
app-builder do the same. `eraseSubjectCanvas` (`canvasSurface.ts:628`) redacts
`capturedBy` and a user `ownerSubject` but not this field. MEASURED: the id
survives erasure.

### Upgrade U1 — per-slide comment threads

The competitive scan (`docs/research/slides-best-in-class.md` §5, §8 "recorded
follow-ups: comments seam") lists threaded comments on a slide as table stakes
(Google Slides, Pitch, Keynote via iCloud, Figma Slides); round-1 deferred it
because no comments seam existed. One exists now: ADR 0881 hardened
`features/comments` with ONE target resolver for HTTP, chat tools and the
workflow node, member-only @mentions and a `CommentsPanel` the document editor
already embeds (`document-editor/DocumentToolbarExtras.tsx:100`). Slides has no
target, so a reviewer has nowhere to leave a note on slide 4.

### Prod exposure (read-only prod reads by the team lead, with the user's approval, 2026-10-13)

- **S4 is LIVE in prod.** `hostext:feature-toggle:realtime-collab` is stored
  `status:'beta'` with no cohort (plus one per-user `on` override). A stored `beta`
  with no cohort resolves ON for every tenant (the stored-override-shadows-default
  trap), so the "default OFF" bound written in S4 above does not hold in prod: a
  workspace Viewer could mint a ticket and live-edit any collab-capable canvas.
  `hostext:feature-toggle:slides` is likewise `beta`, no cohort (on for all). 0
  rows under `hostext:collab*`. Prod holds 7 canvases (5 app-builder, 1 slides,
  1 untyped), so real exposure is small but not zero. **S4 is this row's Blocker
  and ships promptly.** The toggle is NOT changed here (a prod write; the user's
  call).
- **S1 was not exploitable in prod:** 0 project-owned canvases (all 7 org-owned).
- **S2 was never used in prod:** 0 requests to `/host/openwop-app/present/*` in the
  Cloud Run request logs 2026-09-14 → 2026-10-13 (a floor query with the same
  filter on `/host/openwop-app/` returned live hits, so the query works).
- **The deferred OQ-1 gap is the one with real prod population:** every prod
  canvas is org-owned with no `orgId`, and one tenant has 2 orgs — so the
  cross-org sharing of org-owned canvases is live data, not hypothetical. Row 99.

## Decision

### D1 — ONE canvas write predicate, used by every write lane (S1)

Add to `host/canvasSurface.ts`, beside `canvasReadAllowed`:

```ts
export async function canvasWriteAllowed(tenantId, canvas, caller): Promise<boolean>
export async function getCanvasForWriter(tenantId, canvasId, caller): Promise<CanvasRecordView | null>
```

Rule: no `ownerSubject` ⇒ `true` (the org gate stands, as for reads);
`preAuthorized` ⇒ `true`; no subject ⇒ `false`; otherwise
`resolveSubjectAccess` must be `null` or satisfy `'write'`. A `null` level keeps
its meaning (the kind is not membership-scoped, e.g. `user`), so user-owned and
org-owned canvases are unchanged.

- `canvasEditorRoutes.ts`: `loadCanvas(tenantId, id, caller, need)` with a
  REQUIRED `need` (no default, so every `extraRoutes` verb must choose).
  `'write'` on PATCH, DELETE, restore and present-remote, and on the app-builder
  extras whose scope is write/manage (export, publish, sync, sync-binding PUT and
  DELETE). Refusal: **404** when the caller cannot even read the canvas (no
  existence leak); **403** `forbidden_scope` when they can read it but not write
  it — a 404 on save would make a readable deck look deleted (architect #6).
- `assertCanvasRunAccess(…, 'write')` uses `canvasWriteAllowed`.
- The slides render tool and the other write lanes in the table switch to
  `getCanvasForWriter`.
- **Share-link mint is a write** (architect #2): `sharingService.ts` `validate`
  for `slides_canvas` (`:441`) and `app_builder_canvas` (`:171`) uses
  `getCanvasForWriter`. Otherwise the S1 person publishes a live public link to
  the project's deck, which is worse than the edit.
- **Ratchet:** `test/adr0886-canvas-write-gate-ratchet.test.ts` scans `src/` for
  every call of `updateCanvasForTenant(`, `deleteCanvasForTenant(`,
  `restoreCanvasVersion(` and `loadCanvas(` and pins, per file, the CALL COUNT
  plus the reviewed gate (`getCanvasForWriter` / `canvasWriteAllowed` /
  `assertCanvasRunAccess` / `loadCanvas(…, 'write')` / `system:<reason>`). A new
  call in a reviewed file changes the count and fails until re-reviewed
  (architect #7). System lanes listed with reasons: `collabRoom.ts` derive (the
  join is the gate, D2), `dataBinding.ts` (`assertCanvasRunAccess`),
  `canvasSurface.ts` restore helper, `demoAppBuilderSeed.ts`,
  `projects/feature.ts` cascade, `candidateDeathSubscribers.ts`,
  `app-builder/canvasRetention.ts`. Sabotage-witnessed red.

### D2 — collab joins are writes (S4 + S1 on the collab lane)

The ticket and claim-seed doors require `requireWorkflowWrite(req)` (the
request-shaped tenant write gate the workflow collab ticket already uses: it
classifies api keys, the tenant-owner credential and the personal-owner
short-circuit) AND `canvasWriteAllowed` for the canonical caller. The cookie WS
lane adds `assertTenantScope(…, 'workspace:write')` outside a personal tenant,
exactly as the workflow lane does at `:415`, plus `canvasWriteAllowed`. The
ticket WS lane keeps its existing upgrade-time owner check (tickets are
short-lived; the write decision is made at mint, as for workflows). The ticket's
`principalId` stays attribution only: it is not the canonical `User.userId` for
a bearer or api-key minter (architect #4), so it is never used to authorize
write.

**Frontend (architect #1, CRITICAL):** without this the decision bricks the
editor. `useCollab` falls through a refused ticket to the cookie socket, which D2
also refuses, and after 20 s slides (`collab: 'elements'`) replaces the whole
editor with "Live connect failed". So a reader who cannot write gets a DISTINCT
answer — 403 with `details.reason: 'collab_write_required'` (no leak: they can
read the deck over REST) — and `useCollab` treats it as collab disabled: the
editor runs its single-writer path, exactly as when `realtime-collab` is off.
A non-reader still gets the uniform 404. FE test pins the fallback.

This **reverses** ADR 0610's "READ minimum to JOIN". That choice was correct only
while write authority was assumed to come from the org gate, and the canvas lane
never had one. Consequence, stated: a read-only person (org Viewer, or a private
project's observer) no longer opens the live room. They still read the deck over
REST; the editor already falls back to the non-collab lane when the ticket is
refused. A read-only live view is a separate product decision (a server-enforced
read-only socket), recorded as OQ-2, not built here.

### D3 — the present remote is re-checked on every request (S2)

- Claims gain `u` (the minter's canonical `User.userId`) and `o` (the PATH org
  the mint was authorized in). Both are inside the HMAC. The domain prefix moves
  to `presentremote:v2:` and tokens to a `v2.` form, so refusing pre-change
  tokens is decided by version, not by a missing field (architect #3). TTL is
  4 h, so the cost is one re-mint per live show at deploy time.
- ONE function, `authorizePresentRemote(token)`, used by all four public routes:
  signature + expiry → the canvas exists and has an outline provider → the
  canvas type's owning toggle is enabled for the tenant
  (`resolveCanvasTypeAccess`) → the EXACT mint check re-run:
  `assertOrgScope(tenantId, u, o, 'workspace:write')` — the same call
  `requireOrgScope` makes, so a token can never be valid at mint and dead on
  first use (architect #3: a tenant-wide `assertTenantScope` would have disagreed
  with the per-org mint in a shared `ws:` workspace and in demo mode) → the minter
  may still write this canvas (`canvasWriteAllowed`). Every refusal is the
  existing uniform 404.
- The SSE `/events` stream is checked at connect. It carries frame indices only
  (no deck content), so a stream already open when access is lost keeps
  receiving positions until it closes. Stated, not fixed (OQ-3).

### D4 — DSAR redacts `producedBy` (S3)

`eraseSubjectCanvas` also rewrites `metadata.producedBy` to
`{kind:'user', id: ERASED}` when it names the erased subject (all key forms).
Raw collection write, no version bump, idempotent — same discipline as the
existing two redactions. This covers slides, drawings, cad, campaign-studio and
app-builder at once, because they share the field.

### D5 — per-slide comments on the ADR 0881 resolver (U1)

- New comment resource type `canvas_slides` in `features/comments`. `resourceId`
  is the `canvasId` (whole-deck thread) or `${canvasId}#${slideId}` (a slide).
  `featureId: 'slides'` (the owning toggle, checked once in
  `resolveCommentTarget`). `validate`: the canvas exists in the tenant and is
  `canvas.slides`; an owned deck needs `subjectReadAllowed` (the comment READ
  rule, same as `canvas_document`); a composite id's `slideId` must exist in the
  deck's current `slides[]` (a deleted slide's thread resolves to nothing, the
  uniform 404 the panel already renders as a gone-state). `title` = the deck
  title, plus the slide name for a slide thread; `restricted` = owned.
- Cascade: the comments feature's `onCanvasDeleted` handler prunes
  `canvas_slides` threads (base + composites) as it does for `canvas_document`.
- Frontend: a Comments button in the slides toolbar extras opens the shared
  `CommentsPanel` for the selected slide, shown only when the `comments` feature
  is enabled. `CommentsPage` learns the type (label, empty-state key, deep-link
  to `/slides/<canvasId>`), and the FE `ResourceType` union gains it (pinned to
  the backend by `comments-deep-link.test.ts`). 4-locale strings.
- `slides` declares the top-level `recommends: ['comments']` (the
  `BackendFeature` field, `featureToggles/registry.ts:159`), never `dependsOn`:
  decks work without comments, and the toolbar button is absent when comments is
  off (it is OFF by default).
- **Stable slide ids** (architect #8): the render tool assigned `slide-${i+1}`
  on every update, so an inserted slide would silently re-attach every later
  thread to the wrong slide. It now keeps each incoming slide's `id` when it is a
  valid unique slug (the get-design read returns them, and the tool description
  says to keep them), falling back to a fresh unused positional id.
- Every pin that enumerates comment resource types moves with the type
  (architect #9): `RESOURCE_TYPES`, the FE union (`comments-deep-link.test.ts`),
  `CommentsPage`'s two typed maps, the reviewer prompt pin
  (`comments-adr0881.test.ts`), and the `feature.comments.nodes` prose with a
  pack version bump.
- No new person field: authors, mentions and resolution already belong to
  comments and are covered by ADR 0881's DSAR and removal handling.

## Alternatives weighed

- **S1: compare the path org with the subject's org** (refuse when they differ).
  Rejected: it still answers READ-level for writes inside the right org, and a
  user/agent-owned canvas has no org. The subject's own access level is the rule
  ADR 0054 already states.
- **S1: fix slides only.** Rejected: the hole is in the factory and the run lane
  that every canvas type shares, and the agent tools are copies of one pattern.
- **D2: keep read-to-join and make the room read-only for readers.** Better UX,
  but there is no read-only socket today and building one inside a fix is how
  the fix ships wrong. OQ-2.
- **D3: a revocation epoch row per canvas.** GC-SL-3 rejected it as a second
  state surface, and that still holds. Re-checking the live facts on each
  request revokes on exactly the events that matter (membership, toggle,
  access) with no new store.
- **D5: a slides-local comments store.** Rejected outright (no parallel
  architecture). The comments feature owns threads.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 predicate + factory + run lane + slides tool + other write lanes + ratchet | S1 legs green; ratchet sabotage-red |
| P2 | D2 collab write gate; `adr0610-collab-lane-subject-access.test.ts` regain leg re-stated with an Editor member | S4 leg green |
| P3 | D3 present-remote claims + `authorizePresentRemote` | S2 legs green |
| P4 | D4 eraser | S3 leg green |
| P5 | D5 backend target + cascade + FE panel + i18n | comments target tests + FE test |
| P6 | `SLW2-1/2` chain witnesses | determinism + gallery legs |

## Architect pass (2026-10-13, before code) — what changed

1 CRITICAL (#1 the FE bricked the editor under D2), 3 HIGH (#2 share mint and
the app-builder extras were write lanes the table missed; #3 the remote's
use-time check disagreed with its mint check; #4 the collab ticket identity is
not canonical), 5 MEDIUM (#5 collab test fixtures need owner memberships; #6
403-not-404 for a reader; #7 the ratchet as drafted was gameable; #8 positional
slide ids; #9 the comment-type pins), 4 LOW (#10 `recommends` is top-level; #11
campaign-studio also writes `producedBy`; #12 ui-plugin already checks tenant
write — only its owner check is read-level, and a collab room keeps writing for
a member demoted mid-session; #13 user-owned decks have no resolver). All folded
into D1–D5 above; #12b and #13 are recorded as OQ-4 and OQ-5.

## Open questions / decisions

- [ ] OQ-1 Org-owned canvases carry no `orgId`, so every org in a tenant shares
  them for read and write. Out of scope (schema change across six canvas
  types); handed to feature-loop row 99 (canvas chassis). **Prod-populated:** all
  7 prod canvases are org-owned and one tenant has 2 orgs (see Prod exposure).
- [ ] OQ-2 A server-enforced read-only collab socket for readers (D2 consequence).
- [ ] OQ-3 Close an open present `/events` stream when access is lost (positions
  only today).
- [ ] OQ-4 A live collab room keeps writing for a member demoted or removed
  mid-session (the socket is authorized at join). Same class as OQ-3.
- [ ] OQ-5 Only `project` and `board` owners have an access resolver, so a
  user-owned deck (every render-tool deck) is writable by anyone with tenant
  write. D1 does not change that; it is the chassis' user-ownership semantics,
  handed to row 99 with OQ-1.
- [x] RFC verdict: host-extension only. No wire field, capability or event type.

## Implementation record (2026-10-13, branch `feat/fl2-43-slides`)

Every security leg below was proved RED on `origin/main` source
(`git checkout origin/main -- <src>`, run, restore) before its fix, and each fix
was sabotage-checked after it was committed.

| Phase | What landed | Witness |
|---|---|---|
| P1 / D1 | `subjectWriteAllowed`, `canvasWriteAllowed`, `getCanvasForWriter`; the factory's `loadCanvas(…, need)` (REQUIRED, 403 when readable); the run lane; the slides / drawings / cad / campaign-studio / app-builder-surface / ui-plugin / documents-delete lanes; share mint for `slides_canvas` + `app_builder_canvas` | `test/adr0886-slides-floors.test.ts` S1 (REST, share ×2, render tool, `ctx.canvas.write`, and PATCH+DELETE for each of the six editor types — DELETE answered 204 on main); `test/adr0886-canvas-write-gate-ratchet.test.ts` (mutator counts, literal `need`s, write-predicate counts — three sabotages red) |
| P2 / D2 | collab ticket + claim-seed (`assertCollabWrite`, authz-only refusals → `collab_write_required`), cookie WS lane; `useCollab` stays DISABLED on that reason | S4 leg; `adr0610-collab-lane-subject-access.test.ts` (regain leg re-stated for an Editor; cookie-lane Viewer 403 — the Viewer OPENED the room on main); `useCollab.test.tsx` |
| P3 / D3 | v2 tokens (`u`, `o`), `authorizePresentRemote` on all four routes, refusal causes logged | S2 legs (minter removed; feature off); `presentRemote.test.ts` (minter swap = forgery; v1 refused); `PresentRemotePage.test.tsx` |
| P4 / D4 | `eraseSubjectCanvas` redacts `metadata.producedBy` | S3 + S3b (producedBy-only, idempotent) |
| P5 / D5 | `canvas_slides` comment target + delete cascade; packs `feature.comments.nodes@1.2.1`, `vendor.openwop-app.comments.agents@1.0.4`; toolbar Comments (absent when `comments` off); FE type + 4 locales; deep link `?frame=`; render tool keeps slide ids; editor slide ids never re-minted (`frameOps` `uniqueIds`) | `test/adr0886-slides-comments.test.ts` (6); `slideComments.test.tsx`; `commentsDeepLink.test.tsx`; `CanvasEditorPage.test.tsx` (`?frame=`) |
| P6 | `SLW2-1` (build twice, byte-identical), `SLW2-2` (gallery chain) | `slidesDesignChain.test.ts` |
| grade fixes | `SL2UX-1` view-only editor (GET `access`), translated 403s, History restore hidden; `SL2UX-2` remote expires on a refused command; `SL2UX-3` save-first state; `SL2UX-4` link back; `SL2UX-5` h2; `SL2CD-1..4,6,7,9` | `CanvasEditorPage.test.tsx` (view-only, 403 text) and the legs above |

> **Correction (grade pass, after implementation):** D5 said "slide ids are kept
> stable across edits". That was true of updates and false of delete-then-add:
> the editor's deterministic slug re-minted a deleted slide's id (`slide-4`), and
> its thread came back on the new slide (`SL2CD-1`). Slide ids are now minted
> with a random suffix in the editor and the render tool's update lane; creates
> stay positional (no thread can exist yet, and the in-run create idempotency
> key hashes the deck).
