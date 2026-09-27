# ADR 0668 — CMS localization: the tenant axis, the silent locale publish, and the delivery claim

Status: **implemented** (verified 2026-09-17, #3794)

Extends **ADR 0064** (CMS content localization), **ADR 0592** (the localization fix batch),
**ADR 0593** (the editorial approval gate, whose §C9 added the guard this ADR carries onto the
second axis) and **ADR 0594** (which ruled that the WRITE refusal is the control). Feature-loop
2026-09 iteration 23. Gap ids `CMSLWF-13`..`-17` in `docs/steward/WORKFLOWS-ASSESSMENT.md`
§ "CMS content localization — feature loop 2026-09 it.23 re-grade, 2026-09-13" (`8be192a97`).

## Context

This feature's one output is: **a reader gets content in the requested language, and is never
served another workspace's data doing it.** The 2026-08 pass graded six collections — chain pack,
node pack, approval gate, publish sweep, events/erasure/teardown, agents & chat — every one of
them *about* the delivered projection, and **none of them was the delivered projection**. The
second half of the promise is broken.

### The Blocker, measured

`features/cms/cmsService.ts:724` applies `assertSectionTenant(type, d, pageTenantId)` — the
ADR 0593 §C9 / `CMSA-12` guard — to a section's base `data`. **Two lines later**, `:726` calls
`validateLocalizations(type, r.localizations, baseLocale)`, which is **3-ary and receives no
tenant at all** (`:672`). Each overlay goes to `buildSectionData(type, overlay, /*partial*/ true)`,
and in partial mode `entityList`/`entityDetail` preserve `tenantId` verbatim (`:441`, `:472` — the
`!partial` throws are the only guards there). `host/i18n/resolveSection.ts:53` then merges
`{ ...base, ...exact }`, so the overlay's `tenantId` **replaces** the base one for that locale.

**MEASURED end to end** (probe against the real `validateSection` + `resolveSection`):

```
BASE     data.tenantId = FOREIGN             -> REFUSED ("may only reference its own workspace")
OVERLAY  localizations.es.tenantId = FOREIGN -> ACCEPTED, and stored
DELIVERED  en -> tenantId = MINE
DELIVERED  es -> tenantId = FOREIGN      <-- served to Accept-Language: es
```

Both write lanes are open: the HTTP PATCH (`features/cms/routes.ts:241` —
`assertLocaleScopedSectionsPatch` constrains a *grant-holder*, not an ordinary `workspace:write`
member) and the run/agent lane (`features/cms/surface.ts:113` → `sanitizeSectionOverlay`, the same
partial builder → `updatePage` → `validateSections` → `validateSection`).

**Severity, stated honestly.** `readPublicEntities` gates `published + publicRead + !neverPublic`,
so this embeds another workspace's **already-public** rows — the softening ADR 0593 applied to
`CMSA-12`, not exfiltration. What makes it a Blocker is that **ADR 0594 ruled the write refusal IS
the control**: a read-only cure closes the crawler lane and leaves the human one open, and
`test/cms-bound-snapshot-delivery.test.ts:313-320` says so in terms. On the overlay axis that
control does not exist, and the SPA has no read-side guard at all
(`SectionRenderer.tsx:409` passes `tenantId` straight into the anonymous public-entities fetch).

**Why it survived:** the guard's own witness suite (`test/cms-bound-snapshot-delivery.test.ts:312-357`)
has three cases — create-with-foreign-`data`, own-tenant-accepted, PATCH-with-foreign-`data`.
**Zero cases put anything in `localizations`.** The test exercises one axis.

## Boundaries audit (Step 3)

- **No new feature package, no new toggle.** Everything extends `cms` / `cms-localization`.
- **No namespace collision.** D1 changes an internal validator's arity; D2 adds a key to an
  existing event map; D3 adds two headers to an existing route.
- **Single owner respected.** `assertSectionTenant` remains the ONE cross-tenant section
  predicate — verified: it is the only `assert*` guard in the section-validate path
  (`cmsService.ts:724`, defined `:780`). D1 **calls** it on a second axis rather than writing a
  second rule.
- **The plumbing already exists.** `createPage:902` and `updatePage:976` both pass `tenantId` into
  `validateSections`, which forwards it to `validateSection` (`:760`). `validateLocalizations` is
  the only link in the chain that drops it.
- **CORRECTED after the pre-implementation `/architect` pass — the audit said "two tenant-less
  callers, both checked and NOT holes." There are FOUR, and the two I did not list ARE holes.**
  - `routes.ts:241` — **not a hole, confirmed end to end.** It validates tenant-lessly for the
    diff only; `:247` assigns `patch.sections = body.sections` (the RAW body), and `:253` →
    `updatePage` → `validateSections(…, tenantId)` (`:976`). The diff cannot be fooled either:
    `assertLocaleScopedSectionsPatch` is a pure `stable()` comparison and `assertSectionTenant`
    never mutates, so adding it changes throw-vs-no-throw, never normalisation.
  - `cmsService.ts:237` (`registerFieldKindValidator('blocks', …)`) — the ADR 0406 content-section
    field-kind lane, deliberately a STRUCTURE check. Adjacent, different ownership; recorded as
    `CMSLWF-18` for that feature's pass.
  - **`createSharedSection` (`cmsService.ts:1567-1568`) and `updateSharedSection` (`:1602`,
    `:1605`) — HOLES, on BOTH axes.** They never call `validateSection` at all: they call
    `buildSectionData(type, d, false)` and `validateLocalizations(…)` **directly**, so
    `assertSectionTenant` has never run on a shared section — not on the base axis the ADR
    asserted `CMSA-12` had already closed, and not on the overlay axis. Both take `tenantId` as
    their first parameter and never use it for this. Shared content reaches delivery verbatim:
    `resolveSharedRefs:1697-1699` copies `shared.data` AND `shared.localizations` into the served
    page, so one poisoned shared section is served on **every page that references it**.

  **This falsifies three claims the audit made**, including "the plumbing already exists" — it
  does not exist for these two. Worse, **D1 as originally specified would have shipped GREEN and
  left this open**: adding an *optional* `pageTenantId` to `validateLocalizations` changes nothing
  at two call sites that pass no tenant. That is the exact "why it survived" failure shape this
  ADR diagnoses, reproduced inside its own fix.

## Decisions

### D1 (Blocker, `CMSLWF-13`) — the tenant guard applies to BOTH axes, on ALL FOUR write lanes

`validateLocalizations` gains `pageTenantId` **as a REQUIRED parameter** and calls
`assertSectionTenant(type, overlay, pageTenantId)` per overlay. `validateSection:726` forwards the
value it already holds.

**Required, not optional — and that is the load-bearing detail.** An optional parameter would have
let `createSharedSection` and `updateSharedSection` keep passing nothing, the compiler would have
stayed quiet, and the guard would have silently no-opped on the lane the first draft of this ADR
declared safe. Making it required **lets the type system enumerate the call sites instead of my
audit**, which is the only reason the shared-section lane surfaced at all.

**The shared-section lane is fixed in the same phase, on both axes.**
`createSharedSection:1567` and `updateSharedSection:1602` gain
`assertSectionTenant(type, d, tenantId)` before `buildSectionData(type, d, false)`, using the
`tenantId` they already receive. They carry the SAME severity as the filed Blocker — arguably
higher, because `resolveSharedRefs:1697-1699` serves one poisoned shared section into every
referencing page.

**The rule is identical on both axes, deliberately** — equal-or-absent. An overlay naming no
`tenantId` inherits the base (the common case, still legal); one that names it must name this
page's. `assertSectionTenant` returns early for a missing/empty value (`:781-784`), so the partial
shape needs no special case and no second predicate.

**Scope inherited, stated rather than assumed.** `assertSectionTenant` covers `entityList` /
`entityDetail` only (`:782`), and D1 inherits that exactly. Verified: for those two types
`tenantId` really IS the only cross-tenant-reachable field preserved in partial mode —
`entityId`, `termId`, `typeName`, `filterKey/Value` are all tenant-derived through
`readPublicEntities`. But **two other partial-preserved fields reach another org on BOTH axes and
remain unguarded**: `productGrid.storeOrgId` (`:406`, → `public-store/:orgId/products`) and
`form.formId` (`:621`, → `public-forms/:formId`, **globally addressable with no org in the
path**). Filed as **`CMSLWF-19`** against the sections that own them, not widened here — but this
ADR's opening promise is restored **for the entity axis only**, and leaving that exemption
unstated is how the previous three of these were missed.

**Alternative weighed and rejected — forbid `tenantId` in an overlay entirely.** Stricter, and
defensible, but a different rule from the base axis; a guard stricter than the mechanism it guards
is how this project has produced outages before. Parity is the claim; parity ships.

**Alternative weighed and rejected — cure at the read.** ADR 0594 already decided it: a read-side
cure closes the crawler lane and leaves the human one open.

**The witness must close the FIXTURE gap, not just the code gap.** The `CMSA-12` suite
(`test/cms-bound-snapshot-delivery.test.ts:312-357`) gains the `localizations` cases it never had
— create-with-foreign-overlay and PATCH-with-foreign-overlay — **plus shared-section cases on both
axes**, because a guard whose test covers one axis is how this shipped.

### D2 (`CMSLWF-15`) — a locale release emits on the WEBHOOK lane only

`setLocalePublishState` calls `recordCmsAction('locale-publish-state', …)`
(`cmsService.ts:1947`), and that action is in neither `EVENT_FOR_ACTION` (`:1272-1280`) nor
`LIFECYCLE_FOR_ACTION` (`:1317`) — an audit row and nothing else. ADR 0593's own gate comment says
the transition IS a publish (`routes.ts:799-804`).

**Chosen: `EVENT_FOR_ACTION` gains `'locale-publish-state'` → `host.cms.page.published` /
`unpublished`, carrying `locale`. `LIFECYCLE_FOR_ACTION` is deliberately NOT extended.**

**CORRECTED after review — the first draft wired BOTH, and the lifecycle half was destructive.**
`CmsPageLifecycleChange` (`host/cmsPageLifecycle.ts:25-36`) has **no `locale` field**, and the one
registered consumer deletes the WHOLE document on `unpublished`
(`features/docs/docsKnowledgeService.ts:75-79`). So withholding a single `es` overlay of a docs
page would have **evicted a still-published page — its English body included — from the docs KB**,
and the ONE chat would stop answering over it until someone ran a backfill. The page's `status` is
still `published`; nothing would have looked wrong.

The benefit was zero in the other direction too: `flattenSectionData` walks `section.data` only
(`docsKnowledgeService.ts:66`), so the KB stores **base** text and a locale flip changes nothing it
holds. Release would have been a wasteful no-op re-ingest; withhold would have been data loss.

**Therefore the Context line "no `fireCmsPageLifecycle`, so the docs→KB sync never re-ingests" is
WITHDRAWN as a defect for this action** — re-ingesting is not something this transition should do.
If the lifecycle half is ever wanted it needs a `locale?` on the seam type plus a consumer-side
base-locale check, and that is its own decision with its own gap id.

**No new event kind**, because a new `host.cms.page.*` type is an operator-catalog change under the
ADR 0617 D4 parity gate, and the existing kinds describe the reader-visible fact.

**Comment corrected in the same commit:** `cmsService.ts:1288` asserts *"never a locale
(RFC 0103 §F)"*. §F's invariant (`spec/v1/localized-content.md:165`) is scoped to a **run event
log**; a host-ext webhook is not one, and the audit row already carries `locale` via `extra`
(`:1947`). Leaving that comment standing beside contradicting code is the doc-rot shape this ADR
exists to oppose.

### D3 (`CMSLWF-14`) — both blog routes advertise what they vary on

`features/publishing/routes.ts:154-166` forwards `accept-language` into `listPublicBlog`, which
localizes `excerpt` and `readingMinutes` per post, and sets **neither `Vary` nor
`Content-Language`**. Every sibling sets both (`:99`, `:115-116`, `:201-202`, `:229`, `:243`).

**CORRECTED after review — this needs a SIGNATURE CHANGE, and the first draft described an API
that does not exist.** It said "`listPublicBlog` returns the negotiated locale". It does not:
`publishingService.ts:527` returns `Promise<PublicBlogPost[]>`, a bare array. So:

`listPublicBlog` becomes `Promise<{ posts: PublicBlogPost[]; locale: string }>`, negotiating once
via the same RFC 0103 path `localizePage` uses. On the `localizable === false` short-circuit
(`:550-555`) no negotiation runs today, so it returns `settings.baseLocale` — computed, not echoed.
The route keeps its `res.json({ posts })` shape.

**The sibling has it too.** `${PUB}/blog/prerender` sets `Vary: Accept-Language` and **no**
`Content-Language` — the same half-claim, one route away, and its own `PUB2-B2` comment records
that this route already shipped a `Vary` the renderer did not honour. `prerenderBlogIndex` returns
its negotiated locale for the same reason.

### D4 (`CMSLWF-16`) — correct the delivery claim to what the code does

**CORRECTED after review — my own MEASURED count was FALSE, in an ADR whose thesis is that a claim
is not evidence.** The draft said "the only two `cms-localization` toggle reads in the feature".
**There are seven**: six in `features/cms/routes.ts` (five `requireFeatureEnabled` gates on the
authoring/admin routes at `:783`, `:795`, `:822`, `:846`, `:1034`, plus the submit-time
auto-translate boolean at `:301`) and one in `agentTools.ts:65`, plus an FE nav gate
(`frontend/react/src/features/cms/routes.tsx:48`). I counted the two I had happened to read.

**The conclusion survives, and is the part that matters: ZERO of them are on a delivery path.**
`routes/contentDelivery.ts`, `features/publishing/routes.ts`, `features/docs/routes.ts`,
`publishingService.publicPageBySlug` and `cmsService.localizePage` contain no toggle read at all.
So an org that authored overlays and then flips the toggle OFF **keeps serving Spanish**.

`docs/adr/0064-…:251-252` states the claim with the load-bearing qualifier — *"OFF ⇒ CMS
byte-identical **(no authored locales ⇒ base delivery)**"* — and the downstream copies dropped it.

**Chosen: correct the claim, do not change the behaviour.** Gating delivery on an AUTHORING toggle
would make a workspace's published Spanish pages vanish when an operator flips a switch. Verified
house-consistent: **no public delivery route in this repo gates on a toggle** (checked across
publishing, docs and contentDelivery), so this is precedent, not an exception.

**Three copies, not two — and the third is the one that matters most.** `FEATURES.md:191` and
`ROADMAP.md:242` are docs. **`features/cms/feature.ts:87` is the toggle DESCRIPTION an operator
reads at the moment they flip it**, and it currently advertises *"Accept-Language delivery for CMS
pages"* — the strongest form of "flipping OFF should stop delivery". Fixing the two docs and
leaving that would be fixing the copies nobody reads at decision time.

A **delivery-lane** witness pins it. Today's nearest test is *titled* "is byte-identical when the
cms-localization toggle is OFF" (`test/cms-auto-translate.test.ts:158`) and asserts only that the
auto-translate sweep does not fire — a witness-shaped thing beside the claim that does not witness
it, which is the shape this loop keeps finding.

### D5 (`CMSLWF-2`) — declare the durable writers, and predict the ratchet correctly

`packs/feature.cms.nodes/pack.json` declares all six nodes `role:"action"` and states *"All
role:action — outputs are recorded; replay/fork read the recorded result."* `update-section-draft`
and `submit-page` **mutate the `pages` store**, and both are absent from
`MANIFEST_SIDE_EFFECT_FLOOR` and `MANIFEST_FAST_PATH_SERVED`. This is the it.22 `PMXWF-9` shape,
unbitten only by accidental idempotency.

**Chosen:** declare `update-section-draft` and `submit-page` `role:"side-effect"`; bump the pack;
regenerate the floor; re-attest. Both reach no AI, so both WILL be fast-path served — that half is
straightforward.

**CORRECTED after review — my rationale for `translate-section` was exactly INVERTED.** The draft
said "its output is exactly the kind the fast path must serve rather than re-derive." The
generator refuses on purpose: `INVOCATION_LOGGED = /callAI(?![A-Za-z0-9_$])/`
(`scripts/lib/packNodeReach.mjs:118`), and the node reaches `ctx.callAI`
(`packs/feature.cms.nodes/index.mjs:45`), so `classifyNodeReach` returns `ai-invocation-log` and
`deriveServedSet` **holds it back** from `MANIFEST_FAST_PATH_SERVED`. Since `isSideEffectingNode`
consults the SERVED set and not the floor, declaring it buys **floor membership, not fast-path
service** — the node still re-executes on replay, and the ADR 0572 served-set ratchet's
**undischarged `ai-invocation-log` count rises by one.**

That is correct and intended: fast-pathing a `callAI` node would destroy RFC 0041 §B divergence
injection, and the ADR 0326 invocation log is its real discharge. It is declared anyway, because
the manifest's blanket "all role:action" sentence is false for a node that writes and is
non-deterministic. **Expect a +1 HELD-BACK delta, not a +1 served delta** — recorded so the
ratchet diff is read against the right prediction instead of looking like a regression.

**Not redundant with the chain capability.** `examples/workflow-chain-packs/cms-localization/
pack.json` carries `capabilities:["side-effectful"]` at the CHAIN level, but the generator reads
`json.nodes` from `packs/*/pack.json` only — a chain-level capability never feeds the floor.

### D6 (`CMSLWF-17`) — PHASED, not dropped

ADR 0592 §5 built the fallback-disclosure affordance — *"Previewing es — N of M sections fall back
to en"* plus withheld-locale badges, after review F5 caught the preview itself lying — and shipped
it to the **admin preview only**. The public reader got no `Content-Language` reader and no
fallback disclosure; the polish family was deferred wholesale (`CMSLU-8..13`).

**Deferred to a UX-owned phase with a reason, not silently:** the disclosure is a public-surface
design question (what a reader should be told, in which locale, without implying the page is
broken), it is the one item here with no correctness component, and it belongs with the deferred
`CMSLU-` family rather than being invented in a backend ADR. **It stays the feature's headline
residual** and is recorded as such.

## Explicitly NOT filed

- **A partially-translated page IS announced as the requested locale — and the spec REQUIRES it.**
  `../openwop/spec/v1/localized-content.md:115-118` makes per-section fall-through normative and
  gives the same positive example; `:92` requires the body `locale` to equal `Content-Language`.
  Header, body and spec agree. **This was my primary suspicion entering the iteration and it was
  wrong** — recorded so a later pass does not re-open it.
- **The translator grant's three toggle-OFF promises all hold** — enforcement live, removal
  reachable, self-read reachable, each verified at HEAD and witnessed. Scope note, not a defect:
  an overlay is a partial replace of the whole section payload, so a locale grant also reaches
  `ctaUrl`/`imageToken`/`formId`/`productIds` for that locale's readers. A **content** grant, not a
  text grant — worth saying in the UI copy, filed with the `CMSLU-` family.
- **AI translate-from-base** is the strongest part of the feature: typed failure with one bounded
  error-fed repair and three distinct reasons, no success-with-empty, closed-world per-type field
  allowlist, missing-only so it never overwrites a human. Disclosed residual: the submit-time sweep
  writes durably before a human reads, and with `cms-approval-gate` OFF an admin may publish
  directly. Passes CLAUDE.md's "closed-world validation **and/or** a human gate" on the and/or.
- **Erasure / teardown / retention** clean; no translation-job rows exist because translation is
  synchronous. Zero `cms` hits in the destructive-lane census is CORRECT (`eraseCmsSubject` is a
  `registrant-of` the eraseSubject runner; `startCmsPublishSweep` destroys nothing).

## Tracker corrections carried by this ADR

1. **`CMSLWF-5` is CLOSED**, not open — `features/cms/contentApproval.ts:281` carries the fix and
   cites it by id (*"ADR 0593 (CMSA-7 ⇄ CMSLWF-5)"*), returning 409 `unpinned_review` (`:294`).
   **Feature 24 closed feature 23's row and still lists it as inherited-open** — a row it fixed
   itself.
2. **`CMSLWF-10` is FULLY closed**, not half — the ADR 0204 §C6 note landed
   (`docs/adr/0204-…:136-145`, 2026-08-21). It landed under ADR 0593, which is why ADR 0592's
   closeout missed it.
3. **`CMSLWF-11` is HALF closed** — route arm witnessed
   (`test/cms-translate-repair.test.ts:109`, `:124`); chat arm still only `feature_disabled`.
4. **Net at HEAD: 5 open + 1 half, not the tracked 7.** Zero rows stale closed→open.

## RFC verdict

**Host-extension throughout; no new OpenWOP RFC, and none is ridden.** D1 tightens an internal
validator. D2 reuses two **existing** `host.cms.page.*` kinds rather than minting one — a new kind
would be an operator-catalog change under the ADR 0617 D4 parity gate, which is why it was
avoided. D3 adds two response headers to a **non-normative** `/v1/host/openwop-app/*` route; the
normative `/v1/content` lane already sets both unconditionally and is untouched. D4 is
documentation. D5 changes a pack manifest's node classification — host-internal, but it moves the
ADR 0572 served-set ratchet under `docs/steward/`, which is the item to watch.

**Recorded so a later reader does not mistake it for spec behaviour:** D2 rides
`localePublishState`, a host extension beyond `spec/v1/localized-content.md:154` §E, which
declines per-locale publish for v1 and marks it a future additive field. That predates this ADR
(ADR 0205 D2) and the normative `/v1/content` lane is untouched.

**Nothing here changes the normative localized-content wire**, and the one behaviour a reader
could observe — per-section fall-through under a requested locale — is left exactly as the spec
requires (see Explicitly NOT filed).

## Phases

| Phase | Scope | Gap ids |
|---|---|---|
| P1 | `pageTenantId` **required** on `validateLocalizations` + per-overlay assert + **`assertSectionTenant` on both shared-section writers** + the missing `localizations` AND shared-section cases in the `CMSA-12` suite | `CMSLWF-13` |
| P2 | `locale-publish-state` → `EVENT_FOR_ACTION` only (NOT the lifecycle seam), carrying `locale`; correct the `:1288` comment | `CMSLWF-15` |
| P3 | `listPublicBlog` + `prerenderBlogIndex` return their negotiated locale; `Vary` + `Content-Language` on `${PUB}/blog` **and** `${PUB}/blog/prerender` | `CMSLWF-14` |
| P4 | correct the claim in `FEATURES.md`, `ROADMAP.md` **and the toggle description** (`features/cms/feature.ts:87`); add a delivery-lane witness | `CMSLWF-16` |
| P5 | `role:"side-effect"` on the three writers; pack bump; floor + served-set + attestation regenerated, read against a **+1 held-back** prediction | `CMSLWF-2` |
| — | public-reader fallback disclosure — **deferred, UX-owned, reason stated** | `CMSLWF-17` |
| — | `productGrid.storeOrgId` / `form.formId` cross-org reach — **filed, not widened** | `CMSLWF-19` |
| — | the ADR 0406 field-kind lane — **filed for that feature's pass** | `CMSLWF-18` |

## Open questions — both CLOSED by the pre-implementation review

- **OQ-1 (reuse `host.cms.page.published` for a locale release?) — RESOLVED, and narrowed.** The
  webhook half is safe: `emitHostEvent` mints a fresh id per emission and bindings match on exact
  `eventType`, so nothing dedups or suppresses a second `published`. A subscriber that COUNTS
  publishes will see more of them — disclosed, benign, and the `locale` discriminator is enough.
  The harmful half was the lifecycle seam, and D2 now excludes it.
- **OQ-2 (strip a redundant same-tenant `tenantId` from overlays?) — RESOLVED: strip it at
  sanitize time.** This is normalisation, not a stricter rule — the base axis already accepts a
  same-tenant restatement — and it makes `assertLocaleScopedSectionsPatch`'s stable-stringify diff
  quieter for translators.

## What the pre-implementation review changed (recorded, not silently fixed)

The `/architect` pass on this ADR's decision text returned **4 Blockers**, and the most valuable
one falsified the ADR's own boundaries audit:

1. **The audit missed two write lanes, and both were holes on BOTH axes.** `createSharedSection`
   and `updateSharedSection` never call `validateSection`, so `assertSectionTenant` had never run
   on a shared section — including the base axis the ADR asserted `CMSA-12` had closed. **D1 as
   first specified would have shipped GREEN and left it open**, because an optional parameter
   no-ops at a call site that passes nothing. The cure is to make the parameter REQUIRED and let
   the compiler enumerate the lanes: my audit found two callers, the type system finds four.
2. **D2's lifecycle half was destructive.** Withholding one locale of a docs page would have
   deleted the whole page from the docs KB, English included, while its status stayed `published`.
3. **D5's rationale was inverted** — a `callAI` node is deliberately HELD BACK from fast-path
   serving, so the declaration raises an undischarged count rather than lowering one.
4. **D3 described a return type that does not exist**, and **D4 carried a false MEASURED count**
   (two toggle reads; there are seven) in an ADR arguing that a claim is not evidence.

**The transferable lesson is #1's cure.** An audit enumerates what the author thought to look for;
a required parameter makes the compiler enumerate what is actually there. Where a guard must reach
every write lane, prefer the mechanism that cannot be forgotten over the one that must be
remembered.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3794**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** P1 `features/cms/cmsService.ts:689,708,1613,1649`; P2 `cmsService.ts:1331,1347`; P3 `features/publishing/publishingService.ts:540` + `routes.ts:170-172`; P4 `features/cms/feature.ts`; P5 pack 1.5.0 + `executor/sideEffectFloor.generated.ts:295-297,575-576`.
