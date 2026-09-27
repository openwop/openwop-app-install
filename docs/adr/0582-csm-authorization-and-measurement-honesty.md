# ADR 0582 — CSM authorization and measurement honesty

Status: implemented

Supersedes nothing. Extends ADR 0016 (the CSM feature), ADR 0212 (CSM↔CRM
linkage), ADR 0383 (account depth). Rides the accepted RFC 0049 scope vocabulary
and the accepted RFC 0134 edge-condition wire form — **no new RFC**: every route
here is a non-normative host extension under `/v1/host/openwop-app/*`, and the
chain change uses an operator this host already ships.

## Context

Three independent audit passes over the `csm` feature (`/grade-code`,
`/grade-ux`, `/grade-workflows`, all 2026-08-18) landed on the same two themes,
from opposite ends of the stack.

**1. A human approval gate that did not gate the effect.** The
`csm-ops.renewal-risk` chain declares a `core.chat.approvalGate` and then created
the CRM follow-up task regardless of the decision. `core.chat.approvalGate`
returns `status:'success'` on **reject** as well as approve — `approved` is only
an output field — and the `review → follow-up` edge carried no condition. The
repo already knew this: `features/kicktodo-creator/builtinWorkflows.ts:57-60`
states the behaviour as load-bearing and is exactly why *that* workflow uses
conditioned edges plus a `core.fail` branch. The chain's own description
promised *"On approval, creates one follow-up task"* on a workflow declared
`side-effectful`. That sentence was false as shipped.

The existing witness was vacuous **precisely there**: the e2e drove the run to
the gate, asserted a pending interrupt, asserted no task existed *before* resume,
and stopped. It never resumed, so neither leg had ever executed.

**2. Authorization was absent on the whole feature surface.** `requireEnabled`
(toggle + entitlement) was the entire gate on all four CSM routes: no scope
check, no role check, no caller resolution. In a shared SSO/SCIM/`ws:` tenant —
many humans on one tenantId — every member including a **viewer** could create,
rename, re-score, re-link and **delete** rows carrying ARR, renewal dates and
owner attribution. Separately, `crmRef.orgId` is body-supplied and
`validateCrmRef` proved only that the company existed in that org *of that
tenant*, never that the caller could read that org — a cross-org existence oracle
plus a durable link into an org the caller has no scope in, bypassing ADR 0272
territory row-visibility.

Nothing caught either because **every** CSM HTTP test authenticates with one
`dev-token` operator bearer, which carries `tenants: ['*']` — the wildcard escape
hatch every scope gate in this host honours. A wildcard principal cannot witness
a scope gate: it is admitted by construction whether the gate exists or not.

**3. Measurement dishonesty, backend and UI, as one defect.**
`computeHealthFromCrm` fired whenever *either* CRM fan-in was present and
defaulted the missing side to `[]`, so a partial fan-in scored the unmeasured
side as **zero open rows** — the maximum contribution — producing **100**, and
the service then stamped `healthComputedAt` over a `factors` breakdown asserting
counts nobody observed. The chain's twice-stated "the Account's `crmRef` MUST
already reference orgId/companyId" precondition was enforced nowhere, so a
mis-parameterised run scored an account from a different customer's deals.

The UI had no unmeasured state at all: `healthScore` was non-optional,
`clampScore(undefined)` returned **50**, and the create form pre-filled `'50'` —
so "never measured", "deliberately scored 50" and "the form's default" were one
value, and a 100 from a broken fan-in rendered as the greenest chip on the page.

**The worst consequence is aggregate, not per-row.** `portfolioArrAtRisk` counts
`< 70`, so a fan-in failure *removed* that account's ARR from the at-risk figure.
The executive summary got **quieter** when measurement broke.

## Decision

### §1 — The gate gates the effect (WF-CSM-1, WF-CSM-2, WF-CSM-10)

`csm-ops.renewal-risk`'s effect edge carries the RFC 0134 wire-form condition
`{"type":"truthy","left":"approved"}` (truthy takes no `right`; the host mapper
drops a stray one). A `falsy`-conditioned `gate-reject` node terminates the
rejection branch explicitly rather than letting it complete silently.

> **CORRECTION (R2, 2026-08-18) — this section shipped INVERTED, and the
> witnesses could not see it.** Two defects, recorded rather than rewritten:
>
> 1. **The condition never fired on an approval.** `core.chat.approvalGate` read
>    `resumePayload.decision`, but **every shipped producer sends `action`** —
>    `interrupts/ApprovalCard.tsx`, `chat/registry/defaultCards.tsx`, and
>    `routes/reviews.ts` all POST `{action, comment}`, and nothing normalises on
>    the way in (`routes/interrupts.ts` → `executor.ts` → `suspendSignal.ts`
>    returns the value verbatim). So `approved` was **always false**: clicking
>    Approve took the `falsy` edge, hit `core.fail`, and told the operator *"The
>    renewal review was rejected"*. The task was created on **neither** leg. Fixed
>    at the CLASS level in the gate (§9), not per-chain — the same
>    `{path:'approved', op:'truthy'}` sat in
>    `features/kicktodo-creator/builtinWorkflows.ts` and was latently broken
>    identically.
> 2. **The original witnesses were vacuous on approve.** They resolved with
>    `{decision:'approved', approved:true}` — a shape no UI produces. It passed
>    `validateResumeValue` only because a chat gate's `interrupt.data` has no
>    `actions` array, so the enum check early-returns. The non-vacuity claim
>    below was true for reject and **false for approve**. Rewritten to the real
>    payload (§9).
>
> See also §10 (a rejection is no longer a `core.fail`) and §11 (a conditioned
> edge alone is **not sufficient** — the lighthouse egress case).

`gate-reject` is declared **before** `follow-up` in `dag.nodes` deliberately:
`expandChain` assigns `outputRole:'primary'` to the **last terminal node in
declaration order**, and the chain's declared output is `task`. (Unchanged by
the R2 correction — the node order is preserved, only its `typeId` moved from
`core.fail` to `core.flow.noop`.)

Both edges are port-qualified (`open-deals.deals → review.artifact`) so the
reviewer actually sees the deals — the sibling `csm-ops.health-from-crm` had
already hit and fixed this exact class. `lighthouse.renewal-risk` carried the
same defect on its `notify` leg and is fixed the same way
(`score.content → notify.message`).

### §2 — RBAC at the one existing choke (CSM-1)

`requireEnabled` now also runs `requireTenantScope(req, scope)` —
`workspace:read` on the list route, `workspace:write` on the three mutating ones.
All four routes already funnelled through that helper, so this is one edit.
Order is toggle → entitlement → scope, so a caller without scope in a workspace
where CSM is **off** still learns nothing about CSM's existence there.

### §3 — A body-supplied `crmRef.orgId` is authorized (CSM-2)

CRM's own precedent for a body-supplied org (the lead-convert route): stage it
into `req.params.orgId` and run the **shared** `requireOrgScope` predicate, so
there is one definition of the guard rather than a second copy. Applied on both
POST and PATCH, before `validateCrmRef` resolves the company (which is what would
leak its existence). The wildcard-operator principal keeps the same trusted
escape hatch `requireTenantScope` uses.

### §4 — "Not measured" is a real state, end to end (CSM-3, CSM-8, CSM-11)

`Account.healthScore` becomes **optional; absent means NOT SCORED**. `clampScore`
no longer substitutes 50 — a present-but-invalid score is a typed
`validation_error` and an absent one is simply absent. `healthScore: null` on
PATCH clears a score back to unscored (previously the only way to un-assert a
number was delete-and-recreate, which mints a new `accountId` and destroys the
CRM link and the health history).

`setAccountHealthForTenant` requires, on the COMPUTED path, that the caller name
the company it measured **and** that it equal `crmRef.companyId` — the same shape
as the R2 CS-SP-4 rule beside it: a provenance stamp may not assert more than the
caller proved.

The node **refuses rather than defaults**: both fan-ins and a non-empty
`companyId` are required, and the refusal is *recorded on the row*
(`healthMeasureFailedAt` / `healthMeasureFailedReason`) before the node fails
typed. Recording matters because a failed run is invisible from the CSM console —
without the marker the page would keep showing a stale number forever.

CSM-8: the company filter is now strict, so one org-wide untagged CRM row no
longer deflates every account at once (the pack description already claimed this
behaviour).

### §5 — The breakdown states its own arithmetic (CSM-UX-4)

`healthMethod: 'penalty-sum' | 'weighted-mean'` is stored with `healthFactors`,
and a breakdown without one is refused. The node computes `100 − Σ(w × count)`
(higher value = worse) while the demo seed computes `Σ(w × v) / Σ(w)` (higher
value = better) — **under identical `{factor, weight, value}` headers**. The UI
states the formula in words and labels the third column Count or Value
accordingly.

### §6 — The console renders those states, and its failures (CSM-UX-1/2/3/5)

Three health states (never-measured / measurement-failed / measured) in the
table, the grid (which held its own bare chip and so skipped every fix the table
got), both dashboard tiles, and the health facet. Unmeasured ARR is counted
**out** of "ARR at risk" and counted **in**, visibly, beside it with its own
count and ARR — so the summary gets *louder*, not quieter, when measurement
breaks. Vocabulary copied from `priority-matrix`'s "Unscored" and CRM's
absence-as-an-action.

A failed read is a distinct state from loading, with a consequence clause and a
Retry (it previously left `accounts` null, so `DataTable` rendered skeleton rows
forever with no retry anywhere for the page's primary read). `csmClient` throws a
typed `CsmRequestError` carrying the status so the page maps it to **localized**
copy — the old `err instanceof Error ? err.message : t(…)` idiom could never
select `t`, so sixteen translations were dead by construction and every failure
rendered raw English server text. An account editor covers the six PATCHable
fields that had none.

### §7 — `owner` privacy (CSM-4, CSM-12)

`declarePiiFields('csm:account', ['owner'])`, a registered tenant-scoped
`SubjectEraser`, and a registered retention purger. Both redact **in place**
(the `crm/erasure.ts` anonymize-don't-delete shape): a CSM account is the
tenant's commercial record, so a DSAR must not destroy the business's own ARR and
renewal history to remove one person's attribution.

The account **name** is deliberately *not* declared — it is a company, not a
person. Stated rather than left implicit, per the house norm.

### §8 — Writes are compare-and-swap (CSM-6, CSM-7, CSM-13)

One bounded-retry `mutate` helper backs `updateAccount`,
`setAccountHealthForTenant` and the crmRef scrub. A vanished row returns `null`
(404 at the route) and is never re-created — the PATCH-racing-DELETE
resurrection is now structurally impossible. PATCH no longer ships `200 null`.
The scrub narrows on both halves of `crmRef` **when the org is known**; `orgId`
is optional on the ADR 0283 delete payload, and a stricter guard that skipped
those rows would leave dangling refs — a worse defect than the one it closes.

---

## R2 — the adversarial-review fold-in (2026-08-18)

### §9 — The gate normalises the decision verb (corrects §1)

`core.chat.approvalGate` now reads the verb from `decision` **or `action`** and
maps every shipped spelling through one `APPROVAL_VERBS` table onto its action
union. `action` is the field the UI actually sends AND the field
`validateResumeValue` enum-checks, so it is the one to trust; `decision` /
`approved:true` are retained for direct `ctx.suspend` resolvers.

- An **explicit verb wins** over the legacy `approved` boolean — a payload
  carrying both must honour the verb the reviewer clicked.
- `defer` / `escalate` are **deliberately not in the table**. The card offers
  them, the union has no member meaning either, and inventing one would fabricate
  a decision. They keep the pre-existing non-approving `refine` fallthrough.
- The lookup is guarded with `Object.hasOwn`: `rawVerb` is caller-controlled, so
  a bare index would resolve `constructor` off the prototype chain to a truthy
  non-verb.

This repairs every consumer at once, including
`features/kicktodo-creator/builtinWorkflows.ts`, which carried the identical
`{path:'approved', op:'truthy'}` edge and the identical synthetic-payload e2e.

**Witnesses (all sabotage-proven, and stated per-leg because they discriminate
different things):**

| Leg | Sabotage that reddens it | Sabotage it does NOT detect |
|---|---|---|
| APPROVE `{action:'approve'}` ⇒ 1 task, run completed | gate reads `decision` only | removing the edge condition |
| REJECT `{action:'reject'}` ⇒ 0 tasks, run terminated | removing the edge condition | gate reads `decision` only |
| LEGACY `{decision:'approved'}` ⇒ 1 task | (back-compat pin, not a defect witness) | — |

The reject leg genuinely does **not** discriminate §9: a rejection reaches the
same state whether the verb parsed correctly or fell through to `refine`, since
both are non-approving. Said plainly rather than claimed as coverage.

### §10 — A business rejection is a completed run, not a failed one

The reject branch was `core.fail`. `host/workflowFleetStats.ts` computes
`successRate = completed/(completed+failed)` and excludes only debug/eval/draft
runs — so **every legitimate "no" degraded the workflow's headline number**
(with the §9 defect in place, this chain read 0%).

**Chosen: terminate as a completed run**, not "exclude business failures from the
metric". Identifying a business-terminal failure generically would need a
registry of "business" error codes — a drift-prone hand-kept list, and the same
class of hand-maintained cascade list `/grade-data` flags. `gate-reject` is now a
labelled `core.flow.noop`; the run **completes**, no task is written, and the
rejection stays auditable via the gate's own `decision:'reject'` output in the
run feed. `workflowFleetStats.ts` is untouched.

### §11 — A conditioned edge is NOT sufficient (the lighthouse egress case)

`lighthouse.lead-triage`, `lighthouse.account-brief` and **`lighthouse.post-meeting`**
(the last was missing from §1's list entirely) each gate an **external** effect —
two outbound emails and a notification. `core.openwop.integration.email-send`
sends unconditionally and `host/emailAdapter.ts` has no approval interception, so
a rejected review **sent the mail anyway** — strictly worse than the CRM-task
case, because the effect leaves the building.

**The naive fix is vacuous, and this is the load-bearing finding.** MEASURED
against the real scheduler: with the effect node ALSO fed by an unconditional
sibling data edge (`draft.content → send.text` — the shape these chains shipped),
`evaluateTrigger` returns `ready` on a rejection anyway. `all_success` requires
`allTerminal && !anyFailed && anyCompleted`, and the completed data edge
satisfies `anyCompleted` on its own even though the gate edge folded to
`skipped`:

| wiring | reject | approve |
|---|---|---|
| conditioned gate edge + unconditional data edge | **`ready`** ← still sends | `ready` |
| data routed THROUGH the gate (one conditioned edge) | `skip` | `ready` |

So the fix routes the content through the gate — `draft.content →
approve.artifact → send.text` — giving the effect node exactly one, conditioned,
incoming edge. This required a small additive gate output: `artifact`, the
approved artifact (the reviewer's edited version when they edited it, else the
input verbatim), added to `approvalGate.output.json` (which is
`additionalProperties:false`).

Witnessed in `workflow-chain-lighthouse.test.ts` against `evaluateTrigger`
itself, **not** the pack JSON — asserting on the JSON would have passed the
vacuous shape. Sabotage-proven: reverting lead-triage to conditioned-edge-plus-
sibling reddens the REJECT leg.

**Not fixed here, and not hidden: the class is 43, not 3.** A sweep of
`examples/workflow-chain-packs/*` finds **43 unconditional post-gate edges across
25 packs** with the same shape (`sales-outreach`, `inbox`, `commerce`,
`people-hr`, `finance`, `support`, `marketing`, `campaign-journeys`,
`customer-onboarding`, `it-support`, `knowledge`, `release-comms`,
`weekly-digest`, `starters`, `data-ops`, `exec-ops`, `feedback-triage`,
`incident-postmortem`, `meeting-ops`, `approvals`, `crm-ops`, …). Every one is a
gate whose rejection still performs the effect. They are **out of scope for this
PR** (each needs a per-chain decision about where its content should flow, and
the batch needs the full chain-config-conformance suite), but they are a real
open defect and are recorded as such rather than left for the next reviewer to
rediscover. §9's normalisation is a prerequisite for fixing any of them.

### §12 — The PII declaration is entity-scoped, not global

`declarePiiFields` adds every declared name to an **entity-agnostic union**
(`allPiiFieldNames` → `isKnownPiiFieldName` → `maskPiiDeep`), which
`observability/logger.ts` applies to **every log bag**, masking ON by default.
Declaring a word as generic as `owner` globally would rewrite any `owner` log key
app-wide to `pii_<sha>` — including app-builder's sync-binding `owner`, a GitHub
login. That is precisely the repo-owner false-positive class the Alternatives
entry cites when refusing to widen the *erasure* matcher; introducing it into the
*log-mask* union instead would be the same mistake one layer over.

`declarePiiFields` takes an optional `{ maskGloballyByFieldName }` (default
`true`, so every existing call is unchanged) and CSM passes `false`.
`isPiiField('csm:account','owner')` still returns true, so erasure, retention and
export are unaffected. **Trade-off, stated:** a value logged under a bare `owner`
key is then not masked for CSM either — accepted because the deep walk has only
the leaf key and cannot tell the two apart, and `src/features/csm/` emits **zero**
`log.*` calls (measured), so the global declaration bought no masking in practice
while costing the union a very common word.

### §13 — How far the DSAR actually reaches (narrows §7)

`eraseCsmSubject` matches `owner === subjectKey`. The field's only real producer
is a **free-text "Account owner" box**, and a display name never equals a subject
key — so for the values that motivated declaring it PII, the DSAR sweep is a
**no-op**. The §7 test pins the documented contract (`owner:'user:cs-1'`), not the
producer, so it did not witness this either.

Stated plainly rather than papered over with a substring match, which would erase
the wrong people. **The retention purger IS real coverage** (age-based and
value-agnostic — it does not care what shape `owner` holds), as is ADR 0284
tenant teardown; that claim stands. Closing the gap properly means normalising
`owner` to a subject ref at the **write boundary** (a user picker rather than a
free-text box) — a product change, recorded as open work. A new test pins the
gap explicitly so the coverage claim cannot be read wider than it is.

### §14 — The dashboard deep link is wired

`CsmHealthTile` links `/csm?health=unscored`; `CsmPage` never read
`useSearchParams`, so the click landed on an unfiltered list — a promise the page
did not keep, in a change about exactly that. `healthFilter` now seeds from
`?health=`, honouring only values in the known tier union (an unrecognised param
is ignored rather than filtering everything away). Three witnesses incl. a
no-param control, sabotage-proven.

### §15 — The node refuses an unlabelled breakdown instead of inventing one

The explicit-`factors` branch defaulted `method` to `'penalty-sum'`, satisfying
the service's "a breakdown with no stated arithmetic is not interpretable" check
by **fabricating the arithmetic** — an upstream weighted-mean breakdown got
stamped `penalty-sum`, which the SPA renders as a sentence and the agent prompt
tells the model to trust. It now `refuseToScore`s (recorded on the account, then
a typed failure), the same "invent rather than refuse" shape removed from
`clampScore`. Only the fan-in branch still hardcodes `penalty-sum`, because that
branch actually runs it. The pre-existing passthrough test never asserted
`method`, which is why the fabrication was invisible; it now does.

### §16 — Attribution coverage makes a measured zero legible

The strict `t?.companyId === companyId` filter is correct — it replaced an
over-count charging every account for every unattributed row — but `Task.companyId`
is optional and the sibling chain's own `create-task` never sets it, so
`openTasks` reads **0 for most tenants**, indistinguishable from a measured zero.
The breakdown now carries unweighted `dealsAttributed`/`dealsSeen`/
`tasksAttributed`/`tasksSeen` denominators (`weight: 0`, so they can never move
the score; 6 factors, within the service's `MAX_FACTORS` of 12). They are plain
`{factor, weight, value}` entries because `validateHealthFactors` **keeps only
those three keys** — an `of:` side-channel would have been silently dropped on
write, advertising provenance the store never kept. The SPA labels zero-weight
rows as context (i18n ×4), and the node pack description says so.

## Alternatives weighed

- **Fix the approval gate node instead of the chain.** Making
  `core.chat.approvalGate` return `status:'failure'` on reject would fix every
  consumer at once — and break the ones that deliberately branch on `approved`
  (kicktodo's checkpoint barrier reads a *completed* gate). Rejected: the chain
  is where the authoring decision belongs, and RFC 0134 already expresses it.

  > **PARTIALLY OVERTURNED (R2, 2026-08-18).** The conclusion — don't change the
  > gate's *status* — still holds. But this framing led to fixing only the chain,
  > and the actual defect was **in the gate**: it read a field no producer sends
  > (§9). "The chain is where the authoring decision belongs" is true of the
  > *edge condition*; it is not a reason to leave the gate's own decision parsing
  > wrong. §9 changes what the gate READS, never what it RETURNS, so the
  > checkpoint-barrier consumers are unaffected.
- **A per-account write lock instead of CAS.** Rejected: `compareAndSwap` is
  already on `DurableCollection`, is correct across instances, and the CRM
  sibling has the precedent. A lock would be a second concurrency primitive.
- **Delete the account on DSAR.** Rejected — see §7.
- **Keep `healthScore` non-optional and add a sibling `healthState` enum.**
  Rejected: leaving a number present for an unmeasured row is exactly how the
  defect survived three prior review rounds. Absence must have no numeric
  representation.
- **Widen the ADR 0464 feature-store gate's matcher to `owner`.** **Rejected —
  but the numbers this entry originally gave were WRONG, and are corrected here
  rather than quietly edited.**

  It said: *"a bare `owner` signal enumerates 7 stores, three of which
  (`app-builder:sync-binding` / `-webhook` / `-deliveries`) hold a GitHub repo
  owner."* **RE-MEASURED 2026-08-18** by replaying the gate's OWN enumerator
  (`subject-erasure-feature-stores.test.ts` — `STORE_RE` over `src/features/**`,
  matching the row type body with one level of nested-type expansion) with an
  `owner` signal added:

  | Claim | Stated | Measured |
  |---|---|---|
  | stores bound by a bare `owner` | 7 | **4** |
  | …holding a GitHub repo owner | 3 | **1** |
  | …already registering an eraser | — | **4 of 4** |
  | signals the gate binds | "five field-name shapes" | **six** |

  The four are `app-builder:sync-binding`, `crm:contact`, `crm:deal`,
  `csm:account`. Only `SyncBinding.owner` is a repo owner (constrained by
  `GH_OWNER_RE`, *"GitHub login"*); the two other stores named above
  (`WebhookRef`, `DeliveryRow`) carry **no `owner` field at all**. The sixth
  signal the original count missed is the KB-3 actor signal
  (`createdBy`/`uploadedBy`/`authorId`), alongside `userId`, `subjectKey`,
  `subjectId|managerSubjectId`, `contactId` and email.

  **Does the refusal still hold? Yes — on a narrower ground.** Since all four
  already register a module-level eraser, widening would add **zero** new
  debt-ledger rows, so the harm originally claimed ("booking those as
  newly-classified") does not occur at all. What remains: `eraseSyncBindingSubject`
  rewrites `boundBy` only and has no reason to touch a GitHub login, so a widened
  matcher would let the gate assert `owner` coverage that nothing provides. That
  is still false coverage — **one** instance rather than three. Left as recorded
  work needing a narrower signal.

## Implementation record

| § | Change | Witness |
|---|---|---|
| 1 | `csm-ops.renewal-risk` conditioned edges; port-qualified artifact edge; `lighthouse.renewal-risk` notify leg | `workflow-chain-csm-ops-execution.test.ts`, `csm-packs.test.ts` (`WF-CSM-1`, `WF-CSM-2` over the REAL expanded def + REAL `buildNodeInputs`) — **superseded in part by §9–§11 below** |
| 2–3 | `requireTenantScope` in `requireEnabled`; `authorizeCrmRefOrg` on POST + PATCH | `csm-authz-http.test.ts` — real non-privileged principals in a real `ws:` workspace via the production identity path |
| 4–5 | optional `healthScore`, typed `clampScore`, `computedForCompanyId` + `method` requirements, node refusal + recorded failure, strict company filter | `csm-packs.test.ts`, `csm-feature.test.ts` |
| 6 | SPA states, typed client error, editor, tiles, i18n ×4 | `csmMeasurementHonesty.test.tsx` (12 legs), `csmRound2.test.tsx` |
| 7–8 | PII declaration + eraser + purger; CAS `mutate` | `csm-privacy-and-concurrency.test.ts` (8 legs) |
| 9 | `APPROVAL_VERBS` normalisation in `packs/vendor.myndhyve.chat/index.mjs` | `workflow-chain-csm-ops-execution.test.ts` — APPROVE / REJECT on the REAL UI payload + a LEGACY `{decision}` pin |
| 10 | `gate-reject` → `core.flow.noop`; run completes on rejection | same file (reject ⇒ `completed`), `csm-packs.test.ts` `WF-CSM-1` (asserts NO `core.fail` remains) |
| 11 | lighthouse lead-triage / account-brief / post-meeting rewired through the gate; `artifact` output + schema | `workflow-chain-lighthouse.test.ts` — 6 legs against the REAL `evaluateTrigger` |
| 12 | `declarePiiFields(..., {maskGloballyByFieldName:false})` | `csm-privacy-and-concurrency.test.ts` — `owner` absent from the global union, present per-entity |
| 13 | documented DSAR limit | same file — a free-text owner name survives erasure |
| 14 | `CsmPage` reads `?health=` | `CsmPage.test.tsx` — 3 legs incl. a no-param control |
| 15 | node refuses a `factors` breakdown with no `method` | `csm-packs.test.ts` — refusal recorded, no score written |
| 16 | attribution-coverage factors + SPA note (i18n ×4) | `csm-packs.test.ts` — unattributable fan-in reports `tasksSeen:3, tasksAttributed:0` |

**Non-vacuity.** Every new witness was run against the pre-fix code and observed
**red**, then restored: the four workflow legs (edges reverted), the three RBAC
legs (gates removed), and three of the eight privacy/concurrency legs (eraser
registration and CAS removed). One leg is documented **in-file as
NON-discriminating** — the "no membership" case still passes without the gate,
because `middleware/auth.ts` bounces a non-member to their personal tenant where
the toggle is off and the route 404s. It is kept for the fail-closed property,
not as a witness.

> **CORRECTION (R2) — the claim above was FALSE for the approve leg.** The
> original §1 workflow witnesses resolved with `{decision:'approved',
> approved:true}`, a shape no UI produces, so "observed red then restored" was
> true of the reject leg and **vacuous** for approve: the approve path could not
> fail, because the payload never exercised the code the UI actually hits. This
> is the second time in this ADR that a green witness described a state no caller
> produces (§13 is the other). The R2 legs below are sabotage-proven
> **individually**, and each records which sabotage it does NOT detect:
>
> | Leg | Reddened by | Blind to |
> |---|---|---|
> | §9 APPROVE (`{action:'approve'}`) | gate reading `decision` only | edge-condition removal |
> | §9/§10 REJECT (`{action:'reject'}`) | edge-condition removal | gate reading `decision` only |
> | §11 lighthouse REJECT ×3 | reverting to conditioned-edge + sibling data edge | — |
> | §14 `?health=unscored` | dropping the `useSearchParams` read | — |
>
> The §11 sabotage is the important one: it reddens against the *naive* fix, so
> it discriminates a shape that LOOKS correct in the pack JSON.

**Replay note.** Both chain changes are definition-shape changes: existing
instantiations keep their old expansion id and old behaviour. Re-instantiate via
`…/workflows/from-chain` to pick them up. `expandChain` remains clock/random-free.

## Open questions

- [ ] A narrower subject-signal for the ADR 0464 feature-store gate that
      distinguishes a person-`owner` from a repo-`owner` (see Alternatives).
- [ ] WF-CSM-3: the created follow-up task still links to nothing — the
      reviewer's decision payload is not carried into `follow-up.dealId`/`title`.
- [ ] WF-CSM-5: "Renewal risk" still never reads `Account.renewalDate`; ADR 0568's
      proposed `on-renewal-window` sensor is the doctrine-fit cure.
- [x] ~~`lighthouse.account-brief` and `lighthouse.lead-triage` carry the same bare
      `approve → …` edge shape as the leg fixed here.~~ **Done in R2 §11** — and
      the list was incomplete: `lighthouse.post-meeting` had it too.
- [ ] **The 43-instance class (R2 §11).** 43 unconditional post-gate edges across
      25 chain packs still perform their effect on a rejection — outbound email,
      Slack, notifications, ERP/HRIS/ticket connectors, `http.openapi-call`.
      §9 is the prerequisite; each chain then needs a per-chain decision on where
      its content should flow (the sibling-data-edge trap in §11 means a
      conditioned edge alone will NOT fix them), plus a full
      chain-config-conformance run.
- [x] **DISTINCT mechanism, DIFFERENT node type — `core.approvalGate` single-approver
      resume was verb-blind (WF-DOC-2 / GEN-DOC-2, fixed 2026-08-20).** Not one of
      the 43 above (those are `core.chat.approvalGate` reinvoke-lane instances whose
      gate normalises the verb per §9 and whose hazard is the unconditional SIBLING
      edge). This was the HOST resume path itself: `requiredApprovals: 1` routes
      around the quorum machinery (`routes/interrupts.ts` `recordQuorumVote` → null)
      and the executor's resume-by-snapshot marked the node `completed` without
      reading the verb — so EVERY single-approver `core.approvalGate` in the corpus
      fired its downstream on a reject and `rejectionPolicy` was inert (live
      instance: `anniversary-draft.approve → notify`). Fixed at the host resolve
      path: a non-quorum `{action:'reject'}` on a `core.approvalGate` now fails the
      run `approval_rejected`, mirroring the quorum-reject and RFC 0093 §D.1
      timeout paths (which both already had it right). Witness:
      `test/approval-gate-reject-blocks.test.ts` (born-red). Verified before
      shipping: zero chains condition an edge on a core.approvalGate reject, so no
      consumer relied on reject-continues; the reinvoke lane (`core.chat.approvalGate`,
      the kicktodo barrier) is out of scope and unchanged.
- [ ] **`all_success` permits skipped upstreams (R2 §11).** `scheduler.ts`'s
      docstring says *"every upstream completed && none failed"*, but the
      implementation is `allTerminal && !anyFailed && anyCompleted` — one
      completed edge is enough. That gap is what makes a conditioned gate edge
      vacuous beside an unconditional sibling. Not changed here (the kicktodo
      barrier and other fan-in patterns depend on current skip semantics, so it
      needs a corpus-wide blast-radius measurement first), but doc and code
      disagree and one of them is wrong.
- [ ] **Normalise `Account.owner` to a subject ref (R2 §13)** so the DSAR reaches
      the field's real producer. Needs a user picker in place of the free-text
      box — a product change.
- [ ] CSM-9: `GET /accounts` is still unpaginated, uncapped, and echoes
      `tenantId` to the browser (the workflow surface projects it out).
