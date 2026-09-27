# ADR 0439 — Feature-dependency graph integrity: a cycle guard, a parity ratchet, and why we declared almost nothing

**Status:** implemented — 2026-07-19.
**Date:** 2026-07-19
**Depends on:** ADR 0001 (feature-first packages), ADR 0194 (the dependency graph +
disable-lock), ADR 0330 (the `forms` → `crm` inversion precedent), ADR 0366 P4 (the
core/bundle/standalone distribution tiers), ADR 0419 (paid feature bundles — the
composer closure now also drives what a tenant BUYS), ADR 0434 (four toggles
graduated to always-on, which retired several would-be edges).
**Surface:** host-internal. No routes, no wire, **no RFC** — `dependsOn` is
non-normative host configuration.

---

## Context

ADR 0194 introduced `BackendFeature.dependsOn: string[]`, enforced as a
**disable-lock**: a feature cannot be turned off while an enabled feature
hard-depends on it. Features *also* couple by **direct import** across package
boundaries, and those edges are invisible to the graph.

A full static scan of `backend/typescript/src/features/*` (static `from '../b/…'`
**and** dynamic `await import('../b/…')`) measured:

| | count |
|---|---|
| distinct cross-feature import edges | **184** (359 import sites, 121 feature dirs) |
| declared in `dependsOn` | **19** |
| undeclared | **165** — of which 95 target a toggleable feature, 70 target always-on substrate |
| edges reachable ONLY via dynamic `import()` | **10** |
| cycles already present in the real import graph | **16** |

The obvious reading — *"declare the other 165"* — is wrong, and this ADR exists
mostly to record **why**, so the next person does not re-derive it and act on it.

---

## Decision

### 1. `dependsOn` is a lock + composition mechanism, NOT documentation

Every declared edge has three consumers beyond the disable-lock:

- **The white-label composer** closes the graph into `composed.autoRequired`
  (`BundleShopPage.tsx`), so an edge auto-pulls its target into any composition
  selecting the source.
- **`gen-distribution --check`** requires `core` to be `dependsOn`-closed — a
  **core → non-core** edge is a hard **build error**.
- **ADR 0419** sells the same catalog, so an edge that crosses a bundle boundary
  silently widens what a tenant **purchases**.

So "record that an import exists" is not a free act. Recording relationships is
what this ADR's *test* is for; `dependsOn` is reserved for genuine breakage.

**Concretely rejected during this work:** `chat-export → documents` (core → the
`studio` bundle) would have **failed the build**; `document-editor → documents`,
`dealers → crm`, and `sales-commissions → crm` are all **cross-bundle** and would
have quietly enlarged a paid bundle — a packaging decision wearing a correctness
fix's clothes.

### 2. An import edge is not a hard dependency — so we declared NO new edges

Toggles are **runtime**, not build-time. Disabling B does not break A's import; it
breaks A only if B **refuses** when off. We audited the surviving candidate targets
and found the opposite:

- `entitiesService.ts`, `documentsService.ts`, and `territories`' service layer
  contain **no toggle check at all** — only their *routes* 404. The functions
  `bi`/`cms`/`service-desk`/`notebooks`/`sales-commissions` actually import keep
  working with the target off.
- `sharing` and `developer-keys` — the targets of four more candidates — **became
  always-on in ADR 0434**, and `features/types.ts` is explicit that an always-on dep
  "is always satisfied and never blocks."

The candidate list therefore collapsed from ~20 → 9 → **0**. Declaring any of them
would have created a lock that either cannot fire or protects against a failure
that does not occur. **We added no `dependsOn` edges.**

### 3. We removed ONE wrong declaration (a second was withdrawn on review)

- `kicktodo-community` declared `kicktodo-creator` with **no import of it** (the
  only textual match was the KV namespace string `'kicktodo-creator-profiles'`).
  Removed — it locked a feature this package does not need.

  > **The inverse half is instructive.** `kicktodo-community` DOES import
  > `kicktodo-commerce` (`entitlementService`, from three files) and does not declare
  > it, so the first draft of this ADR "fixed" that too. Adding the edge immediately
  > **failed `gen-distribution --check`** — the `slim-proof` distribution includes
  > `kicktodo-community` but excludes `kicktodo-commerce`, breaking the dependsOn
  > closure. Applying this ADR's own §2 criterion then settled it: `entitlementService`
  > carries no toggle check, so community keeps working with commerce off and the lock
  > would be fiction. The edge was NOT added. Worth recording that the rule caught its
  > own author — which is the point of writing it down rather than trusting judgment.
- ~~`kicktodo-core` declared `goals`, which is always-on core substrate — a lock
  that can never fire.~~ **Reverted during review — deferred to a documented
  decision by another author.** `kicktodo-core/feature.ts` carries an explicit
  rationale for that edge ("the dependency is real: the enrollment saga creates one
  ADR 0412 goal per enrollment. Declaring it is free (an always-on dep never locks)
  and records the relationship"), which landed on `main` while this work was in
  flight. That reasoning holds — `goals` is core, so it ships in every distribution
  and the composer-closure cost is exactly zero, while the declaration documents a
  real runtime relationship. A cleanup pass has no business overruling a reasoned,
  documented choice, so the edge stays and the invariant that would have failed it
  was **downgraded to informational** (see §5). Only the import-backed check
  survives as a hard rule — which is the one that caught the genuine bug.

### 4. A cycle guard in `registerFeatureDependencies`

`computeDisableBlockers` is **one-hop**, so a cycle would never hang — it would
**silently make every feature in it permanently mutually undisableable**, with no
error anywhere. Nothing prevented that, and with 16 cycles already in the import
graph the hazard is live (e.g. `commerce` declares `dependsOn: ['crm']` while
`crm/leadScoreService.ts` imports `commerce`).

Two deliberate failure choices:

- **Drop the offending EDGE, never the map KEY.** The `dependencies` map's keys are
  the authoritative registered-feature set (`listRegisteredFeatureIds`), consumed by
  the bundle-catalog projection. Refusing the whole registration would make the
  feature look *unregistered* and fail `gen-distribution --check` with "core names
  unregistered feature" — **a worse failure than the cycle it prevents.**
- **Log, never throw.** This runs at boot for every feature. A bad declaration must
  not take the service down over what is a lock-*strength* concern: dropping the
  edge reproduces exactly today's behaviour, so the runtime outcome is never worse
  than the status quo.

The build-breaking half lives in CI, where a developer can act on it.

### 5. Invariants, not a 165-line allowlist

`test/feature-dependency-parity.test.ts` enforces:

1. **Every declared dep is backed by a real import** — caught the `kicktodo-community` bug.
2. **Always-on declared deps are ALLOWED** (informational only) — a first draft
   failed them; that rule was withdrawn, see §3.
3. **The declared graph is acyclic** (CI-blocking).
4. **Every declared dep resolves to a registered feature.**
5. **A ratchet on the undeclared-onto-toggleable count** — new coupling is allowed, but it must be *noticed*.

An allowlist of 165 entries would be a rubber stamp nobody reads, and would ossify
the drift as approved. A ratchet keeps the debt visible without pretending it is
resolved. `test/feature-dependency-cycle-guard.test.ts` separately pins the guard's
behaviour, including the key-preservation and never-throw properties.

---

## Alternatives weighed

1. **Declare all 165 edges.** Rejected — deadlocks the
   `crm`/`commerce`/`email`/`consent`/`cdp`/`analytics`/`sharing` cluster
   permanently (16 cycles), breaks the build on core → non-core edges, and enlarges
   paid bundles.
2. **Declare the ~20 "Tier 2" acyclic edges.** Rejected on evidence — see §2. Four
   targets are always-on; the rest do not gate their service layer, so nothing
   breaks and the lock would be fiction. One (`chat-export → documents`) would have
   failed the build outright.
3. **Throw at boot on a cycle.** Rejected — one bad edge takes down every tenant
   over a governance nicety.
4. **Refuse the whole registration on a cycle.** Rejected — drops the map key and
   corrupts the registered-feature set (§4).
5. **A boot-time/runtime assertion mirroring the CI invariants.** Rejected for the
   same reason ADR 0419 §Correction rejected its runtime twin: one owner per
   invariant, and CI is where it is actionable.
6. **A 165-entry allowlist as documentation.** Rejected — see §5.

---

## Deferred (recorded, not dropped)

**Tier 3: ~60 edges inside the cycle cluster.** These cannot be declared without
deadlocking the cluster. The path is the **ADR 0330 inversion**: `forms` removed its
`dependsOn: ['crm']` and inverted the coupling into a forms-owned
`submissionSinks.ts` registry that CRM registers itself into.

Heuristic for which arm of a mutual cycle to invert: **invert the arm that is a
notification/sink** (A tells B something happened), not the arm that is a **query**
(A needs B's data to answer). Sinks invert cleanly into a registry; queries do not.
`forms → crm` was a sink, which is why it inverted well.

Do these **opportunistically**, when a feature is already being touched — a 60-edge
inversion program is not justified by the current harm (the undeclared edges cause
no runtime failure today; they only mean the disable-lock is weaker than a reader
might assume). The parity ratchet keeps the debt visible in the meantime.

**Also deferred:** two fail-soft dynamic-import edges (`crm/signService.ts`,
`crm/bookingService.ts` — `await import()` in `try/catch` with a `log.warn`
fallback) are candidates for `recommends`, which has zero lock/closure/build effect.
Not added here to keep this change to integrity fixes only.

> **Resolved (GATE-3 → ENG-11, 2026-07-20).** `recommends: ['commerce', 'documents']`
> added to `crm/feature.ts`. A full audit of crm's fail-soft `await import()` sites
> (`signService.ts`, `signTargets.ts`) found four cross-feature soft targets: `sharing`
> and `media` (both **always-on**, so recommending them is vacuous) plus `commerce` and
> `documents` (**toggleable**) — only the toggleable two are recorded. As predicted,
> `gen-feature-deps` reads only `dependsOn`, so the map is unchanged and the edges
> correctly stay `[2]` soft-read; `recommends` merely adds the toggle-panel hint.
>
> **Related (ENG-9, 2026-07-20) — resolved-by-design, no code.** The two undeclared
> import edges the disable-lock can't see (`entities → developer-keys` for `verifyApiKey`;
> `sharing`'s five consumers) target **always-on** features (graduated, ADR 0434), so a
> `dependsOn` there is a **phantom lock** — one that can never fire — exactly the
> anti-pattern this ADR warns against. Left undeclared by design; the coupling stays
> visible in the ADR 0446 dependency map. Re-open only if a target is de-graduated.

---

## Implementation record

| # | Change | Artifact |
|---|---|---|
| 1 | Cycle guard (edge-drop, key-preserving, non-throwing) + `enforcedFeatureDependencies()` | `host/featureToggles/registry.ts` |
| 2 | Stale/inverted declaration corrected | `features/kicktodo-community/feature.ts` |
| 3 | Dead always-on declaration removed | `features/kicktodo-core/feature.ts` |
| 4 | Graph-integrity invariants + ratchet | `test/feature-dependency-parity.test.ts` (5 cases) |
| 5 | Guard behaviour incl. key-preservation + never-throw | `test/feature-dependency-cycle-guard.test.ts` (9 cases) |

No `dependsOn` edges were added. `distributions/bundles.json` is unchanged.
