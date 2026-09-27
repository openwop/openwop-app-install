# ADR 0677 — A declared approver ACL that is never read, and a mailbox writer outside the replay guard

Status: **implemented** (verified 2026-09-17, #3807)
Date: 2026-09-14
Feature loop 2026-09, iteration 27 (Insights & Drafting, `FEATURES.md:604`)
Gap ids: `ISWF-20` (new), `ISWF-21` (new), `ISWF-6` / `-9` / `-14` / `ISC-9` / `ISU-4` (re-verified), `GEN-APPROVENOTIFY-1` (re-scoped)

## Context

The it.27 re-pass verified the ADR 0599/0600 closeout and then looked at the residuals
those PRs named. Two of them resolve into shippable Blockers; the rest are re-verified
with sharper mechanisms and dispositioned.

Everything below was measured at `1275e4d41`.

## D1 (Blocker, `ISWF-20`) — `approverRefs` is silently inert unless `requiredApprovals > 1`

`routes/interrupts.ts:727-728` (the `data` destructure is `:726`):
```ts
const requiredApprovals = typeof data.requiredApprovals === 'number' && data.requiredApprovals > 1 ? data.requiredApprovals : 0;
if (requiredApprovals === 0) return undefined; // not a quorum gate — no eligibility gate
```
The function returns **before `approverRefs` is ever read**. So a gate that declares an
explicit approver ACL but does not also declare `requiredApprovals > 1` is an OPEN gate:
any authenticated tenant member may satisfy it.

**MEASURED: two ACL-declaring nodes in the 60 chain packs, zero in `packs/`. This is a
FLOOR, not the population** — `core.interrupt` forwards `config.data` **verbatim**
(`bootstrap/nodes.ts:1011`) and the builder palette exposes `approverRefs` /
`approverGroupRefs` / `approverRoleRefs` as first-class config fields on `core.approvalGate`
(`frontend/react/src/builder/palette/nodeCatalog.ts:284-300`), so tenant-owned builder
workflows can carry an ACL no corpus scan can see.

| pack | chain | node | **typeId** | `requiredApprovals` | ACL |
|---|---|---|---|---|---|
| `approvals` | `approvals.two-stage-sign-off` | `stageOne` | **`core.chat.approvalGate`** | absent | `approverRefs` |
| `approvals` | `approvals.two-stage-sign-off` | `stageTwo` | **`core.chat.approvalGate`** | absent | `approverRefs` |

> **CORRECTED by the review — the first draft of this section was wrong twice, and the
> second error made the prescribed fix a NO-OP on the very nodes it cited.**
>
> **(a) The typeId matters and was omitted.** Both nodes are `core.chat.approvalGate`, not
> `core.approvalGate`. Only two writers ever put `approverRefs` on `interrupt.data`:
> `approvalGateNode` (`bootstrap/nodes.ts:943`) and `core.interrupt`'s verbatim forward
> (`:1011`). The chat gate is neither — it is a pack `.mjs` node that destructures only
> `title, artifactType, maxRequestChangesIterations, timeoutMs, actions`
> (`packs/vendor.myndhyve.chat/index.mjs:275-288`) and suspends without forwarding the ACL
> (`:313-323`); `makeSuspendFn` persists `data: { ...payload }` with no config merge
> (`executor/suspendSignal.ts:99`). So `interrupt.data.approverRefs` is **undefined** for
> both nodes, and a route-only fix leaves them open gates. **The originally-filed witness —
> "a born-red test over `approvals.two-stage-sign-off`" — was unbuildable as specified.**
>
> **(b) "Enforces nothing" was rhetoric, not a measurement.** Both approver params default
> to `""` with the description **"blank = any team member"**
> (`examples/workflow-chain-packs/approvals/pack.json:56-57`), chain config freezes
> `{{params.*}}` at expansion (`workflowChainPackLoader.ts:1259-1261`), and `clean()` drops
> empty strings (`host/approverResolution.ts:52`). **The default instantiation is an
> INTENTIONAL open gate the pack documents.** The defect bites the moment an operator
> supplies `stageOneApprover`: the ACL is then accepted, persisted, rendered in the gate
> evidence panel (`frontend/react/src/chat/reviews/GateEvidence.tsx:133-134`) — and enforced
> nowhere.

This is still the ADR 0582 "approval gates that do not gate" family in a new form: there the
effect bypassed the gate; here the gate's own ACL is never consulted.

**The docblock's remediation advice is false as written.** `interrupts.ts:713` tells
authors *"authors who want an ACL set `approverRefs`"* — which does not work unless they
also set `requiredApprovals > 1`, a coupling that is undocumented and unintuitive. The
sentence is the reason the two shipped gates are authored the way they are.

### What this decision must NOT do, and why

**The open-gate behaviour for an EMPTY approver list is spec-mandated and must stay.**
`interrupts.ts:702-713` records it: the `openwop-interrupt-quorum` profile is pure vote
COUNTING; per-subject AUTHORIZATION is the separate `openwop-interrupt-auth-required`
profile. Verified independently: `conformance-fixtures/conformance-interrupt-quorum.json:18`
pins `"approversList": []` with three voters and an API-key caller, and a separate
`conformance-fixtures/conformance-interrupt-auth-required.json` exists for the other
profile. The same docblock states the asymmetry with `host/approvalDecision.ts` is
deliberate — *"keep them that way."*

> **THIS IS AN UNIMPLEMENTED NORMATIVE MUST, NOT A JUDGEMENT CALL — a third conformance
> scenario the first draft never checked.**
> `@openwop/openwop-conformance/src/scenarios/v2-approver-enforced.test.ts:83` pins:
> *"a host advertising `interrupt` MUST refuse a resolver not in approversList with 403
> (RFC 0173 §B — enforcement, not advice)"*. Its fixture `conformance-approval-approvers`
> carries a non-empty `approversList` and **no `requiredApprovals`**, and is resolved by the
> suite's **bearer**. Under today's code that resolve succeeds; the row records
> `softSkip('blocked')` only because no host advertises the fixture. So D1 closes a live
> RFC 0173 §B non-conformance — and because the driver is a bearer, it only closes it if
> the token lane below is fixed too.

**Decision — FOUR parts, because the route-only fix is a no-op:**

1. **Both eligibility lanes.** `assertEligibleApprover` (`routes/interrupts.ts:726-728`) AND
   `assertTokenQuorumVote` (`:782-791`) carry the identical early return, and
   `resolveAndResume` (`:899`) dispatches to exactly one: the first when a bound user
   exists, the second otherwise — where "otherwise" is the API-key/bearer path, the RFC 0093
   signed-token route, the email decide-by-token POST, MCP (`host/mcpSemantics.ts:299`) and
   inbound webhooks (`features/connections/inboundWebhooks.ts:685`). Fixing one lane leaves
   the ACL unconsulted on every token caller. *(This also means the Context sentence "any
   authenticated tenant member may satisfy it" was UNDERSTATED — any bearer principal can.)*
2. **Gate on a NON-EMPTY resolved approver set**, independent of `requiredApprovals`. Empty
   ⇒ open gate, so `conformance-interrupt-quorum` is untouched.
3. **Forward the ACL from the chat gate** (`packs/vendor.myndhyve.chat/index.mjs:313`) so
   `core.chat.approvalGate` — 49 of the corpus's 63 gate instances — can carry one at all.
   **This is a pack change: it needs a version bump + registry republish**, which the
   original §RFC-verdict wrongly said was unnecessary.
4. **The override branch.** Removing the early return makes `:735-742` reachable on
   single-approver gates, where it returns `{countAs}` **without consulting the ACL**, and
   because `quorumResult` is `null` (`:603`) the RFC 0093 §D.2 `approval.overridden` event
   and audit-sink row (`:917-940`) are **never written** — an ACL bypass with no audit
   trail. Either gate the override on `requiredApprovals > 1` or emit the event/audit row on
   the non-quorum path. **Not deciding this would ship a new defect inside the fix.**

**Witness:** a born-red leg on a `core.approvalGate` gate (the lane that can carry an ACL
today) asserting a non-approver is refused; a SECOND born-red leg on the token lane; a leg
asserting an EMPTY-list gate still accepts any authenticated reviewer so the fix cannot
drift into breaking the quorum profile; and a leg on the chat gate once part 3 lands.

## D2 (Blocker, `ISWF-21`) — `core.email.draft` writes to a live mailbox and is outside the replay guard

`bootstrap/nodes.ts:2775` DECLARES `core.email.draft` and `:3460` registers it; the durable
mailbox write is `:2792-2796` through `ctx.connectors` (`:2783` is the capability guard and
`:2805-2810` is output shaping — the first draft cited both as the write, which they are not). **`isSideEffectingNode`
returns false for it:**

- not in `MANIFEST_SIDE_EFFECT_FLOOR` / `MANIFEST_FAST_PATH_SERVED` — those are derived
  from pack manifests and **`core.email.draft` has no manifest anywhere**
  (`grep -rn "core\.email" packs/` → zero hits);
- no `SIDE_EFFECTING_TYPE_PATTERNS` arm covers `core.email.*`;
- `sideEffecting` is not set at the registration site.

Five chain packs bind the typeId (`insights-suite`, `incident-postmortem`,
`seo-content-ops`, `support`, `inbox`).

> **CORRECTED by the review — the severity claim was FALSE, and the correction inverts
> which fork mode matters.** This section originally said a `:fork` or replay "mints a
> second draft in the user's mailbox". It does not.
>
> **A `mode:'replay'` fork THROWS before reaching the mailbox.** `core.email.draft` reaches
> it via `connectors.invoke` (`bootstrap/nodes.ts:2792-2796`) → `brokeredFetch`, whose FIRST
> statement is `assertEffectAllowed('network-egress', …)` (`host/brokeredEgress.ts:186`),
> which throws `ReplayEffectError` while `ctx.replaying` (`host/runEffectContext.ts:222-237`).
> So the node fails with `replay_source_missing` and logs *"ADR 0531: a replay reached an
> unclassified effect seam"* — the ADR 0563 "a backstop firing is a bug report, not a steady
> state" shape. Real, but not duplication.
>
> **And the mode that DOES duplicate is untouched by this fix.** `sourceOutcomes` is
> populated only for `mode:'replay'` (`executor.ts:1565-1573`, gated on
> `replayInvocationsFromRunId`, set at `routes/runs.ts:1725` only when
> `body.mode === 'replay'`), and `isSideEffectingNode` is consulted only under
> `if (input.sourceOutcomes …)` (`executor.ts:1007`). A **`mode:'branch'` fork** sets
> `replaying:false`, walks past the backstop, and re-executes live — and `sideEffecting:true`
> changes nothing about it. **The mode that duplicates is not fixed here; the mode fixed here
> does not duplicate.** That is the it.25 lesson recurring: I measured the mechanism
> correctly and mis-traced the lane that reaches it.
>
> D2 is therefore **demoted from Blocker to a replay-correctness fix** — it converts a
> backstop throw into a served recorded outcome, which is correct and worth doing, but it is
> not a mailbox-duplication hole.

### This is a CLASS, and `core.email.draft` is not its worst member

Every programmatically-registered NodeModule is invisible to the generated sets (they derive
from pack manifests, and none of these has one). Of the 35 registered in `bootstrap/nodes.ts`,
exactly one self-declares (`conformance.effect.emit`, `:3585`). The unclassified durable
writers:

| typeId | write | replay today |
|---|---|---|
| `core.email.draft` (`:2792`) | Gmail/Graph draft | backstop throws |
| `core.email.send` (`:2863`) | **sends real mail** | backstop throws |
| `core.openwop.connectors.ticket-create` (`:3171`) | mints a ticket (has its own content-hash ledger, `:3165`) | backstop throws |
| `…ticket-transition` · `…erp-action` (`:3342`) · `…hris-action` · `…ad-budget-update` (`:3079`) | ERP/HRIS/ad-spend mutations | backstop throws |
| **`local.openwop-app.memory-write`** (`:2234`) | `writeMemoryEntryRedacted` → a fresh durable memory row | **NOTHING fires** |

**`local.openwop-app.memory-write` is the only true duplication in the table** — there is no
`memory-write` member of `EffectKind` (`host/runEffectContext.ts:104-110`), so no seam guards
it and no classification serves it. Filed as `ISWF-22`; **not fixed here**, because adding an
`EffectKind` member is a core-seam change with its own blast radius.

**And `core.email.send` carries a DOCUMENTED refusal of exactly this fix**
(`bootstrap/nodes.ts:2878-2884`): *"`:fork` mints a NEW runId → a fresh key → this ledger does
NOT (and should not) suppress it; a forked run correctly re-hits the mandatory approval
interrupt … not a double-send hole."* Classifying `draft` while its sibling `send` stays
unclassified on a stated rationale is an asymmetry this ADR **adopts deliberately**: `draft`
has no approval interrupt in front of it, `send` does.

**The fix shape differs from ADR 0673/0676 and that is the point.** Those added
`capabilities:["side-effectful"]` to a pack manifest. There is no manifest here. But
`core.email.draft` is **programmatically registered**, which is exactly the case
`sideEffects.ts:97` reserves: *"a pack `.mjs` node cannot self-declare
(`NodeModule.sideEffecting` is reachable only by programmatic registration)"*. Verified
the arm is live: `executor.ts:1007` calls `isSideEffectingNode(nodeRef.typeId, module)` —
the module IS passed.

**Decision:** set `sideEffecting: true` on the `core.email.draft` `NodeModule` (declared
`bootstrap/nodes.ts:2775`, registered `:3460`). Verified this is NOT the allowlist trap that
made the previous iteration's D2 a no-op: `getNodeRegistry().register` stores the module **by
reference** and `resolve`/`get` return that same object (`executor/nodeRegistry.ts:16-41`),
`executor.ts:501` gets it and passes it verbatim at `:1007`, and `sideEffecting` is declared
at `executor/types.ts:901` with **exactly one reader** — `isSideEffectingNode`. No
compensation, cost, dry-run or advertisement consumer. No pack bump, no re-attestation.

**Witness:** a leg asserting `isSideEffectingNode('core.email.draft', mod)` is true,
sabotage-proved by removing the field; plus a leg pinning the class table above so a new
programmatically-registered writer cannot join it silently.

**NOT decided here:** creating the missing manifest. That is `ISU-4`'s root cause and it
also unblocks the required-config gate (`nodeCatalogBuilder.ts:228-238` builds only from
manifest entries, so `requiredConfigKeysFor('core.email.draft')` returns `[]` and the gate
is structurally blind — which is why `test/chain-required-config-census.test.ts:80-96`
carries a hand-maintained table and a three-node quarantine). Authoring a manifest for a
core node changes what the census measures corpus-wide; filed, not smuggled in.

## Re-verified and dispositioned (mechanisms sharpened, not carried)

- **`ISWF-6` — the trigger lane is DEAD, and the filed wording understates it.** It is not
  that `inputs` is null (`triggerIngestionService.ts:583`). It is that the ingest path calls
  `insertRunWithStartContext` + `executeRun` directly (`:597-604`) and **never calls
  `seedRunVariables`** — the only creator of the bag (`variablesRuntime.ts:117-139`) — so
  the bag is never created, not even schema defaults. `{{params.X}}` on a node input
  compiles to a variable-sourced PortValue (`workflowChainPackLoader.ts:1188-1190`), so the
  required `workdayBaseUrl` is unbound and the chain dies at node 1. The covering test
  asserts the ENVELOPE only (`insights-suite-trigger.test.ts:111-130` reads
  `run.metadata.triggerData`, never `run.inputs`). **Deferred with the mechanism recorded:**
    > **SPLIT by the review — the two legs are separable and only one is cross-cutting.**
  > **`ISWF-6a` — TAKE:** `seedRunVariables(runId, wf.definition.variables, {})` at
  > `triggerIngestionService.ts:597` seeds the **declared defaults**
  > (`variablesRuntime.ts:117`; the fallback is documented at
  > `features/insights-suite/metaWorkflows.ts:89`), which revives the dead lane. One line,
  > envelope-independent.
  > **`ISWF-6b` — DEFER:** mapping the trigger envelope into the bag is the RFC 0099
  > cross-cutting decision the prior pass routed to `/architect`. Deferring BOTH on the
  > reason that applies only to the second leaves a shipped, reachable workflow dead for no
  > gain.
- **`ISWF-9`** — `POST /v1/runs` applies auth, run quota and a TENANT-level `run.create`
  verb, but **no feature-toggle gate and no per-workflow ACL** (`routes/runs.ts:160-282`;
  zero `requireFeatureEnabled` hits). `requireProtocolScope` is a no-op unless
  `OPENWOP_AUTHORIZATION_ENFORCEMENT=on` (`protocolAuthorization.ts:102`). So a member can
  start `openwop-app.insights.talent-prep` while `insights-suite` is OFF for the tenant,
  though the config route 404s them. **Filed, not fixed here** — gating run-start on a
  per-workflow feature id is a core-surface policy decision affecting every feature.
- **`ISC-9`** — both halves still open. The shared ingest route enforces **tenant ownership
  only** (`src/routes/triggerBridge.ts:172-175`; no scope check anywhere in the file — note a distinct `src/host/triggerBridgeService.ts` also exists) over a guessable
  id (`insights-anniversary:<tenantId>:<principalUserId>`). And the insights subscription
  registers with `verificationMode:'none'` and no secret (`insightsSuiteService.ts:200-203`),
  bypassing the mint path, so every unsigned POST is "verified". Secrets that do exist live
  in a process-local `Map` (`triggerIngestionService.ts:628-638`), so a restart turns every
  `required` webhook into permanent `verified=false`.
  > **SPLIT by the review — the deferral reason applied to only one half.**
  > **`ISC-9a` (ingest-route authorization) — TAKE.** The exploit is concrete and
  > intra-tenant: **any authenticated member, at any role**, can forge an anniversary event
  > for any other principal, starting an LLM run on the tenant's BYOK key with
  > attacker-controlled content that lands in an email draft. It needs **no** secret-storage
  > decision. Note `insightsSuiteService.ts:198-201` justifies `verificationMode:'none'`
  > *because* the route is tenant-auth-gated — so the two halves are load-bearing on each
  > other and the cheap half is the one that was deferred.
  > **`ISC-9b` (signing-secret persistence) — DEFER**, genuinely blocked on a storage decision.
- **`ISWF-14`** — confirmed: no chain pack of any kind is attested; `gen-steward-manifest.mjs:52`
  walks only `packs/`. Same corpus-wide row as `SPWF-10`.
- **Sibling-lane check: CLEAN, and recorded as a negative.** Both
  `feature.insights-suite.nodes` (`variance-compute`, `talent-score`) are genuinely
  `role:"pure"` — the whole 374-line `index.mjs` contains exactly four `ctx.` reads, all
  `ctx.config`/`ctx.inputs`, with no host surface, connector, emitter or persistence call.
  The declarations are accurate. This is the first iteration in four where this check comes
  back clean, and saying so is the point: the class is not universal.

## Corrections to carried numbers

- `GEN-APPROVENOTIFY-1` said **14** gates declare no approver. That is exact for
  `core.approvalGate` — but the sibling typeId `core.chat.approvalGate` has 49 instances of
  which 47 declare none, so **the unaddressed population is 61 of 63, not 14.** The row
  undercounts by 47 because it enumerated one typeId. *(A 50th `core.chat.approvalGate` hit
  exists at `packs/vendor.myndhyve.chat/pack.json:66` — that is the node's own manifest
  declaration, not a workflow instance. Noted so the next reader does not "correct" 49 to 50.)*
- The same row's *"changed DISCOVERY, not reachability"* is **right about the notification**
  (title + a 140-char redacted static prompt + an `/inbox` link — `notifications/notify.ts:62-90`)
  and should not be widened: the proposal body is not in the notification.
- ADR 0599 §9's "all 58 chain packs are unattested" is numerically stale — there are **60**.
  The claim itself is unchanged and correct.

## RFC verdict

**Host work, no new RFC — but the framing was wrong and is corrected.**

> **CORRECTED:** this originally read "it only makes a NON-empty ACL mean what it says", as
> if D1 were a discretionary hardening. **D1 closes a live RFC 0173 §B non-conformance**
> pinned by `v2-approver-enforced.test.ts:83`, which currently records `blocked`. The
> empty-list open-gate semantics of `openwop-interrupt-quorum` are still preserved exactly.
> Also corrected: D1 part 3 **is** a pack change (`vendor.myndhyve.chat`) and therefore needs
> a version bump + registry republish; the original verdict said no bump was required, which
> was true only of D2.

**Witness obligation this adds:** ship + advertise the `conformance-approval-approvers`
fixture, converting a `blocked` bundle row into a pass.

## Open questions

1. D1 changes behaviour for any gate that declares a non-empty ACL — today exactly two, both
   in one pack. Should the same change also set `requiredApprovals: 1` on those two nodes,
   or is the ACL alone the author's intent? **Leaning: ACL alone** — `requiredApprovals` is
   a quorum threshold, not an authorization switch, and conflating them is what produced
   this defect.
2. **ANSWERED, and the first answer was wrong.** Does any gate rely on today's behaviour?
   **Yes, by default** — both `approvals.two-stage-sign-off` params default to `""` with
   "blank = any team member", and the empty-list rule already covers exactly that case. The
   first draft answered "Measured: no", which mistook the pack's documented default for an
   absence.
3. **Break-glass (NEW).** `isEligibleApprover` returns `{eligible:false, openGate:false}` when
   refs are present but resolve to nobody — a deleted group, a departed user, a missing
   `run.metadata.approverOrgId` (`host/approverResolution.ts:183-225`). Today any member can
   unblock such a run; after D1 **nobody can**, unless the gate declares `overrideScopes`.
   `resolveEligibleApprovers` already computes `unresolved[]` (`:44-49`) and the pre-flight
   path uses it, but the resolve path does not. Choose: a scoped admin override, or a typed
   `approver_refs_unresolvable` refusal.

## Status correction (2026-09-17)

This read `Status: Proposed (revised after adversarial pre-implementation revie…` — a PRE-implementation phrasing that went stale when
the work landed in **#3807** (D1 (4 parts) + D2). `docs/steward/FEATURE-LOOP-2026-09.md` records the
row **DONE** with that PR, which is the independent evidence for this correction.

**It was invisible to the steward staleness ratchet for a structural reason worth recording.**
That gate tested `Status:` for the EXACT string `Proposed`, so the parenthetical after the
word silenced it permanently — no baseline row, no exemption, nothing in a diff that reads as
a suppression. Seven ADRs were hidden that way, and the commit that claimed the baseline was
"drained to zero" was wrong about its own headline. The test is a prefix match now.
