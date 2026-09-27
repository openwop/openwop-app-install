# ADR 0328 — Slides best-in-class program: blocks-not-freeform on the app-builder stack

Status: Implemented (2026-07-10 — Phases 0-7 shipped: PRs #1568, #1571, #1575, #1577, #1580, #1582, #1583; Phase 8 = recorded follow-ups below)

## Context

`docs/research/slides-best-in-class.md` (PR #1565) is the governing research: a
five-researcher industry deep-dive (PowerPoint/Google Slides, Keynote/Canva,
Pitch/Gamma/Beautiful.ai/Tome, Figma Slides/Prezi + editor-UX synthesis) plus a
file:line inventory of the current `slides` feature. Its verdict: slides today
is the canvas framework's fixed-schema contract proof with almost no product on
top — and one live honesty violation: **the advertised `export: ['slides','pdf']`
facets and the FEATURES.md "exports via Documents (pptx/pdf)" promise reach only
`canvasContentToMarkdown` → a JSON code fence → `renderMarkdownToPptx`, which
produces garbage. No export button exists.**

## Decision

Execute the research doc's §4 plan. The architecture-level decisions:

1. **Blocks, not freeform.** Every 2026 AI-deck failure let AI place freeform
   boxes; every leader constrained the substrate (Beautiful.ai smart slides,
   Gamma flow blocks, Pitch template contracts). Slides v2 (Phase 3) becomes the
   **second consumer of the app-builder block stack** — a closed slide-block
   catalog on the tree trait with layout *variants* owning geometry. A freeform
   x/y slide canvas is a recorded non-goal.
2. **Core-vs-slides placement per the research doc §3**: media (`mediaRef`
   property type), present mode + phone remote, state-diff motion (the Keynote
   Magic Move model), frames clipboard, share analytics, sections, the a11y
   checker, and Cmd+K are **core chassis capabilities** (every canvas type
   inherits them); the exporter, block catalog, variants, themes/brand binding,
   presenter semantics, and the AI chain are **slides-layer**.
3. **Honesty first (Phase 0+1, one PR).** The export facets stay and become
   TRUE in the same change (retract-then-restore would churn the registry twice
   in a day): a real `canvas.slides` → pptxgenjs exporter AND a pdfkit renderer,
   both driven by ONE shared per-layout geometry module so the two formats
   cannot drift. Theme CSS becomes real (5 themes), `theme` becomes editable
   (`docPropDefs`), and the History Compare gains a chassis-level frames-diff
   default (frames-gated — an elements-only type keeps Compare hidden).
4. **Export rides the `slides` toggle** — not a separate toggle: app-builder's
   `code-export` earned its own because generated *source code* is a distinct
   risk surface; a deck downloading as .pptx is the product's table-stakes
   output.
5. **SSRF-free image embedding.** The exporters embed image *bytes* only for
   host-served media assets (`/v1/host/openwop-app/assets/<token>` resolved
   internally via `resolveMediaAsset` — zero network). External `imageUrl`s
   render as a visible layout-preserving "linked image" placeholder. External
   embedding arrives with Phase 2's `mediaRef` (host-served by construction).
6. **AI chain v2 (Phase 6) reuses the ADR 0325 shapes** — outline-first with a
   HITL checkpoint, per-slide regeneration (the deepen pattern), deterministic
   deck audit, provider-stamped configs, soft-fail-loud, seam-tested (the
   toposort/planContext/gate-binding lessons all apply verbatim).

### Wire/RFC

None. All host-ext: artifact-type facets/fields are host-owned additive (the
ADR 0317/0323 precedent); export/present routes are `/v1/host/openwop-app/*`
non-normative; `ctx.callAI` is already-specced. Compatibility: Additive.

## Phases (mirrors the research doc §4)

| Phase | Scope | Status |
|---|---|---|
| 0+1 | Honesty + real export: pptx + pdf via shared geometry, ToolbarExtras button, theme CSS, editable theme, frames-diff Compare default | done (#1568) |
| 2 | `mediaRef` property type + MediaRefWidget (propertyWidgets seam; app-builder image.src migrated) + the `brand` theme (renderer=app tokens, exporter=hex-validated host brand) + per-slide background accent | done (#1571) |
| 3 | **Block pivot**: slide block catalog + tree trait + layout variants (schema v2, additive w/ legacy-layout coercion; two-gate + seam-test discipline) | done (#1575) |
| 4 | Present mode (core `CanvasPresentPage`: presenter window notes/next/timer; QR phone remote over SSE; notes stop leaking to the audience) | done (#1577) |
| 5 | Motion: state-diff transitions (block-id matching) + per-slide build-order list; reduced-motion honest | done (#1580) |
| 6 | AI chain v2: outline-first + per-slide regen + restyle + notes gen + deterministic audit; agent edits show scoped diffs | done (#1582) |
| 7 | Share wiring + per-slide analytics + sections/skip + frames clipboard + PPTX import | done (#1583) |
| 8 | Recorded follow-ups: comments seam, per-slide status/assignee, Q&A widgets, a11y checker pane, Cmd+K, co-editing (own program) | recorded |

### Phase 8 — the consolidated follow-up record

From the research doc §4 plus decisions recorded during phases 0-7:
comments seam · per-slide status/assignee (the Pitch pattern) · audience Q&A
widgets · live a11y checker pane (the PPT model — C9) · Cmd+K palette (C10) ·
co-editing (its own program) · chart-block export as a rendered image (today:
the honest text placeholder) · PPTX export of transitions/builds (static
export ignores motion) · per-element build config (in/with/after — today the
block order IS the build order) · a "Create with AI" entry in the documents
gallery driving `slides.design` (chat-drivable today) · PPTX import of images
via the media library (today: text-fidelity only, skips reported).

### Phase 7 notes (as built)

- **Share wiring**: `slides_canvas` joins the sharing feature's resource
  types (resolver mirrors `app_builder_canvas`: living document, tenant
  isolation via `getCanvasForTenant`, slides-toggle fail-closed, user-owner
  mint guard); the slides factory sets `shareResourceType` (delete purges
  links) and the definition's `share` trait mints 7-day links. **The public
  viewer is a one-frame pager on `SlideFrame`** — speaker notes are
  structurally absent (the S7 posture; the deck-listing renderer would have
  leaked them), skipped slides are passed over.
- **Per-slide analytics live in the sharing feature** (the research's C8
  placement): a `sharing:frameview` DurableCollection keyed
  `token:frame`, CAS-incremented from the public viewer (uniform-404 on
  bad tokens; first-view put is best-effort under a race — analytics never
  block a reader), read back owner-gated per link ("Views by slide" bars on
  the sharing page). The viewer reports each frame once per mount.
- **Sections are DERIVED, not schema**: a `section`-layout slide starts one;
  the chassis `present.sectionOf` trait renders group headers in the jump
  grid. No new field.
- **Frames clipboard is chassis-level**: copy/paste in the frame menu, per
  canvas type via localStorage (cross-tab/cross-deck); paste re-enters
  through `addFrameFromTemplate` → the same coercion every frame write gets,
  identity fields re-minted.
- **PPTX import is TEXT-FIDELITY by design**: titles (placeholder-shape
  detection), body paragraphs (as bullets), speaker notes; images/charts/
  tables are reported as skipped, never mangled into lookalikes. Pure
  regex/string over the zip XML (jszip, now an explicit dependency — it was
  a phantom transitive for app-builder export). Round-trip tested against
  our own exporter. The import button creates a NEW deck and opens it.

### Phase 6 notes (as built)

- **`slides.design` chain on the ADR 0325 shapes**: brief → outline →
  **HITL outline approval** (the ADR 0083 gate binding — the outline is the
  checkpoint, the Gamma lesson: approve the narrative before paying for the
  deck) → draft (blocks slides against the closed catalog) → deepen (per-slide
  regen for the thinnest slides, ≤4, sequential, re-validated through the SAME
  closed-world gate) → notes (speaker-notes generation, soft-fail-loud) →
  audit (**deterministic, zero AI**: empty slides, over-cap text, duplicate
  titles, unknown block types the validator would reject, missing notes,
  build/variant sanity — never re-implementing validateSlidesDoc) → review
  gate emitting the single `outputRole: 'primary'` artifact.
- **Soft-fail posture (loud)** and **cost honesty** are inherited verbatim
  from ADR 0325: outline+draft are the paid core; deepen/notes are enhancers
  that pass through unchanged on failure with a warning output + audit
  finding; ≤7 BYOK calls per run, all via `ctx.callAI` config pass-through.
- **Scoped diffs for agent edits**: chat-driven edits to an existing deck ride
  the canvas working copy + version snapshots, so the editor's Compare (the
  frames-diff summarizer) shows exactly which slides changed — no new diff
  surface.
- **As built**: `slides.design` builtin workflow (`features/slides/designWorkflow.ts`,
  registered via `builtinWorkflows`); six new pack nodes in
  `feature.slides.nodes` 1.1.0 (outline/draft/deepen/notes/audit/restyle); the
  pack normalizer learned the P3-P5 fields (blocks against a pinned
  `BLOCK_TYPES` vocabulary with a drift-tripwire test vs the host catalog).
  The OUTLINE gate previews a SKELETON DECK (one section slide per planned
  slide, intent+keyPoints in its notes) through the existing slides renderer —
  no new card type; the outline object rides a separate data edge into draft
  (the gate edge is ordering-only, so approval-resume needs no output
  pass-through). `restyle` guarantees content preservation BY CONSTRUCTION
  (only theme/variant/background/transition are read from the model). The
  Slide Designer agent (1.1.0) gained canvasRead/canvasWrite (scoped edits →
  version snapshots → editor Compare) + restyle, and recommends the chain for
  full decks. A "Create with AI" entry in the documents gallery is a recorded
  follow-up (Phase 8) — the chain is chat-drivable today.

### Phase 5 notes (as built)

- **Magic Move matches by CONTENT key, not schema ids** (`blockMotionKey`:
  `type:content[:60]` + a duplicate counter). Duplicating a slide and
  rearranging (the Keynote workflow) keeps keys stable so elements glide;
  editing text changes the key, so the element honestly crossfades instead of
  gliding to the wrong place. No `id` was added to the block schema — a
  correction to the research doc's "matching by stable id" phrasing.
- Per-slide `transition` ('none'|'fade'|'magic', an ENTRY property — the
  Keynote model) + `build` (blocks slides only: reveal one block per advance;
  **the build order IS the block order** — the substrate is the build list,
  no per-element in/with/after config; recorded follow-up). Both additive
  schema+validator+propDef fields.
- The position model is `(frame, step)` in the pure `presentNav` module;
  retreat re-enters the previous frame FULLY BUILT; jumps land fully built;
  the phone remote and audience windows sync the step. Builds hide with
  `visibility: hidden` (layout preserved — a build never reflows the slide),
  and the audience render path receives only the visible step count.
- The FLIP player (`useMagicMove`) + the fade animation both sit behind
  `prefers-reduced-motion: no-preference` — reduce = instant swaps, honest.
  The app-builder's edge-based `preview.transitionFor` seam is untouched
  (walkthrough preview ≠ slide entry; two definition-owned surfaces).
- pptx/pdf export ignores transitions/builds (static formats; a PPTX
  transition mapping is a recorded follow-up).

### Phase 4 notes (as built)

- **Present is chassis-level**: `CanvasPresentPage` + a definition `present`
  trait (`renderFrame`/`notesKey`/`skipKey`). The notes leak (S7) is fixed by
  construction — the audience render path is `renderFrame`, which never
  receives notes; only the presenter window (and the phone) read them.
- **Same-browser audience windows sync over BroadcastChannel** (instant, zero
  backend); the backend is involved ONLY when a phone remote joins.
- **Phone remote**: a stateless HMAC capability (`presentremote:v1`, JSON
  claims — tenant ids contain colons — TTL 4h, signed with the ONE session
  secret) minted behind the canvas factory's org gate; public routes under
  `/v1/host/openwop-app/present/:token/*` (outline/command/state/SSE) 404
  uniformly on bad tokens. Nav events ride the ONE host-ext pub/sub with the
  payload inline (ephemeral control signals — no durable log), fanned out by
  the ONE `openSseChannel` (rate-limit allowlisted; the per-tenant stream cap
  bounds Cloud Run slot usage). The capability deliberately grants the deck
  OUTLINE (names + notes + skip) — the controller shows notes on the phone.
- Per-slide `skip` is schema+validator+editor data; kiosk (auto-advance/loop)
  is URL-param runtime config, NOT deck data. `qrcode` is a new FE dep, loaded
  lazily in the present chunk only.

### Phase 3 notes (as built)

- The 12-type closed block catalog registers through the EXISTING
  `registerCanvasComponents('canvas.slides', …)` machinery — one source for the
  editor palette (the shared catalog endpoint), the validator's closed-world
  gate (`validateComponentTree`), and the Phase-6 AI prompt. Two host-catalog
  additions were needed: the `'text'` category and the `'stringlist'` prop type
  (both additive unions).
- `'blocks'` is a 7th `layout` enum value (one discriminator, no second `kind`
  field); a blocks slide carries `variant` ('full'|'hero'|'split'|'two-col' —
  CSS-owned geometry, blocks never carry x/y) + `blocks[]` (≤40, recursive,
  `additionalProperties: false`).
- Two SMALL chassis seams (both definition-owned, the /architect call):
  `treeEnabledFor?(frame)` gates tree editing per-frame (palette/outline/DnD
  appear only on blocks slides; legacy slides keep the form panel), and
  `frames.transformOnPropChange?(frame, name, value)` lets a prop change apply
  a whole-frame transform — picking the 'blocks' layout runs the pure
  `legacyToBlocks()` conversion in ONE undo step (editor-owned, never
  automatic; the converter lives in the FE definition only).
- Exporters: blocks slides render as a stacked text flow (shared flattener;
  `variant` region fidelity is renderer-CSS-only this phase). A chart block
  exports as an HONEST `[<title> — see the live deck]` placeholder — real
  chart-to-image export is a recorded follow-up; the SSRF posture (host-asset
  bytes only, external URLs → linked-image placeholder) holds for block images.

---

## Correction note — the S7 audience posture had two leaks (2026-07-24, `docs/steward/UX_UPGRADE-slides.md`)

Phase 7 established that the shared-deck viewer is an AUDIENCE surface: speaker
notes are structurally absent because the deck-listing renderer would leak them.
A benchmark against published-deck viewers (Google Slides publish-to-web, Pitch,
Canva) found the viewer was applying that rule to notes and **not** to two other
places that expose the same backstage:

1. **The counter (SL-G1)** rendered the RAW deck index over the FULL slide count.
   A 5-slide deck with 2 skipped showed "1 / 5" while only 3 slides were
   reachable — and the number then jumped 1 → 3 → 5. The audience was both told
   about material they could not open and given a count that visibly skipped.
2. **The jump strip (SL-G2)** drew a dot per slide *including skipped ones*
   (dimmed), and clicking one silently redirected to a different slide. The
   `presentNav` docstring's "stays in the jump grid, dimmed" is correct for the
   AUTHOR's present mode; it is wrong for the audience viewer.

Both now read one **audience projection** (`visible`), so the counter, the strip
and what navigation actually does cannot disagree. A fullscreen control was added
(absent, not disabled, where the browser has no Fullscreen API), and the now-dead
`.cv-shared-deck__dot--skipped` rule was deleted.

**The analytics contract is deliberately unchanged.** Frames are still reported
by their real deck index (0, 2, 4), NOT the new audience-facing position
(1, 2, 3) — switching to the friendly number would have silently corrupted every
existing per-frame tally. There is a test pinning the raw indices for exactly
this reason.

An existing test asserted the old behaviour (3 dots, one dimmed; counter
`1 / 3` → `3 / 3`). It was **encoding the bug** — documenting a counter that
visibly skips — so it was rewritten with a comment explaining why the expectation
moved, rather than deleted or quietly relaxed.

Deferred: a keyboard-shortcut legend (SL-G4). The shortcuts work; a permanent
legend is chrome most viewers never need, and it deserves a proper help
affordance rather than clutter on an audience surface.
