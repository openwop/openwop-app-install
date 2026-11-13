# ADR 1108 — operator plan exemption downstream lanes

Status: implemented (P1 — chat tool lane, in-run `ctx.features`, the
`startWorkflowRun` launch gate, and sub-workflow children of an operator run;
P1b after review — see §6. Voice and other run-creating routes are §5 follow-ups)

Relates to: ADR 0419 (paid feature bundles, the 2026-10-02 correction "the
superadmin has every feature in any workspace", #4323), ADR 0819 §1 (`resolveOne`
is the access resolver for every lane), ADR 0795 D1 (a key that narrowed itself
does not inherit superadmin), ADR 0627 D3 (the request-stamped `personalTenant`).

## 1. Context — what broke

Observed on app.openwop.dev (build `a1d1dccb7`, 2026-11-11 19:10–19:42Z). The
listed operator (`OPENWOP_SUPERADMIN_TENANTS`, person-level through their
personal tenant) made a new workspace on the `free` plan, with plan narrowing on.

- The Campaign Brief and Campaign Studio **HTTP routes** answered 200.
  `toggleSubjectOf(req)` sets `planExempt` from `isListedSuperadmin(req)`, and
  `GET billing/entitlements` returned `allowedFeatures: "*"`.
- In **chat**, the Campaign Brief Strategist's `campaign-brief.get-brief`,
  `.validate` and `.generate-kernel`, and the Campaign Strategist's
  `campaign-orchestration.run`, all returned `feature_disabled`.
- A **builder run** of the Messaging-kernel chain was admitted by the run-start
  gate (`launchSubjectOf` carries `planExempt`), then failed in 453 ms at
  `generate_kernel` with `host_capability_disabled: feature 'campaign-brief' is
  not enabled for this tenant — ctx.features.campaign-brief is unavailable`.

Mechanism, the same in every case: the downstream lanes have no request.
Each built its subject as `{ tenantId, userId? }` and called `resolveOne`. With
no `planExempt`, `resolveOne` ran `checkTenantEntitlement` for the workspace's
`free` plan and returned `{ enabled: false, blockedBy: 'plan' }`.
`ToggleSubject.planExempt`'s own doc said it was "set only by
`toggleSubjectOf(req)`", so no req-less lane could ever have it. The
campaign-brief tool's comment claimed it used the "SAME subject shape as the
route gate". That was false.

A second, smaller defect: about 17 `agentTools.ts` files reduced the
resolution to a boolean. A plan refusal therefore reached the model as
`feature_disabled` ("not enabled for this workspace"), and the agent told the
user to turn on a toggle that was already on. The shared kit
(`host/agentToolKit.ts`) already had the right vocabulary (`featureUnavailable`
→ `not_entitled` / `feature_unavailable` / `feature_disabled`), but these files
had re-declared their own resolver instead of using it.

Confirmed before the fix by `test/tool-lane-operator-plan-exempt.test.ts`: red
with `feature_disabled` for the operator in the free workspace, and green for a
customer in an entitled workspace. So the plan was the cause, not the toggle.

## 2. Decision

**D1 — decide once at the creating request; stamp a reserved key.** The
exemption can only be decided where `isListedSuperadmin(req)` can run. That
check is the one that sees whether an API key narrowed itself (ADR 0795 D1).
`POST /runs` stamps `run.metadata.planExempt = true` from `planExemptStampOf(req)`.
`planExempt` joins `RESERVED_RUN_METADATA_KEYS`, so a client-supplied value is
stripped. On `:fork` the stamp is re-decided for the **forking** caller, the
same confused-deputy rule as `actingUserId` and `personalTenant`.

**D2 — re-check at use, fail closed.** `operatorPlanExempt(scope)`
(`host/operatorPlanExemption.ts`) honours the stamp only when all of these hold:

- the stamp is `true`;
- the run's tenant is still listed, or the person's own personal tenant is still
  listed (shape-guarded with `isPersonalTenantId`, USERS-19).

So de-listing an operator ends the exemption for runs already in flight, and the
stamp alone grants nothing.

> **CORRECTED in P1b.** P1 also required an `actingUserId` on the run. To let a
> sub-workflow child (no actor) keep its parent's exemption, the first P1b draft
> accepted the child's `orgScopeSubject` as "the person". The ADR 0832 ratchet
> (`adr0832-org-scope-subject.test.ts`, "never a grant") rejected that:
> `orgScopeSubject` narrows and must never feed a grant.
>
> The person check is now the stamp's **provenance**. Only these write it:
> - a request from the listed person (`POST /runs`, `:fork`);
> - a tool acting for that person (`startWorkflowRun`'s explicit parameter,
>   which the D5 tools pass only when there is an acting user);
> - the dispatcher, copying from a parent whose own exemption held (D7).
>
> The key is reserved, so no client or caller metadata can supply it.

**D3 — one subject builder for req-less lanes.** `scopeToggleSubject(scope)`
returns the route's `{ tenantId, userId? }` plus `planExempt` when D2 holds. Two
places use it:

- the chat tool kit, `resolveFeatureAccess` / `resolveFeatureToggle`;
- the in-run seam gate, `featureSurfaces.gate`.

The executor and the chat loop thread the stamp from `run.metadata` onto
`BundleScope.planExempt`, through the one scope composer
`createScopedAgentToolProvider`.

**D4 — chat tools resolve through the kit.** Every `features/**/agentTools.ts`
that called `resolveOne` itself now calls the kit. A ratchet in the test file
fails if any `agentTools.ts` calls `resolveOne` directly.

**D5 — a tool that starts a run forwards what it holds.**
`forwardedPlanExemption(scope)` passes `planExempt` (only while D2 holds) and
`personalTenant` to `startWorkflowRun`. Without it, `campaign-brief.generate-kernel`
and `.research.run`, and `campaign-orchestration.run`, would start a run that
fails at its first `ctx.features` call. `startWorkflowRun` stamps the key after
its reserved-key strip, and (P1b) passes `{ planExempt: true }` to its own
launch gate (`resolveLaunchWorkflow`) while D2 holds. With no stamp the subject
stays `{}`, so every other starter caller is unchanged.

**D8 (P1b, second review) — the chat loop spends the exemption only on the
operator's own turns.** In a shared conversation, tools run as the run's acting
principal whoever posted (ADR 0834 D3). The exemption is borrowed authority, the
same as a `bypass`. So `conversationToolLoop` puts `planExempt` on the tool scope
only when `toolAuthorityHolds(callerPrincipal, actingUserId)` and the turn is
not a channel-ingress turn. Without this, a customer posting into the operator's
conversation in the customer's free workspace could call paywalled tools,
including `campaign-orchestration.run`, which starts further stamped runs. That
breaks priced ⟹ gated.

The operator's own turns supply `callerPrincipal` from
`routes/interrupts.ts` (`req.userId ?? principalId`). That is the same
derivation the `bypass` check depends on.

**Resume by a different approver keeps the exemption (accepted).** An
operator-stamped run that pauses at a HITL gate and is resumed by someone else
(`:resume`, an approval) keeps its stamp. This is acceptable: the resume
continues the operator's own definition with no new tool intent. A
conversation turn is different, because it carries new intent from whoever
posts it, which D8 governs.

**D7 (P1b) — sub-workflow children of an operator run.** Review found
`campaign-orchestration.run` still refused for the operator after P1. Two gates
checked the five channel children (owned by `campaign-channels`, a paid bundle)
with an empty subject:

- the tool's advisory pre-check, `firstChildRefusal`;
- the dispatcher, `subWorkflowDispatcher.ts`, which refused with
  `subworkflow_feature_refused`.

On top of that, a child carries no actor, so D2's person rule refused its
`ctx.features`. Now:

- the pre-check uses `launchPlanExemptSubject(scope)`;
- the dispatcher computes `childPlanExemptionStamp` from the **parent row**. It
  passes `{ planExempt: true }` to the child's launch gate and stamps the child,
  but only while the parent's own exemption holds. The stamp is `planExempt` plus
  the operator's personal tenant under a separate, reserved, **non-granting** key,
  `planExemptPersonalTenant`, which only the re-check reads.

  > **CORRECTED (second review).** The first P1b draft copied the parent's
  > `personalTenant` onto the child. That key is authority-bearing:
  > `assertTenantScope` / `assertOrgScope` admit the implicit personal-tenant
  > owner before the no-subject check. So an actorless child in the operator's
  > personal tenant would have passed `workspace:write`, a new grant and the
  > ADR 0627 confused deputy. The child never gets `personalTenant`. A non-operator, scheduled or triggered parent
  has no stamp, so its children get none and are launched exactly as before.

**D6 — name a plan refusal as one.** `campaign-brief` and
`campaign-orchestration.run` return `featureUnavailable(...)`, which gives
`not_entitled` for `blockedBy:'plan'` and `feature_unavailable` for
`'unresolved'`. A toggle that is off keeps its `feature_disabled` text.

## 3. Who never inherits it

- **Scheduled, triggered, heartbeat and channel runs.** No request creates them,
  so nothing stamps them. `startWorkflowRun` callers other than the D5 tools
  never pass it.
- **A run started by anyone who is not listed.** It gets no stamp, and a forged
  stamp is stripped.
- **A narrowing API key.** `isListedSuperadmin` refuses it at stamp time.
- **Sub-workflow children of any parent without a holding exemption.** D7
  copies the stamp only from a parent row whose own exemption holds. The key is
  not registered with `inheritedRunMetadata`, so no other path copies it.

> **Correction (2026-11-12, CC-AUTH-5 — lead grading/routing; CC-LEAD-1 — a refusal
> must release).** Live on `373d4863a` the operator's lead grade answered 403 "…belongs
> to the crm feature, which is not included in this workspace's plan."
> (`crm-ops.grade-lead`): `startReservedLeadDispatch` started the run with only
> `orgScopeSubject`. The lead routes now pass `planExemptStampOf(req)`. A timer-started
> reroute child acts for nobody, so it inherits neither the parent's `personalTenant`
> nor an exemption (§3 / D7; an earlier draft forwarded both and was caught in review).
> The refusal also locked the lead for good (qualify/route 409): the pending
> grade is stamped before the start and retained on any throw, because an insert fault
> is ambiguous. A run-start refusal is not (it is decided before any insert), so it
> now releases the reservation; an insert fault still retains it. Test:
> `test/cc-auth-5-lead-dispatch-refusal.test.ts`.

## 4. Alternatives weighed

- **Re-derive from `personalTenant` alone at tool time.** Rejected. It cannot
  see an API key's declared scopes, so a narrowing key minted in the operator's
  personal tenant would inherit the exemption (ADR 0795 D1).
- **An AsyncLocalStorage "this turn is exempt" context read by `resolveOne`.**
  Rejected. It is implicit authority that reaches any `resolveOne` in the call
  tree, including reads for another tenant. An explicit scope field can be
  reviewed.
- **Patch each of ~17 feature helpers to add `planExempt`.** Rejected in favour
  of D4. Those helpers were re-declarations of the kit, which is how they had
  drifted in the first place.

## 5. Not done here (follow-ups)
> **Correction (2026-11-12, CC-CHAN-1 — six tool launchers never forwarded the
> exemption).** Live on `373d4863a` the Channel Generator's
> `openwop:campaign-channels.generate` was refused on every call (5×, the turn
> ended `tool_rounds_exhausted`); Cloud Run logged `workflow_launch_refused_feature
> {blockedBy:'plan', featureId:'campaign-channels'}`. The tool passed its own gate
> and then `startWorkflowRun` refused the run, because it was started without
> `forwardedPlanExemption(scope)` — P1 had added it only to the campaign-brief and
> campaign-orchestration tools. Added to every chat-tool launcher that starts a
> run for the acting person: campaign-channels, podcasts, production,
> destination-sync, notebooks and `workflow.compose`. The generate tool's own gate
> now words a plan refusal as `not_entitled` (it said "turned off"). Alongside, the
> chat tool loop records a named reason on every refusal it makes
> (`not_on_allowlist`, `not_in_conversation_scope`, `approval_required`,
> `agent_guardrail_denied`, `capability_firewall_denied`, …) and answers a repeat
> of a refused tool from the refusal instead of re-running it (a plan/feature
> refusal for the whole tool, any other `forbidden` for identical arguments).
> Tests: `test/cc-chan-1-channel-generate-plan-exempt.test.ts`,
> `test/cc-chan-1-repeated-refusal.test.ts`.


- **Surface-internal access reads.** A feature surface reads another feature's
  toggle after the seam gate. Fixed here, on the live paths:
  `campaign-brief/surface.ts` (`campaign-intel` for UTM lint) and
  `campaign-orchestration/surface.ts` (linked features), both via
  `tenantToggleSubject(scope)`. Still tenant-only, and so still paywalled for the
  operator in a non-entitled workspace:
  - `campaign-intel/surface.ts` (`CAPS_TOGGLE_ID` ×2, `MULTI_TOUCH_TOGGLE`);
  - `campaign-connectors/surface.ts` (`campaign-connectors` ×2,
    `SCHEDULED_CONVERSIONS_TOGGLE`);
  - `campaign-journeys/surface.ts` (`experiments`);
  - `crm/surface.ts` (`crm` + `LEAD_INTEL_TOGGLE`, three sites);
  - `campaign-ops/surface.ts`, `commerce/surface.ts`, `experiments/surface.ts`,
    `creative-video/surface.ts`, `app-builder/surface.ts`, `cms/surface.ts`.

  The `agentTools.ts` ratchet does **not** cover `surface.ts`. These sites are
  excluded on purpose and listed here, and each one is a one-line move to
  `tenantToggleSubject(scope)`.

- **Realtime voice** (`features/voice/realtime/routes.ts` →
  `issueRealtimeSession` / sideband session → `toolBridge`) builds its tool scope
  from a mint-time session, not a run. It still lacks the stamp. The fix is the
  same: stamp `planExemptStampOf(req)` at mint and thread it into
  `createScopedAgentToolProvider`.
- **Other run-creating routes** besides `POST /runs` and `:fork`. These include
  workflow-author drafts, debug and redrive, eval runs, and the feature routes that
  call `startWorkflowRun`. They do not stamp yet, so an operator run started there
  is still paywalled in a non-entitled workspace. The rule for each is the same
  one line.
- **Tools that start runs other than the three in D5.** These lose the exemption
  on the started run.
- **The boolean helpers in the other ~14 `agentTools.ts` files** now honour the
  exemption, but they still report a plan refusal as `feature_disabled`. Moving
  each one to `featureUnavailable` changes model-facing copy, so it is per-feature
  work.
- **`canvasScope`** (executor) and `disabledFeatureSurfacesFor`, the authoring
  catalog's preview, do not carry the stamp.

### Operational notes

- **`personalTenant` is now forwarded on every tool-started run** from
  `campaign-brief` and `campaign-orchestration`, customers included. Before, those
  runs had none. It is the same request-stamped value the tool's own scope
  already carried (ADR 0627 D3), and it grants only the implicit owner of that
  personal tenant.
- **A child's operator record is `metadata.planExemptPersonalTenant`**
  (reserved). It is never `personalTenant`.
- **Conversations and runs created before deploy have no stamp.** An operator
  seeing the old refusal in an existing chat should start a new conversation
  (or a new run).
- **The stamp is visible on raw run rows** (`metadata.planExempt`). It is
  host-written and records only that the listed operator created the run.

## 6. Implementation record
> **Correction (2026-11-12, CC-AUTH-4 — the campaign autopilot launch lane).** Live on
> `373d4863a` the listed operator's autopilot launch answered 201 ("The autopilot is
> running…") and run `e63186aa` (`campaign-studio.autopilot`) failed at once: `forbidden`,
> "…belongs to the campaign-orchestration feature, which is not included in this
> workspace's plan." The launch route never stamped the exemption on the spine, and
> `startStageRun` started the drafting stage (a campaign-orchestration workflow) without
> `forwardedPlanExemption`. The route now passes `planExemptStampOf(req)` + the personal
> tenant to `launchAutopilot`, which stamps the spine; the stage forwards it. A customer
> in a free workspace is still refused up front by `requireAutopilot`'s entitlement check.
> Follow-up: the Autopilot section still says "running" without showing a failed run.
> Test: `test/cc-auth-4-autopilot-operator-plan-exempt.test.ts`.


| Phase | What | Evidence |
|---|---|---|
| P1 | D1–D6 for chat tools, in-run `ctx.features` and `POST /runs` / `:fork` | `test/tool-lane-operator-plan-exempt.test.ts`: red before the fix (operator `feature_disabled`, customer `feature_disabled` instead of `not_entitled`), green after; witness by reverting `src/` |
| P1b-2 | Second review: D8 (chat loop gated on `toolAuthorityHolds`, no channel turns), D7 child key moved off `personalTenant`, de-listed-parent control, dead `actingUserId` pass dropped | `tool-lane-operator-plan-exempt-chat-loop.test.ts` (participant / no-caller / channel turns `not_entitled`, owner passes) + child-gate cases; witness by reverting `src/` |
| P1b | Review fixes: D5 launch gate, D7 child gate + dispatcher, two surface reads; tests for a real brief past the child gate, the person-level stamp (operator in a non-listed workspace), the fork control, a real run from `run.metadata` through the executor to `ctx.features`, and dispatcher children | `tool-lane-operator-plan-exempt.test.ts` + `tool-lane-operator-plan-exempt-child-gate.test.ts`; witness by reverting `src/` |

> **Correction (2026-11-12, CC-AUTH-3 — the client-report section sources were a
> lane P1 did not reach).** Observed live on build `373d4863a`: the listed
> operator, in a free-plan workspace, got `409 report_source_unavailable` from
> "Compute report", and the `campaign-ops-reporting.client-report` chain failed
> the same way in 387 ms. `requireReportSource(featureId, tenantId)`
> (`features/campaign-ops/reports/sectionSources.ts`) resolved access with no
> subject, so `planExempt` never reached `resolveOne`. Fixed the same way as §2:
> the HTTP routes pass `launchSubjectOf(req)` (compute, and the definition parse
> that checks named campaigns), the run lane passes `scopeToggleSubject(scope)`
> minus the tenant, and `POST …/report-definitions/:id/runs` forwards
> `planExemptStampOf(req)` to `startClientReportRun` like `POST /runs`. A plan
> refusal is now a 403 `not_entitled` in plan words ("…is not included in this
> workspace's plan."); toggle-off and unresolved stay the 409. The change-request
> and execution launchers do not forward the stamp yet (§5 follow-up; their nodes
> resolve through `ctx.features`, whose gate already reads the stamp when present).
> Test: `test/cc-auth-3-report-source-operator-plan-exempt.test.ts` (red on
> `373d4863a`: the operator compute 409 reproduced the live failure).
