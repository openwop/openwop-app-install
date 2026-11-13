# ADR 1109 — Readable requests: the gate's own words, the chain's name, and what a request is about

Status: Accepted (2026-11-11). Not yet implemented.

> Renumbered from 1108 on 2026-11-11: #5796 took that number for its operator-plan ADR and
> was already gating. The P1 commits `3373803bc` and `c9299f90f` still say 1108.

Part 1 of #5793, which a white-label adopter (CasaVoga, its ADR CV-0189) filed from a
customer principal's seat. Extends the interrupt and approval surface of
[ADR 1013](1013-interrupt-form-rules.md) and the notification record of ADR 0050. Host
extension and SPA only: no wire change and no RFC (§Wire, below, shows why).

## Context

What a customer sees in `/inbox` today:

> `wf.copy.cv-decision-reminders.4b50… needs your input`

It appears under a banner that says "You're all caught up", above a tab that says
"Action needed 11". MEASURED on `c22bc2f0d`, five separate causes:

1. **The gate drops its own words.** `core.chat.approvalGate`
   (`packs/vendor.myndhyve.chat/index.mjs`) puts `config.title` on the chat card, then calls
   `ctx.suspend({...})` without `title` or `prompt`. This is 49 of the corpus's 63 approval
   gates. `emitInterruptNotification` (`notifications/notify.ts:70-81`) reads only
   `interrupt.data.prompt` or `.summary`. It finds neither and prints
   `` `${workflowLabel} needs your input` ``.
2. **The label is an id.** `workflowLabel = run.metadata.workflowName || run.workflowId`.
   Only some dispatchers stamp `workflowName`. A chain-instantiated definition already
   carries the chain's `label` as `definition.metadata.name`
   (`workflowChainPackLoader.ts:1906`), and nothing reads it here.
3. **The banner counts the wrong things.** `NeedsYouInbox` shows "all clear" when
   `approvals.length + blockers.length === 0`, which counts roster approvals and waiting
   agents only. Workflow interrupts are in neither list, so the banner contradicts the
   "Action needed" tab beside it.
4. **A request does not say what it is about.** `NotificationRecord` has no subject. A
   person with eight projects cannot tell which one a request belongs to.
5. **Only two types can need action.** `ACTION_NEEDED_TYPES` (`notifications/types.ts:57`)
   is a fixed set of two. An adopter's own type (`casavoga.check-in`) never appears under
   "Action needed".

Also, the card for an interrupt kind the SPA cannot render says "Ask your administrator to
update the app". A customer has no administrator to ask.

## Wire

Nothing here adds a field to the protocol.

- `ApprovalData` (`schemas/v2/suspend-request.schema.json`) is closed. It has `title`
  (required) and `description`, and no `prompt`. But `interrupt.requested` is a
  **projection** of the host record (`executor/interruptRequestedPayload.ts`). The host
  interrupt record keeps the node's full data, and the approval projector already maps
  `title`, then `prompt`, then `question` onto the wire `title`, and `description` onto
  `description`. So forwarding `title` and `prompt` from the gate adds HOST record data
  only. Its one effect on the wire is a real `title` where these gates now emit
  `Approve <nodeId>`. That makes the event more honest; it does not change its shape.
- `NotificationRecord` is a host-extension record with no schema under `schemas/v2`.
- This ADR does NOT add `prompt` to the wire, and nothing here may.

## Decision

### D1 — The approval gate forwards its own words

`core.chat.approvalGate` adds `title` and `prompt` to its `ctx.suspend` payload, using the
same drop-blanks rule as `approverRefsPayload`: a non-empty string or nothing, read from
`config.title` and `config.prompt`. MEASURED across the 49 instances in `packs/` and
`examples/`: 37 set `title`, 6 set `prompt`, none set `description`. The chat card is
unchanged. The pack takes a patch bump. `vendor.myndhyve.chat` is not in production's
`OPENWOP_INSTALL_PACKS` (MEASURED 2026-11-11: 57 packs pinned, this one not among them;
`check-pack-pin-drift` "none unshipped"), so the bump ships with the image. There is no
registry publish and no pin step.

### D2 — One reader for the request's words

`emitInterruptNotification` reads the request through one helper, `requestWordsOf`:
`title` on its own, and the text from `prompt`, then `description`, then `summary`. Today's reader takes `prompt`
and `summary`, and the wire projector also takes `description` and `title`. One helper
means the notification and the wire event can no longer disagree about what the request
says. Every value is bounded and redacted as today.
When the gate carries a `title`, it becomes the notification's title in place of the
generic kind label ("Approval needed").

### D3 — The label falls back to the chain's name before the id

`workflowName` (dispatcher-stamped), then the definition's `metadata.name` (the chain's
`label`), then `workflowId`. The definition is resolved through the tenant boundary
(`resolveTenantWorkflow`), so another tenant's id reads as unknown and falls through to the
id. A failed lookup never blocks the notification.

The catalog lives on the host suite, not on `Storage`, so `notify.ts` takes a resolver
(`setNotificationWorkflowNameResolver`). `index.ts` wires it at boot, beside
`setCompensationDefinitionResolver`, which is the same late-bound pattern. Unwired, the
label is today's `workflowName || workflowId`. The run-failed and run-completed
notifications use the same label.

### D4 — A request names what it is about

A notification may carry `metadata.subject = { kind, id }`. It is written by the host,
never taken from a client:

- **Source today:** `run.metadata.schedule.ownerScope`, which the schedule daemon writes from
  the job's subject (`scheduleDaemon.ts`). A project schedule therefore yields
  `{ kind: 'project', id }`.
- **P1b:** a server-validated project stamp for the Workflows tab's "Run now". Today that
  sends only `manual.source: 'project'`. The run route would stamp the project id only
  after checking the caller can read the project.

**The record stores no name.** The SPA resolves it at read time through the projects list
the reader can already see. An id the reader cannot see renders as a generic "a project",
so a private project's name (#5755, ADR 0054 D5) never reaches someone outside it.

The SPA chip (P2) is a link to the project when the reader's own project list
(`listProjects`) names it, and a plain "A project" chip otherwise.

It lives in the existing `metadata` JSON column, so there is no migration. Grouping by
subject is client-side, over the loaded page.

### D5 — Features declare their action-needed types

`isActionNeeded` reads a registry, not a fixed set. The two host types are seeded in it.
A feature's or adopter's SPA registration adds its own (the same contribution pattern as
`featureProjectTabs`). A type that is not registered behaves as today.

### D6 — The banner counts workflow requests

"All caught up" requires roster approvals, waiting agents AND action-needed notifications
to all be zero. `NotificationsPage` passes the count it already computes for the tab. The
banner and the tab then read the same number.

### D7 — The fallback card says what to do

An approval already renders `ApprovalCard`, with Approve / Decline bounded by the gate's
own `actions` and the approver check. It now heads the card with the gate's `title` (D1
puts it there), in place of the generic "Approval required".

The fallback branch of `RenderInterrupt` is reached only by a kind the SPA cannot render.
It shows the request's title and text (D2's reader, mirrored as `interrupts/requestWords.ts`)
and says plainly that this app cannot answer that kind of step yet. It offers **no buttons**,
because guessing a resume value for a schema the app cannot read could resolve the step
wrongly. The copy loses "Ask your administrator". All four locales change together.

> **Corrected during P2:** the first draft offered Approve / Decline on the fallback card
> "when the interrupt is an approval". An approval never reaches that branch. The ask is met
> by `ApprovalCard` carrying the gate's words.

## Alternatives considered

- **Add `prompt` to `ApprovalData`.** That needs an RFC, and `description` already exists
  on the wire for the same purpose. Rejected.
- **Have the host merge a node's `config.title` into every interrupt record.** This would
  fix every gate at once, but it is a second path that guesses at node config. The node
  owns its payload; the one node that drops the words is fixed instead.
- **Store the subject's name on the notification.** Simpler to render, but it goes stale on
  rename and shows a private project's name to non-members. Rejected for read-time
  resolution.
- **Derive the subject from `workflowId` via project assignment.** One workflow can be
  assigned to many projects, so this would guess. Rejected.

## Plan

| Phase | What | PR |
|---|---|---|
| P1 | D1, D2, D3 and D4 (the schedule source), with backend tests | backend + pack |
| P1b | D4's server-validated "Run now" stamp | backend |
| P2 | D5, D6 and D7, plus the project chip on the inbox card | SPA |
| P2b | Group-by subject on `/inbox` | SPA |

Each phase gets a sabotage-witnessed test: the old code must fail it.

## Out of scope

- The page lede "Your agents' communication portal" (#5788 §3, the wording seam).
- Parts 2–6 of #5793.

## Open questions

- Should the bell panel group by subject too, or only `/inbox`? P2b does `/inbox` only.
