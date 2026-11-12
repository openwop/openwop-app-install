# ADR 1023 — Funnels: blueprints the model can read, and step stats that count honestly

Status: implemented — D2 by #5452 (`fix/subchain-children-expand-params`, gated alone by lead decision 2026-11-01); D1 and D3–D9 by the row-72 funnels PR. Follow-ups filed in the row-72 record.

Feature: `funnels` (extends ADR 0294 / 0296 / 0332 / 0948; no new toggle).
Source: the row-72 grade, `docs/steward/workflows-assessment/2026-11-01-funnels-row72.md`
(IDs `FN72WF-*`). RFC verdict: **host work only** — no wire field, event type,
capability or envelope changes. The loader change (D2) alters how this host
expands an RFC 0133 sub-chain child; it does not change the pack format.

## Context

The first unit grade of Funnels found five Blockers. All were re-read by hand
and the loader one was probed through the real `expandChain`.

1. **FN72WF-1.** The four money-step sub-chains feed `copy` from two BARE
   edges (`brief→copy`, `products→copy`). `buildNodeInputs`
   (`executor/scheduler.ts:401-411`) maps a bare edge to port `input`, so the
   second overwrites the first. `buildNodeCtxInputs` unwraps the lone `input`
   and merges the declared `{productId}` on top. `toMessages`
   (`packs/core.openwop.ai/index.mjs:84-97`) then sends the FIRST string-valued
   key as the whole user turn: the model is asked to write a sales page and
   receives `"p1"`.
2. **FN72WF-2.** `funnels.optimize-step` has the same two bare edges; the
   funnel definition never arrives.
3. **FN72WF-3.** `coRegisterSubChains` (`host/workflowChainPackLoader.ts:2073`)
   expands every sub-chain child Path-A with `params: {}`. Path A drops each
   `{{params.x}}` it cannot resolve, so in a gallery (`from-chain`) copy every
   child node loses `orgId`/`briefId`/`formId`, and the child variables the
   loader appends at `:2083-2091` are seeded at dispatch and read by nothing.
   The generate lane works only because `buildChainBackedDefinition` takes the
   deferred path and restores bare names (`chainBackedWorkflows.ts:89-147`).
   This hits every sub-chain chain whose child reads `{{params.x}}`.
4. **FN72WF-10.** `rebuildFunnelStats` counts every funnel-stamped order except
   `canceled` (`funnelStats.ts:120-129`). The public checkout creates a
   `pending` order with `funnelRef` before payment, so abandoned checkouts are
   shown as revenue.
5. **FN72WF-11.** Views are counted only for consented visitors
   (`routes.ts:92`); completions also count unconsented form submissions and
   any `/next?from=` with no view. Conversion can exceed 100%.

Highs in scope: FN72WF-4 (pages drafted and queued for review before the
offers are validated), -5 (`get` / `step-stats` nodes succeed on a missing
funnel), -6 (`get-brief` node drops `orgId`), -12 (per-day distinct visitors
summed into "distinct" totals), -15 (forms sink trusts a forged
funnel/step context), -19 (direct publish can go live with draft pages),
-20 (no stale-write guard on PATCH), -22 (model-facing revenue sums currencies).

## Boundaries audit

- **One AI chat; no new chat surface.** Nothing here adds UI for talking to a
  model; the Funnel Architect stays the agent pack it is.
- **Chains, not hard-coded workflows.** Every change to a workflow is a chain
  pack edit (`examples/workflow-chain-packs/funnels`, version bump) or a node
  pack edit (`packs/feature.funnels.nodes`, `packs/feature.campaign-brief.nodes`).
- **The deferred bare-name restore already exists** in
  `buildChainBackedDefinition`. D2 extracts it to one helper and calls it from
  both lanes; it does not write a second one.
- **Stats single owner:** `funnelStats.ts` stays the one rollup; the route,
  agent tool and workflow surface keep reading its day rows.
- **Forms sink seam:** the fix stays inside the funnels sink; forms is not
  changed (ADR 0330/0332).
- **Publish lane:** `assertFunnelPublishable` / `unpublishedStepPages` already
  exist (`funnelsService.ts:704-760`); D7 calls them from the direct route.

## Decision

**D1 — Blueprint copy reads a typed context, not a bare-edge race (FN72WF-1, -2, -5, -6).**
- New node `feature.funnels.nodes.offer-context` (role `action`, pure read):
  inputs `brief` (port), `products` (port), `productId` (declared). It returns
  `{context: {brief, product}}`, where `product` is the ONE catalog row whose id
  equals `productId`. A missing brief or product is a typed failure
  (`brief_not_found` / `offer_not_found`), never an empty success.
- Each money-step sub-chain becomes `brief.brief → context.brief`,
  `products.products → context.products`, `context.context → copy.context`.
  `copy` then has one non-`input` port and no declared string input, so
  `toMessages` serializes `{context:{…}}` as one JSON user turn. The system
  prompt names `context.brief` and `context.product`.
- `optimize-step`: ported edges `funnel.funnel → propose.funnel` and
  `stats → propose.stats` (the whole outputs map).
- `get` and `step-stats` fail typed `not_found` for an unknown funnel,
  matching `set-steps` and the chat tools.
- `get-brief` passes `orgId` through to `getBrief` (the surface already
  compares it; the node dropped it).
- Witness: the tripwire and lead-magnet e2e tests assert the recorded AI
  call's messages carry the brief name and the product title; a new test runs
  `optimize-step` and asserts the funnel's step names reach the model.

> **Correction (architect round 1, B1 + M3).** The first draft passed the raw
> brief and product rows. `get-brief` returns the whole `CampaignBrief`
> (including `kernelReview.runId`, `createdBy`, `budget`, `utm`, timestamps) and
> `list-products` returns rows carrying `cost`, `downloadAssetTokens`,
> `inventory` and `updatedAt`. That would put a run id in model text (ADR 1002)
> and margin data and download tokens in a prompt, and `inventory` drifts
> between a run and its replay. So `offer-context` returns two CLOSED
> projections, never a raw row:
> - brief: `name`, `objective`, `productName`, `productDescription`,
>   `industryVertical`, `competitors`, `messaging`, and the kernel's content;
> - product: `name`, `description`, `type`, `categories`, `tags`,
>   `attributes`. No price, cost, stock, token or timestamp.
>
> `productId` is optional, so the opt-in and thank-you sub-chains route their
> brief through the same node (their bare `brief→copy` edge sends the raw row
> today). The checkout context also carries the bump product (`bumpProductId`,
> optional). A test asserts the recorded messages contain none of the excluded
> keys.

**D2 — A sub-chain child expands deferred with bare parameter names (FN72WF-3).**
- `coRegisterSubChains` expands each child with `deferred: true`, then applies
  the extracted `restoreBareParamNames(def, chain)` helper (the code now at
  `chainBackedWorkflows.ts:97-147`, moved, not copied). Child node inputs then
  read `{type:'variable', variableName:'<param>'}`, which is exactly where
  `core.subWorkflow` seeds the dispatch-mapped values.
- The `childInputVars` append stays, deduped as now, so a child param that
  only an `inputMapping` reads is still declared.
- A restored variable keeps the required flag the helper sets. Dispatch
  always seeds mapped params, so a child run started by its parent is not
  refused; a child run started by hand prompts for them, which is correct.
- Replay: expansion stays pure (`expansionId` hash of chainId + version +
  params; `params` is `{}` for a child, so the child id and node ids are
  unchanged). Existing tenant child copies are NOT re-expanded; they were
  unrunnable before, and re-instantiating the template produces a working one.
- Witness: a from-chain copy of `funnels.blueprint.lead-magnet` runs to
  `completed` through the real loader and executor, and its pages carry the
  requested org.

> **Correction (architect round 1, H1, H2, M4, M5).** Three claims above were
> wrong or loose:
> - "Existing tenant child copies are NOT re-expanded" is false.
>   `commitSubChainChild` refreshes a PRISTINE child in place on
>   re-instantiation (`chainInstantiation.ts:60-110`). That is acceptable here:
>   the child it replaces could not run, so no earlier parent run completed
>   against it. An edited child is never touched.
> - The blast radius is every sub-chain chain, not only funnels: 12 children
>   under 6 parents. The kicktodo `lesson-batch` child reads 11 params,
>   including `credentialRef` and `imageCredentialRef` (BYOK reference
>   strings, not secrets); in gallery copies they are dropped today and become
>   live. Witness: a repo-wide test expands every loaded parent through
>   `coRegisterSubChains` and asserts no child node keeps an unresolved
>   declared param.
> - The restore helper renames `variables[]`, node inputs and
>   `deferredParameterAliases` only. Deferred mode can also mint prompt
>   templates with prefixed slots (`liftPromptBody`) and emit `defaultValue`
>   for a param with a default. No child has a prompt-body param today; the
>   helper REFUSES a child that would mint one (typed
>   `sub_chain_prompt_param_unsupported`) rather than ship an empty slot. A
>   child variable keeps `defaultValue` only from the PACK's declared default
>   (`params` is `{}` for a child, so no person's value can reach it — the SR-1
>   concern pinned at `workflow-chain-composition.test.ts:158` is about the
>   latter); Path A froze that same default into the node, and a mapped value
>   still wins (`seedRunVariables` prefers inputs). A child with an
>   `x-openwop-sensitive` param is likewise refused, since deferred mode drops
>   it from the expansion hash.
> - Child runs are not refused for a missing required variable because the
>   runtime never checks `required` (`variablesRuntime.ts:157`), not because
>   dispatch seeds it.
> - The funnels chains whose content changes bump their versions; other
>   packs keep theirs (same child ids; pristine copies refresh).

**D3 — Closed-world offers before any page is drafted (FN72WF-4).**
`generateFunnelFromBlueprint` checks every `*ProductId` parameter against the
org's ACTIVE catalog (`getProduct`) before it claims the ignition key, refusing
typed `offer_not_found` (404). D1's `offer-context` repeats the check inside the
gallery lane, where generate is not on the path, so a bad id fails at the first
money step before that step drafts its page.

> **Correction (architect round 1, B2).** Two premises were false. The tripwire
> runs its steps in order, so a bad `downsellProductId` still drafted three
> pages before `offer-context` saw it; and `getProduct` does not filter
> inactive products (the only active rule is in `coerceOffer`,
> `funnelsService.ts:342-345`). So: extract `assertOfferProducts` from
> `coerceOffer` (ONE rule) and call it from generate; add a parent-level
> `feature.funnels.nodes.check-offers` node as the tripwire's FIRST node, before
> any sub-chain, which calls the same rule through the surface; absent
> optional ids (`bumpProductId`) are skipped.

**D4 — Revenue is money received (FN72WF-10).**
Only orders in `paid`, `fulfilled`, `refunding` or `partially_refunded` count,
net of `refundedAmount`; `pending`, `canceled` and `refunded` never do. The
order count follows the same rule.

> **Correction (architect round 1, H4).** A demo checkout leaves its order
> `pending` (`commerce/routes.ts` demo branch), so a tenant with no Stripe key
> now shows 0 orders and no revenue. That is the honest number: no money moved.
> `funnels-phase3.test.ts:118`, which counted a pending order, changes with it.

**D5 — Visitor-cohort step stats (FN72WF-11, -12).**
- The rollup reads events OLDEST-first and dedupes per (type, funnel, step,
  visitor) across the whole read window, not per day.
- A view is attributed to the day of the visitor's FIRST view of that step.
- A completion counts only for a visitor with a view of that step, and is
  attributed to that view's day (a cohort). So for any set of days,
  completions ≤ views for every step, and the summed totals are distinct.
- A completion with no consented visitor or no view (an unconsented form
  submission, a `/next` without a view) is counted once per submission or
  event in a new `unattributed` field on the day it happened. It is never part
  of `conversion`; the detail page shows it as a separate, labelled count.
- The FE "conversions" day sums are relabelled as step completions (UX
  phase).

> **Correction (architect round 1, H3).** Precisely: take the newest
> `EVENT_WINDOW` events (as now), then process them in TWO passes so
> attribution never depends on order or equal timestamps — pass 1 records each
> visitor's earliest view per (funnel, step); pass 2 counts completions. A
> completion whose view aged out of the window becomes `unattributed`, and the
> route's existing `eventWindow` disclosure covers it. `unattributed` dedupes
> per visitor when one exists, per `submissionId` for an unconsented form
> submit, else per event. `stepExperimentUnits` and the experiment rollups,
> which read the same events, are unchanged.

**D6 — The forms sink attributes only a form that is on the step (FN72WF-15).**
The sink requires the funnel to be `published`, and the submitted form to be
the step's bound form (`application.formId`, the webinar's registration form)
or to appear as a `form` section in the step's served page (holdout or a
running variant). Anything else is ignored, logged, and never fails the capture
(seam contract).

> **Correction (architect round 1, B3).** Scanning `page.sections` would drop
> real opt-ins: a form section can be a shared-section reference with an empty
> `data` (`cmsService.ts:1103-1109`), and delivery substitutes a running CMS
> page experiment's sections (`cmsService.ts:2650-2672`). The check uses what
> delivery serves: `resolveSharedRefs` over `deliverableSectionsForPage`
> (the `contentApproval.ts:528` precedent), unioned over the holdout page and
> every running funnel-variant page (an unconsented submitter has no served
> variant to check against). The webinar's form is `MarketingEvent.formId`. A
> test covers a form inside a shared section.

**D7 — The direct publish refuses a funnel whose step pages are not published
(FN72WF-19).** `POST …/publish` calls `publishFunnel(…, {requirePublishedPages: true})`,
the same rule as the approval lane, so a human cannot publish a dark funnel.

> **Correction (architect round 1, H5).** The flag moves the route onto the
> `swapStored` branch, whose 409 says "Request publishing again"
> (`stale_review`) — wrong copy for a direct publish; the direct path gets its
> own conflict message. The environments promote
> (`publishPointersDomain.ts:73`) is a snapshot apply that orders nothing and
> stays as is (filed with FN72WF-23). The open `funnel-publish` review a
> direct publish leaves behind is the FN72WF-23 follow-up, not this phase.
> `funnels-phase1.test.ts:105` publishes draft pages through the route and is
> updated to publish them first.

**D8 — A stale tab cannot overwrite newer steps (FN72WF-20).**
PATCH accepts `expectedUpdatedAt`; when present and different from the stored
row's `updatedAt`, it refuses `409 funnel_changed`. The detail page sends it
and, on 409, reloads and tells the user. Absent (old clients, agent tools), the
current behaviour stands.

> **Correction (architect round 1, M1).** The comparison lives in
> `updateFunnel` against the row it already read, inside the CAS, not in the
> route (a route check races the write). Two writes in the same millisecond
> share an `updatedAt`; that residue is accepted and stated.

**D9 — Model-facing revenue keeps its currency (FN72WF-22).** The
`step-stats` tool and surface return `revenueByCurrency`, and `revenue` is
`null` when more than one currency is present (architect M2: a cross-currency
sum beside the split would keep the defect in model text).

## Alternatives weighed

- **D1: fix `toMessages` in `core.openwop.ai`** to serialize all inputs when
  more than one key exists. Rejected: it changes every chain's prompt bytes
  (prompt caching, ADR 1002 replay digests) to fix one pack's wiring.
- **D1: nest `productId` under an object.** Rejected: deferred mode binds only
  WHOLE-value tokens (`materializeInputs`, `workflowChainPackLoader.ts:1495`);
  a nested token freezes to `undefined` in the generate lane.
- **D2: freeze the parent's values into the child.** Rejected: a child is
  shared by every run of the parent; its values arrive per run.
- **D5: clamp the rate at 100%.** Rejected: it hides the mixed populations
  instead of separating them.
- **D6: require a server-signed visitor token on `/next` and sink submissions
  (FN72WF-14).** Right, but it is a protocol between the viewer, forms and
  funnels; filed as a follow-up.

## Phases

| Phase | Scope |
|---|---|
| P1 (this PR) | D1–D9 backend + packs + witnesses; FE: `unattributed` count, `expectedUpdatedAt`, relabel; grade-ux fixes |
| Follow-ups | FN72WF-7, -8, -9, -13, -14, -16, -17, -18, -21, -23 (filed in the steward record) |

## Matrix

1. Feature package: changes stay in `features/funnels/` plus the loader (D2)
   and two node packs. 2. Toggle: `funnels`, unchanged. 3. `ctx.features.funnels`:
   `stepStats` gains `revenueByCurrency` and `unattributed` (additive).
   4. Node pack: `feature.funnels.nodes` minor bump (new `offer-context`,
   `get`/`step-stats` typed failures, `check-offers`); `feature.campaign-brief.nodes` patch bump.
   5. Envelopes: none. 6. Agent pack: prompt text unchanged except where it
   names inputs. 7. Public surface: D6 narrows what the anonymous sink counts.
   8. RBAC: unchanged (D7/D8 are `workspace:write` routes). 9. Replay: D1 adds a
   read node (`action`); D2 keeps expansion pure; no run-scoped id enters model
   text. 10. Frontend: detail page only; strings in the lazy `funnels` namespace.

## Corrections from the grade round (grade-code / grade-ux, after implementation)

> **Correction (grade-code FN72CD-1) — D2 covered INPUTS only.** Deferred mode
> binds whole-value `{{params.x}}` tokens in `inputs`; a token in node `config`
> still freezes from `resolvedParams`, which is `{}` for a child. The funnel step
> chains' `provider`/`model` were exactly that, and they never reached the copy
> model in ANY lane (the generate lane's same-id children froze them too). They
> are removed from all eight blueprint and step chains (the run's AI default
> applies, ADR 0903), and a repo-wide test refuses any sub-chain child that reads
> a param through config. "No child node keeps an unresolved declared param" is
> now true for inputs and config.
>
> **Correction (grade-code FN72CD-2) — D1's closed-projection rule was broken by
> my own optimize-step edge.** `funnel.funnel → propose.funnel` handed the model
> the funnel ROW (experiment salt, promotion receipts, timestamps). The `get` node
> now takes `view: 'model'` and returns a closed projection (name, status, steps
> with kind, name, routing, whether it sells, experiment status).
>
> **Behaviour change (lead, after the grade round).** A caller that passes
> `provider`/`model` to `funnels.generate` for a blueprint now gets 400
> `invalid_params` (the blueprint schema is closed), where before they were
> accepted and silently ignored; the gallery's run form no longer offers them.
> The run's AI choice (ADR 0903) is what every blueprint step uses, as it already
> was in effect.
>
> **Note (lead).** `funnelForModel` reduces a step's offer to `sells: true`. A
> future product-aware optimize prompt needs a safe product NAME projection (the
> `offer-context` one), never the offer's product ids.
>
> **Note (FN72CD-10).** `asChild` refuses a child that DECLARES a sensitive param,
> even one it never reads. That is broader than Path A (which refused only a used
> one) and is kept on purpose: deferred mode drops sensitive params from the
> expansion hash, so admitting one would change a child's id on replay. No shipped
> child declares one.
>
> **D5 consequence stated (FN72CD-3).** Completions are credited to the day each
> visitor FIRST viewed the step, so recent days under-read and past days grow as
> late completions arrive. The daily tile says so ("by first-view day").

## Implementation record

| Phase | PR / branch | Witness |
|---|---|---|
| D2 loader (+ FN72CD-1's config rule, FN72CD-6's alias merge) | #5452 `fix/subchain-children-expand-params` | `subchain-children-expand-params.test.ts` (every loaded child; a NON-funnel kicktodo `lesson-batch` witness red on main) |
| D1, D3–D9 (+ the grade rounds) | row-72 funnels PR (`fl2-72-funnels`) | `adr1023-funnels-honesty`, `adr0948-tripwire`, `adr0948-p2-lead-magnet`, `forms-funnel-attribution`, `funnels-packs`, `funnels-phase1/3`, FE `adr1023DetailHonesty`, `funnelsErrors`, `funnelMoneySteps` — every guard sabotage-witnessed red (the test headers name each one) |

**Replay / fork of runs recorded before D2.** A child's minted workflow id and its
node ids are unchanged: the id hashes `(tenant, chainId, version)` and the node-id
prefix hashes the same resolved params in both modes (the test asserts both). A
pristine child copy refreshes in place on the next instantiation; a run recorded
against the Path-A shape re-resolves by the same id and the same node ids, with
inputs that now bind variables where they used to be empty. Those runs could not
have completed (every child node lacked its inputs), so no completed run's replay
changes. An EDITED child is never refreshed.

## Open questions

- Should a published funnel's step edit go through the approval lane? (ADR 0948
  says the human route is unchanged; left as is.)
- Is an existing tenant's broken child copy worth a migration? Assumed no:
  re-instantiating the template is the fix.
