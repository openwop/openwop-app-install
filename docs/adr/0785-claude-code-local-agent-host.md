# ADR 0785 — Claude Code in the app: a paired local agent host, a terminal tab, and a runner the heartbeat can dispatch to

Status: Accepted — P1–P5 implemented (double-gated OFF); the P1 residue and Q2 gate the operator switch. Accepted by the steward 2026-09-29, including D2 (the user's own Claude login, at the user's own risk, which supersedes ADR 0756 in part for this path only).

Feature id: `claude-code` · Toggle: `claude-code` (default **OFF**) · Bucket: `user`
Operator gate: `OPENWOP_CLAUDE_CODE_AT_OWN_RISK` (default unset ⇒ nothing advertised, nothing dispatched)
Packs: `feature.claude-code.nodes` · `feature.claude-code.mcp-tools` (chain pack of MCP-exposed workflows) · agents: **none** (see matrix row 6)
Client: `clients/agent-host/` (new, Node — sibling of `clients/subscription-provider`, `clients/copilot-provider`)

**Amends:** [ADR 0539](0539-job-search-vertical-strategy.md) D4 (the "PTY terminal host + agent dock — deliberately NOT ported" bullet) — see D1.
**Supersedes in part:** [ADR 0756](0756-rfc0121-narrow-at-own-risk-anthropic-google.md) — for the `claude-code` path ONLY, and ONLY its reasoning that no Anthropic consumer-login use may be app-driven. Every rail ADR 0756 installed stays in force (D2).
**Rides:** Accepted RFC 0122 (`../openwop/RFCS/0122-self-hosted-runner-remote-execution.md`) (self-hosted runner, tool-dispatch) · the existing MCP server mount (ADR 0087 / ADR 0553).
**Composes:** ADR 0140 (multi-tab chat deck) · ADR 0073 (embedded conversation — as the drawer precedent) · ADR 0270 (developer keys) · ADR 0025 §4 (one approval store) · ADR 0311/0313 (commitment todos, the work loop) · ADR 0534/0535 (ranked selection, stranded-card recovery) · ADR 0543 (no second loop) · ADR 0182 (the loopback client precedent).
**Prior art:** a studied external job-application agent (the same prior art as ADR 0539). Its engineering reference is kept outside this repo. It is a production system that runs the real `claude` CLI in a local .NET PTY host, shows it as a sidebar terminal, and drives an autonomous pilot with stateless one-shot cycles against server-held state. Referenced as **the prior art**; nothing is vendored.

## Context

Customers already pay for Claude Code, and it already runs on their machines, next to
their repositories. Today openwop-app can't reach it. The prior art shows what reaching it
looks like: a small companion process owns a PTY running `claude`, the web app shows that
PTY as a terminal in a sidebar, and a server tells the agent what to do next, one
context-free cycle at a time.

This ADR makes Claude Code a **first-class participant in this host** without building a
second chat, a second execution model, or a second work loop:

- **P2, interactive.** A **Claude Code tab** in the chat deck, and a **"Pair with Claude
  Code" drawer** on the builder, app-builder and run pages. Both show a live terminal onto
  the user's own `claude`, running on their own machine.
- **P3, connected.** That Claude Code is **already connected to this host's MCP server**.
  From the terminal it can list and start workflows, read run events, read and add kanban
  todos, and look up schemas.
- **P4, governed.** Claude Code's **permission prompts become approval cards** in the
  existing queue. They can be answered from the inbox, a phone, or a delegate.
- **P5, autonomous.** A chain step or a kanban card can be **dispatched to the user's
  Claude Code** as an RFC 0122 runner step. The heartbeat stays the only loop, and the run
  stays the only executor.

### Two earlier decisions this ADR must answer, not quietly reverse

1. **ADR 0539 D4** rejected porting the prior art's PTY host and agent dock: *"Porting a
   local companion would be a second execution model."* **ADR 0535 D1** made the same point
   from the other side: the prior art needs a claim TTL *"because its worker is a separate
   process on a user's laptop that can vanish without a trace"*, and this host has no such
   worker. This ADR adds exactly that worker, so both need a reply. D1 gives it.
2. **ADR 0756** (2026-09-26) removed the Claude Code harness (`claude -p` behind the
   ADR 0182 shim), citing Anthropic's terms: *"Anthropic does not permit third-party
   developers to offer Claude.ai login into their own applications, or to route requests
   through Free, Pro, or Max plan credentials on behalf of their users."* The steward
   decided on 2026-09-29 that this feature runs on the user's own login **at the user's
   own risk**, including the app-driven lane. D2 records that decision, its scope, and what
   in ADR 0756 does not move.

### Boundaries audit (evidence at `origin/main` `dacaf9774`)

| Concern | Finding | Consequence |
|---|---|---|
| Name / route collision | `claude-code`, `claudeCode`, `agent-host`, `pty`, `xterm` appear nowhere in `backend/typescript/src`, `frontend/react/src`, `packs/` or the ADR titles. `/v1/host/openwop-app/agents` already means user-authored agents (`routes/userAgents.ts`). | Route prefix `/v1/host/openwop-app/claude-code/*`. Never `/agents/*`. |
| Remote execution on a user's machine | RFC 0122 is **Accepted**. `host/selfHostedRunner.ts:1-60` holds the per-subject registry, the subject-first match (no cross-subject fallback) and at-most-once `{runId, stepId}` results in a `DurableCollection`. It says it *"NEVER spawns a vendor CLI"*. Routes are conformance seams only (`routes/runnerSeam.ts:107-110`). The registry is in-process; **there is no live production channel**. | The companion **is** an RFC 0122 runner. P5 builds the live channel that RFC 0122 §1 already specifies (SSE down, POST up). No new wire. |
| MCP server | `POST /v1/host/openwop-app/mcp` (`routes/mcp.ts:50`). It is **off unless `OPENWOP_MCP_SERVER_ENABLED=true`** (`routes/mcp.ts:42`); nothing in `deploy/` sets it. It authenticates any principal, including `owk_` keys (`middleware/auth.ts:942`), and refuses anonymous callers (`:92-98`). Tools are workflows carrying `core.openwop.mcp.expose-tool` (`host/mcpServerRegistry.ts:95`), filtered per principal and per toggle (`:307`). **No kanban, todo or run tools are exposed.** | P3 ships MCP tools as a **chain pack** of expose-tool workflows, never an in-tree registration. It depends on the operator enabling the mount; the P3 gate verifies prod state live. |
| Tokens and pairing | Developer keys: `features/developer-keys/apiKeyService.ts` mint (`:69`), scopes (`:88`), `expiresAt` (`:79`), revoke (`:104`). Scope checks are in `host/protocolAuthorization.ts:212,275`. **No device-code or pairing flow exists** (searched `device_code`, `deviceCode`, `pairing`, `cliLogin`). | Pairing is new host-extension routes that **mint an ordinary developer key**. There is no new token store. |
| Approvals outside a run | Interrupts always carry `runId` and `nodeId` (`executor/suspendManager.ts:50`). `PendingApproval` (`host/approvalService.ts:68`) already carries a non-run `actionId` branch (`:90`), under ADR 0025 §4 "no new approval store". | Permission prompts join **the same queue** as a new discriminated kind (D7). |
| Work loop | Heartbeat `host/heartbeatService.ts:104`. Ranked selection is ADR 0534 (`features/work-selection/`). Card recovery observes the run (ADR 0535 D1). Leases are server-side and short (`host/kanbanService.ts:944-1022`, `:1460-1479`). **No external pull or claim API exists, and none is wanted.** | No card lease and no agenda snapshot. The runner is a dispatch *target*, not a puller (D8). |
| Terminal transport | The raw-upgrade WebSocket precedent is `host/collab/collabServer.ts:1-40`: origin allowlist (CSWSH), `?ticket=`, toggle gate, per-tenant cap, cross-instance fan-out over the `publishHostExtEvent` Postgres LISTEN. Voice audio is instance-local plus best-effort `--session-affinity` (`DEPLOY.md:465-474`). | The terminal relay copies the collab upgrade boundary item for item (D4). |
| Browser → localhost | `firebase.json:273` `connect-src` is `'self' https://*.run.app …`, with no `localhost` or `ws://127.0.0.1`. No SPA code calls a local service. | The steward chose **outbound-only** (D4). The CSP does not change. |
| Chat deck | `DeckTab` is `{sessionId, pinned, lastActiveSeq, lastTitle?}` (`chat/tabDeck/tabDeckModel.ts:20-32`), with **no kind field**. Persistence re-validates only those fields (`tabDeckPersistence.ts:24,49`). Rendering always mounts `<TabSession>` (`TabChatDeck.tsx:700-716`). New-tab is a single button (`TabStrip.tsx:326-335`). **There is no chat slot or tab-kind registry.** | D5 adds `DeckTab.kind` plus a render branch. It's a deliberate core edit, justified in matrix row 1. |
| Drawer | There is no shared drawer in `ui/`. `BuilderShell.tsx:1030-1037` (`builder-ai-drawer-inner`, `inert`, `drawerEscapeHandler`) is the model. | The drawer copies the builder's AI drawer and renders through `ui/ModalPortal`. |
| Terminal dependency | No `xterm` in `frontend/react/package.json`. `CliPage.tsx` is static docs. | New lazily loaded chunk, `@xterm/xterm` plus `@xterm/addon-fit`. |
| Native shell | `native/nativeBridge.ts:24` detects `electron`/`ios` (`clients/desktop`, ADR 0181). | Open question Q5: the desktop shell could embed the companion later. |

## Decision

### D0 — One package, one toggle, one companion

- **Backend:** `backend/typescript/src/features/claude-code/`, which holds:
  - pairing service + routes
  - terminal-session registry + WebSocket upgrade
  - the permission-request bridge
  - the runner channel (P5)
  - `feature.ts` appended to `BACKEND_FEATURES` (`features/index.ts:212`)
- **Frontend:** `frontend/react/src/features/claude-code/` and a `FrontendFeature` in
  `features/registry.ts:122`. It covers settings (paired devices) and the lazily loaded
  terminal and drawer components.
- **Companion:** `clients/agent-host/`, a Node CLI (`npx @openwop/agent-host`) that uses
  `node-pty` (forkpty and ConPTY).
  - It is a separate client like `clients/subscription-provider`. It is not a backend
    module, and the backend never imports it.
- **The toggle is bucketed by `user`.** The companion, the pairing and the runner are
  personal, and RFC 0122 matches by subject. A workspace admin can still switch it off
  tenant-wide through the ordinary toggle override.

### D1 — Not a second execution model: Claude Code is a runner and an MCP client (amends ADR 0539 D4)

ADR 0539 D4 rejected the prior art's host **as the job-search executor**. That verdict was
right, and it stands for job search: the career agent runs on the heartbeat, on this host
(ADR 0543). What this ADR adopts is different in kind:

| Role | What owns it | Why this is not a second model |
|---|---|---|
| Deciding what runs next | the heartbeat + ADR 0534 selection | unchanged; there is no agenda engine and no pilot |
| Executing a run, replay, fork | this host's executor | the companion receives **one step** (RFC 0122 per-step dispatch, *"whole-run routing is rejected"*), never a run |
| Liveness of dispatched work | the run: dispatch lease + a **step deadline** | the card still *observes* the run (ADR 0535 D1 holds) |
| Talking to the platform | the existing MCP server | Claude Code is one more MCP client, like any other |
| The terminal | the user's own `claude` process | a view onto a third-party tool, not a chat implementation (D5) |

**Reply to ADR 0535 D1.** The laptop worker now exists, but it never owns a card. A
dispatched step has a deadline. A runner that vanishes fails the **step**, with a typed
`runner_unavailable` or `step_deadline_exceeded`. That goes through
`emitTerminalFailure`, and ADR 0535's existing handler restores the card. Adding a card
TTL is still rejected, for the reason D1 gave: two liveness systems for one lifecycle.

**ADR 0539 D4 correction note (to add at that section when this lands):** "*Amended by
ADR 0785: the PTY host is adopted as a user-owned RFC 0122 runner and MCP client, not as
an executor. This bullet's execution-model objection is preserved.*"

### D2 — Credential posture: the user's own login, at the user's own risk (supersedes ADR 0756 in part)

**The decision (steward, 2026-09-29).** Claude Code in this feature runs on whatever
credential the user's own `claude` CLI is logged in with, **including a Free, Pro or Max
consumer login**. That holds for interactive sessions and for app-dispatched steps (P5).
The user bears the risk.

**What this ADR does not pretend.** The terms quoted in ADR 0756 plausibly cover the P5
lane: an application dispatching work to a user's plan-authenticated Claude Code on the
user's behalf. The interactive lane is weaker ground for that reading: the user is typing
into their own CLI, and this host is only an MCP server the CLI connects to. Anthropic's
enforcement lands on the **user's account**. That is the risk being accepted, and it is
the user's, which is why every lever below is consent-shaped.

**What stays exactly as ADR 0756 left it:**

- `subscription:anthropic` is still refused at advertisement, at bind and at dispatch
  (`byok/subscriptionCredentialScope.ts:70`, `aiProviders/aiProvidersHost.ts:1161`,
  `host/exchange/dispatchTurn.ts`).
- **This host never sees, stores, proxies or dispatches a Claude credential.** The
  credential stays inside the user's `claude` process. RFC 0122's
  `runner-credential-non-transit` rail keeps frames closed-schema and credential-free. The
  host does **not** turn a consumer login into an API-shaped model endpoint. The ADR 0182
  `/v1/messages → claude -p` route stays deleted.
- The subscription-provider shim is untouched. `claude-code` is a separate client.

**The consent levers (all required, none optional):**

1. **Operator gate.** `OPENWOP_CLAUDE_CODE_AT_OWN_RISK=true`. When it's unset, the feature
   advertises nothing, the pairing routes return 404 and the node fails
   `capability_not_provided`. White-label bundles ship it unset.
2. **Per-user consent at pairing.** The user must acknowledge a consent screen before a
   key is minted. The screen quotes the Anthropic sentence verbatim, with its URL and the
   date it was fetched. The acknowledgement is stored with the text's content hash, the
   same shape as the ADR 0180 consent record. A new text version requires a new
   acknowledgement.
3. **Separate consent for app-driven dispatch.** P5 must be enabled per device, and the
   companion must report `credentialMode: 'api-key' | 'login'` in its registration
   capabilities. The host **cannot verify** this and says so in the UI. It is a
   user-reported disclosure, stamped on `run.metadata.claudeCode.credentialMode` so the
   record shows what the user claimed at dispatch time.
4. **API key is always the supported path.** The consent screen and the docs lead with
   "use an Anthropic API key (or Bedrock/Vertex) on the companion". Login is the
   at-your-own-risk alternative, not the default.

### D3 — Pairing mints a developer key; nothing else holds authority

- The companion starts pairing with `POST /v1/host/openwop-app/claude-code/pair/start`,
  which is unauthenticated and rate-limited. It returns `{ deviceCode, userCode,
  verificationUrl, interval, expiresIn }`, a device-authorization shape (RFC 8628 in form;
  not an OpenWOP wire claim).
- The user opens `/claude-code/pair` while signed in, **types the code** their terminal
  shows, reviews the device label, where and when the request started, which workspace
  it will join, and the D2 consent, and approves. The link never carries the code and
  the page ignores one in the URL (RFC 8628 §5.4: a pre-filled link is a phishing lure;
  see the P1 code review record). (Correction, P1: the draft said
  `/settings/claude-code/pair`. `/settings` is the settings shell's route, so the feature
  owns `/claude-code` and `/claude-code/pair` instead.)
- The companion polls `…/pair/poll`. On approval the host **mints an ordinary ADR 0270
  developer key** through `apiKeyService`:
  - scopes `workspace:read`, `workspace:write`;
  - `expiresAt` of 90 days by default;
  - name `claude-code:<deviceLabel>`.
- **The key never carries `approvals:respond`.** An agent must not be able to answer its
  own permission prompt (D7).

  > **Correction (architect review, 2026-09-29):** an absent scope does **not**, on its own,
  > keep a key off the `PendingApproval` queue. `routes/approvals.ts:222-249` (claim and
  > reject) checks no scope, and `decidedBy` falls back to `principal.principalId`. Only
  > the run-interrupt route checks `approvals:respond` (`routes/interrupts.ts:202`). The
  > real guard is in D7: the decision branch refuses any `auth.kind === 'api-key'`
  > principal.
- **The runner and device subject is the key's delegator, not the key.** An `owk_` principal
  is `apikey:<keyId>`, carrying `auth.issuer` = the canonical subject who minted it
  (`middleware/auth.ts:951-956`). Runs are owned by `user:<id>`. RFC 0122 subject-first
  matching therefore keys on `auth.issuer`, resolved once at registration and never taken
  from a frame.
  - The key is pinned to the tenant it was minted in (`:953`), but the runner is
    **per user, not per workspace**. The runner store is subject-scoped by design
    (`host/selfHostedRunner.ts`, the ADR 0464 note).
  - A dispatch additionally requires the `claude-code` toggle to resolve on **in the run's
    own tenant**.
  - A route-level test pins both halves: a matching subject is found, and another
    subject's runner is never matched.
- Revoke means revoking that developer key. Revocation closes the device's live terminal
  and runner channels on the next frame.
- **The Paired devices list reads from the key.** (Correction, P1: the draft called the
  list "a filtered view of developer keys, not a second store".) A small device row does
  exist, because the label, platform and **consent record** (version + hash) have to live
  somewhere. But the row holds **no authority**. Its status (`active` / `revoked` /
  `expired`) is derived from the developer key on every read. Revoking a device is
  revoking its key, and the key's own verifier refuses the next request.
- The companion keeps the key in the OS keychain, falling back to a file with mode `0600`.
  This follows the prior art's `pilot.json` discipline, minus the plaintext on Windows.

### D4 — Transport: the companion connects out, and nothing listens on the user's machine

The steward chose outbound-only. **Nothing listens on the user's machine and the CSP does
not change.** This closes prior-art lesson 10: there, an origin allowlist was the only gate
between a web page and a localhost PTY.

- **Runner control (P5) is RFC 0122 as written:** SSE `GET` for dispatch frames and `POST`
  for result frames, authenticated by the developer key. It carries no terminal bytes.
- **Terminal bytes (P2) go over a host-extension WebSocket** at
  `/v1/host/openwop-app/claude-code/terminal/:terminalSessionId`, with two sides: the
  companion as `role=host` and browsers as `role=viewer`. The upgrade handler copies
  `collabServer.ts`'s boundary item for item:
  1. `originPolicy` for viewers (CSWSH);
  2. developer-key bearer for the host, or a `?ticket=` minted over `/api` for viewers;
  3. the `claude-code` toggle and the operator gate;
  4. subject match (a viewer must be the key's owning user; no sharing in v1);
  5. per-user socket caps.

  Every failure rejects the upgrade.
- **Frames** follow the prior art's contract:
  - host → viewer: binary PTY output;
  - viewer → host: `{type:'input', data:b64}` and `{type:'resize', cols, rows}` JSON,
    each ≤ 1 MiB.
- **The replay buffer lives in the companion** (512 KiB, the prior art's value), so it's
  the source of truth and a relay restart loses nothing. On a new viewer attach the
  companion sends the buffer first, then live bytes.
- **A slow viewer is dropped, never skipped**: a terminal missing bytes renders garbage.
- **Every PTY spawn carries a generation number.** A late exit or input from a previous
  generation is discarded.
- **Cross-instance.** The host socket and a viewer socket can land on different Cloud Run
  instances.
  - A durable `claude-code:terminal-session` row records the instance holding the host
    socket.
  - When a viewer lands elsewhere, the two relay over `publishHostExtEvent` (Postgres
    LISTEN/NOTIFY, `hostExtPersistence.ts:258`), with output coalesced into ≤ 50 ms frames
    and a per-session byte-rate cap.
  - **Frame size is bounded by `NOTIFY`'s 8000-byte payload limit:** at most 6 KiB of raw
    bytes per frame, so it still fits after base64. Anything larger is written to a
    short-lived row and notified by id. (Correction, architect review: an earlier draft
    said 16 KiB, which `NOTIFY` rejects.)
- **The runner channel has the same cross-instance problem.** Today's registry is an
  in-process `Map` holding **one runner per subject** (`selfHostedRunner.ts:57,67-76`).
  On multi-instance Cloud Run, the runner's SSE connection and the dispatching run can
  land on different instances, and a second device silently overwrites the first. So P5
  replaces the Map with:
  - a durable registry keyed `(subject, deviceId)`, recording the instance holding each
    live SSE;
  - frame delivery to that instance over the same relay seam;
  - explicit device selection: the node's `device` input, else the subject's most
    recently active device that advertises the `claude-code.task` tool.
  - `--session-affinity` (already documented for voice) keeps the common case local.
  - **This path is the P2 measurement gate** because it rides the `db-f1-micro` LISTEN
    budget (Q2).

### D5 — Frontend: a tab kind and a drawer, not a second chat

- **Tab kind.** `DeckTab` gains `kind?: 'conversation' | 'claude-code'`, where absent means
  `conversation`, so persisted decks restore unchanged.
  - `tabDeckPersistence` re-validates it.
  - `TabChatDeck.tsx:711` branches: a `claude-code` tab mounts the lazily loaded
    `ClaudeCodeTerminalTab` instead of `<TabSession>`.
  - The new-tab button becomes a `ui/Menu` offering **New chat** and **Claude Code**. The
    Claude Code option is visible only when the toggle is on and a device is paired.
- **Why this is not a second chat (the CLAUDE.md rule).** The rule forbids re-implementing
  a conversation: composer, feed, persistence, BYOK, agents. This tab renders **a
  third-party tool's own TUI**. It has no composer, no message model, no history store and
  no model call from this host. Anything that *is* conversational still goes through the
  one chat:
  - P5 dispatches are **runs**, so their progress and results appear as the ordinary
    `WorkflowRunBubble`.
  - Permission prompts appear as ordinary approval cards.
  - A future "chat view" of an interactive session would be a conversation projection,
    not a new panel (Q3).
- **The drawer.** A "Pair with Claude Code" button on the builder, app-builder and
  run-detail pages opens a side drawer. The drawer copies `BuilderShell`'s AI-drawer
  mechanics (`inert` when closed, escape handler, `ModalPortal`).
  - It starts a session with a **launch prompt argument**: `claude "<prompt>"`, where the
    prompt names the workflow, run or app id and tells Claude Code to read it over MCP.
  - The host never types into a running TUI to steer it. The prior art's keystroke
    injection works around the lack of an RPC channel, and MCP is ours (prior-art lesson 3).
- **Terminal UX from the prior art:**
  - Shift+Enter sends CSI-u `ESC[13;2u`;
  - Ctrl+C copies when there's a selection and sends `\x03` otherwise;
  - resize is debounced 220 ms;
  - one in-flight start is shared across StrictMode remounts;
  - offline and uninstalled states each get a designed card (install command, pairing
    CTA).
- Strings go into all four locales (`i18n/locales.ts:24`, enforced by
  `scripts/check-i18n.mjs`).

### D6 — Claude Code connects to this host over MCP, and the tools are a chain pack

- The companion launches `claude` with `--mcp-config` pointing at
  `/v1/host/openwop-app/mcp`, authenticated with the paired key, plus a `--settings` file:
  - a deny-list for `~/.ssh/**`, `~/.aws/**`, `**/.env` (the prior art's set);
  - the D7 hook.
- The companion keeps its own plugin directory, holding an `/openwop:*` skill set that
  explains the protocol. **Skills describe; the server refuses** (prior-art lesson 1).
- **Tools** ship as `feature.claude-code.mcp-tools`, a chain pack of `expose-tool`
  workflows (never an in-tree registration, per the chains-or-stacks rule):
  - `kanban.list`, `kanban.add-todo` (the same seam as `openwop:kanban.add-todo`,
    `host/agentToolProvider.ts:361`), `kanban.move`;
  - `runs.start`, `runs.status`, `runs.events` (tail, bounded);
  - `interrupts.list` (read-only);
  - `schema.lookup`.
- **Each tool shares its HTTP route's access predicate** (one helper; the route and the
  tool both call it) and fails empty without an acting user. This is the AI-exchange
  non-negotiable, and each tool gets a tracker row in `docs/steward/LLM-EXCHANGE-AUDIT.md`
  with its tripwire.
- **Inbound tool arguments are untrusted** (`mcpSemantics.ts`, RFC 0020 §D). MCP-started
  runs carry `metadata.trustBoundary: 'untrusted'` as they already do.

### D7 — Permission prompts become approval cards in the one queue

- The companion's settings register a Claude Code permission hook. The exact hook event
  (`PermissionRequest` versus `PreToolUse`) will be confirmed against the current Claude
  Code docs at implementation (Q1).
- The hook calls `POST /v1/host/openwop-app/claude-code/permission-requests` with
  `{deviceId, terminalSessionId?, runId?, tool, summary, inputDigest}`, which enqueues a
  `PendingApproval` with a new discriminated `kind: 'claude-code-permission'`, beside the
  existing `actionId` branch (ADR 0025 §4: no new approval store).
  - `workflowId` is required on the row (`approvalService.ts:85`), so it is left empty,
    as the existing non-run kinds already do (`:106`, `:136`).
  - The kind's claim and reject branch lives in the **shared decision module**, which
    both `/approvals` and `/reviews` call (`routes/approvals.ts:218-221`), not in a new
    route.
  - **The branch refuses any `auth.kind === 'api-key'` principal, and any non-human
    session.** The generic claim route checks no scope (see the D3 correction). A
    route-level test pins it: an `owk_` key presenting the claim gets 403.
- The hook long-polls for the decision. **The deadline defaults to deny** (5 min
  interactive, the step deadline for P5).
- **Whoever answers first wins, through a CAS** on the approval row, not a status check
  (a legal-transition table only rejects a write it sees):
  - the user in the TUI (the hook withdraws the card);
  - a human in the inbox, on a phone, or through ADR 0198 delegation or out-of-office.
- The card shows the tool, a bounded argument summary, the device label and the repo path.
  It **never shows secrets**: arguments are digested and redacted, never echoed wholesale.
- **The companion's key cannot resolve approvals.** This is enforced by the api-key refusal
  in the decision branch above, not by the missing scope. Only a human session can resolve.

### D8 — Autonomous lane: the heartbeat dispatches a step, and the companion runs one stateless task

- **The node.** `feature.claude-code.nodes.task` has inputs `{prompt, repo, device?,
  allowedTools?, maxTurns?, deadlineMs?}` and output `{status, summary, artifacts[],
  transcriptRef}`. It calls the RFC 0122 **tool-dispatch** frame `{runId, stepId, tool:
  'claude-code.task', inputs}` against the run's owning subject.
  - **Subject-first match.** No runner means a typed `runner_unavailable`, which RFC 0122
    §3 makes *retriable*. That is safe because nothing was sent. There is never a
    fallback to another user's runner.
  - **The node dispatches, then suspends. It does not wait inline.** Today's
    `dispatchToRunner` awaits `execute` inline, which on this path would hold an executor
    worker for up to the step deadline. Computer-use yields for exactly this reason
    (`computerUseService.ts:30-33`). The result POST resumes the suspended node through
    the executor's existing suspend/resume seam. The deadline is a run timer, not an
    `await`. (Correction, architect review.)
- **The companion** runs each task in a **fresh process**:
  `claude -p --output-format stream-json`, with the same `--mcp-config`, `--settings` and
  plugin directory. It mirrors the stream read-only into a terminal session so a viewer can
  watch, then POSTs the result frame.
  - This is the prior art's `/clear`-per-cycle lesson (a stateless agent against
    server-held state) **without** its TUI injection, whitespace-stripped sentinel parsing
    or stuck-output heuristics. Completion is a typed result frame.
- **At-most-once needs a claim before the send. Today's store does not provide it.**
  `dispatchToRunner` (`selfHostedRunner.ts:108-126`) reads the result store, calls
  `execute`, then writes the result. That misses two cases:
  - a crash after `execute` but before the write, followed by redelivery, runs the step
    twice;
  - two concurrent deliveries both run it.

  So P5's first change is host-side: a **compare-and-swap claim row**
  (`{subject, runId, stepId} → dispatched`) written **before** the frame is sent.
  - A redelivery that finds `dispatched` with no result **never resends**. It returns
    `maybe_executed`.
  - A sabotage test (remove the claim, and concurrent plus crash-injected redelivery
    executes twice) pins it.

  A task's effects on the user's machine are not idempotent. There is **no automatic retry** of a step that
  may have run (prior-art lesson 8). A step that times out after dispatch surfaces as
  `maybe_executed` and needs a human decision.
- **Replay** reads the recorded result and never re-dispatches (RFC 0122 §3).
- **Fork re-routes by subject and never pins the original device.** RFC 0122 §3: a fork
  *"MUST NOT pin to the original `runnerId`"*. `run.metadata.claudeCode.deviceId` is an
  **audit stamp only**. (Correction, architect review: the first draft's matrix row 9 read
  it verbatim on `:fork`, which violates the RFC.)
- **Output** re-enters the host fenced `<UNTRUSTED>` (`runner-output-untrusted-transport`).
- **How kanban cards reach it: through the chain, not a new profile field.** The card
  names a chain, or the agent's chain includes the `task` node.
  - The heartbeat picks the card through ADR 0534 as today and runs that chain.
  - The chain's `task` step dispatches to the user's runner.
  - (Correction, architect review: the draft added an agent-profile `executor` field. It
    was dropped. It would have been a new field threading through the profile validators'
    allowlists, which delete fields they don't list, and it is redundant: choosing a
    chain that contains `task` already routes the work.)
  - `checkAutonomousRunBudget` and the ADR 0318 cadence apply unchanged.
  - The companion **never pulls work**, so there is no agenda, snapshot, claim TTL or
    browser lease.
- **Honest advertising.** `selfHostedRunner` is advertised **only** once the live channel
  (D4) is wired and honoured, with `dispatchKinds: ['tool']`. Model-dispatch is not
  implemented and never advertised.

### D9 — Safety floor (each item gets a test)

- Frames and logs never carry a credential (RFC 0122 invariant, test-pinned).
- The companion key has no `approvals:respond` (D3). Unsupervised tools default to deny
  (D7).
- There is a **workspace-root allowlist**: the user picks repo roots at pairing, and the
  companion refuses a `repo` input outside them. The host checks the claimed root against
  the device's registered list; the companion enforces it.
- **Stop means a process-tree kill.** Send SIGHUP, wait 3 s, then kill the tree. Claude
  Code ignores SIGHUP, and orphaned MCP children hold locks (prior-art lesson 4).
- **Rate limits:**
  - pairing start is per client address (the forwarded-for reading, never `req.ip`,
    which is the Cloud Run front end). Poll has only the global per-IP budget: it
    needs a 32-byte device code, so it is not guessable. (Correction, P1 review: this
    line said "start/poll are per-IP".)
  - permission requests are per device;
  - terminal bytes are capped per session;
  - runner dispatches are capped by the existing autonomous-run budget.
- **DSAR.** Paired-device rows, terminal-session rows and permission-request approvals
  register erasers (ADR 0464 store tripwire). Runner results already have one.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | `features/claude-code/` on both sides; `clients/agent-host/` outside the app. **Two deliberate core edits, both minimal and additive:** (a) `DeckTab.kind` + one render branch in the chat deck; there is no tab-kind registry, and adding a registry for one consumer is premature (Q4 records the trigger for promoting it); (b) the upgrade dispatcher routes the new path the way it already routes `canvas-collab`. Core never imports the feature. The deck branch lazy-imports via a registry lookup keyed on `kind`. |
| 2 | Toggle + admin UI | `claude-code`, **OFF**, bucket `user`, no variants. Double-gated by `OPENWOP_CLAUDE_CODE_AT_OWN_RISK`. Managed in `FeatureTogglePanel`. Paired devices appear in personal settings. |
| 3 | Workflow orchestration | `ctx.claudeCode.dispatchTask(...)` behind the toggle, the operator gate and the run's subject. Advertised only via RFC 0122's `selfHostedRunner` once honoured (D8). |
| 4 | Node pack | `feature.claude-code.nodes`: `task` (P5), `device-status` (read-only: is a runner connected for the subject). Signed through the registry pipeline and listed in `requiredPacks`. |
| 5 | AI-chat + envelopes | **No new envelope kind.** Chat reach is (a) the deck tab (a tool surface), (b) runs rendered as run bubbles, (c) approval cards. MCP is the external-process lane per the three-lanes rule. |
| 6 | Agent pack | **None in this ADR.** Claude Code *is* the agent. An `executor: 'claude-code'` agent profile is configuration on an existing roster member, not a new persona. (A "Claude Code operator" persona can follow once P5 is proven. It would be a pack, never source.) |
| 7 | Public surface | `pair/start` and `pair/poll` are unauthenticated, hold only a device code, are rate-limited per IP, return a uniform 404 when the gate is off, and expire in ≤ 10 min. Nothing else is public. |
| 8 | RBAC + isolation | Every route requires the toggle, the operator gate and an authenticated subject. Device, terminal and runner rows are keyed by subject; cross-subject access returns 404. Viewer = owner only in v1. Permission requests are scoped to the device's subject. Resolving requires a human session. Fail-closed throughout. |
| 9 | Replay / fork | P5 results are at-most-once: a CAS claim before the send, and replay from the durable store. `run.metadata.claudeCode = {deviceId, credentialMode}` is stamped at dispatch as an **audit record**. `:fork` copies the stamp but routes by the run's subject, never by `deviceId` (RFC 0122 §3). Packs are decoupled from toggle state. |
| 10 | Frontend | `claudeCodeClient.ts`, settings page (devices + pair), `ClaudeCodeTerminalTab`, `ClaudeCodeDrawer`; nav through personal settings, not a new top-level group. `ui/` cohesion, tokens, four locales, light and dark terminal themes built from tokens. Gate: `( cd frontend/react && npm run build )`. |

## Phased plan

| Phase | Scope | Exit gate |
|---|---|---|
| **P0** | This ADR, consent copy (four locales), the ADR 0539 D4 correction note, the ADR 0756 cross-reference | ADR Accepted by the steward |
| **P1: companion + pairing** | `clients/agent-host`: `pair` / `status` / `unpair`, keychain (darwin) or `0600` file. Backend: pair routes, developer-key mint, paired-devices view, revoke, operator gate, DSAR erasers. Frontend: devices page + approval page | Pair → key → revoke round-trip test. Sabotage: dropping the gate turns tests red. The key has no `approvals:respond`, test-pinned |
| **P2: terminal** | **PTY session** in the companion (generations, tree-kill; moved from P1, see the implementation record), WebSocket relay (D4), companion-side replay buffer, `DeckTab.kind`, the new-tab menu, `ClaudeCodeTerminalTab`, drawer on builder / app-builder / run pages with launch-prompt handoff | Upgrade-refusal tests for every D4 item. Cross-instance relay measured against the pg budget (Q2). `/browser` light and dark. Frontend build green |
| **P3: MCP** | `feature.claude-code.mcp-tools` chain pack, shared access predicates, companion `--mcp-config`, LLM-exchange tracker rows | Every tool's route↔tool predicate parity test. `OPENWOP_MCP_SERVER_ENABLED` confirmed **on the live service** before claiming prod reach |
| **P4: approvals** | Permission hook → `PendingApproval` kind (branch in the shared decision module), long-poll, deadline-deny, first-answer CAS, api-key refusal | Race test (TUI vs inbox) resolves exactly once. Timeout denies. **Route-level:** an `owk_` key gets 403 at claim and reject |
| **P5: autonomous** | **First, host prerequisites:** CAS claim-before-send in `dispatchToRunner`; a durable `(subject, deviceId)` registry replacing the in-process Map; cross-instance frame delivery; dispatch → suspend → resume-on-result. **Then:** RFC 0122 live SSE/POST channel, `task` node, `maybe_executed`, per-device dispatch consent, `selfHostedRunner` advertisement | Crash-injected and concurrent redelivery executes **once** (sabotage-verified). Dispatch and result on different instances succeed. A fork routes by subject, not device. The RFC 0122 conformance scenario passes non-vacuously against the live channel. Runner loss → typed step failure → ADR 0535 card restore. No worker is held during a task |

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Browser → `localhost` direct** (the prior art) | Rejected by the steward (2026-09-29). It needs a `connect-src` widening, is subject to Chrome's private-network-access rules, authenticates by Origin alone, and only works on the same machine. |
| **Server-side Claude Agent SDK** instead of a local CLI | Rejected for this feature: it runs on the host's or the user's API key in *our* infra, not on the user's machine, repos and subscription, which is the point. It stays a valid separate feature (a hosted coding agent over `code-exec` / ADR 0555). |
| **Cloud sandbox terminal** (`host/sandboxAdapter.ts`) | Deferred (Q6). It's a good zero-install tier, but a different product: throwaway workspaces, operator-paid. The D4 relay and D5 tab would serve it unchanged, since the host role could be a sandbox instead of a laptop. |
| **A pull API with claims and leases** (port the pilot's agenda engine) | Rejected. It duplicates ADR 0534 / 0535 / 0543 row for row. The runner is a dispatch target. |
| **Drive the agent by typing into its TUI** and parse a printed sentinel | Rejected. The prior art does this for lack of an RPC channel and documents it as lossy (lesson 3). Here we have RFC 0122 result frames and MCP. |
| **API key only** (the ADR 0756-consistent option) | Offered. The steward chose login-at-own-risk. The API-key path remains first-class and is presented first (D2 lever 4). |
| **New "Claude Code" chat panel** | Forbidden by CLAUDE.md. Conversational output reaches the one chat as runs and approval cards. |

## RFC verdict

**No new RFC.**

- Pairing, the terminal relay, the permission bridge, devices and consent are
  **host-extension** routes under `/v1/host/openwop-app/claude-code/*`: non-normative, and
  they never touch the wire.
- The autonomous lane **rides RFC 0122 (Accepted)**. It passes the three-part test:
  - the wire shape is locked;
  - the RFC doesn't gate advertisement beyond its own capability;
  - this host will honour tool-dispatch before advertising.

  The host implements the RFC's own transport (SSE/POST), not a WebSocket variant.
- The MCP tools ride the already-advertised MCP server mount.
- **If** Q3 later wants interactive-session events on the run event log, that would be a
  new event type and needs an RFC first.

## Implementation record

> P1 was built at the steward's direction ("keep going") while the ADR read Proposed. The
> repo's ADR-status tripwire (`test/steward/adr-status-not-stale.test.ts`) then refused an
> implemented ADR reading Proposed, and the steward **accepted** it on 2026-09-29. P1 stays
> double-gated OFF (operator env unset, toggle OFF) until the P1 residue below is closed.

### P1: companion + pairing (branch `feat/claude-code-p1`, 2026-09-29)

| Piece | Where | Pinned by |
|---|---|---|
| Consent text (verbatim quote, source, fetch date) + content hash | `features/claude-code/constants.ts` | backend test: stale hash → 409; frontend test: mid-page change reloads and requires a fresh tick |
| Device-code pairing, claim-before-mint CAS, device row, derived status, revoke, DSAR eraser, `kvAgeOut` for pairing rows | `features/claude-code/pairingService.ts` | `test/claude-code-pairing.test.ts` (14 tests) |
| Routes: operator gate first, human session (`auth.kind === 'subject'`) for everything signed-in, per-IP start limit | `features/claude-code/routes.ts`; `/pair/device` in `PUBLIC_PATH_PREFIXES` | same file: gate-off 404s, api-key 401s, public-prefix pin |
| Devices page, approval page, four locales, `nav` keys | `frontend/react/src/features/claude-code/` | `__tests__/pairPage.test.tsx` (6 tests); `npm run build` green |
| Companion CLI | `clients/agent-host/` | `node --test` (11 tests), plus the backend test driving the **real** companion module against the **real** routes |

**Sabotage, run 2026-09-29.** Each guard was removed and the suite re-run:

| Guard removed | Suite | Result |
|---|---|---|
| Operator gate | backend | red |
| `approvals:respond` added to the device scopes | backend | red |
| Human-session check | backend | red, 2 tests |
| Stale-consent check | backend | red |
| Claim-before-mint CAS, replaced by a blind `put` | backend | **stayed green at first** |
| `!acknowledged` on Approve | frontend | red, 2 tests |
| Acknowledgement reset on reload | frontend | red |

**The CAS finding.** The HTTP "two racing polls" test could not tell a CAS from a blind
write, because the two requests serialized. A same-tick service-level race was added; it
goes red under that sabotage and green with the CAS. Kept as its own commit so the gap is
visible in history.

**Corrections the build forced:**

1. **The PTY session moved to P2.** It has no consumer until the relay exists, and shipping
   it in P1 would have been dead code with its own test burden. Prior-art lesson 5 (the
   arm64 `TIOCSWINSZ` padding) is specific to a raw P/Invoke. `node-pty` makes the ioctl
   natively, so P2 verifies it rather than copying the workaround.
2. **The approval route is `/claude-code/pair`**, not `/settings/…` (D3 correction).
3. **The device row holds consent and labels, not authority** (D3 correction).

### P5: app-dispatched tasks (branch `feat/claude-code-p4`, 2026-09-30)

| Piece | Where | Pinned by |
|---|---|---|
| `claude-code.task` node: runner-unavailable decided BEFORE any claim; **claim-before-send** (`putIfAbsent`); one frame over the device socket in RFC 0122's dispatch shape; `ctx.suspend` external-event keyed on the task | `features/claude-code/tasks.ts` | `claude-code-task.test.ts` (5): real run → device frame → HTTP result → resume → completed. Same-tick triple execution sends ONE frame; sabotage (blind `put`) → red |
| Device result route (only the device the task went to, uniform 404, idempotent), then resume through `resolveAndResume` | same | same file |
| Deadline sweep: an external-event suspend has no deadline, so overdue tasks resume as `expired` → `maybe_executed`, never retried | same | same file |
| Summary fenced `<UNTRUSTED source="claude-code">` before it re-enters the run (`runner-output-untrusted-transport`) | same | same file |
| Companion task runner: a FRESH `claude -p --output-format stream-json --verbose` per task, typed `result` event, device-side at-most-once (`tasks-seen.json`), prompts to the P4 tool, **explicit `--permission-mode acceptEdits`** | `clients/agent-host/src/taskRunner.js` | `taskRunner.test.js` (5) **and** the backend test driving the real `TaskRunner` into the real route; flags verified against the real CLI 2.1.285 |

**Corrections P5 forced:**

1. **`selfHostedRunner` is NOT advertised.** The frames reuse RFC 0122's dispatch and
   result shapes, but they travel over the P2 device socket, not RFC 0122's SSE/POST
   runner channel. Advertising the capability would claim a transport this host does not
   serve. D8's "advertise once honoured" therefore resolves to: the lane is host-private
   until an RFC 0122 channel is built.
2. **`dispatchToRunner`'s read → execute → write (architect finding #1) is NOT on this
   path.** P5 has its own claim-before-send store. The seam function keeps the defect;
   it is conformance-only and honest-off (`supported:false`), and it is recorded here so
   it is not mistaken for fixed.
3. **An explicit `--permission-mode acceptEdits` for app-started work.** MEASURED: the
   CLI inherited `permissionMode: "auto"` from the user's own settings, which lets the
   CLI approve tools itself and would bypass the approval cards. Edits inside the
   workspace root proceed; everything else asks a person.
4. **There is no agent-profile `executor` field (architect finding #8), and no new pack.**
   `claude-code.task` is an in-tree node, the app-builder MCP-node precedent. **Residue:**
   the builder palette lists pack-manifest nodes, so a `feature.claude-code.nodes` manifest
   (plus an example chain) is still owed for a user to find the step without knowing its
   type id.

### Second code review (P2–P5, 2026-09-30): fixed before merge

1. **A database read on every terminal output frame.** Device frames were
   ownership-checked with a store read EACH, so a busy terminal put steady load on
   Postgres. Ownership is now decided once per session per socket. It cannot go stale,
   because a session never moves to another device.
2. **Heartbeat- and approval-started runs carry no acting user** (MEASURED:
   `heartbeatService` and `approvalDecision` stamp only their provenance blocks), so every
   card-driven task would have been `runner_unavailable`. The task node now falls back to
   the card's board owner, **only for a personal board**, whose owner is unambiguous. An
   agent board gets `runner_unavailable`, never a guess. Both cases are pinned in
   `claude-code-task.test.ts`.
3. **The deadline sweep started only after a local dispatch.** It now starts at boot
   (operator gate on), so a task that expires across a restart is still expired.

Also checked: stamping `actingUserId` on MCP runs does not widen what existing MCP tools
show an API-key caller. `canvasReadAllowed` refuses an owned canvas for an `apikey:`
subject exactly as it did for an absent one, because memberships are keyed on people.
Unowned canvases stay visible either way.

### P4: permission prompts (branch `feat/claude-code-p4`, 2026-09-30)

| Piece | Where | Pinned by |
|---|---|---|
| `claude-code-permission` approval kind: ONE queue, its own disposition + audit lines (`claude-code.permission-allowed/denied`), owner-only audience (`policyApproverRef`), delete-on-erasure redactor | `host/approvalService.ts`, `approvalDecision.ts`, `approvalAudience.ts`, `features/claude-code/approvalPolicy.ts` | the redactor-completeness and audience tests; `claude-code-permission.test.ts` (6) |
| Eligibility: only the device's human decides; never a key (the generic claim route checks no scope) | `approvalPolicy.ts` | a device key → 403, a co-tenant → 403 and cannot see the card; sabotage → red |
| MCP tool `claude-code-permission` (the headless prompt tool): files the card, notifies ONLY the owner, waits ≤ 4 min; answers in the CLI's validated shape (read from the 2.1.285 binary); unanswered → deny + card closed | `features/claude-code/mcpTools.ts` | same file |
| Opt-in interactive hook (`on_timeout: 'defer'`): prints nothing on a timeout so the TUI prompt decides | `clients/agent-host/src/permissionHook.js`, per-session settings | `permissionHook.test.js` (4); the tab's opt-in checkbox |
| Both inboxes render it as Allow/Deny on the reasoned bar (the deny reason goes back to Claude Code), never "Approve & run" | `notifications/{NeedsYouInbox,ApprovalsInbox}.tsx` | `claudeCodePermissionCard.test.tsx` |

### P3: MCP (branch `feat/claude-code-p3`, 2026-09-30)

| Piece | Where | Pinned by |
|---|---|---|
| MCP runs stamp `metadata.actingUserId` the way HTTP runs do. Before this, no MCP backing node on this host could do per-caller work | `host/mcpSemantics.ts` | `claude-code-mcp.test.ts`; sabotage (drop the stamp) → 3 red |
| The personal board's two keys (personal tenant, canonical user id) captured at pairing approval, where a request exists | `pairingService.ts`, `routes.ts` | the todo is on the SAME board `GET /kanban/boards/personal` returns |
| `claude-code-my-todos` / `-add-todo` / `-schema-lookup`: expose-tool workflows (chain-backed, `mcp-tool-projections` 1.0.2 → 1.0.3) over in-tree nodes | `features/claude-code/mcpTools.ts` | `claude-code-mcp.test.ts` (4); sabotage (accept any key) → red |
| ONE schema lookup, shared with `openwop:schema.lookup` | `host/schemaLookup.ts` | `claude-code-mcp-schema-parity.test.ts`; sabotage (drift the served enum) → red |
| Companion launches `claude` with `--mcp-config` (a `headersHelper` command, so no key in files or env) and `--settings` (deny-rules incl. its own store) | `clients/agent-host/src/claudeConfig.js` | `claudeConfig.test.js`; the hook shape verified against the installed CLI 2.1.285 schema |
| Output coalescing (≤ 16 ms / 16 KiB) with flush-before-replay | `clients/agent-host/src/daemon.js` | `daemon.test.js` (ordering) |

**Corrections P3 forced:**

1. **The tool set is narrower than D6 listed.** D6 named board-wide `kanban.list` /
   `kanban.move`, `runs.*` and `interrupts.list`. Their routes' access predicates
   (`authorizeBoard`, `loadOwnedRun`) are request-bound and private to the route files.
   CLAUDE.md requires a tool to **share** its route's predicate, never reimplement it. So
   P3 ships only the tools whose rule already exists as a shared function. The rest are
   tracked as `XCH-CC-1`, blocked on that extraction.
2. **The add-todo write is `mcpApproval: 'never'`,** not HITL-gated. It files onto the
   caller's own board, a visible backlog that is never auto-executed: the agent tool's
   semantics, with the app-builder MCP-write precedent.
3. **The key reaches Claude Code through `headersHelper`, not an environment variable.**
   Every child of `claude` inherits the environment, including its Bash tool, so a
   prompt-injected `env` would leak an environment-variable token.

### Review from the jobpilot session (2026-09-30), folded in

1. **Cloud Run cuts every request at 60 minutes, WebSockets and SSE included.** Already
   handled: the companion reconnects with capped backoff, PTY sessions outlive the socket,
   and a re-attaching viewer gets the replay. The cost is recorded: each online device
   holds one request slot on one instance.
2. **NOTIFY is the riskiest piece, and cross-instance is the COMMON case.** Session
   affinity cannot co-locate a companion and a browser (they are different clients), so
   with N instances a viewer shares the device's instance only about 1/N of the time.
   - Mitigated now: companion-side coalescing, plus the relay publishing only while a
     remote viewer pings interest.
   - **Q2 is a hard gate before the operator gate is set in prod**, and it has to be
     measured on `db-f1-micro`.
   - If it fails, a **dedicated pub/sub becomes the primary relay**, with NOTIFY as the
     fallback.
3. **P4 is reshaped (adopted).**
   - **Headless (P5) tasks** route permission prompts through
     `--permission-prompts host --permission-prompt-tool mcp__openwop__claude-code-permission`,
     an MCP tool on this host that enqueues the approval card and waits for it. No hook,
     and it reuses D6's auth. Verified present in CLI 2.1.285.
   - **Interactive sessions** keep the TUI's own prompt by default. "First answer wins
     between the TUI and the inbox" is not achievable: while a blocking hook waits, the
     TUI shows no prompt. The `PermissionRequest` hook becomes a **per-session opt-in**
     ("approve from anywhere"), and when it times out it returns `ask`, handing the
     decision back to the TUI.
4. **The arm64 `TIOCSWINSZ` note did not transfer** (already recorded in P2). The real
   distribution risk is confirmed: node-pty 1.1.0 ships prebuilds for **darwin and win32
   only**, so a Linux install needs a native toolchain. Added to the P1 residue.
5. **Require an API key for app-dispatched (P5) work?** This re-raises D2 for the
   autonomous lane specifically, where the quoted terms bite hardest. The steward decided
   login-at-own-risk for all lanes on 2026-09-29. This ADR records the recommendation as
   open question **Q10**; it does not change the decision.

### P2: terminal (branch `feat/claude-code-p2`, 2026-09-30)

| Piece | Where | Pinned by |
|---|---|---|
| Upgrade seam: features register raw-upgrade handlers; `main()` attaches once | `host/upgradeRegistry.ts`, `index.ts` | terminal test: the handler is registered through the seam |
| Relay: local delivery, bus only while another instance declared interest, chunks < NOTIFY's 8000 bytes, replay-before-live | `features/claude-code/terminalRelay.ts` | `claude-code-terminal-relay.test.ts` (6, two instances on one bus) |
| Device socket (Bearer key only; refused with any Origin) + viewer socket (origin + 60 s HMAC ticket bound to tenant/subject/session); key re-verified every heartbeat | `features/claude-code/terminalSockets.ts` | `claude-code-terminal.test.ts`: full round trip, forged cross-session frames ignored, 7 upgrade refusals |
| Terminals API (open / list / ticket / stop), device `online`, revoke closes the live socket, presence + session rows, DSAR | `routes.ts`, `terminalStore.ts` | same file |
| Companion: PTY sessions (generations, 512 KiB replay, SIGHUP → group SIGKILL, spawn-helper repair) + `run` daemon (reconnect with backoff) | `clients/agent-host/src/{ptySessions,daemon}.js` | `node --test` (20, incl. a real node-pty smoke) **and** the backend test driving the REAL daemon against the REAL server |
| Deck tab kind + persistence + new-tab menu + `?newTab=` deep link; route-aware ⌘K sources; the xterm tab | `chat/tabDeck/*`, `ui/commandContributions.ts`, `features/claude-code/ClaudeCodeTerminalTab.tsx` | `tabKinds.test.tsx`, `viewerSocketUrl.test.ts`, `openHere.test.ts`; `npm run build` green |

**Corrections P2 forced:**

1. **The drawer became a ⌘K route command plus a deck deep link.** D5 promised a drawer
   on the builder, app-builder and run pages. None of those pages has an extension slot,
   and the pages are core: importing an excludable feature there fails the ADR 0630
   boundary. So two small *generic* seams landed instead:
   - `registerRouteCommandSource`, evaluated by the palette against the current page and
     link-only;
   - `?newTab=<kind>&tabContext=…` on the chat deck.

   "Open in Claude Code" on a workflow, run or app-builder canvas opens a Claude Code tab
   whose launch prompt names the thing and tells Claude Code to read it over MCP. A true
   side drawer would need a page-slot seam; it is recorded here, not built for one
   consumer.
2. **The collab origin check cannot admit the device.** `originPolicy` refuses a missing
   Origin whenever an allowlist is set, which is production. The device role therefore
   authenticates by Bearer only and **refuses any** Origin, the inverse of the viewer.
3. **The CSP gets an explicit `wss://*.run.app`,** rather than relying on `https:`
   implying `wss:` in every browser.
4. **The prior art's arm64 `TIOCSWINSZ` workaround was not ported.** `node-pty` issues the
   ioctl natively. Its real macOS defect was a different one: the prebuilt
   `spawn-helper` ships without its execute bit (every spawn fails with
   `posix_spawnp failed`). The companion repairs it at startup.
5. **Q2 (terminal traffic over Postgres) is answered by construction for the common case.**
   A same-instance session publishes **no** bytes. Cross-instance traffic is
   chunked < 8 KB and flows only while a remote viewer pings interest. The load
   measurement on `db-f1-micro` stays owed before the operator gate is set in prod.

### P1 code review (`/code-review`, 2026-09-29)

Seven findings; items 1–4 and 6 fixed, 5 documented, 7 folded into 2:

| # | Sev | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | The start limit used `req.ip`. The app sets no `trust proxy`, so behind Cloud Run that is the front end's address, and the "per-IP" limit was **one global limit**: ten starts anywhere locked pairing for everyone | Keyed on `clientIp` (exported from `middleware/rateLimit.ts`); a test with two `X-Forwarded-For` addresses goes red under the old code |
| 2 | HIGH | Device-code phishing (RFC 8628 §5.4): `verificationPath` carried the code, a one-click lure | The link carries no code; the page **ignores** `?code=` and makes the user type it; it shows the requesting address, its age, and the workspace the key will join |
| 3 | HIGH | The devices page printed `--host <origin>` only, which fails on app.openwop.dev (API under `/api`) with a false "not enabled" | `pairCommand` derives `--api-base` from the SPA's own `config.baseUrl`; the companion accepts an absolute base for a cross-origin API |
| 4 | MEDIUM | A mint failure after the claim burned the pairing silently | Key ceiling refused at **approve** (409 `key_limit`); a mint failure at poll returns `status:'failed'` with a message the companion prints |
| 5 | MEDIUM | The keychain write passes the key in argv (`ps`-visible for an instant) | Documented in the code and README; a native binding is the real fix |
| 6 | MEDIUM | D9 claimed poll was per-IP limited | D9 corrected |
| 7 | LOW | The approval page did not name the workspace | Folded into 2 |

Also forced by the gate: the ADR 0642 v1-reliance ratchet refused two new
`/v1/host/openwop-app/*` literals. Routes are built with `vendorTwin` now, and the
companion calls the canonical, version-agnostic `/host/openwop-app/…` root (ADR 0652),
so a companion installed today keeps working after the `/v1` cutover.

### Turn-on preparation (2026-09-30)

**Pre-launch items, status:**

| Item | Status |
|---|---|
| macOS keychain path | **Verified** on a real login keychain from the INSTALLED package: stored there, absent from the credentials file, round-trips, removed on `unpair` |
| Publishable companion | **Ready.** `private` dropped; `files`, `license: Apache-2.0`, `repository` and `publishConfig.access: public` added; `engines.node` corrected `>=20` → **`>=22`** (the companion uses Node's built-in WebSocket client, stable from 22). The packed tarball (10 files, 15.4 kB) was installed into a clean directory: the CLI runs, and a real PTY spawns from the installed node-pty with the spawn-helper repair. **Publishing needs the npm account for `@openwop`** (this machine has no npm login). |
| Linux | **Documented.** node-pty 1.1.0 ships no Linux prebuild, so a Linux install compiles it (`python3`, `make`, a C++ compiler). Pairing works without it. |
| Q2 (relay load on `db-f1-micro`) | **Measured in the beta, with a stop condition** (runbook step 6). It cannot be measured without real sessions; a synthetic load on the shared prod database would itself be the risk. |
| User documentation | **Shipped** (2026-09-30): `docs/CLAUDE-CODE-SETUP.md` (users + operators, linked from the README and the companion README), the `set-up-claude-code` tutorial (narrative-only: no walkthrough actions exist for `/claude-code`, and a dangling Show-me would fail the binding-drift guard), and the public feature page `/p/claude-code` with a card on `/p/features`. The card links the public page, not the toggle-gated `/claude-code` route, so a visitor without the feature never lands on a dead link. |
| Builder palette listing for `claude-code.task` | **Shipped 2026-10-05 (D7, below).** A palette overlay ("Ask Claude Code" + form), the node reading config as well as inputs, and the gallery template `openwop-app.claude-code.ask`. |

> **CORRECTED 2026-10-04 — the companion's device socket cannot ride the `/api`
> door.** The first prod pairing (2026-09-30) paired fine and then showed the device
> **offline** forever. MEASURED: a WebSocket upgrade to
> `app.openwop.dev/api/host/openwop-app/claude-code/device` answers **404** (Firebase
> Hosting's rewrite drops `Upgrade`, so the backend sees a plain GET with no route),
> while the same request straight to Cloud Run answers **401** (the socket, asking for
> its key). Pairing and polling are plain HTTP, which is why they worked and the
> failure only appeared at `run`. The devices page now builds the pair command from
> `config.sseBaseUrl`, the direct base the SPA already uses for streams and the
> terminal viewer socket, and the runbook command below uses it. A device paired with
> `--api-base /api` must `unpair` and pair again.
>
> **Superseded in part (same day): the companion now finds the direct origin itself.**
> A second pairing with NO `--api-base` reached the same front door (Firebase also
> rewrites `/host/**`), so a correct command on the page was not enough: a user who
> types or copies an older command lands back offline. The host already advertises the
> direct origin for exactly this reason (ADR 0761, `extensions["openwop-app.host"]
> .streamBase`), so companion 0.1.1 reads it on every `pair` and `run`, validates it as
> the host does (https, no credentials, no query), persists it beside the pairing for
> the per-prompt permission hook, and prints the root it uses. Existing pairings repair
> on their next `run`. `run` also refuses a `--root` that is not a folder (the same
> session's `~/Users/david/...` expanded to a path that did not exist).

**Operator runbook** (in order; each step reversible):

1. **The code is live.** `/api/readiness` `build.commit` and `/build-info.json` both show a
   commit containing `55ecf9efa` or later. (2026-09-30: the backend half waits on the
   migration-22 boot fix — openwop-app-7f's deploy.)
2. **Publish the companion:** `cd clients/agent-host && npx -y npm@10.9.8 publish`. This
   needs an npm login with publish rights on `@openwop`. Check with
   `npx @openwop/agent-host` from a clean directory.
3. **Set the operator gate**, a merge update that keeps every other binding:
   `scripts/update-env.sh OPENWOP_CLAUDE_CODE_AT_OWN_RISK=true`.
   *(Corrected 2026-10-05, CE-16: this step used to say a bare `gcloud run services update
   --update-env-vars …`. With traffic pinned by name (ADR 0631) that mints a 0%-traffic
   revision and the flag never reaches a request; `update-env.sh` verifies the new
   revision and shifts traffic to it. The 2026-09-30 turn-on worked only because the
   operator shifted traffic by name afterwards.)*
   This mints a revision, so coordinate with whoever holds the deploy that day. Re-check the
   ADR 0631 traffic pin with `scripts/verify-deploy.sh`. With the toggle still OFF this
   exposes only the public, rate-limited `/pair/device/*` pair (the approval page 404s),
   so the order of steps 3 and 4 is safe.
4. **Enable the toggle for a beta cohort, not everyone:** `claude-code` → `status: 'beta'`,
   `betaCohort: [<your home workspace id>]`, via `PUT …/feature-toggles/admin/configs/claude-code`
   as a super-admin. **Not the Feature toggles panel's "Beta" button:** the panel cannot set a
   cohort, and `beta` with no cohort is an OPEN beta for everyone (`resolveConfig`,
   `host/featureToggles/service.ts`). Put the workspace id in the cohort, not the principal
   id: principal ids are not issuer-qualified, so one string can name two people.
5. **Smoke test, as the cohort member:**
   - `npx @openwop/agent-host pair --host https://app.openwop.dev --api-base https://openwop-app-backend-89896419173.us-central1.run.app` → type the
     code at `/claude-code/pair` → approve.
   - `npx @openwop/agent-host run --root <a repo>`.
   - Chat → New tab → Claude Code → the terminal opens, and `claude` answers.
   - In it, ask Claude Code to call `claude-code-my-todos`; the call reaches the MCP mount.
   - Tick "approve from anywhere", ask for a Bash command, and an Allow/Deny card appears in
     `/inbox`.
   - Revoke the device on `/claude-code`; the terminal disconnects.
6. **Q2 watch** during the beta (stop condition: Cloud SQL CPU > 70% sustained, or
   connections within 3 of `max_connections`):
   `gcloud sql operations list` is not enough, so read Cloud SQL metrics
   `database/cpu/utilization` and `database/postgresql/num_backends` over the session window.
   Open two viewer tabs so at least one lands on another instance (maxScale 3, affinity on).
   If the stop condition trips, turn the toggle off (instant), then plan the dedicated
   pub/sub relay.
7. **Widen** the cohort (tenant ids, then `status: 'on'`) only after step 6 is quiet.

**Rollback at any point:** toggle `claude-code` off (immediate, per request). Or unset the
gate with `scripts/update-env.sh OPENWOP_CLAUDE_CODE_AT_OWN_RISK=false`. Revoking a device kills its
key on the next request.

**P1 residue (must close before the operator gate is set anywhere):**

- **Publish the companion.** The devices page shows `npx @openwop/agent-host pair --host
  <origin>`, but `clients/agent-host/package.json` is `private: true` and nothing is on
  npm. Until it is published, only a repo checkout can run it
  (`node clients/agent-host/src/bin.js pair --host …`). The gates being off is what keeps
  this from being a broken promise to a user today.
- **Measure Q2** (cross-instance NOTIFY on `db-f1-micro`, a TUI repaint at scale). If it
  fails, a dedicated pub/sub becomes the primary relay.
- **Builder discoverability for `claude-code.task`:** a node-pack manifest plus an
  example chain (P5 correction 4).
- **Linux support for the companion.** node-pty ships no Linux prebuild, so either
  bundle a prebuilt binary or document the toolchain requirement (jobpilot review #4).
- **Exercise the macOS keychain path by hand.** It writes to the real login keychain, so
  the automated tests pin only the `0600` file fallback.

## Architect review record (2026-09-29, `/architect`, both tracks)

Nine findings, all folded in above as inline corrections:

| # | Sev | Finding | Where fixed |
|---|---|---|---|
| 1 | CRITICAL | `dispatchToRunner` is read → execute → write, so it is not at-most-once across a crash or concurrent redelivery (`selfHostedRunner.ts:108-126`) | D8, P5 prerequisite |
| 2 | CRITICAL | The `PendingApproval` claim and reject routes check no scope, so "no `approvals:respond`" did not stop the key (`routes/approvals.ts:222-249`) | D3 correction, D7 api-key refusal |
| 3 | HIGH | An `owk_` principal is `apikey:<id>` pinned to one tenant, while runs belong to `user:<id>` (`middleware/auth.ts:951-956`) | D3: the subject is `auth.issuer`; the runner is per user |
| 4 | HIGH | The runner registry is an in-process Map with one runner per subject (`selfHostedRunner.ts:57,67-76`) | D4: durable `(subject, deviceId)` registry |
| 5 | HIGH (wire) | Fork read `deviceId` verbatim, against RFC 0122 §3 "MUST NOT pin" | D8, matrix row 9 |
| 6 | HIGH | Waiting inline on `execute` holds a worker for up to the deadline | D8: dispatch → suspend → resume |
| 7 | MEDIUM | 16 KiB relay frames exceed `NOTIFY`'s 8000-byte limit | D4: ≤ 6 KiB raw, or row + id |
| 8 | MEDIUM | The agent-profile `executor` field is redundant and would be dropped by validator allowlists | D8: dropped |
| 9 | MEDIUM | `PendingApproval.workflowId` is required, and the decision branch location was unstated | D7 |

Classification: **additive**, no wire change. Boundaries: pass. It adds no second
executor, loop, approval store, token store or chat.

## Open questions

- **Q1.** Which Claude Code hook event carries permission decisions synchronously, and can
  a hook both *withdraw* a pending card and defer to the TUI? To be confirmed against
  current Claude Code docs at P4. D7's contract (deadline-deny, first-answer CAS) holds
  either way.
- **Q2.** How much terminal traffic can cross instances over `publishHostExtEvent` on
  `db-f1-micro`? P2 must measure it, not assume it. If it fails, the fallbacks are an
  affinity-only relay (with the viewer told to reconnect) or a dedicated pub/sub.
- **Q3.** Should an interactive session also project into a **conversation** (a
  chat-view toggle, fed by Claude Code hooks)? It's attractive, but it's a second writer
  into conversation history. It needs its own decision.
- **Q4.** When should the deck's `kind` branch become a registry? Trigger: a second non-
  conversation tab kind, such as a sandbox terminal (Q6).
- **Q5.** Should `clients/desktop` (Electron, ADR 0181) embed the companion so desktop
  users skip the install? It's additive, with the same pairing.
- **Q6.** A zero-install **sandbox** host role for users without a local machine, the
  cloud tier. It reuses D4 and D5, and needs its own ADR (cost and isolation).
- **Q7.** Codex support. The prior art is provider-neutral (a second `--provider`). The
  toggle id names Claude Code, so a second provider would be a companion flag, not a
  rename.
- **Q8.** Should this be a paid bundle (ADR 0419)? Not in v1.
- **Q9 — RESOLVED 2026-09-29.** `OPENWOP_MCP_SERVER_ENABLED=true` on the live service
  (read from `gcloud run services describe`, serving revision `00799-c7p`). The repo's
  `deploy/` still does not set it, so the P3 gate re-reads the live value rather than
  trusting this note.
- **Q10 (jobpilot review #5).** Should app-dispatched (P5) work require an Anthropic API
  key, leaving login-at-own-risk to the interactive lane? Open for the steward.

## PRD-vs-architecture corrections (what changed from the prior art)

| The prior art | Here | Why |
|---|---|---|
| Browser talks to `localhost:4102`; Origin allowlist only | Companion connects out; developer-key + ticket auth | CSP, private-network rules, and a real identity (D4) |
| Skills `curl` the API with a PAT (shell-quoting and `-f` hazards, lessons 6–7) | Typed MCP tools with validated arguments | The host already runs an MCP server (D6) |
| UI steers the agent by typing slash commands | Launch-prompt argument + MCP | No keystroke RPC (D5) |
| Sentinel + journal + stuck detector + intervention ladder | RFC 0122 result frame + step deadline | Completion is typed, not scraped (D8) |
| Agenda engine, versioned snapshot, claims with TTL, browser leases | Heartbeat + ADR 0534 selection; the run owns liveness | ADR 0543 D1 / 0535 D1 (D1) |
| `--permission-mode auto` + a deny-list | Deny-list + approval cards, deadline-deny | Governance the host already has (D7) |
| .NET 10 AOT host | Node + `node-pty` in `clients/` | Matches the existing loopback clients and one toolchain |
| PAT stored in `pilot.json` (DPAPI on Windows only) | OS keychain, `0600` fallback | Parity across platforms |

## Consequences

- Customers get "the Claude they already pay for, wired into their workflows", with
  approvals, runs and kanban as the connective tissue. No competitor ships the approval
  bridge.
- **The host takes on a documented terms-of-service risk, at the steward's direction.** It
  is bounded by an operator gate, per-user consent, and the fact that no Claude credential
  ever reaches this host.
- A new client to build, sign, publish and update (`@openwop/agent-host`). Release
  plumbing follows the `openwop-cli` precedent.
- The deck gains its first non-conversation tab kind. That is the seam Q4 and Q6 will
  grow.

## D7 — Per-device opt-in to workflow tasks (2026-10-05)

**Gap found while making the task step discoverable.** The pairing consent says *"Letting
this app send work to Claude Code on its own is a separate choice I make per device,
later"*, and P5's plan lists "per-device dispatch consent", but it was never built:
`chooseDevice` returned the first ONLINE device of the acting human. It was latent only
because nothing surfaced `claude-code.task` to authors. Listing it in the builder first
would have made the consent text false for every user.

**Decision.**
- `DeviceRecord.workflowTasks { enabledAt, enabledBy }`; absent = off, which is every device
  that existed before this change.
- An owner-only `PUT …/claude-code/devices/:deviceId/workflow-tasks {enabled}`. It is behind
  `requireHuman`, so a device key cannot grant itself unattended work. It is a CAS update,
  so a concurrent revoke is never undone.
- The task step dispatches only to opted-in devices. With paired devices but none opted
  in, it fails `consent_required`, before any claim or frame.
- The devices page has a **Workflow tasks** column. **Allow…** confirms in plain terms
  ("without you watching … may change files"); **Turn off** is immediate.

**Discoverability (the P5 residue), corrected.** The residue said a `feature.claude-code.nodes`
manifest was owed. Reading the loader overturned that: a manifest must ship an `index.mjs`
(`pack-manifest-impl-parity`), and loading such a pack overwrites in-tree executors. The
in-process node was already in the palette as a bare "Task" with no form. The fix is the
house pattern for in-tree nodes, a `NODE_CATALOG` presentation overlay, plus three more
pieces:
- the node reads `{ ...config, ...inputs }`, because the builder form edits config;
- `claude-code.mcp-node.*` is hidden from the palette, since it had leaked there like
  app-builder's would have;
- a gallery template, `examples/workflow-chain-packs/claude-code-task`.

**Tests:**
- An online, un-opted device gets `consent_required`, no claim and no frame. A sabotage run
  with the filter removed goes red. On → off is refused again.
- A key cannot opt in (401), a stranger cannot (404), and a non-boolean body is rejected (400).
- A config prompt reaches the frame.
- Palette parity: the label and form are present, and the MCP internals are hidden.
- Devices page: Allow… asks first, and Turn off is immediate.

