# ADR 0894 — computer-use session authority

Status: implemented (2026-10-15; Accepted after the pre-code `/architect` pass, corrected by the closing grades below)

**Date:** 2026-10-15 · **Feature:** `computer-use` (extends ADR 0418 / ADR 0541; toggle id unchanged) ·
**Origin:** feature loop round 2 row 48 (`docs/steward/FEATURE-LOOP-2026-10.md`), grade `CU2WF-1..12` in
`docs/steward/WORKFLOWS-ASSESSMENT.md` · **RFC verdict:** host-extension only. The approval rides the
existing `interrupt` primitive (RFC-accepted, interrupt.md) through the existing `ctx.suspend`; the abort
route is under `/v1/host/openwop-app/computer-use/*`; no event, capability or schema changes.

## Context

ADR 0418 shipped a browser agent whose every consequential action (a submit, a download, a new origin)
halts the session for a human. The halt exists. The human does not: the decision is a boolean surface
argument, `decide({sessionId, approve})`, and the docs ask authors to place a `core.approvalGate` before
it. No chain does, and nothing checks. Because the surface is reached from runs rather than from an HTTP
door, the authority an HTTP route would apply had to be rebuilt in the surface, and most of it was not.

Probed on `fd57d8fd1` (`backend/typescript/test/adr0894-computer-use-session-authority.test.ts`, 29 RED,
6 controls green). No live provider exists yet (ADR 0418 §P2 correction), so none of this is exploitable
in production today; every item is live the moment a provider is configured.

| Id | Finding | Where |
|---|---|---|
| CU2WF-1 | The commit approval is a boolean input. A literal `true`, or one wired from an LLM node that read page text, records `decidedBy:'human'`. | `feature.ts:78`, `computerUseService.ts:265` |
| CU2WF-2 | `decide`/`status` resolve a session by tenant only: another org's run, or a peer in the same org, decides or reads the opener's session. | `feature.ts:78-84`, `sessionStore.ts:83` |
| CU2WF-3 | The submit-once hash omits the opener, so two people's identical tasks are one session (and one apply grant). | `sessionStore.ts:71`, `computerUseService.ts:150` |
| CU2WF-4 | An apply grant matches `subjectId + campaignId` only; `applyContext` is caller input. A peer auto-submitted under the opener's grant. | `host/applyGrant.ts:266` |
| CU2WF-5 | Starting needs `workspace:read`; an empty `orgId` skips the floor; a run with no person drives a browser. | `feature.ts:66-70`, `featureSurfaces.ts` floor |
| CU2WF-6 | No SSRF floor: metadata, loopback, RFC 1918/ULA, `*.internal`, `*.local`, the app's own origin are accepted. | `computerUseService.ts:72` |
| CU2WF-7 | No recheck after start; membership loss leaves the session live and resumable. | `computerUseService.ts` `advance` |
| CU2WF-8 | Credential entry is offered for approval; no broker exists to supply one. | `adapter.ts:37` |
| CU2WF-9 | No wall-clock ceiling (ADR 0418 §5 promised one) and no way for a person to stop a session. | `computerUseService.ts:31` |
| CU2WF-10 | The detail route returns `providerSessionId`, a hosted-browser handle. | `routes.ts:40` |
| CU2WF-11 | No DSAR eraser (recorded debt). | `subject-erasure-feature-stores.test.ts` |
| CU2WF-12 | The HITL chain the feature describes is not shipped. | — |

### What the market does (the competitive bar)

`docs/steward/GAP-SWEEP-2026-07.md` §3 row 1 is the analysis this feature was built from (no
`docs/research/` deep-dive exists for the domain). The vendors it names converge on one posture, stated in
their own operator guidance: the agent asks before every consequential action and the person confirms that
action specifically; the person can stop or take over at any moment; the agent works inside a site list;
it never handles the person's credentials (the person takes over to log in); and page content is treated
as untrusted input that cannot change the task. Our ADR 0418 matches that posture on paper. This ADR makes
the mechanism match the paper. "Take over" (handing the live browser to the person) needs a real provider's
live-view API and stays with the provider gate (§Deferred).

## Boundaries audit

- **Approval owner:** the run `interrupt` primitive. A pack node raises one with `ctx.suspend`
  (`executor/suspendSignal.ts`); the executor persists it (`InterruptRecord`, `node.suspended` carries its
  `interruptId`, `executor/executor.ts:2660`); the ONE resolve path (`routes/interrupts.ts`) authorises the
  resolver and CAS-resolves it (`storage.resolveInterrupt`, ENG-6). No new approval flow, no new store
  (ADR 0418 §2 "never a new approval flow" holds).
- **Org authority owner:** `assertRunScopeOrg` (`host/accessControlService.ts:683`) — the predicate the
  seam floor and the HTTP doors share — plus the surface `orgPolicy.methodScopes` (`featureSurfaces.ts`).
- **Revocation owner:** `onMemberAuthorityLost` (`accessControlService.ts:1135`), the hook member removal
  already runs.
- **SSRF owner:** `isDeniedWebhookHost` (`host/webhookEgressGuard.ts:242`), the predicate every egress
  guard shares.
- **Public base URL owner:** `publicBaseUrl` (`features/featureRoute.ts:187`).
- **Grant owner:** `host/applyGrant.ts` `consultApplyGrant`; extended with two optional narrowing filters.
- **Erasure owner:** `registerSubjectEraser` + `EXPECTED_SUBJECT_ERASERS` (`host/subjectEraserManifest.ts`).
- **No new toggle, store, capability, envelope or event.** One new host-ext route (abort); one new chain
  pack (`core.openwop.workflows.computer-use`).

## Decision

- **D1 — start authority.** `startTask` requires (a) a person — `scope.actingUserId`, never the
  `run:<id>` fallback; a run with no person is refused `forbidden` (403); (b) a non-empty `orgId`
  (`validation_error`); (c) `runs:create` in that org, declared as `orgPolicy.methodScopes.startTask`, so
  the seam asks it instead of `workspace:read`. `runs:create` is what `POST /runs` asks; a browser session
  is a run's worth of authority.
- **D2 — a session answers its opener, in its org.** `decide` and `status` load the row first and then
  apply the authority to the ROW's org, never to a caller argument: a caller without `workspace:read` in
  `session.orgId` gets the same 404 as a missing session (no existence oracle). `decide` additionally needs
  `runs:create` there and `actingUserId === session.createdBy`; anyone else gets 403. `status` stays an org
  read (a teammate may watch). The submit-once hash includes `createdBy` and the normalised `applyContext`,
  so two people never share a session and a context change is a new session.
- **D3 — approve is a human's resolution of THIS action, used once.** The `decide` node no longer takes
  `approve` from its inputs. It reads the session; if a commit action is pending it raises an `approval`
  interrupt itself, via `ctx.suspend`, with `resumeKey = cu-approve:<sessionId>:<actionId>` and host-composed
  data: `prompt` ("Allow the browser agent to <kind> on <origin>?"), `computerUse: {sessionId, actionId,
  kind, origin}`, and the provider's description in a separate `providerNote` field, labelled and
  truncated, never in `prompt` (page text must not be the instruction a human reads). On resume it calls
  `decide({sessionId, approve, nodeId})`. The surface then, for `approve: true`, verifies in the run's own
  record that an interrupt raised by THIS node (`node.suspended` events for `scope.runId` + `nodeId`) has
  `kind:'approval'`, `data.__resumeKey` equal to the key above, `__resumeStyle:'reinvoke'`, is resolved,
  and resolved to `accept` (`normalizeApprovalAction`); and that the node at `nodeId` in the run's
  resolved definition is `feature.computer-use.nodes.decide`. Anything short of that is `approval_required`
  (409). The interrupt id is stored on the step (`approvalInterruptId`) and in `session.consumedApprovals`,
  and a second use is refused. **Deny needs no interrupt** — the safe direction is always available to the
  opener. The node loops: after an approval, if the session halts at another commit, it suspends again with
  the new key (re-invoke semantics give each action its own key), bounded by the session step ceiling.
- **D4 — every advance rechecks; losing membership ends the session.** `advance` starts by re-resolving the
  opener's access in `session.orgId` (`resolveEffectiveAccess`) and the toggle (`resolveOne`); either
  missing aborts the provider session and ends the row `aborted` with `opener_revoked` / `feature_disabled`.
  `onMemberAuthorityLost('computer-use', …)` ends the subject's live sessions in that org the moment the
  removal lands, so a halted session is not left resumable. (Demotion that drops `runs:create` without a
  removal is caught by the per-advance recheck.)
- **D5 — SSRF floor.** `parseAllowedOrigins` refuses a host `isDeniedWebhookHost` denies, any `.internal` /
  `.local` / `.localhost` name, and the app's own `publicBaseUrl()` origin. The same predicate runs on
  `startUrl` and on every provider-reported URL (a denied URL fails the session closed, as off-allowlist
  does). A public NAME that resolves to a private address is the hosted provider's network, not ours; it is
  recorded residue (`CU2-R1`), to be closed by the provider adapter's own egress pin when one exists.
- **D6 — credential entry is refused.** A `credential` action denies + aborts and ends the session
  `failed: credential_entry_unsupported`; it is never offered for approval. ADR 0418 §2's broker lane is the
  only way credentials will ever enter, and it does not exist.
- **D7 — a grant authorises its grantor, in its org.** `ConsultInput` gains optional `orgId` and
  `grantedBy` filters; computer-use passes `session.orgId` and `session.createdBy`. Other callers are
  unchanged (additive).
- **D8 — wall-clock ceiling and abort.** A session older than `OPENWOP_COMPUTER_USE_MAX_SESSION_MIN`
  (default 60) is aborted on its next advance or decide (`aborted: wall_clock_ceiling`). New route
  `POST …/computer-use/orgs/:orgId/sessions/:sessionId/abort` (toggle + `runs:cancel` in the org, the
  scope that cancels a run; uniform 404 across orgs) aborts the provider session and ends the row
  `aborted: aborted_by_user`. New terminal status `aborted`. Stopping is the safe direction, so any
  `runs:cancel` holder in the org may stop any session there, as with runs.
- **D9 — projection + erasure.** The detail route returns a closed projection (no `providerSessionId`,
  no `consumedApprovals`, mock scripts masked). `features/computer-use/erasure.ts` registers
  `eraseComputerUseSubject`: for rows whose `createdBy` or `applyContext.subjectId` is the subject, it
  tombstones those ids (`ERASED_SUBJECT_SENTINEL`) and drops the free text (`task`, `resultSummary`,
  `error`, each step's and the pending action's `description`), keeping kind, URL origin, tier,
  `decidedBy`, timestamps — the audit of what was done, where, under whose authority (ADR 0541 D5) without
  the person. Joins `EXPECTED_SUBJECT_ERASERS`; leaves `RECORDED_DEBT` (ceiling shrinks).
- **D10 — ship the chain.** `examples/workflow-chain-packs/computer-use` (`core.openwop.workflows.computer-use`
  1.0.0): `computer-use.run-task` = `task → decide`. It is the gallery / `/`-picker way to run a browser task
  with approvals. `career.apply` is unchanged: its law is "neither chain submits"; its sessions are decided by
  a grant or end at the wall-clock ceiling / abort (recorded, `CU2-R2`).

### Node pack

`feature.computer-use.nodes` 1.0.2 → **1.1.0** (`decide` contract change; typeId versions unchanged so
existing builder workflows keep resolving — an old workflow that wires `approve: true` now suspends for a
human instead of approving, which is the fix). `requiredPacks` bumped in `feature.ts`. The node's
`description` stops telling authors to compose `core.approvalGate`.

## Pre-code `/architect` pass (2026-10-15) — folded into the decisions above

Track A (host only). Each finding was checked against the code, not the ADR text.

- **A1 (Blocker) — D3 as first written bound the approval to the ACTION but not to a PERSON.** The
  interrupt resolve route (`routes/interrupts.ts:204`) asks `approvals:respond` through `loadOwnedRun`, and
  an approval with no `approverRefs` is an OPEN gate (`:966`): any editor in the tenant could approve the
  opener's commit, including one in another org. **Fix:** the decide node's interrupt carries
  `approverRefs: [session.createdBy]`, so the existing ADR 0075/0198 eligibility check
  (`isEligibleApprover`, canonicalised to userIds) admits only the opener or the opener's own declared
  delegate. The surface verification also requires the RECORDED `data.approverRefs` to be exactly
  `[session.createdBy]`, so a re-shaped interrupt cannot pass.
- **A2 (High) — other in-process resolvers.** `resolveAndResume` is also called by the inbound-messaging
  lane (`connections/inboundWebhooks.ts:719`, value `{message, source}`) and the app-builder MCP node
  (allowlisted to app-builder gates, `mcpControlNodes.ts:197`). Neither can produce an `accept` here: the
  messaging value has no top-level `action`, and the MCP node refuses non-app-builder gates. The
  verification reads the RECORDED `resolvedValue.action` at top level, so this holds by construction, not
  by those callers' good behaviour.
- **A3 (High) — the recheck must use the run-lane predicate, not raw `resolveEffectiveAccess`.** A
  personal workspace's owner is implicit (no member row; `assertOrgScope`'s personal-owner short-circuit),
  so a raw access read would abort EVERY personal-workspace session as `opener_revoked` — the "fail-closed
  seam locks out anon" class. **Fix:** D4 rechecks with `assertRunOrgScope(tenantId, createdBy, orgId,
  'runs:create')`, the same predicate D1 starts with.
- **A4 (Medium) — the membership hook's `reason`.** `demoted` fires only for losing `host:members:manage`.
  **Fix:** the hook ignores `reason` and re-runs the D4 predicate for each of the subject's live sessions
  in that org; it ends only those that fail it.
- **A5 (Medium) — ending a session with no provider configured.** `resolveAdapter()` throws
  `capability_not_provided` in production today. Abort paths (hook, ceiling, route) end the ROW even when
  the provider call cannot be made, and log it; a row must never stay live because its provider is gone.
- **A6 (Medium, stated) — an opener without `approvals:respond`** (a custom role with `runs:create` only)
  can deny but not approve its own commits: the resolve route refuses them. Fail-closed and intended.
- **A7 (Low) — migration.** The hash now includes `createdBy`, so a pre-change row is never re-resolved by
  a new start. No production rows exist (no provider has ever been configured); test rows are per-run.

## Closing-grade corrections (2026-10-15, `/grade-code` + `/grade-ux` on the implementation)

Recorded as corrections, not rewrites: each overturns or extends a sentence above.

- **C1 — A1 was false on the capability-token lane (`CU2CD-2`, High).** "Only the opener (or the opener's
  declared delegate) is eligible" holds on the signed-in lane. On the token lane
  (`POST /interrupts/{token}`, `assertTokenQuorumVote`) a single-approver gate with a declared ACL admits any
  body `voter` that is eligible, unsigned (`requiredApprovals === 0` skips the binding — host residue
  `ISWF-23`), and the listing hands the token to every `approvals:respond` holder. A peer editor could post
  `voter: <opener>`. **Fix:** a resolution carrying `voter` never authorises a commit
  (`approvalBinding.ts`). The opener's emailed decide-link is refused with it; they approve signed in.
  Probed through the real token route.
- **C2 — "task → decide" assumed the provider is never still working (`CU2CD-1`, High).** With a real
  provider the first poll usually has no action; `decide` looped only on `awaiting_approval`, so the chain
  ended and stranded a billed session. **Fix:** a `resume` surface method; `decide` polls a running session
  and waits on a `duration` timer keyed by the session's idle count between polls.
- **C3 — lifecycle writes were blind puts (`CU2CD-3/4`).** A stop could be overwritten by an in-flight
  advance, and two concurrent decides could spend one approval twice. **Fix:** every write is a revision
  CAS (`writeSession`); `endSession` CAS-loops; an approve claims before it tells the provider.
- **C4 — D8's ceiling did not bound a forgotten approval (`CU2CD-5`), and there was no visible stop
  (`CU2UX-2`).** **Fix:** sessions record `runId` and end with their run in any terminal state
  (`onAnyRunTerminal`), so the run's Cancel IS the stop; a 5-minute reconciling sweep ends ceiling-expired
  and orphaned live sessions. This also closes residue `CU2-R2` (career.apply sessions end with their run).
- **C5 — D2 had a personless read (`CU2CD-6`).** A run with no person passes the org floor
  tenant-trusted; `status`/`decide` now 404 for it.
- **C6 — the approval card showed only the English prompt (`CU2UX-1/5`).** `GateEvidence` renders the
  action and site, the page-derived note apart under "Unverified", and the opener-only line; reject copy
  says it ends the session. Four locales.
- **C7 — retention (`CU2CD-8`).** Finished rows age out after 180 days (`registerKvAgeOut`, marker-aware).

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| Probes RED on `fd57d8fd1` (29 red, 6 controls) | `106161bb1` | `adr0894-computer-use-session-authority.test.ts` |
| P1–P3 (D1–D10) | `d8d9da528`, `a82cb1261` | same file + `computer-use.test.ts`, `apply-grant-commit-gate`, `career-apply-chain-gate`; 13 fixes sabotaged red |
| Closing-grade corrections C1–C7 | `12ce2a4f2` and the follow-up commits on the branch | 12 more probes (54 total), FE `browserActionGate.test.tsx`; C1–C4 sabotaged red |

Residue still open: `CU2-R1` (DNS names resolving private — provider egress), `CU2-R3` (no resolver subject
on `InterruptRecord`), `CU2-R4` (trajectory viewer / screenshots / take-over with a live provider), and the
host-wide `ISWF-23` token-lane binding, which this feature now refuses rather than fixes.

## Addendum (2026-10-15, team-lead review notes received after #4831 merged)

Four gaps against the review's notes, each probed RED on `d3495f816`+ and closed:

- **G-A — the approval binds the exact action.** It was keyed on (session, provider-chosen action id); a
  provider re-issuing an id for a different target would ride it. The key and the recorded
  `computerUse.digest` now carry `sha256(kind, url, description)`; the surface recomputes it from the
  pending action. A changed action raises a NEW approval.
- **G-B — a signed-in human.** An anonymous principal (`session:` / `anon:`) can no longer start a session,
  so no anonymous principal is ever the opener, and therefore never the gate's sole eligible approver. The
  other non-human lanes were already refused, now pinned: an anon cookie resolver fails the ACL check,
  MCP refuses ACL'd gates (`needsNamedApprover`), the inbound-messaging value has no top-level `action`, and
  a token-lane `voter` is refused (C1).
- **G-C — resolve, don't just name.** Allowlist names are resolved with `dns.lookup` (all addresses) and
  judged by the SAME predicate (`isDeniedWebhookHost`) at start and on every advance (DNS rebinding ends the
  session `origin_resolves_private`). A failed lookup is not a refusal (the provider may resolve
  differently); a denied address always is. Redirect hops are the provider-reported URLs, re-checked every
  step. Residue CU2-R1 narrows to rebinding between this check and the provider's own connection.
- **G-D — the credential refusal is visible.** A session that ends on a credential step now FAILS its
  node with `credential_entry_unsupported` and a plain message, so the run fails and the completion card
  shows it (it used to complete quietly). The chain description says sign-in sites are unsupported. No
  broker is built.

**Addendum 2 (same day, team-lead conditions on A and B).**
- **A, corrected — the digest is of exactly what the approver SAW.** G-A hashed the full description and
  URL while the card showed only the site and a 280-character note, so the digest covered text the human
  never read. Now the host projects the shown action (`shownAction`: kind, full URL, site, note truncated
  for display); the decide node copies it VERBATIM into the approval; the card renders the full URL as well
  as the site; and the digest is `sha256(kind, url, shown note)`. Verification re-reads the RECORDED fields
  the card rendered, requires them to equal the shown action, and recomputes the digest from them.
- **B, one pinning probe per non-human lane:** an anonymous caller (no session) is refused by the resolve
  route; the inbound-messaging lane (`resolveAndResume({message, source}, capabilityToken)`) records no
  commit; the MCP lane refuses the gate up front (`needsNamedApprover` is true for it); a system resolution
  (the timeout sweep's `{action:'reject', reason:'timeout'}`) is never a verified approval. These four pin
  existing host behaviour — each holds through a host gate this ADR did not write — so a regression there is
  caught here.

Deliberate deviation kept (note 5, accepted by the team-lead): the approval is a real `approval` interrupt raised by the decide node
via `ctx.suspend`, not a separate `core.approvalGate` node — a separate node can be deleted or rewired in the
builder, which is the defect this ADR exists to close.

## Alternatives weighed

- **Keep `core.approvalGate → decide` and have `decide` check that a gate ran before it.** Rejected: the
  gate's resolution is not tied to the action (an author can place any gate anywhere, with any prompt), and
  "a gate resolved somewhere earlier in the run" is exactly the kind of ambient proof that a re-ordered chain
  defeats. The node raising its own interrupt makes the action and the approval one record.
- **Route the approval through the approvals inbox (`PendingApproval`, the commerce-spend pattern).**
  Viable and strong (decider recorded, anti-double-vote). Rejected for now: a browser task is an in-flight
  run, which is what `interrupt` is for (approvalService's own header draws this line), the run's chat card
  is where the person already is, and it needs a new approval kind + redactor + renderer. The interrupt
  route already authorises the resolver.
- **Sign a one-time approval token into the interrupt.** Rejected: interrupt data is readable by the run
  (any node can read the status), so a token there proves nothing a resolved interrupt does not.
- **Self-hosted browsers so we control egress.** Out of scope (ADR 0418 alternatives).

## Residue (recorded, not hidden)

- `CU2-R1` — DNS names that resolve to private addresses are checked only by name here; the provider's
  egress pin closes it when a provider lands.
- `CU2-R2` — `career.apply` sessions that halt have no decide path (that chain's law); they end by grant,
  ceiling or abort. **CLOSED by C4:** they now end with their run.
- `CU2-R3` — the interrupt resolution records no resolver subject (`InterruptRecord` has none); the step
  records the interrupt id, and the resolve route's authorisation is the subject check. A resolver id on the
  record is an `interrupt.md` change, not host work.
- `CU2-R4` — the trajectory viewer, screenshots-as-media and "take over" stay gated on a live provider
  (ADR 0418 §P2).

## Phased plan

| Phase | Scope |
|---|---|
| P1 | D1, D2, D5, D6, D7 (surface + service + applyGrant filters) |
| P2 | D3 (node 1.1.0 + verification) + D10 (chain) |
| P3 | D4 (recheck + hook), D8 (ceiling + abort route), D9 (projection + eraser) |
| P4 | FE: the abort action where sessions are listed; the approval card shows `computerUse` kind/origin (grade-ux decides scope) |

## Open questions

- OQ-1 — Should `status` be opener-only? Decided no: teammates watching a session is useful and the row is
  org data; the projection is closed.
- OQ-2 — Default wall-clock ceiling: 60 min. Provider sessions bill by the minute; an hour bounds a forgotten
  approval.
