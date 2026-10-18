# ADR 0899 — A declared approver ACL binds the voter on every decide lane

Status: implemented (D1–D3, D5; D4 deferred as `IVB-R5`). /architect 2026-10-17: approve with changes, applied.

Feature loop queue item (A). Closes host residue `ISWF-23` (filed by ADR 0677 D1,
kept open by ADR 0778 D4(c), re-measured by ADR 0894 C1 / `CU2CD-2`). Baseline
`origin/main` `f55f995ad`.

## Context

An approval interrupt has five decide lanes. They converge on one function,
`resolveAndResume` (`routes/interrupts.ts`), which picks the eligibility check by
WHO is calling:

| Lane | Reviewer passed to `resolveAndResume` | Eligibility check |
|---|---|---|
| `POST /v1/runs/:runId/interrupts/:nodeId` | `reviewerOf(req)` (session user, or `bearer:` → capability) | `assertEligibleApprover` (subject pinned) or `assertTokenQuorumVote` |
| `/v1/host/openwop-app/reviews/:id/actions/:action` | `reviewerOf(req)` | same |
| `POST /v1/interrupts/:token` (RFC 0093) | **always** `{ capabilityToken: true }` | `assertTokenQuorumVote` |
| `POST /host/openwop-app/interrupt-action` (emailed link) | `{ capabilityToken: true }` | `assertTokenQuorumVote` |
| MCP `requestState` | `{ capabilityToken: true }` | refused before claim when `needsNamedApprover` (ADR 0778 D5) |

On the subject lanes the session user is pinned and the body `voter` is ignored
(ADR 0070), so a declared `approverRefs` binds. On the capability lane the body
`voter` declares the approver. `assertTokenQuorumVote` checks that the voter is
eligible, and then:

```ts
if (requiredApprovals === 0) return undefined;   // ← single-approver gate: done
const voterSig = …;
if (!verifyVoterBinding(interrupt.token, voter, voterSig)) throw 403;
```

So on a **single-approver gate with a declared ACL** (the common shape:
`requiredApprovals` absent, `approverRefs: [<one person>]`), the voter is
eligible-by-claim and never proven. The interrupt listing hands the token to
every `approvals:respond` holder in the tenant (ADR 0778 D2), so any Editor can
`POST /interrupts/{token}` with `voter: <the named approver>` and resolve it as
them. ADR 0894 measured exactly this on the computer-use decide gate (a peer
editor posting `voter=opener` got 2xx) and refused it inside that one feature
(`approvalBinding.ts` drops any resolution carrying `voter`) rather than at the
host.

The rationale ADR 0677 gave for scoping the HMAC to quorum gates was that
widening it "would 403 legitimately-emailed single-approver links". **That premise
is false on the current code**: `emailApprovalDelivery.ts` signs every emailed
link for its recipient (`signVoterBinding(token, recipientUserId)`), quorum or
not, and the confirm-page POST already verifies a voter's signature whenever one
is named. Nothing that legitimately reaches the token lane with a `voter` lacks
its signature. (Measured: the only producers of `voter` on any lane are the
emailed links, the conformance suite's `bearer:` quorum votes on OPEN gates, and
hand-written API calls. No SPA client sends `voter`.)

A second, related question was open: what does an approval gate with an **empty**
ACL mean?

## Decision

### D1 — A declared ACL proves the voter on the capability lane, quorum or not

`assertTokenQuorumVote`: when the gate declares an ACL (`gateAclOf(...).declared`
— explicit subjects ∪ groups ∪ roles, blank strings ignored), the body `voter`
must be eligible **and** carry a valid `voterSig` for `(token, voter)`, for every
`requiredApprovals`. The early `requiredApprovals === 0` return moves below the
signature check. A bare token holder can no longer name an approver; an emailed
recipient's link keeps working unchanged.

This is the ONE choke point every capability-lane caller passes through — the
API token route, the emailed-link POST, a `bearer:` env key on the node and
`/reviews` routes, inbound webhooks (`inboundWebhooks.ts`, whose resume value
carries no `voter`, so it fails closed on an ACL'd gate as it already did), and
MCP (which refuses ACL'd gates before this). Callers that pass no reviewer at all
(`claude-code/tasks.ts`, the connections prompt in `connections/routes.ts`) take the
non-capability branch, which already refuses any ACL'd gate (403). No lane gets its
own check.

### D2 — The token route has no caller identity, so it stays a pure capability lane

The first draft of this ADR had the token route pin a signed-in caller through
`reviewerOf`, as the node route and `/reviews` do. **That premise died on a code
read:** `/interrupts` is a public path (`middleware/auth.ts` `PUBLIC_PATH_PREFIXES`), and
`authMiddleware` calls `next()` for a public path before it reads a cookie or a
bearer. `req.userId` and `req.principal` are never set on that route, so there is no
session to pin. Making the route credential-optional (the ADR 0748 lane) would make
a stale `Authorization` header a `401` where the token alone succeeds today, which
is a wire-visible change to the RFC 0093 token surface for no security gain once D1
holds.

So the token route stays what the spec says it is: the token is the authorization.
After D1, an ACL'd gate resolves there only with the per-recipient signature. A
named approver who is signed in decides on the session lanes (the inbox, the run
page and the chat card all use them; no SPA client posts a `voter`). The emailed
confirm page is likewise unchanged: its identity is the signed link.

### D3 — An EMPTY ACL stays open. That is the documented default, not an accident

An approval gate whose `approverRefs` / `approversList` / group / role refs are
all absent or blank is **open**: any caller who may decide an open gate on that
lane may decide it.

| Lane | Who may decide an open approval gate |
|---|---|
| node route, `/reviews` | `approvals:respond` in the run's tenant (ADR 0778 D2 floor, `requireInterruptDecider`) |
| token route | the token holder. The listing hands the token only to `approvals:respond` holders (`decideTokenProjector`). Open gates get no emailed decide link (`notify.ts` sends one only to an addressed gate) |
| MCP | the `requestState` holder (open, non-quorum gates only) |
| open QUORUM gate | as above; counts distinct identities (ADR 0778 D4 residual, by contract) |

Why open, not "fail closed to the run's opener":

- **Real consumers rely on "any approver".** The `approvals.two-stage-sign-off`
  chain defaults its approver params to `""`, which freezes to `approverRefs: [""]`
  and is documented "leave a stage blank to open it" (blank ⇒ open,
  `approver-acl-binds-without-quorum` leg 4). `core.approvalGate` itself has no
  default; it passes an ACL through only when configured (`bootstrap/nodes.ts`). The `approvals.request-sign-off` chain is explicitly "any team member".
  The census for this ADR found ~85 chain-pack gates and 13 code producers; all
  but three declare no ACL, and the unified inbox and its SLA/escalation ladder
  (ADR 0478) route open gates to whoever is on call. A default of "opener only"
  would strand every one of them the moment the opener is away, and would make a
  headless run's gate (no opener) undecidable.
- **The spec separates counting from authorization.** `openwop-interrupt-quorum`
  is pure counting; RFC 0173 §B binds `approversList` *where declared*.
  `conformance-interrupt-quorum.json` pins `approversList: []` as open.

So the rule is: **a gate that means "a specific person" must SAY so**, by
declaring the ACL, and from D1 on a declared ACL binds on every lane. The fix for
a gate that means a specific person but declares nothing is at the PRODUCER (D4),
not a host-wide default flip.

### D4 — Producers that mean a specific person must declare it (rule; `core.email.send` deferred)

The rule from D3 is that the producer declares the ACL. The census found one
producer where the meaning is unambiguous: `core.email.send` raises "Send this email
**as you** via …" and sends with the run's acting user's credential
(`connectorInvoker`: credential = `actingUserId`), yet declares no ACL, so any Editor
could approve a send as someone else.

**The first draft fixed it here (`approverRefs: [ctx.actingUserId]`). The /architect
review refused that, correctly, on two grounds, so it is deferred as `IVB-R5`:**

- **Spelling.** `actingUserId` is `req.userId ?? principal.principalId`
  (`routes/runs.ts:698`), so for an unbound OIDC / SAML / key-started run it is
  `oidc:<sub>` and the like. `isEligibleApprover` matches explicit refs raw while the
  session lane votes as the CANONICAL user (`reviewerOf`). The real sender would be
  ineligible on every lane, and `email.send` sets no `timeoutMs`, so the run would
  wait forever. Fixing it needs a canonical user id resolved once at suspend time.
- **Fork.** `ensureForkInterrupts` copies `source.data` verbatim, while `:fork`
  re-stamps `actingUserId` to the forker (`routes/runs.ts:2002`). A forked gate would
  name the SOURCE user as approver while the send uses the FORKER's credential.
  Fixing it needs either a re-bind in `ensureForkInterrupts` or a resume-time check
  that fails closed (`sent:false, reason:'approver_mismatch'`).

Both are real design work on the fork path, not a one-line producer change, and
neither belongs in a fix to the vote-binding choke point. The same spelling
exposure exists latently in computer-use (`approverRef = createdBy =
scope.actingUserId`), recorded on the same row.

`feature.computer-use.nodes.decide` already declares `[opener]`. With D1, its
emailed-link refusal (`approvalBinding.ts`: any `voter` ⇒ not approved) becomes
defence in depth rather than the only guard. It stays: "the opener approves signed
in" is that feature's own decision (ADR 0894 C1).

### D5 — Not a wire change

`resumeValue` is opaque to the protocol (`{ resumeValue }` closed, its members
host-defined); `voter`/`voterSig` are host fields. RFC 0173 §B already says a host
MUST refuse a resolver not in `approversList`; this ADR makes the host refuse an
**unproven** claim to be in it, which is the stricter reading of the same MUST.
`interrupt.md` §Surfaces ("SHOULD expose the signed-token surface for callers not
authenticated to the protocol") still holds: open gates resolve by token alone, and
ACL'd gates resolve by token plus the per-recipient binding the host mails.
No RFC needed; no capability flag changes. `approverRefs` itself stays a host field:
`interrupt.requested` projects only `approversList` onto the wire
(`interruptRequestedPayload.ts`).

## Alternatives considered

1. **Refuse a body `voter` on the token lane for single-approver gates.** Breaks
   every emailed single-approver link (they carry `voter` + `sig`). Rejected.
2. **Per-approver tokens** (mint one RFC 0093 token per eligible approver). The
   cleanest capability model, but the token grammar and the one-token-per-interrupt
   store are RFC 0093 / identity.md surface, and the HMAC binding already gives
   the same property. Rejected as disproportionate.
3. **Stop handing the token to non-eligible callers in the listing.** Narrows
   distribution but leaves the `bearer:` key and any leaked token able to name an
   approver; it treats the symptom. Kept as an open question (defence in depth).
4. **Default an empty ACL to the run's opener.** See D3: strands most gates in the
   app and makes headless gates undecidable. Rejected.
5. **Fix it per feature** (as ADR 0894 did). That is the drift this ADR ends: the
   next feature to declare an ACL would inherit the hole. Rejected.

## Trade-offs

- An API client that decided ACL'd single-approver gates with a bare token plus a
  `voter` stops working. That client was exercising the defect; the supported ways
  are a session lane (signed in) or the emailed link (signed).
- A signed-in approver who reaches for the token route (rather than the inbox)
  needs their emailed link; the token route cannot see the session (D2).
- `resolvedValue.voter` on a session lane is still the raw body value (ignored, not
  stripped — stripping would change the node's output shape mid-flight). It is not
  an identity claim; the decision ledger and `decidedBy` are.

## Implementation plan

| Phase | Change | Witness |
|---|---|---|
| P0 | probes RED on `f55f995ad` | `adr0899-interrupt-voter-binding.test.ts` (real HTTP routes) |
| P1 | D1 in `assertTokenQuorumVote` | probes; `approver-acl-binds-without-quorum` leg 2 (which asserted the hole: an unsigned listed voter passes) flips to 403 with a signed positive leg beside it, and leg 7's "filed as ISWF-23" closes |
| P2 | D2: no route change; probes pin that the token route is identity-free (a cookie does not make `voter` count) | probes |
| P3 | D3 documented + tested (open gate accepted on every lane) | probes |
| P5 | ADR 0894 `CU2CD-2` probe flips from "route accepts" to "route refuses"; comments that cite ISWF-23 as open updated | `adr0894-…test.ts` |

## Exposure measurement (read-only, for the operator to run)

```sql
-- The ACL predicate mirrors gateAclOf: approverRefs shadows approversList whenever
-- approverRefs is an array; blank / whitespace refs do not count; strict mode so a
-- scalar is not treated as a one-element array (silent=true: a missing key is false, not an error). requiredApprovals counts as a
-- quorum only when it is a JSON number > 1 (the code's typeof check). No kind
-- filter: assertTokenQuorumVote does not check kind.
WITH acl AS (
  SELECT i.*,
    (CASE WHEN jsonb_typeof(i.data->'requiredApprovals') = 'number'
          THEN (i.data->>'requiredApprovals')::numeric ELSE 0 END) > 1 AS is_quorum,
    ( (CASE WHEN jsonb_typeof(i.data->'approverRefs') = 'array'
            THEN jsonb_path_exists(i.data, 'strict $.approverRefs[*] ? (@.type() == "string" && @ like_regex "\\S")', '{}', true)
            ELSE jsonb_path_exists(i.data, 'strict $.approversList[*] ? (@.type() == "string" && @ like_regex "\\S")', '{}', true) END)
      OR jsonb_path_exists(i.data, 'strict $.approverGroupRefs[*] ? (@.type() == "string" && @ like_regex "\\S")', '{}', true)
      OR jsonb_path_exists(i.data, 'strict $.approverRoleRefs[*] ? (@.type() == "string" && @ like_regex "\\S")', '{}', true)
    ) AS declared
  FROM interrupts i
)
-- Q1: open gates that declare an ACL, single vs quorum.
SELECT count(*) FILTER (WHERE NOT is_quorum) AS single_approver, count(*) AS total
FROM acl WHERE resolved_at IS NULL AND declared;

-- Q2 (same CTE): every resolved ACL'd single-approver gate whose resolution named a
-- voter. Export these rows; do NOT filter on voterSig being present, because a
-- forger could send any voterSig string and nothing verified it on this gate shape.
SELECT interrupt_id, run_id, node_id, kind, resolved_at, token,
       resolved_value->>'voter' AS claimed_voter, resolved_value->>'voterSig' AS voter_sig,
       data->'approverRefs' AS approver_refs
FROM acl
WHERE resolved_at IS NOT NULL AND declared AND NOT is_quorum AND resolved_value ? 'voter'
ORDER BY resolved_at DESC;
```

**Not executed:** no Postgres was reachable from the authoring machine (Docker down; `pg-mem` has no jsonpath), so the operator runs this first against a scratch copy or with `EXPLAIN`.

To classify the Q2 rows, re-verify each `(token, claimed_voter, voter_sig)` offline
with `verifyVoterBinding` under the production session secret: a valid signature is
an emailed recipient's own decision; an invalid or missing one is an unverified
identity claim the host accepted. A session-lane resolution also keeps its raw body
`voter` (ignored there, ADR 0070), so a row can be a false positive; no app client
sends `voter`, which keeps that set small. A non-quorum resolution records no
caller, so even an invalid signature is "an unverified claim was accepted", not
proof of impersonation.

> **Measured 2026-10-17 (read-only, prod).** The team lead ran the queries above, with the user's
> approval, against production's `interrupts` table: **2517 rows** (918 open), raised from
> 2026-05-23 to 2026-10-17.
> - **0 rows declare an ACL** by the `gateAclOf` predicate, so **Q1 = 0 and Q2 = 0**.
> - Floor check, so the zero is not an inert predicate: 165 rows carry `approversList`, but none
>   has a non-blank entry. That is the `core.approvalGate` `[""]` default, which the predicate
>   correctly refuses to count. 38 resolutions carry a body `voter`, all on open gates (no ACL
>   declared, the D3 lane).
> - **Conclusion: ISWF-23 was never exploitable in prod**, because no ACL'd gate ever existed there.
>   The fix closes it before one does.



## Residue (not fixed here)

| id | Gate | Why not here |
|---|---|---|
| `IVB-R1` | kicktodo replan (`kicktodo-core` + `kicktodo-replan` chain) — "the participant approves changes to their own plan", no ACL; `ownerSubject` is available | needs the feature owner to confirm the participant spelling (subject vs userId, anon participants) |
| `IVB-R2` | kicktodo challenge factory gates — "the creator approves"; `authorSubject` available | same |
| `IVB-R3` | `core.hitl.approval-request` writes `approvers:` / `quorum:`, keys the enforcer never reads, so declared approvers are silently open; it also reads `decision`, not `action` | a pack-contract fix (map to `approverRefs` / `requiredApprovals`), with its own tests |
| `IVB-R5` | `core.email.send` "send this email as you" declares no ACL, so any Editor can approve a send as someone else | D4: binding needs a canonical user id at suspend time and a fork re-bind or resume check; the computer-use `approverRef = actingUserId` shares the spelling exposure. Gates already open at deploy keep whatever data they were raised with (no migration) |
| `IVB-R4` | role-copy gates ("manager sign-off", "compliance sign-off") with no ACL in `people-hr`, `work-twin-templates`, `exec-ops`, … | they mean a ROLE; authoring an `approverRoleRefs` default is a per-pack product decision |

## Open questions

- [ ] Should `decideTokenProjector` withhold an ACL'd gate's token from callers who
      are not eligible (alternative 3)? After D1 the token alone cannot decide such
      a gate, so this is defence in depth only.
- [ ] Should ADR 0894's "any `voter` ⇒ not approved" in `approvalBinding.ts` relax to
      "a VERIFIED voter equal to the opener"? Left to the computer-use owner; kept
      fail-closed here.

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| P0 probes, 5 RED on `f55f995ad` (9 controls green) | `c8cfe97b0` | `adr0899-interrupt-voter-binding.test.ts` |
| P1 D1 (`assertTokenQuorumVote`: signature before the single-approver return) + P5 (ADR 0894 `CU2CD-2` probe now asserts the route's 403; comments citing ISWF-23 as open updated) | `ca1441a72` (+ grade-code follow-up: group / `approversList` probes, stale comments) | the probes (16 after the follow-up); `approver-acl-binds-without-quorum` legs 2/2b/7; `adr0894-…` CU2CD-2. **Sabotaged:** reverting the fix reds 7 (5 probes, leg 2b, CU2CD-2) |
| P2 D2 / P3 D3 | no code change | D2 probes (cookie + unsigned voter refused on the token route); D3 probes (open gate accepted on the token route, node route, `/reviews`) |

