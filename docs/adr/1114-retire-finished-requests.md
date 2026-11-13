# ADR 1114 — A request is over when its step is

Status: Accepted (2026-11-13). Implemented in the PR that closes #5868.

Host notifications and the inbox SPA only: no wire change, so no RFC. Companion to
[ADR 1109](1109-readable-requests.md), which fixed the words on a request; this fixes its
state once the step it asks about is over.

## Context

A request is a notification that names an interrupt (`interruptId` set): "Approval needed",
"Your input is needed", "Conversation in progress". It was retired in one place only: the
inbox card's `onResolved` archived the row when the step was decided **from that card**.

Every other ending left it as it was: decided in chat, from the email link, through the API or
the CLI; timed out (`approvalGateTimeout.ts`); closed by the expiry sweep; or the run failed,
was cancelled or ended. The row stayed "Approval needed / High / Unread", and the card's only
hint was "Interrupt may have been resolved elsewhere — refresh to reconcile". Refreshing
changed nothing.

Measured on a white-label adopter's production inbox (#5868, Nov 12): 335 notifications, 279
of them requests or run notices pointing at a run with nothing open, all unread; ten needed
anything.

## Decision

### D1 — One retire point: an event-log subscriber

Twelve call sites resolve an interrupt (`storage.resolveInterrupt`); none is shared. Every
ending already appends an event: `interrupt.resolved` for a decision, an answer or a timeout,
and `run.completed` / `run.failed` / `run.cancelled` when the run ends (a cancel resolves its
open interrupts without an `interrupt.resolved`; the terminal event covers it). So the retire
step is one subscriber (`notifications/retireRequests.ts`), installed with the notification
emitter, not a call added to each resolver. It is best-effort like the SSE and webhook
subscribers: a failure is logged and that row keeps the old behaviour.

### D2 — Stamp, don't archive

The subscriber stamps `metadata.resolution = { state, at }` and moves `unread` → `read`. It
never archives: the person can still see what happened. `state` is `approved`, `rejected`,
`changes-requested`, `timed-out`, `answered` (any other answer) or `run-ended` (the run ended
with the request still open). A run's end never overwrites an earlier decision, and archived
rows are left alone. Rows that name no interrupt (run failed or completed notices) are not
requests and are never touched.

One storage method does it (`resolveRequestNotifications`, sqlite and postgres), with a partial
index on `(tenant_id, run_id) WHERE interrupt_id IS NOT NULL` (postgres migration 51, sqlite
53), since it runs on every resolution and run end.

### D3 — The card says how it ended

A stamped request is no longer "action needed" (`isActionNeeded` returns false), so it leaves
the Action needed tab and its count. Its card shows the ending ("Approved", "Timed out", "No
longer waiting") in place of the type and priority chips, and no resolver. A row from before
this change, with no stamp, still asks the server; when nothing is open it now says "This step
is no longer waiting", not "refresh to reconcile".

### D4 — One action for the backlog

`POST …/notifications:archive-resolved` archives, in the caller's scope, every request that is
over: stamped, or (older rows) whose interrupt is resolved or gone. The inbox offers it as
"Archive finished requests" beside "Archive read".

### D5 — The run link says where it goes

"run 209ebb26-8ab →" (the id cut to twelve characters) becomes "Open the run →".

## Alternatives considered

- **Retire in each resolver.** Twelve call sites, and the next one added would forget. Rejected
  for the subscriber over events every path already appends.
- **Archive on resolve.** Simpler, but the person loses the record of a decision someone else
  made. Rejected for stamp-and-read.
- **Compute the state in the SPA from the interrupt.** That is today's per-card fetch, which
  is why the tab count never moved. Rejected.

## Plan

| Phase | What |
|---|---|
| P1 | D1–D5, with backend tests (storage, subscriber, route) and a SPA test |

Each test is sabotage-witnessed: the old code fails it.
