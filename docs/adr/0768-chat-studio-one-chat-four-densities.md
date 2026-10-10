# ADR 0768 — Chat Studio: one chat, four densities

Status: implemented (P1–P6; deferred items listed per phase)

## Context

The app has exactly one AI chat (`frontend/react/src/chat/`, RFC 0005), and
CLAUDE.md forbids a second one. It renders at two sizes today: the full page
(`ChatTab` → `ChatSidebar` / `TabChatDeck`) and the slimmed embed
(`EmbeddedChatPanel` → `EmbeddedConversation` → `ConversationView`, ADR 0073),
used by roughly a dozen feature surfaces (builder `CreateWithAiPanel`, CAD
assist, agent author, project chat, commerce, advisory board, KickTodo guide and
studio, intent ledger, capability scope).

A design pass (canvas "AI Chat Reimagined", 2026-09-28) asked for a fresh UX
across both sizes, and found three problems the current surfaces share:

1. **An approval can scroll out of reach.** An open interrupt renders only as an
   inline card under the message that raised it. Twenty turns later it is
   off-screen, and nothing near the composer says a run is paused on you.
2. **Every turn prints its full working.** Tool-call, hand-off, decision and
   verification cards render expanded on every assistant turn, followed by a
   provider/model/token meta line. A long thread becomes mostly receipts.
3. **The composer's power is invisible.** `/` (workflows, chains + stacks) and
   `@` (agents) are the chat's differentiators, and they are discoverable only
   by typing the character.

## Decision

Treat every AI surface as the **same conversation at one of four densities**.
The moments, the composer and the BYOK gate never fork; only the chrome grows
or shrinks:

| Density | Is | Owner |
| --- | --- | --- |
| **Studio** | full page at `/` | `ChatTab` |
| **Dock** | side panel inside a feature | `EmbeddedChatPanel` |
| **Pocket** | launcher + popover / modal | `EmbeddedChatPanel` (P5) |
| **Mobile** | any of the above under 720px | responsive rules (P6) |

Five principles, each a phase below:

1. **Talk left, work right.** Runs, artifacts and sources open in a Studio
   *workbench* pane; the thread keeps a receipt that links to them.
2. **What needs you never scrolls away.** Open interrupts surface above the
   composer in every density.
3. **The composer is the command line.** Sigils are visible, not memorised.
4. **Honest receipts.** Each turn states what it did from fields it already
   carries. A figure it cannot source is omitted, never estimated. A failure is
   never folded away.
5. **Every small chat can grow.** Dock and Pocket hand off to Studio with the
   same conversation id.

The load-bearing constraint: **P1 changes only the shared seam**
(`ConversationView`, `MessageBubble`, `ChatInput`), so Studio and every
`EmbeddedChatPanel` consumer get it in one change and nothing is reimplemented
per surface.

### Corrections the implementation forced on the design

- **There is no `#` board sigil.** The canvas drew `#` as "cite a board". The
  code's board summon is `@@<handle>` (`detectBoardMention`), and its
  `BoardMentionAutocomplete` is currently mounted **hidden** (`u-hidden`,
  `aria-hidden`). P1 ships `/` and `@` chips only. A board chip waits until the
  board picker is visible again, and it would be `@@`, not `#`.

  > **CORRECTED (P3): the board picker was never hidden.** The `u-hidden` /
  > `aria-hidden` / `tabIndex={-1}` attributes this bullet quoted belong to the
  > hidden file `<input>` that follows `BoardMentionAutocomplete` in
  > `ChatInput.tsx`. The claim came from reading two non-adjacent excerpts of the
  > file printed back to back, which made the input's attributes look like the
  > picker's. `@@` has worked since #304. The `#` half of the correction stands:
  > the sigil is `@@`. P3 ships the `@@` chip, gated on `advisory-board`.
- **`/` is not insertable mid-message.** `detectSlashTrigger` opens the picker
  only for `^(@agent\s+)?/query$`. So the `/` chip seeds an empty message or an
  `@agent ` hand-off prefix, and is **disabled with a stated reason** once prose
  is typed. It does not silently clobber the draft.
- **The tray is a pointer, not a second resolver.** The canvas drew
  Approve/Reject in the tray. Duplicating the card would mean two resolve paths
  and would break `InterruptCardStack`'s focus handoff (a11y). The tray names
  the gate and moves focus to the one actionable inline card.
- **The receipt shows no turn duration.** `ChatMessage` carries no settled-at
  timestamp for a 1:1 turn (only `thoughts.durationMs` and per-tool
  `startedAt`/`finishedAt`). A wall-clock figure would be invented, so it is
  left out until the turn records one.

  > **CORRECTED (P3): the turn already records one.** Every RFC 0005 conversation
  > turn carries `ts` on the wire; `turnsToBubbles` simply dropped it and the
  > client re-stamped `createdAt` with "now". No new persisted field was needed:
  > `replyMs` = the agent turn's `ts` − the preceding user turn's `ts`, derived
  > in `turnsToBubbles`, identical live and on reopen.

## Alternatives weighed

- **A new chat surface for the redesign, behind a toggle.** Rejected: it is the
  second-chat drift CLAUDE.md forbids (the retired `AiAuthorPanel` precedent),
  and embeds would not get it.
- **Move interrupt cards into the tray.** Rejected for the resolve-path and
  focus reasons above.
- **Hide the agent-event cards entirely.** Rejected: that removes information,
  and a failed tool must stay visible. The receipt folds; it never deletes.
- **A feature toggle for P1.** Rejected: P1 is a presentation refinement of an
  existing surface with no new capability, data or wire. Every card that
  rendered before still renders, one click away or, for failures, by default.

## Trade-offs

- A healthy settled turn now needs one click to see its tool cards.
  Mitigation: open while streaming, open on any failed tool or failed
  verification, and the summary line names the counts.
- The tray hides while every open card is on screen, using
  IntersectionObserver. Without IO (jsdom, very old engines) it stays visible,
  which is the fail-safe direction for an approval prompt.

## Phased plan

| Phase | Scope | Status |
| --- | --- | --- |
| **P1** | Shared seam: Needs-you tray (`NeedsYouTray`, `lib/openInterrupts`), turn receipt (`TurnReceipt`), composer `/` + `@` chips (`ChatInput`) | **implemented** |
| **P2** | Studio **workbench**: a right-hand pane with Run (today's `WorkflowProgressPanel`, moved from the left rail) + Artifact (`artifacts/ArtifactWorkbench`, docked) tabs, in BOTH shells | **implemented** (Sources tab + in-thread artifact open deferred — see P2 record) |
| **P3** | Live status on tabs + rows, the `@@` board chip, reply duration in the receipt | **implemented** (closed-conversation status deferred — see P3 record) |
| **P4** | "Continue in full chat": promote an embedded conversation to a rail conversation on click, deep-link it | **implemented** (a `density` prop + feature-supplied "can see" strip deferred to P5, where Pocket needs them) |
| **P5** | Pocket: `ChatPocket` (launcher pill + non-modal popover over the ONE embed), `EmbeddedChatPanel` `contextLabel` ("Can see …") + `density`; first consumer: Commerce | **implemented** |
| **P6** | Mobile: Workbench as a bottom sheet; rail ⟷ Workbench arbitration on phones; compact composer (`+` menu) for narrow viewports AND narrow hosts | **implemented** (first-run/gate copy refresh deferred — see P5/P6 record) |

### P1 implementation record

| Item | Where | Test |
| --- | --- | --- |
| Open-interrupt projection (pure) | `chat/lib/openInterrupts.ts` | `chatStudioP1.test.tsx` › collectOpenInterrupts |
| Tray + jump-to-card focus | `chat/NeedsYouTray.tsx`, mounted in `ConversationView`; cards tagged `data-interrupt-id` in `MessageFeed` | › NeedsYouTray |
| Turn receipt | `chat/TurnReceipt.tsx`, replaces the agent-event block + meta line in `MessageBubble` | › TurnReceipt (the failed-tool default is sabotage-proven: removing `troubled` from the default turns the test red) |
| Composer chips | `ChatInput` (`seedSlash` / `seedAgent`) | › composer sigil chips |
| Copy | `chat/i18n/{en,es,fr,pt-BR}.ts` | — |
| Styles | `styles/global.css` (`.needs-you-*`, `.turn-receipt-*`, `.chatinput-sigil-btn`), tokens only; status colour as hairline, dot or label only (DESIGN §3 rule 3) | frontend build gates |

### P2 implementation record

**Why the workbench is its own state, not another rail tab.** Both shells kept
ONE `activeRailTab`, so "Runs" and "Conversations" were mutually exclusive. A
workbench rendered off `activeRailTab === 'progress'` would have forced the
thread list closed whenever work was shown — the opposite of "talk left, work
right". `useWorkbench` holds an independent `run | artifact | null`.

| Item | Where | Test |
| --- | --- | --- |
| Workbench state (per-tenant persistence of `run` only; never restores an empty artifact tab; `null` tenant = no persistence for the deck) | `chat/workbench/useWorkbench.ts` | `workbench/__tests__/workbench.test.tsx` › useWorkbench |
| Pane (Run + Artifact tabs, arrow-key roving, ONE close, mobile overlay) | `chat/workbench/Workbench.tsx` | › Workbench pane |
| Artifact viewer docks instead of opening a modal (`docked` prop; Library keeps the modal); still lazy (entry budget) | `artifacts/ArtifactWorkbench.tsx` | › docks the artifact viewer |
| Run panel inside the pane without its own header | `WorkflowProgressPanel` `hideHeader` | › ONE close |
| Runs leave the left rail (`progressProps` optional) | `leftRail/LeftRail.tsx` | existing rail suites |
| ChatSidebar: legacy persisted `progress` rail tab migrates to an open Run tab; auto-open on a new dispatch, run-bubble open, reviews → docked artifact; header toggle | `ChatSidebar.tsx`, `ChatHeader.tsx` (`PanelRightIcon`) | hook-level (`initialTab`) |
| TabChatDeck: same wiring; toggle in `TabStrip`; `?rail=progress` → Workbench Run | `tabDeck/TabChatDeck.tsx`, `TabStrip.tsx` | `TabChatDeck.railDeepLink` (sabotage-proven: deleting the alias turns it red) |
| Width token `--workbench-w` | `tokens.json` + `foundations/tokens.css` | `check-dtcg-parity` |

**Deferred, with the reason:**

- **In-thread artifact → workbench.** `WorkflowCompletionCard` hands the feed a
  node's raw output; no run message carries a durable `artifactId`, and
  `listArtifacts` has no run filter. Matching a page of recent artifacts on
  `provenance.runId` would be a guess that silently misses older ones. It needs
  a host route filter (`GET …/artifacts?runId=`) first — host-extension, no RFC.
- **Sources tab.** Citations already render under each turn; a Sources tab
  earns its place only once it aggregates across turns (and knowledge reads),
  which is new projection work.
- **Mobile arbitration.** Below 720px both the rail and the workbench overlay
  full-width; opening one does not yet close the other. P6.

### P3 implementation record

| Item | Where | Test |
| --- | --- | --- |
| `running` tab state (turn in flight or a `pending`/`running` workflow run); ranks blocked > running > unread; OPTIONAL field so pre-P3 badge values are byte-identical; never announced (a state, not an arrival — the `unread` rising edge still fires when it settles) | `tabDeck/useTabBadges.ts`, `TabSession`, `TabChatDeck` `renderStatus` | `chatStudioP3.test.tsx` › running tab state |
| Row status "Waiting on you" / "Running" for conversations whose messages the client holds (the deck's open tabs) | `ConversationsRail` `liveStatusFor` | typecheck (shares the tab badge source) |
| `@@` board chip, gated on the `advisory-board` toggle | `ChatInput` `seedMention('@@')` | › @@ board chip (on + off) |
| Reply duration from the conversation log | `conversationTransport.turnsToBubbles` → `ChatMessage.replyMs` → `TurnReceipt` | › reply duration (derivation, absence, settle-only) |

**Deferred, with the reason:** a CLOSED conversation's row cannot show "needs
you" or "running" — the conversation list (`ChatSessionHeader`) carries only
message and read counts, and the client holds no messages for it. That needs a
host projection (open-interrupt + active-run counts on the session header), not
a client guess.

### P4 implementation record

**Decision: promote on click.** Three options were weighed against the code:

- *Persist every embed* — rejected. `persist:false` is a deliberate invariant
  (`useChatSession.integration.test`: "persist:false writes NO backend
  session/messages") so a builder session never clutters the rail or clobbers
  the main chat (ADR 0073).
- *Replay the transcript into a new session* — rejected. A new session mints a
  new RFC 0005 run: the agent's server-side context and any pending interrupt
  are lost, and the copied history is display-only.
- *Promote on click* — chosen. An ephemeral embed still opens a real
  conversation run, with `chatSessionId: session.id`. Promotion creates the rail
  row for THAT id, binds the existing run, copies the settled transcript and
  names the scoped agent as a participant. Nothing is written until the user
  asks, so the invariant holds.

| Item | Where | Test |
| --- | --- | --- |
| Promotion (strict: any non-409 failure throws; idempotent: 409 = done, so a retry finishes) | `chat/lib/promoteConversation.ts` | `chatStudioP4.test.tsx` › promoteConversation |
| ONE store encoding shared by write-through and promotion (so a handed-off conversation reopens exactly like a persisted one) | `encodeMessageForStore`, used by `useSessionPersistence` | › byte-equal to the encoder |
| The control: hidden on an empty conversation; disabled mid-turn; on failure it stays put, shows the reason and announces it | `chat/ContinueInFullChat.tsx`, in `EmbeddedConversation`'s footer slot (every embed consumer) | › ContinueInFullChat |
| Embeds still never persist on their own | unchanged | `useChatSession.integration.test` (green) |

The deep link works because the full chat mounts a fresh `useChatSessions`
list on navigation, and its `?conversation=` handler re-runs when that list
changes (`ChatSidebar.tsx` deep-link effect depends on `sessions`).

### P5 / P6 implementation record

| Item | Where | Test |
| --- | --- | --- |
| `ChatPocket`: a launcher pill (Mod+J, `aria-keyshortcuts`) and a NON-modal `role="dialog"` over the page; focus goes in on open and back to the launcher on Esc; the thread stays mounted while closed | `chat/ChatPocket.tsx` | `chatStudioP5P6.test.tsx` › ChatPocket |
| `EmbeddedChatPanel` `contextLabel` → a "Can see …" strip; `density: 'dock' \| 'pocket'` | `EmbeddedChatPanel`, `EmbeddedConversation` | › opens the ONE embedded chat at pocket density |
| **Commerce**: the Store Assistant moves from its own tab into a Pocket over every tab (ask about the orders you are looking at). An old `?tab=assistant` link opens the pocket. The scope label is **honest**: the assistant is not bound to the selected store or tab (the panel receives no `orgId`), so it says "your stores' catalog, orders, quotes and prices", never "this store". | `features/commerce/CommercePage.tsx` | commerce suite green |
| Mobile rail ⟷ Workbench: at most one pane over the thread on a phone; keeps the one that JUST opened. ONE hook shared by both shells | `useMobilePaneArbitration` | › useMobilePaneArbitration |
| Workbench bottom sheet (<720px): the thread that produced the work stays visible above it | CSS `.workbench-aside--mobile` | — (presentation) |
| Compact composer: sigil chips fold into the `+` menu on a narrow viewport (<480px) OR a narrow host (the Pocket passes `compact`, since a 420px popover on a wide screen is just as cramped) | `ChatInput` `compact`, `ConversationView` `composerCompact` | › compact composer |

**Deferred:** the first-run / BYOK-gate *copy* refresh drawn on the canvas
(States board). The states already exist and were split honestly by ADR 0517 /
0764; restyling them is a polish pass, not a density change. And the Pocket's
first consumer is Commerce only. Dock consumers (builder, CAD, agent author)
can adopt `contextLabel` one at a time; each must state a scope the agent really
has, never a guess.

### Phase 0 (follow-up program) — ONE canvas read predicate on every lane

Found while scoping the "can see" label (the embeds' agents are not bound to the
canvas on screen, so we checked what they CAN reach). The canvas editor HTTP
route has enforced project/user membership on a member-owned canvas since
**ADR 0610 D3′** (`canvasEditorRoutes.ts` `loadCanvas`); the other lanes loaded
canvases by tenant alone. This restores that invariant everywhere — it is a
bug fix under an existing decision, not a new one.

**The predicate.** `canvasReadAllowed(tenant, canvas, caller)` /
`getCanvasForCaller` / `listCanvasesForCaller` in `host/canvasSurface.ts`,
delegating to `subjectReadAllowed` (KBC-1), which REFUSES a caller with no
subject (a system run has no membership — the resolver would otherwise answer
"owner"). The editor route now calls the same function, so the chat lane and
the HTTP door cannot disagree.

**Exploitability, stated precisely** (narrower than the first audit claimed):
project policy (`levelFor`, ADR 0054 D5) gives `workspace:write` WRITE on every
project, private included; membership only widens READ. So lanes that already
required `workspace:write` were not exploitable. The real leaks:

| Lane | Before | Reachable by |
| --- | --- | --- |
| `cad` / `drawings` / `slides` / `campaign-studio` / `app-builder` agent `get-design` (+ the update loads) | read (and CAS-update) any canvas by id | an org **viewer** via chat |
| ui-plugin RPC `artifact.read` / `artifact.write` | read AND write ANY canvas, ANY type (no type pin, no scope) | **any authenticated tenant caller** |
| documents `canvas-sources` picker | listed every canvas name | an org viewer |
| app-builder MCP nodes (`open-project` list, `get-design`, `get-preview-url`, `render-design`) + the app-builder run surface | read/update by id | an MCP principal / a run |
| sharing mint, documents DELETE / materialize | (gated by `workspace:write` ⇒ policy already allows) | — now use the predicate for consistency |

**Witness:** `test/canvas-access-one-predicate.test.ts` (14). Sabotaging the
predicate (`return true`) turns **12** red; the 2 that stay green are the type
pin and the policy pin, which do not depend on it. The sabotage also caught a
second copy of the rule inside `listCanvasesForCaller`, now routed through the
one predicate. The DELETE test PINS the ADR 0054 D5 policy (an org editor may
delete a private project's canvas) so a future change to it is a decision.

**Follow-up (named, not guessed):** the ui-plugin RPC has no org-scope check,
so an org VIEWER can still `artifact.write` an ORG-owned app-builder canvas
(the editor route requires `workspace:write`). Canvases store no org, and the
route also serves API-key principals (the conformance witness), so the right
scope rule needs its own decision: `UIP-SCOPE-1`.
### Follow-up P1 — honest "can see" labels on the Dock embeds

None of the three Dock agents is bound to what is on screen (checked against
the agents' tool allowlists and the panels' props), so each label states the
agent's REAL reach, never "this canvas":

| Panel | Agent reads | Label |
| --- | --- | --- |
| builder `CreateWithAiPanel` | `nodes.get` = any workflow in the tenant (no id passed) + the node catalog | "the node catalog and the workflows in this workspace" |
| `CadAssistPanel` | `cad.get-design` by a model-supplied id, through the shared canvas predicate (Phase 0) | "CAD models you can open in this workspace" |
| `AgentAuthorPanel` | the catalog + roster; NOT the wizard's form | "available agents, workflows and your roster" |

Pinned by `chat/__tests__/embedCanSeeLabels.test.tsx` (removing a panel's label
turns its test red). A label may only say "this …" once the entity is actually
bound to the conversation — follow-up Phase 5.
### Follow-up P2 — open a run's artifact from the chat into the Workbench

The P2 deferral ("no run message carries a durable `artifactId`, and
`listArtifacts` has no run filter") is closed without guessing:

- **Backend:** `GET /v1/host/openwop-app/artifacts?runId=` (the EXISTING Library
  route, host-extension, so no wire change; a list under `/v1/runs/:id/artifacts`
  would be protocol surface). `listArtifactsForRun` is a FILTER over what the
  Library already shows the caller: every row resolves through `getArtifact`,
  the same per-artifact gate as `GET /artifacts/:id`. The read is one prefix
  scan on the run-artifact key (`${runId}:`), never the tenant-wide `.list()`.
  Items carry an additive `runNodeId`.
- **Frontend:** the feed keeps the run id on its preview; on a surface with a
  Workbench it looks up the run's artifacts (client loaded on demand, off the
  entry chunk) and offers "Open in the Workbench" ONLY for a confirmed artifact
  of the clicked node. Both shells pass `workbench.openArtifact`; embeds pass
  nothing and never look up.
- **Tests:** `test/artifacts-by-run.test.ts` (one run only; the `run-7` vs
  `run-70` prefix boundary is sabotage-proven; tenant isolation; bad input),
  `chat/__tests__/openRunArtifactInWorkbench.test.tsx` (match, no-match, no
  Workbench).

### Follow-up program — status (2026-09-29)

After P6 the design canvas was itemized (43 elements: 18 built, 19 partial,
6 missing) and the gaps were planned as tracks A–D. Each item lives in its
own ADR or record; this table is the roll-up, not the evidence.

| Item | What | Where recorded | Status |
| --- | --- | --- | --- |
| A0 | One canvas read predicate on every lane (a live hole) | Phase 0 above | live (#4222) |
| A1 | Honest "can see" labels on the Dock embeds | Follow-up P1 above | live (#4243) |
| A2 | Open a run's artifact from the chat in the Workbench | Follow-up P2 above | live (#4243) |
| A3 | "Waiting on you" for every conversation | ADR 0776 P1 | live (#4243) |
| A4/C1 | First-run card states; wizard + status card pinned before restyle | #4243 | live |
| B1 | Builder preview-then-apply | ADR 0773 (Pair Canvas, another session) | merged, not duplicated |
| B2 | Typed `/workflow` inputs inline; estimate from history only | #4255 | merged |
| B3 | Run outputs as cards opening in the Workbench | #4255 | merged (v2: thumbnail + diff badge need a server source) |
| B4 | Workbench Sources tab: web sources the turns CITED (de-duplicated, counted once per turn) + files the user SENT, from messages already held (no server read); reachable from the Workbench strip and the receipt (shells only, via `WorkbenchActionsContext`) | `chat/workbench/sources.ts`, `SourcesPanel.tsx`; `sources.test.tsx` (8; 3 sabotages caught) | built |
| B5 | Embed bound to the canvas beside it | ADR 0777 | merged (#4255) |
| B6 | "Running" on closed conversations | ADR 0776 P2 | merged (#4255) |
| B7 | Tools declare read/write for the receipt | ADR 0784 | P1 merged (#4255); P2–P4 open |
| C2 | Header: the session cost is a quiet mono figure, not a badge. The agent/model chips are unchanged (the model zone is already one control) | `ChatHeader.tsx` (`.chathdr-cost`) | built |
| C3 | Step bar on the run bubble: one segment per step. The bubble knows COUNTS, not graph order, so it fills by count (done, failed, the step in hand, the rest) and carries no per-step labels; dashed only while the run waits on the user; dropped above 12 steps | `WorkflowRunBubble.tsx` `stepSegments`; `runStepBar.test.ts` | built |
| C4 | Recovery rows share one shape: a status dot replaces the tinted left rail on every `.env-chip` event row | `global.css` | built |
| C5 | ⌘K box in the navigator: already there. The app shell's nav carries "Search… ⌘K", which opens `ui/CommandPalette`. The design's wording ("threads, runs, artifacts") is NOT copied: the palette has no conversation source, so the box keeps its plain "Search…" | app shell nav | built (seen live 2026-10-01) |
| C6 | Phone subline under the tab strip: agent · model · session cost, only the segments that are known. Rendered by each tab from state it already holds (no lift to `TabStrip` was needed); hidden above 640px, where the composer toolbar shows the same facts | `tabDeck/TabSession.tsx` `TabSubline`; `tabSubline.test.tsx` | built |
| C7 | Key wizard: the operator note moved BELOW the provider choice (it stood between the heading and the tiles). The three steps, the free tier and the Copilot path are kept; the design's one-screen gate would drop them | `byok/ProviderGrid.tsx` | built |
| C8 | The composer bar wraps instead of crushing the textarea in a narrow thread column (16px → 186px at 1280 with both rails open) | `global.css` (#4299) | live |
| C9 | A workflow id is OPAQUE. Three chat sites tested `workflowId.startsWith('wf_')` — the spelling of a blank workflow minted in the browser — so every server-minted workflow (`wf.seed.…` starters, `wf.<chain>.<id>` template copies, `wf.fork.…`, sub-chains, cadence) ran with no step count, no step names and no "Open in builder" link. All workflows are one definition format in one store on one executor; only the chat's reading of the id diverged. Now: ownership is read from the ownership index (`isOwnedWorkflow`), the step total from the index's `nodeCount` (also for a run an agent tool started) | `chat/lib/workflowMentions.ts`; `ownedWorkflow.test.ts` | built |
| C10 | Recovery rows and the run step bar are on `/design-system` from fixtures, in the gallery's screenshot + a11y lanes, light and dark. They render only when a model call goes wrong or a run is mid-flight, so they had shipped unseen | `design-system-gallery/GalleryPage.tsx`; `e2e/design-system.spec.ts` | built |
| D1 | `@agent` hint, with copy CORRECTED against behaviour: it is a handoff (routing switches), and with files attached the mention does NOT switch agents (`chatSubmit` skips activation). Uses the shell's own `agentEntries` (no second fetch) | `AgentHandoffHint.tsx`; premise pinned in `chatSubmit.test.ts` | built |
| D2 | Unreadable attachment said in TEXT (was a hover title only); judged by the model that will answer (the per-message override). The design's "switch to a vision model" is NOT built: every provider in providers.json is all-vision or no-vision, so no same-provider alternative exists (a cross-provider one needs a second key) | `lib/attachmentCaps.ts`, `ChatInput.tsx` | built (switch: not applicable) |
| D3 | "Ask for a source" on an agent member's channel message: DRAFTS an @-addressed question quoting the claim (never sends); handle from the channel roster, the same entries @-mentions route on | `MessageFeed.tsx` / `MessageBubble.tsx`; `askForSource.test.tsx` | built |
| D4 | Slash picker shows its REAL keys (Enter or Tab picks, Esc closes; the design's "⇥ fill inputs" is not the behaviour) | `SlashAutocomplete.tsx`; `slashPickerKeys.test.tsx` | built |
| D5 | Pockets on CRM, Support and Analytics, each on its feature agent with an honest scope ("… in organizations you can read"; the tools resolve any readable org, not the one on screen) | page tests pin agent + scope; none while the feature is off | built |

Deliberate differences from the canvas, kept: boards are `@@` not `#`; the
cost estimate appears only from real history; starter-card metadata appears
only when the workflow definition provides it.

Found along the way and fixed separately: two chat agent tools skipped their
route's org gate (#4253, JOBS-SCOPE-1 / BI-SCOPE-1). Node-lane surfaces taking
an org from node inputs are the DOCUMENTED tenant-trusted posture
(`host/featureSurfaces.ts` CTI-1), a deferred refinement, not the same defect.

## RFC gate

None. P1–P6 are presentation changes in the SPA over data the client already
holds. No run-event field, capability, endpoint or wire shape changes. P4's
persistence decision is host-local (host-extension routes), not wire.

## Open questions

- [x] P4: **promote on click** (neither persist-always nor replay). See the P4 record.
- [x] P2: does the workbench replace the left rail's Runs tab, or mirror it? **Replace** — two homes for one panel is the drift this ADR exists to stop. `?rail=progress` stays a deep-link alias.
- [x] Board chip: ship it (user decision, 2026-09-28). It was never hidden — see the correction above.
- [x] Receipt duration: state it (user decision, 2026-09-28), from the wire turn `ts` — see the correction above.
- [x] Closed-conversation status on rail rows: **done** — waiting-on-you from the review inbox (ADR 0776 P1), running from one bounded read (ADR 0776 P2).
