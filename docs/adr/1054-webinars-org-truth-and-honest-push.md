# ADR 1054 — Webinars: one client per webinar, writes need write authority, an unconfirmed registrant is queued

Status: Accepted (implemented on `feat/fl2-86-webinars-org-truth`; flips to implemented on merge)

> Commit ids in the implementation record are after the rebase onto `origin/main` (2026-11-04);
> the graders graded the pre-rebase heads `4b8184c01` (first), `5fabe20c9` and `c58bae506` (closing).

Date: 2026-11-03 · Feature: `webinars` (extension; toggle id unchanged) · Feature loop round 2,
row 86 · Extends ADR 0404 §a (the Zoom connector) · Rides ADR 0832 (the org-scope surface floor)
and ADR 1035 (connection resolution; no change) · RFC gate: none (host work, no wire change)

## Context

Row 86's workflows grade (`docs/steward/workflows-assessment/2026-11-03-webinars-row86.md`,
`WB86WF-*`, graded on `origin/main` @ `96cd0524a`) found the chains-or-stacks doctrine met: the
feature ships no workflow definition, only the `feature.webinars.nodes` pack (`register`,
`sync`) over `ctx.features.webinars`. The defects are in what the surface, the routes and the
ingest do. Each was shown red on unmodified main by `test/adr1054-webinars-org-truth.test.ts`
(6 red legs, 2 green controls).

1. **A webinar id is shared by every client in a workspace** (`WB86WF-1`). The marketing event's
   key is `${tenantId}:${provider}:${providerEventId}` (`entities/marketingEvent.ts:47`), and
   `upsertMarketingEvent` checks only the tenant before patching (`:87`). So:
   - `POST /webinars/orgs/B/events` with client A's Zoom webinar id returned **201 with A's
     event** (A's `connectionId`, `formId`, `journeyId`) and overwrote A's title;
   - a webhook or sync for client B rewrote A's event the same way (`webinarProcessor.ts:109`).
2. **A viewer's workflow writes** (`WB86WF-2`). The surface declares no `orgPolicy`, so the ADR
   0832 floor asks `workspace:read` of `registerRegistrant` (a Zoom write plus a CRM activity) and
   `syncEvent` (provider reads plus CRM writes). Their HTTP doors ask `workspace:write`
   (`routes.ts:48,88,102`).
3. **A registrant Zoom never confirmed is dropped, or reported as confirmed** (`WB86WF-3`).
   - `registerRegistrant` on the surface records the local registration, and on a failed push
     returns `{success:false}` and forgets the person. The forms sink queues the same failure
     (`pendingPush.ts`, R2 WB-SP-2), so the drain button never sees it.
   - An actorless run (an event trigger, a schedule without a creator) cannot resolve the org
     connection, by design (`brokeredEgress.ts:35`), so every such push is lost the same way.
   - A 2xx with no `registrant_id` returns `{success:true, registrantId:''}`
     (`host/webinarAdapter.ts:66`). The node then reports success with no join link.
4. **Every Zoom webhook becomes CRM data** (`WB86WF-4`). The observer ingests any
   `webinar.*` or `meeting.*` registration or join for any id in the connected Zoom account
   (`webinarProcessor.ts:75,83`), creating a CRM contact (lead source `webinar`) and a marketing
   event for each one. An internal team meeting's participants become marketing leads, and their
   join events can start journeys bound to `host.webinar.attended`. The operator never chose to
   track that meeting.

**Prod (read-only, 2026-11-04T04:02Z, orchestrator):** the toggle is `beta`; there are **zero**
marketing events, zoom-webinar connections, inbound configs, webinar activities, pending pushes,
form bindings, workflows using the nodes, and funnel webinar steps. `OPENWOP_ZOOM_API_BASE` is
unset. Every defect is latent; no data migration is needed, and D4 changes nothing for an existing
user.

## Decision

> **Corrected before code (adversarial `/architect` pass, 2026-11-03, approve-with-changes).**
> The first draft made the D1 claim a check-then-put (racy), stated that an actorless run cannot
> spend a credential (false: the broker falls through to a WORKSPACE-scoped connection,
> `connectionsService.ts:621`), let the `register` node CREATE a tracked event (which undid D4 and
> let any run squat a webinar id), queued permanent failures, and swallowed ingest errors so no
> refusal could be reported. The text below is the corrected decision; the reviewer's findings are
> B1–B3, M1–M4 and m1–m5 in the row-86 per-run file.

### D1 — A webinar id belongs to the first client that tracks it, atomically

The event key stays `${tenantId}:${provider}:${providerEventId}` (no migration; prod has no rows).

- **Create** is `events.putIfAbsent`. On a lost race the row is re-read and its `orgId` compared.
- **Patch** (title, start, form, journey) is a `compareAndSwap` against the row that was read,
  re-read and retried (three tries, then a 409 `event_write_contended`), with the org check
  repeated on every re-read. The form bind and unbind clear `formId` the same way.
- **Another client's row** is refused: `OpenwopError('conflict', …, 409, { reason:
  'event_in_other_org' })`. The response carries no field of the other row. It does tell a member
  of client B that some client in the same workspace tracks that id. That is accepted: both are
  members of one workspace, and the alternative (a silent shared row) is the bug.
- **Ingest never changes a tracked event's connection** (it set `connectionId` to whichever
  connection delivered the webhook, so two connections flipped it; reviewer m5). Ingest sets it
  only when the row has none.
- **`connectionId` on `POST …/events`** must name an active `zoom-webinar` connection in this
  workspace that is either this client's or workspace-wide; otherwise 400. (It was stored
  unchecked, and D3 now routes pushes through it.)

### D2 — Surface writes ask `workspace:write`; an actorless run can reach only a workspace connection

`webinars` declares `orgPolicy.methodScopes = { registerRegistrant: 'workspace:write',
syncEvent: 'workspace:write' }` (`WEBINARS_SURFACE_POLICY`), the ADR 1022 D4 shape. A viewer's run
gets `forbidden_scope` before any write or provider call.

**Actorless runs, stated accurately.** The ADR 0832 floor passes a run with no subject. The broker
withholds org and user connections from such a run but does hand it a workspace-scoped
connection. That is the same reach the public forms sink has always had (a visitor's
registration is pushed with the workspace credential), and D3 bounds it: the run can push only
into a webinar the client already tracks, so the run chooses the registrant, never the target.
When the tracked event names a connection, the push is pinned to it (ADR 1035's pinned lane,
which re-checks ownership or `connections:use` for the actor), so a client's webinar goes through
that client's Zoom account and an actorless run reaches it only if it is workspace-wide.

### D3 — Register only into a tracked webinar; record first; queue every unconfirmed push

> **Corrected after the grade (2026-11-03, grade-code WEB-4/WEB-10, grade-ux WEB86-3).** The
> first implementation split failures into "recoverable" (queued) and "permanent" (Zoom 400/404:
> not queued, and deleted by the drain). The grader showed that a 404 or 400 is just as often a
> setup fault (the event pinned to the wrong Zoom account, registration not enabled), and that the
> drain would then delete up to 50 registrants per click, the only record that they asked to
> register. A permanent-failure guess is not safe enough to delete people on. So: every
> unconfirmed push is queued, the drain removes a row only on success, and each failure stays
> with its reason. The confidential-PII retention purger bounds how long a never-pushable row
> lives. The order also changed: the registration is recorded before the push, so an erased
> person is never sent to Zoom.

Order in `registerRegistrant`: **resolve the tracked event → record → push → queue.**

1. The webinar must already be tracked in this client (`getMarketingEventByProviderId` plus the
   org check). Otherwise `{success:false, error:'event_not_tracked', queued:false}` and nothing is
   written or sent. Another client's id is `event_in_other_org`, same shape. The node never
   creates an event.
2. The local `registered` activity is recorded first, as ADR 0404 decided. `ingestWebinarEvent`
   returns a typed outcome (`recorded | duplicate | suppressed | other_org | untracked | failed`)
   instead of `void`. Anything but `recorded`/`duplicate` (an erased person, no usable email, a
   storage error) is `{success:false, error:'not_recorded', queued:false}` and nothing is sent.
3. The push goes through the adapter, pinned to `event.connectionId` when it is set (also in the
   forms sink and the drain route, so all three push the same way).
4. The adapter treats a 2xx without a `registrant_id` as `{ok:false,
   error:'zoom_no_registrant_id'}`. A missing `join_url` stays tolerated (Zoom omits it for
   approval-required webinars).
5. Every failed push is queued with `enqueuePendingPush` (insert-once, so a retry or replay keeps
   the first `queuedAt` and does not restart the retention clock) and returned as
   `{success:false, error, queued:true, recorded:true}`. The drain removes a row only when Zoom
   confirms; one row's thrown error is that row's failure, never a 500 for the batch.
6. A registrant still in the queue is never marked a no-show by the sync: they have no join link.
7. **The forms sink uses the same record-first gate** (re-grade, grade-code #7): a public
   submission from an erased person is recorded nowhere, so it is never pushed or queued.
8. **No row can block the queue, and every row has a way out** (re-grade, grade-ux WEB86-14,
   grade-code WEB-19). Each failed drain attempt is counted on the row with Zoom's last answer
   (`attempts`, `lastError`; compare-and-swap, so a row the eraser deleted stays deleted). The
   drain takes the fewest-attempted rows first, so rows Zoom keeps refusing sink to the back and a
   new registrant is never stuck behind 50 of them. `GET …/events/:eventId/pending`
   (`workspace:read`) lists who is waiting: masked email (`a***@example.com`), attempts, last
   answer, and an email-free `pendingId`. `POST …/pending/:pendingId/remove` (`workspace:write`)
   drops one pending push, after the shared confirm dialog. The person stays registered in the
   CRM. The removal is written to the audit stream (`webinars.pending-push.removed`) without
   the email.
9. **No registrant text from Zoom is stored** (final grade, WEB-22). A Zoom error is kept as
   `zoom_<status>` plus Zoom's numeric error code (`zoom_400:300`), never Zoom's message text,
   which can echo the email. That string is what the queue row, the page and the audit record
   carry.
10. **The row handle is random** (final grade, WEB-23): `pendingId` is a UUID stored on the row
    at enqueue (insert-once keeps it), not an unsalted hash of the key, which a dictionary of
    emails reverses. A row queued before handles existed gets one on first listing (CAS). The
    list shows the name the person gave plus a masked email (`ad…@example.com`), so two
    registrants are distinguishable; the remove button's accessible name is that same text.

The node maps the outcomes to distinct codes: `provider_push_queued` (queued), `event_not_tracked`,
`event_in_other_org`, `registration_not_recorded` (nothing was sent), and `provider_push_failed`
for the rest. Pack `1.0.2 → 1.1.0` (new outputs,
new codes), `features/packPins.ts` and the `pack.json` contract text in step. The node's error
messages are English operator text inside a run (like every node pack's), not page copy.

### D4 — Only webinars the client tracks are ingested from webhooks

`onVerifiedWebinarWebhook` ingests an event only when a marketing event for that provider id
already exists in the connection's client. Anything else is acknowledged and dropped (Zoom still
gets its 200; the inbound route answers before observers) and logged at debug as
`webinar_webhook_untracked` with ids only. A webinar is tracked only by adding it on the Webinars
page (or the `POST …/events` route). A funnel webinar step and the `register` node require an
already-tracked event.

Each dropped delivery is logged as `webinar_webhook_untracked` with the connection id, the
provider id, the phase and a running `droppedSinceBoot` count, never the participant. The log is
sampled (the first, then every 100th) so a busy Zoom account full of meetings cannot flood it.

This removes the webhook auto-discovery ADR 0404 §a implied. The operator decides which events
feed the CRM; an internal Zoom meeting's participants no longer become marketing leads. Prod has
zero events, so no current user loses data. The `meeting.*` mappings stay, so a tracked Zoom
meeting with registration works.

### D5 — Backfill also reads the registrant list

D4 means a person who registered on Zoom before the webinar was tracked arrives by no webhook. The
attendance sync (already operator- or node-driven, already tracked-only, already cooldown-claimed)
first walks `GET /webinars/{id}/registrants` (approved registrants; `webinar:read`, already in the
provider's scopes) and ingests each as `registered`, bounded like the attendance walk. A failed or
partial registrant walk sets `partial:true` and skips the no-show pass, the same rule as R2
WB-SP-1, because no-shows computed from an incomplete registrant list are wrong in the other
direction (missed no-shows), and an honest "partial" is better than a confident undercount.

- A first-page auth, connection or 5xx error is an error sync (the cooldown is released), as for
  the attendance walk.
- A first-page 400 or 404 is the webinar's own answer (registration not enabled, or an id Zoom
  does not know). The attendance walk still runs, and the result is `partial` (corrected after
  the grade: the first version treated a 404 as "complete and empty" without a cited source).
- The result carries `registrants` (distinct emails read), so the page can say what an upcoming
  webinar's sync brought in.

**Ingest writes the event row only when it changes it** (title, start, or a first connection).
A burst of join webhooks no longer contends on one row, and a contended patch of an existing event
never blocks the activity write (grade-code WEB-5).

### Filed, not fixed here

- `WEB-20`: a webhook's Zoom topic still overwrites the title the operator typed (pre-existing;
  it now costs a write, not data).
- `WEB-21`: `clearEventForm`'s contended branch has no direct test.
- A pinned connection that is later deleted reads `no_connection`, with no repair path on the
  page (grade-code #6).
- A webhook from a second connection of the same client is accepted for an event pinned to the
  first (#11; same client, so accepted).

## Alternatives weighed

- **Org in the event key (D1).** Rejected: the CRM activity id has no org segment, so two clients
  tracking one webinar would still collide one layer down, and the funnel and pending-push
  references would need a migration for no product gain.
- **Refuse actorless runs in the surface (D2).** Rejected for the same reason ADR 0832 rejected
  it: event-triggered registration (a funnel opt-in that registers the visitor) is a main shape.
  D3's tracked-only target bounds what such a run can do to what the public forms sink can do.
- **Let the `register` node create the tracked event (first draft).** Rejected by the review: a
  run whose webinar id comes from a trigger payload could claim any id for its client, lock the
  real client out with a 409, and switch on webhook ingest for a webinar nobody chose.
- **Keep auto-discovery but drop `meeting.*` (D4).** Rejected: a webinar the operator never
  added is still over-collection; and a tracked meeting is a legitimate use.
- **Retry the push in the background (D3).** Rejected: an actorless retry still has no
  credential, and a background spender would need its own authority. The operator drain already
  exists and runs with a real acting user.

## Matrix

| Dimension | Disposition |
|---|---|
| Feature-package boundaries | Inside `features/webinars/` only. No change to `connections/inboundWebhooks.ts` (row 85 is editing it) or to the broker. |
| Toggle / paywall | Unchanged (`webinars`, bucket `tenant`). |
| Workflows | No chain changes. Node pack `1.0.2 → 1.1.0`: `register` maps `provider_push_queued`, `event_not_tracked`, `event_in_other_org`; `sync` unchanged. A viewer's run now fails `forbidden_scope`; a `register` for an untracked webinar now fails `event_not_tracked`. |
| AI exchange | None in this feature (no model-facing surface). The funnel architect's missing webinar read tool is filed (`WB86WF-6`), not built here: it is row 72's agent pack. |
| RBAC | D2 aligns the run surface with the HTTP doors. Every route already asks `workspace:write` for writes. |
| Replay / fork | No new nondeterminism. The node is `side-effectful` (unchanged); the pending row is keyed by event and email, so a replayed push enqueues the same row. |
| Data / DSAR | The pending queue already has a subject eraser and a confidential-PII retention purger; `putIfAbsent` keeps its clock honest. No new store. D5 ingests registrants only for a tracked webinar. |
| i18n / UX | Page copy in all four locales: the 409 on add (shown on the webinar-id field), every queued reason (`zoom_no_registrant_id`, rate limit, Zoom unreachable, a generic sentence naming an unknown code), an empty-queue drain, the upcoming-webinar sync, the partial sync, the pending-push explanation, and the tracked-only rule in the hint and the empty state. `event_not_tracked` is a node error inside a run, not page copy. |
| RFC gate | None. Host extension routes only; no wire change. |

## Phased implementation

| Phase | Content | Witness |
|---|---|---|
| P1 | D1–D5 in `features/webinars/`, the node pack, the page copy | `adr1054-webinars-org-truth.test.ts` (6 red on main), plus legs for the race, the untracked refusal, the permanent-failure no-queue, D4 and D5 |
| P2 | `/grade-ux` and `/grade-code` fixes | per the graders |

## Open questions / decisions

- [x] D4 removes webhook auto-discovery. Confirmed by the loop lead (2026-11-04).
- [x] Cross-feature, found here: an event-triggered `campaign-journeys.post-webinar` copy for
      client A also fired on client B's `host.webinar.attended`, because the host-event binding
      has no org filter and the journey takes its org from the chain's params. **Found here, fixed
      by #5562 (row 73).**

## Implementation record

| Phase | Commit(s) | Witness |
|---|---|---|
| P1 (D1–D5, node pack 1.1.0, page copy) | `2e3f1c33b`, `124c7a7dd` | `test/adr1054-webinars-org-truth.test.ts`; `test/webinars-sync-honesty.test.ts` D5 legs; `frontend/react/src/features/webinars/__tests__/adr1054-webinarsReasons.test.tsx` |
| P2 (grade-code + grade-ux fixes) | `93dce1634`, `3591091ff` | the same files, extended |
| P3 (re-grade fixes: sink record-first, queue order/list/remove, sync copy, org switch, node code) | `5654b0b5f` | the same files, extended |
| P4 (final-grade fixes: no Zoom message text, random handles, confirm, refresh, D4 log witness) | `ea911c597`, `102086362` | the same files, extended |

**Red on unmodified main** (`96cd0524a`): 6 legs of `adr1054-webinars-org-truth.test.ts` (D1
route, D1 webhook, D2 viewer push, D2 viewer sync, D3 no-registrant-id, D3 actorless queue); the 2
controls were green.

**Sabotage, each run and reverted in one step, each turning the named leg red:**

| # | Sabotage | Red leg |
|---|---|---|
| S1 | drop `orgPolicy` from `feature.ts` | both D2 viewer legs |
| S2 | drop the other-org check in `upsertMarketingEvent` | D1 route; D1 stale-read race |
| S3 | `put` instead of `putIfAbsent` on create | D1 stale-read race |
| S4 | webhook ingest without `requireTracked` | D4 untracked meeting |
| S5 | (P1) queue every failure | the P1 permanent-failure leg (behaviour later reversed in P2) |
| S6 | skip the registrant walk | all three D5 legs |
| S7 | drop the connection pin on the registrant POST | the pin leg |
| S8 | let any upsert replace `connectionId` | the second-connection re-pin leg |
| S9 | drop the queued-registrant no-show skip | the no-show-skip leg |
| S10 | push before checking the record | the erased-person leg |
| S11 | the forms sink pushes without the record-first gate | the public-sink erased-person leg |
| S12 | the drain takes the most-attempted rows first | the 50-refused-rows leg |
| S13 | the remove route asks `workspace:read` | the queue-list leg (a real viewer of the org) |
| S14 | ingest always writes the event row | the no-op ingest leg |
| S15 | a contended event patch throws | the contended-patch leg |
| S16 | keep Zoom's message text in the error | the 400-stays-queued leg (no message text stored) |
| S17 | log the untracked participant's name (an email is also masked by the logger, ADR 0077) | the D4 log leg |
| S18 | enqueue without a random `pendingId` | the queue-list leg |
| F1–F15 | each page branch (field error, partial-first, generic reason, rate-limit copy, empty queue, the 409 copy, org switch clears the field, the queue list's last answer, no "queued" in a sync reason, confirm before remove, the list re-reads after a push, a coded not-found in the page's words, the remove button named by the person) | its FE leg |

**What users see by default:** nothing changes until `webinars` is on (prod `beta`; zero events,
connections and runs on 2026-11-04). Then: a webinar another organization tracks is refused on
the field; only added webinars feed the CRM; sync also brings in earlier registrations; every
registration Zoom did not confirm waits under "Push to Zoom" with its reason.

**Deploy notes:** no migration, no new store, no env var. Backend before frontend as usual (the
page reads the new `registrants` count and the 409 reason; an old page against the new backend
still works).
