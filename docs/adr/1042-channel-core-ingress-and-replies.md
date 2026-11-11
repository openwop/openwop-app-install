# ADR 1042 — channel core: ingress into the main chat, replies, pairing, dedup and rate limit

Status: Accepted (David, 2026-11-03: "do the full implementation of all of these features in waves")

Phase P0 of [ADR 1041](1041-all-surfaces-channels-program.md). Tracked as
`CHAN-P0-1` to `CHAN-P0-8` in `docs/steward/TODO.md`. This ADR covers the backend
slice (P0-1 to P0-7). The settings page (P0-8) is a later slice.

## Correction (2026-11-06) — compound IDs on PostgreSQL (CHAN-KEY-1)

The original sender, pending-sender, conversation-marker and sender-thread IDs
contained raw NUL separators, including their DurableCollection tenant index
keys and bare-ID values. PostgreSQL TEXT rejects NUL even in a bound read
parameter (measured SQLSTATE 22021 / 0x00). An ordinary conversation's marker lookup then
threw; the existing fail-closed ingress guard correctly refused its promotion.
This is a storage-identity defect, not a reason to relax that guard.

These four owners now resolve identity by a read BEFORE any index or primary
write. On stores accepting legacy NUL IDs, those exact IDs stay canonical, so
mixed old/new hosts share the same row and an old-host revocation is immediately
visible. Only an exact NUL/22021/0x00 rejection selects `v2:` plus SHA256 of the
JSON tuple, using the same selected ID in row.key, primary and index records.
PostgreSQL cannot contain a legacy raw-NUL row, so this fallback cannot discard
one. There are no aliases, dual writes, absence caches, broad scans, capability
memos or adapter-wide codecs. All other errors, including a safe-ID read failure,
remain thrown; the ingress guard continues failing closed. Thread and exchange
hashes, conversation/run IDs, authentication and protocol behavior are unchanged.

Deletes, pending approval cleanup, self selection, cap eviction and erasure use
actual stored identities. Marker erasure goes through the same marker deletion
owner instead of reconstructing a raw key. DurableCollection has no entity value
cache; its index-before-primary write is not a capability probe. Raw writes are
never attempted to discover support. A future cross-backend data transfer of
PostgreSQL safe IDs into a legacy store needs an explicit conversion/cutover,
not silent dual authority.

The original HTTP/store regression reproduced ordinary PUT 409 and direct store
failures at a faithful NUL-rejecting parameter boundary backed by the read-only
PostgreSQL measurement. Controls retain marked-ingress refusal, storage-error
fail-closed behavior, foreign-run/session refusal and old SQLite/memory marker
and revocation semantics. This host storage correction changes no wire field,
API, capability or RFC contract. The captured live promotion response confirms
`channel_ingress_conversation`; exact production exception correlation was not
logged, so the measured PostgreSQL cause remains supported by the independent
route/storage reproduction rather than an exception trace for that request.

## Context

A read-only audit of `main` (0cb39beb0, re-checked on c1f72df8d) found:

1. `features/connections/inboundWebhooks.ts` verifies Telegram, Discord and
   WhatsApp-via-Twilio deliveries, but those branches cannot be reached from the
   API. The inbound config takes its provider from the connection, and the
   registry has no `telegram` or `discord` provider, so no such connection can be
   created. A `twilio` connection always configures as inbound SMS.
2. Teams approval cards (`host/teamsApprovalDelivery.ts`) name the provider
   `microsoft365`. The audit said the registry lacks it. That is half true: the
   built-in list lacks it, but the vendored connection pack
   `examples/connection-packs/microsoft365` registers it at boot, with
   `apiHosts: ["graph.microsoft.com"]` and a `teams.write` scope group carrying
   `ChatMessage.Send`. The built-in `microsoft-graph` has neither the Teams scope
   nor any chat scope. `microsoft365` is the right id; nothing pins it.
3. WhatsApp sends need a connection-to-sender binding (`pairConnection`), and the
   only production writer is Discord's `/pair` command. No route creates one.
4. `setMessagingTransport` and `sendOutbound` have no production caller. A
   message that arrives on a channel can start a workflow, but no answer ever
   goes back.
5. Hosted webhooks dedup on the provider event id through the trigger bridge.
   The device relay validates `platformMessageId` and never uses it, and its
   bridge creates runs with no idempotency key.
6. Inbound has only the global per-IP limit.
7. Relay messages default to the `openwop-app.uppercase` workflow and keep their
   own history in `messaging_sessions`. Neither lane reaches the main chat.

## Decision

### D1. Provider registry entries

- Add `telegram` (bot token, `bearer` kind, `apiHosts: ["api.telegram.org"]`) and
  `discord` (bot token, `bearer` kind, `apiHosts: ["discord.com"]`). Both are
  `adapterOnly` with no consumer nodes: the token reaches only the reply
  transport (D4), never the generic http node.
- WhatsApp via Twilio stays on the `twilio` connection. `OPENWOP-WHATSAPP.md` and
  `whatsappService.ts` both rely on one Twilio identity for SMS and WhatsApp, so a
  second `whatsapp-twilio` registry provider would split the credential. Instead
  the inbound config route accepts `inboundProvider: "whatsapp-twilio"` on a
  `twilio` connection. Without it, a `twilio` connection configures as inbound
  SMS exactly as before.

### D2. Teams keeps `microsoft365`

The audit's fix (switch to `microsoft-graph`) would break delivery, because that
provider has no chat scope. The code is right. A test now pins that the provider
Teams names is registered at boot with the Graph host and `ChatMessage.Send`.

### D3. Pairing: the sender binding and the sender allowlist

Two different things, both behind the connection's own manage check
(`authorizeManage`, the predicate every other per-connection route uses) and a
workspace write:

- **Sender binding** (`GET|PUT|DELETE /host/openwop-app/connections/:id/pairing`).
  The existing `connections:pairing` row: which business sender or channel this
  connection speaks as. Validated per provider (E.164 for `whatsapp-twilio`, a
  numeric phone-number id for `whatsapp-cloud`, a platform id for the chat apps).
  Available when the `whatsapp` or `channel-ingress` toggle is on.
- **Sender allowlist** (`GET|POST|DELETE /host/openwop-app/connections/:id/senders`).
  Default deny. A message from a sender nobody approved is dropped and recorded
  as a pending request (no reply goes out, so an unknown sender cannot make the
  bot talk). An approval records the approving user as the sender's **paired
  owner**. A group chat is approved as `group:<chatId>` and also needs a mention
  of the bot handle set in the channel settings; with no handle set, group
  messages are dropped.

The relay lane already has pairing codes and an allowlist per messaging
connector. In conversation mode it uses them with default deny: no connector
means drop, and a connector with no policy row uses the host default policy
(DM pairing, group allowlist, mention required).

### D4. One reply transport, per provider, through the broker

`messagingOutbound.ts` becomes a per-provider transport registry with one entry
point, `sendChannelReply`. Every send:

- is keyed in the ADR 0619 send ledger (`egress:sent`, channel `chat`) on
  `(lane, inbound message id)`, so a retried or re-settled turn sends once;
- goes only to the chat (and thread) the message came from;
- runs as the thread's paired owner and, for hosted lanes, is pinned to the
  inbound connection (`connectionId`), so the broker cannot pick another row.

Transports:

| Provider | Call | Credential |
|---|---|---|
| telegram | `POST api.telegram.org/bot<token>/sendMessage` | `brokeredFetch`, token placed in the path by the broker after the host pin |
| discord | `POST discord.com/api/v10/channels/<id>/messages` | `brokeredFetch`, `Authorization: Bot <token>` |
| slack | `chat.postMessage` in the source thread | the existing `host/slackAdapter.ts`, now pinned to the connection |
| whatsapp-twilio / whatsapp-cloud | `sendWhatsApp` | the whatsapp feature registers its own transport; the strict lane keeps consent, the 24h window and its idempotency |
| relay | `enqueueOutbound` to the originating device | none (the device pulls it) |

`brokeredFetch` gains two narrow options: a `{credential}` path placeholder
(substituted after the host pin, only for a path-safe secret) and a `bot` auth
scheme. `brokeredPost` gains the existing `connectionId` pin.

A WhatsApp reply to a customer who never opted in fails `consent_denied`. That
is the strict lane working. Whether conversational replies get a
service-reply-style lane is a P2c decision for the user (ADR 0878 OQ-1 limited
that lane to one caller).

### D5. Inbound dedup on both lanes

- Hosted: unchanged. The trigger bridge `deliver` dedups on the provider event
  id (Telegram `update_id`, Discord interaction id, Slack `event_id`, Twilio
  `MessageSid`, Meta message id). Conversation mode dispatches inside the same
  `deliver`, and its exchange key adds a second guard.
- Relay: `POST …/device/inbound` claims `(relayId, platformMessageId)` with a
  compare-and-swap before any work. A duplicate answers `202 {deduped:true}` and
  does nothing. The relay bridge's self-call to `POST /runs` carries
  `Idempotency-Key: relay-inbound:<relayId>:<platformMessageId>`.

### D6. Per-connection inbound rate limit

A sliding 60-second window per hosted connection and per relay device, on the
existing in-process limiter (`middleware/rateLimit.ts`), new reason
`channel_inbound_rate`. Over the limit answers `429` with `Retry-After` and logs
`rate_limited` with that reason. Default 600 per minute
(`OPENWOP_RATELIMIT_CHANNEL_INBOUND_PER_MIN`, `0` turns it off). It applies to
the messaging providers whatever the toggle, because a limit that ships off
protects nothing; streaming/CDC ingress is exempt (it has its own dedup and its
volume is the point). Like the other in-process limiters it is per instance.

### D7. Channel messages land in the main chat

A new feature package `features/channel-ingress`, toggle `channel-ingress`,
default off. (`channels` is taken by team channels, ADR 0126.)

- **One conversation per thread.** A thread is `(connection, external chat id)`
  on the hosted lane and `(relay device, conversation id)` on the relay lane. Its
  conversation is an ordinary main-chat conversation (`chat_sessions` row plus
  `ConversationMeta`, type `agent`), owned by the thread's paired owner, so it
  shows in that person's Conversations rail. No new chat store, no new UI.
- **The agent** comes from the connection's channel settings (`agentId`); absent,
  the turn goes to the main chat's default assistant (no `to`).
- **The turn** runs through the existing exchange (`handleConversationResolve`,
  the same path the chat route uses), so it gets the agent tool loop
  (`runConversationAgentToolTurn`), BYOK and budgets, approvals and compaction
  unchanged. The conversation run is `openwop-app.conversation`, created with
  `actingUserId` = the paired owner. With no owner the message is dropped
  (fail empty), never run as nobody.
- **The exchange key** is `chan:<hash of lane and message id>`, so a redelivery
  cannot produce a second turn.
- **The reply** leaves through D4. A new seam in the exchange,
  `onExchangeSettled`, fires once both turns are durable, on the synchronous and
  the async path. The channel feature reads the agent's text from it, sends it,
  and appends both messages to the chat session so the rail shows them.
- **Workflow mode stays.** An inbound config with a `workflowId` and no
  `mode: "conversation"` keeps starting that workflow. A relay message that
  matches a routing rule keeps going to the rule's workflow or agent. With the
  toggle off, both lanes behave exactly as before, including the relay's
  `uppercase` default.

Security floor (ADR 1041 D3), held by construction: the tenant always comes
from the stored inbound config or the device record, never the request;
signature checks run before any of this; default deny on every lane; replies go
only to the source chat.

### D8. Subject erasure and teardown for every new store

Added after the coordinator's review (2026-11-03). The new rows hold two kinds
of subject: the app user who owns a thread (`ownerUserId`) and the external
person writing in (`senderId`, `chatId`; for WhatsApp an E.164 number). Two
named erasers, both in `EXPECTED_SUBJECT_ERASERS`:

- `eraseChannelIngressSubject` (`features/channel-ingress/erasure.ts`). Matches
  the owner through `subjectKeyForms`, and the external person EXACTLY on
  `senderId`, `chatId`, or the threads they wrote in (no normalising, no prefix
  match). Corrected again after the delta review (M5): who wrote where is an
  UNCAPPED index, `channel-ingress:sender-thread` (lane + sender + thread), not a
  capped most-recent list, so an early writer in a busy group is still found. Corrected after the security review (M5): a
  Slack or Discord DM's chat id is not the person's id, so matching on `chatId`
  alone missed it; and in a GROUP only that person's messages are redacted in
  place (the transcript stamps each user message with its sender), the group
  conversation stays. It deletes approved
  senders, pending senders, owed replies and threads. A deleted thread takes the
  main-chat conversation it created with it: the chat session, its messages and
  the conversation meta. This is needed because the generic chat-post eraser
  matches on `authorSubject`, and the host writes these messages with none, so
  the chat erasure alone would have left the transcript (checked, not assumed).
- `eraseRelayOwnerSubject` (`messaging/relayOwner.ts`, registered by the host
  because the row is written with the feature off too). An erased owner's
  device rows are deleted; the device then has no owner and its messages drop.

PII fields are declared per entity, not globally, because `chatId`, `senderId`
and `label` are generic names elsewhere. Every collection has a `tenantOf`, and
a test proves tenant teardown purges all of them. `messaging:inbound-claim`
holds only a device id and a platform message id: no subject.

Runs (round 3, M5): a thread remembers every conversation run it opened
(`runIds`), and erasing a DM thread or an owner's thread deletes those runs with
`storage.deleteRun`, which deletes their event logs too.

Residual, GROUPS only: when one writer in a group is erased, the group
conversation and its run stay (other people's thread). Their chat-transcript
messages are redacted, but the run's `conversation.exchanged` events keep their
turns as written: the fenced text and the fence's `sender="…"` attribute. This
host has no per-event redaction path (the event log is append-only, for replay
and `:fork`), so those events live until the run is deleted or its retention
removes it.

### D9. A group chat runs as the person who approved it

A thread belongs to one owner (since D11: the CURRENT approver; a new approver gets a new thread). In an approved group, every member's message is
a turn that runs as the approver: with the approver's tools, connections and
BYOK key, in the approver's conversation. That is the decision, because the
approver chose to approve the group. The risk is prompt injection by any group
member, acting with the approver's authority.

What bounds it: channel turns always run in safe mode (the ingress sets
`permissionMode: 'safe'`; nothing in a channel message can ask for `bypass`).
Tools with side effects ARE reachable from a channel turn, the same as in the
main chat, but the high-blast-radius ones wait for an approval recorded in the
conversation's ledger, which only the owner can grant in the app. The workflow
approval gates (ADR 0028) and RBAC still apply. Read tools are not gated, so a
group member can make the agent read anything the approver can read and say it
in the group. That is why a group needs an explicit `group:<chatId>` approval
and a bot mention, and why the settings page (P0-8) must say this before a
group is approved.

> **CORRECTED 2026-11-03 (security review of #5543) — D9's "bounded by the
> approval gates" was wrong.** The conversation-tools ledger keys an approval by
> (conversation, tool), so ONE approval covered every later call of that tool in
> the conversation, with any arguments (`approvalLedger.ts`). A group member could
> wait for the owner to approve one harmless call and then reuse it. Fixed: a
> channel-ingress turn runs the firewall with `singleUseApprovals`, so an approval
> lets exactly one call through and the ledger row is then removed
> (`spendToolApproval`); the next call of that tool, with any arguments, asks the
> owner again. This is narrower than the main chat. It is NOT ADR 0834 FW2-D1
> (replaying the held call with the arguments the owner saw): FW2-D1 is still
> deferred, so an approval is not bound to the arguments that were shown.
>
>
> **Can an approval be bound to the call the owner was shown? No, not with the
> ledger as it is (reviewer's condition, 2026-11-03).** A chat tool call that needs
> approval does not pause on an interrupt and resume: the loop records it in the
> ledger and does NOT run it; after the owner approves, the agent must re-issue a
> call on a later turn, and the firewall sees only the tool's NAME, never its
> arguments. There is no interrupt id to bind to and no stored copy of the full
> arguments to execute (the ledger keeps a capped, scrubbed display summary).
> Binding and replay is exactly ADR 0834 FW2-D1, still deferred. So, as a
> user-visible limitation: an approval lets ONE later call of that tool through,
> whatever its arguments. This is acceptable only where no one but the owner can
> make that call, which is why the decision below takes side-effect tools away
> from every channel turn that is not the owner's own.

**Decision (David, 2026-11-03): "Owner full, others narrow".**

- **Owner-self lane: full scope.** A message from the owner's own linked account
  runs with the owner's full tools (the agent's usual set), still under the
  one-call approvals above and still fenced (D10).
  - Hosted lanes: the owner's own account is an approved sender the OWNER marked
    `self` (`PUT /connections/:id/senders/:senderId/self`). Only the person who
    approved that sender may set it (managing the connection or a workspace write
    is not enough); a group is never self; at most one self sender per owner per
    lane, marking one clears the others; a re-approval by anyone clears it.
  - Relay lane: a message the platform marks as the device owner's own (the
    envelope's `fromMe: true`, from-me or note-to-self), and not in a group.
    Another contact's message in the same chat is not self.
- **Everyone else: narrow scope.** Approved outside senders, every group, and
  relay contacts. The turn is offered ONLY the lane's configured agent's explicit
  allowlist (the super-admin override, else the manifest; never the ADR 0315
  default-on baseline), through the loop's own allowlist mechanism
  (`compileAgentTools` with a full-replace allowlist).
  - **The gate is a hand-kept, reviewed list** (coordinator decision,
    2026-11-03): `CHANNEL_SAFE_READ_TOOLS` in `host/conversationToolLoop.ts`,
    beside the narrow filter. A narrow turn is offered a tool only if the
    agent's allowlist has it AND that list has it. The list starts EMPTY: every
    workspace tool reads something the owner can see and an outsider should not,
    so a tool joins only after a review that it reads nothing sensitive, across
    tenants included, with the reasoning written beside the id. As extra
    conditions the tool must also be a builtin, not held by the safe-mode
    baseline, with no classified egress, and declare `effect: 'read'`;
    `effect` stays display-only and is never the gate on its own. With the list
    empty, a narrow turn has no tools today: the model answers from its
    instructions and the conversation. Side-effect tools are never callable on a
    narrow turn, so no one outside can spend or race an approval. Every tool
    still runs as the owner, so it can never read more than the owner could.
  > **CORRECTED 2026-11-10 (CHAN-F8, user decision "propose and enable") — the list
  > is no longer empty.** A read-only review enumerated the 140 builtins that pass the
  > mechanical conditions (effect `read`, builtin, outside the safe-mode baseline, no
  > classified egress) and read each implementation. Eleven read nothing an outsider
  > should not see and are listed, each with its note: `schema.lookup` (host-global
  > registries), `ask-user` (reads nothing), the slides and app-builder catalogs
  > (constants), `accessibility.check` and `workflow-author.nodes.validate` (grade
  > only their input), and five pure compute nodes. The other 129 read workspace,
  > org, owner or conversation data and stay off; `workflow-author.nodes.draft` stays
  > off because its result names the packs the workspace disabled; four pure tools
  > stay off because they look broken when run as a chat tool (they need node config
  > or `ctx.features` the tool path does not pass). Test:
  > `adr1042-channel-safe-tools.test.ts` (the pin, the notes, and each id still
  > offered after a real boot). Found by the review, not changed here: the egress
  > classifier's `core.openwop.http` prefix never matches the agent tool id
  > `openwop:core.openwop.http.fetch`, so that tool is unclassified and only the
  > safe-mode baseline keeps it off narrow turns. Classifying it `safe-fetch` would
  > LOOSEN tenant rules (an unclassified tool counts as the riskiest class), so it is
  > logged as `CHAN-F16` rather than patched.
  - **No agent memory on a narrow turn** (chosen over refusing memory-bearing
    agents): the exchange passes `suppressRecall`, and the agent's long-term
    knowledge/memory and a granted twin's borrowed recall are not loaded into
    the context. The test witnesses the flag reaching the composer; the two
    guarded legs in `chatContext.ts` are not exercised with a real memory
    store in this slice.

> **Added after the delta review of #5543 (N1).** "Others narrow" first protected
> only the CURRENT turn: a relay chat's self and contact turns shared one
> conversation, and that conversation is also open in the owner's main chat,
> where in-app turns had no channel scope. A full-tools turn could read an
> outsider's earlier text from history. Two rules close it, both enforced in code:
> 1. **Self and narrow never share a conversation.** The scope is part of the
>    thread key, so the owner's own turns and outsiders' turns live in different
>    conversations ("… (you)" for the self one).
> 2. **A narrow conversation is narrow for every turn, forever.** Its run is
>    stamped `channelIngress.scope: 'narrow'` at creation, and the tool loop and
>    the context composer read that stamp on every turn, so an in-app turn the
>    owner sends from the main chat into it also gets only the narrow tools and no
>    agent memory. Chosen over filtering history because history filtering would
>    have to be correct in every place a turn's history is assembled; a run stamp
>    is checked in one.
>
> **Relay self lane (N1).** A from-me message is the owner's own lane only in the
> owner's note-to-self chat: its chat id must equal the device's own account id,
> given by the signed-in owner at registration (`accountId`). A from-me message in
> any other chat is the owner writing to a contact, not a command, and is skipped
> (`own_outgoing`); a client that flags every outgoing message gains nothing.
> Groups are detected by one explicit rule per channel (`messaging/groupDetection.ts`,
> shared with the relay's policy gate): WhatsApp `@g.us`, Signal
> `channelMeta.groupId` or a `group.` id, iMessage `;+;` GUIDs, Discord guilds,
> the relay's `group:`/`chat:` ids, and `channelMeta.isGroup`.
>
> **N2.** Closing a channel conversation extracts no memory (ADR 0982): its user
> turns are other people's words.
>
> **Round 3 (N1 holes, N4).** Two core routes could still move outsider history
> into an unstamped run. `PUT /chat/sessions/:id/conversation-run` re-bound a
> channel session to a fresh run when its stamped run ended (`refuseChannel`
> covers only team channels, `type:'channel'`; channel-ingress threads are
> `type:'agent'`), and `POST …/branch` copied the transcript into an ordinary
> session. Both now answer **409, `reason: channel_ingress_conversation`** for any
> channel-ingress session, narrow and self alike; the channel core opens its own,
> correctly stamped runs. Refusing was chosen over stamping a replacement run
> because the route cannot know the thread's scope or allowlist, and refusing is
> one check. N4 (an unindexed branch escaping erasure) is closed by the same
> refusal. Core learns which sessions are channel threads through a registered
> check (`host/channelConversationGuard.ts`, a `channel-ingress:conversation`
> marker per session). The check fails closed only when the registered check
> throws (it then answers "channel conversation"); when no check is registered
> (the channel-ingress feature absent) it answers false, because no channel
> conversation can exist.
> Model-facing reads exclude them too: `openwop:conversations.search` drops
> channel conversations from its hits, and `openwop:runs.diagnose` treats a
> channel conversation's run as invisible (the same empty answer as a foreign run).

### D10. Channel text reaches the model fenced as untrusted

Added after the security review (H3). The model's turn for a channel message is
the text inside the house `<UNTRUSTED>` fence (`wrapForLLMPrompt`, the fence the
MCP lane uses), with `channel` and `sender` (the platform sender id) as
attributes and one host line saying it was written by that sender, not by the
user. The fence markers inside the text are defanged. The chat transcript keeps
the plain text. Every channel turn is fenced, the owner's own included (D9).

### D11. The current owner, still present, every message

Added after the security review (M4). Each message runs as the CURRENT
approval's owner (hosted) or the CURRENT device owner (relay), read per message.
The owner is part of the thread's key, so when the approval moves to someone
else their messages start a new thread and conversation; another person's
conversation is never reused. Before a turn, and again before its reply is
sent, the owner must still be present in the workspace (the auth middleware's
rule: present in their own personal workspace, otherwise a workspace member);
if not, the message is dropped with reason `owner_not_member`.

What else re-checks membership (review question (a)): an org-shared connection
does (the broker requires `connections:use`, which a removed member no longer
holds); a personal or workspace connection does not, and neither does the tool
loop. The ingress and reply checks above close that for channel turns. The
broker gap for other actorless lanes is not this ADR's and is reported to the
coordinator.

### D12. Strangers never spend the budget; the webhook is acknowledged first

Added after the security review (M6, (c), H1, L7).

- In conversation mode, a verified message is ADMITTED (approved sender;
  addressed, in a group) before the connection's inbound budget (D6) is taken.
  A stranger, a non-message, or an un-addressed group message gets a plain 200
  and is dropped at no cost; Slack disables endpoints that keep failing, so it
  must never be pushed into 429s by people outside the allowlist. Strangers are
  recorded as pending under their own budget (30 per minute per lane, never a
  429) and at most 100 pending rows per lane, the least recently seen evicted.
- Opening the conversation run (which can take up to 15 s) and the turn run
  detached, after the webhook is acknowledged (Slack and Discord allow 3 s).
  Redelivery stays harmless: the trigger bridge or relay claim deduped it, and
  the exchange key makes a second turn impossible. Turns of one thread run in
  arrival order in-process; two instances can still race on one thread.
- The exchange key, the reply ledger key and the transcript message ids include
  the chat and thread ids (H1): a platform message id can be unique only within
  one chat, so two chats with message 7 shared a reply row before.
- The relay dedup claim is keyed on (device, conversation, platform message id),
  expires after 7 days (`OPENWOP_RELAY_INBOUND_CLAIM_TTL_DAYS`) on read, and is
  swept, bounded, on the webhook-delivery worker tick (L7).

### No wire change

Everything is under `/v1/host/openwop-app/*` or host-internal. No RFC is needed.

## Alternatives considered

- **Keep `messaging_sessions` as the relay history.** Rejected: a second chat
  store is what CLAUDE.md forbids, and its turns never reach the agent tool loop.
- **A new `channel` conversation type.** Rejected: `type:'channel'` already means
  a team channel (ADR 0126). An external thread is a one-person conversation with
  an agent, which is `type:'agent'`.
- **Start the conversation run with `startWorkflowRun`.** Rejected: it strips
  `actingUserId`, so the turn would run as nobody and the tool lane would fail
  every user-scoped read.
- **Reply from inside the exchange.** Rejected: the exchange would import a
  feature. The settled seam keeps the dependency pointing inward.
- **A `whatsapp-twilio` registry provider.** Rejected (D1).
- **Reply with a pairing code to unknown senders on hosted lanes.** Deferred: it
  lets anyone make the bot send a message. The relay lane keeps its existing
  pairing code reply because the device owner chose it.

## Consequences

- With the toggle on, a channel turn costs a model call charged like any chat
  turn (managed or the owner's BYOK).
- Detached work: the exchange already finishes tool turns in the background, and
  the ingress opens the run and kicks the exchange without holding the webhook.
  CPU is always allocated on the service (ADR 0741), so this is the existing
  shape, not a new one.
- Discord free text still needs the gateway worker (P2d). Here Discord carries
  application-command interactions only, answered with an ephemeral
  acknowledgement and then a channel message.
- The per-instance limiter under-counts when the service scales out.

## Implementation record

| Item | What | Commit | Test |
|---|---|---|---|
| CHAN-P0-2 (D2) | Teams provider pinned, no switch | c74f0c171 | `teams-delivery-provider.test.ts` |
| CHAN-P0-1 (D1) | `telegram` and `discord` registry entries; `whatsapp-twilio` inbound on a `twilio` connection | abe5192d2 | `adr1042-channel-providers.test.ts` |
| CHAN-P0-5, P0-6 (D5, D6) | Relay inbound claim, bridge Idempotency-Key, per-connection and per-device budget | 01e77e094 | `adr1042-inbound-dedup-and-rate-limit.test.ts` |
| CHAN-P0-3, P0-4, P0-7 (D3, D4, D7) | `channel-ingress` feature: binding and sender routes, reply transports, `onExchangeSettled`, both lanes into the main chat | db087fbbb | `adr1042-pairing-routes.test.ts`, `adr1042-reply-transport.test.ts`, `adr1042-channel-ingress.test.ts` |
| D8, D9 | Subject erasure and teardown for the new stores; channel turns pinned to safe mode | 0e0987de9 | `adr1042-channel-erasure.test.ts` |
| Security review of #5543 (H1, H2, H3, M4, M5, M6, L7, (a)-(c)); D9 corrected, D10-D12 | Chat-scoped keys, single-use approvals, untrusted fence, current-owner threads and presence, erasure by sender, admission before budget, detached turns, relay claim TTL and sweep; D9 "Owner full, others narrow" with the reviewed safe-tool list and no recall on narrow turns | f89c540dd | `adr1042-channel-ingress.test.ts`, `adr1042-single-use-approvals.test.ts`, `adr1042-channel-erasure.test.ts`, `adr1042-inbound-dedup-and-rate-limit.test.ts`, `adr1042-telegram-token-redaction.test.ts` |
| Delta review of #5543 (N1, relay self lane and group detection, M5 index, N2) | Scope in the thread key, narrow-stamped runs for every turn, note-to-self only, uncapped sender-thread index, no memory on close | abdcc5b43 | `adr1042-channel-scope.test.ts`, `adr1042-channel-erasure.test.ts`, `adr1042-no-memory-on-close.test.ts` |
| Round 3 review of #5543 (N1 holes, N4, M5 runs, search/diagnose exclusion) | Re-bind and branch refused for channel sessions, search and diagnose exclusion, thread runs erased | 582be5fd2 | `adr1042-channel-conversation-guards.test.ts` |
| Gate train 366 (six whole-src ratchets) | Two were real and fixed in code: the conversation run now launches through `resolveLaunchWorkflow` (ADR 0823 funnel, was a direct catalog read), and the ingress no longer reads the agent from the registry; the narrow list now comes from the SERVED agent inside the tool loop (ADR 1014: deployment, pins, served version), so it always matches the agent that answers. The run's metadata is FRESH (ADR 0604 H1) and now carries `trustBoundary: 'untrusted'`. Classified with reasons: the run creator (ADR 0823 minters, ADR 0987 admission census, ADR 0604 FRESH row), the settings route's save-time agent check (ADR 1014 metadata list, the chat-widget precedent), and `channel-ingress` as acknowledged demo-data-free. Two unused test-only exports removed. | cee5aee37 | the six ratchets, `adr1042-channel-scope.test.ts` |
| CHAN-P0-8 (D3, D9) | The channels settings page, a tab in the Access console (`/access?tab=channels`, route `/access/channels`), gated on `channel-ingress`: chat connections with inbound mode and answering agent; per connection the agent, bot handle, model and sender binding; pending senders (approve, deny), approving a group only after the D9 warning is acknowledged, a person with the "reviewed read tools only" note; approved senders (revoke, "This is me" only on the caller's own non-group approval); relay devices (owner, account to its owner only, heartbeat, revoke). Three backend additions, each under its siblings' predicate: `GET …/senders` marks each approval `mine`; `DELETE …/senders/:senderId/pending` denies a request (the sender stays blocked); `GET /messaging/relay/devices` (the `relay/revoke` tenant rule, no secrets). Not built: the relay lane's agent and model (no route, the P1 item below), changing a connection's inbound mode (its route needs the signing secret; that stays on Connections), and the relay lane's pairing codes, allowlist and DM/group policy (their existing `/messaging/*` routes are keyed by messaging connector, not by device; a later slice). | (this branch) | `ChannelSettingsPage.test.tsx`, `adr1042-channel-settings-reads.test.ts` |

Status of the record: P0-1 to P0-7 merged in #5543 (b595fda72, 2026-11-03),
deployed with `channel-ingress` off. CHAN-P0-8 is on branch
`feat/adr-1042-p0-8-channel-settings`, not merged.

> **UPDATED 2026-11-05.** CHAN-P0-8 merged in #5558 (df995f5bc, 2026-11-04) and is
> deployed with `channel-ingress` off. Every P0 item is merged; the feature stays
> off until the user enables it (TODO `CHAN-U9`).

> **Correction during implementation (D1, D4).** The relay's bridge first sent
> `Idempotency-Key: relay-inbound:<relayId>:<id>`. The v2 key grammar is
> `[A-Za-z0-9._~-]{22,128}`, so every bridged run was refused with a 400 and no
> run started. The existing relay suite caught it; the key is now a SHA-256 of
> the pair. The `{credential}` substitution was rebased onto ADR 1035 D1, so the
> broker dispatches the same parsed `href` its instance pin checked.

> **Correction (D4).** The deep-investigation exchange path answers with a run
> bubble, not text, so it does not announce `onExchangeSettled`, and a channel
> message routed to a deep-investigation agent gets no reply on the channel.
> Deep investigation is default off. Recorded for P2.

> **Review round 4 (export).** A channel conversation cannot be downloaded
> (`GET /chat-export/:sessionId`, 409 `channel_ingress_conversation`), saved as a
> Document (`openwop:conversations.export-document` refuses it: its messages have
> no `authorSubject`, so the sole-author check alone would have passed), or
> re-imported (`POST /chat-export/import` refuses an openwop-v1 export whose
> source `sessionId` is a channel conversation). A copy would escape the thread's
> erasure and be searchable. Test: `adr1042-channel-conversation-guards.test.ts`.

## Open questions

Named items from the delta reviews of #5543 (none blocks the train; each needs
its own change). The multi-instance group: H2, the M4 queued-start re-check, N3,
the runIds race, and the fence near-miss variants.

- **H2 multi-instance race.** The spent approval is written after the loop
  returns, and turns are serialised per thread only within one process. Two
  instances can each run a turn that spends the same approval once.
- **M4 re-check when a queued turn starts.** Presence is checked when a message
  arrives and again before its reply is sent, not when a turn queued behind
  another finally starts.
- **N3.** The pending-recording budget map clears every lane at once when it
  passes 10,000 lanes, briefly lifting every lane's limit.
- **Detached turn loses the message.** If opening the conversation run fails, or
  the exchange answers 409, the detached turn logs and stops; the provider
  delivery was already acknowledged and deduped, so the message is not retried.
- **runIds read-modify-write race.** A thread records each conversation run it
  opens by reading the thread row, appending to `runIds` and writing it back
  (`ingress.ts`, the run-recording step). Two instances opening runs for one
  thread at once can lose one id, and erasure would then miss that run. Same
  class as the H2 multi-instance race: turns are serialised per thread only
  within one process. Fix with a compare-and-swap on the thread row, or a
  per-run index keyed by thread.
  > **CORRECTED 2026-11-10 (CHAN-F3) — the multi-instance group above is closed,
  > item by item.** Each fix assumes a second instance (or a crash) and holds without
  > the per-thread in-process chain.
  > - **H2.** A channel turn now CLAIMS its approvals before the loop runs
  >   (`claimApprovedToolApprovals`, a compare-and-delete per approved row), and only
  >   the rows it won are folded into its firewall (`approvalsForTurn` in
  >   `conversationToolLoop.ts`). Two instances cannot both win one row. When the loop
  >   returns or throws, the spent claims stay deleted and the rest are handed back
  >   with `putIfAbsent`, so a fresh ask or a denial written meanwhile wins.
  >   `spendToolApproval` (spend AFTER the loop) is deleted. Fail-safe by construction:
  >   while a channel turn holds a claim, another turn on the conversation sees no
  >   approval and asks again; a crash mid-turn loses the unspent claims (the owner
  >   approves again), never duplicates one.
  > - **M4 at queued start.** The turn re-checks the owner's presence when it starts,
  >   not only when its message arrived; a turn queued behind another runs nothing
  >   (and drops its pending reply) for an owner removed meanwhile.
  > - **N3.** Over 10,000 lanes the pending-recording budget evicts the
  >   least-recently-used lane, one at a time, instead of clearing every lane; a lane
  >   being flooded stays limited.
  > - **Detached turn lost.** A failed conversation-run open or a failed exchange is
  >   retried twice (2 s, then 8 s). The exchange key makes a retry that already landed
  >   a no-op. A `conflict` "already in progress" means another instance holds this
  >   very message, so this instance stops without retrying and leaves the pending
  >   reply to it. After the last retry the turn logs `channel turn unanswered after
  >   retries` and drops its pending reply. The sender is not told; that would be a
  >   host-authored message to an outsider, a product decision not made here.
  > - **runIds race.** Recording a run on its thread is a compare-and-swap
  >   (`recordThreadRun`), and it never re-creates a thread erasure deleted. A thread's
  >   first creation is create-if-absent (`createThreadOnce`), so a racing first
  >   message cannot overwrite runs already recorded.
  > Tests: `adr1042-multi-instance-races.test.ts` (runIds, N3, retries, M4 at queued
  > start) and `adr1042-single-use-approvals.test.ts` (claim before use,
  > `approvalsForTurn`), sabotage-witnessed one edit at a time. Not witnessed by a
  > test: the two lines in `runConversationAgentToolTurn` that call `approvalsForTurn`
  > and settle it (no test drives a full chat-lane turn through a gated tool; the
  > spend wiring it replaces was not witnessed either).

- **N5.** The `channel-ingress:sender-thread` index has no TTL or sweep; it grows
  with every (lane, sender, thread) and is trimmed only by erasure and teardown.

  > **CORRECTED 2026-11-09 (CHAN-F5) — closed by trimming at thread deletion, not
  > by a TTL or sweep.** A row's lifetime is exactly its thread's: erasure needs it
  > for as long as the thread (and its transcript) exists, so a time-based TTL would
  > make an old writer unfindable, which is the M5 defect again. Only subject erasure
  > deletes a thread (teardown purges the whole tenant), and it used to delete just
  > the ERASED writer's index rows. Erasing an owner, or a DM writer, therefore left
  > every other writer's rows pointing at a deleted thread. Those orphans were the
  > only unbounded growth, and they kept outsider ids for nothing. `eraseChannelIngressSubject`
  > now deletes a thread's whole index with it. It deliberately does NOT sweep rows
  > whose thread is missing: `ensureThread` writes the index row before the thread,
  > so that sweep would race a first message and drop its writer. Test:
  > `adr1042-channel-erasure.test.ts` case (f), sabotage-witnessed.
- **Autotitle (LOW) — closed, not open.** A channel session is created with
  `titleSource: 'given'`, which ADR 1019 never auto-titles, so no outsider text
  reaches a title. The title is `<channel> · <chat id>` (plus "(you)").
- **Fence near-miss variants.** `defangAngleFence` handles `<UNTRUSTED` and
  `</UNTRUSTED`; spaced, entity-encoded or full-width variants are not normalised.
  This belongs in one shared helper used by every lane, not a channel-only patch.

  > **CORRECTED 2026-11-10 (CHAN-F4) — closed in the one shared helper, not a
  > channel patch.** Every lane already reached the fence through
  > `host/untrustedContent.ts` (the channel lane via `wrapForLLMPrompt`, MCP via
  > `defangPeerFence`, tool results via `fenceUntrustedBlock`, RFC 0124 via
  > `promptCompose`), so the fix is in its two matchers. `defangAngleFence` now also
  > neutralises whitespace before the slash (`< /UNTRUSTED>`), full-width and
  > small-form brackets, slash and letters, invisible format characters (Unicode Cf:
  > zero-width space, soft hyphen, bidi marks) between letters, and numeric or named
  > entity openers and slashes. `defangUntrustedFence` (and `neutralizeUntrusted`,
  > which now calls it) does the same for `BEGIN`/`END UNTRUSTED CONTENT`. A matched
  > marker is folded (NFKC, format characters dropped) and keeps its case and
  > whitespace, so every spelling the old matchers caught produces byte-identical
  > output, and a defanged string defangs to itself. Entity openers are NOT live
  > markers: `&lt;` is the house's own defanged form, so they are only folded to it.
  > A new `hasUntrustedFenceMarker` is the shared detector for lanes that must refuse
  > a marker rather than defang it; it flags live openers only, so it never flags
  > defanged output. `kb/contextualEnrichment` uses it for the model-echo check. The
  > classifiers in `job-search` (`inboxClassification`, `screening`) keep their own
  > patterns: they flag SYSTEM/INSTRUCTIONS markup too, a different job from fencing.
  > Test: `src/host/__tests__/defangAngleFence.test.ts` (CHAN-F4 block), sabotage-
  > witnessed: with the old matcher bodies, 13 near-miss and channel-lane cases go
  > red and the compatibility and benign cases stay green.

- Broker membership re-check for NON-channel lanes (owner: f2). The broker
  re-checks a removed member only for org-shared connections; a personal or
  workspace connection used by a run stamped with a departed member's
  `actingUserId` (a scheduled run, a heartbeat, a resumed run) is not refused.
  D11 closes it for channel turns only.

  > **CLOSED 2026-11-07 (CHAN-F1).** The check now sits in the broker's one
  > choke point, `authorizedCandidates` (`connectionsService.ts`
  > `actingUserPresent`). Every consumer and both selection shapes (ranked and
  > exact-pin) pass through it, so it holds on every lane, channel or not.
  > The rule:
  > - **Shared (`ws:`) workspace, person actor:** the actor must still hold a
  >   root membership. This is the auth middleware's ADR 0015 defence-in-depth
  >   rule, which holds even with enforcement off. It matches the same spellings
  >   as the org check (`actingUserIds`). A person who has left gets no
  >   connection at all: not their own, not the workspace's, not an org's.
  > - **API key actor:** present while its issuer is (ADR 0795 D6, the same
  >   reading auth applies).
  > - **Unchanged:** a non-person actor (operator bearer, service principal),
  >   an actor-less send, and any non-`ws:` tenant. A personal tenant has no
  >   member rows.
  > - **Fails closed:** an unreadable membership withholds the credential for
  >   that call.
  >
  > The ADR 0815 D4 cascade still pauses the departed member's schedules. The
  > broker check covers what that cascade cannot reach: runs already parked
  > and resumed later, heartbeats, and anything that is not a scheduled job.
  >
  > Left out on purpose: the ADR 0910 declared default workspaces
  > (`isMembershipRootedWorkspace`), because an operator activation that is not
  > a member can act there. Widening the check to them is a separate decision.
  >
  > > **CORRECTED 2026-11-07 (David's decision): widened to the declared default
  > > workspaces, membership only.** The reason given above was false.
  > > `activateOperatorAccess` creates the operator's root (viewer) membership
  > > before the activation goes live (the participant floor), and a live
  > > activation without one is no authority (ADR 0910 D4/D5) and is revoked by
  > > the sweep. So the gate is now `isMembershipRootedWorkspace`: in a default
  > > workspace a person must hold the root membership, exactly as in `ws:`.
  > > A live activation is NOT presence on its own, so a removed operator gets
  > > nothing. An API key there needs a live issuer AND, for a person issuer,
  > > that issuer's root membership: auth's own reading does not ask for
  > > membership outside `ws:` (`membershipDefinesPresence`), and widening that
  > > would change authentication, which this decision does not cover.
  > > Test: the `D1`–`D5` legs of `test/chan-f1-broker-presence.test.ts`.
  >
  > Test: `test/chan-f1-broker-presence.test.ts` (sabotage-witnessed). The
  > ADR 0780 D3 race legs' owners became workspace members, as real owners
  > are.
- FW2-D1 (ADR 0834): bind an approval to the held call and replay those exact
  arguments. Until it lands, D9's one-call approvals are not argument-bound.

- P2c: a conversational reply lane for WhatsApp customers who wrote first but
  never opted in (user decision; ADR 0878 OQ-1 precedent).
- P0-8: the settings page for bindings, senders, pending requests and policy. Built (see the record); the relay lane's agent and model wait for the P1 route, and its pairing and policy are not on the page yet.
- P1 (ADR 1043): a sweep for the relay inbound claim rows, a device owner
  bound at activation rather than at registration, and a settings route for a
  relay lane (agent, model). Today a relay lane uses the default assistant on
  the tenant's default model.
