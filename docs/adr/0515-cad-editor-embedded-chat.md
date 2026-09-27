# ADR 0515 — CAD editor embedded chat: the in-editor entry to prompt-to-solids

Status: Accepted
Date: 2026-08-02
Deciders: round-4 programme (CAD-R2-3, re-scoped by discovery)

## Context

The cad round-2 matrix deferred CAD-R2-3 "prompt-to-solids (SketchUp
2026.2's shape)" to a node-pack lane. Round-4 discovery found the capability
**already exists**: the CAD Modeler agent (`feature.cad.agents.default`)
carries `openwop:cad.get-design` + `openwop:cad.render` — prompt → validated
**parametric** solids through the exchange rail (closed-world validate /
repair / CAS persist), which is the side of the output fork the field is
competing toward (Zoo returns editable KCL, Autodesk neural CAD advertises
editable precision geometry; SketchUp's mesh assets are the other side).
What we lack is only the **in-editor entry**: today the CAD Modeler is
reachable through the main chat, not from the model you're looking at.

Field consensus the design must respect (round-4 catalog, cited in
`UX_UPGRADE-cad.md`): **human review before AI geometry lands is universal**
— SketchUp's Generated Object Gallery (download-to-insert), Fusion's
review-outcomes-then-choose, Zoo's `accepted`/`rejected` feedback states.

## Decision

1. **The entry rides the chassis's EXISTING `ToolbarExtras` seam** — the
   per-type slot that "self-gates and owns its own modals/i18n"
   (`canvas/types.ts:286`). The cad `definition.tsx` supplies a
   `CadAssistExtras` component: a toggle button + a right-side drawer
   holding the shared `EmbeddedChatPanel` scoped to the CAD Modeler. **No
   chassis change**; no other canvas type is touched.
2. **Lazy import is REQUIRED**: `chat/` statically imports `features/cad/`
   (`chat/artifacts/CadPreview.tsx` → `Cad3dView`), so a static cad→chat
   edge would cycle. `CadAssistExtras` lazy-imports `EmbeddedChatPanel`
   (the builder precedent, CLAUDE.md import rule).
3. **Canvas scoping via seeded prompts**: `get-design`/`render` take a
   `canvasId` input; the drawer's empty-state example prompts INTERPOLATE
   the open canvas's id ("Read model `<canvasId>` and …"), so the agent's
   read-before-write lands on the model in front of the user. No new wire,
   no new tool, no conversation-metadata mechanism invented.
4. **Review gate, decided for our tier**: chat-driven edits persist via the
   render tool's CAS into the SAME canvas the editor has open — the change
   is immediately VISIBLE in the live view and reversible via the editor's
   undo/collab history, and the tool validates closed-world before any
   write. That is our review story: see-it-live + undo, not a staging
   gallery. A propose-then-accept staging step (the SketchUp/Fusion shape)
   is recorded as a possible follow-up if live use shows undo is not
   enough — it would need a draft-canvas mechanism and is NOT licensed by
   this ADR.
5. **Gating**: the drawer self-gates on the `cad` feature toggle
   (`useFeatureAccess('cad')`), matching the tools' own per-call toggle
   re-check. No new toggle; no RFC (host-extension surfaces only).

## Alternatives considered

- **A new chassis side-rail slot**: rejected — `ToolbarExtras` already
  exists and self-gating panels are its stated purpose; a second slot is
  chassis surgery without need.
- **A modal**: rejected — it hides the model, defeating the point (watch
  the render land live).
- **Extending `EmbeddedChatPanel` with a context prop**: rejected — seeded
  example prompts already carry the id, and a context mechanism would be a
  new chat-surface contract for one consumer.

## Phases

| Phase | Deliverable | Verify |
|---|---|---|
| P1 | `CadAssistPanel.tsx` (drawer + lazy embed + canvasId-seeded examples) + `definition.tsx` ToolbarExtras + CSS + i18n ×4 | frontend build + panel test (gated polarity, examples carry the id) |

## Implementation record (2026-08-02)

P1 shipped with this ADR. Tests: `cadAssist.test.tsx` (gated polarity ×2,
drawer open/close, canvasId in the seeded examples). HV: live BYOK turn in
the editor, both themes (HVCAD-9 in the tracker).
