# ADR 0645 — CSM: tool/route scope parity, refusing to score an absent company, and honest replay classification

Status: implemented
Date: 2026-09-09
Feature: CSM / Customer Success (ADR 0212) · FEATURES.md ordinal 7 of 71
Extends ADR 0212 · Composes ADR 0315 (tool/route predicate parity), ADR 0582 (CSM
authorization + measurement honesty), ADR 0587 §7 (`role:"action"` is not read), ADR 0572
(the served-set ratchet)
Source: `/grade-workflows` re-grade 2026-09-09 (`WORKFLOWS-ASSESSMENT.md`, `CSMWF-1..11`)

## Context

The 2026-09-09 re-grade found the gate layer #3344 fixed to be genuinely sound — the
`renewal-risk` gate has the correct dual-leg shape, routes effect content *through* the
gate so the effect has no unconditional inbound edge, and is re-derived from
`listChains()` by a corpus-wide shrink-only ratchet. All three Blockers are **outside**
that layer, and each is a case of a rule this repo already enforces somewhere else being
unenforced here.

## Decision

### D1 — the agent tool calls the same predicate as its route (`CSMWF-1`, Blocker)

`csm/agentTools.ts` gates on the toggle and an acting user, then performs a tenant-wide
`listAccounts`. `GET /accounts` demands `workspace:read`. So a member with the toggle on
and no `workspace:read` is refused by the route and handed **the full account book — ARR,
renewal dates, owner attribution — by chat.**

This is not a missing-helper problem. `requireTenantScope` exists and its docblock says
it is a thin wrapper *"so the run lane can call the SAME predicate without a Request"*
(`featureRoute.ts:260-270`), and the sibling **`crm/agentTools.ts:147-158` already calls
`assertTenantScope`**, threading `scope.personalTenant`. One helper, two callers, honored
on the CRM side of the same bundle.

The CSM tool gains `checkTenantEntitlement` + `assertTenantScope(..., 'workspace:read',
{ personalTenant })` — **`workspace:read`, not `write`**, because the tool only reads and
over-gating would refuse legitimate readers.

The docblock claiming "Authority parity … the SAME adapter the routes and workflow nodes
call" is corrected: sharing a **data adapter** is not sharing an **access predicate**, and
that conflation is what made the gap invisible.

### D2 — refuse to score an absent company; record the refusal (`CSMWF-2`, Blocker)

A merged CRM company yields a fabricated **100** — the greenest chip on the page.
`mergeCompany` writes a `mergedInto` tombstone without firing `fireCrmRecordDeleted`, so
`crmRef` keeps pointing at it; `listDeals`/`listTasks` **filter without validating the
company exists** and return `[]`; both fan-ins are present and non-empty-`companyId`, so
every ADR 0582 §4 guard passes and `100 − 0 − 0` is stamped as a real measurement.

**This is ADR 0582's own headline defect through a different door** — its Context
describes a `100` from a broken fan-in rendering as the greenest chip while
`portfolioArrAtRisk` (which counts `< 70`) makes the executive summary *quieter* exactly
when measurement breaks.

`setAccountHealthForTenant` already re-validates `computedForCompanyId === crmRef.companyId`;
it now also re-runs the **existing** `validateCrmRef` check — which already rejects a
tombstone — and on failure takes the `refuseToScore` path instead of writing a score.

Second half: on the DELETE path the cascade scrubs `crmRef`, after which the service
**throws** rather than routing through `refuseToScore`, so the durable "why I stopped
measuring" marker is never written and the account keeps its last score and stamp
forever. The whole point of `measureFailed` is defeated on the one path where the link is
legitimately gone. Both paths now refuse-and-record.

### D3 — classify the durable writer honestly (`CSMWF-3`, Blocker; `CSMWF-5`, `CSMWF-6`)

`feature.csm.nodes.health-set` writes durable tenant state and declares `role:"action"`,
and its docblock asserts that this means "replay/fork read the recorded result rather
than re-executing". **MEASURED: `git grep -nE "role\s*===\s*'action'" -- src/executor
src/host` returns nothing.** The executor never reads that field —
`sideEffects.ts:185-190` already says so verbatim, an ADR 0587 §7 finding that this pack
reproduced. The contrast lives inside the same chain: `feature.crm.nodes.create-task`
declares `role:"side-effect"` + `["side-effectful"]` and is in both the floor and the
served set; CSM's *writer* is classified like CRM's *readers*.

`health-set` gains `role:"side-effect"` + `capabilities:["side-effectful"]`, pack
1.3.0 → 1.4.0, with `feature.ts`'s pin moved in lockstep. **The floor/served ripple was
checked before deciding:** the node reaches no host AI capability, so it is *served*
rather than held back — floor and served both rise by one and **`undischarged` stays
flat**, which is what the ADR 0572 ratchet actually constrains. The false docblock is
corrected rather than deleted, because the claim it made is the one a reader would
otherwise re-derive.

`health-set` is also added to `EFFECT_TYPEIDS` so the derived corpus ratchet can see
CSM's own write node (`CSMWF-5`) — today a future gate feeding it would be caught by
nothing — and a `csm-node-replay` witness lands beside the existing `crm-`/`kb-`/`users-`/
`orgs-`/`comments-node-replay` files, together with the byte-identical double-expansion
assertion the CMS pass has and this one does not (`CSMWF-6`).

### D4 — the gate declares the verbs it can honour (`CSMWF-4`)

`review` declares no `config.actions`, so `defer`, `escalate`, `request-changes` — and any
arbitrary string — fall through to `refine` ⇒ `approved:false` ⇒ a node labelled
"Rejected — no follow-up task created", with the run reported `completed`. **A reviewer
who declined to decide has it recorded as a decline.** The cure is named in the gate
pack's own docblock and **the sibling `crm-ops/pack.json:60` already ships it**. CSM sits
on the `UNDECLARED_ALLOWED` debt list under a justification —
`maxRequestChangesIterations > 0` — that does not apply to `csm-ops`, which sets no such
config. Declaring `["approve","reject"]` makes `validateResumeValue` refuse an
unhonourable verb with a 400 and leaves the run interrupted, and the debt row is deleted.

## Alternatives weighed

- **Gate the CSM tool on `workspace:write`** (matching CRM's segment tool). Rejected —
  the CSM tool only reads; over-gating refuses legitimate readers. Parity means the same
  predicate as *its own* route, not the same literal scope as a different feature's.
- **Detect the absent company inside the node** by adding a CRM read to `health-set`.
  Rejected — it crosses a feature boundary the direction ADR 0212 forbids, and the check
  already exists service-side in `validateCrmRef`.
- **Make `mergeCompany` fire `fireCrmRecordDeleted`.** Rejected as the primary fix: a
  merge is not a delete, and the CSM cascade *scrubs* the ref, which would silently
  unlink accounts from a company that still exists under a survivor id. The honest fix is
  to refuse to measure, not to pretend the link is gone. Re-pointing a merged ref at its
  survivor is worth doing and is out of scope here.
- **Suppress the score client-side when the company is missing.** Rejected — the wrong
  layer; the durable row would still carry a fabricated 100 for every other reader.

## Open questions

- `CSMWF-7` (a created task carries no `companyId`, so the two chains cannot see each
  other's work) needs a `feature.crm.nodes.create-task` input addition — a CRM pack
  change, deferred to keep this ADR's blast radius inside CSM.
- Re-pointing a merged `crmRef` at its survivor company is the follow-on to D2.

## Phased plan

| Phase | Scope | Gap ids |
|---|---|---|
| P1 | Tool/route predicate parity + its witness | `CSMWF-1` |
| P2 | Refuse-and-record on both absent-company paths | `CSMWF-2` |
| P3 | Side-effect classification, ratchet visibility, replay + determinism witnesses | `CSMWF-3`, `CSMWF-5`, `CSMWF-6` |
| P4 | `config.actions` + delete the debt row; doc drift | `CSMWF-4`, `CSMWF-10` |


## Implementation record

| Phase | Decision | Change | Witness |
|---|---|---|---|
| P1 | D1 `CSMWF-1` | `csm/agentTools.ts` calls `checkTenantEntitlement` + `assertTenantScope(…,'workspace:read',{personalTenant})` | `crm-csm-agent-tools.test.ts` — born-red (the tool returned the account book); now `forbidden_scope`. The happy path still passes, so the fix does not over-gate |
| P2 | D2 `CSMWF-2` | `accountsService.setAccountHealthForTenant` re-uses `validateCrmRef` and takes the refusal path on both the merge and delete doors | `csm-feature.test.ts` ×2 — both born-red; the merge leg pins the last honest score (42) surviving rather than a fabricated 100 |
| P3 | D3 `CSMWF-3` | `health-set` → `role:"side-effect"` + `["side-effectful"]`, pack 1.3.0→1.4.0, pin + docblock corrected | `csm-node-replay.test.ts` (new) — **sabotage-proved**: restoring the `action` role reddens legs 1, 2 and 3 |
| P3 | `CSMWF-5` | `health-set` added to `EFFECT_TYPEIDS` | the derived corpus ratchet still passes, so no existing chain has an ungated `health-set` |
| P3 | `CSMWF-6` | byte-identical double-expansion leg | `csm-node-replay.test.ts` leg 5 |
| P4 | D4 `CSMWF-4` | `"actions": ["approve","reject"]` on the gate; chain 1.1.0→1.2.0, pack 1.1.0→1.2.0; the `UNDECLARED_ALLOWED` debt row deleted | `workflow-chain-email-reject-witness.test.ts` passes with the row gone |
| P4 | `CSMWF-10` | node-pack version drift corrected at three sites (FEATURES.md, ADR 0212, `feature.ts` comment) | — |

### The floor ripple was checked BEFORE deciding, not after

Reclassifying a node moves the ADR 0572 numbers, and that ratchet constrains
**undischarged**, not the floor. Measured: floor 305 → 306, served 262 → 263,
**undischarged unchanged at 43** — `health-set` reaches no host AI capability, so nothing
holds it back and it is genuinely served rather than merely floored. Had it been
held back, this fix would have grown undischarged and tripped the ratchet, and the
right move would have been to say so rather than raise a baseline.

### Two defect pins removed

`csm-packs.test.ts:54` asserted `role === 'action'` — **pinning the misclassification as
correct**, in the same file that pins everything else about this pack. And the
`UNDECLARED_ALLOWED` row held "declining to decide is recorded as a decline" as the target
under a justification (`maxRequestChangesIterations > 0`) that does not apply to `csm-ops`.

### Correction — one prescribed assertion over-reached

The first cut of the D2 witness asserted that a refusal must CLEAR `healthFactors`. That
is not the contract: `measureFailed` deliberately keeps the last honest score, and the UI
already ranks the recorded failure above it (`csmMeasurementHonesty.test.tsx:81`). Forcing
a clear would have changed `measureFailed` semantics repo-wide to make one new test pass.
The assertion was rewritten to the property that actually matters — **the empty fan-in
must not overwrite the last honest score with a greener fictional one** — which is
discriminating because the fixture's pre-merge score is 42, not 100.

### Deliberately NOT closed

`CSMWF-7` needs a `feature.crm.nodes.create-task` input addition (a CRM pack change) to
carry `companyId`, so a task this chain creates can be attributed; deferred to keep this
ADR's blast radius inside CSM. `WF-CSM-5`/`-8`/`-11` carried. Re-pointing a merged
`crmRef` at its survivor company is the follow-on to D2.

## D5 — the refusal must FAIL the run, not report success (`CSMCD-1`, Blocker — a defect in D2)

The `/grade-code` pass on this same branch found that **D2 above traded a dishonest
score for a dishonest run status.** D2's refusal path `return`ed the marker row. That
row is truthy, so `surface.setHealth` handed the node a non-null `{account}` and
`healthSet` reported `status:'success'` — a `csm-ops.health-from-crm` run against a
merged company **completed green**, while its declared chain output (`outputs.account`,
documented as "the Account after the write") was a row that had never been rescored.

That is success-with-empty on a durable write path — the exact class the pack's own
docblock calls out two functions above, and the class this repo's AI-exchange
non-negotiables forbid. The pack's other refusal, `refuseToScore`, already had the right
shape: **write the marker first** — the run failing is invisible from the CSM console, so
the durable marker is what actually reaches the operator — **then throw typed.** D2 now
matches it, so the two refusal paths agree instead of contradicting each other.

**Why it survived D2's own review:** both D2 witnesses call the service directly, and
`csm-packs.test.ts` stubs `setHealth` — so **nothing in the repo drove the node against a
real service refusal.** That seam is now witnessed (`csm-feature.test.ts`, "the NODE
fails when the real service refuses"), with a non-vacuity leg proving the same wiring
succeeds while the company is live. Sabotage-proved: restoring the `return` shape reddens
that test and both D2 tests.

Two further defects in D2's own code, both found by the same pass:

- **`CSMCD-2`** — `.catch(() => 'crm-company-gone')` classified *every* failure as "the
  company is gone". `validateCrmRef` is a store round trip, so a storage outage would
  have been recorded on a durable, operator-facing row as a wrong, confident, permanent
  explanation. Narrowed to a genuine `not_found`; anything else propagates.
- **`CSMCD-3`** (pre-existing, adjacent) — `refuseToScore` ran `.catch(() => undefined)`
  on the durable write it exists to guarantee, and never inspected the return, so a null
  account was silently acceptable too. Both halves are now typed failures.

**`CSMCD-13`** — `host/featureSurfaces.ts` carried the *same* false replay claim D3
corrected in the pack, at the seam CSM's surface plugs into. It prescribed the wrong role
for the next feature that writes through a surface, which is how `health-set` came to be
classified like a read in the first place. Corrected in place; the original sentence is
retained so the reasoning trail survives.

## D6 — the surfaces around the refusal (`CSMUX-1/-2/-3/-5`, `-12/-13/-14`)

The `/grade-ux` pass graded the feature **D+**, capped by an accessibility Blocker, and
**three of its four Blockers were states D2 made more common**:

- the measurement-FAILED cell had no *when*, no route to the remedy on the same page, and
  was blank in grid view;
- a merged CRM company rendered as a **live link to a raw opaque id** — the row that just
  refused to score *because the company is gone* linked to that company, which
  `CompanyDetailPage` renders as alive (it has no tombstone handling under any name, and
  `getCompany` does not filter merged rows while `listCompanies` does);
- the refusal reason is untranslated server English carrying an internal token
  (`CSMUX-16`, left open with the fix shape recorded).

A backend fix that is correct in isolation while every surface around it still tells the
old story is not finished. Closed here, along with the a11y Blocker (both editor panels
opened with no focus and no announcement, mounting *above* the trigger).

**`CSMUX-13` is the one to remember.** The health-insights agent's prompt said at-risk is
`< 50` while the console renders `40-69` and the at-risk tile counts `< 70` — and the CTA
that opens that agent sits on that page, beside that facet. So an operator asking "which
accounts are at risk" got a different set than the screen showed. `feature.csm.agents` had
**zero tests**, so nothing could notice. The prompt is now aligned *and test-pinned to the
console in both directions*, deriving the boundaries from the source rather than restating
them — sabotage-proved by moving the console alone.
