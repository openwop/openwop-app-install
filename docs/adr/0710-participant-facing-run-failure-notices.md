# ADR 0710: who is told a run failed or needs approval, and in whose words

Status: **Accepted — option C implemented** 2026-09-17

## Context

`emitRunFailureNotification` (`notifications/notify.ts`) emits, for every failed
run:

```ts
{ tenantId: run.tenantId, type: 'workflow.failed', priority: 'high',
  title: 'Workflow failed',
  message: `${workflowLabel}: ${userMessage}`,     // e.g. "…: Something went wrong. Check the server logs."
  runId, workflowId, actionUrl: `/runs/${runId}` }
```

It sets neither `recipientUserId` nor `recipientRole`. The emitter's own
contract (`notifications/emitter.ts`) is that such a record is a **tenant-wide
broadcast**. Web push fans it out to every subscribed member.

The function is careful about the right thing for the audience it was written
for: it requires the classified `userMessage` so a provider's 401 text cannot
echo a key, and it strips secrets from metadata. That audience is an operator
who owns the workflow in a personal tenant. Two things changed under it:

1. **Shared workspaces hold participants, not operators** (ADR 0684). In
   `host-kicktodo` every member is a participant who enrolled in a challenge.
2. **Headless, participant-facing runs exist** (ADR 0689: KickBot's reminder
   coach turn, a scheduled convene-turn run owned by the participant).

### Measured, kicktodo.com, 2026-09-16

A test participant subscribed to web push through a client registered directly
with Mozilla's push service. At the 18:00Z reminder slot the coach turn failed
(`agent_not_found`, since fixed in #3896) and the push that arrived decrypted to:

```json
{"title":"Workflow failed","body":"openwop-app.kicktodo.convene-turn: Something went wrong. Check the server logs.","type":"workflow.failed","priority":"high","actionUrl":"/runs/889b14cb-…"}
```

A participant was told, at the moment the product promised a nudge, to check
server logs they cannot see, with a link to a builder surface they cannot use.
By the emitter's contract every other subscribed member of the workspace received
the same message. No real participant was affected (30 days of production logs
show only probe turns), which is why this is decidable now rather than urgent.

What makes this worth an ADR is less the copy than the pattern: it is the third
instance in two days of one species. ADR 0684's org id reused a convention from an
auth-unreachable precedent where people must enter; the BYOK routes kept a scope
written when a tenant was one person (ADR 0711); and this notice is correct for the
operator who owns a workflow and wrong when broadcast to a workspace of participants.
None is a coding mistake. Each is a component right for the audience or scope it was
written for, reused where that audience moved. The review question this ADR adds for
any notifier: *who is in the tenant this record reaches, today?* (Framing from
openwop-app-1.)

### A second notice with the same reach, measured the same evening

`emitInterruptNotification` (`notifications/notify.ts`) addresses an approval
gate to its named approvers (ADR 0075 §D6), and **an open gate with no named
approvers keeps the tenant-wide broadcast**. On kicktodo.com at 20:35:50Z, a test
participant (a plain `viewer` member of `host-kicktodo`, subscribed only to catch
a reminder) received and decrypted:

```json
{"title":"Approval needed","body":"conformance-approval-refine — Conformance approval (refine-capable)","type":"openwop-app.workflow.approval-needed","priority":"high","actionUrl":"/inbox"}
```

from a verification run another session started in the shared workspace. So the
audience question covers **`workflow.approval-needed` for open gates** as well as
`workflow.failed`: in a multi-principal tenant, "no named approver" cannot mean
"every member".

### A third capture: an instruction addressed to someone without the action

After #3896 went live, the 21:00Z reminder slot failed one layer deeper
(`provider_not_supported` on the managed tier's tools round, fixed in #3902), and
the participant's push decrypted to a body ending:

```
The selected provider, model, or feature is not available on this host. Pick a different one.
```

This copy is not operator vocabulary; it is plain English. It is wrong in a sharper
way: it is **actionable-sounding and addressed to someone who has no power to act**.
The participant selected no provider; the workspace binding did, and ADR 0711 makes
that binding operator-only. The notice tells a participant to do the exact thing the
other ADR removes their ability to do. So **a copy-only fix is not a fix**: a
friendlier sentence sent to the same audience is still an instruction to the wrong
person. The audience decision below comes first, and copy follows the audience.
(Framing from openwop-app-1.)

## Decision drivers

- A participant must never receive operator vocabulary (server logs, run ids,
  workflow ids) or another member's failure.
- An operator must still learn that a scheduled participant-facing run is failing;
  silence is not an acceptable fix (the defect above was found only by a probe).
- The never-guilt law (PRD) applies to failure copy as much as to reminders.
- No wire change: notifications are host-local.

## Options

| # | Option | Participant sees | Operator sees | Cost |
|---|---|---|---|---|
| A | Address the notice to the **run's owner** (`recipientUserId = run owner subject`) | their own failure, operator copy | nothing unless they own it | one field; copy still wrong |
| B | Address to **operators** (`recipientRole: 'admin'` or the workspace's operator role); participants get nothing | nothing | every failure in the workspace | one field; participant silently misses a nudge |
| C | **Split by audience**: runs whose metadata marks them participant-facing (`purpose` in a registered set, e.g. `kickbot-coach-turn`) go to operators by role; the participant gets nothing, or a feature-owned retry | nothing, or a later successful nudge | every failure, operator copy | a small registry + role address |
| D | C, plus a **participant-safe message** the feature supplies (e.g. KickBot: "I'll check in a little later") | a kind, actionless line | as C | copy per feature; i18n |

## Recommendation (open approval gates)

In a multi-principal tenant an open gate is addressed to the workspace's operator
role, never broadcast; a gate that should reach participants names them.

## Recommendation (failures)

**C now, D when a feature asks for it.** Personal tenants keep today's behavior:
the owner is the operator, so option A and today's broadcast coincide there. In a
shared workspace, the default for a failed run with no participant-facing marker
becomes role-addressed to operators, which is also a correction to the silent
broadcast for ordinary workflows. A participant-facing run never produces a
`workflow.failed` notice to participants; its feature decides whether to retry or
say something kind.

## Decision (2026-09-17)

The recommendations are adopted as written: **option C for failures, D later only when a
feature asks for it**, and open approval gates in a multi-principal tenant go to the
operator role, never to every member.

Open questions, decided:

1. **Operator = the existing admin role.** No new notification role. ADR 0050 Phase 3's
   `recipientRole` filter is used as it stands.
2. **Aggregate.** The operator notice for a participant-facing run is at most one per job
   per day, so one broken reminder does not page once per participant.
3. **Operator copy only.** `classifyDispatchError`'s default `userMessage` stays as it is
   and is never rendered on a participant surface.

The appendix's conditionally addressed sites (`approvalSla.ts`, `actionExecution.ts`)
are in scope for the same change: an absent recipient must not fall back to a broadcast.
`commerce.order.paid` gets its own audience decision in the implementing PR. The
`budget-alert` broadcast stays as it is (ADR 0482 §4).

## Open questions (as proposed)

1. Which role is "operator" in a shared workspace: the existing admin role, or a
   new notification role? (ADR 0050 Phase 3 already filters `recipientRole`.)
2. Should the operator notice for participant-facing runs be rate-limited or
   aggregated (one per job per day), so a broken reminder does not page once per
   participant?
3. Does `classifyDispatchError`'s default `userMessage` ("Check the server logs")
   stay as operator copy only, with participant surfaces forbidden from rendering it?

## Consequences if accepted

- `emitRunFailureNotification` gains an audience decision; tests assert no
  broadcast in a multi-principal tenant and no participant receipt for a marked run.
- KickTodo's coach turn registers its `purpose` as participant-facing.
- The notification read path's role filter (ADR 0050 Phase 3) becomes load-bearing
  for failures.

## Appendix: emit sites to audit (not a closed list)

The two measured notices are not the whole set. On `ce8c7d0b9`, 33 call sites
emit through the notification emitter; these 11 files emit **without setting
`recipientUserId` or `recipientRole` anywhere in the file**, so each is a
candidate tenant-wide broadcast and needs an explicit audience decision in a
multi-principal tenant (a file-level grep; some may be intentionally
workspace-wide):

`bootstrap/conformanceSideEffectNode.ts` · `bootstrap/nodes.ts` ·
`features/assistant/actionApproval.ts` · `features/assistant/surface.ts` ·
`features/campaign-brief/feature.ts` · `features/campaign-intel/pacing.ts` ·
`features/commerce/commerceService.ts` · `features/commerce/ucpBuyer/ucpBuyerService.ts` ·
`features/crm/signService.ts` · `features/service-desk/sla.ts` · `features/users/authRoutes.ts`

Refined by openwop-app-1's reading of the 32 call sites:

| addressed | **conditionally** addressed (fails open) | unaddressed (broadcast) |
|---|---|---|
| `kanbanAssignmentNotify`, `escalationNotify` | `approvalSla.ts:285` (`...(recipientUserId ? {recipientUserId} : {})`), `assistant/actionExecution.ts:91` (`decidedByUserId !== undefined`) | `notify.ts` `workflow.failed`; `assistant/actionApproval.ts` `workflow.approval-needed`; `assistant/surface.ts` `assistant.briefing`; `actionExecution.ts` `assistant.nudge`; `commerceService.ts` `commerce.order.paid`; `workflowBudgets.ts` `budget-alert` |

- The **conditional** sites are the sharpest: they read as targeted and silently
  broadcast when the value is absent, the same fail-open shape as ADR 0707.
- **`commerce.order.paid`** broadcasts a money fact with a customer attached to every
  member; a different severity from a failure notice.
- **`workflowBudgets` `budget-alert` is intentional** (ADR 0482 §4: tenant broadcast,
  bell for all) and is out of scope for a change, in scope only for the multi-principal
  review question.

Plus the two measured paths in `notifications/notify.ts`, which set a recipient on
some branches only: run failure (never) and open approval gates (no named approver).
Suggested by kicktodo-2: read the emitter's other run-notice types before this ADR
names a closed list.

## Implementation record — option C

| decision | where | proof |
|---|---|---|
| Operator = existing **admin** role | `notifications/runNoticeAudience.ts` | leg 3 |
| Shared tenant ⇒ role-addressed (ordinary workflows too) | same | leg 2 |
| Personal tenant keeps the broadcast | same | leg 1 |
| Participant-facing registry (`metadata.purpose`) | same | legs 4–5 |
| Aggregate ≤1 per job per day | `notify.ts` `alreadyNoticedToday` | **leg 9 (behavioural)** |
| Open gate no longer broadcasts | `notify.ts` | leg 6 |
| Conditional fail-open sites closed | `approvalSla.ts`, `actionExecution.ts` | leg 7 |
| `commerce.order.paid` audience | decided AT the emit site | leg 8 |

**`commerce.order.paid` — decided, and the decision is "no change".** The appendix
called it "a money fact with a customer attached". Read at HEAD the payload is
`orderId`, `total`, `currency` — **no customer identity**; the contact sits behind
the `actionUrl`, which has its own authz. And it is a FULFILMENT signal: the people
who pack and ship are editor-class, so addressing it to `admin` would hide orders
from the members whose job they are. It belongs with `budget-alert` (ADR 0482 §4),
the other deliberate workspace-wide business fact. What would reverse this: a contact
name/email in the title or message, or a role meaning "fulfils orders".

**One predicate, not a rule per site.** The appendix found this audience question
answered independently at eleven files, two of them *conditionally*. A rule copied
per call site is an audience boundary that drifts, so `runNoticeAudience()` owns it
and every site imports it.

### Sabotage record (disjoint reds)

| removed | reds |
|---|---|
| role-address personal tenants | leg 1 |
| `recipientRole` on the failure emit | leg 6 |
| the participant-facing registry entry | leg 4 |
| the aggregation guard | leg 9 |
| restore `approvalSla`'s conditional spread | leg 7 |

**Leg 6 originally asserted aggregation by grepping for `alreadyNoticedToday`, and
that was a GATE THAT COULD NOT FAIL**: the function DEFINITION keeps the name in the
file, so deleting the CALL left it green — measured, not theorised. It is now pinned
behaviourally in leg 9 (three failed runs of one job ⇒ one notice; two ordinary runs
⇒ two). Derive a ratchet from the CALL, never from the presence of a name.

