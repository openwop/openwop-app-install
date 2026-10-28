# ADR 0932 — Interrupt resumes: a declared schema binds every lane, the resolver is recorded, and an approver ACL scopes the token for every kind

Status: Accepted (implemented in this PR)

## Context

This ADR implements Book AI upstream proposal P6 (`bookai/docs/upstream-proposals.md`).
My user approved it on 2026-10-19 ("proceed with your recommendations").

Book AI's "Draft with AI" pauses a run for the author's answers through a
`clarification` interrupt with a `resumeSchema` and `approverRefs: [authorRef]`.
Three host behaviours left the node to defend itself:

1. **`validateResumeValue` checked only approval `actions` and the credential
   shape.** A declared `resumeSchema` was ignored, although
   `spec/v2/core/interrupt.md` says "A host MUST validate the resume value
   against `resumeSchema` when one is declared."
2. **`interrupt.resolved` never carried `resolvedBy`.** `resolvedBy` is the v1
   MUST, carried into the v2 payload schema as the resolving Subject. So the event
   log could not say who answered.
3. **`decideTokenProjector` handed a non-approval interrupt's resume token to any
   caller with the base scope**, even when the interrupt declared an approver ACL.
   On the token lane, a single-approver ACL trusts a body-supplied voter name
   (ISWF-23), so a workspace Viewer could answer an author's questions by naming
   the author. The session lane was already safe, because
   `assertEligibleApprover` enforces a declared ACL for every kind.

None of the three needs a wire change. Parts 1 and 2 are spec MUSTs this host did
not honour, and part 3 is host authorization.

## Decision

- **D1 — one resume-schema validator (`host/resumeSchemaValidation.ts`, Ajv 2020,
  its own schema class per ADR 0547 D2).**
  - `resolveAndResume` enforces it before anything is claimed, on every external
    lane: a session reviewer, a capability token, MCP, the email action, inbound
    webhooks.
  - Host-internal resumes are untouched: timers, skips and preclaimed expiries
    are preclaimed or pass no reviewer, and keep their host-built values.
  - A mismatch is `400 validation_error` with the paths that failed.
  - A schema that cannot compile is also refused, naming the defect, and never
    treated as "anything goes".
- **D2 — `resolvedBy`.** `requestSubjectV2(req, tenant)` in `host/runOwner.ts`
  maps the caller to the v2 Subject using the same mapping as the run-owner stamp,
  so `resolvedBy` and `run.started.owner.subject` agree.
  - The session lanes (`reviewerOf`) carry it into `resolveAndResume`. All three
    `interrupt.resolved` emitters there record it: accept, reject and
    quorum-reject.
  - A bare capability token has no identity to record, so it leaves the field
    absent rather than inventing one.
- **D3 — ACL-scoped tokens for every kind.** For a non-approval interrupt whose
  data declares an approver ACL (`gateAclOf(...).declared`), the projector hands
  out the token only when the caller is an eligible approver
  (`isEligibleApprover`, the same authority as the session lane).
  - The projector holds no run, so the approver org is not passed. A group or role
    reference therefore resolves without an org and fails closed, meaning no token
    is handed out. Direct `approverRefs` work.
  - No ACL keeps today's behaviour, and approval kinds keep their decide floor.

## Not changed

- `core.chat.clarificationGate` forwarding structured questions, `resumeSchema`
  and the ACL. This was the optional part of P6; Book AI raises the interrupt
  through its own node.
- The token lane's trust in a body voter for a NON-approval ACL'd interrupt. D3
  stops the token reaching an ineligible caller, which closes the reported path.
  Signed voters on that lane (the ADR 0899 D1 form) stay approval-only.

## Implementation

| Part | Where |
| --- | --- |
| D1 | `backend/typescript/src/host/resumeSchemaValidation.ts`; `routes/interrupts.ts` (`resolveAndResume`) |
| D2 | `host/runOwner.ts` (`requestSubjectV2`); `routes/interrupts.ts` (`deriveReviewer`, the three resolution payloads) |
| D3 | `routes/interrupts.ts` (`decideTokenProjector`) |
| Tests | `backend/typescript/test/adr0932-interrupt-resume-schema-acl.test.ts` |

## Checklist

- [x] D1–D3 with tests
- [ ] Tell Book AI the PR number (its node keeps `parseAnswers` as defence in depth)

Recovery correction (2026-10-21): runtime JavaScript packs can bypass the typed
object declaration. Only an omitted schema is unconstrained; a present null,
scalar or array is refused. The shared suspend manager checks declarations before
storage, preventing adapters from coercing false into an absent schema. The resume
validator retains the same guard for malformed historical rows. This enforces the
existing object-only wire schema and adds no protocol shape. Runtime-boundary and
legacy-resume witnesses are added; execution and the canonical gate are pending.
