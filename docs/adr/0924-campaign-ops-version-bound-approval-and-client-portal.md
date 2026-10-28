# ADR 0924 — Campaign ops: version-bound approval and the client approver portal

Status: Accepted — P0 implemented (change-set PR); P1 client portal implemented (client-portal PR); P2 pending

Program: agency campaign operations (ADRs 0921–0928). PRD features **F6**
(version-bound approval) and **F2** (client approver role and portal). Depends on
ADR 0923 (the change set and its hash).

## Context

The product's first rule: **approval belongs to one change and one version.** An
approval for change set X must never authorize change set Y. Two events
invalidate an approval: the request changed, or a person edited an affected
asset after the change set was built. The work then returns to review with a
clear reason.

F2 adds an approver who is **not an agency member**: a stakeholder at the client
who reviews one package, sees only its before/after diffs, and approves or
rejects with a comment. The approval records who approved which exact hash;
revoked access blocks later approvals; public-surface rules apply.

The PRD requires composing the existing approval service and CMS version-pinned
approval, not adding a parallel mechanism.

## Boundaries audit (state on `origin/main` at `38bdc1699`)

- **One approval queue: `host/approvalService.ts`.** `APPROVAL_KINDS` (25 kinds,
  `:40-66`); one flat `PendingApproval` row with per-kind fields (`:70-411`);
  rows at `hostext:approval:<id>` with a status index (`:438-451`, ADR 0029);
  `ApprovalPolicy` approver refs (`:421-438`, ADR 0070/0075).
- **Registering a kind:** tuple entry + a redactor (APPR-5,
  `registerApprovalRedactor`, `:934`); a `KIND_DISPATCH` row, compile-enforced by
  `satisfies Record<DecidableKind,…>` (`host/approvalDecision.ts:275-490`);
  `create…Once` with a deterministic id and `compareAndSwap(null, row)`
  (`:1511-1550`); optional `registerApprovalEligibility` (`:970-984`).
- **Core never checks a digest; each kind's handler does.** `resolveApproval` is
  a pending→resolved CAS plus a hash-chain audit entry (`:2515-2603`);
  `reopenApproval` compensates a failed post-CAS effect (`:2607`).
- **The precedents copied here:**
  - ADR 0862 assistant-action: approve **requires** `expectedContentHash`
    (`host/approvalDecision.ts:103-108`), compared to `contentHashOf`, 409
    `action_changed` on mismatch (`features/assistant/actionApproval.ts:338-343`).
  - ADR 0845 strategy activation: **before** the CAS, a missing digest or a
    mismatch closes the row `rejected` and answers 409 with a reason
    (`features/strategy/activationApproval.ts:153-176`); after the CAS the effect
    is CAS-conditioned and any failure reopens (`:238-250`).
  - ADR 0473 composed-workflow: after approval the handler starts the run with
    the approved hash pinned (`host/workflowComposeTool.ts:697-737`).
  - CMS contentApproval: pinned `pageVersion`, 409 `stale_review` at decide
    (`features/cms/contentApproval.ts:305-311`), self-approval refused as 403
    `separation-of-duties` with a sole-approver escape (`:632-662`;
    `hasDistinctScopeHolder`, `host/accessControlService.ts:2097`).
- **External approvers: nothing exists.** No guest role (only the four built-ins,
  `host/accessControlService.ts:230`). The emailed decide link is signed for a
  member and re-checks membership before sending (`host/emailApprovalDelivery.ts:
  141-171`). The interrupt confirm page shows a 300-character prompt
  (`routes/interrupts.ts:415-470`), not a package. ISWF-23 subject binding is
  closed by ADR 0899 D1, but its token holder is any `approvals:respond` member
  (`routes/runs.ts:1171-1173`), i.e. tenant-wide.
- **Best external-review precedent: CRM e-sign.** One emailed token per signer,
  renders the document, binds to a content hash, sign or decline
  (`features/crm/signService.ts:1-15`; `features/crm/signRoutes.ts:28, 105-153`,
  public prefix `/host/openwop-app/public-sign`). Sharing ADR 0887 D1 re-checks
  the publisher on every read, not only at mint.

## Decision

### D1 — New approval kind `campaign-change-set`

Added to `APPROVAL_KINDS` with a redactor, a `KIND_DISPATCH` row and
`createChangeSetApprovalOnce`. The row's kind-specific fields:

```ts
campaignChangeSet?: {
  orgId: string; changeSetId: string; changeSetHash: string;
  requestId: string; requestVersion: number;
  sourceVersions: Record<string /*assetId*/, { version: number; contentHash: string }>;
  proposedBy: string;
};
```

Deterministic id `appr:cops:sha256([tenant, changeSetId])`: one approval row per
change set, so a resubmit of the same change set cannot open a second row, and a
new change set always opens a new one. No repin: a change set is immutable
(ADR 0923 D4), so a changed package is a new row, never an edited one.

### D2 — Decide-time checks (all before the CAS)

In this order, on every approve:

1. **Hash:** the decider must send `expectedChangeSetHash`; it must equal the
   row's `changeSetHash` and the stored change set's `hash`. Mismatch → 409
   `change_set_mismatch`, row stays pending (the decider was looking at
   something else).
2. **Request current:** the request's head version must equal `requestVersion`.
   Otherwise the row is closed `rejected` with `reason:'request_changed'`, the
   change set goes `stale`, and the answer is 409 `{reason:'request_changed'}`.
3. **Assets current:** every entry's asset is re-read through its adapter
   (ADR 0922). Any `version` or `contentHash` different from `sourceVersions` →
   row closed `rejected` with `reason:'asset_changed'` and the asset ids, change
   set `stale`, 409 `{reason:'asset_changed', assetIds}`. The UI says "Someone
   edited <label> after this change was prepared. Regenerate to review again."
4. **Client current:** the `ClientAccount` is `active` (ADR 0921).
5. **Separation of duties:** the proposer cannot approve their own change set
   (reusing the CMS check, hoisted to `host/approvalSelfCheck.ts` by ADR 0905
   P2a; if that has not landed, call the CMS helper directly and move it with
   0905), with the sole-approver escape **disabled** when the client's policy
   requires a client approver.
6. **Policy eligibility:** D4.

7. **Content rules current** (amended 2026-10-18, ADR 0933 D5): the server
   recomputes the change set's content-rules report; a different digest → 409
   `content_rules_changed` (row stays pending). Every introduced `needs_review`
   finding must be in the decision's `acknowledgedFindings`, else 409
   `findings_not_acknowledged`.

Reject needs only (1) and (6); a reject is always allowed while pending.

The approve then runs the CAS (`resolveApproval`), which writes the hash-chain
audit entry. **Stale is checked again at execution** (ADR 0925 D2): approval is
necessary, never sufficient.

### D3 — What an approval authorizes

Only the change set whose hash it names, against the source versions it names.
Execution reads `approvedChangeSetHash` from the resolved row, never from the
request or the UI. A second change set for the same request needs its own
approval. There is no "approve all future changes" grant in v1.

### D4 — Approval policy per client

`ClientAccount.approvalPolicy` (ADR 0921 D1):

- `agency` — any member with `approvals:respond` on the **client org** (not the
  root), other than the proposer. Stamped as ADR 0075 `approverRoleRefs`
  scoped to the org.
- `client` — a named client approver (D5) must approve.
- `client_and_agency` — both, in either order (`requiredApprovals: 2` via the
  existing quorum ledger, `host/reviewDecisionLedger.ts`).

The demo slice uses `agency`. New clients default to `agency` until a client
approver is added.

### D5 — Client approver portal (F2): per-approver capability token

> **CORRECTED 2026-10-26 (ADR 0958 P1).** The approver record and the link are
> no longer this feature's own stores. An approver is an ADR 0958 link-only
> `client-stakeholder` collaborator, and each link decides through a
> system-minted `decide` grant on the change set (resourceId
> `${changeSetId}:${grantId}`), so revoking the grant or the approver darkens
> the link at its next use. Every check below is unchanged and still runs; the
> API and the page keep their shape. Pre-0958 rows are adopted with their ids.

> **CORRECTED 2026-10-19 (ADR 0941 § "Corrections requested in other ADRs", accepted
> by a0):** the bespoke token store below would be a third home for a link-shaped
> capability, which ADR 0448 D3 forbids. As built, each link is a **sharing
> `campaign_approval` resolver** link (the `sign_request` shape). The approver
> record is shaped as ADR 0958's `ExternalCollaborator` of kind
> `client-stakeholder`, so 0958 P0 adopts it with one migration. The decide-time
> checks (D2) and the page semantics below are unchanged. See "As built — P1".

Modelled on CRM e-sign, not on the interrupt token lane (whose holder set is
tenant-wide).

- **Grant:** an operator with `host:members:manage` on the client org adds a
  `ClientApprover {orgId, email, displayName, status:'active'|'revoked'}`
  (store `campaign-ops:client-approver`). A client approver is **not** an org
  member and has no session.
- **Token:** when a change set enters review under a `client*` policy, the
  service mints one token per active approver: 256-bit random, stored as
  sha256, bound to `{tenantId, orgId, changeSetId, changeSetHash, approverId,
  expiresAt (default 7 days)}`. The raw token appears once, in the link.
- **Delivery in v1:** the operator copies the link from the UI and sends it
  themselves. Campaign ops sends no email in v1. An emailed delivery through the
  agency's email connection is a later phase.
- **Public routes** (added to `PUBLIC_PATH_PREFIXES`):
  `GET /v1/host/openwop-app/public/campaign-approval/:token` (renders the
  package: client name, request text, per-asset diffs from ADR 0923 D7, nothing
  else) and `POST …/:token/decision {action:'approve'|'reject',
  expectedChangeSetHash, comment?}`.
  - Tenant, org and change set come **from the token row**, never the request.
  - Every failure (unknown, expired, revoked, superseded, wrong hash) is the same
    404 body and timing class. A stale package (D2 2–3) is the one exception:
    it returns a 409 page saying the change was updated and the agency will send
    a new link, because the approver needs to know their link is dead.
  - Per-token and per-IP rate limits; comment capped at 2,000 characters;
    request body capped at 8 KB. **Amended 2026-10-18:** the limits are the
    shared Postgres-backed counters of ADR 0934 (fail closed on the decision
    POST), which must ship before P1; the in-process limiter is N× per
    instance.
  - **Every request re-checks** that the approver is still `active`, the client
    is `active`, the token is unrevoked and unexpired, and the change set is still
    `in_review` with the bound hash (the ADR 0887 "checked per use" rule, not
    checked once).
- **Recorded decision:** `decidedBy = { kind: 'client-approver', approverId,
  email, tokenId }` plus the comment, written into the approval row and the
  audit chain. The approval names the exact `changeSetHash`.
- **Revocation:** revoking an approver revokes all their tokens; a later POST is
  404. Archiving the client revokes all of its approvers' tokens (ADR 0921 Q2).
- **The approver sees only that package.** The page has no navigation, no other
  change sets and no asset content beyond the diffed fields.

### D6 — After approval

The `KIND_DISPATCH` handler, after the CAS, starts the execution chain
(ADR 0925) with `{orgId, changeSetId, approvedChangeSetHash}` pinned in the run
stamp (ADR 0921 D3), the composed-workflow pattern. If the client is in
`preview` mode, the approval is recorded but execution is refused
`preview_only` and the change set stays `approved` (ADR 0926 D3). If starting
the run fails, `reopenApproval` puts the row back to pending.

**Restart while awaiting approval** (scenario 5) is safe by construction: the
approval row and change set are durable, and no run is suspended waiting on a
human.

## As built — P0 corrections (2026-10-19)

1. **The decided hash travels as `expectedChangeSetHash`**, a third sibling of
   `expectedDefinitionHash` and `expectedContentHash` in the decision context and
   both decide routes (plus the reviews route). It is not a reuse of either: the
   three hash different objects.
2. **Approval eligibility is `approvals:respond` on the client org**, and the
   kind's audience is that same scope on the row's org (`approvalAudience.ts`).
3. **Separation of duties keeps D2's sole-approver escape**: the person who
   asked may not approve while another member holds `approvals:respond` on the
   client org (`hasDistinctScopeHolder`, the CMS rule); a sole approver is not
   locked out. The escape is disabled once client-approver policies exist (P1).
4. **The approver is the authority for the writes.** Execution writes under the
   approver's own CMS authority (a live page needs `host:members:manage` on the
   client org); a refusal is the step reason `not_authorized`.
5. **D2 check 4 (client inactive) keeps the row pending**, unlike checks 2–3,
   which close it: reactivating the client makes the same approval valid.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `features/campaign-ops/approval/` (kind handler, eligibility, portal routes). The kind registers through the existing `approvalService` seams; core is touched only by the one tuple entry and dispatch row the seam requires (the documented way to add a kind). |
| 2 | Toggle | `campaign-ops` gates everything; `campaign-ops-client-portal` (default OFF, tenant) gates the public routes separately, so a tenant can use internal approval without exposing a public surface. |
| 3 | Workflow surface | `ctx.features.campaignOps.requestApproval({orgId, changeSetId})` (moves the change set to `in_review` and opens the row). There is **no** approve op on the workflow surface: approval is a human act. |
| 4 | Node pack | `feature.campaign-ops.nodes.request-approval` (side-effect, ledgered on `changeSetId`). |
| 5 | Envelopes | None. |
| 6 | Agent pack | The change planner may call `requestApproval`; it can never approve (no tool exists). |
| 7 | Public surface | D5: token-derived tenant, uniform 404, rate limits, payload caps, per-use re-check. |
| 8 | RBAC | D4 policies on the client org; proposer excluded; reject open to any eligible decider. |
| 9 | Replay / fork | Approval is outside runs. The execution run pins the approved hash; a fork re-checks currency before any write (ADR 0925). |
| 10 | Frontend | Internal: the change set card in the operator inbox (ADR 0926) and the existing Approvals inbox. External: one standalone public page (no app chrome). |

## RFC verdict

**Host extension, no RFC.** A new host approval kind and host-extension public
routes. Nothing on the wire; nothing advertised.

## Phased plan

| Phase | Scope | Demo slice? |
|---|---|---|
| **P0** | `campaign-change-set` kind (tuple, redactor, dispatch, `createChangeSetApprovalOnce`); D2 checks 1–5; `agency` policy; post-approval run start with the pinned hash; witnesses: X approval cannot authorize Y, `request_changed`, `asset_changed`, self-approval refused | **Yes** (stale-approval case) |
| P1 | `ClientApprover` store, tokens, public GET/POST portal, per-use re-check, revocation; `campaign-ops-client-portal` toggle | No (PRD tier 3) |
| P2 | `client_and_agency` quorum; emailed link delivery through the agency's email connection | No |

## MyndHyve `commenter` role (amended 2026-10-18, ADR 0933 D8)

MyndHyve's `commenter` (comment and approve, no edit) maps to the client
approver in D5, not to a fifth built-in role. A comment-only agency member has no
expressible scope today; that is a follow-up `comments:write` scope in
`accessControl`.

## Alternatives weighed

- **Reuse the interrupt token lane for client approvers.** Rejected: its token
  holder set is every `approvals:respond` member in the tenant, and its page shows
  a prompt, not a package.
- **A limited "client" role (org membership).** Rejected for v1: it gives a
  client a session, nav and every org-visible surface, which is much more than
  "only that package". Revisit if clients need a standing portal.
- **Repin one approval row as the change set changes (the CMS model).**
  Rejected: change sets are immutable by design, so "new change set, new row" is
  simpler and cannot carry an approval across hashes.

## PRD-vs-architecture corrections

1. "Compose the existing approval service and CMS version-pinned approval":
   done by a new **kind** on the one queue, copying the 0862/0845 hash checks and
   the CMS self-approval rule. The CMS approval row itself is not reused for a
   change set, because a change set spans several assets and destinations.
   **One approval suffices (owner decision, 2026-10-18):** an approved change set
   also satisfies the page's CMS publish gate, but only for the exact page
   version and hash it was bound to. If the page moved, the approval is invalid
   (D2 here, ADR 0922 D3).
2. The PRD's "limited external role, or a capability-token link" → a
   capability token per approver; no external role in v1.

## Open questions

- [ ] **Q1** Token lifetime: 7 days proposed. Should it end when the change set
      is approved by someone else? Proposed: yes (the change set leaves
      `in_review`, so the per-use check already 404s it).
- [ ] **Q2** Should the client approver be able to request changes (a third
      action) rather than only reject? Proposed: reject with a comment covers
      v1; "request changes" maps to the same outcome.
- [ ] **Q3** Does ADR 0905 P2a's `host/approvalSelfCheck.ts` land before P0? If
      not, P0 imports the CMS helper and the hoist moves both.
- [ ] No `/architect` pass has been run on this ADR. The public portal (P1)
      also needs a `/code-review` security pass before it ships.

## As built — P1 corrections (2026-10-19)

1. **The link is a sharing resolver, not a token store** (ADR 0448 D3; ADR 0958 D3).
   `features/campaign-ops/portal.ts` owns the approver record
   (`campaign-ops:client-approver`, kind `client-stakeholder`, mode `link-only`) and
   a link record per (change set, approver) (`campaign-ops:approval-link`). The token
   itself is a `sharing:link` row of type `campaign_approval`, resourceId
   `${changeSetId}:${approverId}`, minted on the visitor lane, 7 days. The package
   renders in the sharing viewer (`/shared/:token`), so the page adds nothing to the
   entry bundle. The decision is the one public route,
   `POST /v1/host/openwop-app/public-campaign-approval/:token/decision`.
2. **Links are minted when the operator asks, not when review opens.** The raw link
   can be shown only once, and the operator is the one who sends it (no email in
   v1), so "Send to client" on the in-review card mints a link per active approver
   and shows each once. Sending again replaces that pair's earlier link.
3. **Who the change is written under.** A client approver has no authority to write
   a page, so the approved change is written under the agency member who **sent**
   the link (recorded on the link record). ~~Execution takes its writer from the
   execute run's person (`orgScopeSubject`, which the decide handler sets to the
   writer), not from `decidedBy`.~~ (Superseded by 11: the writer is recorded at the
   decision and read from the approval.) That member's own authority is re-checked at every
   write: an editor's link cannot publish a live page (`not_authorized`). This
   generalizes as-built correction 4 above.
4. **The approval row names the approver record, never an email:**
   `decidedBy = client-approver:<approverId>`. The email stays on the approver
   record, which the agency can remove. This replaces D5's
   `{kind, approverId, email, tokenId}`.
5. **Under the `client` policy an agency member cannot approve** (403
   `client_approval_required`), but may still reject. Setting the policy needs the
   portal toggle and at least one active approver; the last active approver of a
   `client` client cannot be removed (409 `last_client_approver`).
6. **Every use re-checks** (ADR 0887): both toggles (`campaign-ops` and
   `campaign-ops-client-portal`), the client `active` on the `client` policy, the
   approver `active`, the link record, and the change set `in_review`. Revoking an
   approver also deletes their links at once, so a test that only revokes cannot
   witness the per-use check; the test writes a revoked record with a surviving
   link to do so.
7. **Refusals are the sharing lane's own 404, byte for byte** (unknown, expired,
   revoked, wrong hash, decided by someone else, portal off). The first draft used
   its own message, which would have told a holder "valid link, wrong hash" from "no
   such link"; the test compares the bodies. A dead link's package read throws the
   same 404 rather than returning null, because null is sharing's `resource-gone`
   ("the content was deleted"), which is false here.
8. **Limits (ADR 0934):** the decision takes the per-IP counter (60 per 10 min) and
   the per-link counter (10 per 10 min), failing closed. The package read takes a
   per-link counter (120 per 10 min), failing open.
9. **`client_and_agency` is not built** (P2). ADR 0942 D9 will compile it as one vote
   from EACH party; a bare `requiredApprovals: 2` (as D4 above says) would let two
   agency votes pass with no client, and must not be built.
10. **Toggle:** `campaign-ops-client-portal` is a sub-toggle (`extraToggleDefaults`,
    default off, tenant), so it needs no seed acknowledgement of its own.
11. **Security review (2026-10-19) — the sender holds the link, so a client
    approval must never be weaker than an agency one.** The review found that the
    member who sends a link can open it and approve as the client, and that the
    member who proposed a change could do exactly that with their own change.
    Fixed:
    - **Sending needs agency approver standing** (`agencyStandInRefusal`):
      `approvals:respond` and `workspace:write` on the client org, and not the
      proposer while someone else could approve (the CMS rule, sole-approver
      escape kept). Re-checked when the client decides; a sender who lost it makes
      the link dead (409 `package_stale` to the client: "the agency will send a
      new link").
    - **Members cannot mint approval links** through the generic sharing route
      (`SYSTEM_MINT_ONLY` in `sharingService.ts`): only the visitor lane, from
      `sendApprovalLinks`. Before this, a member who could read approver ids could
      mint a working decision link that wrote under the sender's authority.
    - **The writer is fixed at the decision**, in `campaign-ops:client-decision`,
      and execution reads it from the approval (`writerOf`), never from the run.
      This supersedes correction 3's "from the execute run's person": a fork
      re-stamps the run's person, so a fork could have written as the forker.

    **Residual, accepted for v1:** a member who may approve for the agency and
    sends a link can still open it. That is no more than the authority they
    already hold under the `agency` policy, and the audit names both the link's
    sender and the approver record. Emailing the link (P2) so no member sees it is
    the real fix.
12. **Open items from the review, not fixed here:**
    - an expired link answers sharing's 410 `expired` before the per-use checks,
      not D5's uniform 404 (it only tells a token holder that the token existed);
    - the approver's own email and name have no erasure path besides an agency
      admin removing them, and the approval row's client comment (`note`) is not
      a redactor text field;
    - `sign_request` and `booking_manage` links can also be minted on the member
      lane; the same `SYSTEM_MINT_ONLY` rule probably applies (CRM's to decide).


## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | campaign-ops change-set PR (follows #5015) | `test/campaign-ops-approval-execution.test.ts` |
| P1 | campaign-ops client-portal PR (follows #5022 and #5026) | `test/campaign-ops-client-portal.test.ts` (10, sabotage ×9); frontend `operationsPage.test.tsx`, `publicApprovalView.test.tsx` |
| P1 on ADR 0958 | `feat/0958-p1` (ADR 0958 P1) | the approver and link moved onto ADR 0958 grants; `test/adr0958-p1-link-only.test.ts` (8) |
