# ADR 0194 — Feature dependency graph, disable-lock, and the plugin lifecycle

**Status:** implemented (Phases 1–5 — complete)
**Date:** 2026-07-03
**Depends on:** ADR 0001 (feature-package + toggle model), ADR 0022 (Marketplace — browse + install), ADR 0006 (RBAC)
**Toggle:** none (extends the always-on feature-toggle admin surface)
**Surface:** authed superadmin `/v1/host/openwop-app/feature-toggles/admin/*` (host-extension, NON-NORMATIVE — no wire, no new RFC)

---

## Context

The app already has the two load-bearing halves of a WordPress-style "plugin"
platform:

- **Browse + install** signed feature packs — the **Marketplace** (ADR 0022): a
  computed listing projection + `registryInstaller` (Ed25519 + SRI) install +
  reviews.
- **Turn a feature on / off / beta / multivariant** — the **feature-toggle
  system** (ADR 0001 §3): backend-authoritative resolution, per-tenant overrides,
  sticky-bucketed variants.

Two pieces of the "extend the core like plugins" vision were only ever
**scaffolded**, never wired (confirmed by a codebase audit):

1. **No feature→feature dependency graph.** `BackendFeature` declared
   `requiredPacks` (pack-level) and pack `peerDependencies` classification exists
   (`agentLoader.resolveDependencyDisposition`, RFC 0072 §C), but nothing modelled
   "feature X needs feature Y." Implicit deps live only in code (Forms→CRM,
   Email→CRM, Priority-Matrix→kanban, Strategy→PM/Projects/Advisors).
2. **No "remove to reduce footprint."** `listingService` computes a `requiredBy`
   reverse map with the comment *"so a UI can warn before an uninstall,"* but it is
   **dead metadata** — there is no `/uninstall` route and nothing reads it.

ADR 0022 itself recorded the reopened questions this ADR answers: **alt. 4**
(per-tenant pack enablement vs process-global install) and **open question #5**
(browsing installable *features*, not just packs).

## The decision that unlocks the rest: "remove" is THREE different operations

The WordPress single-site analogy conflates them; openwop-app is **multi-tenant
with process-global pack install**, so they must be named separately:

| User intent | The honest operation | Owner | Status |
|---|---|---|---|
| "Turn it off for my workspace" | per-tenant toggle override → `off` (nav hides, routes 404, fails closed) | feature-toggle system | **exists** |
| "This host shouldn't offer it at all" | per-tenant pack **enablement** gate over the global install (ADR 0022 alt. 4) | Marketplace + toggle | deferred (Phase 3) |
| "Delete it from the host to reclaim footprint" | superadmin, process-global **uninstall** | `registryInstaller` | deferred (Phase 4), **replay-gated** |

A single "Remove" button that hides this distinction would be a correctness bug.
The per-tenant "make it go away" need is **already served** by the toggle `off`
override; true backend deletion is a rare, dangerous, superadmin-only operation.

### Why backend uninstall is NOT Phase 1 (the replay invariant)

`ARCHITECTURE.md` is explicit: *"Feature toggles gate activation, not pack
presence, so historical runs can still resolve their node and agent types."*
Deleting a feature's packs breaks replay/`:fork` of any historical run that
dispatched its nodes — silently, at replay time. So backend uninstall may ONLY
ship as either (a) blocked while any run history references the feature's nodes,
or (b) a **tombstone** (marked removed, a resolution shim degrades replay to a
`node_type_removed` artifact). Never a bare `rm`. This is deferred to Phase 4.

### Footprint is mostly a frontend concern (already ~solved)

Feature **page bodies** are already `lazy()`-split out of the initial bundle
(`features/<id>/routes.tsx`); only the thin registration shells are eager. A
disabled **backend** feature costs near-zero at runtime (routes gated, packs
loaded-but-not-dispatched). So "reduce app footprint" buys little from backend
deletion and a lot from the already-present code-splitting — another reason to
defer deletion and prefer disable.

## Decision (Phase 1 — shipped)

Add a **hard feature-dependency graph** to the feature-package contract and
enforce it as a **disable-lock**, entirely as an additive extension of the
existing toggle system. No new store, no new toggle, no wire change.

### The model

- `BackendFeature.dependsOn?: string[]` — hard deps (ids of features this one
  needs). `BackendFeature.recommends?: string[]` — soft deps (advisory only,
  reserved for a later phase; declaring records the relationship without behavior).
- At boot, `registerBackendFeatures` registers each feature's `dependsOn` into a
  dependency graph kept **beside the toggle defaults** (`featureToggles/registry.ts`)
  — one registry, no second source of truth for "what features exist and relate."
- **Disable-lock** (`service.computeDisableBlockers`): a feature MUST NOT be set
  `off` while an **enabled** feature hard-depends on it (that would orphan the
  dependent). The admin `PUT …/configs/:id` returns **`409 conflict`** with
  `details.dependents` listing the blockers. Backend is the authority.
- **Projection endpoint** `GET …/admin/dependencies` → per-feature
  `{ dependsOn, dependents, blockedByDependents }`, computed over the graph +
  effective toggle state (no stored model). The admin panel reads it to **lock the
  Off control** and render *"required by …"*; the 409 is the enforced boundary
  behind that pre-gate.

### Semantics honored

- **Always-on deps are always satisfied.** A feature that graduated off its toggle
  (no `toggleDefault`) has no `off` state, so it never blocks and is never a lock
  target — the resolution path naturally excludes it (finding: never false-lock
  core substrate). Conversely an always-on *dependent* is treated as permanently
  enabled, so a toggle-able feature it needs can't be silently disabled.
- **Single source of truth.** The dependency graph is registered from
  `BackendFeature`, not duplicated; the admin projection reads the graph + live
  toggle state, never a parallel catalog store (the `/insights-suite` anti-pattern).
- **Real deps declared, incrementally.** Phase 1 declares the two unimpeachable,
  live-testable ones: `email` → `crm` (a campaign resolves its audience from CRM
  contacts) and `forms` → `crm` (capture → CRM contact). CRM is ON by default
  (ADR 0191), so the lock is exercised immediately. Other features declare their
  real deps as follow-on one-line additions; the graph is now the home for them.

  > **Correction (2026-07-10, ADR 0330):** the `forms → crm` edge is REMOVED.
  > Forms no longer imports `../crm` at all — the contact write inverted onto a
  > forms-owned submission-sink seam that CRM registers (and toggle-checks)
  > itself, so disabling CRM cannot orphan forms. `email → crm` remains the
  > live hard dep; later declarations (`csm`/`commerce` → `crm`) still hold.
  > The mechanism this ADR built is unchanged — only the edge inventory moved.

### Limitations (documented, follow-on)

- The lock evaluates effective **global** status. A dependent enabled only via a
  per-tenant override while the global default is `off` is not counted; a full
  per-tenant-override coherence sweep is a follow-on (it composes the same
  `computeDisableBlockers` at the override choke point).
- `recommends` (soft deps / install suggestions) is contract-only in Phase 1.

## Phased plan

| Phase | Scope | Status |
|---|---|---|
| **1** | `dependsOn`/`recommends` contract + dependency graph + disable-lock (409) + `/admin/dependencies` projection + panel Off-lock affordance + `email`/`forms` → `crm` | **implemented** |
| 2 | Unified "Plugins" console: the Feature-toggles admin screen gains the WordPress-style row — dependency chips, per-pack presence chips (`installed`/`mounted`/`missing`), and an "Open" link projected from the `FEATURES` manifest — **composing** the existing `ToggleCard` control (no third toggle writer). Backend: `registerFeaturePacks` boot registry + `packPresence` (core `registryInstaller`) + the console projection. **Correction:** Phase 1's `GET /admin/dependencies` renamed to `GET /admin/features` (the projection grew packs and will grow Phase 3/4 state; sole consumer is the same-repo panel, superadmin, non-normative — no external contract broken). | **implemented** |
| 3 | Per-tenant pack **enablement** (ADR 0022 alt. 4): a sparse DENY store (`marketplace:pack-disable`, keyed `${tenantId}:${packName}` — default all-enabled) + the `host/packVisibility` inversion seam (`setDisabledPacksResolver`, the `setSubjectOrgResolver` pattern; fail-open to empty — curation, not authz). Gates **authoring surfaces only**: the builder palette (`GET /node-catalog` tenant-filtered), new-definition registration (`assertNoDisabledPacks` on `POST /workflows` + `/workflows/from-chain` → 403 `forbidden` + `details.disabledPacks`; unknown typeIds keep today's no-closed-world behavior), and the AI workflow-author catalog (route + `ctx` surface, same seam). Runs/replay/`:fork` never consult it. Marketplace routes `GET/PUT /marketplace/pack-enablement` (toggle-gated; workspace self-service — the BYOK-keys trust class; tenant from `req` only) + the MarketplacePage "Available in this workspace" control. Disables persist if the marketplace toggle later turns off (data persists; the curation UI is gated). Open Q: tighten the PUT to a workspace-admin role once workspace-role helpers exist. | **implemented** |
| 4 | Two-tier superadmin **uninstall** (marketplace-owned): **TOMBSTONE** (default — bytes stay, replay untouched; hidden from node catalog/palette/AI author/install host-wide; listing flagged 'Removed' + Restore) and **PURGE** (`?purge=true`, only while tombstoned; **409 while any registered workflow definition references the pack's typeIds**; deletes the dir, KEEPS the tombstone row so boot loaders never resurrect). Protected classes refuse removal outright: feature-pinned packs (`requiredBy` — the Phase-1 guard finally wired end-to-end) and `core.openwop.*` (host substrate). **Correction (design review):** the tombstone is a **durable row** (`host/packTombstones.ts`, boot-loaded cache) — NOT a file marker, which purge would delete and Cloud Run's per-instance pack dirs would lose; cross-instance freshness = next boot, the same class as install itself (ADR 0022). `packPresence` gains a `tombstoned` tier (console chips). **Decision — FE registry-shell tree-shaking NOT built:** page bodies are already `lazy()`-split; the eager registration shells are thin, and a fork-config exclusion mechanism adds complexity for negligible bytes. Recorded here instead of silently dropped; revisit only if bundle budgets tighten. | **implemented** |
| 5 | **Per-tenant-override coherence** + **soft-dep suggestions** (the two §Limitations follow-ons). `computeDisableBlockers` now resolves BOTH sides per scope (override → global) and returns `DisableBlocker[]` (`{dependentId, tenantId\|null}`) — catching the case Phase 1 missed: disabling a dependency via a tenant override, or the global default, while a dependent is enabled only for that workspace. The `409` carries `details.blockers` (per-scope) + `details.dependents` (unique ids, back-compat); the console's `blockedByDependents` uses **enabled-anywhere** so the global Off pre-gate conservatively catches per-tenant orphans too. **`recommends`** (the Phase-1 contract field) is now registered (`registerFeatureRecommends`) and surfaced in the console (`recommends` + `recommendedOff`) as an advisory **suggestion chip** ("Works better with …", highlighted when off) — never a lock. First declared: `analytics recommends ['consent']` (the consent-gated beacon stays compliant with consent management on). | **implemented** |

## Alternatives considered

1. **Naive backend `rm` uninstall for "footprint."** Rejected — breaks the
   replay/pack-presence invariant silently. Only tombstoned/ref-gated deletion is
   permissible (Phase 4).
2. **A per-tenant "remove" that deletes packs.** Rejected — impossible under
   process-global install; the honest per-tenant operation is the toggle `off`
   override (already exists) or Phase 3 enablement.
3. **A separate `FeatureCatalog` store for the plugin list.** Rejected — the
   feature set is already owned by `BACKEND_FEATURES` + the toggle registry;
   project from it, never duplicate (would drift; the `/insights-suite` failure).
4. **`dependsOn` on `ToggleConfig` instead of `BackendFeature`.** Rejected — a
   dependency is a property of the feature package, not of its toggle's
   status/variants; it lives on `BackendFeature` and is registered into the toggle
   registry at boot for enforcement.

## Implementation (Phase 1)

| What | Where |
|---|---|
| `dependsOn` / `recommends` on the feature contract | `backend/.../features/types.ts` |
| Dependency graph (register / dependents / dependencies) | `backend/.../host/featureToggles/registry.ts` |
| Disable-lock + graph projection | `backend/.../host/featureToggles/service.ts` (`computeDisableBlockers`, `buildFeatureDependencyGraph`) |
| Boot registration | `backend/.../features/index.ts` (`registerFeatureDependencies`) |
| 409 enforcement + `GET /admin/dependencies` | `backend/.../routes/featureToggles.ts` |
| Real deps declared | `features/email/feature.ts`, `features/forms/feature.ts` (`dependsOn: ['crm']`) |
| Admin Off-lock affordance | `frontend/.../featureToggles/FeatureTogglePanel.tsx` + `client/featureTogglesClient.ts` + 4-locale strings |

Tests: `backend/.../test/feature-toggle-dependencies.test.ts` (5 — registry
reverse-map + dedupe/hot-reload; route-level: graph exposes `email`/`forms` → `crm`
edges, disabling `crm` while `email` enabled → 409 with `details.dependents`, the
graph reflects the live lock, disabling `crm` succeeds once no dependent needs it).
Backend `tsc --noEmit` clean; frontend `npm run build` (token/CSS gates) green.

## Post-implementation review note (hardening)

A full-implementation `/architect` pass (all four phases composed) found the
plugin lifecycle sound — the replay invariant is honored end-to-end, boundaries
are clean, and error codes reuse the exhaustive union. One **defense-in-depth**
gap was fixed: the Phase-4 purge `rmSync(join(packDir, packName))` trusted the
pack-name shape only via the upstream `getListing` existence gate (a `../` name
was unreachable *today*, but a future gate relaxation would open a superadmin
arbitrary-directory delete). Added `isSafePackName` (`packs/registryInstaller.ts`
— a path-escape-only check, deliberately looser than the publish-surface
`PACK_NAME_RE` because the marketplace also handles in-tree `feature.*` packs)
and applied it at every filesystem-touching marketplace route (remove / purge /
restore / install) → `400 invalid_pack_name`. Tests: a route-level traversal
rejection (sentinel dir untouched) + an `isSafePackName` unit table
(`test/pack-uninstall.test.ts`, now 7). Accepted-and-documented (not fixed): the
narrow purge reference-scan→`rmSync` TOCTOU (superadmin-only; tombstoned nodes
aren't in the palette; blast radius is a future `host_capability_missing`, not
corruption) and the pre-existing `packPresence` vs `listingService` dual on-disk
scanners (a future consolidation, not this series' debt).

## Open questions (carried to later phases)

- [x] Per-tenant-override coherence sweep (Limitations) — **Phase 5**: `computeDisableBlockers` resolves per scope, returns `DisableBlocker[]`, enforced at the route.
- [x] Should `recommends` drive install/enable suggestions in the console? — **Phase 5**: yes, as an advisory suggestion chip (never a lock); `analytics recommends consent` declared.
- [x] Tombstone shape (Phase 4): durable-row tombstone + definition-reference-gated purge. Purge gate covers REGISTERED definitions only — replay resolves through definitions, and a run whose definition was already deleted is undefined-replay territory today independent of packs; revisit if per-run definition snapshots land.
- [ ] Derive some `dependsOn` edges from pack `peerDependencies` to avoid two graphs
      drifting (finding #6) vs. keep them independently declared.
