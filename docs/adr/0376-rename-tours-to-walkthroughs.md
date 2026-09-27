# ADR 0376 — Rename "tour*" → "walkthrough*" (source + a gated persisted-id migration)

Status: implemented (Phases 1-3, 2026-07-16). DEPLOYED — backend rev
`00510-8mv` (the version-2 APP_MIGRATION ran on boot; log
`app_migration_walkthrough_toggle_copied` confirms the prod canary toggle was
copied `guided-tours`→`walkthroughs` with the tenant override preserved, old
rows left intact) + frontend `index-DDFfT7aq`; readiness 200, `/walkthroughs`
route 200, retention env preserved.

Date: 2026-07-16
Lane: cross-cutting seam (naming) + migration
RFC verdict: **host work only.** The renamed identifiers (`ui.tour.*` node types,
the `tour-step` interrupt kind, the `guided-tours` toggle, host-ext routes) are
all host-local — the node types join the host kind unions (host already exceeds
the wire enum), the interrupt kind is host-rendered, the toggle + routes are
non-normative `/v1/host/openwop-app/*`. Nothing on the OpenWOP wire changes.

## Why

"Tour" undersells what was built. ADR 0368's engine is a general **interactive,
workflow-driven walkthrough** of the real app — an ordinary workflow of
`ui.tour.step`/`ui.tour.checkpoint` nodes whose interrupts a client player
performs + resolves. THREE surfaces ride it (ADR 0374): manual **tests**
(`/test`), **tours** (`/tours`), and **tutorials** (`/tutorials`) — each launches
the same engine by `tourId`. Naming the engine "tour" hides that generality.

**Chosen word: `walkthrough`** (not "dynamic"). "dynamic" was the maintainer's
first choice but it **already means something here** — ADR 0369 is *Transient
("dynamic") workflows*, with a "Dynamic Workflows" builder tab and
`workflows.compose-and-run`. Renaming tour→dynamic would collide two concepts
(is "a dynamic workflow" the transient-lifecycle kind or the walkthrough kind?).
"walkthrough" is collision-free and industry-standard (Pendo/Appcues/WalkMe).

## Decision

### 1. Source rename (Phase 1) — mechanical, zero data risk
Rename every SOURCE artifact `tour* → walkthrough*`: files, directories,
variables, methods, hooks, UI components, i18n keys (×4 locales in parity),
comments, and user-facing routes (`/tours → /walkthroughs`, the host-ext
`guided-tours/*` route paths). Persisted identifier **string VALUES are held
stable** in Phase 1 (the constant NAMES rename, e.g. `TOUR_STEP_TYPE_ID →
WALKTHROUGH_STEP_TYPE_ID`, but still `= 'ui.tour.step'`) so the tree stays green
and no data breaks mid-rename.

### 2. Persisted-id migration (Phase 2) — new ids for new data, back-compat for old
Each replay-critical / stored identifier moves to a `walkthrough*` value **with a
back-compat path** so existing runs replay and the prod canary survives:

| Persisted id | Old value | New value | Back-compat |
|---|---|---|---|
| Node type | `ui.tour.step` / `ui.tour.checkpoint` | `ui.walkthrough.step` / `.checkpoint` | register BOTH ids → same impl (alias); new defs emit the new id; old defs/runs resolve via the alias |
| Interrupt kind | `tour-step` | `walkthrough-step` | new interrupts raise the new kind; the player + interrupt-card path ACCEPT BOTH; a migration rewrites OPEN (unresolved) interrupt kinds |
| Toggle id | `guided-tours` | `walkthroughs` | migration COPIES the stored `hostext:feature-toggle:guided-tours` row (incl. `tenantOverrides` — the prod canary) to the new key; compiled default uses the new id |
| Progress collection | `guided-tour-progress` | `walkthrough-progress` | migration copies rows |
| Builtin workflow id | `tour.campaign-studio.first-brief` | `walkthrough.campaign-studio.first-brief` | new builtin id; migration rewrites progress-row `tourId`; the old id stays registered as an alias so in-flight runs resolve |
| Authored id prefix | `tour.authored.` | `walkthrough.authored.` | forward-only (new drafts); old transient drafts are short-lived / gc'd |

Phase 2 lands as an `APP_MIGRATIONS` entry (contiguous, forward-only) + replay-
safety tests (an old-typeid def still resolves; a `tour-step` interrupt still
renders; the copied toggle row preserves the canary override).

### 3. ADR-history discipline
Per CLAUDE.md ("correct, don't rewrite history"), ADR 0368 + 0374 are **not**
wholesale-renamed. Each gets a one-line terminology **correction note** pointing
here; the persisted ids they describe (`ui.tour.step`, etc.) remain accurate as
the pre-migration values, with this ADR recording the new values + aliases.

## Alternatives weighed
- **Word = "dynamic" (as asked):** rejected — collides with ADR 0369.
- **Source-only, keep persisted ids forever:** safe, but the maintainer chose
  full consistency; Phase 2 achieves it without breaking replay via aliasing.
- **Full rename, no aliases (hard cutover):** rejected — breaks replay/`:fork`
  of in-flight tour runs and orphans the prod canary toggle row.

## Open questions
- OQ1: retire the `ui.tour.*` / `tour-step` aliases after a deprecation window
  (once no run older than the window can reference them)? Deferred — cheap to keep.
- OQ2: redirect `/tours → /walkthroughs` for existing bookmarks, or hard-rename?
  Phase 1 hard-renames (low external usage; internal admin surface).

## Phased plan
| Phase | Scope | Gate |
|---|---|---|
| 1 | Source rename (FE + BE), persisted VALUES stable | `npm run build` + backend tsc/vitest green |
| 2 | Persisted-id migration + aliases + `APP_MIGRATIONS` + replay tests | backend vitest + migration-integrity |
| 3 | Deploy (backend migration FIRST, then frontend) + verify canary toggle preserved | DEPLOY-SMOKE |
