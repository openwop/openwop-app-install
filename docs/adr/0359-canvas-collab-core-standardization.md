# ADR 0359 — Canvas collaboration standardized at the chassis core + rollout across all canvas types

**Status:** implemented (2026-07-12) — all phases shipped the same day, toggle still **OFF**:

| Phase | Scope | PR |
|---|---|---|
| 0 | ADR + 0335 correction + ROADMAP/FEATURES lockstep | #1741 |
| 1 | Backend registry + both-toggle socket enforcement + `canvas-collab` rename + orphan sweep | #1744 |
| 2 | Chassis hoist (`EditorSurfaceProps.collab`, live-session locks) | #1748 |
| 3 | Generic element binding + `useCollabDoc` facade (D3 correction: derived ops) | #1753 |
| 4 | Presence cluster + rail markers + coalesced announcements | #1756 |
| 5 | Per-type rollout ×5 + drift pins | #1758 |
| 6 | Durable-authority parity (derive / apply-into-room / invalidation) | #1763 |
| 7 | Gates: two-client e2e (PASSED — and caught 3 integration bugs: relative ws URL in the dev `/api` posture, the un-stripped `/api` prefix on raw upgrades, and a dead Ctrl+Z in live document sessions) + FEATURES promotion + pg reconciliation | (this PR) |

**Grade pass (2026-07-12, post-implementation):** a 3-grader audit (code/UX/data) over the shipped program, all fixes applied same-PR. The load-bearing find: the D6 authority hooks consulted **per-instance** room liveness while a room can be live on several instances — fixed with durable `collab:lease` heartbeat rows (`hasLiveRoomGlobal`) + a `collab.extwrite` fan-out so every instance's room re-applies an external write from host.canvas. Also fixed: the Documents-browser delete path skipped the canvas-delete cascade (the seam moved into `deleteCanvasForTenant`); collab rows were tenant-untagged (erasure purge missed them); evict-time snapshot compaction (gc'd re-encode — the `gc:false` growth bound); consecutive collab-version dedup + forced room-close capture; remote carets were invisible (no `user.color`, no caret CSS — hue-matched to the Avatar cluster now); a 20 s provisioning ceiling with a designed error + Retry replaced the infinite spinner; announcement-collision and Live-chip honesty fixes. Accepted residual risk: multi-instance snapshot LWW (CRDT-self-correcting), lease staleness ≤60 s after an instance crash, the documented one-render stale-closure race.

**Grade pass, second wave (2026-07-12, the code-grader report):** fixed the
`loadRoom` async-init race (two concurrent first-opens split-brained a room —
in-flight promise map, convergence-tested), added the anti-entropy full-state
heartbeat (a lost fan-out delta can no longer diverge instance rooms
permanently), made the reconcile insert pass O(n) (monotone cursor), the
per-tenant cap atomic, `maxPayload` env-tunable
(`OPENWOP_COLLAB_MAX_PAYLOAD_BYTES`), eviction flushes retried with
keep-resident-on-failure, and a superadmin `canvas-collab/_debug` room
introspection surface.

**Residuals pass (2026-07-12, the final open items):** **(COLLAB-5 closed)**
snapshot persistence is now CONVERGENT, not last-writer-wins — each room CASes
against the row it last read/wrote; a miss merges the winner's state into the
doc (`Y.applyUpdate`, a CRDT join) and re-persists the superset (raw-JSON
field-order pinned by test). **(OQ-4 closed)** the per-tenant connection cap is
`OPENWOP_COLLAB_MAX_CONNS_PER_TENANT` (default 25). **(Scene presence — the
deferred D5 half)** `InteractivePreviewProps.peerSelections` + the shared
`canvas/PeerSelectionOverlay` render peers' selections IN the drawings/cad
scenes (dashed identity-hue outline + name flag; pointer-inert, `aria-hidden`
— the rail markers stay the AT path). The name flag is also the RULING on
hue-proximity at small sizes: disambiguation by name, hue stays identity-stable
(matches avatar + caret). **(LISTEN-replay question answered)** the pg pub/sub
self-heals on drop but Postgres LISTEN buffers nothing — NOTIFYs during a
reconnect window ARE lost; the anti-entropy heartbeat is the designed recovery
(≤1 beat). Optional future: a storage reconnect hook triggering an immediate
anti-entropy pass (recorded, not built).

**Grade pass 3 (2026-07-13, the #1774 delta audit):** data grade B− → fixed:
the CAS vanished-row branch no longer RESURRECTS deliberately-pruned snapshots
— a torn-down room drops the write (the delete race), and a live room that
survived an invalidation restores its lease + seed claim and (shaped types)
re-applies host.canvas BEFORE re-inserting, so the invalidating external write
wins (document rooms log at error — the bounded ≤60s staleness residual);
evict now derives even on a partial flush (the doc holds the merged superset),
keeps the resident dirty room LEASED, clears miss-scheduled timers, and the
heartbeat retries the flush for connection-less dirty residents; mid-session
compaction triggers past 1 MB (marathon sessions no longer grow unbounded);
the CAS byte-pin covers the legacy tenant-less row shape and the TEXT-column
dependency is documented (jsonb would livelock every swap). UX grade B+ →
fixed: peer hues LUMINANCE-CLAMPED to [0.08, 0.15] with a theme-STABLE
`--collab-flag-text` token (flag/caret text ≥4.5:1 in both themes — a fixed
47% lightness failed a hue band per theme); flags collision-stack, flip below
top-edge elements, and hold screen-constant size in drawings via `flagScale`
(CAD chrome scales by design).

**Grade pass 3b (2026-07-13, the late code-grader report — A−):** converged
CAS misses now SKIP the merge/reschedule entirely (the hot-multi-instance
churn); repeated misses are observable (a rate-limited warn + `persistMisses`
on the `_debug` surface — the fingerprint of serialization skew during a
rolling deploy, since the whole-row byte CAS never matches across two row
shapes) with reschedule backoff; rotated TEXT peer outlines pivot on
`shapeCenter` like the renderer (bbox-center only coincides for non-text
kinds); the cap's "0 = unlimited is deliberately not expressible" note.
Recorded follow-up (not built): replace whole-row byte CAS with a monotonic
`rev` token — a row-shape change is exactly what the byte pin makes delicate,
so it waits for a quiet window.

**Enable-gates resolved:** (1) the browser/e2e two-client pass (`frontend/react/e2e/collab.spec.ts` — live sync both directions, presence, per-user undo against the real transport) is green and repeatable; (2) the pg connection budget was reconciled operationally BEFORE this program (private memory `db-connection-budget`: prod `OPENWOP_PG_POOL_MAX=4` × `max-instances=5` = 20 ≤ the ~25 db-f1-micro guideline), and the fan-out rides the pre-existing multiplexed `LISTEN` (+0 connections). **Enabling `realtime-collab` in prod is now purely a product decision** (flip the toggle per tenant; no redeploy).
**Date:** 2026-07-12
**Program:** implements ADR 0335 Phases 3–4 ("other canvas types bind their models"), and **corrects ADR 0335 Phase 2's wiring ownership** (collab provisioning moves from the `document-editor` feature into the canvas chassis — see §Correction below and the matching note added to ADR 0335).
**Depends on / composes:** ADR 0335 (the Yjs transport + persistence + auth boundary — reused verbatim, not reopened), ADR 0310 (the canvas chassis: one working-copy/history owner, elements/tree traits, positional selection ruling), ADR 0334 (the `canvas.document` ProseMirror surface — the existing witness), ADR 0344 (chassis authoring mechanics — clipboard/hidden/locked route through the same gesture seams the binding intercepts), ADR 0319 (one toggle per canvas type — composes with the one `realtime-collab` toggle), ADR 0104/0006 (RBAC posture unchanged).
**Toggle:** `realtime-collab` (existing, **stable — no new toggle**) · default **OFF** · `bucketUnit: tenant`. A surface is collaborative iff `realtime-collab` AND the type's own toggle are both on.
**Surface:** backend `host/collab/` generalization + frontend `canvas/` chassis seam + per-type opt-in. **No wire, no RFC** (§RFC verdict).

---

## Context

ADR 0335 shipped the collaboration **transport** correctly as core infrastructure: the
backend (`host/collab/collabServer.ts`, `collabRoom.ts`) is schema-agnostic — it
authenticates the socket, relays opaque Yjs sync/update/awareness bytes, persists
snapshots, and fans out across instances. Nothing in the room protocol knows what a
document is. Phase 2 then wired exactly one consumer, `canvas.document`, and in doing so
left three pins that make collaboration *de facto* a document-editor feature instead of
a canvas-core capability:

1. **Backend type pin.** Both the WS upgrade and the seeder election hard-require
   `canvasTypeId === 'canvas.document'` (`host/collab/collabServer.ts:163`, `:91`), and
   the route path is named `document-collab` (`:43`).
2. **Feature-owned provisioning.** The chassis passes no collaboration state to
   surfaces — `EditorSurfaceProps` (`canvas/types.ts:172`) has no `collab` field.
   `features/document-editor/DocumentEditorSurface.tsx` privately resolves the toggle,
   calls `useCollab`, runs the claim-seed handshake, and suppresses the CAS save
   (`DocumentEditorSurface.tsx:509` outer gate, `:111` save suppression, `:150` seed).
   A second canvas type would have to copy all of that — the parallel-architecture
   anti-pattern this repo bans.
3. **One binding kind.** The only model binding is ProseMirror-specific
   (`collabExtension.ts`). The other five first-party types (slides, app-builder,
   drawings, cad, campaign) share the chassis element/tree machinery
   (`CanvasEditorPage.tsx`) and have **no** binding at all.

The chassis itself makes standardization tractable: there is exactly **one working-copy
owner** — `useHistoryState` at `CanvasEditorPage.tsx:144` (`history.state` IS the doc);
every gesture routes through `apply` (one clone → one history entry, `:339`),
`history.replace` (drag-phase/text-family coalescing, `:387`), `patchElement`/
`patchElements` (`:775`, `types.ts:131`), and the tree/frame ops. One seam to bind, not
five.

## Boundaries audit (2026-07-12)

- **Route collision:** `grep -rn "canvas-collab" backend/typescript/src` → no hits; the
  rename target is free. The existing `document-collab` path is dormant (toggle OFF,
  never enabled in prod), so renaming it breaks nothing live.
- **Single owners composed, not forked:** transport/persistence = `host/collab/`
  (ADR 0335); working copy/undo = `CanvasEditorPage` `useHistoryState`; per-type doc
  model = each type's definition + validator (ADR 0310); type registration precedent =
  `registerCanvasComponents(canvasTypeId, …)` (`host/canvasComponentCatalog.ts:61`) and
  the per-type route factory `registerCanvasEditorRoutes(cfg)` with `cfg.canvasTypeId`
  (`features/canvasEditorRoutes.ts:59`) — the natural home for the collab opt-in flag.
- **Helper reuse:** `DurableCollection` (snapshots/updates/seed claims — unchanged),
  storage pub/sub fan-out (unchanged), `requireFeatureEnabled`/`resolveOne` toggle
  resolution (unchanged), the RFC 0130 dual-live-region announce pattern (reused for
  presence announcements).
- **Capability honesty:** `/.well-known/openwop` advertises nothing collab-related
  today; this ADR keeps it that way (§RFC verdict).
- **Adjacent in-flight work:** the DESIGN.md §7 CV-1..17 chrome ledger also edits
  `CanvasEditorPage` chrome; the collab seam touches doc-state/undo, not chrome —
  sequence branches, shared-file conflicts are mergeable.

## Decision

Make real-time collaboration a **canvas-core capability**: the chassis owns collab
provisioning and the generic document binding; a canvas type opts in with **one
declarative flag**; the backend authorizes any registered collab-capable type. Ship the
rollout type-by-type behind the existing toggle.

### D1 — Backend: collab-capable type registry (replaces the `canvas.document` pins)

- `host/collab/` gains a tiny registry: `registerCollabCanvasType(canvasTypeId)` /
  `isCollabCanvasType(canvasTypeId)` — mirroring the `registerCanvasComponents`
  pattern. `registerCanvasEditorRoutes` gains `collab?: boolean` in its `cfg` and
  registers the type when set — so the opt-in lives where the type's routes, validator,
  and catalog already live, and the registry can never name a type that isn't mounted.
- The WS upgrade and `claim-seed` replace the `!== 'canvas.document'` checks with
  `!isCollabCanvasType(canvas.canvasTypeId)` → uniform 404. **Fail-closed:** an
  unregistered, unknown, or pack-provided type is not joinable.
- **Both toggles enforced at the socket (architect HIGH-1):** the registry entry
  carries the type's own `feature.toggleId` (already in the factory cfg,
  `canvasEditorRoutes.ts:58`), and the upgrade AND `claim-seed` resolve **both**
  `realtime-collab` and the type's toggle → uniform 404 if either is off. The UI
  hiding a disabled editor is not the boundary — the socket is; a tenant with collab
  ON but (say) `slides` OFF must not be able to open a live room on a slides canvas
  via a raw WS client. The Phase 1 test matrix includes the type-toggle-OFF case.
- **Pack canvas types (RFC 0130 / ADR 0310 Phase D-E) are excluded in v1.** Their
  editors are generic/plugin-sandboxed and their docs validate against pack schemas; a
  live CRDT authority for pack docs is a separate risk decision. Explicitly recorded as
  a non-ship with a trigger (a pack type requests it AND the plugin-preview surface
  gains a collab story).
- **Path rename:** `/v1/host/openwop-app/document-collab/:canvasId` →
  `/v1/host/openwop-app/canvas-collab/:canvasId` (upgrade + `claim-seed`). Dormant
  surface, host-internal, zero clients — rename now, before it's load-bearing. No
  alias kept (nothing to be compatible with). FE consumers of the old path
  (`canvas/useCollab.ts:6,55`, `DocumentEditorSurface.tsx:155`) catch up in Phase 2 —
  safe **only because the surface is dormant**; do not enable the toggle anywhere
  between Phases 1 and 2.
- The `onCanvasDeleted` prune hook drops its type filter (`collabServer.ts:77`) — any
  collab-capable canvas prunes snapshot + seed claim on delete.
- Absorbs the recorded ADR 0335 follow-up: a periodic sweep for writer-crash-orphaned
  `collab:update` rows (self-prune is best-effort today).

### D2 — Chassis: collab provisioning moves into `CanvasEditorPage` (the 0335 §Phase 2 correction)

- The chassis (not the surface) does: resolve-collab-once behind the existing loading
  gate (toggle via `useFeatureAccess('realtime-collab')` + the type's `collab` flag) →
  `useCollab({canvasId, enabled})` → the claim-seed election → **CAS-save + re-seed
  suppression** while the room is live. This is exactly the logic
  `DocumentEditorSurface` runs privately today, hoisted once.
- `EditorSurfaceProps` gains `collab?: CollabHandles` (doc, provider, awareness,
  seeded); `DocumentEditorSurface` is refactored to consume it and its private outer
  gate is deleted. **Solo-path regression guard:** the full doc-editor suite must stay
  green with the toggle off; the resolve-once rule (never recreate the editor
  mid-session) moves up with the gate.
- A type's **definition** declares collab capability (`CanvasEditorDefinition.collab?:
  'document' | 'elements'`), mirroring the backend flag; a drift test pins FE
  declaration ↔ backend registration (the `creatableTypes` drift-test precedent).

### D3 — One generic element-model binding (`canvas/yDocBinding.ts`)

For the five element/tree types, the chassis binds the **whole editor doc** to a Yjs
tree — doc props → `Y.Map`, each collection (frames array, `elements` collections) →
`Y.Array` of `Y.Map` — via a **state-diff binding** at the single working-copy seam:

- **Local edits:** the existing pure ops keep producing plain `next` docs (zero churn in
  `treeOps`/`frameOps`/`elementOps`/geometry code). When collab is on, the binding
  intercepts the `apply`/`replace`/`patchElement(s)` commit point and applies the
  change to Y in one transaction with a `LOCAL` origin.
> **Correction (Phase 3 implementation, 2026-07-12):** the descriptors are
> **DERIVED, not plumbed**. The op layer's clone-on-edit discipline — committed
> docs are never mutated and unchanged items are REFERENCE-SHARED
> (`structuralClone`); only `editDoc` one-shots full-clone — lets a commit-time
> reconciler recover targeted ops with zero call-site churn: reference-identity
> match → deep-equal match (full-clone gestures) → positional per-field pairing
> (identity kept, concurrent field edits survive) → LIS-minimal move set (only
> genuinely-moved items are delete+rebuilt — the documented loss case). The
> integration point collapsed to ONE seam: a `useHistoryState`-compatible facade
> (`useCollabDoc`) that `CanvasEditorPage` swaps in when the session is live, so
> `apply`/`replace`/`patchElement`/name-input call sites are untouched. This
> satisfies HIGH-2's intent (never a blind positional diff) more cheaply than
> the descriptor channel the ADR text proposed. See
> `canvas/collabDocBinding.ts` + `canvas/useCollabDoc.ts` and their suites.

- **Structured-op descriptors, not blind diffing (architect HIGH-2):** an index-based
  prev→next diff cannot distinguish a move/reorder from delete+insert — a reordered
  element re-created as a fresh `Y.Map` orphans a peer's concurrent field edit (it
  lands on the deleted item and is silently lost), and every `apply` gesture is a
  whole-doc commit, so this is the common path. The op layer is enumerable, so each
  structural mutation passes an **op descriptor** (`insert`/`delete`/`move`/
  `patch`/`replaceField`) through the commit point and the binding maps it to targeted
  Y ops (moves as Yjs moves or delete+insert **of the same item content with identity
  carried**, per the OQ-1 spike). `patchElement`'s structured `(col, idx, patch,
  phase)` is already such a descriptor — prop patches become per-field `Y.Map.set`
  (no diff on the hot drag path). A whole-doc diff remains only as the last-resort
  fallback for an op that supplies no descriptor, with its loss semantics documented
  and a dev-warn.
- **Drag phases → undo scope:** `phase:'end'` (and each `apply`) calls
  `undoManager.stopCapturing()`, so one gesture = one undo step — preserving the
  ADR 0310/0317 "one undo step per drag" semantics under `Y.UndoManager`.
- **Remote transactions:** the binding materializes the changed slices back into a
  plain doc and feeds it through the `history.replace`-equivalent path (no local undo
  entry, no `editGen` bump beyond dirty-tracking — the CRDT is authoritative, there is
  nothing to CAS-save).
- **Undo swap:** when collab is on, `useHistoryState` is bypassed and the chassis
  undo/redo/shortcuts drive `Y.UndoManager` with `trackedOrigins: {LOCAL}` — per-user
  undo, superseding the chassis history exactly as `yUndoPlugin` supersedes
  `prosemirror-history` on the document surface (ADR 0335 Phase 2 rule, generalized).
- **`canvas.document` keeps its ProseMirror binding** (`collabExtension.ts`) — rich text
  is genuinely a different model (`Y.XmlFragment`); the chassis just provisions and
  passes handles. `collab: 'document'` vs `'elements'` selects the binding kind.

### D4 — Element identity & selection under concurrency (the load-bearing design rule)

Chassis selection (`selPath`, `multiSel {col, idxs}`) and the artifact schemas are
**positional** — ADR 0310's ruling ("positional selection → validators are PURE schema
mirrors, no identity synthesis") stands. We do **not** persist synthetic element ids
into docs (that would leak into artifact schemas, every validator, and the slides
`normalizeDeckForArtifact` divergence). Instead:

- Identity lives in the **Yjs layer**: each element is a `Y.Map` item whose identity is
  the CRDT item itself. The binding maintains the index↔item correspondence per
  transaction.
- On a remote transaction, the binding computes index displacement from the Y delta
  (inserts/deletes per collection) and **remaps** `multiSel.idxs`/`selPath`/`frameIdx`
  before the new doc state lands — a remote insert above your selection shifts it, a
  remote delete of a selected element drops it from the set (size-1 derivation of
  `selEl` keeps panels consistent, per the #1502 unified-selection model).
- **Remap atomicity (architect MEDIUM-5):** the remapped selection and the new doc
  state land in the **same React commit** (one dispatch), never split across renders —
  a frame where panels/arrange/delete read new-doc + stale-indices is exactly the bug
  class #1502 eliminated. Pinned by a Phase 3 test.
- Awareness carries each peer's selection as `{col, itemClock}` (CRDT item ids), never
  raw indices, so remote-selection highlights survive concurrent inserts.
- Frames already synthesize stable per-frame editor ids (`coerceDeck`, ADR 0310
  Phase B) — the frames `Y.Array` reuses them for remap assertions in tests.

### D5 — Presence UI + accessibility (chassis-owned)

- An awareness-driven **presence cluster** (avatars/initials + user colors) in the
  chassis toolbar, and remote-selection outlines on elements/frames rendered from
  awareness states. One implementation for all types; `canvas.document` keeps
  `yCursorPlugin` carets in-editor and shares the toolbar cluster.
- **Throttled, summarized announcements** (the ADR 0335 HIGH a11y risk, budgeted here):
  join/leave and coalesced remote-edit summaries through the existing chassis announce
  sink (RFC 0130 dual live-region + rate-limiter precedent) — never a per-keystroke
  `aria-live` firehose.

### D6 — Durable-authority parity (ADR 0335's optional 2c becomes REQUIRED)

While a room is live the CRDT snapshot is authoritative and `host.canvas` goes stale —
tolerable for one dormant type, not for six types whose History/Compare, previews,
share links, and browser projections all read `host.canvas`. This phase derives
`host.canvas` versions from CRDT snapshots:

- **Element types:** generic backend derive — decode the snapshot `Y.Doc` → `toJSON()`
  ≈ the editor doc → the type's existing save validator → a `host.canvas` version
  write. Works because for element types the Y tree IS the doc JSON. Any artifact
  **re-emit** path still routes per-type normalization (`normalizeDeckForArtifact` for
  slides — the recorded ADR 0310 rule).
- **Version provenance + cadence (architect MEDIUM-4):** derived versions are NOT
  written on the 2 s snapshot debounce (History would flood and Compare lose meaning).
  Cadence = **room-idle / room-close** plus a coarse periodic floor (order minutes);
  each derived version carries a distinct provenance marker (`source: 'collab'`) so
  History renders live-session versions honestly, and the latest derived version
  defines the CAS `baseVersion` a later solo session resumes from.
- **`canvas.document`:** derive via y-prosemirror's schema-free
  `yXmlFragmentToProsemirrorJSON` server-side if it round-trips our node set (spike
  first); fallback = elected-client derive (the seed winner posts a derived CAS
  snapshot on the same debounce). Open question §OQ-2 records the fork.
- **Writes from outside the room** (AI authoring flows, `from-artifact` re-seeds, any
  CAS save while a room is live): v1 rule = the backend save path checks for a live
  room/snapshot and, if present, **applies the saved doc into the room** as a
  server-origin whole-doc transaction (fanned to clients; concurrent keystrokes during
  the apply window lose — the standard external-import semantics). Never two silent
  authorities. **Scoped to element types (architect MEDIUM-3):** the server-side
  apply uses a *generic* JSON↔Y mirror (any object → `Y.Map`, array → `Y.Array`), so
  the backend stays type-schema-agnostic; `canvas.document` (`Y.XmlFragment`) cannot
  be constructed server-side without ProseMirror tooling, so external writes to a
  live *document* room route through the §OQ-2 mechanism — or, until that lands, a
  document-only 409 `room_live`. §OQ-3 records the blanket-409 alternative and why it
  was not chosen for element types (it would break "AI iterates on an open doc" for
  collab tenants).

## Feature evaluation matrix

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package | **Extension**, not a new package: `host/collab/` stays a host module (ADR 0335 ruling — boot infra on the http.Server), chassis code in `frontend/react/src/canvas/`; the thin `collaborationFeature` toggle-carrier (`features/index.ts`) is unchanged. Import boundary holds: `canvas/` never imports `features/*`; bindings arrive via the definition. |
| 2 | Toggle + admin UI | `realtime-collab` (stable id), OFF, `bucketUnit: tenant`, already in `FeatureTogglePanel`; its description string drops "canvas.document" for "all collab-capable canvas types". No per-type collab toggles — the type's own toggle (ADR 0319) composes. |
| 3 | `ctx.<feature>` workflow surface | **None.** Collaboration is a transport, not an orchestratable capability; runs never read/write CRDT state. |
| 4 | Node pack | **None.** No workflow nodes for live co-editing. |
| 5 | AI-chat envelopes | **None new.** AI authoring keeps riding each type's existing envelopes/saves; the D6 apply-into-room seam is how those writes reach a live room. |
| 6 | Agent pack | **None** — honestly not an AI surface. |
| 7 | Public surface | **None.** Authed WS only; shared/public canvas views stay read-only snapshots (presence on shared views stays deferred, ADR 0335/0013). No `PUBLIC_PATH_PREFIXES` change. |
| 8 | RBAC + isolation | The ADR 0335 auth-on-connect chain is unchanged (Origin/CSWSH → `verifySession` → toggle → `getCanvasForTenant` → per-tenant cap 25 → uniform 404/close codes); only the type check generalizes to the registry, still fail-closed. `claim-seed` keeps `requireFeatureEnabled` + tenant scoping. |
| 9 | Replay / fork | Unaffected — host-internal; no run event carries CRDT state; `from-artifact` seeding is a normal canvas create; `:fork` untouched (ADR 0335 CRITICAL verdict stands). |
| 10 | Frontend | Chassis-owned; presence UI composes `ui/` (Avatar, tokens — no literals); yjs/y-* stay **dynamic-imported out of the entry chunk** (~186 kB budget); i18n strings in the `canvas` ns ×4 locales; announcements throttled (D5). |

## RFC verdict

**Host-extension — NO new RFC.** Everything stays under
`/v1/host/openwop-app/canvas-collab/*` on this host's own origin; nothing is advertised
in `/.well-known/openwop`. The ADR 0335 trigger is unchanged and explicit: advertising
**cross-host** presence/co-editing (a capability flag, normative presence events, or a
peer-host MUST) requires a new `../openwop` RFC reaching `Accepted` first. This ADR does
not approach that line.

## Phased plan (each phase toggle-gated, separately reviewable)

| Phase | Scope | Gate |
|---|---|---|
| 0 | This ADR + the ADR 0335 §Phase 2 correction note | ADR accepted; `/architect` review of D3/D4/D6 |
| 1 | Backend generalization: registry (carrying each type's `feature.toggleId`) + pin removal + both-toggles enforcement on upgrade/`claim-seed` + `canvas-collab` rename + generic prune + orphaned `collab:update` sweep + auth-boundary test matrix (allowed type → 101; pack/unknown → 404; **type-toggle-OFF → 404**) | backend vitest green |
| 2 | Chassis hoist: resolve-once + `useCollab` + seed + save-suppression into `CanvasEditorPage`; `EditorSurfaceProps.collab`; `DocumentEditorSurface` consumes it | doc-editor suite green (solo-path guard) |
| 3 | `canvas/yDocBinding.ts`: state-diff binding + `Y.UndoManager` swap + selection remap (D4) + two-client converge tests (jsdom, provider mocked — the `collab-sync` backend tests already prove the transport) | binding unit suite; entry-chunk budget |
| 4 | Presence: toolbar cluster + remote-selection outlines + throttled announcements (D5) | FE build + a11y tests |
| 5 | Per-type rollout, one PR each: slides → app-builder → drawings → cad → campaign (`collab:'elements'` flag + type-specific remap/presence assertions; slides re-emit routes `normalizeDeckForArtifact`) | per-type tests |
| 6 | Durable-authority parity (D6): generic element derive + document derive spike + apply-into-room seam; History/Compare parity checks | backend vitest |
| 7 | FEATURES.md row + seed-coverage note; **browser/e2e two-client pass across ≥2 surface kinds** (live sync, cursors, per-user undo); **pg connection-budget reconciliation** | the two ADR 0335 enable-gates — unchanged, still block prod enablement |

Deploy is a normal backend-then-frontend ship with the toggle still OFF; enabling in
prod remains gated on Phase 7's last two items.

## Alternatives considered

1. **Per-type bespoke wiring (status quo extended ×5).** Rejected — five copies of the
   toggle/seed/save-suppression logic is the parallel-architecture anti-pattern; the
   document-editor copy already proves the drift risk.
2. **Y-first chassis ops** (rewrite `treeOps`/`elementOps` to mutate Y directly).
   Rejected — massive churn in pure, well-tested op code; the state-diff binding keeps
   the op layer byte-identical and binds at the single history seam instead.
3. **Persist synthetic element ids in docs** to solve selection identity. Rejected —
   leaks identity into positional artifact schemas and validators, contradicts the
   ADR 0310 ruling, and re-opens the slides normalize divergence. Identity belongs in
   the CRDT layer (D4).
4. **Per-type collab toggles.** Rejected — ADR 0319 already gives each type a gate; a
   collab×type toggle matrix multiplies admin surface for no isolation gain.
5. **Keep `document-collab` path + add `canvas-collab` alias.** Rejected — the surface
   is dormant with zero clients; carrying an alias forever to avoid a free rename is
   pure debt.
6. **Reject external CAS writes while a room is live (409 `room_live`)** instead of
   apply-into-room. Not chosen for v1 (breaks AI-iterates-on-open-doc); recorded as the
   fallback if the server-origin apply proves unsafe (§OQ-3).

## Open questions

- [ ] **OQ-1 (D4):** exact remap algorithm for `multiSel` under interleaved remote
  insert+delete in one transaction — derive from the Y delta or from a keyed diff of
  the frames' stable editor ids; settle in the Phase 3 spike with property tests.
- [ ] **OQ-2 (D6):** does `yXmlFragmentToProsemirrorJSON` round-trip our TipTap node set
  server-side (no schema, no DOM)? Spike before committing the backend derive for
  `canvas.document`; fallback = elected-client derive.
- [ ] **OQ-3 (D6):** server-origin apply-into-room semantics — whole-doc replace vs a
  computed minimal diff (less clobbering, more code). v1 = whole-doc replace,
  documented.
- [ ] **OQ-4:** per-tenant connection cap (25) once six types are collab-capable —
  keep, raise, or make env-tunable (`OPENWOP_COLLAB_MAX_CONNS_PER_TENANT`)? Leaning
  env-tunable with the current default.
- [ ] **OQ-5:** workflow builder collaboration — out of scope (not a canvas type);
  trigger = the DESIGN.md §7 chrome-merge landing `BuilderCanvas` on the chassis
  `EditorSurface` seam. Chat presence stays ADR 0335 Phase 5.

## Status note

No code ships with this ADR. Phases 1–7 land as separate PRs citing
`ADR 0359 Phase N`; ADR 0335's two enable-gates (browser/e2e pass, pg budget) are
inherited unchanged and still block turning `realtime-collab` on in prod.

## Correction note — prod cross-origin WS auth (2026-07-12, pre-canary architect review)

The Phase 1 auth boundary (inherited from ADR 0335) authenticated the upgrade
solely by the `__session` cookie, and `useCollab`'s header comment assumed "the
browser auto-sends the cookie to the direct backend origin (the SSE posture)".
**That assumption was wrong for production:** the WS must target the direct
`*.run.app` origin (Firebase Hosting rewrites cannot proxy a WebSocket
upgrade), but the session cookie is host-scoped to the app origin and never
travels there — the upgrade would arrive unauthenticated (401) or, worse, with
a stray anonymous cookie minted by earlier credentialed same-origin-to-run.app
fetches (wrong tenant → uniform 404). Local dev/e2e never observed this because
the Vite proxy is same-origin.

**Fix (shipped with this note):** a stateless, short-TTL (2 h), HMAC-signed
**collab ticket** — minted by `POST /v1/host/openwop-app/canvas-collab/:canvasId/ticket`
over the cookie-authed same-origin `/api`, gated by the identical uniform
toggle+tenant+type chain as `claim-seed`, scoped to one canvas + tenant, signed
with the session secret under a distinct audience prefix (a ticket can never
replay as a cookie, nor vice versa), and carried in the provider's `?ticket=`
param. The upgrade accepts ticket-or-cookie; every defect fails closed. The
ticket is deliberately stateless (no consume table): it must verify on ANY
instance, and its grant is exactly what the mint-time session already had.
Accepted residual: a session that outlives the TTL and then drops cannot
auto-reconnect (y-websocket params are static) — the existing failure UI's
Retry re-provisions with a fresh mint.

## Canary health criteria (REC-5 rollout gate)

Canary = `realtime-collab` + `document-editor` + `drawings` enabled for the
maintainer tenant only. Broad rollout requires, over ≥3 sessions on ≥2 days:

1. **Reaches Live** — the chip goes Live (WS 101 via ticket) on prod, two
   concurrent clients converge, per-user undo works (the CT script, live).
2. **`persistMisses` stays 0** in `GET …/canvas-collab/_debug` during an
   active session (a non-zero steady value is the CAS serialization-skew
   fingerprint — STOP rollout; see the grade-pass 3b note).
3. **Derive-on-close lands** — closing the last tab yields a new host.canvas
   version with `capturedBy:'collab'` (no consecutive-dup versions), and the
   canvas reopens with the same content collab-off.
4. **No resource regression** — Cloud Run instance count and Cloud SQL
   connections steady (pool 4 × instances 5 ≤ ~25); no 429 walls; no
   `collab upgrade failed` / lease-sweep error spam in logs.
5. **Failure UX honest** — killing the network mid-session shows
   Reconnecting…, then the failure card + Retry (not an infinite spinner).

Rollback at any tier: turn `realtime-collab` off **through the admin
feature-toggle surface (or by deleting the tenant override / stored row)** —
the single-writer path is untouched; live rooms evict and derive on close. A
backend revision rollback additionally reverts the transport entirely.

**Stored-row shadow (grade-pass correction):** the 2026-07-12 canary was
enabled by INSERTing stored rows for `realtime-collab` + `document-editor`
(base `status:"off"` + a tenantOverride). A stored row permanently SHADOWS the
compiled `toggleDefault` (store-first), so flipping the compiled default in a
future release is a NO-OP for these two toggles. Consequences:
- Rollback via "change the compiled default" does not work — use the admin
  surface (`saveConfig` rewrites the row) or delete the row.
- **GA cleanup step:** when broad rollout flips the compiled defaults on,
  DELETE these two rows (or rewrite them via the admin surface) or GA
  silently stays off. (Only `status`/`tenantOverrides` shadow — label,
  description, and category always come from the compiled default.)

**Threat-model notes (grade-pass):** (1) the ticket appears in the WS request
URL, so Cloud Run request-log READ access converts to a ≤2 h read/write grant
on that one canvas from any allowed Origin (Origin is a browser-only CSWSH
control) — request-log access is in-scope for the collab threat model.
(2) Tickets sign with the SAME secret as sessions (distinct audience prefix):
rotating `OPENWOP_SESSION_SECRET` invalidates all sessions AND all
outstanding tickets at once with no overlap window — the same posture as the
cookie itself, recorded here so rotation planning counts live collab sessions
among the casualties.
