# ADR 1156 — A held tool call is approved on a card in the chat, in one press

Status: Accepted (2026-11-23). P1 is implemented in the PR that carries this
ADR. P2 is Proposed and is not built until the user decides it.

A chat agent's held tool call (ADR 0132, ADR 0834) gets a card in the message
list, at the turn that raised it, in the full chat and the embedded one. One
press on Approve approves exactly that call and continues the conversation. The
card says what happened next. Host-extension only: no RFC (see "The wire").

## Context

The user hit this on a white-label adopter's production. The adopter's agent
edits a mood board through a tool held for approval. Approving took three steps
(open the composer's tool control, approve in its dialog, press Continue) and
the user said it was not intuitive: "it should all be in the chat exchange and
more simple to understand". The adopter's session found, and this host's code
confirms on `029324b150`:

1. The embedded chat (`EmbeddedChatPanel`) shows no approvals control at all:
   `useComposerModifiers` is mounted only by `ChatSidebar` and `TabSession`. The
   full chat shows the control in the composer row, away from the message that
   raised the call.
2. After approval, Continue is an ordinary new turn. The model has to call the
   tool again, and a `call`-grain approval matches only an HMAC of the call's
   full canonical input (`approvalLedger.ts` `makeApprovalGrant`). Twice the
   model re-sent different JSON; the approval did not match and the person was
   asked again with nothing saying why.
3. A held call is written to the ledger when the turn ends
   (`conversationToolLoop.ts`, after the loop returns).
4. The display copy of the arguments is capped at 2,048 characters
   (`REQUESTED_INPUT_MAX_CHARS`). An adopter's change runs to dozens of lines
   and cannot be shown in full, and raw JSON is not something a person reviews.
5. A denial is sticky for the tool, any arguments: the ledger holds one row per
   tool per conversation, `recordToolApprovalRequested` keeps a denied row
   verbatim, and `scopeFoldRows` folds every denial into the scope, which drops
   the tool from the conversation. Nothing undoes it.

The adopter worked around this in its own lane (a non-held "propose" tool, its
own store, a card in the embedded panel's `composerModifiers` slot and its own
apply route). That only works where its panel is mounted; in the full chat a
person still gets the platform dialog.

## Decision

### P1 — implemented

| # | Decision |
|---|---|
| D1 | **The card is the ledger row, shown in the feed.** It is not an interrupt and has no resolve path of its own: it reads the conversation-tools ledger through the existing `GET …/capability-scope` and decides through the existing `POST …/approvals/:toolName`, with the same `requestedAt` version check and the same authority. So ADR 0834 D6's disposition stands (no `interrupt.approval` card, no second approval path); what changes is where the one path is shown. The composer control stays as the conversation-wide list. |
| D2 | **Where it goes.** When a turn records a held call as pending, the exchange appends a host-extension run-log event `openwop-app.conversation.tool-approval-requested` `{conversationId, askId, toolName, requestedAt}`, where `askId` is that agent turn's wire message id: the ADR 1001 D7 clarification-card precedent. The client reads it from the same events poll and puts the card under that turn. The event carries **no arguments and no description** (D6 keeps them only while the ask is open), so the card fetches those live from the ledger. The ledger row records the `askId` of its latest ask. |
| D3 | **Host-written words.** A conversation tool may declare `describeApproval(input)`, returning plain lines a person can review (the adopter's: one line per change, grouped). The loop calls it when it records the hold; the lines are secret-scrubbed, capped at 200 lines of 400 characters, stored on the ledger row as `requestedLines`, and cleared on decision like `requestedInput`. A describer that throws or returns nothing falls back to the raw arguments. The card shows the lines; the raw arguments are behind an expander. Text comes from the tool, never the model. |
| D4 | **One press.** Approve on the card posts a `call`-grain approval for the version shown, then sends the existing Continue message through the surface's own submit. The person does nothing else. Decline posts a denial. A `409` (the ask moved) reloads the card instead of guessing. |
| D5 | **What was shown is what runs, or nothing runs.** P1 cannot run the stored call (that is P2), so it makes the failure visible instead of silent. After the continue turn the exchange appends `openwop-app.conversation.tool-approval-settled` `{conversationId, askId, toolName, outcome, reason?}`: `ran` (the approved call executed), `refused` (it executed and the tool returned an error, whose message, capped at 300 characters and scrubbed, is the reason: a stale-version refusal reads plainly), or `superseded` (the model asked for different arguments, so the approval was not used and a new card asks again). The card shows the outcome; it never says "approved" over a different change. |
| D6 | **Decline is for that call.** A denial now has a grain. The card's denial is `call`-grain: it covers only the arguments it was shown (the row keeps their digest). A later call with different arguments is a new ask with a new card. The same call again is refused to the model at once (`approval_declined`, "the person declined this exact request; do not retry it") instead of being held again with no card. `scopeFoldRows` folds only tool-wide (and legacy grain-less) denials, so a call-grain denial no longer removes the tool. The composer dialog's Deny keeps its tool-wide meaning. |
| D7 | **Who may press it.** The route's ADR 0834 D3 authority (the principal the tools act as, the owner) plus: the request must come from a signed-in person's session, not an API key or an agent token. A card shown to anyone else is read-only and says who can approve. |
| D8 | **Both chats.** `MessageFeed` renders the card, so the full chat, the tab deck and the embedded chat all get it. A surface passes the conversation's session id and its submit; without them (an ephemeral embed with no persisted conversation) no card is shown, as before. The card is lazy-loaded with its client. It is keyboard-reachable, and a status change is announced in a polite live region. |
| D9 | **A feature may draw its own card.** If a card is registered for `tool-approval.<toolName>` in the chat `CardRegistry`, it renders instead of the default, receiving the row, the lines and the outcome as its payload, and `approve` / `decline` as actions that go through D4. This is the seam the adopter asked for; it adds no store and no route. |

### P2 — Proposed, not built

**Run the approved call itself.** On the continue turn, before the first model
call, the host executes the call the model already authored in the previous
turn, with the arguments that were approved, inside the new turn's live run,
then gives the model the result. This closes D5's remaining gap: the model no
longer has to repeat itself.

It revisits ADR 0834 FW2-D1, which rejected running the held call from the
*approval route*. Of its five objections, two do not apply to this shape: the
tool events land on a live run that is executing, and the tool call is the
model's own, from its previous turn. Three still need answers before it is
built:

- **Arguments at rest.** The full, unscrubbed input must be kept until the ask
  is decided (encrypted with the KMS seam, deleted on decision, on the channel
  TTL, and on conversation delete), not only its digest.
- **The wire.** RFC 0064 must allow a tool-return in a turn before the turn's
  first model call. Read the RFC; if it does not, P2 needs an RFC revision in
  `../openwop` first.
- **Replay and fork.** A replayed turn must reuse the recorded result, never
  re-execute, and a fork must not re-run an approval the forker never gave
  (ADR 0834 D3 / FW2-CD-1).

### Not in this ADR

A tool-id class on `CapabilityRule` ("always ask for this tool, for every
conversation") is not needed for the adopter's case. A feature can already
narrow every conversation with `registerConversationScopeContributor` (ADR 0856
D2), returning `requireApproval: ['<tool>']`. The ADR 0132 scope gate it feeds
checks only an explicit approval, so bypass mode does not satisfy it.

## The wire

None of this is on the OpenWOP wire. The ledger, its routes and both new events
are host-extension (`/host/openwop-app/*`, `openwop-app.*` event types; the
clarification-card events are the precedent). What the wire carries is
unchanged: RFC 0064 `agent.toolReturned` with `status:'forbidden'` and a
host-chosen `error.code`, of which `approval_declined` is one more. No RFC.
P2 may need one (above).

## Alternatives weighed

- **Reuse the `interrupt.approval` card.** Rejected again, for ADR 0834 D6's
  reason: a held chat call has no interrupt record, and minting one is a second
  approval path.
- **Only move the gear into the feed (no outcome).** Rejected: it fixes the
  three steps but leaves finding 2 silent, which is the part that misleads.
- **Feature-only seam (the adopter's option B) instead of a platform card.**
  Rejected as the only answer: every adopter would rebuild the same card. Kept
  as D9 on top of the platform card.
- **Run the stored call from the approval route.** Rejected by ADR 0834 FW2-D1,
  and still rejected; P2 is a different shape and is left to the user.
- **Put the arguments in the run-log event** so the card rebuilds without the
  ledger. Rejected: the run log is kept for the life of the conversation, and
  D6 keeps the arguments only while the ask is open.

## Trade-offs

- After a decision, a reloaded card shows the outcome and the tool, not the
  change itself (cleared with the ask, by design).
- P1 still depends on the model repeating the call. When it does not, the
  person sees "superseded" and a new card, which is honest but is a second
  press. P2 is the fix.
- `requestedLines` makes a pending row larger (up to ~80 KB) for as long as the
  ask is open.

## Phased plan

| Phase | What | Status |
|---|---|---|
| P1 | D1–D9: the card, the two events, `describeApproval`, call-grain denial, the person-session check, the feature card seam | implemented in this PR |
| P2 | Run the approved call on the continue turn (above) | Proposed; needs the user's decision and the RFC 0064 reading |

## Implementation record

| Phase | Commit | Tests |
|---|---|---|
| P1 | (this PR) | `backend/typescript/test/adr1156-held-call-card.test.ts`, `frontend/react/src/conversationTools/__tests__/HeldCallCard.test.tsx` |

## Open questions

1. P2: build it? (The user's call; see above.)
2. Should the composer dialog's Deny also become call-grain by default, with
   "block this tool" as a second choice? Left as is in P1, so its meaning does
   not change under anyone.
