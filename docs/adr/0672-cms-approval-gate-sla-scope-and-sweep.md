# ADR 0672 — CMS approval gate: who may learn a review exists, and the fourth row-stranding producer

Status: **implemented** (verified 2026-09-17, #3798)

Extends **ADR 0066** (the gate), **ADR 0593** (the fix batch whose D2 producer enumeration this
completes and whose §C1 one-owner lesson this applies again), and **ADR 0230 §B3** (which gave
`strategy-activation` the same decide bar). Feature-loop 2026-09 iteration 24. Gap ids
`CMSAWF-11`..`-15` in `docs/steward/WORKFLOWS-ASSESSMENT.md` § "CMS editorial approval gate —
feature loop 2026-09 it.24 re-grade, 2026-09-13" (`9ea3a28bb`).

## Context

This feature's promise is *nothing reaches the public without a real, audited, inbox-visible
human approval*. **The publish-status surface is genuinely closed** — re-derived independently
this pass from the two write directions: only `transitionPage` and `restoreVersion` write
`Page.status` at all, `updatePage`'s patch type has no `status` field, and `pageToKernel:259-271`
maps anything non-published to `draft` so the kernel row cannot diverge. With the gate ON no lane
publishes without a decide through `decideContentPublish`.

What this ADR fixes is the other half of "inbox-visible": **who learns a review exists**, and
**what the inbox says after a page goes live by another route.**

### The Blockers, measured — there are TWO, on different lanes

**CORRECTED after the pre-implementation review: the surface I cited as a protector is itself a
leak, and it is the wider of the two.**

#### (i) `CMSAWF-11` — the SLA lane broadcasts, on FOUR channels

`host/approvalSla.ts:245-247` resolves recipients from `approval.policy?.approverRefs ?? []`, and
**no CMS lane ever sets `policy`** (`createContentApproval` accepts one at
`approvalService.ts:1322`; its only production caller, `contentApproval.ts:417`, passes none). So
the list is always empty, and `notifyRefs` (`:265-268`) emits with **no `recipientUserId`**.

An unaddressed notification is a true broadcast on **four lanes**, not one — the first draft of
this ADR named only the inbox:

| lane | site | behaviour |
|---|---|---|
| inbox list | `storage/sqlite/index.ts:2265`, `storage/postgres/index.ts:2368` | `recipient_user_id IS NULL` ⇒ every tenant member |
| SSE stream | `routes/notifications.ts:94,107` | no recipient to match ⇒ every connected member |
| **Web Push** | `notifications/webPush.ts:108-111` | `n.recipientUserId ? filter : allSubs` — **`title` + `message` on every device's lock screen** |
| email / Teams | `emailApprovalDelivery.ts:119` | correctly excluded — addressed-only |

`approvalSla.ts:177` sets `title` to the raw `approval.proposal`, so `Publish CMS page "<title>"`
reaches the lock screen of every device in the tenant — including devices belonging to members
the list route and `/reviews` deliberately hide the row from. **Opt-in** (`:127` iterates
`allPolicies.filter(p => p.enabled)`), which bounds it without making it correct.

#### (ii) `CMSAWF-18` — the approvals LIST route implements four of nine audiences and returns the rest UNFILTERED

The first draft cited `routes/approvals.ts` as one of "two surfaces that spend code preventing
exactly this". **It is a leak of its own, and a wider one.** `:177-181` gates only
`content-publish`/`strategy-activation` (`host:members:manage`) and
`strategy-checkin`/`pm-scenario-select` (`workspace:write`); `:187` is `return a` for everything
else. So `GET /v1/host/openwop-app/approvals` returns, with `proposal` text, to any principal
resolving to the tenant:

- `anon-surface-write` — **a widget visitor's captured PII**, which `reviewProjection.ts:612-617`
  hides precisely because the fallthrough *"would leak the visitor's captured PII to every member
  of the surface tenant"*
- `kicktodo-plan-proposal` — a coach's free-text note **about a participant**, which
  `reviewProjection.ts:572` restricts to a single approver ref
- `dealer-registration` / `territory-model-transition` / `commission-statement` — each requiring
  its own `host:*:manage` scope in `/reviews`
- `commerce-listing-publish` — **superadmin-only** in `/reviews`

**This is the strongest evidence FOR the one-owner framing, and the first draft omitted it.**

### The audience rule is a NINE-branch table, not a two-site duplication

`host/reviewProjection.ts:567-624` (`approvalVisible`) **already is** the owner for `/reviews`:

| # | kind | audience | line |
|---|---|---|---|
| 1 | `kicktodo-plan-proposal` | `policy.approverRefs[0]` only (note is participant PII) | `:572` |
| 2–4 | `dealer-registration`, `territory-model-transition`, `commission-statement` | `host:dealers/territories/commissions:manage` in the row's org | `:576-586` |
| 5–6 | `strategy-checkin`, `pm-scenario-select` | `workspace:write` in the row's org | `:591-595` |
| 7 | `commerce-listing-publish` | superadmin tenant only | `:606` |
| 8 | `anon-surface-write` | `workspace:write` (visitor PII) | `:612-617` |
| 9 | `content-publish`, `strategy-activation` | `host:members:manage` in the row's org | `:621-624` |

**Only branch 9 is the rule the first draft enumerated**, and its claim that `null` means
"tenant-scoped, today's behaviour for every other kind" was **false for eight of nine**.

## Boundaries audit

- **No new feature package, no new toggle.** Everything extends `cms` / the host approval seam.
- **`KIND_DISPATCH` (`host/approvalDecision.ts:294`) already carries per-kind behaviour**
  (`getHandler`, `notComposedLabel`, `audit`, `result`). D1 extends that existing table rather
  than standing up a parallel registry — verified before designing, because the last two
  iterations each caught me proposing a mechanism the repo already owned.
- **`listMembers(tenantId, orgId)` exists** (`accessControlService.ts:647`), so recipient
  enumeration composes an existing reader rather than a new query.
- **Why audience is a SIBLING table to `KIND_DISPATCH`, not a field on it (S6).** Both are keyed
  by `kind`, and an unexplained second registry is exactly what this audit exists to catch. The
  reason is a cycle: `approvalDecision.ts` imports feature handlers, so having
  `reviewProjection.ts` / `routes/approvals.ts` import it to read audience would create a
  host→feature→host edge. The audience table therefore lives beside the decision table and is
  imported by the read surfaces only.
- **CORRECTION to my own scouting note:** I was told `CMSA-10` was "member enumeration
  incomplete", which would have constrained D1. It is not — `CMSA-10` is the
  `supportedLocales`-widening Blocker (ADR 0593 `:309-322`), and it is fixed. Verified before
  designing; there is no known enumeration hazard blocking this.

## Decisions

### D1 (Blockers, `CMSAWF-11` + `CMSAWF-18`) — one audience owner, seeded from all NINE branches

**CORRECTED after review on five counts.** The first draft proposed
`approvalAudience(kind) → { scope } | null` on the premise that the rule was hand-written twice
and that `null` was correct for every other kind. Both premises were false, and three further
defects were specified into the design.

**D1a — a DISCRIMINATED audience, seeded from the nine branches above, not a scope-or-null.**

```ts
type Audience =
  | { orgScope: Scope }              // branches 2–6, 8, 9
  | { policyApproverRef: true }      // branch 1 — the note is participant PII
  | { superadminTenant: true }       // branch 7
  | null;                            // genuinely tenant-scoped — enumerated by NAME below
```

`null` is correct for, and only for: `run-proposal`, `assistant-action`, `contact-merge`,
`environment-promotion`, `campaign-spend`, `compensation-action`. **Enumerated by name because a
default is how the other eight would have been silently mis-audienced** — under the first draft
`approvalAudience('anon-surface-write')` returned `null` and the SLA rung would have pushed a
widget visitor's captured PII to every device in the tenant. `assistant-action` is the precedent
that `null` is a real value: `features/assistant/actionApproval.ts:117-131` already emits a
create-time tenant-wide broadcast for it, deliberately.

**A completeness ratchet over the runtime kind tuple** (`approvalService.ts:34-36`) fails the
build when a kind is added without an audience — the APPR-5 redactor-completeness pattern this
repo already owns. Without it the table decays exactly as `routes/approvals.ts` did.

**D1b — two shapes over the one table.** `mayViewApproval(tenantId, subject, approval)` (the
predicate) and `approvalRecipients(tenantId, approval)` (the enumeration). `approvalVisible`
becomes a thin caller; **`routes/approvals.ts:177-187` adopts the predicate, which closes six
currently-unfiltered kinds** (`CMSAWF-18`); `approverRefsOf` consults the enumeration.

**D1c — `approvalRecipients` is ONE batched pass, not an N+1.** The first draft specified
`listMembers` → `resolveEffectiveAccess` per member. MEASURED: `listMembers`
(`accessControlService.ts:647`) does an **unfiltered global `members.list()`** then filters, and
`resolveEffectiveAccess` does `members.list()` + `customRoles.list()` + `groups.list()` **per
call**. That is `1 + 3N` full-collection reads per approval per rung, inside a 60-second daemon
iterating every enabled tenant × every pending approval — against the Postgres connection budget
CLAUDE.md documents. Instead: three `list()` calls once, union computed in memory, modelled on
`resolveSubjectScopesUnion` (`:1341-1385`, which reads each store *"exactly once… independent of
org count"*), plus a per-sweep memo keyed `(tenantId, orgId)`.

**D1d — absent `orgId` ⇒ ZERO recipients, never the fallback.** Both existing predicates already
fail closed (`routes/approvals.ts:181`, `reviewProjection.ts:622`). `listMembers(t, undefined)`
returns `[]` today only by accident of its filter. Written down because, per D5's own lesson, the
unwritten invariant is the one that drifts.

**D1e — the zero-recipient case is a DECISION, not an open question (was OQ-1).** It is reachable
today: `systemSite.ts:167-169` creates `SYSTEM_SITE_ORG` with **no `addMember`**, and the repo's
own comment says authority there is held by nobody — *"a reserved org nobody is a member of…
an ORG-review gate is structurally inapplicable where there is no org to review within"*
(`features/cms/routes.ts:203-210`). Submit queues unconditionally, and
`kindHasRejectSideEffects('content-publish')` is **true** (`approvalDecision.ts:432-435`), so the
expire rung never auto-closes it. The first draft's "emit to nobody, log" would therefore create a
**permanently pending row nobody is notified of and nothing closes**, with its ladder row retained
forever (`approvalSla.ts:133-136` deletes only rows whose approval has left `pending`).

**Chosen: when an audience-ruled kind resolves to zero recipients, emit tenant-wide with the
proposal REDACTED to a kind-generic string** — existence without content, the narrow-projection
discipline `features/cms/routes.ts:488-495` already reasons for. Someone learns a review is
stuck; nobody learns which page.

**D1f — one reasoned NON-adopter, named so a sweep does not "fix" it.**
`GET …/pages/:pageId/review` (`features/cms/routes.ts:496`) serves at `workspace:write`
deliberately: it is the submitter's own page, and `:488-495` records that withholding it *"is what
made the gate a dead end"*. P1 must not adopt the owner there.

**Alternative weighed and rejected — snapshot `policy.approverRefs` at queue time.** Goes stale: a
demoted member keeps receiving reminders, a promoted one never does. Resolving at notify time is
the same rule the list applies at read time.

**Alternative weighed and rejected — make the empty-refs fallback fail closed globally.** One
line, and it silences SLA notifications for the six kinds where tenant-wide is correct.

### D2 (`CMSAWF-12`) — the scheduled-publish sweep closes its approval row — **and DEPENDS ON D3**

`setScheduledPublish` (`cmsService.ts:1758`) permits `in_review`; `publishSweep.ts:64` publishes
via `transitionPage(…, 'publish', SCHEDULED_PUBLISH_ACTOR)` — **with no approval-row closure
anywhere in the file.** MEASURED: four sibling producers have the cure (`cmsService.ts:1090`
`deletePage`, `:1281` `restoreVersion`, `routes.ts:531` unpublish/archive, `routes.ts:555` direct
publish). The sweep does not. ADR 0593 D2 names exactly three producers.

**CORRECTED after review — and I predicted this one when handing the ADR over.** The first draft
said "call `rejectPendingApprovalForPage`, like its four siblings", and ordered P2 before P3.
That function resolves the row `status:'rejected'` (`approvalService.ts:2271-2276`) and
`resolveApproval` derives the chain `outcome` from that status (`:2231-2236`). **A sweep publish
IS a superseding publish**, so the first draft would have introduced on a new lane the exact
defect D3 exists to remove. **P3 now precedes P2, and the sweep calls the superseding closure.**

**Scope is unchanged: do NOT alter publish semantics.** `publishSweep.ts:57-62` already re-checks
`isApprovalGateOn` at fire time and clears the schedule rather than publishing — which is what
shows the stranding is **gate-OFF-only** and strengthens the choice. Refusing a scheduled publish
at fire time would break a legitimate advisory-review workflow, and fire time is the worst moment
to refuse because nobody is watching.

### D3 (`CMSAWF-15`) — a superseding closure records the truth, by a NAMED mechanism, across its whole class

Under the gate OFF, a direct publish closes the row `'rejected'` and the chain records
`outcome:'rejected'` **for a page that just went live**. The chain is this feature's "audited"
promise; an outcome contradicting the page state is the one thing it must not say.

**CORRECTED after review — the first draft left the mechanism unspecified between two options
with very different blast radius, and fixed one of five instances.**

**Mechanism chosen: a chain-only `outcome`, decoupled from `ApprovalStatus`.** `ApprovalStatus` is
a three-value union (`approvalService.ts:32`) baked into the secondary-index id
(`approvalIxId:390-391`) and iterated as a 3-tuple by `listApprovals` (`:2070`). Adding a fourth
status would force an index migration plus every status consumer including
`routes/approvals.ts:143-145` and `frontend/react/src/agents/approvalsClient.ts:49`. The row stays
`rejected`; the CHAIN entry carries `outcome:'superseded'` via an explicit param. The RFC verdict
below silently assumed this — now it is stated.

**Consequence the first draft missed:** `GET …/pages/:pageId/review` (`features/cms/routes.ts:496-513`)
projects the ROW's status, never the chain — so a chain-only outcome is **invisible** to the very
submitter surface D3 promised would render it. P3 therefore adds the projection, or the fix is
decorative.

**The class has FIVE instances, not one.** Superseding closures recorded as `'rejected'`:
`features/cms/routes.ts:555` (named in the first draft), `features/cms/routes.ts:531`,
`features/cms/cmsService.ts:1281`, `features/cms/cmsService.ts:1090`,
`features/commerce-connect/listings.ts:61` and `:79`. **This is D5's own lesson recurring inside
the same ADR** — enumerate the claim, not the instance.

> **DEVIATION recorded at implementation (2026-09-13):** this said "P3 fixes the CMS four; the
> commerce-connect pair is filed with a gap id". **The pair was fixed instead.** Reading them
> showed both are unambiguously supersessions — the code's own comment says *"resolve it as
> superseded"* and both notes begin "Superseded" — so the change is one argument each, additive,
> with no behaviour change. Filing a two-line, provably-correct fix to preserve a scope boundary
> would have left a known-wrong audit entry in another feature for no benefit. Recorded rather
> than done silently, because widening scope mid-implementation is the move that needs a reason.

**FE correction:** `CmsPage.tsx:1011-1032` already carries a neutral `reviewClosedTitle` branch
for an authorless closure, so the frontend work is narrower than the first draft stated — only the
`status === 'draft'` arm is missing, and that branch is the landing spot.

### D4 (`CMSAWF-13`) — `repinContentApproval` must hold the guarantee its own header claims

`approvalService.ts:2129-2153` is a blind read-modify-write: **no `compareAndSwap`** (unlike
`resolveApproval:2216` and `reopenApproval:2260`) and **not inside `withApprovalLock`** — while
its header (`:2126-2128`) states *"It refuses anything that is not still `pending`"*. A
submit/repin interleaving a decide reverts an approved row to `pending`, erases
`resolvedAt`/`decidedBy`, and — because `indexApproval(next)` is called with no `prevStatus`
(`:393-398` only deletes the old entry when one is supplied) — leaves the row indexed under BOTH
`approved` and `pending`. `setApprovalProposal` (`:2168-2174`) is identical.

**Chosen:** both take `withApprovalLock` and CAS, and pass `prevStatus` to `indexApproval`. Blast
radius is inbox/index integrity and attribution erasure, not a publish bypass — filed as an
Improvement, but it is the one function whose comment promises what it does not do.

**Caller trace recorded (S5) — D4 is otherwise sound as written.** Every caller verified outside
the lock: `features/cms/contentApproval.ts:289` (before the CAS in `decideContentPublish`),
`:409` (`queueContentApproval`), `features/commerce-connect/listings.ts:75`. **`withApprovalLock`
(`:421-431`) is a per-key promise chain and is NOT re-entrant — a nested take deadlocks**, so any
future caller invoked from inside a `resolveApproval`/`reopenApproval` callback must not call
these two. Written down because the trace is the thing that makes the fix safe, and it is
invisible from the call sites.

### D5 (`CMSAWF-14`) — re-grep the CLAIM, not the phrasing

The closeout says *"all five pre-C1 doc surfaces corrected; class re-grepped"*. The re-grep used
`byte-identical|status-only|IfGated` — **a pattern derived from the instances already found**.
Grepping the CLAIM ("queueing is toggle-conditional") finds four live instances the sweep never
reached, because it stopped at the backend-prose tier:

| Site | Why it matters |
|---|---|
| `agentTools.ts:332` | **the worst — text a model reads and repeats to the user**, so the agent actively misinforms about whether a review was queued |
| `packs/feature.cms.nodes/pack.json` (`submit-page`) | wire-visible in the builder's node catalog |
| `examples/workflow-chain-packs/cms-localization/pack.json` (`outputs.submitted`) | same |
| `approvalService.ts:2267-2270` | core comment; the cleanup is unconditional and `routes.ts:525-528` says so |

The five surfaces the ADR fixed are all still correct. **The fix was real; the enumeration was
the defect.** Also: ADR 0066's phase table still names a test that no longer exists
(`toggle-OFF-byte-identical`, `:27`) describing semantics its own header note retracts.

**CORRECTED after review — SIX instances, not four**, and the two additions are inside the very
document D5 cites: `docs/adr/0066-…:114` (*"When OFF: nothing changes — no approval row, direct
`approve` works (byte-identical)"*) and `:39` repeat the toggle-conditional claim verbatim. The
first draft cited only `:27`'s stale test name. **D5 undercounted its own class while making the
point that the class was undercounted** — which is the strongest possible argument for grepping
the claim rather than the phrasing.

### D6 (`CMSAWF-9`) — make the pin a COMPILE-TIME fact, and keep the quorum path witnessed

`test/approval-quorum.test.ts:51-57` registers a stub handler in `beforeAll` that returns
`{status:'approved', changed:true}` **without resolving anything**, on a process-global slot
**with no restore**. Every content-publish assertion in that file is an assertion about the stub.

**CORRECTED after review — the first draft's structural pin was grep-shaped, and deleting the test
would have removed the only real coverage of `evaluateQuorum`.**

1. **Make the premise a type fact, not a grep.** The first draft proposed pinning that "no CMS
   lane mints a policy'd row" — but that is a property of call sites, and
   `approvalService.ts:1322` still ACCEPTS `policy`. **Delete the param from
   `createContentApproval`** and the claim becomes a compile error, not an assertion that rots.
2. **Do not delete the behaviour coverage.** `test/approval-quorum.test.ts` is the only file
   reaching `approvalDecision.ts:119-190` (`quorum-review.test.ts` and the RFC 0093 suite exercise
   the INTERRUPT path; `approval-rejection-policy-vocabulary.test.ts` calls
   `evaluateQuorumTally` standalone). **Re-point the behaviour tests at a kind that genuinely
   carries a policy** — `kicktodo-plan-proposal` (`reviewProjection.ts:572`) — so the approval-store
   quorum path keeps a real witness.
3. **Restore the global slot** regardless: a process-global registration with no teardown is a
   hazard to every suite sharing the worker.

### D7 (my carried finding from it.23, completed) — the fourth live-edit copy duplicates TWO halves

I brought forward that `routes.ts:210-219` hand-writes the live-edit rule with a `published`-only
arm, and judged it defensible because `updatePage` bumps `version` unconditionally
(`cmsService.ts:963`) so the approval pin catches `in_review`. **That judgement survives** — and
for a stronger reason than I gave: a MISSING pin now refuses-and-repins
(`contentApproval.ts:281-296`) rather than falling through, which is what made the defence sound.

Two residuals I did not have:

1. **The site duplicates the owner's GATE composition too**, not just its state test: `:210`'s
   `tenantId === SYSTEM_SITE_TENANT || orgId === SYSTEM_SITE_ORG` is `liveEditGateActive`'s body
   verbatim (`contentApproval.ts:84`). That is the §C9 F3 shape recurring in the one site the F3
   sweep did not visit. **Chosen:** call `liveEditGateActive`; keep the deliberate `published`-only
   state arm and its in-code reasoning (`routes.ts:196-199`).
2. **The one path where the version-bump defence is vacuous has no test.** The lazy backfill
   (`routes.ts:442-450`) mints a row AT DECIDE TIME pinned to the current version — so no window
   exists for the pin to catch a PATCH, because the pin is created after it. **CORRECTED after review — a witness is NOT enough, because the guard is VACUOUS, not merely
   untested.** `decideContentPublish` compares `live.version !== approval.pageVersion`, and the
   backfill mints the pin FROM `live.version` moments earlier, so the comparison passes **by
   construction**. The reviewer is certified as having approved content they may never have
   opened — which is the feature's one promise, not a bookkeeping detail. **Chosen:** take the
   exit `contentApproval.ts:281-296` already ships — mint the pin and `409 unpinned_review`, so
   the reviewer re-reads and decides in a second round-trip. My "the behaviour is correct for a
   migration edge" was the wrong call.

## Explicitly NOT filed

- **`pruneResolved`** (`approvalService.ts:2393-2408`) destroys the audited row at 100/tenant
  across all kinds and is **invisible to the destructive-lane census** (P2's name regex does not
  match it; P3's primitives set has no `DurableCollection.delete`). Recorded as `CMSAWF-16` and
  routed to the host-owned census, not fixed here — the population is not this feature's to widen.
- **ADR 0594 is Accepted with ZERO of three phases shipped** (`grep liveReferenceSections` →
  nothing). Its option (d) *accept-the-lane-with-disclosure* rests entirely on the unbuilt D1.
  Recorded as `CMSAWF-17`, cross-feature.
- **Quorum is dead config for this kind** — true, and it is the reason D6 pins rather than
  simulates.
- **`CMSAWF-19` — `review.updated` is an unconditional tenant-wide existence feed**
  (`notifications/notify.ts:185-215`, emitted at `approvalDecision.ts:229`): no
  `recipientUserId`, bypassing every audience branch for every kind. **Accepted as a deliberate
  exception, with the reason stated:** it carries `title:''`/`message:''` and is explicitly a
  machine cache hint, so it leaks no proposal text. It does disclose existence, decision state and
  quorum counts — which is narrower than this ADR's own standard ("never even sees the page title
  / **existence**"). Named rather than left unenumerated, because an unenumerated fourth consumer
  is exactly the failure mode D1 exists to end.
- **`CMSAWF-20` — the governance audit export has a WIDER audience than the rows it contains.**
  `routes/governance.ts:531-558` gates on `requireTenantScope(req, 'host:members:manage')` — the
  scope held in ANY org — then exports the whole chain including every `governance.decision`
  entry's free-text `note`, with no org filter. So a manager of org-A can export org-B's
  content-publish decision notes. Load-bearing for D3, which adds a value to those very entries:
  **a `superseded` outcome lands in a document with a wider readership than the row it describes.**
  Filed, not fixed here — the export's audience is a governance-owned decision, and silently
  widening an already-divergent surface is the wrong move.
- **`CMSAWF-21` — `GET /approvals` has no route-level scope gate**, and `tenantOf`
  (`routes/approvals.ts:43-45`) defaults to `'default'`, so a tenantless request reads the
  `default` tenant's queue. The only authorization is the per-row filter P1 is about to edit.
  **Filed explicitly rather than fixed-in-passing**, so that a P1 touching `:167-187` does not
  imply the route was reviewed — that would be the "a gate on the creation lane is not a gate on
  the use lane" shape.

## RFC verdict

**Host-extension throughout; no new OpenWOP RFC, none ridden.** D1 changes who receives an
in-product notification; D2/D3/D4 are host-internal state and audit-chain corrections; D5 is
documentation plus two pack descriptions (metadata rendered in the builder catalog, not a wire
contract); D6/D7 are tests. No run-event field, capability, endpoint contract or normative MUST
moves, and no decide starts a run (replay/fork N/A, re-confirmed structurally this pass).

**One thing to watch:** D3 changes a value that appears in the tamper-evident governance chain.
It is additive (a new `outcome` value beside `approved`/`rejected`), and existing entries are not
rewritten — but a consumer that switches exhaustively on `outcome` must be checked, which P3
does.

## Phases

**P3 now precedes P2** — the first draft's order would have shipped the D3 defect on the sweep lane.

| Phase | Scope | Gap ids |
|---|---|---|
| P1 | the nine-branch discriminated audience + completeness ratchet; `mayViewApproval` adopted by `approvalVisible` AND `routes/approvals.ts` (closing six unfiltered kinds); `approvalRecipients` as ONE batched pass + memo; absent-`orgId` ⇒ zero; redacted tenant-wide emit on zero recipients; `/pages/:id/review` named as a non-adopter | `CMSAWF-11`, `-18` |
| **P2** | chain-only `outcome:'superseded'` + the `/review` projection that makes it visible + the CMS four instances of the class | `CMSAWF-15` |
| **P3** | the sweep closes its row **via the superseding closure** | `CMSAWF-12` |
| P4 | `repinContentApproval`/`setApprovalProposal` under the lock, CAS, `prevStatus` | `CMSAWF-13` |
| P5 | the six doc-drift instances (incl. ADR 0066 `:39`, `:114`) | `CMSAWF-14` |
| P6 | delete `policy` from `createContentApproval`; re-point quorum tests at `kicktodo-plan-proposal`; restore the global stub; `liveEditGateActive` at `cms/routes.ts:211`; the backfill takes the `unpinned_review` exit | `CMSAWF-9`, D7 |
| — | filed, not fixed: `review.updated` accepted exception · governance-export audience · the ungated `/approvals` route · the commerce-connect pair of the D3 class | `CMSAWF-19`..`-21` |

## Open questions — OQ-1 CLOSED, one remains

- **OQ-1 — RESOLVED into D1e.** It was not a policy question: the zero-recipient case is reachable
  today on `SYSTEM_SITE_ORG`, which is created with no members and which the repo's own comment
  describes as *"a reserved org nobody is a member of"*. Deferring it would have shipped a
  permanently pending row nobody is notified of and nothing closes.
- **OQ-2.** `strategy-activation` shares branch 9 and therefore inherits D1's fix, as do the seven
  other kinds now covered. This ADR changes notification recipients for features it does not own.
  Confirm with those passes rather than assuming a shared bar implies shared intent — the audience
  table makes the change visible, which is the point.

## What the pre-implementation review changed (recorded, not silently fixed)

**8 Blockers.** The four that mattered most each falsified something I asserted:

1. **"Hand-written in exactly two places" was wrong, and the shape was wrong.** The rule is one
   branch of a **nine-branch** audience table that ALREADY EXISTS (`approvalVisible`). I proposed
   new names for an existing owner — **the third consecutive iteration where I specified a
   mechanism the repo already had** — and my `null` default would have mis-audienced eight kinds,
   including one whose own comment says the fallthrough leaks a visitor's PII.
2. **The surface I cited as a PROTECTOR is a leak, and the wider one.** `routes/approvals.ts`
   implements four of nine audiences and returns the rest unfiltered — visitor PII, a coach's note
   about a participant, three field-sales kinds, and superadmin-only listing rows. It should have
   been the ADR's lead evidence; I omitted it while citing the file as evidence FOR the design.
3. **My phase order shipped the defect I was fixing.** I predicted this when handing the ADR over,
   and it was confirmed: the cleanup function records `'rejected'`, so P2-before-P3 would have put
   a "review rejected" entry against a page the sweep had just published.
4. **A deferred open question was a live defect.** Zero recipients is reachable on an org the repo
   documents as having none, and content-publish never auto-closes on expire.

Also: my Blocker understated its own blast radius by three channels (**Web Push puts the page
title on every device's lock screen**); my recipient enumeration was an N+1 over global scans
inside a daemon; D3's mechanism was unspecified between two options with very different cost, and
fixed one of five instances of its class; D5 **undercounted its own class while making the point
that classes get undercounted**; and D6 would have deleted the only real coverage of
`evaluateQuorum`.

**The transferable lesson is #1 and #2 together.** I went looking for a leak on the lane I
suspected, found one, and cited a neighbouring surface as proof the invariant was enforced — while
that neighbour was leaking six other features' rows. *Citing a surface as a protector is a claim
about it, and claims get verified.*

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3798**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** P1 new owner `host/approvalAudience.ts:63,111,136`, adopted by `host/reviewProjection.ts:575`, `routes/approvals.ts:188`, `host/approvalSla.ts:266`; P2 `host/approvalService.ts:2278-2379`; P3 `features/cms/publishSweep.ts:78`; P4 `approvalService.ts:2184,2231`; P5 six doc sites; P6 `features/cms/routes.ts:220`.

**D6 item 1 was RETRACTED in code and this prose is stale on it.** `createContentApproval`'s `policy` param survives at `host/approvalService.ts:1319+` with an in-source note: deleting it would remove real coverage from `approval-quorum.test.ts` and `subject-erasure-host-stores-adr0464.test.ts`.
