# ADR 1043 — the device relay to production grade

Status: Accepted (David, 2026-11-03: "do the full implementation of all of these features in waves")

Phase P1 of [ADR 1041](1041-all-surfaces-channels-program.md), wave 2. Tracked as
`CHAN-P1`. It builds on the channel core of [ADR 1042](1042-channel-core-ingress-and-replies.md):
the relay lane, the self lane, `own_outgoing`, `messaging/groupDetection.ts` and the
relay inbound claim. Two repositories change: this host (the gateway routes under
`/host/openwop-app/messaging`) and `openwop-cli` (the relay device, `openwop relay`).

## Context

The device relay is how a personal WhatsApp, Signal or iMessage account reaches the
app (ADR 1041 D1). The user reversed MyndHyve decision 6(e) for it on 2026-11-03, on
the terms in ADR 1041 D2. ADR 1042 connected the relay to the main chat. It did not
make the relay something a user can leave running. A re-check of the 2026-11-03 audit
on `main` (b595fda72, openwop-cli c79957e) found:

**Server (`routes/messaging.ts`, `messaging/*`).**

1. No activation lockout. A wrong activation code costs nothing and can be retried
   until the 10-minute window closes.
2. The owner is bound at registration (`recordRelayOwner` in `/relay/register`), not
   at activation, and `/relay/activate` never checks the caller's tenant. Anyone with
   the relay id and code, in any tenant, could mint the device token.
3. No offline marking. `lastHeartbeatAt` is written, and only the connector probe
   reads it.
4. No token rotation. The 30-day token simply expires, and every expiry, revocation
   or unknown token answers the same `401`, so a client cannot tell them apart.
5. `/device/ack` takes only successes. A failed send stays in the queue and is
   retried forever, with no record of why.
6. A relay lane's agent and model have a store (`channel-ingress:settings`, lane key
   `relay:<id>`) but no route. Today a relay lane always uses the default assistant on
   the tenant's default model. Revoking a device leaves its lane settings behind.
7. Already closed by ADR 1042, re-verified: the per-device inbound budget
   (`enforceChannelInboundRateLimit(res, 'relay:<id>')`, D6) and the relay inbound
   claim sweep (`sweepRelayInboundClaims` on the webhook-delivery worker tick, L7).

**Client (`openwop-cli`: `src/cli/relay.ts`, `relayShared.ts`, `src/channels/*`).**

1. No handling of token expiry or rotation.
2. Fixed-interval loops: the bridge sleeps a fixed 5 s whatever happened, there is no
   backoff and no watchdog, and nothing reconnects WhatsApp after the socket closes
   (the cached connection promise is never cleared on close).
3. Outbound acks only successes, retries nothing within a cycle, and keeps no record
   of what it already delivered, so an ack lost after a send makes the next cycle
   send the message again.
4. No debounced batching of inbound bursts, no typing indicator.
5. No launchd or systemd installer for the relay (the only plan builder in
   `daemon.ts` is for the demo backend).
6. `relay setup` is non-interactive and shows no risk notice.
7. WhatsApp sends only the first image (`media[0]`, always as `image`). Signal and
   iMessage send no media at all.
8. Tests are mock-only, with hand-written payloads.
9. The self lane cannot work from the CLI: setup never sends `accountId`, and the
   normalizers drop every from-me message, including the note-to-self chat.

## Decision

### D1. The relay protocol contract

All routes are under `/host/openwop-app/messaging` (the CLI reaches them at
`/v1/host/openwop-app/messaging`). Operator routes take the normal session or bearer;
device routes take `x-openwop-device-token` only.

| Route | Caller | Request | Answer |
|---|---|---|---|
| `POST relay/register` | signed-in user (or operator key) | `{channel, deviceName?, accountId?}` | `201 {relayId, channel, activationCode, activationExpiresAt}` |
| `POST relay/activate` | the same signed-in user | `{relayId, activationCode, accountId?}` | `200 {relayId, channel, deviceToken, tokenExpiresAt, rotateAfter, heartbeatIntervalSeconds, outboundPollIntervalSeconds, ownerBound}` |
| `POST relay/revoke` | the device's owner or a workspace admin | `{relayId}` | `200 {relayId, revoked:true}`; anyone else `403` `relay_revoke_forbidden` |
| `GET relay/devices` | tenant | none | `200 {devices:[{relayId, channel, deviceName?, status, registeredAt, lastHeartbeatAt?, online, presence, offlineSince?, owner, canRevoke}]}` (the CHAN-P0-8 shape plus presence and `canRevoke`; no token, code or expiry) |
| `GET\|PUT relay/:relayId/channel` | the device's owner | `{agentId?, provider?, model?, accountId?}` | `200 {settings, accountId?}` |
| `POST device/heartbeat` | device | `{status?}` | `200 {ok, serverTime, tokenExpiresAt, rotateAfter, heartbeatIntervalSeconds, outboundPollIntervalSeconds}` |
| `POST device/rotate` | device | none | `200 {deviceToken, tokenExpiresAt, rotateAfter, previousTokenValidUntil}` |
| `POST device/inbound` | device | the envelope (ADR 1042) | `202 {accepted, …}`, `202 {deduped:true}`, `429` + `Retry-After` |
| `GET device/outbound` | device | `?limit` | `200 {relayId, messages:[egress + attempts]}` |
| `POST device/ack` | device | `{egressIds?:[], failed?:[{egressId, error, permanent?}]}` | `200 {acked, failed, deadLettered}` |

**Token lifecycle.**

- Minted once at activation, returned once, stored only as a SHA-256 hash (unchanged).
- Valid 30 days from its last mint. `rotateAfter` is 7 days before expiry. The device
  rotates on its first heartbeat past `rotateAfter`, so a device that runs keeps a
  valid token, and one that has been off for 30 days must be set up again.
- `POST device/rotate` mints a new token and keeps the old one valid for a 10-minute
  grace (`previousTokenValidUntil`), so a client that crashes between the answer and
  its write still has a token that works. A rotation from the old token during the
  grace is refused, so a stolen old token cannot fork the device.
- Revoke deletes the hash, any grace row, the queue, the owner and the lane settings.

**Error codes.** Every device-auth refusal is `401 unauthenticated` with
`details.reason`:

| `details.reason` | Meaning | What the client does |
|---|---|---|
| `device_token_missing` | no header | a bug: stop |
| `device_token_invalid` | unknown token | stop, tell the user to run `relay setup` |
| `device_token_expired` | past `tokenExpiresAt` | stop, tell the user to run `relay setup` |
| `device_revoked` | the token's device was revoked (revoke keeps a tombstone of the hash until the token would have expired) | stop, tell the user |
| `device_token_superseded` | the token was rotated away: the client never saved the answer of its last rotation (security review) | stop with a NON-zero exit and tell the user to run `relay setup` |

Activation refusals: `400 invalid_request` (wrong or expired code, as before, with
`details.attemptsLeft`), `403 forbidden` with `details.reason: activation_locked`
(D3), `403 forbidden` with `details.reason: activation_user_mismatch`, and `404` for a
device in another tenant. `429` from `device/inbound` carries `Retry-After` (seconds).
Any `5xx` or network failure is transient: the client backs off (D5) and retries.

**Ack semantics.**

- `egressIds` were delivered. Each is deleted and logged `delivered`. Unknown ids are
  ignored, so an ack is idempotent.
- `failed[]` entries with `permanent: true` (the platform refused the recipient, the
  media was too large, the channel cannot send that kind) are deleted and logged
  `failed` with the client's error text, capped at 200 characters.
- `failed[]` entries without `permanent` stay queued and their attempt count goes up.
  At 5 attempts the egress is dead-lettered: deleted and logged `failed`,
  `max_attempts`. `GET device/outbound` returns the count as `attempts`.
- The client never acks a send it did not make. It keeps a set of delivered egress
  ids (D5), so an ack lost after a send is re-sent as an ack, never as a second
  message.

### D2. The security terms of ADR 1041 D2, and where each is held

| Term | Held by |
|---|---|
| Each user opts in; off for every tenant until a user sets it up | No device exists until a signed-in person registers and activates one. Conversation mode also needs the `channel-ingress` toggle (default off). |
| The user's own machine and own accounts, never an operator number | The CLI's setup notice says so and needs explicit consent (D6). The server cannot see whose number it is; the owner is the person who activated, and their turns run as them. |
| The risk is shown at setup | D6: a per-channel notice and a typed `yes`, or `--accept-risk` when not interactive. Consent is recorded in the local credentials file. |
| Business WhatsApp stays on the official API | Unchanged. The relay is never offered for a business number; the notice says to use the WhatsApp Business connection. |
| The token is bound to one tenant, one user and one device | The device row holds the tenant; activation binds the owner (D3); the token is per `relayId`, and `relayId` is one device's registration. A token from one device never authenticates another. |
| The server address never comes from a link or a query string | D7. |

### D3. Server fixes

- **Activation lockout.** Each wrong code for a relay counts against it in
  `messaging:relay-activation` (CAS). The fifth wrong code burns the code: the
  device stays `registered` with no code, and every later attempt answers
  `activation_locked`. The user registers again. With a 12-character code from a
  48-bit space, five guesses is a negligible chance; the count is per relay, so a
  guesser cannot spread it across relays they do not know the ids of.
- **The owner is bound at activation.** Registration records who registered
  (`registeredBy`, beside the code). Activation:
  1. requires the caller's tenant to be the device's tenant (`404` otherwise, the
     same answer as an unknown relay);
  2. when a person registered it, requires the same person (`activation_user_mismatch`);
  3. records the activating person as the owner (`messaging:relay-owner`), with the
     `accountId` from the activation body, else the one given at registration.
  With no signed-in person (an operator key) there is no owner, as before: workflow
  mode works and conversation mode drops (`no-owner`). `ownerBound` in the answer says
  which.
- **Offline marking.** Each heartbeat writes the device's presence
  (`messaging:relay-presence`). A sweep on the webhook-delivery worker tick (beside
  the claim sweep) marks a device `offline` when its last heartbeat is more than
  three intervals old (90 s), once, with a delivery-log row `offline`. The next
  heartbeat marks it `online` and logs `online`. `GET relay/devices` reports
  `presence` (`online`, `offline`, or `never` for a device that never heartbeated).
  Bounded at 500 rows a tick, fail-contained. Outbound to an offline device still
  queues; the device pulls it when it returns.
- **Token rotation** as in D1, with the grace rows in `messaging:relay-token-grace`
  keyed by the old token's hash.
- **Failure ack and dead-lettering** as in D1, attempt counts in
  `messaging:relay-egress-attempts`, removed with the egress.
- **Relay lane settings route.** `GET|PUT relay/:relayId/channel`, registered by the
  `channel-ingress` feature (`404` while it is off, as its sibling
  `connections/:id/channel` is). Access is the sibling's: the same feature check, the
  same workspace write for a change, and one owner predicate. A relay device is
  personal, so its owner is the only one who may manage it, the same rule
  `authorizeManage` applies to a personal connection. The body is validated by the
  same helper the connection route now uses, so the two cannot drift (the agent must
  resolve in this workspace; provider and model match the same patterns).
  `accountId` updates the self lane's account on the owner record.
- **Revoke purges the lane.** Through a registered hook (the route does not import
  the feature): the lane's settings, approvals and pending senders, plus the owner,
  presence, grace and attempt rows.

### D4. What stays on the server

Unchanged from ADR 1042: the per-device inbound budget, the inbound claim and its
sweep, group detection, the policy gate, `own_outgoing`. The relay is still pull
(the device polls); a push channel is not part of this phase.

> **CORRECTED 2026-11-04 (D9):** "the policy gate" now applies to the legacy
> workflow lane only. Conversation mode admits by the device's own approvals.

### D5. Client reliability

- **Backoff with full jitter** for every loop (bridge cycle, Signal daemon stream,
  `signal-cli receive` respawn, WhatsApp reconnect): delay = random(0, min(cap,
  base × 2^attempt)), base 1 s, cap 5 min, reset on a success. The bridge cycle runs
  at the server's `outboundPollIntervalSeconds` while healthy.
- **Watchdog.** If the inbound side has produced nothing (no message, no platform
  event, no successful poll) for 30 minutes, the receive side is torn down and
  started again. This is OpenClaw's 30-minute watchdog.
- **WhatsApp reconnect.** On `connection: 'close'` the shared socket is dropped and a
  new one is opened with backoff. A `loggedOut` close stops the relay and tells the
  user to link again; it never re-prints a QR code in a background service.
- **Token handling.** The bridge rotates past `rotateAfter` and writes the new token
  to the 0600 credentials file before using it. A `401` with any D1 reason stops the
  bridge with a message naming the reason, and exits 0, so neither launchd
  (`KeepAlive: SuccessfulExit = false`) nor systemd (`Restart=on-failure`) restarts
  it into a loop.
- **Outbound.** Each egress gets up to 3 attempts in the cycle with backoff. Then it
  is acked as failed (permanent when the plugin says so). Delivered egress ids are
  kept in `~/.openwop/relay-delivered.json` (24 hours, at most 2,000 ids, 0600): an id
  already delivered is acked without sending.
- **Debounced batching.** Plain messages from one sender in one chat that arrive
  within 1.5 s of each other (`--debounce-ms`) are sent as one inbound: the texts
  joined by a newline, the media concatenated, the id of the last message. At most 10
  messages or 10 s per batch. Reactions, edits, commands and from-me messages are
  never batched.
- **Typing indicators.** After an inbound is accepted, the plugin shows "typing" in
  that chat until a reply to it is delivered or 60 s pass: WhatsApp
  `sendPresenceUpdate('composing')`, Signal daemon `sendTyping`, Discord
  `sendTyping()`. iMessage has no interface for it and shows nothing.
- **Full media.** WhatsApp sends every attachment, as image, video, audio or document
  by MIME type, with the caption on the first. Signal (daemon or binary) and iMessage
  (AppleScript `POSIX file`) send attachments downloaded to a private temporary
  directory first: `https` only (or `http` to loopback), 25 MB each, deleted after
  the send. A download that fails is a transient failure; a type or size the channel
  cannot send is permanent.
- **Echo suppression.** The relay remembers what it sent (ids where the platform
  returns them, else a hash of the text per chat for 2 minutes), so its own reply in
  the note-to-self chat never comes back as a from-me message and loops.

### D6. Setup, installer and the self lane

- **Interactive setup.** `openwop relay setup` on a terminal prints the channel's risk
  notice and asks for a typed `yes` before registering:
  - all personal channels: this links YOUR OWN account on THIS machine; never use a
    number or account your employer or the operator owns; anyone who can approve
    senders can make the agent answer in your name;
  - WhatsApp: linking through WhatsApp Web (Baileys) is unofficial, WhatsApp can ban
    the number; business numbers belong on the WhatsApp Business connection;
  - iMessage: needs Full Disk Access for `chat.db`; Apple has broken unofficial
    iMessage clients before and may again;
  - Signal: signal-cli becomes a linked device with full access to the account.
  Without a terminal, `--accept-risk` is required for those three channels and the
  notice is printed anyway. Discord uses a bot token, not a personal account, and
  needs no consent. The consent (`riskAcceptedAt`, notice version) is stored in the
  credentials file.
- **Self lane.** Setup asks for the device's own account id (`--account`: the
  WhatsApp number or JID, the Signal number, the iMessage handle) and sends it as
  `accountId`. The normalizers pass a from-me message only when its chat is that
  account (note-to-self) and mark it `fromMe: true`; every other from-me message is
  still dropped on the device, so the user's ordinary outgoing messages never leave
  the machine.
- **Installer.** `openwop relay service install|uninstall|status [--dry-run]` writes a
  user service that runs `node <cli> relay start` against the pinned server:
  - macOS: `~/Library/LaunchAgents/dev.openwop.relay.plist`, `RunAtLoad`,
    `KeepAlive {SuccessfulExit: false}`, `ThrottleInterval 30`, loaded with
    `launchctl bootstrap gui/<uid>`;
  - Linux: `~/.config/systemd/user/openwop-relay.service`, `Restart=on-failure`,
    `RestartSec=10`, enabled with `systemctl --user enable --now`.
  No secret is written into either file: the token stays in the 0600 credentials
  file. Windows prints a manual recipe, as `demo` does.

### D7. The server address

The relay sends its token only to the server it was activated against.

- The address comes from `--base-url`, `OPENWOP_BASE_URL` or the CLI config, never
  from a link, a URL argument's query string or a deep link. The CLI has no link
  handler and this phase adds none.
- Setup refuses an address with a query string, a fragment or user info, and an
  `http` address that is not loopback.
- Activation stores the address in the credentials file. `relay start` and the
  service use only that stored address; a `--base-url` that differs is refused, not
  followed.

### D8. Tests

- Server: `adr1043-device-relay.test.ts` over HTTP (lockout, owner at activation and
  tenant check, rotation and grace, 401 reasons, failure ack and dead-lettering,
  presence sweep, the settings route's predicate, revoke purge).
- Client: contract tests against recorded fixtures (`test/fixtures/relay/`: Baileys
  `messages.upsert` and `connection.update` events, signal-cli JSON-RPC `receive`
  notifications, `chat.db` rows, and the server's answers including each `401`
  reason, a `429` and a failure ack) through a mock host that implements D1.
- A scripted manual live check per channel (`docs/relay-live-check.md` in
  openwop-cli). It is documented, not run by the agent: no real account is linked and
  no real message is sent in this phase.

### D9. Per-device peer approval, by the device's owner (CHAN-P1b)

**Decision (David, 2026-11-04, in the coordinator's session): "Per-device, owner
approves".** Each relay device's OWNER approves their own contacts for THEIR OWN
device only, the way channel-ingress already does for hosted connections (ADR 1042
D3/D9). Workspace admins keep the ability to revoke. The relay no longer sends a
pairing prompt to strangers.

- **One store, keyed by the device's lane.** Approvals and pending senders are
  channel-ingress's own `channel-ingress:sender` and `channel-ingress:pending`
  rows, keyed by `laneKeyOf({kind:'relay'})` = `relay:<relayId>`. No parallel
  store. A peer approved on device A is a row on `relay:A` and is never read for
  device B.
- **Admission (conversation mode).** A relay message that is not from-me is
  admitted only when its pairing id is approved on THAT device's lane, by that
  device's current owner (`ownerUserId` equals the owner record). The pairing id is
  the peer id for a direct chat and `group:<chatId>` for a group (the D3 rule of
  ADR 1042). An approved group is answered only when the message mentions the
  assistant (`hasBotMention`: the operator's configured bot id or name, fail
  closed), which is what the old default policy's `requireMention` required.
- **Strangers.** An unknown sender is recorded as pending (ADR 1042 D12: at most 30
  new records a minute per lane, never a 429, at most 100 rows per lane with the
  least recently seen evicted) and dropped (`not_paired` in the delivery log).
  Nothing is sent back, from any account.
- **The self lane is unchanged.** A from-me message in the note-to-self chat (the
  chat id is the owner's recorded `accountId`) is the owner's own, full-tools lane
  (ADR 1042 D9); every other from-me message is `own_outgoing`. It needs no
  approval: only the owner sets the account id. A relay approval is never `self`:
  there is no "this is me" route for a device, because the self lane is decided by
  the note-to-self rule, not by a mark.
- **Routes** (registered by `channel-ingress`, `404` while it is off, the device's
  tenant only, `404` for another tenant's or a revoked device; changes need a
  workspace write):
  - `GET relay/:relayId/senders`: the owner gets `{approved, pending, canApprove:true}`;
    a workspace admin who is not the owner gets `{approved, pending:[], canApprove:false}`
    (enough to revoke; a stranger's pending request is the owner's business);
    anyone else `403` `relay_peers_owner_only`.
  - `POST relay/:relayId/senders` `{senderId, label?, groupAcknowledged?}`: the
    owner only. The approval's paired owner is the device owner. A `group:` id
    needs `groupAcknowledged: true` (`400` `group_ack_required`), the server side of
    the D9 warning the settings page shows; the hosted lane checks it in the page
    only. (Since the coordinator follow-up, the hosted lane checks it server-side too.)
  - `DELETE relay/:relayId/senders/:senderId/pending`: deny, the owner only.
  - `DELETE relay/:relayId/senders/:senderId`: revoke, the owner or a workspace
    admin (`isRelayWorkspaceAdmin`, the one predicate of the H1 review).
- **The tenant-wide rules.** Connectors, `dmPolicy`/`groupPolicy`, the allowlist
  and pairing no longer admit relay traffic in conversation mode: that lane reads
  only the device's own approvals, and needs no connector. They stay, admin-only,
  for the **legacy workflow lane** (Channels into chat off, or a routing rule
  claims the message), whose behaviour is otherwise unchanged, except that a
  `pairing` policy no longer queues the "Pairing requested" message to the
  stranger: the code is minted, returned to the device in the `202` answer and
  listed for an admin by `GET pairing`, who approves it as before.
- **No approval widens.** Nothing is migrated. An allowlist row that admitted a
  peer into conversation mode before is not copied to any device (copying it to
  every device would be the defect this replaces), so that peer becomes a pending
  request on the device it writes to, and that device's owner decides. The
  legacy lane reads exactly the rows it read before. Production had 0 relay
  requests in the 30 days to 2026-11-04 (see "Fixed pre-existing gaps"), so no live
  contact is cut off.
- **Erasure and revoke.** The rows are the same `channel-ingress:sender` and
  `:pending` stores the ADR 1042 D8 eraser already walks per tenant (erasing the
  owner or the peer deletes them), and revoking a device purges its lane (D3).
- **Admission runs before the device's budget (coordinator, 2026-11-04).** As first
  built, the per-device inbound budget (ADR 1042 D6) was taken before the
  approval check, so a flood of strangers could push the owner's own device into
  `429`s. It now matches ADR 1042 D12: in conversation mode the route admits first
  (an ownerless device, the owner's outgoing chatter, a stranger and an
  un-addressed group are acknowledged with `202` and dropped), and only an
  admitted message takes the budget. Strangers go only through the pending
  recorder's own budget and cap. The ingest re-checks admission at dispatch, with
  the same function (`admitRelayMessage`).
- **Group acknowledgement on both lanes (coordinator, 2026-11-04).** The hosted
  `POST connections/:id/senders` now also refuses a `group:` id without
  `groupAcknowledged: true` (`400` `group_ack_required`). One server check
  (`requireGroupAcknowledged`) serves both lanes, and the settings page's client
  sends the flag only after the acknowledgement is ticked.
- **Admin listing (coordinator, 2026-11-04: accepted as built).** A workspace admin
  who is not the device's owner may list its approved senders, never its pending
  ones, so that Revoke is usable from the page.
- **Operator note: groups on a device.** A personal account has no bot handle, so
  an approved relay group is answered only when a message mentions the assistant
  by the name the operator configured: `OPENWOP_MESSAGING_BOT_NAME`, or the
  channel's `OPENWOP_MESSAGING_BOT_ID_<CHANNEL>` in `mentions`. With neither set,
  approved relay groups are never answered. The group-approval dialog says
  "groups are answered only when your assistant is mentioned by name". No new
  setting was added.
- **Settings page.** The relay devices section lets the device's owner open a
  device and manage its pending and approved senders with the hosted lane's own
  components (the senders section and the approve dialog with the group
  warning and acknowledgement); a workspace admin sees the approved list with
  Revoke.

### No wire change

Every route is a host extension under `/host/openwop-app/*` and non-normative
(`host-extensions.md`); the device token, its rotation and its error reasons never
appear on the OpenWOP wire. No RFC is needed. The CLI drives a host-extension surface,
which its golden rule 5 allows.

## Alternatives considered

- **Refresh tokens (a long-lived refresh plus short access tokens).** Rejected: the
  device would hold two secrets instead of one with the same blast radius, and
  rotation with a short grace gives the same property (a running device stays valid,
  a stolen old token dies within 10 minutes).
- **Lock activation per IP.** Rejected: behind NAT and Cloud Run the IP is a poor
  key, and the per-relay count already bounds guessing.
- **Mark offline in the heartbeat route only.** Rejected: a device that stops never
  calls it. The sweep is the only way to notice silence.
- **A `status: 'offline'` column on `relay_devices`.** Rejected for now: a schema
  migration on two storage engines for a value the sweep owns. The presence rows are
  host-ext durable rows like the owner and the claim.
- **Server-side batching of inbound.** Rejected: the server would have to hold a
  message before answering the device. The device sees the burst and can batch it.
- **Push delivery (SSE or WebSocket) instead of polling.** Deferred: polling with
  backoff is enough for one personal account, and push is a new process shape.

## Consequences

- A relay that runs keeps working across token expiry; one that stops is visible as
  offline within about 90 s plus one sweep tick.
- A message that cannot be delivered is dropped after 5 attempts with a log row,
  instead of being retried forever.
- The relay can send any attachment type, so the server's media URLs must be
  reachable from the user's machine.
- The device lane's ban risk is the user's, recorded at setup (ADR 1041
  Consequences).

## Implementation record

| Item | What | Commit | Test |
|---|---|---|---|
| ADR | This decision | 6b01b78b8 | |
| D1, D3 (server) | Activation tenant + registrant checks, owner bound at activation, lockout, named 401 reasons with a revoke tombstone, rotation with grace, failure acks and dead-letter, presence sweep and `relay/devices`, relay lane settings route, revoke purge | 3ba6a74f5 | `adr1043-device-relay.test.ts` (7 cases; 10 sabotage probes each red) |
| D5–D8 (client) | openwop-cli `feat/relay-production` | openwop-cli 430042f | `test/relay-production.test.mjs` (31 cases; 14 sabotage probes each red), `docs/relay-live-check.md` |
| D9 (CHAN-P1b) | Per-device peer approval by the owner: `admitRelayPeer` on the relay ingest (the device's lane, the current owner), strangers pending and never answered, the four `relay/:relayId/senders` routes, the legacy lane's pairing prompt removed, the tenant-wide policy out of conversation mode; the settings page opens a device's senders with the connection's components | #5573 (4df908ae4; branch `feat/adr-1043-p1b-device-peer-approval`) | `adr1043-device-peer-approval.test.ts` (7 cases; 8 sabotage probes each red), `messaging-relay-route.test.ts` (pairing sends nothing; 1 probe red), `ChannelSettingsPage.test.tsx` (3 new cases; 2 probes red) |
| D9 follow-up (coordinator, 2026-11-04) | Relay admission before the device's inbound budget (ADR 1042 D12); the hosted group approval needs `groupAcknowledged` server-side (one `requireGroupAcknowledged`), and the client sends it; the device group copy; the admin-listing note, the operator note and `RELAY-KILL-SWITCH-1` | #5573 (4df908ae4; branch `feat/adr-1043-p1b-device-peer-approval`) | `adr1043-device-peer-approval.test.ts` (+2 cases; 2 probes red), `ChannelSettingsPage.test.tsx` (+1 case; 1 probe red) |

Status of the record: implemented on branches, not merged, not deployed, not
published. The live check per channel has not been run.
(As written on 2026-11-04. Superseded by the notes below: D1/D3 and D9 are
merged and live; the live check per channel is still not run.)

> **UPDATED 2026-11-05.** Merged and live: D1/D3 server in #5567 (a93b7d443,
> 2026-11-04); D9 and its follow-up in #5573 (4df908ae4, live in 3c1ebe770 on
> 2026-11-05); the client in openwop-cli #87, published as `@openwop/cli` 2.0.0
> (2026-11-04). The live check per channel is still not run: it needs the user's
> own accounts (TODO `CHAN-U11`). `RELAY-LOG-RETENTION-1` is #5589.
>
> **UPDATED 2026-11-05 (later).** #5589 MERGED as aaf127ac1 (train 382) and is
> LIVE (deploy verified on both halves). Its hourly sweep runs with the 7-day
> default, as the user approved.

> **Correction during implementation (D1).** `device_revoked` was unreachable as
> first written: revoke deletes the token hash, so a revoked token looked unknown
> and answered `device_token_invalid`. Revoke now keeps a tombstone of the hash
> (in `messaging:relay-token-grace`) until the token would have expired, and the
> grace sweep removes it after that.
>
> **Found during implementation (client).** Four existing defects, fixed in
> openwop-cli: `relay start --daemon` spawned a non-existent `../openwop.mjs`;
> iMessage receive started from ROWID 0 and would have forwarded the whole
> `chat.db` history on first start; Signal group sends through the binary passed
> the group id as a recipient instead of `-g`; `relay setup --json` printed the
> device token.
>
> **Fixtures (D8).** The host answers are recorded from this host. The platform
> payloads (Baileys, signal-cli, chat.db) are written in each library's shape,
> not captured from a live account, because this phase links none. The live check
> says how to re-capture them.

## Who may revoke, and `canRevoke` (coordinator follow-up, 2026-11-04)

Rebased onto CHAN-P0-8 (#5558), which added its own `GET relay/devices` and a relay
section on the channels settings page. There is ONE route: #5558's shape (relayId,
channel, deviceName, status, registeredAt, lastHeartbeatAt, online, owner with
`ownedByCaller` and the account id for its owner only) plus `presence`,
`offlineSince` and `canRevoke`. #5558 kept the token expiry out of the listing, and
it stays out.

- **One presence source.** `online` is `relayPresenceOf(device, presenceRow) ===
  'online'`: the sweep's offline mark, else a heartbeat no older than
  `OFFLINE_AFTER_MS` (90 s), falling back to the device row's own heartbeat for a
  device that has no presence row yet. #5558's `RELAY_ONLINE_MS` is gone; the
  connector test probe uses `OFFLINE_AFTER_MS` too.
- **Revoke.** Before, any caller in the device's tenant could revoke it. Now only
  the device's **owner** or a **workspace admin** may, where admin is the
  connections routes' own workspace-level check (`authorizeManage` on a row with no
  owner and no org, i.e. `host:connections:manage` on the caller's workspace, which
  built-in admin and owner hold). Anyone else gets `403 forbidden` with
  `details.reason: relay_revoke_forbidden`. The connections routes are imported
  lazily: a static import from `routes/messaging.ts` forms a module-init cycle.
- **`canRevoke`** in the listing is the same predicate (`canRevokeRelay`), false for
  a revoked device. The settings page shows Revoke only when it is true.
- Tests: `adr1043-device-relay.test.ts` (owner OK, admin OK, another member 403,
  `canRevoke` for each) and `ChannelSettingsPage.test.tsx` (no Revoke button where
  `canRevoke` is false). Sabotage, one probe at a time, each red: dropping the
  owner branch, the admin check always true, always false, `canRevoke` always
  true (backend); ignoring `canRevoke` on the page (frontend).

## Security review of #5567 / cli #87 (2026-11-04): H1, M2, M3, L4

**H1 (confirmed): any workspace member could send through another member's device.**
`POST relay/enqueue` checked only the tenant, so B could queue a send through A's
personal WhatsApp to any chat, with any text and media URL, which A's machine then
fetched (localhost and intranet included) and sent from A's number. Fixed on both
sides: sending AS a device is its owner's act only, every relay route has an explicit
rule (table below), the workflow chat-egress path holds the same owner rule, and the
CLI refuses any media URL that is not public https (L4 section of the CLI).

**Who may call what (every relay route):**

| Route | Rule |
|---|---|
| `POST relay/register` | any signed-in member, for themselves (the registrant is recorded) |
| `POST relay/activate` | the registrant; an operator-registered device: a workspace admin. Anyone else: the same `404` as an unknown relay, counting nothing (M2) |
| `POST relay/revoke` | the device's owner or a workspace admin |
| `GET relay/devices` | any member (ids, owner and presence; the account id only to its owner; `canRevoke` per caller) |
| `GET\|PUT relay/:relayId/channel` | the device's owner only |
| `POST relay/enqueue` | the device's **owner only** (sends AS the device); an ownerless operator device: the wildcard operator only; `403 relay_owner_required` |
| `GET connectors`, `GET connectors/:id`, `POST connectors/:id/test`, `GET connectors/:id/policy`, `GET routing` | reads: any member |
| `POST connectors`, `POST connectors/:id/enable\|disable`, `PUT connectors/:id/policy` | workspace admin (`403 relay_admin_required`) |
| `POST routing`, `DELETE routing/:ruleId` | workspace admin |
| `GET\|POST pairing…`, `GET\|POST\|DELETE allowlist` | workspace admin (codes and other members' contacts) |
| `GET relay/:relayId/senders` | the device's owner (approved and pending); a workspace admin who is not the owner sees the approved list only, so they can revoke (D9) |
| `POST relay/:relayId/senders` | the device's **owner only**; a group needs `groupAcknowledged: true` (D9) |
| `DELETE relay/:relayId/senders/:senderId/pending` | the device's owner only (D9) |
| `DELETE relay/:relayId/senders/:senderId` | the device's owner or a workspace admin (D9) |
| `GET\|DELETE sessions…`, `GET\|POST\|DELETE identities…` | workspace admin (other members' contacts) |
| `GET logs` | any member, filtered to the relays they own; a workspace admin sees all |
| `device/*` | the device token only (D1) |
| `POST notify` | unchanged: not keyed by a relay or connector (email/SMS one-off), out of this review's scope |
| internal: channel-ingress reply transport, the workflow bridge | function calls (`enqueueOutbound`), never the HTTP route; each replies only to the chat the message came from |
| internal: workflow chat egress (`ctx.messaging.dispatchEgressEnvelope`) | a device with an owner: only a run whose acting user is that owner (`connector_not_found` otherwise, system runs included); an ownerless device: as before |

"Workspace admin" is ONE predicate everywhere (`isRelayWorkspaceAdmin`): the
connections routes' workspace-level manage check (`authorizeManage` ⇒
`host:connections:manage`; built-in admin and owner, a person's own personal
workspace, the wildcard operator). Consequence: in a shared workspace a non-admin's
relay needs an admin to set up the connector, policy and allowlist; in a personal
workspace its owner is the admin. Per-device connectors are an open question.

> **CORRECTED 2026-11-04 (D9, CHAN-P1b) — the pairing and allowlist rows above no
> longer decide who reaches a relay device in conversation mode.** As written, the
> peer rules (connector, `dmPolicy`, allowlist, pairing) were per (tenant, channel)
> and admin-only, so a non-admin could not approve their own contacts, a peer
> approved for member A was also admitted to member B's relay, the easy way out was
> `dmPolicy: 'open'` for every device, and the pairing prompt was sent from the
> owner's personal account to any stranger. D9 replaces them for conversation mode
> with per-device approvals the device's owner manages; the four `relay/:relayId/senders`
> rows were added to the table. The tenant-wide rows still hold, admin-only, for
> the legacy workflow lane only (D9).

**M2: the lockout let any member burn a victim's code.** It counted wrong codes per
device BEFORE the registrant check. Now the tenant and registrant checks run first (a
non-registrant gets `404` and counts nothing) and wrong codes are counted per
(device, caller). Test: six wrong codes from another member leave nothing counted, and
the owner then activates.

**M3: lifecycle writes clobbered concurrent ones.** Heartbeat and rotate upserted the
whole row loaded at auth (both backends' `upsertRelayDevice` is an
`INSERT … ON CONFLICT DO UPDATE` of every column), so a revoke landing in between was
undone and a heartbeat could restore a rotated-away hash. Four column-only,
conditional storage methods, in sqlite and postgres: `activateRelayDevice` (only while
`registered` with that code), `touchRelayDeviceHeartbeat` and `rotateRelayDeviceToken`
(only while `active` with the hash that authenticated), `revokeRelayDevice`. Tests
force each race by revoking or rotating inside the auth read.

**Lost rotation answer.** A client that never saved a rotation's answer holds the
previous token; its next rotate is refused. There is no safe re-authentication from an
old token (a stolen one could fork the device), so the refusal is now its own reason,
`device_token_superseded`, and the CLI exits NON-zero telling the user to run
`relay setup` (the old token still works for the rest of its 10-minute grace).

**Low, recorded: the self lane's `accountId` is unverified.** The owner states it; the
server cannot check that it is really that device's account. Only the owner can set it
(at registration, activation or the owner-only settings route), and it only decides
which of the OWNER's own chats runs with the owner's full tools, so a wrong value
narrows or widens the owner's own lane, never another person's.

## Fixed pre-existing gaps (review prep, 2026-11-04)

### The activation route trusted the relay id alone (FIXED by D3)

- **What it was.** On `main` before P1, `POST relay/activate` looked the device up
  by `relayId` alone. It never checked that the caller's tenant was the device's
  tenant, nor that the caller was the person who registered it.
- **Exposure.** The relay routes are mounted unconditionally, whatever the
  `channel-ingress` setting, so the route was live on every deployment.
- **Why it was hard to exploit.** An attacker also needed the activation code:
  about 48 bits, returned only to the registering tenant, valid for 10 minutes,
  and single-use. Brute force is infeasible under the 60 writes per minute per-IP
  budget.
- **Evidence of use.** The Cloud Run request log showed 0 relay requests on
  app.openwop.dev in the 30 days to 2026-11-04.
- **Decision (with the coordinator).** No separate priority fix: it ships with P1,
  whose D3 adds the tenant check (`404`), the registrant check
  (`activation_user_mismatch`) and the lockout.

### Device tokens printed by the published CLI (FIXED in openwop-cli 430042f)

- Every published `@openwop/cli` from **v0.2.1 (2026-06-06) through v1.9.0** printed
  the device token on `openwop relay setup --json` and `openwop relay activate
  --json`. A token captured in a script's output or a CI log is a bearer credential
  for that device until it expires or is revoked.
- Device tokens have had a 30-day expiry since 2026-05-27 (`28545ef20`), so a token
  printed more than 30 days ago is already dead unless it was used since. Rotation
  (D1) did not exist before P1, so no token outlived its 30 days.
- P1's CLI prints `deviceToken: "[stored]"` instead. Its CHANGELOG tells
  self-hosters to revoke and re-activate any relay that was set up or activated
  with `--json` in scripts or CI.

### A token row with no expiry never expired (FIXED, review prep)

`requireDevice` skipped the expiry check when `tokenExpiresAt` was absent, so such a
row authenticated forever. It now fails closed: no expiry, or one that does not
parse, is `device_token_expired`. Activate and rotate are the only writers of a token
hash and both always write an expiry, so only a legacy or corrupt row is affected.
Test: `adr1043-device-relay.test.ts` ("names each refusal"); restoring the old guard
turned it red.

## Security review of #5573 (2026-11-04): C1

Cleared by the independent review, with one fix folded in. **C1:** a conversation-mode
admission drop (a stranger, the owner's outgoing chatter, an un-addressed group, an
ownerless device) wrote a `messaging_delivery_log` row with the outsider's chat id,
before any budget. A stranger or a busy group could grow that table without bound.
An admission drop now writes **no** row. It logs `relay_inbound_dropped` with the
device, channel and reason only, never a chat or sender id. A stranger is already
recorded, bounded, by the pending recorder (D9). Test: `adr1043-device-peer-approval`
"no pairing message is queued…" now asserts no inbound log row. Re-adding the write
turned it red (1 failed, 8 passed).

## RELAY-LOG-RETENTION-1 (fixed)

`messaging_delivery_log` (SQL, both backends) had no delete path but tenant
teardown, and every row carries `conversation_id`: the chat id (an E.164 number or
a platform handle) of the person a relay or connector talked to. Decisions, all in
`messaging/deliveryLogRetention.ts` unless named:

- **Window: 7 days**, `OPENWOP_RELAY_DELIVERY_LOG_RETENTION_DAYS` (unset, `0` or
  invalid reads as 7; the same parse as `OPENWOP_RELAY_INBOUND_CLAIM_TTL_DAYS`).
  Seven days matches the relay inbound claims and the trigger dead letters
  (ADR 0805): a log of contact ids is a short-lived operational record. It runs on
  the retention daemon's default-on half (`registerDefaultWindowSweep`, ADR 0951
  D3), hourly, so it holds on a host that never enabled the governance sweep. It
  skips tenants under legal hold (`listHeldTenantsFrom`, excluded in the `DELETE`)
  and is censused as an `asserts` lane. A new `at` index (sqlite mig 52,
  postgres mig 50) serves the cross-tenant delete.
- **Eraser: `eraseRelayDeliveryLogSubject`** (named, in `EXPECTED_SUBJECT_ERASERS`,
  registered from `hostSubjectErasers.ts`). It deletes the tenant's rows whose
  `conversation_id` EQUALS the subject key: no `subjectKeyForms`, no prefix match,
  the ADR 1042 D8 rule for an external person. The device OWNER's leg lives in
  `eraseRelayOwnerSubject`: it deletes the device's rows before the owner row,
  which is the only record of whose device it was, so the result does not depend
  on eraser order.
- **Teardown:** already reached through `deleteAllTenantData`'s `tenant_id`
  introspection (ADR 0284); now pinned by a test.
- **Revoke:** the revoke route deletes the device's rows with the rest of its
  lifecycle state.
- **Ratchet:** no test classified SQL tables for erasure (the ADR 0464 coverage
  test sees only host `DurableCollection`s; the teardown guard only proves
  teardown reach). `sql-table-erasure-classification.test.ts` lists every
  `CREATE TABLE` in both schema files and requires each to be ERASED (eraser in the
  manifest, storage methods that `DELETE FROM` it in both adapters), TORN_DOWN,
  EXEMPT with a reason, or on a shrink-only list of 40 pre-existing tables not yet
  audited.
- **Inbound dedup claims (same gap, folded in).** `messaging:inbound-claim` keys
  every claim by `relayId`, conversation id and platform message id, and had a
  7-day expiry but no eraser and no revoke delete. `eraseRelayOwnerSubject` is now
  its one eraser: it deletes the claims of the owner's devices and the claims
  whose conversation id EQUALS the key, in the tenant (`deleteRelayInboundClaims`).
  Revoke deletes the device's claims. Neither ADR 0464 ratchet walks
  `src/messaging`, so `messaging-store-erasure-classification.test.ts` classifies
  every durable store there: owner, activation and claims ERASED; token grace and
  presence EXEMPT; egress attempts (device-reported `lastError` text) left
  unclassified on a shrink-only list of one.

## Open questions

- Outbound queued for a device that never returns stays until revoke. A retention
  sweep for undelivered egress older than the token's lifetime is not in this phase.

  > **CORRECTED 2026-11-10 (CHAN-F12) — closed.** `messaging/outboundRetention.ts`
  > registers a `relay-outbound` default-window sweep on the retention daemon's
  > default-on half. It deletes egress enqueued more than the device token's
  > lifetime (30 days, one constant shared with the routes that mint tokens) ago.
  > That window is exact: a device gets a fresh token only while online, so one last
  > online at `t0` holds a token that expires by `t0 + TTL`, and any egress
  > enqueued after `t0` has no reader once it is older than the TTL (`relay setup`
  > registers a new relay id with a new queue). The sweep skips tenants under legal
  > hold (through the row's device), clears each egress's attempt counter, and logs
  > it `failed` with detail `expired`, as a dead-lettered egress is logged. A row
  > whose device is already gone is deleted with no log row. Storage method:
  > `pruneRelayOutbound` in both adapters (postgres: one `DELETE … RETURNING`
  > statement). Tests: `adr1043-relay-outbound-retention.test.ts` (both backends)
  > and `adr1043-relay-delivery-log-lifecycle.test.ts` case (g) (boot
  > registration).
  >
  > **Still open (new, `RELAY-OUTBOUND-ERASURE-1`):** `relay_outbound` rows carry
  > the recipient's chat id and the reply text but have no `tenant_id` column, so
  > the SQL-table erasure ratchet keeps the table on its pre-existing unclassified
  > list. Classifying it ERASED needs a migration adding `tenant_id` (backfilled
  > from `relay_devices`) and an exact-id contact eraser. Until then a queued reply
  > to an erased contact lives until it is delivered, revoked, or aged out (at most
  > 30 days).
- Presence and the per-device budget are per instance where they are in-process;
  presence is durable, the budget is not (ADR 1042 D6).
- The desktop app (P7) will host the relay and replace the launchd and systemd
  services for users who install it.
- **`RELAY-LOG-RETENTION-1` (pre-existing, owner f2): `messaging_delivery_log` has no
  delete path at all.** The sqlite and postgres stores only insert and select. No
  retention sweep, no subject eraser and no tenant-teardown leg touches it, and its
  rows carry chat ids (`conversation_id`) of the people a relay talked to. C1 stops
  admission drops from adding to it; delivered and failed rows still accumulate.
  It needs a retention window, an erasure leg matching `conversation_id`, and
  teardown. Its own change.
- **`RELAY-KILL-SWITCH-1`: an admin kill switch per channel.** Since D9,
  conversation mode no longer needs an enabled messaging connector, so an admin
  cannot switch the relay off for one channel (say, WhatsApp only) in a
  workspace. The controls today are the `channel-ingress` toggle (every lane, every
  channel) and revoking a device. Not built; recorded by the coordinator,
  2026-11-04.
