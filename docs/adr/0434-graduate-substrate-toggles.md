# ADR 0434 — Graduate four substrate toggles to always-on, and retire one inert switch

**Status:** implemented — 2026-07-19 (all phases; see § Implementation record).
**Date:** 2026-07-19
**Depends on:** ADR 0001 (feature-first packages), ADR 0010 § Correction
(notifications — "a toggle only hid the UI while side effects flowed"), ADR 0024
§ Correction (connections — "platform plumbing, not an optional *product*
surface to A/B"), ADR 0027 (cms/media/publishing), ADR 0134 (the 14-chat-feature
graduation recipe), ADR 0144 § Correction (access-hub — a graduated console's
subsumed surfaces drop their nav), ADR 0148 (context economy), ADR 0197
(run-input forms), ADR 0229 (planning surfaces on by default — the
*counter*-precedent), ADR 0270 (developer keys), ADR 0366 P4 (the
core/bundle/standalone distribution tiers), ADR 0419 (paid feature bundles).
**Surface:** host-extension only. One new read-only superadmin route
(`GET /v1/host/openwop-app/feature-toggles/admin/env-governed`).
**Wire impact:** none. No capability advertisement, run event, or endpoint
contract changes — **no RFC required** (this app is a conformant host; toggles
are non-normative host configuration).

---

## Context — two catalogs that disagree

This app classifies every feature **twice**, independently:

1. The **toggle catalog** — `BackendFeature.toggleDefault` in each
   `features/<id>/feature.ts`. It asserts: *this is optional; an operator may
   switch it off.*
2. The **distribution catalog** — `distributions/bundles.json`, sorting every
   feature into `core` (boot-critical substrate, **not excludable** from any
   build) / `bundles` (sellable groupings) / standalone. It is CI-enforced by
   `scripts/gen-distribution.mjs --check`, is `dependsOn`-closed, and is the more
   considered judgment because a wrong answer produces an un-buildable slim
   distribution.

At the time of this ADR, **19 features were in `core` yet still carried a
toggle.** `core ⊅ always-on` is legitimately one-directional (a feature can be
non-excludable *and* per-tenant switchable — `billing`, `marketplace`, `orgs`
are all correctly in that state). But it also makes `core ∩ toggled` the exact
place where a *dead* toggle can hide: something the build already treats as
substrate while its toggle still advertises it as a product option.

Auditing those 19 (plus all 81 live toggles) against the graduation rationales
this repo has already used four times, **five** were found to be gating nothing
an operator should be choosing. This ADR resolves those five, and — as important
— records why the other 76 keep their toggles.

### The bar, restated from precedent

Graduation is warranted when a toggle is one of:

- **Dishonest** — side effects flow regardless; the toggle only hides UI
  (ADR 0010, notifications).
- **Plumbing** — a shared seam other features import, not a product surface to
  A/B (ADR 0024, connections).
- **Load-bearing for an always-on surface** (ADR 0027, cms/media powering the
  public front page).
- **Superseded by a finer, honest gate** — RBAC, a per-user preference, a
  per-surface default-deny (ADR 0134's residual gates).

And explicitly **NOT** warranted merely because a feature is mature, popular, or
default-ON. **ADR 0229 is the governing counter-precedent**: it flipped
`strategy` / `priority-matrix` / `advisory-board` from off→on and *deliberately
kept* their toggles — *"the default is a floor, not a lock."* This app therefore
has **three** intentional states, not two:

| State | Meaning |
|---|---|
| `off` | born-off (the `FEATURES.md` § "Adding a feature" convention for every new feature) |
| `on` | promoted; an operator may still disable it — **a resting place, not a waystation** |
| graduated (no `toggleDefault`) | no operator could reasonably switch this off |

---

## Decision

Graduate **four** features off their toggles, and **retire** a fifth that was
never a real switch. All five were already `core`, so no bundle moves and no
paywall interaction (see § Rejected).

### 1. `run-input-forms` → always-on

The toggle was an explicit, self-documented pre-GA gate. Both call sites said so
verbatim: *"gated on the `run-input-forms` toggle so behavior is opt-in **until
the toggle GAs**"* (`host/runInputValidation.ts`, `routes/runs.ts`). It has
GA'd. It also gated a behavior on the **core** runs surface from inside a
feature package — the gate lived in `routes/runs.ts`, which is the ADR 0001
boundary smell (a feature toggle reaching into core), and is itself evidence
this was never a product curtain.

Validation remains **fail-open by construction**: no `inputSchema`, or a schema
Ajv cannot compile ⇒ the run proceeds exactly as before. See § Risks for the one
real behavior change.

### 2. `sharing` → always-on

`sharingService` is imported directly by **five unrelated features** —
`commerce/routes.ts` (`assertLiveLinkFor`), `crm/signRoutes.ts` and
`crm/bookingRoutes.ts` (`resolveActiveResource`), `canvasEditorRoutes.ts`
(`purgeLinksForResource`), `commerce/commerceService.ts` (`createLink`). It is a
host seam.

The toggle had **already admitted this**: ADR 0402 had to add an
`enforceSharingToggle: false` carve-out so CRM booking/e-sign capability tokens
would survive the toggle being off. A seam that needs a bypass hatch is
plumbing. The hatch is **removed along with the toggle** rather than widened —
the exception existed precisely because gating capability tokens on a
*content-sharing* toggle was wrong.

What still gates the public surface, unchanged: the unguessable token IS the
credential (charset-validated), plus revocation, expiry, and the org↔tenant
binding — uniform 404 on any failure. Authed link management keeps org-scoped
RBAC; only the toggle half of `authorizeOrgScope` is gone (→ `requireOrgScope`,
the ADR 0134 conversion). **Each resolver still applies its OWN feature's
toggle** (`creative-briefs`, `app-builder`, `slides`, `crm`) before returning
content, so no feature becomes shareable that was not already. This is the ADR
0134 `chat-widget` posture: always-on route, default-deny content.

### 3. `developer-keys` → always-on

The gate was **half-open and security-relevant**. `verifyApiKey` runs
unconditionally in core auth (`middleware/auth.ts`, the `owk_` bearer branch),
so keys already minted keep authenticating when the toggle is flipped off —
only the rotation/revocation UI disappears. *A switch that removes your ability
to revoke a credential while the credential keeps working is worse than no
switch.* (`features/entities/routes.ts` also imports `verifyApiKey` directly
without declaring `dependsOn`, so the toggle graph could not see that coupling
either — recorded in § Follow-ups.)

Graduating matches the Connections precedent exactly (ADR 0024 § Correction — a
credential broker is platform plumbing). Authority is unchanged and is the real
gate: an authenticated principal is required to manage any key, and `keyScopeOf`
keeps self-service callers to their own keys while admin/owner see the tenant's.
The feature's stale doc comment ("wiring verification into `middleware/auth.ts`
is a separate, security-reviewed step") is corrected — that step landed.

### 4. `models` → always-on

The toggle only ever chose a **navigation shape**, never a capability: ON
rendered one hub with two tabs; OFF rendered the same two routes standalone via
`hiddenWhenFeature`. Both destinations were reachable in both states. It was an
unresolved IA decision deferred to per-tenant configuration. Its contents
(`model-router`) had already graduated in ADR 0134 — the wrapper outlived the
thing it wrapped.

Following the ADR 0144 access-hub precedent, the subsumed surfaces
(`model-router`, `evals`) **drop their standalone `nav` blocks** rather than
keep a `hiddenWhenFeature: 'models'` that can now never fire, and `models`
leaves `AdminOverviewPage`'s `CONSOLE_IDS`. The `evals` toggle still gates its
hub *tab*.

### 5. `context-economy` → toggle RETIRED (not graduated)

This one is different in kind and deserves its own verdict. The toggle
**gated nothing**. `host/contextEconomy.ts` says so plainly: it is registered
*"ONLY to register the toggle so the feature is visible/governable in the admin
toggle console"* and *"does NOT gate dispatch-layer behavior"* — the dispatch
layer is tenant-agnostic by design and reads `OPENWOP_CONTEXT_ECONOMY*` directly.

That is a **lying switch**: a superadmin could flip it and observe exactly zero
effect, in either direction. That is worse than an absent control — one that
appears authoritative but is inert misinforms the operator about what governs
their bytes and their spend.

The *visibility* need was real, so it moves to a control that cannot lie:

```
GET /v1/host/openwop-app/feature-toggles/admin/env-governed   [superadmin]
```

returning the **resolved** env state (master + each of the five levers, each
labelled with the env var that owns it). Same discoverability, in the same admin
console, with honest authority — the operator lever is the deploy env, and the
console now says so instead of pretending to own it. The endpoint is additive by
design: future env-only capabilities append there rather than minting inert
toggles.

**Deliberately unchanged:** the tenant-agnostic dispatch layer. Wiring a
per-tenant toggle into provider dispatch would couple the tenant model into a
layer that has (by design) none — the ADR 0148 split stands.

---

## Alternatives weighed

1. **Graduate the 13 default-ON features instead** (the intuitive read: "these
   are proven, promote them"). **Rejected** — and it is the most important
   rejection here.
   - `crm` carries the app's **only live variant experiment** (a 50/50 split
     with real node bindings on `crm.triage`). Graduating destroys the sole
     working demonstration of the multivariant + bindings system that
     `FEATURES.md` documents at length. It also has four hard dependents.
   - `crm` and `analytics` sit in the **priced** `crm` bundle. Graduating forces
     removal from the bundle (`core ∩ bundle` is a `gen-distribution` error),
     which either strands a priced SKU or silently kills the "buy to unlock"
     affordance — `useFeatureLocked` returns `false` for any feature with no
     toggle entry, so the lock UI vanishes with **no error**. ADR 0419's
     `priced ⟹ gated` invariant is prose, not an automated check, so nothing
     would have caught it.
   - `advisory-board` / `priority-matrix` / `strategy` are ADR 0229's explicit
     keeps.
   - `documents` / `slides` / `app-builder` / `cad` / `drawings` /
     `campaign-studio` all sit in sellable bundles (`studio`, `documents`,
     `canvases`) — same trap.
   - `chat-autotitle` is a **per-user preference** (`bucketUnit: 'user'`; its
     toggle description is written as user-facing copy). The toggle IS the
     honest control ADR 0010 asks for. Same for `multi-tab-chat`.
2. **Also graduate `consent`** (it is the most-recommended feature in the repo
   and several features import `isAllowed`). **Rejected** — toggle-off is
   deliberately *permissive* ("honest opt-in"). Graduating would flip every
   tenant into an enforcing consent regime and start denying analytics and
   marketing sends. That is a behavior change wearing a cleanup's clothes. The
   part that genuinely is substrate (`STRICT_EXPLICIT_OPT_IN` / WhatsApp) is
   already toggle-independent. Correctly designed; left alone.
3. **Also graduate `settings` / `entities` / `environments`** (all `core`,
   all Platform/Admin-category). **Rejected as premature** — all three landed
   2026-07-17, two days before this ADR, with no independent consumers.
   Graduating would ship unexercised code. `environments` can rewrite live
   feature-toggle state (highest blast radius in the audit).
   `settings` is the best future candidate once it has soak time.
4. **Keep `context-economy`'s toggle and wire it into dispatch** so it stops
   lying. **Rejected** — that is exactly the tenant-coupling ADR 0148 forbids.
5. **Delete `context-economy`'s toggle with no replacement.** **Rejected** —
   loses the real visibility need; an operator would have no in-app way to see
   which levers are live.
6. **Delete the now-empty route-less feature packages** (`run-input-forms`,
   `models`), per the ADR 0144 access-hub treatment. **Rejected** —
   `gen-distribution.mjs` requires every `core` id to be **registered** (it
   detects registration from the `import { xFeature }` line in the registry), so
   deleting the package while the id stays in `core` fails the gate. They stay
   registered with no `toggleDefault`. ADR 0144 could delete access-hub only
   because it predated the core tier.

---

## Implementation record

| # | Change | Artifacts |
|---|---|---|
| 1 | `run-input-forms` graduated | `features/run-input-forms/feature.ts` (§ Correction, `toggleDefault` removed); `routes/runs.ts` (gate + now-unused `resolveOne` import removed); `host/runInputValidation.ts` (doc corrected) |
| 2 | `sharing` graduated | `features/sharing/feature.ts` (§ Correction); `features/sharing/routes.ts` (`authorizeOrgScope`→`requireOrgScope` ×4, `FEATURE` removed); `features/sharing/sharingService.ts` (toggle gate + `enforceSharingToggle` opt + `TOGGLE_ID` removed) |
| 3 | `developer-keys` graduated | `features/developer-keys/feature.ts` (§ Correction, stale auth-wiring note corrected); `features/developer-keys/routes.ts` (`requireEnabledPrincipal`→`requirePrincipal`; toggle imports removed) |
| 4 | `models` graduated | `features/models/feature.ts` (§ Correction); FE `features/models/routes.tsx` (`featureId` dropped), `features/model-router/routes.tsx` + `features/evals/routes.tsx` (standalone `nav` blocks dropped), `settings/AdminOverviewPage.tsx` (`CONSOLE_IDS`) |
| 5 | `context-economy` retired | `features/context-economy/feature.ts` (§ Correction); `routes/featureToggles.ts` (new read-only `/admin/env-governed`) |
| 6 | Ghost-override retirement | `features/index.ts` — all five appended to `RETIRED_TOGGLE_IDS` with a dated block |
| 7 | Stale toggle-scoped config removed | `host/seedCoverage.ts` (4 `ACKNOWLEDGED_UNSEEDED` entries); `host/demoProvision.ts` (`developer-keys` from `DEMO_FEATURE_TOGGLE_IDS`) |
| 8 | FE gates removed | `runs/RunsIndexPage.tsx`, `features/sharing/SharingPage.tsx`, `chat/ChatSidebar.tsx`, `chat/tabDeck/TabSession.tsx`, `features/sharing/routes.tsx` |
| 9 | Tests | see § Tests |

`distributions/bundles.json` is **unchanged** — all five were already `core`,
which is the finding that motivated this ADR.

### The `feature.ts` trap

`gen-distribution.mjs` detects "always-on" by scanning the raw file text for the
`toggleDefault:` **property**. A commented-out block would silently defeat the
core-membership check. Every graduated file therefore replaces the block with a
plain prose comment (`// No toggleDefault — graduated off its toggle`), never a
commented-out literal.

### The `useFeatureVisible` trap

A graduated feature has no assignment, so `byId[featureId]` is `undefined` and
`useFeatureVisible` resolves it to **not-visible**. Leaving a stale
`featureId:` on a nav entry therefore *hides the page outright*. Every graduated
nav entry drops its `featureId` (`sharing`, `models`). The mirror-image trap
applies to `hiddenWhenFeature`, which can now never fire — handled by dropping
the subsumed `nav` blocks (§ Decision 4).

---

## Risks

- **`run-input-forms` — the one real behavior change.** Schema validation
  becomes universal, so a 400 that previously never fired for toggle-off tenants
  now can. It is bounded: only a workflow that **declares** an `inputSchema`
  **and** receives an actually-invalid payload is affected; schema-less
  workflows and uncompilable schemas fail open unchanged. This is also the
  intended GA behavior the ADR 0197 comment promised. Mitigated by the
  route-level tests below; the raw-JSON editor remains the launch-surface
  escape hatch.
- **`sharing` — the public surface becomes unconditional.** Mitigated: the token
  is the credential, revocation/expiry/org-tenant gates are untouched, and each
  resolver keeps its own feature toggle, so the set of shareable content is
  unchanged. Same posture ADR 0134 accepted for `chat-widget`.
- **`developer-keys`** — key management is now always reachable. This *narrows*
  risk (revocation can no longer be switched away from an operator while the
  credentials keep working); minting still requires an authenticated principal.
- **Per-tenant overrides** for all five ids are deleted at boot via
  `RETIRED_TOGGLE_IDS`, so a tenant that had explicitly disabled one will see it
  enabled after deploy. This is inherent to graduation and matches every prior
  wave. Two independent safety nets (`getEffectiveConfig` ignoring orphaned
  overrides, `pruneOrphanedConfigs`) mean the retirement list is documentation +
  eager cleanup rather than the sole guard.

---

## Follow-ups (not in this ADR)

- `features/entities/routes.ts` imports `verifyApiKey` from `developer-keys`
  without declaring `dependsOn` — invisible to the ADR 0194 disable-lock graph.
  Now moot for this pair (the dependency is always-on), but the *pattern* should
  be fixed: `sharing`'s five consumers all coupled by direct import too, which
  is why the toggle graph showed the most-coupled feature in the audit as
  isolated.
- ADR 0419's `priced ⟹ gated` invariant is prose. Given how quietly
  `useFeatureLocked` fails for a feature with no toggle, an automated check
  (every feature in a priced bundle must be `requireEntitledFeature`-gated, and
  no `core` feature may be priced) is worth adding.
- `settings` is the next graduation candidate once it has soak time.
