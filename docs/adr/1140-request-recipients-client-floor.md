# ADR 1140 — A run's request reaches only people who can open the run

Status: Accepted

Issue: #5951. Follows ADR 1121 (client floor) and ADR 1133 (private-project floor).

## Context

ADR 1121 made a run stamped for a client readable only by that client's people and
the tenant-level grants; anyone else gets `run_not_found`. ADR 1133 added the same
for a private project's runs. Requests were not touched. The interrupt notification
(`notifications/notify.ts` `emitInterruptNotification`) still addressed every named
approver that `resolveNotificationRecipients` returned, and the SLA reminders
(`host/approvalSla.ts` `sweepAutonomyInterruptSla`) did the same. So an approver in
another client got an "Action needed" card whose run page answered 404 (#5933 D3:
"This step can no longer be opened here").

No data leaked: the 404 held, and the card carried only the request's own words.
The cost was noise, a confusing card, and a gate that looked asked but could not be
answered by the person asked.

The issue asked three things:
1. drop recipients who fail the floor, or tell them with a "needs client access" card;
2. recheck live;
3. what to do with an approver named in `approverRefs` who lacks client access.

## Decision

**D1. Drop, at address time, anyone the run doors would refuse.** One reader,
`host/runClientAccess.ts` `runUserReader(run)`, answers "may this userId open the
run?" without a request. It is `runClientReader`'s rule, keyed on the same id
(`callerSubject(req)` is the userId):

- the client stamp (`runClientStamp`): `runs:read` in the client org, or a
  tenant-level grant; an unreadable stamp needs a tenant-level grant;
- then the ADR 1133 project check (`runProjectReader`), behind the same grants;
- the tenant-level grants a person can hold without a request: a tenant admin
  (`host:members:manage`), and a tenant where membership does not define presence.
  A personal tenant is never filtered (single principal by construction). A wildcard
  principal is a bearer, never a notification recipient.

`splitRunReaders` applies it to a recipient list, failing closed per recipient:
a check that throws (a storage error) counts that one person as unreadable and logs
`run_recipient_read_check_failed` with the error code and no user id. Letting it
throw would reach `emitInterruptNotification`'s best-effort catch and silence the
request for everyone, operators included. `emitInterruptNotification` asks
only the readers. The SLA interrupt reminders use the same cut.

A "you need client access" card was rejected. The person cannot act on it, and the
operator who can fix the gate is not the one who sees it.

**D2. A named approver who cannot open the run is a misconfigured gate, so it is
reported, not refused.** When any named approver is dropped, the run's operators
(the ADR 0710 `runNoticeAudience`, the same audience an open gate goes to) get one
notice, `openwop-app.workflow.approver-unreadable`. It says how many named approvers
cannot open the run. It carries no `interruptId`, so the inbox shows it as
information, not as a request. When nobody named can open the run, the request
itself goes to the operators, as an open gate's does, instead of to nobody.

Refusing the gate when it opens was rejected. It would fail a live run over a
membership the operator can fix in a minute, and the same membership may change
before the gate is decided.

**D3. Live recheck stays at the run door.** The address-time cut covers every new
request. A row written before this change, or for someone whose client access is
revoked later, still opens to the #5933 "can no longer be opened here" card, which
is honest. The inbox list does not load each row's run to re-filter it: that is a
run read per row on the hottest notification path.

## Consequences

- An agency member is no longer asked about another client's step. The operators
  learn the step names someone who cannot open it.
- For a client run, the reader makes up to two access reads per named recipient
  (the admin check, then the org-scope resolve), on a path that already resolves
  each recipient. An unstamped run makes none unless it is bound to a private
  project (the ADR 1133 probe is cached per tenant), and a personal or no-presence
  tenant makes none.
- Approval rows (`approvalAudience.ts`) and autonomy notices
  (`autonomyPolicy/notify.ts`) are unchanged. The first are not run interrupts and
  carry their own org audience; the second carry no run metadata, only an optional
  run id.

## Residue

- `ARFC-1`: autonomy notices that name a run (`emitAutonomyNotice` with a `runId`)
  are not cut by D1. They are notices, not requests. Effort: S.
- The frontend renders the new type with the generic notice style. A dedicated
  label or icon is an inbox UI change for the notifications owner.

## Verification

`backend/typescript/test/adr1140-request-recipients-client-floor.test.ts`, a shared
workspace with two client orgs over HTTP, emitting through the production
`emitInterruptNotification`:

- an approver in the run's client is asked, one in the other client is not, and
  the owner gets one notice with no interrupt;
- an unstamped run asks everyone named, with no notice;
- when nobody named can open the run, the request goes to the operators;
- a tenant admin named on a client run is asked;
- a check that throws for one of two approvers drops only that one: the other is
  asked and the operators get the notice.

Sabotage: removing the cut in `notify.ts` turns two cases red. So does making
`runUserReader` ignore the client stamp. Rethrowing in `splitRunReaders` turns the
throwing-check case red.

## Implementation record

| Phase | Commit | Tests |
|---|---|---|
| D1–D3 | `d3/request-fanout-client-floor` | `adr1140-request-recipients-client-floor` 5/5, three sabotages red |
