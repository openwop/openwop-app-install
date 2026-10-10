# ADR 0778 — Interrupts inbox: decide integrity (one claim, one authority, one identity)

Status: implemented (P1) — P2/P3 Proposed

Feature loop round 2, row 6 (`core:interrupts`). Grade:
`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Approvals / interrupts inbox" (ids
`APWF-`). Baseline `origin/main` `4d55caa17`.

## Context

The interrupts surface is the human gate that every durable AI write passes
through. It has five decide lanes: the protocol node route
(`POST /v1/runs/:runId/interrupts/:nodeId`), the RFC 0093 token route
(`/v1/interrupts/:token`, including the email confirm page), the unified inbox
(`/v1/host/openwop-app/reviews/:id/actions/:action`), MCP `requestState`, and the
host's own timeout lane. They converge on one function, `resolveAndResume`
(`routes/interrupts.ts:1284`), and one resume seam, `dispatchGateResume`. The
convergence is real (grade scout: no bypass of `dispatchGateResume` exists), and
the RFC 0223 reject routing merged in #4187/#4196 is correct.

The integrity of what reaches that seam is not. The grade found five Blockers:

| id | Defect | Where |
|---|---|---|
| `APWF-1` | the accept branch never checks it won the resolve CAS, so a gate that a reject or the timeout already closed can still run as ACCEPTED (fail-open) | `routes/interrupts.ts:1542`, `executor/suspendManager.ts:108` |
| `APWF-2` | `/reviews` decide requires `runs:read`; no session lane has an always-on role floor (a Viewer decides open gates unless `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`) | `routes/reviews.ts:84`, `protocolAuthorization.ts:280` |
| `APWF-3` | cancelling a run leaves its own gates open and actionable; deciding one 500s after consuming it; dead rows crowd the inbox's `LIMIT 500` | `host/runCancel.ts:146`, `storage/*/index.ts` `listOpenInterruptsForTenant` |
| `APWF-4` | the token lane records a voterless vote as `anon-N` and ignores group/role ACLs, so one token holder meets a quorum alone | `routes/interrupts.ts:814`, `:1024` |
| `APWF-5` | MCP claims the interrupt before eligibility and quorum run, so a quorum gate is consumed with quorum unmet and the run never resumes | `host/mcpSemantics.ts:304` |

and three that ride along cheaply: `APWF-6` (vote identity keyed on one raw
spelling — the row 4/5 two-spellings trap), `APWF-7` (the lazy timeout check sits
in one route, not the choke point) and `APWF-8` (the inbox read still does one
`getRun` per distinct run after #4215, and `status` omitted returns the unbounded
approval history).

### Competitive frame

`docs/steward/UX_UPGRADE-inbox.md` benchmarks the inbox against Linear and GitHub
notifications, and ADR 0198 benchmarked approvals depth (delegation, OOO,
anti-double-vote) against Jira Service Management / ServiceNow-class approvals.
The conventions every one of them holds, and this surface does not, are all
integrity conventions, not features:

1. **A decision is final.** A reject or an expiry is never overturned by a click
   that arrived later (Jira SM, ServiceNow, GitHub environment approvals).
2. **Only an approver sees the approve button.** Everyone else sees who the
   request is waiting on. ServiceNow and GitHub environments both render
   "waiting on <reviewers>" to non-reviewers.
3. **A cancelled request leaves the queue.** It is not left for someone to
   discover by clicking.
4. **One person, one vote.** However the person signed in.

So this ADR is an integrity refinement. Its UX half (D10) is those conventions
made visible, not new furniture.

## Boundaries audit

- **Single owners, composed rather than forked.**
  - `resolveAndResume` owns every human decision, and `dispatchGateResume` owns every resume.
  - `storage.resolveInterrupt` is the CAS: a conditional write on both adapters (`postgres/index.ts:875`, `sqlite/index.ts:1536`).
  - `isEligibleApprover` / `consumeVoteIdentity` (`host/approverResolution.ts`) own ACL resolution and delegation.
  - `callerHoldsTenantScope` / `callerSubjectSpellings` (`features/featureRoute.ts:323-356`, ADR 0775 D1) own the always-on role floor and the identity union.
  - `resolveCallerUser` (`features/users/usersGuards.ts:79`) owns the canonical user.
  - `verifyVoterBinding` (`host/interruptVoterBinding.ts`) owns the per-recipient email signature.
  - `timeoutApprovalGateIfDue` owns expiry.
- **Nothing new is invented.** Every decision below routes an existing lane through an existing owner that a sibling lane already uses.
- **No route collision.** No route is added.
- **Capability honesty.** Nothing is advertised or withdrawn. The quorum profile's open-gate contract (`conformance-interrupt-quorum.json`: `approversList: []`, three distinct `voter`s on a bearer) is preserved exactly. The conformance scenario always sends `voter` (`interrupt-quorum-resolution.test.ts:44,62,85,89`), and so does `v2-approval-reject-disposition` (`:169,173`).

## Decision

### D1 — One claim on every terminal branch (`APWF-1`)

The accept branch claims exactly as the two reject branches do:
`won = reviewer?.preclaimed === true || await storage.resolveInterrupt(...)`.

A lost claim throws `409 interrupt_already_resolved` ("already decided") and
appends nothing. It throws rather than returning silently because every caller of
the accept branch is a human-facing request that would otherwise answer
`200 resolved` for a decision that did not happen.

The reject branches keep their silent `return`. Their losing caller's intent (the
gate did not pass) is already true, and #4196's tests pin that shape.

The quorum paths `clearQuorumVotes` only AFTER winning the claim, so a claim lost
to a timeout no longer destroys the vote record.

`SuspendManager.resolve` is no longer called from this path. The wrapper that
swallowed the flag stays for its other callers but is not on the decide path.

### D2 — One decide authority on session lanes (`APWF-2`)

A new helper, `requireInterruptDecider(req, storage, interrupt)` in
`routes/interrupts.ts`, is called by both SESSION decide routes (the node route
and `/reviews`) before `resolveAndResume`:

- **The gate declares an ACL** (non-empty `approverRefs`, `approversList`,
  `approverGroupRefs` or `approverRoleRefs`): the ACL is the authority, as it is
  on the approvals lane (`approvalDecision.ts:147-165`). A named approver may
  hold any role; eligibility runs in `resolveAndResume`.
- **Open gate:** `callerHoldsTenantScope(req, run.tenantId, 'approvals:respond')`,
  always on. `approvals:respond` is the scope the spec names for resume, and it is
  held by Editor and above (`accessControlService.ts:225`). Refusal is
  `403 forbidden_scope`, the envelope kanban and the agent area answer, so the SPA
  maps it once. The wildcard operator principal (conformance, env keys) and the
  caller's own personal workspace pass, exactly as they do for kanban.

`/reviews` decide on an interrupt-source review additionally calls
`requireProtocolScope(req, 'approvals:respond')` in place of `runs:read`. This
matches the node route, so a key narrowed to `runs:read` is refused on both.
Approval-source reviews keep `approvalDecision.ts`'s own authority (ADR 0198). It
already requires `approvals:respond` on open gates, and deciding it is out of this
ADR's defects.

The token lane (RFC 0093 capability) is not a session lane. The token is the
authority, and D4 hardens it.

**Not a widening.** The helper only adds refusals. The enforced-mode
`requireProtocolScope` on the node route is unchanged, so under enforcement a
named approver who is a Viewer is still refused there exactly as today.
**Correction candidate, recorded rather than changed:** that refusal contradicts
the "ACL is the authority" rule above, and loosening it is a widening that needs
its own refuse-side tests (open question Q1).

### D3 — A terminal run closes its gates (`APWF-3`)

- **`cancelRunAndCascade`** resolves the cancelled run's OWN open interrupts
  (`{ cancelled: true, reason }`, `recordInterruptResolved(…, 'cascaded')`), after
  the `run.cancelled` append succeeds, in the same loop shape the child cascade
  uses.
- **`listOpenInterruptsForTenant`** (both adapters) adds
  `r.status NOT IN ('completed','failed','cancelled')` to its JOIN. This drops
  pre-existing dead rows too, which cancel alone could never reach (the finalizer
  `runCancel.ts:94-101` proposes), and it stops them from consuming the 500-row
  window.
- **`getReview`** returns `null` (so the route answers 404) for an interrupt whose
  run is terminal.
- **`resolveAndResume`** refuses `409 interrupt_already_resolved` on a terminal
  owning run BEFORE any claim, so no lane can consume a dead gate.
- **The node route's v1 answer is preserved.** After a cancel,
  `getInterruptByNode` finds no open row. In the not-found branch, a `cancelled`
  owning run now answers the major-1 `410 interrupt_gone` it answered when the
  row was left open (major 2 already answers 409). Conformance accepts
  410/409/404 (`interrupt-parent-child-cascade.test.ts:96`), but a silent 410→404
  change is still a change.

### D4 — The token lane counts real, eligible, signed voters (`APWF-4`)

- **(a)** A quorum vote without a string `voter` is `400 validation_error`. The
  host never fabricates an identity (`anon-N` is deleted).
- **(b)** `assertTokenQuorumVote` becomes async and reads the FULL ACL (explicit ∪
  group ∪ role), the same `declaresAcl` predicate as the session lane. When an ACL
  is declared, `voter` must be eligible through `isEligibleApprover` (the single
  resolver, org-scoped by `run.metadata.approverOrgId`), not merely `includes`.
- **(c)** Every ACL-declaring QUORUM vote on this lane requires a valid
  `voterSig`. Today that holds only for explicit lists.
  - Emailed recipients are unaffected, because every email link is signed for
    its recipient's userId (`emailApprovalDelivery.ts:166`).
  - A group or role gate can no longer be satisfied by one recipient naming
    others.
  - Single-approver gates keep the ISWF-23 decision (no signature), with the
    eligibility check from (b).
- **Residual, by contract:** on an OPEN quorum gate (no ACL), a single bearer can
  still name N distinct voters. That is the `openwop-interrupt-quorum` profile as
  specified (pure counting; per-subject authorization is the separate
  `auth-required` profile), and an author who needs N distinct humans declares an
  ACL. It is stated here so nobody reads D4 as closing it.

### D5 — MCP never claims a gate that needs a named approver (`APWF-5`)

`resumeInterrupt` (`host/mcpSemantics.ts`) refuses before its claim when the gate
is a quorum gate or declares an ACL. It returns
`{kind:'failed', text:'this approval needs a named approver — decide it in the inbox'}`,
and the interrupt stays open.

The alternative, running eligibility and quorum ahead of the claim, was rejected.
MCP `requestState` carries no approver identity, so the only honest answer for a
gate that requires one is "not here". The existing trust check already sits before
the claim for the same stranding reason (`:291`).

### D6 — One reviewer identity (`APWF-6`)

A single `reviewerIdentityOf(req)` is used by both session routes. It returns:

- `countAs`: the canonical userId via `resolveCallerUser`, falling back to
  `req.userId`, then the raw principal;
- `spellings`: `callerSubjectSpellings(req)`.

Both routes key the ledger on `countAs`, so the SPA and an OIDC bearer are one
voter.

Eligibility is decided on ANY spelling: `isEligibleApprover` is tried per
spelling and the first eligible one wins, while `countAs` stays canonical. A list
naming `oidc:<sub>` is then decidable by the canonical user.

An unbound OIDC bearer, previously refused as "unauthenticated" on ACL and quorum
gates, now votes as its canonical user. It is still refused when not eligible;
refuse-side tests pin both.

### D7 — Expiry is checked at the choke point (`APWF-7`)

`resolveAndResume` calls `timeoutApprovalGateIfDue` first, unless `preclaimed`,
and answers `409` ("approval gate timed out") when it fires. This covers `/reviews`
and every future lane. The node route's own call stays as a cheap early exit.

### D8 — The inbox read is bounded (`APWF-8`)

- An optional `Storage.getRunsByIds(ids)` does one query per adapter
  (`= ANY($1)` / `IN (…)`). `listReviews` and the scan fall back to per-id reads
  where it is absent.
- `listReviews` reads the distinct runs of the interrupt page in that one call.
- `/reviews` with no `status` means `pending`, as every docstring already says.
- Approval visibility memoizes `resolveEffectiveAccess` per `(subject, orgId)`
  for the request.
- Each review gains `canDecide?: boolean` for the caller:
  - interrupt source: D2's authority, plus eligibility for ACL gates;
  - approval source: the approvals lane's same predicate.

  The SPA hides decide buttons on `canDecide === false` (D10). It is advisory:
  the server refuses regardless.

### D9 — Out of scope, with pointers

- **`approval.overridden` payload, the workforceHistory v1 fixture
  (openwop#1742), `core.conformance.hold`, `0223.replay-derives-rejection`:** owned
  by the parallel `approval-reject-action-fix` work. Untouched.
- **`APWF-11`, override authority on the token lane and `override.requiredRole`:**
  shares `rfc0093-approval-gate.test.ts:251` and the emitter with that work.
  Deferred to P3, after it lands.
- **`APWF-9`, the resolved-but-not-resumed recovery lane, and `APWF-10`, the
  cross-instance execution fence:** P2 (L), with their own witness design.
- **`APWF-12`** (advertised timeout), **`APWF-13`** (partial index, a NEW migration
  entry — never `MIGRATIONS[1]`) and **`APWF-14`** (ledger hygiene beyond D1): P3.

### D10 — SPA: the conventions made visible (pending file clearance from the orchestrator)

- **Hide decide buttons unless the caller can decide.** `ReviewCard` renders its
  actions only when `canDecide !== false`, and otherwise says whose decision the
  request waits on. This is convention 2.
- **Errors reach the user.** Decide errors are held in `reviewStatusStore`, keyed
  by reviewId, so they survive the optimistic remove/restore remount (they are
  swallowed today).
- **Localized, status-based errors.** A 403 maps to `common:error_forbidden`, and
  a 409 is detected by `ApiError.status`, not by regex. It shows the existing
  "resolved elsewhere" copy.
- **No fake answers.** A `requiresValue` action links to the run's interrupt
  surface instead of posting `{}`.

  > **CORRECTED 2026-10-08 — the link was a dead end for every member.** The
  > run's interrupt surface is `/runs/:runId`, which is **admin-tier**
  > (`chrome/features.tsx`, gated by `AdminLayout` on `isAdminCaller`), so a
  > member who may answer a clarification was sent to "Administrator access
  > required" (found closing DESIGN.md rule 17 in #4611). "No fake answers" stands;
  > the answer now happens ON the card. The projection carries `answerForm`, a
  > closed per-kind allowlist (`interruptAnswerForm` in
  > `host/reviewProjection.ts`): clarification `question`/`profile`/`connection`,
  > refinement `current`, cancellation `reason`, and never raw `data`. `ReviewCard`
  > renders the chat's own interrupt card for that kind (`CardHost`,
  > `autoFocus={false}` because the inbox is a list) and posts the card's value
  > through the existing `/reviews/:id/actions/resolve` lane, which already took
  > `value` and runs the same checks as the node route. Kinds the card cannot
  > answer (credential, external-event, an approval gate without listed verbs)
  > keep the run link for an admin. A member sees a line saying an admin can
  > answer it. Q1 below is unchanged. Tests: `adr0778-decide-authority.test.ts`
  > § "D10 correction" and `ReviewCard.test.tsx` § "D10 correction", both
  > sabotage-witnessed.
- **Reject asks first.** Reject requires a confirm, as `ApprovalCard` already does
  (ISU-12).
- **One click, one post.** A synchronous in-flight ref guards against double
  submit.
- **No keyboard trap.** `ApprovalCard` stops trapping focus in an inline card
  (WCAG 2.1.2): it focuses on mount without trapping.

## Corrections from the adversarial `/architect` pass (before any code)

The pre-implementation review returned **5 Blockers, 4 High, 5 Medium**. Every one is
accepted; the decisions above are read with these corrections applied, and the
original text is kept so the reasoning trail survives (CLAUDE.md "correct, don't
rewrite").

- **C1 (Blocker, D1 strands every timer).** "Five decide lanes" was false. There are
  **eleven** `resolveAndResume` call sites. The timer sweep CLAIMS first
  (`executor/timerResume.ts:71`) and then calls `resolveAndResume` WITHOUT
  `preclaimed` (`index.ts:1029`). Under D1 its accept-branch claim would lose to
  its own sweep, so every ADR 0267 timed wait would throw 409 with its interrupt
  consumed and never resume. It is exactly the class D1 closes, one caller over.
  **Corrected:** `index.ts:1029` passes `preclaimed: true`, and a real-executor
  witness proves a due timer resumes its run. Every caller is now classified:
  - preclaimed: timer, connection-prompt skip (`routes/interrupts.ts:174`, already passes it), MCP (see C6);
  - not preclaimed: node route, token route, email POST, `/reviews`, conversation close, OAuth callback (`connections/routes.ts:381`, already catches), inbound webhook (`inboundWebhooks.ts:691`), `mcpControlNodes.ts:172`.

  The last two catch the new 409: the webhook treats it as deduped and returns the
  run it would have resumed, and the MCP node answers `fail('conflict')`. Without
  that, a redelivery would start a NEW run from a message meant for the old
  conversation.
- **C2 (Low→adopted, D1).** The concurrent voter who TIPS `accept-quorum-met` but
  loses the claim to a peer's identical tip must not be told "already decided":
  their vote counted and the gate passed. On the quorum-met/override branches a
  lost claim returns silently. Only a NON-quorum accept that loses throws 409.
- **C3 (Blocker, D2 blocks chat).** The node route serves every interrupt kind:
  conversation exchange/close, clarification, credential, tour-step,
  walkthrough-step, external-event. An `approvals:respond` floor on all of them
  would stop a Viewer from chatting in a shared workspace. **Corrected:**
  `requireInterruptDecider` applies to `kind === 'approval'` only. A test pins that
  a Viewer can still send a conversation exchange.
- **C4 (Blocker, D6 breaks the v1 quorum conformance scenario).** Falling back to
  "the raw principal" makes `bearer:<id>` a subject, so
  `conformance-interrupt-quorum`'s three `voter`s on one bearer would dedup into
  one ledger row and the quorum would never be met. **Corrected:** D6 applies only
  when `principal.auth.kind === 'subject'` AND a user resolves. Every other caller
  keeps today's split: a non-subject is the capability-token lane (body `voter`),
  and anything else fails closed.
- **C5 (Blocker, D6 lets anonymous sessions vote).** The same fallback turns an
  anon cookie into subject `session:<sid>`, which an OPEN quorum gate counts. Today
  that fails closed (ADR 0070 tier c). **Corrected:** never fall back to an
  anonymous principal. There is a refuse-side test in the anon's OWN tenant.
- **C6 (Blocker, D6/D4 double-count a delegate).** "`countAs` stays canonical"
  would overwrite the ADR 0198 `consumeVoteIdentity` result, so a principal and
  their delegate would count twice. D4(b) had the same bug on the token lane.
  **Corrected:** both lanes take `countAs`/`actedBy` from `consumeVoteIdentity`
  (the token lane passes the body's `actedFor`). D6 changes only WHICH reviewer
  ref enters it (the canonical user instead of `req.userId`/raw principal). The
  "eligible on any spelling" widening is WITHDRAWN: eligibility stays on the
  canonical ref, so a list naming `oidc:<sub>` still fails closed for the
  canonical user, exactly as today. It is filed as `APWF-6b`, needing its own
  delegation-aware design.
- **C7 (High, D5 → MCP stops pre-claiming).** Beyond quorum, MCP's claim-then-throw
  also strands the run on the `timeout` action refusal, the credential shape checks,
  `approval_node_unresolvable` and D3's new terminal 409. D7 also exempted
  preclaimed callers, so MCP could accept an overdue gate. **Corrected:** once D1
  exists, every branch claims for itself, so MCP DROPS its own claim and calls
  `resolveAndResume` without `preclaimed`, mapping a 409 to "interrupt already
  resolved". Single use still holds through the branch claim. Every refusal now
  happens before any claim and leaves the interrupt open. D5's quorum/ACL refusal
  stays, because a pending vote never claims.
- **C8 (High, D4 order and scope).** D4(a) applies to the capability lane only
  (session subjects carry no `voter`). It runs AFTER the ACL checks, so
  `v2-approver-enforced` (a non-quorum ACL gate, a bearer, no `voter`) still gets its
  403, not a 400.
- **C9 (Medium, D4(c) reaches bearer integrations).** The node route's bearer caller
  also uses `assertTokenQuorumVote`, so an API integration voting on a group/role
  QUORUM gate now needs a `voterSig` it cannot mint. **Accepted deliberately:** a
  bearer naming arbitrary group members is exactly the quorum defeat D4 closes. An
  integration that needs to vote uses an authenticated user, or the gate names its
  approvers explicitly with emailed links. No test or conformance scenario hits it
  (the quorum fixture is open).
- **C10 (High, D3 is invisible to open inboxes).** The cancel path also broadcasts
  `review.updated` for each gate it closes, so an open inbox drops the card without
  a refetch.
- **C11 (Medium, D3 filter placement).** `listReviews` falls back to
  `listOpenInterruptsAll` on an adapter without the tenant query, so the loop ALSO
  skips a terminal run (the run is already loaded there, so it costs nothing).
- **C12 (Medium, D3 changes token GET after cancel).** `loadInterruptByTokenChecked`
  returns early for a resolved row under `allowResolved`, before its terminal-run
  check. After D3 a cancelled run's token GET would answer `200 {resolved:true}`
  instead of 409. **Corrected:** the terminal-run check moves ahead of the
  `allowResolved` return.
- **C13 (Medium, D2 posture change for member-less shared tenants).** A cookie,
  SAML or OIDC user on a non-personal tenant with no member row (and demo mode off)
  resolves zero scopes, so after D2 they can no longer decide an OPEN approval gate
  there. This is the same posture kanban and the agent area already have
  (`callerHoldsTenantScope`), and it is **recorded as a deliberate operator-facing
  change**: seed the member row (SAML JIT/SCIM do), or name approvers on the gate.
- **C14 (Medium, D8 `canDecide` cost).** Compute the session floor ONCE per request,
  memoize eligibility per distinct gate-ref set, and reuse the D8 access memo. Never
  per row unmemoized, or the inbox-latency incident comes back.
- **C15 (Low, D6 ledger re-key).** A vote cast before deploy on `/reviews` under an
  `oidc:` key could count again afterwards under the canonical key. The window is
  transient (open quorum gates at deploy time) and is accepted and stated.
- **Factual fixes.** The node route's enforced gate is `loadOwnedRun(…,
  'approvals:respond')` (`routes/interrupts.ts:194`), not a bare
  `requireProtocolScope`; D2's helper runs after it. The email signing is at
  `emailApprovalDelivery.ts:169`, driven from `notifications/notify.ts:120-128`
  with canonical userIds from `resolveNotificationRecipients`. For group/role gates,
  `isEligibleApprover` rule 2 matches those userIds, so emailed recipients really are
  unaffected by D4(c). `mcpControlNodes` `resolve-paused-task` is a further external
  decide lane: tenant- and workflow-allowlisted, but with no `approvals:respond`
  check. It is filed as `APWF-15`, because app-builder design gates are not approval
  kind and its caller is a run, not a person.

## Feature evaluation matrix

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package | Core surface (`core:interrupts`), not a package. No new package, and no feature imports added to core. |
| 2 | Toggle | None. This is an always-on integrity fix to a core surface. A toggle would let the fail-open path be switched back on. |
| 3 | Workflow orchestration | The resume seam is unchanged. D1 and D3 make the seam's input honest. |
| 4 | Node pack | None changed. `core.approvalGate` and `core.chat.approvalGate` already forward the fields D2 and D4 read. |
| 5 | AI-chat / envelopes | None. MCP (D5) refuses honestly. |
| 6 | Agent pack | None. This is not an AI surface. |
| 7 | Public surface | The token route stays public by design. D4 narrows what a token can do. |
| 8 | RBAC | D2 and D6. Every change is a refusal, and each gets a refuse-side test. |
| 9 | Replay / fork | Unchanged. Forked interrupts get fresh ids (`forkInterrupts.ts`), and D3's terminal filter reads the fork's own run. |
| 10 | Frontend | D10, pending clearance. |

**RFC verdict: host work, no RFC.** Every decision is host policy inside RFC 0093,
RFC 0173 §B and RFC 0223. Refusing a voterless quorum vote and requiring the
signature the host itself issued are both admissible under the quorum profile. The
v1 410 and v2 409 answers are preserved (D3).

## Alternatives weighed

- **D1: fix `SuspendManager.resolve` to return the flag and leave the call site.**
  Rejected as the only change. The flag must also stop the append and the
  dispatch, which means a call-site change either way. Calling the CAS directly
  matches the two sibling branches, so the three read the same.
- **D2: flip `OPENWOP_AUTHORIZATION_ENFORCEMENT` on.** Rejected. It changes every
  protocol route at once, and it is an operator posture, not a code fix. Kanban
  and agents set the always-on precedent at the feature boundary.
- **D3: a cancel-finalizer sweep instead of the SQL filter.** Rejected as the
  primary fix. It leaves a window, while the filter is instant and covers
  failed/completed runs with a stray open gate. The finalizer idea stays with P2.
- **D5: let MCP vote.** Rejected. MCP has no approver identity to vote AS.

## Open questions

- **Q1.** Should a named approver who holds only Viewer be able to decide on the
  node route under enforcement? The approvals lane says yes and the node route
  says no. Loosening is a widening. Deferred with this ADR's P3.
- **Q2.** Should the inbox page past 500 with a cursor (`B7`)? The D3 filter
  removes the known accumulation driver first; re-measure before building a cursor.

## Phased plan

| Phase | Scope | Status |
|---|---|---|
| P1 | D1–D8 backend + tests (each Blocker witnessed on the real route and sabotage-checked); D10 SPA if cleared | this PR |
| P2 | `APWF-9` recovery lane + `APWF-10` execution fence | Proposed |
| P3 | `APWF-11` (after the override payload fix), `-12`, `-13`, `-14`, Q1, Q2 | Proposed |

## Implementation record (P1)

| Decision | Commit | Witness (each sabotaged red) |
|---|---|---|
| D1 claim on accept + C1 timer preclaim + C2 | `27582fa4f` | `adr0778-decide-integrity` "accept that LOSES…", "row the sweep already claimed…" |
| D2 decide floor + `/reviews` scope | `27582fa4f` | `adr0778-decide-authority` "Viewer is refused…", "key narrowed to runs:read…" |
| D3 cancel closes own gates, terminal filter, v1 410 / token 409 | `27582fa4f` | "cancel resolves the run's own open interrupt…", "stray open gate on a TERMINAL run…", scan "TERMINAL run" |
| D4 token lane (no `anon-N`, full ACL, signature) | `27582fa4f` | "voterless vote…", "GROUP-only…" ×2, "REAL group member…", "voting twice counts ONCE" |
| D5 MCP refuses named-approver gates, no pre-claim | `27582fa4f` | "quorum gate is refused and stays OPEN" |
| D6 one reviewer identity | `27582fa4f` | "unbound OIDC owner … counted once" |
| D7 lazy timeout at the choke point | `27582fa4f` | "overdue gate cannot be approved…" |
| D8 batched runs, `status` default, `canDecide` | `27582fa4f`, `8edf9f3b9` | scan "ONE run read", "canDecide adds NO per-row read" |
| grade-code `APCD-1..10` (token projection, lost-claim honesty, closed-log 409, cancel containment, webhook 409, `canDecide` fidelity) | `8edf9f3b9` | "TIPS … TIMEOUT", "REJECT that loses…", "run log closes…", "failing gate close…" |
| D10 SPA (`APUX-1..11,13,17`) + closing review | `2edd799aa`, `4140ddb4b`, `0907d8fc5`, `3e52fa88e` | `ReviewCard`, `ReviewInboxPanel`, `reviewStatusStore`, `ApprovalCard.behavior` |

**Correction to D5, recorded as implemented:** MCP does not merely refuse quorum/ACL
gates. It no longer claims at all (C7), because every branch of `resolveAndResume`
now claims for itself.

**Correction to D8, recorded as implemented:** approval-source `canDecide` is stated only
for QUORUM approvals (`APCD-7`). The approvals lane finalizes a single-approver approval
before it reads the list, so stating it there would have hidden buttons from people the
server admits.

**D9 addendum:** replay forks re-deciding gates are owned by the parallel
`feat/conformance-hold-node` branch (`forkReplayResolutions.ts`), not this ADR.

**Correction to D2, found by the row-6 gate:** the always-on floor judged an `owk_` key only
by its issuer's membership. In a tenant with no member rows (the ADR 0755 D3 default
posture, pinned by `adr0755-key-lane-scopes`), that meant a key declaring
`approvals:respond` lost its resume token, which is a regression against an accepted ADR.

Reconciled in `holdsDecideFloor`:
- **Memberless tenant:** a key that EXPLICITLY declares `approvals:respond` is a responder. Membership is not the authority there, which is the same rule `emailApprovalDelivery` already applies.
- **Tenant with members:** the key is judged by its issuer, so a Viewer's key still cannot decide. Witnessed by `adr0778-decide-authority` "Viewer-issued key".
- **Undeclared (`*`) key:** never takes the memberless arm.

Both arms were sabotaged red.
