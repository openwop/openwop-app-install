# ADR 0200 — Consolidating feature chains into single features (Campaign Studio first)

**Status:** implemented (Phases 1–2) · Phase 3 (facet merge) **Rejected** (behavior-neutral, negative-value — see §Phase 3)
**Date:** 2026-07-03
**Depends on:** ADR 0001 (feature-first packages), ADR 0014 (feature faces), ADR 0144/0145 (hub projection), ADR 0194 (feature dependency graph + recommends)
**Surface:** host-extension, NON-NORMATIVE — no wire, no new RFC

---

## Context

Several product areas ship as **chains of small toggle-gated feature packages** that
are meant to be used together. The question this ADR answers: *what would it take to
present (and optionally merge) such a chain as one "feature" — one code set + one
toggle?* The worked example is **Campaign Studio** (5 packages); the analysis
generalizes to Commerce, the Planning pair, and the CRM/CMS families.

### The chains (grounded inventory)

| Chain | Packages | Toggles | Route bases | Coupling |
|---|---|---|---|---|
| **Campaign** | 5 (`campaign-brief`/`channels`/`orchestration`/`connectors`/`intel`) | 5, all `category:'Marketing'` | `/campaign-brief`, `/campaign-orchestration`, `/campaign-connectors`, `/campaign-intel` (channels = workflows only) | **Tight** — 7 intra-chain service imports (brief ×4) |
| **Commerce** | **1** (`commerce/`) + buyer + billing | **2 in one pkg** (`commerce`+`commerce-ucp`) | `/commerce`, `/public-store` | already merged |
| **Planning** | 2 (`priority-matrix`, `strategy`) | 2, `Business Tools` | `/priority-matrix`, `/strategy` | **Loose** — FE-composition + links, no hard import |
| **CRM/CMS families** | separate features that compose CRM / extend always-on CMS | per-feature | per-feature | expressed by the dependency graph |

## The core finding: "join" is FOUR separable layers

A feature has four faces (ADR 0014); joining a chain can happen at any subset, at
very different cost:

| Layer | Join means | Cost | Reversible |
|---|---|---|---|
| **A. Toggle** | N toggles → 1 (master) or 1 + sub-toggles | Low–Med (state migration) | Yes |
| **B. Code set** | N packages → 1 `BackendFeature` + 1 dir | Med | Med |
| **C. Packs (node/agent typeIds)** | `feature.campaign-*.*` → `feature.campaigns.*` | **High + replay-UNSAFE** | Hard |
| **D. UI / nav** | N nav entries → 1 hub with tabs | Low | Yes |

The high-value, low-risk joins are **A + B + D**. **Layer C is the landmine**:
historical runs reference node typeIds (`feature.campaign-brief.nodes.draft`);
renaming packs breaks `:fork`/replay (`ARCHITECTURE.md` — "pack presence is decoupled
from toggle state"). **Every model below keeps layer C frozen.**

## The three consolidation models (each has a precedent in this codebase)

**Model 1 — Full physical merge** (one package, one toggle, one route base, one pack
namespace). Rejected: it is the only model that touches layer C (pack rename → replay
break) and re-bases routes (URL-contract churn).

**Model 2 — Facet consolidation** (one package, keep sub-toggles, **keep pack
namespaces**) — the **`commerce/` precedent** (one `BackendFeature`, `commerce` +
`commerce-ucp` toggles, 8 stores, one surface). One `campaigns/` dir; one
`campaignsFeature` whose `registerRoutes` mounts all sub-registrars and
`registerToggleDefault`s the retained toggles; a single `requiredPacks` spans all 5
existing pack refs (packs are independent of the feature id). Medium cost; keeps
granularity + gives one code + nav home; **layer C frozen**.

**Model 3 — Umbrella hub, no code merge** — the **ADR 0145 hub + ADR 0194 graph
precedent**. Keep 5 packages; add (a) a **hub** (`HubId += 'campaigns'`; the 4 nav
routes project via a `hubTab` annotation, collapse their standalone nav via
`nav.hiddenWhenFeature: '<hub-anchor>'`, exactly like `models`/`chat-deployment`), and
(b) the **dependency graph** to express chain coherence. Lowest cost; joins the
*experience*, not the *code*; fully reversible.

## Decision: phase it, cheapest-and-safest first

**Model 3, and — after building it — Model 2 was rejected.** The hub delivers the
user-visible "one Campaigns feature" with zero replay risk and full reversibility. It
was meant to *validate the grouping before* committing to a code merge; on review
(§Phase 3) that merge proved **behavior-neutral and negative-value**, so it was not
built. The ADR 0194 dependency-graph work is itself largely an *alternative* to
merging — it expresses "these features form a chain" without fusing code, which turned
out to be the better answer here. **Final shape: Phase 1 (relationships) + Phase 2
(hub); no code merge.**

### Phase 1 (this ADR — implemented): chain relationships in the console

Declare the campaign chain's real relationships as advisory `recommends` (ADR 0194
Phase 5 — a suggestion chip, never a lock), because the couplings **degrade rather
than orphan** (the service/workflow imports bypass the sub-toggle):
- `campaign-orchestration` ⇝ `campaign-brief`, `campaign-channels`
- `campaign-intel` ⇝ `campaign-connectors`

No hard-deps: disabling a sub-feature leaves the others degraded-but-running, so a
hard lock would be false friction (the ADR 0194 §Limitations principle).

### Phase 2 (implemented): the Campaign Studio hub (Model 3)

A Campaign Studio **hub** on the ADR 0145 pattern.

> **§Correction (implementation, 2026-07-03) — two decisions changed vs the proposal:**
> 1. **Anchor id is `campaigns`, NOT `campaign-studio`.** The pre-existing-surface audit
>    caught a collision: `campaign-studio` is already a DIFFERENT feature — the ADR 0153
>    in-chat campaign **canvas** (`canvas.campaign` artifact, category `Canvases`, packs
>    `feature.campaign-studio.*`). The hub anchor uses the free id `campaigns` (label
>    "Campaign Studio console", nav label "Campaign Studio", path `/campaign-studio`,
>    which is free — the canvas has no FE nav route). `hiddenWhenFeature: 'campaigns'`.
> 2. **Anchor defaults OFF**, not ON — matching the `models`/`chat-deployment` precedent.
>    Consolidation is **opt-in and zero-risk to existing nav**: OFF ⇒ the four campaign
>    features keep their standalone Marketing nav; ON ⇒ they collapse into the console.

- `chrome/featureTypes.ts`: `HubId += 'campaigns'`.
- A backend **hub-anchor toggle** `campaigns` (default OFF, `BackendFeature` with
  `registerRoutes: () => {}`, no service/surface/pack) so
  `nav.hiddenWhenFeature: 'campaigns'` resolves in `FeatureAccessContext.byId`
  (the mechanism `models`/`chat-deployment` use — the anchor is a registered toggle,
  distinct from the 5 sub-feature toggles).
- The 4 campaign FE routes gain `hubTab: { hub: 'campaigns', order, featureId }` and
  `nav.hiddenWhenFeature: 'campaigns'` (collapse standalone nav into the hub).
- A `CampaignStudioHubPage` mirroring `AccessHubPage` (no scope pill) — projects tabs
  from `visibleHubRoutes(FEATURES, isVisible, 'campaigns', …)`, each tab gated by its
  own `featureId` (single-source gating), with a designed empty-state when no
  sub-feature is enabled.
- One "Campaign Studio" nav entry (Marketing group); old paths stay reachable (the hub
  renders each route's element). FE-only IA — no wire.

### Phase 3 (REJECTED): facet code-merge (Model 2)

**Decision (architect review, 2026-07-03): do NOT perform the facet code-merge.** The
original proposal was to fold `campaign-*/` into one `campaigns/` package (one
`BackendFeature`), keeping route bases, pack namespaces, and `ctx` surface ids frozen,
plus a master toggle + a per-tenant override migration. On review this is a net-negative:

- **A physical merge changes ZERO runtime behavior.** This app decouples routes /
  packs / workflows / services / stores / toggles from a feature package's *location*
  (for replay-safety, `ARCHITECTURE.md`). So merging ~2,000 LOC across 5 backend
  packages (+ their FE dirs + ~15 pack refs + tests) into `campaigns/` is pure code
  reorganization — every surface stays frozen, nothing users experience changes. Its
  cost (git-history churn, constant merge conflicts with the many parallel sessions
  editing campaign code, breaking in-code `campaign-*` path refs, and the risk of
  violating the frozen-surface discipline mid-move) buys no value, and it works
  *against* ADR 0001's small-self-contained-package grain.
- **A true "single toggle" (master gate) has no cheap path.** `resolveConfig` resolves
  each toggle independently — there is no parent-gate seam. A master toggle that
  disables the five children would require modifying the core per-feature resolution
  path (used by every feature and every replay), a replay-adjacent engine change to
  save an admin four toggle flips. Not worth it. And the `campaigns` id is already the
  Phase-2 hub anchor — a second "master-enable" semantic on the same id would conflate
  IA with capability-gating, or force a sixth toggle (the opposite of "fewer toggles").

**The user's actual goal — "Campaign Studio should feel and act like one feature" — is
already met by Phases 1–2:** the hub is the single destination, the dependency graph +
`recommends` express the chain, and the nav consolidates. This is a **value/correctness
verdict, not scope-cutting-for-size**: Model 1 breaks replay, Model 2's code-move
changes nothing, and Model 2's master-toggle is invasive for marginal gain.

**If a concrete operator need to enable/disable the whole suite in one action ever
appears**, the right build is a **FE bulk-toggle affordance** in the Plugins console
(ADR 0194) — iterate the existing per-toggle API over the `campaigns`-`recommends` set,
zero engine change, zero code-move — NOT a `resolveConfig` parent-gate or a package
merge. Recorded as a future option; not built.

## Per-chain guidance (they are NOT the same problem)

| Chain | Verdict | Why |
|---|---|---|
| **Campaign** | Phase 2 hub — **NOT** the facet merge (Phase 3 rejected: behavior-neutral) | Tight coupling, designed suite; the hub + dep-graph already deliver the grouping |
| **Commerce** | Already Model 2; optionally fold `commerce-ucp-buyer` as a 3rd sub-toggle; leave `billing` (cross-cutting `Admin`) | one package already |
| **Planning (PM + strategy)** | Do NOT merge code; a hub at most, else leave as-is | loose coupling; the `recommends`/links already express it; a merge is anti-modular (ADR 0001) |
| **CRM/CMS families** | Don't merge — the dependency graph already relates them | forms/email/consent *compose* CRM (declared deps); cms-localization/approval *extend* always-on CMS |

## Alternatives considered

1. **Model 1 full merge.** Rejected — the only model that breaks replay (pack/typeId
   rename) and churns URL contracts. No upside over Model 2.
2. **Hard-lock the campaign chain instead of `recommends`.** Rejected — the couplings
   bypass the sub-toggle (services/workflows are toggle-decoupled), so they degrade,
   not orphan; a hard lock would be false friction.
3. **Merge the Planning pair.** Rejected — loosely coupled, independent capabilities;
   merging regresses toward the monolith the feature-first architecture avoids.

## Implementation (Phase 1)

| What | Where |
|---|---|
| `campaign-orchestration` ⇝ `campaign-brief`,`campaign-channels` | `features/campaign-orchestration/feature.ts` (`recommends`) |
| `campaign-intel` ⇝ `campaign-connectors` | `features/campaign-intel/feature.ts` (`recommends`) |

The console (ADR 0194 Phase 5) surfaces these as "Works better with …" suggestion
chips automatically — no new code path. Backend `tsc` clean; dependency suite green.

## Open questions

- [ ] Phase 2: does the "Campaign Studio" hub nav entry show when NO sub-feature is
      enabled (empty-state prompt to enable in Marketplace), or hide entirely? (The
      access-hub/models precedent always-shows; a "hide when empty" needs an OR-gate
      the nav layer doesn't have today.)
- [ ] Phase 3: one master `campaigns` toggle vs. retained sub-facets — and the
      per-tenant override-migration shape.
