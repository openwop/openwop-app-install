# ADR 0365 — One owner for canvas shell-chrome BEHAVIOR: shared blocks under `canvas/` (ADR 0361 Phase-3 debt)

Status: implemented (2026-07-13) — P1+P2 in PR #1786 (`refactor(canvas): useSurfaceChrome + RailAside`).

## Context

ADR 0361's Phase-1 correction note recorded a residual debt: after
`CanvasSurfaceShell` landed (#1780), TWO compositions of the same chrome
primitives exist under `canvas/` — the shell (engine-backed editors: the
workflow builder) and `CanvasEditorPage`'s inline wiring (doc-backed editors:
the six canvas types). The §7 canon-1 concern is drift.

Measured, the duplication is four BEHAVIOR blocks (~90–110 lines): rail
chrome (aside + chevron + separators + rail CSS vars), the shortcut-registry
window-keydown owner + `?` overlay mount, ⌘K command projection/registration,
and the zoom-handle slot api. The announcers differ (the page's is
dual-channel polite/assertive with ~52 call sites; the shell's single-channel).
The BAR is *not* duplicated — the shell has no bar frame, and the page's
bar/⋮ fold is doc-coupled (name field bound to `doc[nameKey]`, Save/CAS/
version/share cluster, quick props).

## Decision

**Extract the four duplicated blocks into shared owners; keep the two
compositions.**

1. **`canvas/useSurfaceChrome.ts`** — the ONE behavior owner: dual-channel
   announcer state (polite + assertive), the declarative-registry
   window-keydown owner (composing-guard + `inTextContext` + modal-Escape
   guard) with the `?`-overlay open state, ⌘K projection of enabled registry
   entries + `registerCommandSource` lifecycle, and the §7.3 zoom-handle slot
   api. Parameterized by: the command-source id (FROZEN — `canvas-editor` /
   `workflow-builder`), the type translator for `group: 'type'` labels, and
   the commands-group heading.
2. **`canvas/RailAside.tsx`** — the rail aside/chevron chrome (className,
   labels, collapsed state, toggle) both compositions render; rail
   persistence stays each composition's `useRailLayout(<frozen key>)` call.
3. **`CanvasSurfaceShell` refactors internally** to consume the blocks with
   NO config-API change (BuilderShell and the shell tests are untouched).
4. **`CanvasEditorPage` swaps its inline wiring** for the blocks with zero
   intended behavior change (announce keys, rail keys, ⌘K id, overlay
   semantics all identical).

**The two compositions are an ACCEPTED, documented split** — doc-lifecycle
(load/save/CAS/version/share around a `useHistoryState` doc) vs
engine-lifecycle (surface owns model/undo/persistence). This supersedes the
"fold fully onto one composition" aspiration recorded in ADR 0361 Phase 3
with a cheaper equivalent that kills the drift class that has actually
occurred (behavior wiring), leaving only ~30-line layout orderings per
composition.

## Alternatives considered

- **Full fold (page composes the shell; shell grows doc-aware slots)** —
  rejected for now: it forces the announcer inversion (52 call sites
  announcing through shell ctx via ref indirection) and slotifies a
  2.8k-line page's doc-coupled bar, the highest regression surface on the
  app's most-used pages, for no additional drift-kill over shared blocks.
- **Leave as-is** — rejected: the behavior blocks WILL drift (the §7 program
  already patched registry/rails behavior twice in two places).

**Falsifiability:** if a future §7 chrome change still has to land twice —
in both compositions' JSX rather than in a shared block — the full fold
becomes justified; add the correction note here and do it then.

## Phases

| Phase | Scope | Gate |
|---|---|---|
| 1 | `useSurfaceChrome` + `RailAside`; shell refactors internally (config API + tests unchanged) | shell tests green unchanged |
| 2 | `CanvasEditorPage` swaps inline wiring for the blocks | full FE suite + live CT spot pass (drawings, slides, campaign, builder), zero behavior change |

## Wire/RFC

None. Frontend-internal refactor under `canvas/`. Compatibility: none.
