# ADR 1125 — Inbox requests people can act on

Status: implemented (2026-11-17): P0 #5943, P1 #5958, P2 #6001, D1 fix #6050, P3 #6062 —
see § Implementation record. Accepted 2026-11-15 (release manager review: all eight
behaviour changes, with the conditions recorded in D1, D2 and D5). Implements #5922 P1–P3.
P0 shipped in #5943 (v0.14.0).

Host notifications and the inbox SPA only. Notifications are a host extension
(`/host/openwop-app/notifications`), so nothing here touches the OpenWOP wire and no
RFC is needed. Builds on [ADR 1109](1109-readable-requests.md) (a request's own
words), [ADR 1114](1114-retire-finished-requests.md) (a request is over when its
step is) and #5955 (a request about a deleted run is over too).

## Context

The CasaVoga owner's Inbox was a column of identical "Conversation in progress ·
Input needed · Unread" cards that said "openwop-app.conversation needs your input",
offered "Open the run →", warned that "This app can't answer this kind of step
(conversation)", and ended in three unlabelled icons, one of them a red trash can.
P0 (#5943) stopped idle chats from filing requests and retired the ones already
sent. What is left is that the inbox still speaks the engine's language and still
mixes requests with news. Read from `origin/main` on 2026-11-15:

1. **The asker is an id.** `workflowLabelOf` (`notifications/notify.ts:107`) falls
   back to `run.workflowId`.
2. **The title is a kind.** With no gate title, the title is `KIND_LABEL[kind]`
   ("Clarification needed") and the message is `${label} needs your input`.
3. **Two notified kinds have no card.** `RenderInterrupt` has no case for
   `external-event` or `credential`, so both show `unknownKindBody` with the raw
   kind in brackets. `external-event` is raised by machine waits: dispatch wave
   joins, Claude Code task waits, and an assistant approval wait keyed on an
   approval id (`bootstrap/nodes.ts:399,697,3540`, `features/claude-code/tasks.ts:190`).
   That last one is already in the Needs-you approval queue. `credential` (RFC
   0199) carries a `connectUrl` the person can follow.
4. **The card's chips repeat its title.** Type chip "Input needed" beside the
   title "Input needed", and an "Unread" chip.
5. **The only link is a diagnostic.** With no `actionUrl` the card offers
   `/runs/<id>` as "Open the run →".
6. **An open request can be archived or deleted into silence.** The icons and the
   `e` key do it, and the step still waits.
7. **Two lists claim to be what needs you.** `NeedsYouInbox` (proposals, drafted
   actions, content reviews, board blockers) sits above every tab and says "You're
   all caught up" while the "Action needed" tab below counts 3 (#5909).
8. **"All" mixes requests with news.** A decided request and a "run completed"
   notice share the tab with open requests.

## Principles (from #5922)

- An inbox item is a request this person can fulfil from the card, or news worth
  their time. Machine state is neither.
- No sentence, no item. If the host cannot say in plain words what is asked and who
  asks, it does not notify.
- The asker's words first; one primary action named with a verb; housekeeping and
  diagnostics behind "…".
- End-user copy the host composes never contains a workflow id, a node id, a kind
  name, or the words run, step, interrupt, node, gate. Words a gate's author wrote
  are theirs and are shown as written.

## Decision

### D1 — Only answerable kinds notify, and a ratchet keeps it so

- `external-event` joins `NEVER_NOTIFY_KINDS`. Every raiser is a machine wait. The
  one that waits on a person (the approval wait at `nodes.ts:3540`) already shows
  in the Needs-you queue as the approval itself, so its notification was a
  duplicate.
- `credential` gets a card: "Connect *{provider}* to continue", with one primary
  button. The resume happens through the connect flow, as today.

  > **CORRECTED 2026-11-15 (review):** this said the button opens `data.connectUrl`
  > when it is https. https is not enough: a pack can raise a `credential`
  > suspension with any data, so it could put a phishing link behind an inbox
  > button. The button **never reads `data.connectUrl`**. The SPA builds the URL
  > itself from the run and node ids, to the host's own connect route
  > (`/host/openwop-app/connections/connect/:runId/:nodeId`, what `connectUrlFor`
  > issues), so the link is host-built by construction. The provider name is shown
  > as text only, bounded to 60 characters. Witness: a pack-supplied https URL on a
  > foreign origin never reaches `window.open`.
- **Ratchet:** a backend test reads `InterruptRecord['kind']`, `NEVER_NOTIFY_KINDS`
  and the `case '<kind>'` labels in `frontend/react/src/interrupts/RenderInterrupt.tsx`.
  Every kind is either never-notify or has a renderer case, or the test fails.
- The default branch of `RenderInterrupt` (still reachable on a run page) drops the
  kind name: it shows the request's words and "This request can't be answered here."

  > **CORRECTED 2026-11-16 (train 283b, then #5843):** "can't be answered here" alone
  > tells the person nothing to do. A first fix added "Ask whoever runs this workspace
  > to update the app." That repeated the advice #5843 rejected, and ADR 1109 D7
  > forbids: no version of the app has a card for these kinds, so updating would not
  > help. The fallback now reads "This request can't be answered here." with a **View
  > the activity log** link to the run, left out on that run's own page. It names no
  > kind and no administrator. The CC-UI-2 control asserts all three.

### D2 — The words: a named asker and a composed sentence

- `workflowLabelOf` never returns an id. Order: stamped `workflowName`, the
  definition's `metadata.name`, then a generic noun, "An automation". The
  definition's `name` is what `chainInstantiation` stamps, so every gallery
  workflow already has one.
- When a gate supplies no title, the host composes one from the asker:

  | kind | title |
  |---|---|
  | approval | Approval needed: *{asker}* |
  | clarification | *{asker}* has a question for you |
  | refinement | *{asker}* asks you to review a draft |
  | cancellation | Confirm cancelling *{asker}* |
  | credential | Connect *{provider}* so *{asker}* can continue |

- The message is the gate's text, led by the asker when known ("*{asker}* — *{text}*"),
  else "From *{asker}*" ("From an automation" when unknown). Email and push read
  the message, so it keeps the asker; "needs your input" is gone.
- The host stamps `metadata.asker` (the label, sanitized) on new rows so the card
  can name the asker without parsing the message. Older rows have none and show no
  asker.
- **Language:** stored titles are English, as today. Email and push read the same
  stored text, so composing them in the SPA would split the three. Localizing
  stored request text is a separate decision, recorded here as a known limit.
- **Ratchet:** for each notified kind, with a gate that supplies no words, the
  emitted `title` and `message` match neither a dotted-id shape
  (`/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/`) nor `/\b(run|step|interrupt|node|gate)s?\b/i`.

### D3 — The card

```
●  Approval needed: Send the proposal                                   2h ago
   Harbor Lane Residence · from Send the proposal · you're a named approver
   $18,400 to Northfield Millwork, 14-week lead time.      [ Approve ] [ Decline ]   …
```

- **Line 1:** the title. Unread is weight plus a dot with an accessible "Unread"
  label, not a chip. The type chip goes. The priority chip stays only for `high`
  and `urgent`. A finished request keeps its ADR 1114 resolution chip (#5955 adds `run-deleted`).
- **Line 2:** the subject chip (ADR 1109 D4), "from *{asker}*", and the reason
  (D5), when each is known.
- **Line 3:** the message (omitted when it equals the title), then the inline
  resolver, which is the primary action.
- **"…" menu** (`ui/Menu`), labelled items: Mark as read / Mark as unread,
  Archive, Delete, and **View activity log**. The last is today's run link, offered
  when the row has a `runId` and is not `run-deleted`. ADR 1121 already answers 404
  to a person who may not read the run, so the menu needs no second permission
  check.
- **An open request cannot be silenced.** While a request is open (action-needed,
  no resolution), Archive and Delete are not offered, and the `e` key skips it.
  They return once it is decided or ended. The bulk "Archive read" skips open
  requests too. The server routes are unchanged; this is the inbox's own grammar.

  > **CORRECTED 2026-11-16 (P2, #6001):** "the server routes are unchanged" could
  > not hold for the bulk verb. `:archive-read` archives every read row on the server,
  > so the inbox could not skip an open request by itself. The route now takes an
  > optional `keep` id list (at most 500) and leaves those rows alone; the inbox sends
  > its open read requests. `keep` only narrows the caller's own set: a `keep` id is
  > never looked up, so a foreign or unknown id has no effect and reveals nothing. The
  > client still decides what "open" means, because only it knows the composed
  > features' action-needed types, the same split as `:bulk-read`. A call without
  > `keep` behaves exactly as before. The single-row archive and delete routes are
  > unchanged.
- **Collapse:** news items (not requests) with the same type, title and asker
  collapse into one card, "*{title}* · 3 times", which expands in place. Requests
  never collapse: each is its own decision.
- Snooze and "Not mine" (hand back or reassign) from #5922 are **not** in this ADR.
  Neither has a seam today (no snooze state on a notification, no reassign on an
  interrupt). Each needs its own decision.

### D4 — The page: Needs you, Updates, Archived

- Tabs become **Needs you**, **Updates** and **Archived**.
  - *Needs you* holds open requests, with the `NeedsYouInbox` queue (proposals,
    drafted actions, content reviews, board blockers) as its first section. That
    queue no longer renders above every tab.
  - *Updates* holds non-archived news and finished requests.
  - *Archived* is unchanged.
- **One count.** The Needs-you count is open requests plus the queue's items, the
  same cards the tab shows. "All caught up" shows only when that count is 0. This
  closes #5909: `NeedsYouInbox` reports its count up instead of deciding "all clear"
  alone.
- **Empty state as good news:** "Nothing needs you right now." plus the last
  decision, when there is one: the newest finished request, e.g. "Last: Approved
  *Send the proposal* · 2h ago".
- The deep-link tab mapping (`notificationDeepLink.ts`) follows the new tabs. A
  `?notification=` for a finished request opens Updates.

### D5 — Why it came to you

> **Review condition, 2026-11-15:** `metadata.asker` was read as a named approver,
> which would be personal data. It is not: `asker` is the **workflow's** name (the
> stamped `workflowName` or the definition's `metadata.name`), sanitized, never a
> person and never an id. It holds no subject, so it needs no subject eraser.
> `reason` is a closed, host-composed shape (`named`, or `role` with a role name
> from `runNoticeAudience`). It never carries model or pack text or a raw id.

The host stamps `metadata.reason` when it knows why a person got a request:
`{ kind: 'named' }` for an addressed approver (`recipientUserId` from the gate's
named approvers), and `{ kind: 'role', role }` for a role-addressed request
(ADR 0710). A broadcast carries none. The card shows "you're a named approver" or
"sent to admins". The reason is host-written only and never read from gate data.

## Behaviour that changes beyond copy and layout

1. `external-event` interrupts stop notifying.
2. `credential` requests get a Connect button in the inbox.
3. Open requests cannot be archived or deleted from the inbox UI (menu, `e`, bulk
   archive-read).
4. Identical news items collapse.
5. The tabs change meaning: Updates excludes open requests, and the Needs-you queue
   moves into the Needs-you tab.
6. New host-written notification metadata: `asker`, `reason`.

## Alternatives weighed

- **Localize titles in the SPA from `metadata.kind` plus the asker.** Email, push and
  the bell would then disagree with the card. Rejected for now (D2, known limit).
- **Give `external-event` a "waiting on…" card instead of silencing it.** It would
  be an item with no action, which the first principle forbids.
- **Enforce "open requests can't be archived" on the server.** Archive is also how
  the bell drawer and the API clear rows, and ADR 1114's bulk archive-resolved
  needs it. Keeping it UI-only changes no API contract.
- **Merge `NeedsYouInbox` items and notification rows into one list.** They have
  different stores, resolvers and cards. Putting the queue in the tab and summing
  the counts fixes #5909 without a data-model change.

## Implementation plan

| Phase | Scope | Tests / witnesses |
|---|---|---|
| P1 | D1 + D2 + D5 stamping (backend `notify.ts`, `suspendManager.ts`; FE credential case and default branch) | kind ratchet (never-notify ∪ rendered = all kinds); banned-words ratchet over every notified kind with no gate words; `workflowLabelOf` never returns the id (unknown definition → "An automation"); `asker`/`reason` stamped for named, role and broadcast; credential card renders a Connect button only for https; sabotage: drop a case or a set entry and the ratchet fails |
| P2 | D3 card, "…" menu, open-request guard, collapse (FE; after #5955) | an open request offers no Archive/Delete and `e` skips it; a finished one offers both; the menu's View activity log is absent for `run-deleted`; unread reads as dot + label, no type chip; collapse groups news but never requests; 4-locale i18n parity; `npm run build` |
| P3 | D4 tabs, one count, empty state, deep links | Needs-you count = open requests + queue items, and "All caught up" only at 0 (#5909 regression); a finished request's deep link opens Updates; empty state shows the last decision; keyboard triage still works on every tab |

Each phase is one PR, through a train.

### Implementation record

| Phase | PR | What landed | Witnesses |
|---|---|---|---|
| P0 | #5943 | `conversation` never notifies; the items already sent are retired | (#5943) |
| P1 | #5958 (train 285) | D1 kinds ratchet, `external-event` never notifies, host-built credential Connect card, fallback without the kind; D2 named asker and composed titles, banned-words ratchet; D5 `asker` and `reason` stamping | `adr1125-request-words-and-kinds`, `adr1109-readable-requests`, `adr0710-run-notice-audience` leg 6, `RenderInterrupt`, `ccUi2TimerWalkthrough` |
| P2 | #6001 (train 285) | `notifications/inboxCards.ts`; the card (dot plus label for unread, no type chip, priority only for high and urgent, line 2 from `asker`/`reason`, message dropped when it repeats the title, "…" menu with Mark read/unread, Archive, Delete, View activity log); `e` skips open requests; Archive read sends `keep`; identical news collapse | `adr1125InboxCard` legs 1–7 (five guards sabotaged red, then restored); `priorityFilter` `e` cases; `notifications-feature` `keep` cases (own, foreign and unknown ids; 501 ids refused) |
| D1 fix | #6050 (merged 2026-11-17, 57865cbf03) | the fallback links the activity log instead of advising an update (D1 correction); the unused `cardRunLink` copy is retired | `ccUi2TimerWalkthrough` controls (removing the link reds them); `resolvedRequests` locale case |
| P3 | #6062 (merged 2026-11-17, dc43ae45b9) | D4 tabs (Needs you, Updates, Archived), one count (#5909), deep links to the canonical tab (`NeedsYouInbox.tsx`, `NotificationsPage.tsx`, `notificationDeepLink.ts`) | `adr1125InboxTabs` (one count incl. the queue, #5909; the empty state names the last person's decision; each row on one tab; four guards sabotaged red, then restored); `notificationDeepLink` (a finished request's link opens Updates); `priorityFilter`, `adr1125InboxCard`, `adr1109ReadableRequests` retargeted to the new tab names |

> **CORRECTED 2026-11-19:** this record said #6050 was not merged and P3 was not started; both merged on 2026-11-17. Corrected from the merge commits; witnesses for P3 are as listed in #6062.
>
> **UPDATED 2026-11-21:** Status flipped Accepted → implemented (every planned phase has merged), and the P3 witnesses are now named from #6062's test files rather than pointed at.

## Open questions

- [ ] Snooze and "Not mine": a later ADR each.
- [ ] Localizing stored request text for email, push and the card together.
  **Accepted known limit (review, 2026-11-15):** stored titles and messages are
  English until that decision.
