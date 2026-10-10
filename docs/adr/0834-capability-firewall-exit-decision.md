# ADR 0834 — Capability firewall: one decision at every tool exit

Status: implemented (pending merge; see § Implementation record)

Feature loop round 2, row 20 (`capability-firewall`, `conversation-tools`,
`core:conversationTools`, ADR 0150 permission mode). The round-1 grade (A / A− / A−)
covered permission mode only; `conversation-tools` was never graded. Both were treated
as claims and re-measured on `origin/main` @ `a767ee948`: four parallel read-only
audits, then my own reading of every cited line. Each defect below is proved RED on
the unmodified code by a committed test before it is fixed (§ Witnesses).

This **extends** the always-on `capability-firewall` (ADR 0135/0397), the always-on
`conversation-tools` (ADR 0132) and the core permission mode (ADR 0150). Every route
is under `/v1/host/openwop-app/*`; the anonymous-lane reason strings are host-defined
values of RFC 0132's open `reason` field (the RFC lists them as "e.g."). No run-event,
capability or endpoint contract changes, so **no RFC is needed**.

## Context — what was measured

The tool loop (`host/agentDispatch.ts` `runChatToolLoop`) applies five gates per call:
allowlist, ADR 0132 scope, ADR 0132 approval set, ADR 0102 permissions, ADR 0135
firewall. The firewall hook (`buildFirewallHook`) also carries the ADR 0150 safe-mode
baseline. What held up:

- **The tool loop's gate ORDER is sound.** Deny is never downgraded; a firewall eval
  error fails closed in `enforce` and never weaker than the safe-mode baseline.
- **The ADR 0315 default-on baseline cannot grow silently.** `DEFAULT_ON_AGENT_TOOL_IDS`
  is pinned to an exact 9-id set (`test/agent-toolallowlist-override.test.ts:119`).
- **Schema-carrying outputs are not compacted.** `SCHEMA_READ_EXEMPT_TOOLS` + the
  `schemaCarrying` declaration are pinned both ways against the live tool population
  (`test/schema-read-exemption-completeness.test.ts`).
- **No MCP-mounted external tool reaches an agent.** `BUILTINS` holds none; outbound
  MCP is reached only from workflow nodes and feature services.
- **Tenant isolation of the rule store holds** (keyed by `tenantOf(req)`; the platform
  floor is a superadmin singleton).

What did not. Every one is a tool exit that skips a decision the product says it takes:

| # | Defect | Evidence |
|---|---|---|
| S1 | **A participant can switch on bypass in the owner's conversation.** `permissionMode` is read from the exchange body with no authority check; the exchange is authorized by READ visibility (participants pass). Tools then run as `run.metadata.actingUserId` — the owner. The approvals route refuses the same participant ("a participant may not … self-approve"). | `exchange/validateTurn.ts:58`, `exchange/authorizeResolve.ts:49`, `conversationToolLoop.ts:349,562`, `conversation-tools/routes.ts:50` |
| S2 | **Bypass downgrades admin- and operator-imposed approvals.** A superadmin platform `require-approval` rule, a tenant `require-approval` rule and an `enforce` posture whose default verdict is `require-approval` are all turned into `allow` by the user's own bypass switch. ADR 0150 says bypass "skips the ask" — but these asks are not the user's to skip. | `firewallHook.ts:200-206` |
| S3 | **The anonymous widget lane has no firewall.** A platform or tenant `deny` does not apply to an unauthenticated visitor's tool calls, including the auto-run writes under `rate-limit-session-cap`. | `anonymousActor.ts:482-491` ("The loop sets no capability-scope/firewall gate") |
| S4 | **Arbitrary fan-out and off-host sends run unasked in safe mode.** `openwop:workflows.compose-and-run` runs a model-written workflow (http/email nodes included) with no review; `openwop:destination-sync.run` POSTs model-supplied records to a peer. Neither is in `SENSITIVE_APPROVAL_TOOLS`, and neither classifies, because every egress row in the classifier is keyed on a bare node type id no agent tool can carry. So in safe mode a prompt-injected model composes an http.fetch node and gets the egress the `openwop:core.openwop.http.fetch` gate exists to stop. Both are reachable today only through an ADR 0104 allowlist override. | `toolCapabilityResolver.ts:20-34`, `workflowComposeTool.ts:335-411`, `destination-sync/agentTools.ts:140-178` |
| S5 | **The voice lane ignores the conversation's tool scope.** A tool the owner disabled for a conversation (or put behind approval, or put out of mandate by an expired intent ledger) is still callable over voice in that conversation. | `voice/realtime/toolBridge.ts:140-216` |
| S6 | **No approval card exists for chat tool calls.** ADR 0150 and `FEATURES.md` say a held call raises "the existing `interrupt.approval` card". Nothing reads `pendingApprovals` after the loop; the only surface is a gear-icon modal with no pending indicator, which shows the tool name and never the call's arguments, and does not say an approval covers every later call of that tool in the conversation. | `conversationExchange.ts:598-633`, `CapabilityScopeModal.tsx:82-101` |
| S7 | **Decision logging exists on one lane of five.** `onFirewallDecision` / `onShadowWouldBlock` are wired only in the chat lane, so a tenant reviewing `shadow` would-blocks before flipping to `enforce` never sees run, dispatch, voice or anonymous traffic. | `agentRunnerNode.ts:154`, `routes/agents.ts:440`, `toolBridge.ts:179` |
| S8 | **The firewall is built by four hand-copied blocks.** Each lane repeats a 5-read `Promise.all` and an option list; they already differ (chat passes `gateHostMediatedEgress`, two lanes do not; one passes approvals; one logs). | the four sites above |

Doc claims found false (corrected in place, same PR): the scope stamp is "read
verbatim on `:fork`" (`readCapabilityScopeStamp` has no caller — the loop re-resolves
live, which is what makes a revocation hold); permission mode "rides the run log ⇒
replay-deterministic" (chat exchanges arrive over HTTP); `resolveToolApproval`
"returns null if none was pending" (it never does); `SENSITIVE_APPROVAL_TOOLS` lists
`openwop:core.files.write`, which no agent tool registers; and the ADR 0610 PMC-1
witness proves the egress gate with `core.openwop.integration.email-send`, an id no
agent lane can carry — a gate that could not fail.

## Decision

> **Revised before any code, after an adversarial `/architect` pass** (4 Blockers,
> 7 Highs, 6 Mediums against the first draft — § Architect pass records each and where
> it landed). The first draft's D2 let a pre-approved ledger row skip an operator's
> ask, its D3 compared the wrong identity, and its D4 would have shrunk the rule
> coverage of tenants who already wrote rules. The text below is the corrected one.

### D1 — One lane firewall, built in one place

`host/laneFirewall.ts` exports `buildLaneFirewall({ tenantId,
lane, permissionMode, approvals?, resource?, dedupeKey? })`. It does the five posture
reads once, computes the safe-mode baseline set (D4), builds the hook, and wires
decision + shadow logging to the governance decision log for **every** lane, with
`detail.lane`. Shadow would-blocks are deduped per `dedupeKey` (the run, the voice
session), not per hook instance, so a lane that builds a hook per call (voice) does
not flood the log. The chat, run, dispatch-route, voice and anonymous lanes all call
it. `buildFirewallHook` stays the pure evaluator.

The chat lane builds the hook unconditionally. The old skip (bypass + rule-less +
`default-allow`) saved five cached reads and is the reason a lane could be
firewall-less at all.

**Anonymous lane** (no user, no ledger, no UI): forced `safe`, no approvals. A
`deny` is refused and audited `anon-firewall-denied`; a `require-approval` is refused
with a typed answer and audited `anon-firewall-held` (it does not enter the
operator hold queue — the hold lane is for the surface's granted writes, and mixing
a firewall ask into it would let an operator approve past a platform rule). The
`forbidden` → `anon-not-granted` audit mirror is restricted to tools outside the grant,
so a firewall refusal is never mislabelled. The deferred approve of a held anonymous
write re-checks the hook's `deny` (rules + platform floor) before it executes.
Rollout note: a tenant in `enforce` with no allow rule covering its widget's tools
will see the widget refuse them — that is what `enforce` means, and the decisions log
plus the simulator show it first in `shadow`.

Ratchet (`test/firewall-lane-census.test.ts`), counting the **physical exit**:
`buildFirewallHook(` has exactly one production caller (`laneFirewall.ts`), and every
production caller of `createAgentToolProvider(` / `createScopedAgentToolProvider(` is
named in a census table with the lane firewall that guards its `executeTool`, or with
the reason it needs none (`routes/agents.ts` verify-run passes no executor; inbound MCP
exposes nodes, not agent tools). A new tool-executing site fails the census until it
is adjudicated.

### D2 — Bypass skips only the user's own asks

Every `require-approval` now carries an **origin**:

| Source | Origin |
|---|---|
| the owner's own ADR 0132 scope `requireApproval` (ledger only) | `baseline` (user-level — FW2-CD-5: approving it must not satisfy a later policy ask) |
| tenant presence / `countAtLeast` / `expression` rule | `policy` |
| `enforce` default verdict | `policy` |
| platform floor (directly or through `mostRestrictive`) | `policy` |
| safe-mode baseline (name set + declared tools, D4) | `baseline` |
| eval-error fallback | `baseline` for the safe-mode part; the already-computed floor keeps `policy` |

A verdict's origin is the **maximum** of its contributors (`policy` > `baseline`): the
baseline overlay never replaces a policy verdict, it only raises an `allow`. The ADR
0132 scope `requireApproval` list is an owner-set ask that lives outside the firewall;
bypass has never reached it and still does not. On the ledger it is recorded as
`baseline` (user-level), so the owner approving their own scope ask does not satisfy a
workspace or platform ask on the same tool.

What can satisfy each origin:

- `bypass` (D3-authorized) satisfies `baseline` only.
- A **ledger approval** satisfies the origin it was raised for, or lower. The ledger
  row records the highest origin that held the tool while it was pending; an approval
  of a `baseline` row does not satisfy a later `policy` ask — that ask re-opens the row
  as `pending` (an escalation is the one transition that may reset a decision).
- Voice's client-set `userApproved` (and the sideband held-approval resolve) satisfies
  `baseline` only.
- A `deny` is never downgraded, as before.

The approvals route refuses (`409 no_pending_approval`) to decide a tool that has no
`pending` row: an approval answers an ask; it cannot be issued in advance. Stated
plainly: `require-approval` means a human with authority saw this tool being held.
An approval is still per tool for the rest of the conversation (allow-once is
FW2-D1), so a `countAtLeast` policy satisfied once stays satisfied for that tool.

Behaviour change, stated: a tenant that configured `require-approval` rules will now
see those asks in bypass conversations too.

### D3 — Authority over a conversation's tools is the principal the tools act as

Tools in a chat turn run as `run.metadata.actingUserId`, which `routes/runs.ts`
derives as `req.userId ?? principalId` — the same derivation as a conversation's
`ownerUserId`. The exchange's existing `callerUserId` is a DIFFERENT key
(`resolveCallerUser(req).userId`, the canonical durable user), so comparing it would
repeat the two-identity-keys defect. One function,
`toolAuthorityHolds(callerPrincipal, actingPrincipal)` (both defined, string-equal), in
`host/conversationVisibility.ts`:

- **Exchange bypass:** `callerPrincipal = req.userId ?? principalId` (threaded through
  as a new `hostDeps.callerPrincipal`), `actingPrincipal = run.metadata.actingUserId`.
  No acting principal, or no caller principal ⇒ the turn runs `safe`.
- **Approvals route:** `callerPrincipal` the same, `actingPrincipal = meta.ownerUserId`.
- **Folding approvals into a run (FW2-CD-1):** the conversation's approvals are the
  owner's. A run in the same conversation acting as someone else (a `:fork` re-stamps
  `actingUserId` to the forker but keeps `chatSessionId`) folds none of them, and its held
  calls are not written into the owner's ledger.
  An ownerless conversation has no principal with authority ⇒ `403`. (Ownerless
  conversations are legacy, conformance and anonymous flows; none drives an approval
  card.)
- Subject-bound conversations: "authority" is this principal match, not the subject's
  org admin.

An unauthorized bypass runs `safe` — not `403`, because the message is legitimate —
logs `permission_mode_bypass_refused`, and the composer hides the bypass switch for a
viewer who is not the conversation's owner (the meta's `ownerUserId` is already on the
client), so the user is not told bypass is on when it is not.

### D4 — The safe-mode baseline is declared on the tool

`BuiltinTool` gains an optional `safeModeApproval?: true`. The baseline set is
`SENSITIVE_APPROVAL_TOOLS` ∪ every registered tool that declares it. **Capability
classes are not changed in this ADR**: today every `openwop:*` tool is unclassified and
so counts as the risky fallback (`write` + `host-mediated`) for tenant rules and the
platform floor; declaring classes for a subset would remove those tools from rules
tenants already wrote. Classifying the population is FW2-D4.

Declared in this ADR:

| Tool | Why |
|---|---|
| `openwop:workflows.compose-and-run` | runs a model-written workflow, http/email nodes included, with no review. In a lane with a person present, the held answer points to `openwop:workflows.propose` (reviewed per composition). On the always-safe run lane it escalates, which is the ADR 0150 run-lane contract for a sensitive tool. |
| `openwop:destination-sync.run` | POSTs model-supplied records to a peer host |

`SENSITIVE_APPROVAL_TOOLS` drops the dead `openwop:core.files.write`.

Ratchet (`test/safe-mode-baseline-census.test.ts`): every live tool id in
`builtinAgentToolIds()` is adjudicated — in the baseline (exact set pinned), or in a
no-ask table grouped by a stated reason. The denominator is the live id set, not
`effect` (which is display-only by its own contract, and declares `http.fetch` a
read). A newly registered tool fails until it is adjudicated. Every
`SENSITIVE_APPROVAL_TOOLS` member must be a registered tool. The ADR 0724 §D0 pin
(`safe-mode-egress-gate-implied.test.ts`) is updated, not deleted: the class-gate
population stays empty by design, and the baseline census is now the witness that
off-host tools are covered.

### D5 — Voice honours the conversation's scope

The scope resolution in `conversationToolLoop.ts` (config ∩ approved intent ledger,
out-of-mandate ⇒ nothing enabled, approval decisions folded) moves to
`host/conversationToolScope.ts` `resolveConversationToolGate()`, called by the chat
loop and by the voice bridge when the session is bound to a conversation. Voice
refuses a disabled tool (`denied`) and treats a scope `requireApproval` tool as held
(the existing typed `requires_approval` answer; `userApproved` does not satisfy it —
D2). Intent-ledger expiry is measured from the run stamp; voice has no run, so it
anchors at the ledger's `createdAt` — the only timestamp the ledger has, and earlier
than its approval, so a runless lane can only refuse EARLY, never late. Only the run
lane persists expiry. Ledger approvals fold into the voice lane only when the session's
acting principal is the conversation's owner (through the D3 predicate) — the owner
approved the tool for their own actions.

> **Corrected in implementation (grade pass, FW2-CD-4).** The first text said "with no
> anchor at all it fails closed"; `createdAt` is always present, so that branch does not
> exist. The grade also found that an EXPIRED ledger was skipped by every lane (only
> `approved` folds), so the turn after expiry fell back to the full tool set — the
> opposite of "talk, don't act". An expired ledger now narrows to nothing until the
> user drafts a new mission.

### D6 — Held calls surface where the user is

- The ledger row stores the held call's arguments (`requestedInput`, secret-scrubbed,
  capped at 2 KB of JSON) and its `origin` (D2). Arguments update while the row is
  `pending` and are **cleared when it is decided**, so they live no longer than the ask.
  Every ledger write is a compare-and-swap against the row it read (`DurableCollection.
  compareAndSwap`), so an approval racing a re-ask is refused, never silently applied.
- The composer's conversation-tools control (the gear, now lazy-loaded) re-reads the
  ledger **when each agent turn settles** (the reply text is model output and cannot be
  trusted to announce a hold) and, while anything is pending, says so in words and the
  warning style. Its dialog shows the tool, "Requested with: …", and the grain in plain
  words: approving allows this tool **for the rest of this conversation, with whatever
  arguments the agent uses next**. Approve sends the `requestedAt` it displayed and the
  route REQUIRES it (`400` without, `409 approval_changed` if the row moved). After
  Approve, focus moves to a "Continue" button that sends a visible, localized user
  message through the surface's own submit (the current agent), so it re-attempts.
- The collection gets a subject eraser (`resolvedBy` redacted) and an
  `onConversationDeleted` cascade (rows deleted). Residual, stated like the intent
  ledger's: a DSAR cannot map a subject to a conversation, so a still-`pending`
  row's arguments survive a DSAR until decided or the conversation is deleted.

> **Corrected in implementation.** The first text promised "a notice above the
> composer" and "the gear shows a pending count". What shipped is ONE control: the gear
> itself becomes the pending indicator (a second raw button would have grown the
> bespoke-button ratchet, and the separate notice had nowhere to sit in a composer row
> that is a chip strip). The grade pass also found the first cut re-read on the turn's
> START, not its end (the send adds two rows, the completion swaps them 1:1), so a hold
> was invisible until the next message (FW2-UX-1).

> **Disposition (orchestrator review, 2026-10-06): the chat `interrupt.approval` card is
> deliberately NOT reused.** That card renders a workflow approval INTERRUPT record and
> resolves through the interrupts route. A held chat tool call has no interrupt record —
> it is a `conversation-tools:approval` ledger row. Minting an interrupt per held call
> would be a second approval path with its own resolve semantics, which CLAUDE.md
> forbids ("no second system" / reuse, never recreate). The existing conversation-tools
> surface (the composer gear → `CapabilityScopeModal`) IS the reused component; it
> became the pending indicator.

### D7 — Doc honesty

The five false claims in § Context are corrected inline (code comments, ADR 0132 /
0150 correction notes, `FEATURES.md` rows), and the PMC-1 witness is replaced by one
that uses a tool an agent lane can actually be offered.

### Replay / fork

Recorded runs replay their recorded verdicts (`agent.toolReturned`) unchanged. A
`:fork` re-resolves live, as ADR 0132 already does for scope ("tighter wins"), so a
forked conversation's next `compose-and-run` or `destination-sync.run` call is held
where the source's was not. Nothing new is stamped.

## Alternatives weighed

- **Gate in the executor (`createAgentToolProvider().executeTool`)** — the one
  physical exit every lane shares. Rejected for the firewall itself: the decision needs
  per-turn context (the seen set for composition rules, the approval ledger, the
  permission mode), which the executor does not have. D1 gets the same property — one
  decision — through one factory plus a census of the executor's constructors.
- **403 an unauthorized bypass (D3).** Rejected: the message is legitimate; only the
  pre-authorization is not. Fail-safe matches ADR 0150's "absent ⇒ safe".
- **Declare capability classes for the off-host tools (first draft of D4).** Rejected:
  every `openwop:*` tool currently counts as the risky fallback for tenant rules and
  the platform floor; giving a subset precise classes removes them from rules already
  written. One declaration was serving two purposes (rule matching and the safe-mode
  ask); they are separate fields now, and only the second changes here.
- **Gate the fixed-workflow run starters (campaign, podcasts, production …).** Not
  done: the user asked for that workflow by name, the workflow is code-reviewed, and
  its sends carry node-level gates (`core.email.send`'s approval interrupt). The
  arbitrary one (`compose-and-run`) is the risk, and it is held.
- **A tenant setting to forbid bypass.** Not needed after D2 + D3: an admin who wants
  an ask that bypass cannot skip writes a `require-approval` rule.

## Phased plan

| Phase | Deliverable |
|---|---|
| P1 | Witnesses RED on `origin/main` (S1–S7) |
| P2 | D1 factory + all five lanes + census ratchet; D2 origins + ledger origin/409 |
| P3 | D3 shared authority function in the exchange + the approvals route + composer switch |
| P4 | D4 declaration + baseline census |
| P5 | D5 shared scope gate + voice |
| P6 | D6 ledger arguments/CAS/erasure + pending notice + count; D7 doc corrections |

## Architect pass (pre-implementation, 2026-10-06)

An adversarial review of the first draft, verified against the code. Dispositions:

| Finding | Disposition |
|---|---|
| B1 ledger approvable with no pending ask ⇒ policy asks skippable | D2: route `409 no_pending_approval`; origin on the row; escalation re-opens |
| B2 origin underivable (overlay replaced the verdict; eval-error branch) | D2: origin = max of contributors, per-source table |
| B3 voice `userApproved` satisfies "real" approval | D2/D5: satisfies `baseline` only |
| B4 D3 compared the canonical user, tools act as `req.userId ?? principalId`; ownerless/no-caller passed | D3: compare against `run.metadata.actingUserId`; no principal ⇒ safe / 403 |
| H1 class declarations shrink tenant rule coverage | D4: separate `safeModeApproval` flag; classes untouched (FW2-D4) |
| H2 compose-and-run: headless lane / per-conversation grain | D4: held answer points to `workflows.propose`; run lane escalates by contract |
| H3 voice cannot compute ledger expiry (no run) | D5: anchor at ledger `resolvedAt`; no anchor ⇒ fail closed |
| H4 anonymous lane audit would lie; require-approval undefined; `enforce` rollout | D1: reasons, refusal semantics, rollout note |
| H5 census counted the wrong functions; anon deferred approve | D1: census the executor constructors; deferred approve re-checks deny |
| H6 arguments shown ≠ what is approved; race | D6: honest copy + `requestedAt` compare-and-set |
| H7 arguments add PII to a store with no erasure | D6: eraser + conversation-delete cascade + clear on decision; residual stated |
| M1 `effect` is the wrong census denominator | D4: census over the live id set |
| M2 shadow log floods (dedupe per hook) | D1: dedupe per run/session |
| M3 silent fail-safe | D3: composer hides the switch for non-owners |
| M4 "Continue" must be localized + keep `turn.to` | D6 |
| M5 voice folds owner approvals into a participant's session | D5: fold only when the acting principal is the owner |
| M6 fork re-resolves; §D0 pin will move | § Replay / fork; D4 updates §D0 |

## Grade pass (post-implementation, 2026-10-06)

`/grade-code` (C on `origin/main` → B+ on the first cut) and `/grade-ux` (C+ on the first
cut) ran over the implementation. Every Blocker and High is fixed in this PR:

| Finding | Fix |
|---|---|
| FW2-CD-1 a fork's run spent the owner's approvals and wrote into the owner's ledger | fold + ledger writes only when the acting principal is the owner (D3) |
| FW2-CD-2 the "compare-and-set" was read-check-write | `compareAndSwap` in every ledger writer; `requestedAt` required on the route |
| FW2-CD-3 the census counted builds, not hand-offs; no decision-log witness | a hand-off check per lane; trailing comments stripped; a decision-log witness per lane |
| FW2-CD-4 voice could end a mission early, and an expired mission widened to every tool | expired ⇒ nothing enabled; only the run lane persists expiry |
| FW2-CD-5 the owner's scope ask recorded as `policy` | recorded `baseline` (user-level) |
| FW2-CD-6 voice's owner check bypassed the shared predicate | `toolAuthorityHolds` |
| FW2-CD-7 / FW2-UX-4 bypass + authority state survived a conversation switch | reset on `sessionId` |
| FW2-CD-8 / FW2-UX-9 this ADR disagreed with the code | corrected in place (D5, D6) |
| FW2-UX-1 (Blocker) the control re-read at turn START | keyed on the turn settling (`isSending ? -1 : length`) |
| FW2-UX-2 a non-owner saw an editable scope and a Save that 403s | read-only + a localized line (`viewer.mayEditScope`) |
| FW2-UX-3 focus lost after Approve; outcome not announced | focus moves to Continue; `role="status"` |
| FW2-UX-5 a non-owner got no reason for the missing switch | a labelled "Safe" note |
| FW2-UX-6 arrow-keying the posture radios switched to enforce | enforce is confirmed first |
| FW2-UX-7 the arguments box was not keyboard-reachable | `tabIndex=0` + label |
| FW2-UX-10/11 French register; "safe-mode asks" jargon; hover lost the warning colour | copy + CSS |

## Implementation record

Branch `feat/fl2-20-firewall`, base `origin/main` @ `a767ee948`. Commits are cited by
subject (shas move on rebase):

| Phase | Commit |
|---|---|
| P1 witnesses (RED) | `test(adr0834): firewall exit witnesses — RED on origin/main (10 red, 3 controls green)` |
| P2–P5 backend | `fix(firewall): one decision at every tool exit (ADR 0834 D1-D5)` |
| P6 frontend + doc corrections | `feat(chat): held tool calls surface on the composer control; owner-only bypass (ADR 0834 D3/D6/D7)` |
| grade-pass fixes | `fix(firewall): grade-pass fixes — owner-only fold, CAS ledger, hand-off census, expired mission (ADR 0834)` |
| PMC-1 on a real agent tool | `test(firewall): PMC-1 egress-class witness on a real agent tool (ADR 0834 D7)` |
| run-lane + dispatch execution witnesses | `test(adr0834): execution witnesses for the run lane and the dispatch route (FW2-CD-3)` |
| turn-settle refresh in the hook | `fix(chat): pending-approval re-read keyed on the turn settling, in the hook (FW2-UX-1)` |

### Witnesses

RED on the unmodified `origin/main` (`test/adr0834-firewall-exit-witness.test.ts`, run
before any fix: 10 failed, 3 controls passed — every failure an assertion, not a load
error):

| Defect | Witness | RED on main |
|---|---|---|
| S1 participant bypass runs as the owner | `S1 — … a participant's bypass does NOT run it as the owner` (+ no caller principal) | executed `[code-exec]` |
| S2 bypass skips admin/platform asks | 4 cases: platform floor, tenant rule, enforce default, sensitive + policy | `allow` ×4 |
| S3 anonymous lane unfirewalled | `a platform deny refuses a GRANTED anonymous read` | executed the read |
| S4 compose-and-run / destination-sync unasked | the chat-lane hook as built on main | `allow` ×2 |
| S5 voice ignores scope | `a tool the conversation disabled is refused over voice` | `ok` |

Added with the fix (each fails without it): the D3 predicate, voice `userApproved`
answers only a baseline ask, a held voice call lands in the ledger, per-lane decision
logging (×5), FW2-CD-1 fork fold, FW2-CD-4 expired mission; the ledger's 409 /
compare-and-swap / escalation / eraser / cascade (`conversation-tools-approval.test.ts`);
the route's 400/409/200 sequence (`conversation-tools-route.test.ts`); two census
ratchets (`firewall-lane-census.test.ts`, `safe-mode-baseline-census.test.ts`); and the
frontend control, owner-only switch and enforce confirm.

Sabotage-witnessed (each committed first, then broken, then restored with `git checkout`):
removing `firewall,` from `agentRunnerNode.ts` / `routes/agents.ts` reds both the lane
census hand-off check and the run-lane / dispatch-route EXECUTION witnesses
(`test/adr0834-lane-execution-witness.test.ts`, platform deny ⇒ the tool never runs;
control without the rule ⇒ it runs); deleting the `openwop:destination-sync.run`
classifier row reds 4 egress-class witnesses (the ADR 0610 PMC-1 block now uses that
real agent tool instead of a node id no agent can carry, and §D0 R3 pins the live
egress population to exactly it). The FW2-UX-1 refresh is witnessed through the hook
(`pendingApprovalsRefresh.test.tsx`: count 0 → sending at 2 → settled at 2 must re-read).

### Deploy note

- **No migration, no env, no pack pin.** One new eraser registration
  (`eraseConversationToolApprovalsSubject`, in the manifest).
- **Behaviour changes:** (1) a tenant's `require-approval` rules, an `enforce` default of
  `require-approval`, and platform `require-approval` rules now ask in bypass chats too;
  (2) a participant's bypass runs `safe`, and the switch is shown only to the owner;
  (3) the anonymous widget is under the firewall — an `enforce` tenant whose rules do
  not allow-list the widget's tools will see it refuse them; (4) in safe mode,
  `workflows.compose-and-run` and `destination-sync.run` ask (both reachable only via an
  ADR 0104 override today); (5) an approval needs a pending ask and its version — an old
  client that POSTs without `requestedAt` gets 400; (6) legacy approval rows (no origin)
  satisfy only safe-mode asks; (7) an expired intent ledger keeps tools off until a new
  mission is drafted; (8) firewall decisions now land in the governance log from every
  lane, so the decisions view shows more rows.

## Deferred

- `FW2-D1` **Allow-once grain.** Server-side replay of the held call with its stored
  arguments, so an approval covers exactly what was shown.
- `FW2-D2` **Exchange retry re-runs tools.** A dispatch error after a tool ran releases
  the idempotency claim, so a retry can repeat a side effect (`conversationExchange.ts:
  610-626`). A runs-row concern; recorded here because it was found here.
- `FW2-D3` **Toggle-OFF tool exits.** KickTodo core/creator/accountability tools and
  `walkthroughs.register-draft` run while their feature toggle is OFF (the HTTP route
  refuses). No paid-bundle feature is affected (ADR 0819's paywall holds: every
  ungated tool family is absent from `bundles.json`). Owned by the KickTodo row.
- `FW2-D4` **Classify the agent-tool population.** Under the default `treat-as-risky`,
  ~200 unclassified tools count as host-mediated egress for tenant composition rules,
  so the recommended read-then-egress rule over-fires and `countAtLeast` fan-out rules
  cannot tell a run starter from a read. Needs a simulator before/after diff per
  tenant with rules before it ships.
- `FW2-D5` **Run-lane scope.** A workflow run started from a chat (`chatSessionId`
  stamped) does not apply that conversation's scope to its agent-runner nodes.
- `FW2-D6` **Heartbeat workflow-as-tool and child workflow nodes.** `bootstrap/nodes.ts`
  sub-runs and nodes inside any run an agent starts take no firewall; node-level gates
  (`core.email.send`'s approval) are the only ones. Composing a child workflow is
  held (D4); a fixed workflow's nodes are reviewed code.
- `FW2-D7` **Held calls in ownerless or channel conversations.** No principal has
  approval authority there (D3), so a held call fails safe and stays held; nothing in the
  UI says why. Legacy/conformance flows only.
- `FW2-D8` **Announce a new hold to screen readers** (FW2-UX-8): the control's text
  changes but is not a live region.
