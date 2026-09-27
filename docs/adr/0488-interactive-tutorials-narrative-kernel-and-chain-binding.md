# ADR 0488 — Interactive tutorials: narrative in the content kernel + the tutorial↔chain binding

Status: **implemented** — P0–P7 shipped 2026-07-25; **D1 §Correction 2026-07-26** repaired the kernel mint + registered the phase chains (both halves of D1 had shipped dead; see the correction note under D1). Tenant EDIT and per-locale read-back remain unshipped and are no longer claimed. ADR 0489's anchor exemptions are now 3, not 59.

## Implementation record

| Phase | Status | Evidence |
|---|---|---|
| **P0** | ✅ shipped | Duplicate `0303` resolved (this ADR's subject renumbered to **0490**, first-created-wins); 9 sources mis-citing "ADR 0301" corrected; 12 sources + 6 docs swept |
| **P1** | ✅ shipped | `features/tutorials/` backend package (no toggle); `tutorials.lesson` minted via `mintSystemType`; seed **generated** from the frontend content + drift ratchet (sabotage-proven); **D3 degraded-mode floor** with 11 tests; host-ext read routes |
| **P2** | ✅ shipped | `tutorial-progress` store (per-user, no shared row — cannot reproduce the ADR 0378 hijack); **own `registerSubjectEraser` + 13 tests**, closing `DATA-T2`; frontend server-backed with a `localStorage` floor and an honest `server`/`local`/`unavailable` mode |
| **P3** | ✅ shipped | `run:{chainId,nodeId}` binding + all 6 authored links migrated off the legacy `walkthroughId`; **binding-drift guard** (sabotage-proven) makes a dangling "Show me" impossible. **D2 phase sub-chains PROVEN** on `connect-your-ai` — 3 phase chains + a parent composing them via `core.subWorkflow`/`subChainRef`, validated through the REAL pack loader (`tutorial-phase-chains.test.ts`, 7 tests) |
| **P4** | ⬜ remains | Content depth via record→AI-enrich→review (unblocked: ADR 0489's ratchet shipped) |
| **P5** | 🟡 mostly shipped | `surfaces[]` on all 4 tutorials + `TutorialHint` — a quiet, dismissible, **never-auto-launching** contextual affordance, with 9 tests pinning the RESTRAINT rules (no prefix-bleed across features, stays dismissed, never circular on `/tutorials`). Empty-state launchers (`StateCard`) remain |
| **P6** | ✅ shipped | `feature.tutorials.agents` (Tutor) + two READ tools + `ctx.features.tutorials`. **D6 CORRECTED** — see below |
| **P7** | ✅ shipped | A11y close-out: the progress chip and the filtered result count are LIVE REGIONS — ticking a step (the page's whole interaction) and filtering both changed the screen in silence before. Grade trio ran per-increment |

**D2 §Correction (2026-07-25) — what a phase `chainId` MEANS, and a defect it
already caused.** A phase `chainId` is *"the spine that COVERS this phase"*.
Two rules follow, and the first was violated by the very commit that introduced
phase chains:

1. **ONE SPINE PER PHASE.** A phase that declares `chainId` owns the spine for
   its steps; those steps MUST NOT carry their own `run.chainId`. #2558 shipped
   all three phase-chained phases of `connect-your-ai` with BOTH — the phase
   pointing at the new phase chain, the step still pointing at the old
   single-step page spotlight — so the surface rendered two competing "Show me"
   buttons driving overlapping work through different chains. Fixed, and pinned
   by `tutorial-binding-drift.test.ts` (sabotage-proven against the original
   defect).
2. **COVERAGE is an authoring obligation.** A phase may declare `chainId` only
   when that chain drives the whole phase. Node count is NOT the test — the
   campaign-studio chain is 5 nodes covering a 1-step narrative phase, which is
   correct. Where a chain covers only *part* of a phase, bind at the STEP level
   (`run.chainId`), which is honest about its scope. `build-your-first-funnel`
   stays step-bound for exactly this reason: its phase 1 has two steps and the
   available chain drives one.

**D2 nesting proof — DONE, and here is exactly what it proves.**
`examples/workflow-chain-packs/tutorial-connect-your-ai/` ships three PHASE
chains plus a PARENT that composes them through `core.subWorkflow` +
`subChainRef` (never a pinned `config.workflowId` — RFC 0133 §1.2). Verified
through the **real chain-pack loader**, not a synthetic registry, because ADR
0442 recorded a synthetic registry masking a production loader bug for a whole
phase. Each phase resolves and expands INDEPENDENTLY — that is what makes "Show
me this phase" real — and phase 4 carries a HITL step *and* its checkpoint, so a
child chain is demonstrably not limited to one step.

Two things the proof deliberately leaves standing:
- **`nodeId` is carried and validated but never dispatched on.** The player runs
  whole chains; per-node entry would need a player change, and phase granularity
  already delivers the completion benefit the evidence argues for.
- **Only ONE tutorial is converted.** That is the instruction, not an omission:
  prove nesting once, then convert the library in P4 alongside ADR 0489's anchor
  drawdown (the other three tutorials target surfaces that are still on the
  exemption list, so converting them now would author chains that cannot resolve).

**`open-your-storefront` is NOT-BACKABLE, not pending — stop re-planning it.**
ADR 0378 already recorded this honestly and it has not changed: the storefront is
a PUBLIC per-workspace URL (`/store/<workspace>`) that lives OUTSIDE the app
shell, so the walkthrough player — which mounts in the app chrome — cannot reach
it; and the commerce admin is API-only ("no dedicated page", its own suite's
words). No amount of anchor drawdown fixes either. This tutorial stays a READ
projection unless those surfaces change, and that is the correct outcome, not a
gap.

**Correction to the earlier "P4 is blocked" claim.** Two increments recorded that
converting the remaining tutorials "would author chains that cannot resolve".
That was wrong, and the error was a premise never checked: it assumed conversion
means authoring a NEW chain per phase. It does not — a phase BINDS an existing
chain, and a phase with nothing to do correctly has none. Once audited, one
tutorial converted with zero anchor work, one was already correctly step-bound,
and one is permanently not-backable. Only *new* driveable depth needs the anchor
drawdown.

**What P1 deliberately did NOT do:**

**`open-your-storefront` is NOT-BACKABLE, not pending — stop re-planning it.**
ADR 0378 already recorded this honestly and it has not changed: the storefront is
a PUBLIC per-workspace URL (`/store/<workspace>`) that lives OUTSIDE the app
shell, so the walkthrough player — which mounts in the app chrome — cannot reach
it; and the commerce admin is API-only ("no dedicated page", its own suite's
words). No amount of anchor drawdown fixes either. This tutorial stays a READ
projection unless those surfaces change, and that is the correct outcome, not a
gap.

**Correction to the earlier "P4 is blocked" claim.** Two increments recorded that
converting the remaining tutorials "would author chains that cannot resolve".
That was wrong, and the error was a premise never checked: it assumed conversion
means authoring a NEW chain per phase. It does not — a phase BINDS an existing
chain, and a phase with nothing to do correctly has none. Once audited, one
tutorial converted with zero anchor work, one was already correctly step-bound,
and one is permanently not-backable. Only *new* driveable depth needs the anchor
drawdown.

**What P1 deliberately did NOT do:** the frontend still renders its in-tree
`content/` modules and does not yet read the new routes. That switch belongs with
P3's binding (the FE needs the `run` bindings to render per-step "Show me"), and
until then the **drift ratchet** is what keeps the two copies honest. Shipping the
backend first means the kernel lane, the seed lifecycle and the degraded floor are
all proven before any user-visible change rides on them.

D5's ≤5-steps-per-phase rule is already enforced against the seed
(`tutorial-seed-drift.test.ts`), so P3 can generate phase sub-chains from a shape
that is known-valid.

**Requirements source:** maintainer direction 2026-07-25 — *"our tutorials are lacking… we have a better tutorial walkthrough but it isn't interactive"* — refined by the deep-dive in [`docs/research/interactive-tutorials-architecture.md`](../research/interactive-tutorials-architecture.md) and an `/architect` options pass that overturned the first draft's owner choice (§Corrections).
**Depends on:** ADR 0490 (`0490-user-facing-tutorials.md` — the tutorials surface this extends; renumbered from a duplicate 0303 in P0), ADR 0386 (entities — headless content modeling), ADR 0408 Phase C (the entities **content kernel**), ADR 0406 D1/D7 (per-locale field overlays + the independent `entities-localization` toggle), ADR 0368/0374/0376/0378 (the walkthrough engine + player), ADR 0472 (walkthroughs are RFC 0013 chain packs), ADR 0435 (sample walkthroughs are seeded example data), ADR 0308 (`registerFeatureAgentTool`), ADR 0473 (composed-workflow proposals).
**Companion:** **ADR 0489** — the walkthrough-engine half (adaptive checkpoints + the anchor coverage ratchet). 0489's ratchet is the hard dependency for this ADR's Phase 4.
**Surface:** frontend `features/tutorials/` + a **new backend feature package** `features/tutorials/`.
**RFC verdict: host work only — NO new RFC.** See §RFC gate.

---

## Why this exists

`/tutorials` (ADR 0490) is a *passive read-along*: **4** tutorials, hand-authored TypeScript
objects in `features/tutorials/content/*.ts`, a hard-coded `registry.ts`, per-step progress in
`localStorage`, and **5 "Show me" buttons in the entire app**. It has no backend.

Beside it sits a genuinely best-in-class execution engine (ADR 0368 → 0378): a walkthrough
**is** a durable workflow run, steps suspend as interrupts, targets resolve through a
**semantic action registry** rather than CSS selectors, HITL steps can never dead-end,
checkpoints make divergence honest, and since ADR 0472 walkthroughs are RFC 0013 **chain
packs** — builder-editable, `/`-runnable, tenant-ownable.

The two never met at the right granularity. The result is a documentation surface that
cannot drive the product and an execution surface almost nothing points at.

There is also a **doctrine violation** hiding in plain sight. `CLAUDE.md` and
`ARCHITECTURE.md` both state that a workflow is *never* a hard-coded in-tree definition;
ADR 0472 drained the `builtinWorkflows` quarantine 72 → 0 and **deleted the module** so
that declaring one is now a compile error. Yet `features/tutorials/registry.ts` is exactly
that: a code-pinned, in-tree, ordered set of steps that drive the app — invisible to the
builder, not tenant-editable, not localizable, not authorable by the AI. Tutorials were
never exempt from the doctrine; they were simply never audited against it.

---

## Boundaries audit (verified against `origin/main`, not docs)

| Check | Finding |
|---|---|
| **Route namespace** | `/v1/host/openwop-app/tutorials*` — **FREE**. No registrant (`git grep "openwop-app/tutorials"` → 0 hits). No collision. |
| **Concept owner — content** | **`entities` is the owner, NOT `cms`.** `cms/cmsService.ts:22-26`: *"ADR 0408 Phase C — the CMS façade composes the CONTENT KERNEL (the entities engine)… the kernel is the app's single content store and never imports cms back (guard-tested)."* CMS owns **pages** (slugs, redirects, publish sweep, page experiments). A tutorial is not a page. |
| **Mint precedent** | Features mint their own system types directly, bypassing CMS: `cmsService.ts:213` (`cms.page`), `commerceService.ts:305` (product), `crm/entities/deals.ts:80` (deal, `neverPublic:true`). `tutorials.lesson` follows this 5×-established path. |
| **Concept name collision** | **"Lesson" is taken.** `features/kicktodo-creator/routes.ts:259` `GET …/candidates/:id/lessons` + `lessonStatus()`; its workflows speak of *"the batch's built lessons"*. Shipping a second unrelated "Lesson" is the `orgs`↔`accessControl` failure mode. **We keep the noun "Tutorial"** — already the feature id, the route, and ADR 0490's vocabulary. (The *system type* is still named `tutorials.lesson` because `mintSystemType` requires a dotted feature-scoped slug and the scope prefix disambiguates it from `kicktodo-creator`'s rows; no product surface ever says "lesson".) |
| **Localization** | **Already solved — do not build it.** ADR 0406 D1 (`entitiesService.ts:101, 564-585`): sparse per-locale overlays over `localizable` string fields, BCP-47-validated, at the **kernel** level. Closing ADR 0490's content-localization follow-on is a field flag. |
| **Content blocks** | `mintSystemType({ extensionKinds: ['blocks'] })` (`entitiesService.ts:624`) + `registerFieldKindValidator` (imported at `cmsService.ts:23`) is the existing home for the discriminated block union. Do not invent a block schema. |
| **Toggle posture** | Untoggled backend feature packages are the norm (`accessibility`, `analytics`, `assistant`, `billing`, `brand`, `cad`, … all lack `registerToggleDefault`). A `tutorials` backend package with **no toggle** preserves ADR 0490's always-on access-hub posture with ample precedent. |
| **Dependency risk** | **`entities` defaults OFF** (`entities/feature.ts` `toggleDefault.status:'off'`) and `entities-localization` is a *second* independent opt-in (ADR 0406 D7). Tutorials is deliberately always-on. Resolved by D3 below. |
| **Progress store** | `walkthroughs/progressStore.ts` is the precedent: keyed `tenantId:userId:<id>`, subject stamped **server-side**, keys *constructed only, never parsed* (subjects contain `:`). Note `test/subject-erasure-coverage.test.ts:11` enumerates only `src/host/**`, so a feature-owned collection is **not** build-caught — it must self-police. |
| **Spine** | Walkthroughs are already RFC 0013 chain packs (`examples/workflow-chain-packs/walkthroughs/pack.json`, ADR 0472 P4). No new workflow artifact. |
| **Doc-integrity defects found** | (1) `docs/adr/0303-` is a **duplicate number** — `0303-rfc-0123-connection-pack-provider-vendor.md` *and* `0303-user-facing-tutorials.md`. (2) All **9** tutorials source files cite **"ADR 0301"**, which is actually `0301-cdp-f-audit-hash-chain.md`. Both are corrected in Phase 0. |

---

## Decision

### D1 — A Tutorial is a **narrative document bound to a chain spine**

Two artifacts, one product concept, joined by a stable binding:

- **Spine** — an RFC 0013 workflow-chain pack of `ui.walkthrough.*` steps. Executable steps
  only. Keeps every property ADR 0472 conferred: builder-editable, `/`-runnable,
  tenant-ownable, replay-safe.
- **Narrative** — a `tutorials.lesson` record in the **entities content kernel**. Prose,
  learning objectives, prerequisites, callouts, code samples. Tenant-editable, localizable,
  AI-authorable.
- **Binding** — each narrative step carries `run: { chainId, nodeId? }`. The narrative never
  contains an action; the chain never contains a paragraph. A drift test asserts every
  `run.chainId` resolves and no chain node is claimed by two narrative steps.

**The two-artifact seam is forced, not preferred.** RFC 0013 chain-pack manifests are
**normative wire**; adding a `narrative` field to one would require an upstream OpenWOP RFC.
Keeping prose out of the manifest is precisely what keeps this entire program off the wire.

> **§Correction (2026-07-26, grade trio) — BOTH HALVES OF D1 SHIPPED DEAD. Neither the
> narrative store nor the binding actually worked in production, and the whole delta was
> green throughout.**
>
> **The narrative half.** `tutorials.lesson` could never be minted. The field table declared
> `select`, `text` and `json` — none is in the kernel's closed vocabulary — and the mint
> passed no `extensionKinds`, so `buildFieldSpec` threw on the fourth field of every call.
> No workspace ever held a tutorial row; the D3 seed floor served the shipped copy and made
> the failure look like the healthy default. Two further defects sat behind that one and
> could only surface once it was fixed: the kernel **lowercases and snake_cases field keys**,
> so camelCase writes failed with "Unknown custom field"; and `values` accepts **built-in
> scalars only** — extension-kind fields ride `ext` (as `cms.page` does with its sections).
> Three distinct defects, stacked, between the ADR and one working row.
>
> **The binding half.** The phase chains were *loaded* from their pack, which made them
> gallery-reachable and nothing else. Run resolution asks `getChainBackedWorkflow`, which
> reads the **registered** set, and nothing registered them — so three of the four
> "Show me this phase" buttons 404'd. The drift test above certified them anyway, because
> it built its launchable set from `listChains()` (loaded) rather than from what the run
> resolver accepts. **A test that asserts a weaker property than production requires is
> worse than no test: it converts an outage into a green check.**
>
> Fixed 2026-07-26: `enum`/`string` + a registered `tutorial-doc` extension kind with a
> bounded structural validator; snake_case keys behind an explicit `TUTORIAL_FIELD_KEYS`
> map; the two-bag `values`/`ext` split; `registerTutorialChainWorkflows()` derived from the
> loaded chains by prefix so a new pack cannot miss registration; and the drift test now
> asserts through `getChainBackedWorkflow` (sabotage-probed — removing the registration
> names exactly the three dead ids). A new `tutorials-kernel-mint.test.ts` exercises the
> REAL kernel and asserts on rows, because the existing suite mocks the kernel wholesale
> and therefore could never see any of this.
>
> **Still not shipped, and no longer claimed anywhere:** tenant EDITING of these rows (there
> is no write path — generic entity writes are refused on system types) and per-locale
> READ-BACK. `localizable` marks fields eligible for ADR 0406 overlays; nothing writes or
> resolves one yet, so ADR 0490's content-localization follow-on stays **open**. The
> `/example-data` copy, `FEATURES.md` and `ROADMAP.md` were corrected to match.

### D2 — Phase-granular chains via sub-chain nesting

"Show me *this* part" needs a chain that starts where the reader is. Rather than inventing
mid-DAG entry (`startAt` params + branch edges everywhere):

- **one chain per phase** (≤5 steps — see D5), and
- **the whole tutorial = a parent chain composing the phase chains as sub-chains.**

Sub-chain nesting is already first-class (`CLAUDE.md`: *"a chain can hold a sub-chain —
workflows can hold workflows"*). "Show me this phase" runs the sub-chain; "Drive the whole
tutorial" runs the parent. **No new chain-format capability is required.**

### D3 — The seed is the **degraded-mode floor**, not merely a seeding source

`entities` defaults OFF; tutorials is always-on. Therefore:

| `entities` state | `/tutorials` behavior |
|---|---|
| ON | kernel row is authoritative — tenant-edited, localized, AI-authorable |
| OFF (or read fails/times out) | the **in-repo seed** is served, read-only, with an honest "not editable here" affordance |

This is structurally the timeout-falls-back-to-seed pattern, and it preserves the ADR 0490
posture verbatim: *"tutorials teach features a workspace may not have enabled yet, so the
reader itself is never toggle-gated."*

**This is not the ADR 0072 anti-pattern.** The harm there is a code-pinned artifact being the
uneditable runtime **source of truth for a workflow**. Here the workflow spine is a proper
chain, and the narrative seed is a documented fallback that a tenant's kernel row supersedes
the moment `entities` is on. The seed carries `seedVersion`; a tenant edit stamps
`customizedAt`; re-seeding updates only rows whose `customizedAt` is unset (or with an
explicit `force`).

### D4 — Progress moves server-side, on the walkthrough store's discipline

`localStorage` cannot support cross-device resume, the Tutor agent, or honest completion
reporting. A `tutorial-progress` `DurableCollection` keyed `tenantId:userId:tutorialId`,
subject stamped **server-side**, keys **constructed only, never parsed**. It registers its own
`registerSubjectEraser` — the coverage ratchet will not catch it (audit above), so the ADR
makes it an explicit obligation and Phase 2 adds the test.

`localStorage` remains the anonymous/unauthenticated fallback.

### D5 — Enforced shape: ≤5 steps per phase chain, nothing auto-launches

The completion evidence is unambiguous — 3-step tours complete at ~72%, 7-step at ~16%; ~70%
of users skip tours that feel imposed; user-triggered tours outperform auto-triggered by
2–4×. These become **test-enforced invariants**, not guidelines:

- a phase chain declaring >5 `ui.walkthrough.step` nodes fails the build;
- **no tutorial ever auto-launches** — every drive/delegate entry is user-triggered.

### D6 — Three projections, one artifact

| Projection | Surface | Status |
|---|---|---|
| **Read** — "teach me" | `/tutorials`, localized, printable | exists; re-sourced in Phase 1 |
| **Drive** — "show me" | the ADR 0368 player | exists; re-pointed per-step in Phase 3 |
| **Delegate** — "do it for me" | Tutor agent **guides**: reads the catalog + your progress, recommends, explains, points at the walkthrough | shipped P6 — **scope corrected, see below** |

> **Correction (P6 implementation, 2026-07-25).** D6 said the Tutor "runs the
> chain for you". It cannot, and the app already knew why: `walkthroughs/surface.ts`
> records the identical finding — *"a backend run has no live FE player, so it
> cannot launch a tour at a user"*. An agent turn executes server-side; the
> walkthrough player lives in the browser and starts from the FE bus. An agent
> advertising that it drove the UI would be claiming behaviour the host does not
> honour.
>
> The delegate projection therefore **guides** rather than drives: it reads the
> catalog and the learner's own progress, recommends the next thing, explains any
> step from the real content, and points at the walkthrough the human launches.
> The DRIVE projection remains the FE player. Both the tool descriptions and the
> system prompt state the limit explicitly, and a test pins that they do —
> "I started it for you" is the single most likely hallucination on this surface.
>
> This narrows the differentiator claim honestly. What remains genuinely
> uncommon is still real: one artifact serving documentation, a guided tour, and
> an agent-readable model of the learner's progress. What is NOT true is
> autonomous execution of a UI walkthrough.

The **delegate** projection is the differentiator: the market's tools either simulate a
replica of the product (Arcade/Navattic/Storylane) or overlay the real app with brittle
selectors (Pendo/WalkMe). Because a spine is already an agent-runnable chain and ADR 0473
already ships propose→review→approve, "run this tutorial for me, with gates" is composition
here and a rewrite for everyone else.

### D7 — Placement beats catalog

A tutorials index is where tutorials go to be ignored. Each narrative declares
`surfaces: ['/funnels', …]`; the chrome renders a quiet **"Teach me this"** affordance on any
screen with a match, and `StateCard` empty states become tutorial launchers.

---

## Data model

```ts
// entities system type: `tutorials.lesson`  (product noun: "Tutorial")
{
  slug, title, description, category, difficulty, estimatedMinutes,
  hero: { title, subtitle },
  goal?, learningObjectives?[], prerequisites?[],
  surfaces?: string[],            // D7 contextual placement
  requiresSeed?: string,          // ADR 0435 example-data id (teach on real data)
  seedVersion?: string,           // code-owned; drives re-seed propagation
  phases: [{
    number, title, description?, goal?, outcome?,
    chainId?,                     // D2 — the phase's sub-chain
    steps: [{
      id, title,
      content: Block[],           // extensionKinds:['blocks']
      run?: { chainId, nodeId? }, // D1 — the binding
    }],
  }],
}
// localizable: title, description, hero.*, goal, learningObjectives,
//              prerequisites, phases[].{title,description,goal,outcome},
//              steps[].title  — per ADR 0406 D1 overlays. `run` is NEVER localizable.
```

---

## Phases

| # | Deliverable | Gate |
|---|---|---|
| **P0** | **Doc-integrity fix**: renumber the later `0303-*` duplicate per the first-created-wins policy; correct the 9 source files citing ADR 0301 → the real tutorials ADR | none; unblocks greppable code↔decision links |
| **P1** | Backend package `features/tutorials/` (no toggle). Mint `tutorials.lesson`; seed the 4 existing tutorials with `seedVersion`; **D3 fallback**; read routes under `/v1/host/openwop-app/tutorials/*` | route-level tests (authz, tenant IDOR, entities-OFF fallback) |
| **P2** | **D4** server-side progress + `registerSubjectEraser` + its coverage test | erasure test is the gate |
| **P3** | **D1 binding + D2 phase sub-chains.** Convert the 4 tutorials; drift test both directions. **Prove nesting on ONE 3-phase tutorial before converting the rest** | drift test + the nesting proof |
| **P4** | Content depth via the record→AI-enrich→review factory | **blocked on ADR 0489's anchor ratchet** |
| **P5** | **D7** contextual placement + empty-state launchers | `/ux-review` |
| **P6** | **Delegate**: `feature.tutorials.agents` (Tutor) + `ctx.features.tutorials` catalog + `registerFeatureAgentTool` reads sharing the routes' access predicate | ADR 0308 shared-predicate rule |
| **P7** | A11y close-out (focus into the caption on step change, focus return on stop, WCAG 2.2 2.4.11) + grade trio | `/grade-ux`, `/grade-code`, `/grade-data` |

---

## RFC gate

**Host work only — no new RFC.** Every surface is host-extension
(`/v1/host/openwop-app/tutorials/*`, non-normative), the content store is a host-local
entities system type, and the spine reuses **already-normative** RFC 0013 chain packs
unchanged. The single wire-adjacent temptation — putting narrative inside a chain manifest —
is explicitly **rejected in D1**, and that rejection is what keeps the program off the wire.
Adding a new envelope kind or a chain-manifest field would flip this verdict; neither is
proposed.

---

## Alternatives weighed

1. **Narrative in the CMS** — *the first draft's choice; overturned by `/architect`.* CMS is a
   page-specific façade over the kernel (ADR 0408). It would inherit page semantics that don't
   apply and stand up a second content path beside the kernel. **Rejected.**
2. **A new `kind:"tutorial-content"` pack** — precedented (`canvas-content` is host-private,
   `artifact-type`/`prompt`/`workflow-chain` prove loader-per-kind), but it adds a 5th loader,
   ships read-only content, builds localization from scratch, and inherits ADR 0347's standing
   RFC watch-item. **Rejected now; revisit if third-party distributable tutorials become a
   requirement** (§Open questions OQ2).
3. **Narrative inside the chain pack** — one artifact, one version. **Rejected: RFC 0013
   manifests are normative wire**, so this needs an upstream RFC (D1).
4. **Keep the in-tree registry, just add more "Show me" buttons** — leaves the doctrine
   violation, the localization gap, and the authoring bottleneck untouched. **Rejected.**
5. **Mid-DAG entry (`startAt` parameter + branch edges)** instead of phase sub-chains — makes
   every chain's DAG carry entry-point plumbing. **Rejected** in favor of D2's nesting.

---

## Plan-vs-architecture corrections

Recorded per `CLAUDE.md` (*correct, don't rewrite history*) — the research doc carries the same
notes inline:

- **Owner corrected: CMS → entities kernel.** The research draft said "a CMS content
  document". Wrong owner (ADR 0408). Corrected in D1 + the audit table.
- **Noun corrected: "Lesson" → "Tutorial".** The coinage collided with `kicktodo-creator`.
- **Scope reduced: localization is not a build item.** ADR 0406 already provides it.
- **New constraint surfaced during this refinement:** `entities` defaults **OFF** while
  tutorials is always-on — neither the research doc nor the `/architect` pass caught it. It
  produced D3, which strengthens the design by giving the seed a principled ongoing role.

---

## Open questions

- **OQ1** — Should a tenant be able to author a *net-new* tutorial (not just edit a seeded
  one) in P1, or is that gated behind the Tutor agent in P6? *Assumption: edit-only in P1;
  create in P6 via ADR 0473 propose→review→approve.*
- **OQ2** — Distributable third-party tutorials would flip alternative 2 from rejected to
  correct. Not a requirement today; re-open if the marketplace wants tutorial packs.
- **OQ3** — Does the Tutor agent get added to the ADR 0315 default-on baseline, or stay
  pack-allowlisted? *Assumption: pack-allowlisted — the baseline is its own ADR-level
  decision.*
- **OQ4** — `requiresSeed` cleanup posture: offer to clear seeded example data after a
  tutorial completes, or leave it? *Assumption: offer, never automatic.*
- **OQ5** — Content localization coverage: seed English only and let tenants/AI translate via
  ADR 0406 overlays, or ship ×4 seeds? *Assumption: English seed + overlay-on-demand.*
