# ADR 0446 — Cross-feature coupling: make it visible, extract misfiled primitives, and stop pretending it's a disable-lock problem

**Status:** **implemented — COMPLETE** (2026-07-20). All phases resolved: A+B (visibility), D.1 (the one genuine extraction — entitlement), D.2/D.3/D.4/F (per-edge review reclassified every other "primitive"/hard-dep as intended coupling), E (moot). Final: `[1]`=0 · `[2]`=80 · `[3]`=0.
**Date:** 2026-07-20
**Depends on:** ADR 0001 (feature-first packages), ADR 0014 (`ctx.features.<id>` surface), ADR 0194 (the dependency graph + disable-lock), ADR 0283/0285/0288 (the lifecycle-seam family + PRUNE/DISABLE/TOLERATE taxonomy), ADR 0330 (`forms → crm` inversion precedent), ADR 0434 (graduation / the `core ∩ bundle` pricing rule), ADR 0439 (the parity ratchet + the "phantom lock" finding).
**Surface:** host-internal. One generated doc + one CI gate; later phases add `host/*Seam.ts` seams. **No wire, no RFC, no migration.**

---

## Context

Features couple two ways. **Declared:** `BackendFeature.dependsOn`, which feeds the ADR 0194 disable-lock (you can't turn B off while an enabled A hard-depends on it). **Undeclared:** A directly `import`s another feature's internal module. A static scan finds **83** undeclared→toggleable edges against **21** declared — the toggle graph is blind to 80% of the real coupling.

ADR 0439 named this the "84-edge debt" and, correctly, declared **none** of it — reasoning that most edges cause no runtime failure. This ADR finishes that thought, because a follow-up asked the obvious question: *"reduce the count by moving the shared code to core."* That instinct is **half right, and half a trap**, and the difference is measurable.

## The finding that reframes everything

Every one of the 83 edges is a **service-layer import**, and — verified by scanning each of the ~25 target features — **the target services do not gate on their own toggle.** `entitiesService`, `documentsService`, `crm/contactsService` all keep working when the feature's *routes* are 404'd. So:

> **Turning target B off does not break consumer A.** The disable-lock these edges would "earn" is a lock with **no failure to prevent** — the exact phantom lock ADR 0439 removed (`kicktodo-core → goals`).

Two consequences:

1. **Declaring these as `dependsOn` is make-work that re-introduces the anti-pattern the last ADR just deleted.** The naive "declare them all" fails on its own terms.
2. **The real problem is ENCAPSULATION, not correctness.** `commerce` importing `crm/contactsService`'s internals means a change to CRM's private signature breaks commerce at build time. That is a maintainability concern — legitimate, but a *different and lower-urgency* thing than a disable-lock gap. This ADR is justified on encapsulation, and says so plainly, so no one later "fixes" the 83 for a benefit it never delivers.

The "move it to core" instinct is right for exactly the subset that is genuinely misfiled cross-cutting infrastructure — and wrong (the **god-core** ADR 0001 guards) for domain data. The measured split proves how small the "move to core" subset really is.

## Decision — the three-way gate

Classify every undeclared→toggleable edge by *what is imported* and *whether the target refuses when off*, and act accordingly:

| # | The imported thing is… | Detected by | Fix |
|---|---|---|---|
| **[1] Primitive** | cross-cutting infra (a gate / policy / transport / registry / stateless helper), not the owner's domain | a curated allowlist in `gen-feature-deps.mjs` (a reviewed architectural register, not a guess) | **Extract to a `host/` seam** — removes the edge AND corrects ownership |
| **[2] Soft-read** | A reads B's domain, but B's service is **vacuous-when-off** | the per-target service-gate scan says B ignores its own toggle | **Leave it — documented in the map.** Route through B's `ctx.features` surface (ADR 0014) only if the build-coupling actually bites. **No `dependsOn`.** |
| **[3] Hard-dep** | A reads B's domain AND B's service **refuses when off** | the scan says B's service checks its own toggle | **Declare `dependsOn`** (the lock is real). Break any cycle first by inverting the sink arm. |

Always-on targets are category **[0]** — never a lock (ADR 0439), correctly undeclared.

**Disclosed residuals (this is an advisory map + drift gate, not a security control).**
The `[3]` scan inspects only `*Service.ts` (excluding `*Knowledge`/`*Cache` helpers),
so a target that gates its own toggle *outside* a service file could be mis-read as
soft `[2]`. Audited 2026-07-20: the only cross-feature-imported gating-non-service
module is `billing/entitlementGuard`, already `[1]` — so there are **zero** concrete
false-`[2]` today. Likewise, a genuine primitive not yet on the `[1]` allowlist reads
as `[2]` — the *safe* default ("not yet extracted"), never a lock. Both residuals are
latent, both are visible in the map, and both are corrected by editing the register in
`gen-feature-deps.mjs`, not by a silent behavior change.

### The measured result (2026-07-20)

Running the classifier over the tree:

| Category | Count | |
|---|---|---|
| **[1] Primitive** | **24** *(initial, coarse)* | the classifier's first-pass "extract to core" candidates — **over-counted**; per-edge review (D.2–D.4/F) reduced this to **0** (see the Final tally) |
| **[2] Soft-read** | **58** *(initial)* | leave documented — declaring these = phantom locks |
| **[3] Hard-dep** | **1** *(initial)* | `service-desk → whatsapp` — later found a file-vs-symbol **false positive** (D.4/F) |

**These are the classifier's FIRST-PASS numbers.** The whole point of Phases D/F was per-edge
review, and it moved almost everything: the 24 "primitives" were mostly intended couplings, and
the 1 "hard dep" was a false positive. See **Final tally** below for the reviewed result
(`[1]`=0 · `[2]`=80 · `[3]`=0). The lesson: an automated module-name scan *over-counts* what
should move to core; only per-edge judgement separates a misfiled primitive from intended
architecture.

## What we REUSE (no parallel systems)

- **Core seams already exist for this** (`ARCHITECTURE.md` "Existing extension seams"): `host/entitlementSeam.ts` (so `[1]` billing edges route through an existing seam — nearly free), and the ADR 0283/0288 **lifecycle-seam family** (`crmRecordLifecycle`, `connectionLifecycle`, `rosterLifecycle`, `conversationLifecycle`, `mediaAssetLifecycle`, `commerce/productLifecycleSeam`) with the PRUNE/DISABLE/TOLERATE taxonomy — the home for the handful of true **sink** edges (a delete-cascade), NOT a new `hostEventDispatcher` path.
- **`ctx.features.<id>`** (ADR 0014) is the blessed feature-to-feature READ contract, for any `[2]` edge whose build-coupling is worth paying down — one surface per owner, not a bespoke seam per data type.

## Phased plan

- **Phase A — the gate scan** *(done)*: `gen-feature-deps.mjs` detects, per target, whether its service self-gates → sorts every edge into [0]/[1]/[2]/[3].
- **Phase B — visibility** *(done)*: the scan writes `docs/FEATURE-DEPENDENCIES.md` (the map + classification + disposition), CI-drift-guarded (`check:feature-deps`, wired into `scripts/ci.sh`). This is the safe, high-value down payment the /architect review said to ship first.
- **Phase D — extract the [1] primitives** *(next, per-seam PRs, prioritized by edge count)*: `entitlementSeam` (exists), `host/consentPolicySeam.ts` (8 edges), `host/submissionSinkSeam.ts` (5), `host/emailTransportSeam.ts`, `host/identityLinkSeam.ts`. **Each seam MUST replicate the current off-semantics exactly** — a before/after "feature-off returns what a direct import returns today" test, so a seam never converts a working read into a silent deny.
- **Phase E — invert true sinks** via the existing ADR 0288 lifecycle seams (a small handful).
- **Phase F — the [3] hard dep**: verify `service-desk → whatsapp`, break any cycle, `dependsOn`; re-run `gen-distribution --check`.

Everything in **[2]** stays put, documented — deliberately, per ADR 0439.

## Alternatives weighed

1. **"Move all shared code to core"** (the literal ask). Rejected — only 24/83 are genuine primitives; moving domain data (CRM contacts) to core guts the feature and rebuilds the god-core ADR 0001 exists to prevent. Also, `documents`/`priority-matrix` are in **sellable bundles**; graduating them to core to dodge an edge is a pricing decision, not architecture (ADR 0434: `core ∩ bundle` is a build error).
2. **"Declare all 83 as `dependsOn`."** Rejected — 58 would be phantom locks (ADR 0439); 16 cycles make many undeclarable anyway.
3. **A new event bus for the sink edges.** Rejected — the ADR 0283/0288 lifecycle seams already are that bus; a second one is the duplication this repo's architecture review exists to catch.
4. **Do nothing / leave it invisible.** Rejected for the encapsulation half — but this ADR keeps the *cost* honest: the down payment (map + primitive extraction) is worth it; chasing the [2] edges to zero is not.

## Implementation record

| Phase | Artifact |
|---|---|
| A + B | `scripts/gen-feature-deps.mjs` (scan + classify + render + `--check`), `docs/FEATURE-DEPENDENCIES.md` (generated), `scripts/ci.sh` (drift gate), `package.json` (`check:feature-deps` / `gen:feature-deps`) |
| D.1 | Entitlement: analytics/crm/csm/email/commerce swapped `requireEntitledFeature` (direct billing import) → `checkEntitlement` (host `entitlementSeam`). **4 edges fully retired** (analytics/crm/csm/email); `commerce → billing` re-classifies `[1]→[2]` (its remaining `stripeApi`/`billingService` use is legitimate payment domain, not a primitive). Map: 24→**19** `[1]`. Also removes the static feature→billing import for the 4 (boundary hygiene). NB: `billing` is `core` tier, so no distribution actually excludes it — this is coupling cleanliness, not a practical tree-shake unblock. Parity pinned by `entitlement-central-gate.test.ts` (GET /crm/contacts still 403s→passes); the bundle-gating allowlist proof broadened to accept `checkEntitlement`\|`requireEntitledFeature`. |
| D.3 | **Reclassification, not a code move — a per-edge review of the `[1]` set found the coarse "imports a shared-looking module" heuristic over-counted primitives.** TWO clusters reclassified `[1]→[2]`: (a) `forms/submissionSinks` (5 edges — crm/email/funnels/service-desk/webinars) is the **ADR 0330 inversion working as designed** — the integrator depends on the primitive (forms) and reads forms' own `FormDef`/`Submission` domain to map values→contact; moving the registry to host would fight ADR 0330 *and* leave the domain-type import, retiring nothing. (b) `analytics/identityLinkService` (4 edges) — consumers call pure fns, but analytics deliberately **owns** the session concept; whether that's a misfiled host identity-floor is an **ownership decision for a focused ADR**, not a mechanical move. Net: `[1]` corrected **19 → 10**. The genuine remaining primitives are consent-policy (8) + email-transport (2). This is the most important finding of the program: *"move the shared code to core" applies to far fewer edges than a module-name scan suggests.* |
| F | **The single `[3]` hard-dep was a FALSE POSITIVE.** `service-desk → whatsapp` looked hard because `whatsappService` self-gates — but service-desk imports the **pure parser `extractWaInbound`**, and `whatsappService` gates only in its *send* path, which service-desk never calls. So it does **not** break when whatsapp is off; declaring `dependsOn` would be a phantom lock. Reclassified `[3]→[2]` via a reviewed edge-level override. **True hard-dep count: 0.** Exposed a classifier limitation now disclosed: `serviceGatesWhenOff` is FILE-level, but gating is per-SYMBOL — a consumer of a pure helper from a partially-gating service is not hard-dependent. |
| D.4 | **Reclassification.** `email/brokeredProvider` (commerce/orgs) is NOT a pure transport primitive — the real transport spine (`host/emailAdapter.ts`) is *already* in host; `brokeredProvider` is email's ADAPTER over it, composing email's `getEmailSettings`/`EmailProvider` domain + connections. Moving it to host would force a host→email up-import (ADR 0001). ⇒ `[2]` domain integration. |
| D.2 | **Reclassification — and a compliance finding.** `consent/consentService.isAllowed` (8 edges) is the one genuine *policy-gate* primitive, but extracting it is **UNSAFE**: consent is excludable (customer-data-platform bundle) and `isAllowed` DENIES strict categories (`marketing.whatsapp`, ADR 0394) without explicit opt-in *even when consent is off*. The direct import **build-enforces** that consent-dependent features can't ship without consent; a host seam would let a slim build omit consent and default WhatsApp sends *permissive* — a Meta-compliance regression. The coupling is protective, intended architecture ⇒ `[2]`, keep the direct import. (Also: `isAllowed` returns a policy *boolean*, so consumers never *break* when consent is off — it's not a real `[3]` either.) |

## Final tally — COMPLETE (2026-07-20)

| Category | Count | |
|---|---|---|
| **[1] Primitive** | **0** | one extracted (entitlement, D.1); every other candidate reclassified on per-edge review |
| **[2] Soft-read** | **80** | intended couplings, domain integrations, compliance-protective + policy-boolean reads — correctly left |
| **[3] Hard-dep** | **0** | none — the apparent one was a file-vs-symbol false positive |

**The program's answer to *"reduce the count by moving shared code to core"*: you almost entirely should NOT.** Of 83 hidden edges, exactly **one** was a genuinely-misfiled primitive (entitlement) — and it already had a host seam. Rigorous per-edge review showed every other candidate is *intentional architecture* whose extraction would have **damaged** the system:

- `submissionSinks` — extracting fights the ADR 0330 inversion and retires nothing (domain-typed).
- `identityLinkService`, `brokeredProvider` — moving them forces a host→feature up-import (ADR 0001).
- `consent.isAllowed` — a host seam would regress WhatsApp opt-in compliance (ADR 0394) in a slim build.
- the "hard dep" (`service-desk → whatsapp`) — a file-vs-symbol false positive; a pure parser.

**There is no god-core to build, and no hard dependency to declare.** The real, lasting deliverable was Phase B — making the 83 edges *visible, classified, and drift-guarded* — plus the single honest extraction (D.1) and a codified rule (`gen-feature-deps.mjs`'s reviewed register) so a future "just move it to core" instinct is met with the evidence instead of a naive sweep.
