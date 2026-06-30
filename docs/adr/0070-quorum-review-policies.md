# ADR 0070 - Multi-approver and quorum review policies

**Status:** implemented  
**Date:** 2026-06-18  
**PRD:** `docs/ai-chat-a-plus-prd.md`  
**Depends on / composes:** `routes/interrupts.ts`, `executor/approvalGateTimeout.ts`, `host/approvalService.ts`, ADR 0068 (Unified review projection), ADR 0006/RFC 0049 (RBAC), `workflowTemplates.ts` approval templates.  
**Surface:** runtime interrupt approval policy and approval-service policy, projected through `/v1/host/openwop-app/reviews/*`.  
**RFC gate:** advertise quorum only when the behavior is implemented and covered. If desired policy fields are not already specified by OpenWOP, author or amend an RFC before discovery claims support.

## Why this exists

Enterprise HITL is rarely a single button from a single user. Common policies require two approvers, a manager plus compliance, first-response-wins, any N of M, timeout fallback, or privileged override. The app already has sequential approval templates and single pending approval CAS behavior, but it should not advertise quorum until the runtime can honor it under concurrent decisions and stale UI actions.

> **Correction note (2026-06-18, chat-surface plural-interrupt fix):** the
> "single pending approval" limitation above was, on the frontend, also a
> *rendering* limitation — the chat surface modeled `ChatMessage.activeInterrupt`
> as a single slot, so a workflow that fanned out into several concurrent
> approval gates (e.g. the `multi-channel-content-review` template's parallel
> legal/brand/risk reviews) only ever showed one card and stranded the rest,
> leaving the run stuck. That is now fixed independently of this ADR: the chat
> surface renders **one interrupt card per concurrent open interrupt**
> (`activeInterrupts: OpenInterrupt[]`), each resolvable on its own node. This
> removes the *UI* obstacle to simultaneous-reviewer workflows; the *runtime*
> concurrency/CAS guarantees this ADR specifies (one final state under
> concurrent approve/reject) remain the open work here.

## Feature-refinement audit

| Concept | Existing owner | Decision |
|---|---|---|
| Runtime approval interrupt | OpenWOP interrupt machinery | Extend with policy metadata and a decision ledger where spec-covered. |
| Pre-execution approval | `approvalService` | Extend with policy metadata only for proposal gates that need quorum. |
| Review display | ADR 0068 projection | Show policy and individual decisions from the source owner. |
| Role/scope checks | Access control service/RFC 0049 | Use existing scopes and org membership; no new identity model. |
| Timeout | `approvalGateTimeout.ts` | Reuse for runtime gates; add equivalent service sweep only if approvals need due dates. |

## Decision

Add a policy and decision-ledger model that can be attached to runtime interrupts and pending approvals without changing their ownership.

```ts
interface ReviewPolicy {
  approverRefs?: string[];
  approverGroupRefs?: string[];
  requiredApprovals: number;
  rejectionPolicy: 'any_rejects' | 'majority_rejects' | 'all_must_reject';
  overrideScopes?: string[];
  dueAt?: string;
}

interface ReviewDecision {
  decisionId: string;
  reviewId: string;
  reviewerRef: string;
  outcome: 'approved' | 'rejected' | 'override_approved' | 'override_rejected';
  note?: string;
  decidedAt: string;
}
```

The final source record transitions exactly once when policy is satisfied. Individual decisions are append-only. Duplicate decisions by the same reviewer are either rejected or replace only that reviewer's prior pending vote according to a documented policy; they never create two counted votes.

## Concurrency invariant

The final transition must use compare-and-swap or an equivalent conditional write. In-process serialization is not enough for multi-instance deployments. If the durable store cannot provide cross-instance CAS for the ledger and final transition together, route behavior must fail closed and discovery must not claim quorum support.

## Authorization

- Eligible approvers are resolved at decision time, not trusted from the client.
- Unknown reviewers, removed org members, and expired delegations are denied.
- Override requires an explicit scope and is audited as override, not normal approval.
- A non-eligible caller gets 404 if the review is not visible, 403 if visible but not actionable.
- Reviewer refs are opaque subject refs and must not expose provider-specific PII.

## Phased plan

1. **Policy parser.** Normalize runtime interrupt policy and approval-service policy into one internal shape.
2. **Decision ledger.** Add append-only decision records for approvals first, then runtime interrupts if the wire shape permits.
3. **Finalizer.** Implement policy evaluation plus single final transition under CAS.
4. **Timeout and override.** Add due-date handling, timeout outcomes, and override scopes.
5. **Review projection.** Expose policy progress through ADR 0068 cards.
6. **Discovery.** Update discovery only after route tests and conformance evidence pass.

## Acceptance criteria

- `requiredApprovals: 2` cannot resolve after one normal approval.
- Concurrent approvals produce exactly one final state.
- Rejection policy is honored under concurrent approve/reject races.
- Non-approvers cannot vote.
- Removed members cannot vote after removal.
- Override decisions are separately visible and audited.
- Timeout produces the configured fail-closed or escalation outcome.
- Discovery does not claim quorum before these tests pass.

## Test plan

- Route-level concurrency tests for simultaneous approve/approve and approve/reject.
- Authorization tests for non-approver, removed member, tenant mismatch, and override scope.
- Stale UI test for a second click after final resolution.
- Timeout tests for runtime gate and service approval due dates.
- Discovery honesty test under `OPENWOP_REQUIRE_BEHAVIOR=true`.

## Alternatives considered

- **Sequential approval nodes only.** Useful but insufficient for true quorum and simultaneous reviewer workflows.
- **Model quorum only in the frontend.** Rejected because policy satisfaction and stale safety must be server-authoritative.
- **Put every policy in `approvalService`.** Rejected because runtime interrupts and pre-execution approvals have different owners and lifecycles.

## Open questions

- Do we need group approvers in v1, or only explicit subject refs?
- Can an approver change their vote before quorum is reached?
- Should timeout reject, escalate, or leave pending by default?
- Which OpenWOP RFC currently owns quorum fields, and where are conformance scenarios expected to live?

## Implementation record

Phases 1–5 landed for **runtime-interrupt** quorum (the existing mechanism). Pre-execution `approvalService` quorum and the discovery claim (Phase 6) are deferred. *(Update — `approvalService` quorum AND the discovery claim have since landed; see the two correction notes below. The discovery flip required two conformance-driven eligibility/identity fixes. Only the live INTEROP-MATRIX witness — which needs a deploy + steward verification — remains deferred.)*

| Phase | Change |
|---|---|
| 1–2 Durable ledger | `host/reviewDecisionLedger.ts` — a durable `DurableCollection<ReviewDecision>` keyed `(interruptId, reviewerRef)` REPLACES the in-memory `quorumVotes` Map in `routes/interrupts.ts`. Overwrite-by-reviewer is the dedup (a reviewer counts once); the tally is computed from the durable rows (cross-instance correct, survives restart). |
| 3 Finalizer | `recordQuorumVote`/`tallyVote` rewritten over the ledger (async). The single final transition stays `storage.resolveInterrupt` (conditional CAS — one winner). A re-vote re-evaluates from the durable truth, so a crash between append and resolve self-heals on the next vote. |
| 2/4 Eligibility + override | New `assertEligibleApprover`: when the caller is AUTHENTICATED, the vote identity is the session subject (`req.userId`/`principal`) — **never the client `voter`** — and eligibility is enforced (on `approverRefs`/`approversList`, else the `approvals:respond` scope; override needs a gate `overrideScope`). Visible-but-ineligible → 403. The `core.approvalGate` node forwards `approverRefs`/`overrideScopes` config. |
| 5 Review projection | `host/reviewProjection.ts` surfaces `policy { requiredApprovals, approvals, rejections }` on a quorum interrupt review (from the ledger); `ReviewCard` renders an "N of M approved" chip + meter. |

**Corrections / decisions vs the plan:**
- *Identity (the central fix):* the vote identity comes from the authenticated session, NOT `resumeValue.voter`. The legacy signed-token path (RFC 0093, anonymous — the token IS the capability) keeps `voter`-from-body, so the existing conformance/token tests stay green; eligibility is enforced only when an authenticated reviewer is present.
- *Concurrency invariant:* the durable ledger is the source of truth; the final transition is CAS; finalize-if-met is re-driven idempotently on each vote. Two concurrent quorum-meeting votes both call `resolveInterrupt`; exactly one wins. (Read-path finalize re-drive needs `hostSuite` in the interrupt routes — deferred; subsequent-vote recovery is the v1 path.)
- *RFC gate:* NO new RFC — the quorum fields are already RFC 0093; the ledger + eligibility are host-internal; the resume value shape is unchanged. **Discovery still does NOT claim `openwop-interrupt-quorum`** — the honest stance, since conformance evidence lives in the separate `../openwop` repo. The host BEHAVIOR is implemented + route-tested; the wire CLAIM waits for that evidence.
- *Scope:* v1 = runtime-interrupt quorum. Pre-execution `approvalService` quorum is a real follow-on (it has a single-decision CAS, no multi-decider model) — a different owner/lifecycle, not built here.

**Correction — `approvalService` quorum landed (follow-up item 3):** the
pre-execution approval quorum deferred above is now implemented, reusing the SAME
durable ledger rather than a parallel one. The ledger was generalized from
interrupt-only to **gate-generic** (`ReviewDecision.interruptId` → `gateId`, keyed
`${gateId}:${reviewerRef}`), so a pending-approval id (`appr:<uuid>`) and an
interrupt id (`int-…`) share one `review:decision` collection + tally. In
`host/approvalDecision.ts`, `evaluateQuorum(ctx, approval, outcome)` runs FIRST in
both `claimApproval` and `rejectApproval`: when `policy.requiredApprovals > 1` a
claim/reject is an eligibility-checked VOTE (`appendDecision` keyed by
`approvalId`), the gate returns `{ status: 'pending', policy }` with no handler
dispatch / run start, and only the vote that meets the threshold falls through to
the existing single-decision finalize (content-publish handler / assistant-action
handler / run-proposal CAS — unchanged). Identity is the authenticated `decidedBy`
(403 if absent on a quorum gate); eligibility is the explicit `policy.approverRefs`
list, else the `approvals:respond` scope via `resolveEffectiveAccess`. Rejection
threshold honors `rejectionPolicy: 'majority'` (else a single reject fails the
gate). `host/reviewProjection.ts` surfaces the same `policy { requiredApprovals,
approvals, rejections }` on an approval-source review (`withApprovalQuorumPolicy`),
so `ReviewCard`'s "N of M" chip works for approvals too. The approval/claim/reject
route responses pass `policy` through when present.

- *Why one ledger, not two:* a second decision store for approvals would drift
  from the interrupt one and duplicate the dedup/tally logic — the boundary fix is
  to make the existing ledger gate-agnostic (it never parses keys; rows carry their
  own ids). `clearDecisions` is intentionally NOT called on resolve — orphan rows
  are harmless (an `approvalId`/`interruptId` is unique and never re-tallied once
  the source record is resolved).
- *Byte-unchanged guarantee:* the quorum gate is a no-op when `policy` is absent or
  `requiredApprovals <= 1`, so a single-decision approval resolves on the first
  vote exactly as before — the 40 existing approval/CAS/CMS/assistant-action tests
  stay green.
- *RFC gate:* still NO new RFC — `approvalService` and its routes are
  non-normative host-extension surface (`/v1/host/openwop-app/*`); no wire field,
  capability, or event changes. The discovery claim is still NOT flipped (item 4,
  below).
- *New tests:* `backend/test/approval-quorum.test.ts` — vote accumulation +
  progress, dedup (a reviewer votes twice → 1 of 2), eligibility (off-list approver
  → 403, unauthenticated vote → 403), and quorum-met → the finalize fires exactly
  once (content-publish handler). `createContentApproval`/`createApproval` gained an
  optional `policy` for seeding.

**Correction — discovery claim FLIPPED, after two conformance-driven fixes
(follow-up item 4):** running the `../openwop` `interrupt-quorum-resolution`
conformance scenario against this host (in-process, `OPENWOP_REQUIRE_BEHAVIOR=true`)
surfaced TWO ways the original ADR 0070 eligibility/identity model contradicted the
`openwop-interrupt-quorum` wire contract. Both are now fixed and the scenario
passes (3 accepts → `completed`; 2-of-3 majority reject → terminal non-completed):

1. *Empty approver list = OPEN gate, not scope-gated.* The fixture
   (`conformance-interrupt-quorum`) has an empty `approversList`; ADR 0070's
   `assertEligibleApprover` required the `approvals:respond` scope when no explicit
   list was present, so the API-key conformance caller 403'd. Fix: an empty
   `approverRefs`/`approversList` is an OPEN quorum gate — any authenticated
   reviewer may vote (still identity-deduped). The quorum profile is pure
   vote-COUNTING; per-subject ACL is the separate `openwop-interrupt-auth-required`
   profile (still not claimed). Explicit-list gates enforce membership exactly as
   before (`quorum-review.test.ts` stays green).
2. *Capability-token transport keeps `voter`-from-body.* The scenario casts three
   DISTINCT votes (`voter: approver-1/2/3`) over ONE API key. ADR 0070 derived the
   vote identity from `req.userId ?? req.principal.principalId`, so all three
   collapsed to the single bearer principal → the durable ledger deduped them to
   one → quorum never met. Fix: the pinned (anti-spoof) identity is the
   authenticated USER session (`req.userId`) ONLY; a bare API-key/bearer principal
   with no user session IS the RFC 0093 capability-token transport, where the token
   authorizes access and the body `voter` declares the approver — so we leave
   `reviewerRef` undefined and `recordQuorumVote` counts the distinct body voters.
   This is exactly the "the legacy signed-token path keeps voter-from-body" stance
   the original note asserted; the bug was the node route eagerly pinning the
   bearer principal. Real UI votes (cookie session → `req.userId`) keep the strong
   pinned-identity + eligibility path.

**Correction — quorum-vote authorization hardened (code-review HIGH/MEDIUM):** the
fix above ("no `userId` ⇒ capability-token path, use body `voter`") was initially
written as `reviewerRef = req.userId`, which dropped eligibility for **every**
principal lacking a bound user — including the **anonymous cookie sessions** that
the (non-bearer-enforced) prod deploy auto-mints for every visitor. Because the
node route (`POST /v1/runs/:runId/interrupts/:nodeId`) has **no per-run owner
check** (`getInterruptByNode` is not tenant-scoped), eligibility was the only
authorization on a quorum vote — so an anon caller could vote (and forge distinct
`voter` ids to meet quorum alone). Reworked into three explicit tiers in
`resolveAndResume`:
1. **Bound user** (`req.userId`) → pin identity + `assertEligibleApprover`
   (unchanged; the UI path).
2. **RFC 0093 capability token** — the signed-token route (`POST
   /v1/interrupts/:token`, cryptographically matched to the interrupt) and a
   `bearer:`-prefixed API-key principal (`middleware/auth.ts`) → `assertTokenQuorumVote`:
   the token authorizes access and the body `voter` declares the approver, BUT it
   MUST name a listed approver when the gate sets an explicit `approverRefs`
   (closes the MEDIUM — a single token can't satisfy a *restricted* N-gate with
   fabricated voters). An OPEN (empty-list) gate admits any `voter`, matching the
   conformance contract.
3. **Anon / no identity** → a quorum vote **fails closed (403)**.

The capability-token signal is a `bearer:` principal id (the API-key path) or the
signed-token route's verified token; the `__resolveAndResumeForTests` seam resolves
as `capabilityToken: true` (it simulates that route). New regression tests in
`quorum-review.test.ts` assert an anon caller is rejected on BOTH an
explicit-`approverRefs` gate and an OPEN gate — the coverage gap that let the
original over-broad relaxation through. The quorum conformance scenario stays green
(the api-key caller is a `bearer:` capability token → open gate → distinct body
voters count).

`routes/discovery.ts` now advertises `openwop-interrupt-quorum` in
`interrupts.profiles`. The `interrupt`-family conformance scenarios (quorum,
cascade-cancel, external-event, token-matrix/lifecycle — 32 tests) all pass
non-vacuously against the host.

- *Why these fixes are safe:* an open-gate vote is still far stronger than the
  pre-0070 in-memory spoofable counter (real identity from the user OR the trusted
  capability token, durable cross-instance dedup); no existing test asserted the
  empty-list→scope behavior; the explicit-`approverRefs` eligibility path (the one
  the UI uses) is unchanged.
- *INTEROP-MATRIX entry deferred (correctly):* the `../openwop/INTEROP-MATRIX.md`
  `openwop-app reference` rows require a DEPLOYED revision + steward curl-witness +
  a non-steward second witness ("live + strict-verified"). This behavior is on a
  branch, not deployed — adding a "live" matrix row now would be a false claim. The
  matrix witness lands post-merge/post-deploy.

**Correction — quorum finalize math consolidated to one owner (architecture review):**
the threshold + rejection math had drifted into TWO copies — `routes/interrupts.ts`
`tallyVote` and `host/approvalDecision.ts` `evaluateQuorum` — that DISAGREED on the
default-rejection case (the interrupt path only failed on `rejectionPolicy:
'majority'`, so a single reject on a default-policy gate never resolved; the
approval path failed on a single reject). Both now call ONE function,
`evaluateQuorumTally(tally, { requiredApprovals, rejectionPolicy })` in
`host/reviewDecisionLedger.ts` (the ledger already owns the tally), returning
`accept | reject | pending`. The divergence is resolved in favor of **`'any'` as
the default rejection policy** (one reject vetoes; `'majority'` ⇒ `floor(n/2)+1`),
applied uniformly to both surfaces — a single deterministic, documented rule per
`interrupt-profiles.md §openwop-interrupt-quorum` ("the host MUST state whether one
reject vetoes … or quorum rules apply symmetrically"). The now-misnamed interrupt
outcome `reject-majority` → `reject-quorum`, and the rejection reason/message are
policy-neutral (`quorum-reject` / "Quorum gate failed: rejected"). The conformance
majority-reject scenario (which sets `'majority'` explicitly) is unchanged; a new
`quorum-review.test.ts` case pins the unified default (one reject vetoes a
default-policy runtime gate → run fails).

The eligibility predicate's INTENTIONAL asymmetry is now documented in BOTH spots
(reciprocal comments): the runtime-interrupt path treats an empty `approverRefs` as
an OPEN gate (the conformance contract), while the pre-execution approval path keeps
requiring the `approvals:respond` scope for an empty list (higher-stakes, no
conformance obligation) — kept deliberately different.

**Correction — node-route access floor added (architecture-review HIGH-3):** the
node route `POST /v1/runs/:runId/interrupts/:nodeId` previously lacked any run-access
gate, while `GET /v1/runs/:runId` and the unified `/reviews` action route both gate
on `requireProtocolScope(req, 'runs:read')` (RFC 0049 / ADR 0006 Phase 3). The fix
is to add that SAME gate — the consistent, app-wide run-access model is
"runId-as-capability + optional RFC 0049 scope," so the node route now matches it
(it was the only resolve path missing the floor). Deliberately NOT a bespoke
`run.tenantId === req.tenantId` match: that would 404 legitimate multi-workspace
callers acting outside their active workspace, and diverge from the run-read model.
The gate is a no-op unless the host sets `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`;
when enforced, a zero-scope caller is 403'd BEFORE the interrupt lookup (no
existence leak), and the wildcard operator/API key (the conformance harness) stays
full-access — so the quorum conformance scenario is unaffected. Quorum eligibility +
the capability-token/anon checks still apply on top. Pinned by a new case in
`authorization-fail-closed.test.ts` (the interrupt node route joins bulk-cancel /
events-poll / debug-bundle in the zero-scope-member deny set).

Deferred: group-approver expansion, vote-change-before-quorum semantics, configurable timeout outcome (reject/escalate), read-path finalize re-drive, the `openwop-interrupt-auth-required` profile, and the `../openwop` INTEROP-MATRIX live-witness row (needs deploy + steward verification).

Tests: `backend/test/quorum-review.test.ts` (authenticated path — eligibility 403, durable dedup keeps 1-of-2, policy progress via `/reviews`, second approver tips quorum); existing `rfc0093-approval-gate` / `parallel-resume-race` / `eng1-approval-gate-atomicity` stay green (durable rewrite is behavior-preserving for the token path); `frontend ReviewCard.test.tsx` (quorum chip).

