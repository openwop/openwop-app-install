# ADR 0773 — Builder Pair Canvas: the AI edits the workflow on the sheet, you keep what it drew

Status: Accepted — P1–P9 and P11 (canvas parity) implemented; P10: G-10a/G-10c/G-10d implemented; G-10b graduation bar MET 2026-10-05 (managed tier after B.8: 5/6, 6/6, 6/6); G-10e graduation implemented (default ON, Create-with-AI drawer retired, managed default free allowance 50k → 150k); architect-reviewed 2026-09-28 (2 Blockers, 3 High, 3 Medium, 1 Low, all folded in)

Design canvas: "Copilot Canvas — AI chat × workflow builder"
(`https://claude.ai/artifact/Y3C6X1qJ3jLdcicvUCQP3q`, boards 00–07). Composes
ADR 0072 (workflow author), ADR 0768 (Chat Studio), ADR 0764 (run digests),
ADR 0770 (builder integrity), ADR 0596 (workflow-author honesty), ADR 0481
(builder multiplayer), ADR 0582 (approval gates), ADR 0150 (permission mode),
DESIGN.md §7 (canvas canon).

## Context

The builder has one AI entry point: "Create with AI", a slide drawer under the
toolbar (`builder/BuilderShell.tsx:1005`) that lazy-imports the ONE chat
(`chat/EmbeddedChatPanel`) scoped to the Workflow Architect. It was graded
**C−** for AI authoring (`docs/steward/UX-ASSESSMENT.md:69`), and the audit below
confirms why. The chat and the canvas cannot talk to each other:

1. **The AI cannot see what you are looking at.** `EmbeddedChatPanel` takes only
   `agentId`, `renderEmptyState`, `tenantId`, `onManageProvider`,
   `byokFallback` and `onTurnSettled` (`chat/EmbeddedChatPanel.tsx:41-58`).
   No workflow id, selection or draft is passed. The Architect's `get` tool reads
   the cached registered head (`workflowAuthorService.ts:419-430`), not the canvas,
   and returns no revision.
2. **The AI can only replace the whole workflow, behind your back.** `persist`
   registers a full definition with no `If-Match`
   (`workflowAuthorService.ts:190-410`). ADR 0770 files this as `WBWF-17`
   (AI lanes last-writer-wins, `0770:86-90`, P2 "follow-up"). If the Architect
   persists the open workflow, the canvas does not refresh and the next autosave
   collides with a 409.
3. **The AI's work cannot reach the canvas.** `agent.toolReturned` carries no
   result payload (`chat/hooks/chatSession/lib.ts:113-116`). The drawer's only
   bridge is the ADR 0596 "Open on canvas" link, which diffs `listWorkflows()`
   on each `onTurnSettled` (`0596:81-90`).
4. **Nothing is point-and-click.** There is no per-node or inspector AI, no
   "fix this error" and no "explain this". The deferred items in
   `docs/steward/UX_UPGRADE-workflows-builder.md` include the edge-"+" insert and
   showing AI build progress phase by phase.

ADR 0768 made every AI surface "one chat at one of four densities". The builder
is the Dock density's most demanding consumer. ADR 0768 P4 explicitly deferred
"a feature-supplied 'can see' strip" (`0768:122`). This ADR is where a feature
first needs it.

## Boundaries audit

Measured on `origin/main` `674970fbc`.

| Question | Finding | Consequence |
|---|---|---|
| Name collision | "proposal" is taken twice: ADR 0473 composed-workflow proposals (`host/workflowComposeTool.ts:83`, `composed-workflow` approval `host/approvalService.ts:62`, `/workflow-proposals/admin/policies`) and RFC 0096 learning proposals (`features/proposals/`, `/v1/host/openwop-app/proposals`). `builder/ProposalBanner.tsx` renders the 0473 lane. Nothing uses "suggest" or "edit" as a route or tool. | The object is a **`WorkflowEditSuggestion`**. The design canvas's word "proposal" is UI copy only and never an identifier. **This is a correction to the canvas.** |
| Builder ownership | The builder is **core** (`chrome/features.tsx:165,169`, no featureId) and `chat/` is core. | The rail UI lives in core `builder/pair/`. It reads availability from the server, following the collab precedent (`BuilderShell.tsx:154,164`: availability is probed, not imported), so core never imports a feature. |
| Workflow author | Always on. Its toggle is retired (`features/index.ts:180`, `RETIRED_TOGGLE_IDS`). It has four tools, `openwop:feature.workflow-author.nodes.{draft,get,validate,persist}` (`agentTools.ts:76-79`), with no shared route/tool predicate (`routes.ts:31` uses only `tenantOf`). | A new toggle cannot hang off a retired one. The server half is a **new feature-package `builder-pair`** that `dependsOn: ['workflow-author']` (ADR 0194, an always-on dep that never blocks). |
| CAS | The CAS path exists only on REST: `parseIfMatch → readRegisteredWorkflowFresh → revisionHashOf → registerWorkflowIfUnchanged` (`routes/workflows.ts:496-538`, `host/workflowsRegistry.ts:43,72`), plus `requireWorkflowWrite` (`:428`, ADR 0770 D1). | Suggestions never write the definition. Keeping a suggestion goes through the builder's existing `enqueueBuilderWrite` (`builderStore.ts:80`) with `if-match` (`registerClient.ts:64`). The AI gets **no** write path of its own. |
| Undo | `pushHistory` is module-private and snapshots only `{nodes, edges}`, with `HISTORY_MAX = 30` (`builderStore.ts:928-934,156`). | Suggestion ops are limited to nodes, node config and edges (including conditions). Workflow-level fields (`name`, `inputSchema`, default inputs) are **out of scope** for v1, because a keep must be one honest undo step. |
| Tool events | `agent.toolCalled`/`toolReturned` reach the client with the tool name (`chat/conversationTransport.ts:461-484`, `lib.ts:96`), but `EmbeddedChatPanel` does not surface them. `onTurnSettled` is a bare tick. | Add one generic, chat-owned callback, `onToolActivity({ toolId, phase })`. It carries no payload, so it is not a result channel. The builder uses it only as a **fetch trigger**. |
| Send hook | `EmbeddedConversation` owns its submit (`:62-66`), so no consumer can run anything before a turn is sent. | Add a third generic prop, `beforeSend?: () => Promise<{ ok: true } \| { ok: false; reason: string }>`, at the ONE embed submit choke. Every send path goes through it: composer, follow-up chips, inline ask, Diagnose. (Architect review A2.) |
| Turn context | An embed cannot attach context to a turn. `EmbeddedConversation` builds its own submit (`:62-66`), `composerSeed` is text-only (`composerSeed.ts:21,51`), `SendOptions` has no context field (`chat/types.ts:516-565`), and RFC 0205 parts are "never hand-set" (`host/conversation.ts:56-60`). | **Do not extend the turn.** The builder publishes a *pairing context* record host-side, and the Architect **reads it with a tool** (agents read before they write, a CLAUDE.md non-negotiable). No turn-shape change, no wire change. |
| Keying the context | Tool scope carries `runId`, which is the conversation run (`conversationToolLoop.ts:310`). The embed session holds `conversationRunId` (`chat/lib/promoteConversation.ts:49,65`). | The pairing context is keyed by `(tenant, actingUser, conversationRunId)`. `EmbeddedChatPanel` exposes it via `onConversationRun(runId)`. |
| Permission mode | Not stored. It is React state per conversation (`useComposerModifiers.tsx:63,130`), read server-side only by the firewall (`conversationToolLoop.ts:121,481`). `BundleScope` has no permission field (`inMemorySurfaces.ts:236-290`). | **Correction to the canvas decision.** Auto-keep cannot key off the chat's bypass mode. It becomes a **builder-side preference** ("Auto-keep small edits", default off), applied client-side where the keep happens anyway. |
| Collab | Local edits reach the Y doc through a store subscription, pushing whole slices on a 300 ms debounce, one Y undo step per flush (`builder/collab/workflowCollabAdapter.ts:4-12,200`). `persist` already refuses `workflow_room_live` (`:276`). | A keep in a live room flushes the adapter immediately so that one keep is one Y undo step. Suggestions never enter the Y doc. |
| Approval gates | Gate typeIds: `core.approvalGate`, `core.interrupt` (`bootstrap/nodes.ts:888,1026`), `core.chat.approvalGate`, `core.hitl.*`, `kanban.board.review`. `nodeRoleMap()` resolves host nodes to `unclassified` (`nodeCatalogBuilder.ts:191-219`). The ADR 0582 witnesses hold their own constants (`test/workflow-chain-effect-reject-witness.test.ts:106,117`). | One exported `APPROVAL_GATE_TYPE_IDS` host constant, which the ADR 0582 witness also imports so the two cannot drift. Ops touching a gate or a gate-incident edge are flagged `gateSensitive`. |
| Tests a new tool must pass | `agent-prompt-tool-ids.test.ts:46-55` (the scanner finds `features/*/agentTools.ts`), `schema-read-exemption-completeness.test.ts:430` (needs an `[id, schemaCarrying]` row), and workflow-author `promptCatalogParity.test.ts:59-85` ("exactly four tools"). | All three are updated in P2. The parity test widens to name the pair tools as a separate, pinned set. |

## Decision

**The builder's right rail becomes one rail with two tabs, Pair and Inspect,
joined by the selection.** Pair is the ONE chat (`EmbeddedChatPanel`, lazy, scoped
to the Workflow Architect). Inspect is today's `inspector/Inspector.tsx`. The
composer stays docked at the rail's foot in both tabs. The AI sees the live draft
and the selection by reading them with a tool. It proposes changes as a
**`WorkflowEditSuggestion`**, a list of typed ops against a base revision. The
builder renders the suggestion as a ghost layer on the sheet, with field diffs in
the inspector. The user keeps or drops each op, and **a keep is an ordinary store
mutation**: one undo step, saved by the ordinary CAS autosave. The AI never writes
the open workflow.

### D1 — The rail (frontend, core `builder/pair/`)

- `railR` renders `PairRail`: a `role=tablist` of Pair and Inspect. Pair lazy-mounts
  `EmbeddedChatPanel` (the lazy-import rule is unchanged: the chat→builder edge
  would cycle). The "can see" strip is the feature-supplied slot ADR 0768 P4
  deferred. It states the surfaces the Architect can read ("live draft (unsaved) ·
  selection · catalog · last run") and is generated from the pairing-context
  record, not hand-written.
- Stepping onto a suggestion op that edits config flips to Inspect with that field
  highlighted. Asking from Inspect flips to Pair.

  > **CORRECTION 2026-09-29 — the rail opens on Inspect, not Pair.** D1 never
  > named a default tab, and the store defaulted to Pair. MEASURED on the
  > graduation branch (toggle default ON): clicking a node left the rail on Pair,
  > so its fields never appeared, and `preset-inputs-clickthrough` CT-E1/E2/E4
  > went red. It had already reddened `main` once, via a global-toggle leak from
  > `pair-canvas.spec.ts` (fixed in #4249). The rail is the builder's
  > PROPERTIES rail (DESIGN.md §7.1.5), so it opens on Inspect. Every AI entry
  > (Ask, ⌘., Diagnose, a cited run step, a send) already switches to Pair
  > itself. Both panels stay mounted, so the chat still mints its conversation in
  > the background. Witness: the three preset cases fail on the graduation
  > branch without the change and pass with it; `pairP11.test.ts` pins the
  > initial tab.
- Selection chips: the store's selection (nodes, edge, multi) renders as removable
  chips in the composer's context row. Chips follow the selection until the user
  pins or removes one. Dragging a node, edge, run-drawer step or palette item onto
  the composer adds a chip. The keyboard path is a `+ node` combobox (the same
  `comboboxWiring` as `/` and `@`).
- **"Create with AI" retires.** The drawer (`BuilderShell.tsx:1005`) and
  `CreateWithAiPanel` are deleted in P5, once the empty-sheet entry (D6) replaces
  them. There is one entry per scale (canvas board 00 §06), never two drawers.

### D2 — Pairing context (server, `features/builder-pair/`)

- `PUT /v1/host/openwop-app/builder-pair/context` takes
  `{ conversationRunId, workflowId, selection: { nodeIds[], edgeIds[] }, lastRunId? }`.
  It is written **only inside `beforeSend`** (D3), the one moment the model can
  read it. It is never written on selection change, because that would spend the
  per-IP write budget (ADR 0640/0771) and compete with autosave. The can-see
  strip and the chips render client-side from the store. The record is a
  `DurableCollection` row keyed `(tenant, actingUser, conversationRunId)`
  (a point `get`) with a 24 h TTL.
- **Validation is closed-world.** The caller must be able to read `workflowId`
  (`workspace:read`), checked by the new scope-shaped predicate in
  `host/workflowWriteAuthority.ts` (D4, Architect review A5). Ids not present in
  that workflow's head are **dropped and reported** (`droppedIds`), never trusted.
  `lastRunId` must belong to that workflow in this tenant (ADR 0764 D5 binding
  rule).
- Tool **`openwop:feature.builder-pair.nodes.read-canvas`** returns
  `{ workflowId, name, revision, definition, selection, lastRunDigest? }` for the
  calling conversation run (`scope.runId`). It reads the head fresh (`readRegisteredWorkflowFresh`,
  not the cache) and returns its revision hash. Without an acting user or a
  context row it returns an **empty typed result**. It is `schemaCarrying`, so it
  is never compacted (`SCHEMA_READ_EXEMPT_TOOLS`).

### D3 — Flush on send

The builder's `beforeSend` awaits `flushPendingBackendSync`
(`builderStore.ts:51`, today's flush-on-switch and pagehide) and then the context
PUT. So "the live draft" **is** the saved head at the moment of the turn. That is
what makes D2's fresh read honest without shipping unsaved state to the server a
second way. A flush that fails (409, offline) **blocks the send** with the existing
`SyncFailureBanner` reason. It never sends a turn whose "can see" claim would be
false.

In a live collab room REST saves are suspended. There, flush-on-send forces the Y
adapter flush, and the tool reads the room's persisted snapshot. If the room has
no snapshot newer than the head, the context row carries `staleWhileLive: true`
and the strip says so.

### D4 — Suggestions (server)

- Tool **`openwop:feature.builder-pair.nodes.suggest-edits`**
  `{ baseRevision, ops[], summary }`. Op kinds are closed:
  `addNode{typeId, name, config, position?}`, `removeNode{nodeId}`,
  `setConfig{nodeId, path, value}`, `renameNode{nodeId, name}`,
  `addEdge{source, target, condition?}`, `removeEdge{edgeId}` and
  `setCondition{edgeId, condition}`.
- **Closed-world validation** runs through the shared seams: typeIds against the
  live catalog (`nodeCatalogBuilder`), config against the node's JSON Schema
  (**CORRECTED 2026-09-29, review CR-10: NOT implemented** — `validateAuthoredWorkflow`
  checks structure, known typeIds and acyclicity only; a config value is checked by
  the human keep step and the node at run time, not here), edge
  endpoints against head plus ops, conditions in RFC 0134 wire form, and the
  result checked acyclic (the ADR 0596 rule) by `workflowDefinitionValidation`
  applied to head+ops. Each op records a **preimage** of every path it touches.
  Ops touching an `APPROVAL_GATE_TYPE_IDS` node or a gate-incident edge are
  stamped `gateSensitive`.
- An invalid op set is a **typed failure** with a reason per op and ONE bounded
  error-fed repair (the authoring-path rule). It is never a partial success.
- **Both tools require a pairing-context row for `scope.runId`.** Without one they
  return a typed `no_pairing_context` and write nothing. That is also the fork
  guard: a `:fork` re-fires the conversation's tool calls (ADR 0764:56-57) under a
  NEW run id, which has no context row, so a forked `suggest-edits` is refused
  instead of writing an orphan (Architect review A1).
- **Op ids and dependencies.** `addNode` ops get server-minted node ids
  (`sg_<suggestionId>_<n>`) that cannot collide with a peer's concurrent add. Ops
  that reference a ghost node carry `dependsOn: [opIndex]`. The builder keeps
  dependencies first, and an op whose dependency was dropped becomes
  `inapplicable` ("needs change 1"), never a dangling edge (Architect review A4).
- The result is stored as a `WorkflowEditSuggestion { id, workflowId, baseRevision,
  requestedBy, conversationRunId, ops[], opState[], visibility: 'private'|'room',
  createdAt }` in a `DurableCollection` keyed `${tenant}:${conversationRunId}`.
  There is **at most one active suggestion per conversation run**: a new
  `suggest-edits` supersedes it, and its undecided ops close as `superseded`. So
  the builder's read is a point `get`, never a `list()` scan (Architect review
  A3). A room-shared suggestion is also indexed in a small per-workflow row,
  `${tenant}:wf:${workflowId}` → `[suggestionKey]`, so peers read it by key. The
  store has a 24 h TTL and is registered with the ADR 0464 erasure tripwire:
  `requestedBy` is PII-adjacent, and the ops hold model output.
- `GET /v1/host/openwop-app/builder-pair/suggestions/:conversationRunId` (plus
  `GET …/suggestions?workflowId=` for room-shared, served from the index row) and
  `PATCH …/suggestions/:conversationRunId` (`opState` keep/drop, `visibility`)
  require `workspace:write` on the workflow. The check is **ONE scope-shaped
  predicate, `canWriteWorkflow({ tenantId, userId, workflowId })`, added to
  `host/workflowWriteAuthority.ts`**. `requireWorkflowWrite(req)` (`:32`) becomes a
  thin wrapper over it, and the routes and both tools call it (the CLAUDE.md
  shared-predicate rule). It is deliberately host-owned, not builder-pair-local,
  because ADR 0770 P2's `WBWF-17` needs the same scope-shaped check for every AI
  lane (Architect review A5).
- **Not a wire change.** `suggest-edits` is a chat-time tool. It is not an
  RFC 0021 envelope kind, and it adds no run-event field.

### D5 — Ghost layer, keep and drop (frontend)

- `builderStore.suggestion` holds the active suggestion. Ops render as a
  **`ghost` variant of `BaseNode`** (dashed clay, numbered) and ghost edges
  (§6 marching dash), with struck-through preimage values beside the proposed
  values in `Inspector`/`EdgeInspector`. An edge-docked instrument sits at the
  sheet's top edge (§7.1.2 allows edge-docked board instruments): the op count,
  J/K to step, Keep all, Drop.
- **Keep** applies the op through the same store actions a human uses
  (`addConnectedNode`, `updateNodeConfig`, …), so it gets one `pushHistory` entry.
  The ordinary debounced autosave then CAS-writes it. **Keep all** is one undo
  step for the whole set.
- **Per-op conflict check (canvas decision 1b):** at keep time each op's
  preimage is compared with the current store value at the same paths. If they
  match, it applies, even when the whole revision has moved. If they differ, the
  op is `stale` and shows the peer's value next to the AI's, with "Keep theirs",
  "Use the AI's" and "Ask to redo". A whole-revision mismatch alone never blocks,
  because otherwise every peer keystroke in a live room would invalidate the
  suggestion.
- **Auto-keep (canvas decision 2, corrected):** a builder preference, default off.
  It applies only to `setConfig`/`renameNode` ops on currently selected nodes that
  validate and are not `gateSensitive`, and it shows a 5 s undo toast. Structural
  ops, gate-sensitive ops, ops outside the selection, and publishing **always**
  wait for a person. This is an ADR 0582 invariant: the AI must never quietly
  route around an approval.
- **Fetch trigger (canvas decision 3, corrected):** the builder refetches the
  suggestion on `onToolActivity({ toolId: suggest-edits, phase: 'returned' })`
  and, as a fallback, on `onTurnSettled`. There is no SSE and no payload channel.
  A draft placed in several `suggest-edits` batches lands live, batch by batch.

### D6 — Point-and-ask entries (frontend)

Each entry feeds the same thread and the same suggestion layer:

- **Near-selection toolbar:** Ask, Explain and Run from here. **⌘.** opens an
  inline prompt anchored to the selection. Its exchange posts to the Pair thread
  (never off the record), and a small result is kept or dropped with a toast.
- **Edge "+":** the existing drop picker filtered to compatible ports, plus one
  "from your words" row that sends an inline ask scoped to that edge.
- **Palette:** a free-text query that matches no node offers "Describe a step…",
  which becomes an inline ask.
- **Inspector:** "Fill with AI" on schema fields, as an inline ask scoped to
  `{nodeId, path}`.
- **Run and repair:** a failed node's toolbar offers Diagnose. It adds a run chip
  (`lastRunId`, so `read-canvas` returns the ADR 0764 digest) and sends
  "Diagnose". Keeping the fix offers "Keep and re-run from here" through the
  existing debug lane (`debugSession.ts`, ADR 0475).
- **Empty sheet:** a "What should this workflow do?" composer on a new workflow.
  Progress phases (Planned → Placing n/N → Validate → Review) come from real tool
  events, never from a timer. A chain template also opens as a ghost suggestion,
  and `from-chain` runs only on keep.

### D7 — Multiplayer (canvas decision 1)

A suggestion starts `private`, visible only to `requestedBy`. "Share with room"
sets `visibility:'room'`, and peers then see it read-only: only the requester keeps
or drops. Ghosts never enter the Y doc. A keep flows through the store, then the Y
adapter, and is flushed immediately so that one keep is one `Y.UndoManager` step
for the requester (`workflowCollabAdapter.ts:43-48`).

### D8 — `persist` gets CAS (closes `WBWF-17` for this lane)

`persist` of an **existing** workflow id now requires `baseRevision` and goes
through `registerWorkflowIfUnchanged`. A mismatch is a typed
`workflow_head_moved` error, never last-writer-wins. Creating a new workflow is
unchanged. The Architect's prompt says: in the builder, suggest; `persist` is only
for creating a workflow from full chat.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Backend `src/features/builder-pair/` (`feature.ts`, `routes.ts`, `agentTools.ts`, `pairContextStore.ts`, `suggestionStore.ts`, `suggestEdits.ts`), appended to `BACKEND_FEATURES`, `dependsOn: ['workflow-author']`. The one host change is the scope-shaped `canWriteWorkflow`/`canReadWorkflow` predicate in `host/workflowWriteAuthority.ts`. Frontend in **core** `builder/pair/`, because the builder is core. It never imports the feature and probes availability from the server (collab precedent). Chat gains three generic, chat-owned props (`beforeSend`, `onToolActivity`, `onConversationRun`), not builder-specific code. |
| 2 | Toggle | `builder-pair`, **default OFF**, `bucketUnit: tenant` (a workspace pairs together, and a shared suggestion needs every peer on the same UI), no variants, managed in `FeatureTogglePanel`. When off, the routes return uniform 404, the tools return a typed `feature_disabled`, and the builder keeps today's drawer. It graduates ON at P5, and the drawer is deleted in the same change. |
| 3 | Workflow orchestration (`ctx.*`) | **None.** Pairing is an interactive builder surface. A run has no canvas to pair with, so a `ctx.builderPair` would be an unreachable surface (the ADR 0488 built-but-unreachable class). Stated, not deferred. |
| 4 | Node pack | **None as runnable nodes.** The two ids follow the `openwop:feature.<id>.nodes.*` tool-id convention (all 18 existing feature tool ids use `.nodes.`) so the ratchet scanners find them, but they are chat-time tools only. |
| 5 | AI-chat integration / envelopes | Chat-time tools (lane 1 of the three-lane rule). **No new envelope kind.** Tools are pack-allowlisted on the Workflow Architect (`packs/vendor.openwop-app.workflow-author.agents/pack.json:22-29`, version bump) and **not** added to the ADR 0315 default-on baseline. |
| 6 | Agent pack | Reuses the Workflow Architect. The prompt gains a builder-mode section that is generated from, or test-pinned to, the op-kind schema (`promptCatalogParity`, widened). The rules it states: read-canvas before suggest-edits; the smallest correct change (an edge condition beats a new node); never touch a gate unless asked. |
| 7 | Public surface | None. All routes are authenticated. |
| 8 | RBAC + isolation | Context PUT: `workspace:read` on the workflow. Suggestions GET/PATCH and both tools: `workspace:write`, through ONE helper shared by route and tool. The tenant comes from the session, never the body. Ids are checked closed-world against the head, and the context row is bound to the caller's conversation run. Fail-closed without an acting user (typed empty). A **viewer gets Pair in read-only mode**: `read-canvas` works (Explain, Diagnose), `suggest-edits` is refused as a typed `forbidden`, and the strip says "read-only · suggestions off". Viewers are not locked out of asking, and they cannot draw a suggestion they could never keep (Architect review A6). |
| 9 | Replay / fork | Both tools are a read plus a suggestion-store write that has **no effect on any run**. A `:fork` re-fires tool calls (ADR 0764:56-57) under a new run id with no pairing-context row, so both tools refuse with a typed `no_pairing_context` and a fork writes nothing (D4). Nothing here starts a run. "Keep and re-run from here" goes through the existing guarded debug lane (ADR 0764 D3 `queue.run-start`). |
| 10 | Frontend | `builder/pair/{PairRail,PairContextChips,SuggestionLayer,SuggestionInstrument,InlineAsk,pairClient}.ts(x)`, `BaseNode` `ghost` variant, Inspector diff rendering, and the `?`-overlay and ⌘K commands in the shared registry (§7.1.6). Uses `ui/` primitives and tokens only. Status color is carried by lightness and label as well as hue. J/K, ⏎, ⌫ and ⌘. are registered commands with a keyboard path for every pointer gesture (§7.1.12). i18n in all four locales. |

## RFC verdict

**Host extension, no RFC.** The routes sit under `/v1/host/openwop-app/builder-pair/*`,
the tools are chat-time feature tools, and there is no new run-event field,
envelope kind, capability or conversation-turn field. The two options that would
have touched the wire were considered and rejected: a turn-level context part
(RFC 0205 parts are content-derived, never hand-set) and a result payload on
`agent.toolReturned` (the ADR 0596 R1/`WFAU-4` history).

A portable "graph edit" envelope, so that another host's builder could consume
suggestions, would be an **RFC 0021 revision**. It is explicitly deferred and not
needed for this host.

## Alternatives weighed

- **Keep the drawer and add canvas context to it.** Rejected: the drawer occludes
  the sheet (§7.1.2) and fights canon 3 (docked rails, never floating panels).
  It would be a third AI place beside the rail and ⌘K.
- **A third rail for the chat.** Rejected: §7.1.5 (structure left, properties
  right) and the sheet-is-sacred width budget. Pair and Inspect share the rail
  because the selection joins them.
- **Let the AI write the canvas directly (auto-apply) with undo.** Rejected as the
  default. It is a hidden write path beside CAS, and a structural auto-edit can
  bypass an approval gate (the ADR 0582 class). Kept only as the narrow opt-in
  auto-keep in D5.
- **Reuse ADR 0473 composed-workflow proposals.** Rejected: that lane is a
  whole-definition transient draft pinned by hash and approved to *run*. It is the
  wrong granularity (per-op keep), the wrong lifecycle (run approval) and the
  wrong collision surface.
- **Put selection and draft in the turn (`SendOptions.hostContext`).** Rejected:
  it widens the turn transport for one consumer, it is client-asserted content the
  model would have to trust, and it breaks "read before write". The tool-read
  pairing context is closed-world validated.
- **SSE for suggestions.** Rejected for now: the CDN `/api` buffering carve-out,
  a connection per open builder, and a second live channel beside collab. The
  tool-activity trigger gives batch-level liveness at no cost.
- **Key auto-keep off the chat's bypass mode.** Rejected by the audit: the mode is
  not readable outside the composer and the firewall.

## Phased plan

| Phase | Scope | Exit witness |
|---|---|---|
| **P1 Context** | Toggle + `builder-pair` feature. `PairRail` (Pair/Inspect, composer docked). `EmbeddedChatPanel` `beforeSend` + `onConversationRun` + `onToolActivity`. `canReadWorkflow`/`canWriteWorkflow` in `workflowWriteAuthority.ts`, with `requireWorkflowWrite` re-based on it (the ADR 0770 D1 tests stay green). Context PUT + `read-canvas`. Selection chips, drag-to-cite, `+ node`. Flush-on-send, with the send blocked on a failed flush. Can-see strip. | Route and tool tests (viewer refused, foreign workflow and ids dropped, empty without an acting user). **Sabotage:** skipping the flush makes a "reads what's on screen" test red. `read-canvas` returns the head revision fresh (a stale-cache witness). Every embed send path runs `beforeSend` (a follow-up chip that bypasses it is red). The toggle-off witness asserts a 404 on a suggestion that returns 200 with the toggle on, **and** is sabotage-checked by deleting the gate (a bare 404 cannot tell "disabled" from "not found"). |
| **P2 Suggestions** | `suggest-edits` + closed-world op validation + preimages + `gateSensitive` + server-minted ids + `dependsOn`. Suggestion store (point-keyed per conversation run, supersede, room index, TTL, erasure). GET/PATCH. Ghost layer, instrument, J/K, keep and drop through store actions. Per-op conflict. Architect prompt + pack bump + the three ratchets. D8 `persist` CAS. | Keep = exactly one undo entry. Keep-all = one. **Sabotage:** removing the preimage check lets a stale op apply (red). A cyclic op set is a typed failure. A forked conversation's `suggest-edits` writes nothing (`no_pairing_context`). Keeping an edge whose ghost endpoint was dropped is `inapplicable`, not a dangling edge. No hot path calls `list()` (source-scan ratchet). `persist` on a moved head returns 409. |
| **P3 Point & ask** | Near-selection toolbar, ⌘. inline ask, edge "+" AI row, palette "Describe a step", Inspector "Fill with AI", auto-keep preference with its guard. | Auto-keep refuses a structural op, a gate-sensitive op and an op outside the selection (three sabotage-checked reds). |
| **P4 Run & repair** | Diagnose, run chip → `lastRunId` digest in `read-canvas`, keep-and-re-run through the debug lane. | A forked Diagnose conversation starts no run (the ADR 0764 D3 guard is reached). |
| **P5 First draft + graduation** | Empty-sheet composer, phase strip from tool events, chain template as a ghost suggestion, `from-chain` on keep. Collab `visibility:'room'`. Toggle ON. **Delete `CreateWithAiPanel` + drawer.** | A phase strip driven by a stubbed timer fails (the witness pins event-sourced phases). A room peer cannot PATCH another user's suggestion. |

### Gap-closure plan (P6–P10) — added 2026-09-29

A board-by-board gap analysis of the shipped P1–P5 against the design canvas
(boards 00–08) found the architecture complete and about 70% of the designed
experience built. **Every gap is scheduled below; none is dropped.** Gap ids
`G-nn` name the board they come from (`01` Pairing, `02` Point & ask, `03` Keep
or drop, `04` Run & repair, `05` First draft, `06` Architecture). All are
host-extension or SPA work (**no RFC**) unless a row says otherwise.

**P6 — keep the promises already made** (small; each fixes a claim the design or
this ADR already states)

| Gap | Scope | Witness |
|---|---|---|
| G-03a auto-keep undo toast | A visible 5 s toast ("Kept 2 small edits · Undo") on every auto-keep, via `ui/toast`, whose Undo pops exactly that undo entry; the SR announcement stays | auto-keep → toast shown → Undo restores the pre-keep graph (sabotage: remove the toast → red) |
| G-04a keep and re-run from here | "Keep and re-run from here" on a Diagnose suggestion: keep → await the CAS autosave → start the existing debug lane from the failed node (`debugSession.ts`, ADR 0475) | the rerun starts only after the save lands (a queued write is flushed first); a failed save starts no run |
| G-06a narration receipts (principle 04) | `builder/pair/narrate.ts`: debounced store diffs between turns, coalesced into one quiet line in the Pair panel ("You connected Enrich → Score lead · set model to Sonnet"); never sent per keystroke; the model reads the effect via `read-canvas` | a manual edit between turns yields exactly one coalesced line; a kept suggestion yields none (it is the AI's, already receipted) |
| G-01a status-edge count | the §7.2 status edge shows "suggestion: n pending" and the J/K hint while reviewing | rendered only while n > 0 |
| G-01b "Run from here" in the node toolbar | reuse the Inspector's `NodeDebugSection` action | same handler, no second run path |
| G-03b dropped ghosts stay visible | a dropped op renders as a faint outline until the suggestion closes, so a drop is visibly reversible ("Restore") | drop → outline remains → Restore returns it to pending |
| G-03c progress segments | the instrument shows one segment per op, coloured by status and labelled (never colour alone) | segments match `liveOpStatuses` |

**P7 — review depth** (the tracked-changes experience of board 03)

| Gap | Scope | Witness |
|---|---|---|
| G-03d per-change "why" | `suggest-edits` ops gain an optional `why` (≤ 280 chars, untrusted, fenced); shown in the review row and the Inspector diff; the prompt asks for it on non-obvious ops | schema-pinned in `promptCatalogParity`; rendered as text, never HTML |
| G-03e "Edit, then keep" | the Inspector diff's proposed value is an editable field; keeping keeps the EDITED value (still one undo step) | keep after edit applies the edited value; the PATCH records `kept` |
| G-03f "Use the AI's" on a stale op | force-apply a stale `setConfig`/`renameNode`/`setCondition` over the current value after a confirm (`ui/confirm`); structural stale ops cannot be forced | force on a config op applies; on a structural op the control is absent |
| G-03g who changed it | the stale explanation names the other editor: in a live room from Y awareness identity, otherwise from the head revision's recorded author (`workflowRevisions`); "someone" when unknown — never a guess | attribution appears only when a source exists |
| G-01c follow-up chips | after a suggestion, up to three follow-ups ("Test with a 95-score lead", "Who approves?") the Architect returns as an optional `followUps[]` on `suggest-edits`; clicking one sends it | chips are the model's, capped, and dismissed on the next send |
| G-01d free-text ask from ⌘K | typing a sentence in ⌘K offers "Ask the Architect: …" as the last result (the shared command palette's free-text row) | the row appears only with pairing on; runs `ask()` |
| G-01e suggestion receipt in the thread | **Decision to make in P7:** keep the review card in the rail (today), or add a chat-registry card (`chat/registry/CardHost`) that renders a one-line "Drew 5 changes → Review" in the thread and jumps to the rail. The card is a chat-owned registry entry, not a second renderer | whichever lands: one review surface, one resolve path |

**P8 — point & ask depth** (board 02)

| Gap | Scope | Witness |
|---|---|---|
| G-02a multi-select inline ask | the near-selection toolbar appears for a multi-selection (anchored to the selection bounds) with Ask + quick actions | toolbar shows for 2+ nodes; the chips carry every id |
| G-02b lasso quick actions | "Wrap in a group" (the existing group action) and "Extract as sub-chain" (asks the Architect to propose a `core.subWorkflow` split as a suggestion — never a direct write) and "Explain" | extract arrives as a suggestion, not an edit |
| G-02c inline result toast | a small inline ask whose suggestion is ≤ 3 config ops shows a keep/drop toast at the selection as well as the rail entry | both surfaces resolve the SAME op state (one resolve path) |
| G-02d drag canvas nodes into the composer | a node's header gains a drag handle using native DnD (`application/openwop-node-id`) alongside xyflow's pointer drag; dropping on the Pair panel cites it | the drop cites; xyflow drag still moves the node |
| G-02e hover "+" on edges | a custom xyflow edge renders "+" at the midpoint on hover/focus (keyboard reachable); it opens the existing ports-filtered drop picker plus one "from your words" AI row that may propose an edge condition instead of a node | picker inserts a node splitting the edge in one undo step; the AI row produces a suggestion |
| G-01f palette "Suggested here" | a short palette section listing catalog nodes whose input ports fit the selected node's outputs (deterministic port compatibility, no model call) | suggestions match `isPortCompatible` |

**P9 — first draft, repair and room depth** (boards 04, 05, 06)

| Gap | Scope | Witness |
|---|---|---|
| G-05a nodes land one by one | the builder-mode prompt drafts in batches (≤ 3 ops per `suggest-edits` call) that APPEND to the conversation's suggestion (new `mode: 'append'` on `suggest-edits`, same validation against head + prior ops); each batch refreshes and animates in (`--dur-enter`, reduced-motion safe) | three batches → one suggestion with all ops; ghosts appear per batch |
| G-05b "placing n of N" | the phase strip shows the running op count from the appended suggestion (N from an optional `plannedOps` on the first batch) | count equals ops received |
| G-05c chain templates in the empty state | the empty sheet offers 3 relevant chain templates from the gallery | chips link the real gallery entries |
| G-05d chain as ghost suggestion | a new server op source: expand a chain pack (`expandChain`) into `addNode`/`addEdge` ops against the empty draft and store it as a suggestion; keeping runs through the same keep path, then `from-chain` ownership is recorded for sub-chains | a kept chain equals the `from-chain` result for a single-level chain; nested chains follow ADR 0770 D3 |
| G-05e stop on the phase strip | "Stop" cancels the in-flight turn (the embed's cancel) | stop ends drafting; ops already appended stay reviewable |
| G-04b run digest card in the thread | Diagnose sends with a run chip AND renders the ADR 0764 digest headline as a quiet card above the prompt (read from the run, never from the model) | card text = the host digest |
| G-04c retry / debug in the failed-node toolbar | "Retry step" and "Debug session" reuse the existing debug-lane handlers | same handlers |
| G-04d fix ghost beside the failed node | a config fix on a failed node renders a small ghost "config diff" chip beside it (not only marks + Inspector) | shown only for ops on a node with `runStatus: failed` |
| G-06b room ghosts for peers | a room-shared suggestion renders read-only ghosts for peers (distinct outline, requester's name from the room view — added as `requesterName`, never the id); peers cannot keep or drop | peers see ghosts; no keep/drop controls; the view still carries no user or conversation id |

**P10 — prove it live and graduate**

| Item | Scope |
|---|---|
| G-10a live browser check | `/browser` on a deployed build with `builder-pair` ON for one workspace: every board 01–05 state, light + dark, keyboard-only pass |
| G-10b live Architect eval | a small eval set (add a branch, fix a failed run, first draft from intent, edit a gate — refused unless asked) run against the real Architect; pass rate recorded here |
| G-10c `WBWF-17` node lane | the meta-workflow `persist` node gains a read step and passes `baseRevision` (closes the last last-writer-wins lane) |
| G-10d collab per-keep flush | a keep inside a live room flushes the Y adapter immediately so one keep = one `Y.UndoManager` step |
| G-10e graduation | after dogfooding: toggle ON by default, delete `CreateWithAiPanel` + the drawer + its toolbar button in the same change |

> **The graduation bar — added 2026-10-01.** G-10b was "a precondition" with no
> number, so it could be neither met nor failed. G-10e may merge when BOTH hold
> on the model tier the ON default applies to (today: the managed free tier):
>
> 1. **Behaviour:** all six scripted cases in `docs/evals/builder-pair-architect.md`
>    pass in **2 of 3** runs on a quiet machine (load under ~10), scored against
>    the written criteria, not only the mechanical assertions. A case lost to a
>    provider network error or the harness is re-run, not counted either way.
> 2. **Cost:** one first draft (case 4) completes inside that tier's daily
>    allowance as configured in production.
>
> Measured against this bar on 2026-10-01: NOT met. Cases 2 and 4 passed in 0 of
> their measured runs, and a first draft cost 54–75k prompt tokens against a
> 50,000-token allowance. Production already runs the toggle ON for every tenant
> (operator choice, an override), so graduation now changes two things only: the
> default for fresh installs and white-label adopters, and the deletion of the
> Create-with-AI drawer, which is the fallback when the toggle is off.
>
> **What G-10e must also carry** (found when planning it): `CLAUDE.md` and ADR
> 0073 name `builder/CreateWithAiPanel` as the reference consumer of
> `EmbeddedChatPanel`; deleting the file needs both repointed to
> `builder/pair/PairPanel`. The prepared branch is 189 commits behind `main` and
> is to be REBUILT, not rebased.
>
> **Shipped the same day, independent of the bar:** a tool turn that hits the
> daily allowance now says so and offers the user's own key (it showed "Something
> went wrong · internal_error", and retried four seconds later against the same
> wall); the ADR 0796 follow-up round is logged so a live run can show whether it
> fires.
>
> **Plan B.2 — cheaper Architect turns (2026-10-03, architect-reviewed in
> options mode).** The fixed cost of every round was ~7.7k prompt tokens: a
> ~2.7k system prompt plus 17 tool schemas (~5.5k), nine of them the ADR 0315
> default-on baseline, which a Pair turn never uses. Two changes, both host-only:
>
> 1. **A paired conversation is offered four tools** (`read-canvas`,
>    `suggest-edits`, `draft`, `schema.lookup` — `features/builder-pair/pairToolScope.ts`).
>    The Pair context route writes them as the conversation's ADR 0132 capability
>    scope, intersected with any scope already set, so it only narrows and the
>    main chat keeps the full list. `persist` and `propose` go too: they write a
>    workflow without the ghost-layer review. `validate` is redundant because
>    `suggest-edits` validates closed-world and acyclic itself.
> 2. **`draft` returns only the withheld nodes relevant to the ask** (ADR 0791
>    correction).
>
> Implementing (1) found that the tool loop read the capability scope, tool
> approvals and the intent ledger under the run-derived conversation id, while
> everything that writes them uses the chat session id, so a scope set from the
> chat UI never applied (ADR 0132 correction). Fixed in the same change.
>
> **Estimate, NOT a measurement** (source sizes ÷ 4): about 3.6k fewer prompt
> tokens per round, putting a four-round first draft at ~35–37k (was 54k) and the
> worst measured five-round draft at ~51–53k (was 74.6k). So the typical draft
> fits the 50k allowance and the worst case may not. Only a G-10b eval run
> measures it. If a five-round draft is still over the cap, the next lever is
> trimming the persona prompt, behind an eval run. B.2 does not address the
> behaviour half of the bar (cases 2 and 4), except that a model choosing among
> four tools instead of seventeen has fewer wrong ones to reach for.

> **Plan B.3 — a stronger Architect model (2026-10-03).** Measured with BYOK
> `google/gemini-3.8-flash` (the user's choice) on B.2's four-tool Pair scope:
> cases 1, 3 and 8 pass; **2 and 4 fail the same way they did on MiniMax** —
> repeated `draft` catalog searches, no `suggest-edits`, and the 5-round tool
> limit ends the turn with no reply; 5 has no valid run (provider quota and
> overload). Details: `docs/evals/builder-pair-architect.md`. So B.3 does NOT
> clear the behaviour half of the bar by swapping the model; the turn's round
> budget and search-then-draw shape are the next thing to measure. Running the
> eval also exposed that a transient provider 503 ended a chat turn with no
> retry and no logged cause; fixed separately (#4360).

> **Plan B.5 — the turn, not the model (2026-10-04, architect options review).**
> After B.2 the managed tier scored 4/6 on a quiet machine (1, 3, 5, 8 pass; 2
> and 4 fail), with the first draft at 60.6k prompt tokens over 4 rounds —
> inside production's allowance (`OPENWOP_MANAGED_DAILY_TOKEN_CAP` is 20,000,000
> there; the 50,000 code default applies to fresh installs), so the COST half of
> the bar is met as written. Cases 2 and 4 end with "Let me search …" after
> repeated catalog searches; Gemini fails them the same way. Cause: the prompt
> told the model to search again with no bound, and the catalog has no node
> made for "dedupe leads" or "score a lead". Adopted: the search reports
> `noDedicatedMatch` with `generalBlocks`, and the prompt caps searches at two
> per kind of step (ADR 0791 correction). Rejected: raising the round limit
> (the loop has no end, and each round costs 5–7k), compact search hits (cost
> is not the blocker). Held: widening the ADR 0796 follow-up past a trailing
> colon, if runs still end on "Let me …" with no call. Measure: 3 quiet runs of
> all six cases on the managed tier; cases 2 and 4 must call `suggest-edits`
> with at most two searches per step kind.

> **B.5 measured, and B.6 (2026-10-04).** Three quiet runs on the managed
> tier after B.5: 3/5, 4/6, 4/6. The search loop is gone (6–8 catalog reads
> per run; case 2 draws an AI-classify step and passed once). Three narrower
> causes remain, each fixed in B.6: (1) B.5's hint said "fetch its schema with
> `typeIds`", which the model read as the `schema.lookup` tool — general blocks
> now carry their full schemas, as any search hit does; (2) `plannedOps` was set
> in 0 of 3 first drafts on a prompt rule alone — `suggest-edits` now refuses a
> first batch on an empty canvas without it (typed `invalid_ops`, repairable in
> the turn); (3) edge ops arrived with no `why` — the prompt now asks for one on
> every op. Agent pack 1.3.7.

> **B.6 measured, and B.7 (2026-10-04).** Three quiet managed-tier runs on
> `4292f287b`: 6/6, 6/6, 5/6 by the scripts, provider calls all clean, 5–6
> catalog reads per run. Scored against the WRITTEN criteria, cases 1, 2, 3 and
> 8 pass 3/3 and 5 passes 2/3, but case 4 passes 1/3: it planned 7 ops
> correctly and built from general blocks, yet drew 2 and stopped in two runs
> (one ending "Batch 2: the If branch." with no call). The server already knew
> the plan was unfinished, so B.7 keys the follow-up on that, not on the
> reply's wording: `suggest-edits` returns `drawn`/`planned` and, while drawn <
> planned, a host-internal `continueTurn` text on its tool result; the chat loop
> (`runChatToolLoop`) sends it as one follow-up when the model stops without a
> call, at most `MAX_CONTINUATIONS` (2) per turn, each granting
> `CONTINUATION_ROUNDS` (2) more rounds up to a hard cap. Core reads a generic
> field and imports no feature. Side finding: a finished first draft costs
> 44–50k prompt tokens, inside production's allowance but at the 50,000 code
> default fresh installs get (run 3 hit it right after finishing).

> **B.7 measured, and B.8 (2026-10-05).** One quiet managed-tier run on the
> deployed B.7 (`aa8e6160a`) scored 4/6: case 4 planned 7 ops and drew 3. B.7's
> follow-up fired once, the model answered it with "Drawing ops 3–5 now." and no
> call, and the second follow-up could not fire: sending a follow-up DISARMED it,
> and only a fresh tool result re-armed it, so `MAX_CONTINUATIONS = 2` was
> effectively 1 on exactly the failure B.7 targets. **B.8:** the follow-up stays
> armed until a tool reports the work moved on; `MAX_CONTINUATIONS` remains the
> bound (`host/agentDispatch.ts`, witness `unfinished-plan-followup.test.ts`,
> born red). Three quiet runs after B.8: **5/6, 6/6, 6/6 by the written
> criteria, so the BEHAVIOUR half of the bar is met.** Case 4 failed once (6 of 7
> drawn, both follow-ups spent); one of its passes drew an "else" edge into the
> CRM step, a semantic defect the written criteria do not catch. **Cost:** a
> first draft now costs 64–140k prompt tokens (the follow-up rounds add to the
> 44–50k B.6 measured). That is inside production's allowance (20,000,000), so
> the cost half is met AS WRITTEN, but it is over the 50,000 code default that
> fresh installs and white-label adopters get, which is exactly who the G-10e
> default flip reaches. Deciding that is a precondition of G-10e, not of B.8.

> **G-10e — graduation (2026-10-05).** The behaviour half of the bar is met
> (B.8 note above). The cost half is met as written for production, and the
> user decided the fresh-install gap: the managed tier's code default daily
> allowance goes from 50,000 to 150,000 tokens
> (`DEFAULT_MANAGED_DAILY_TOKEN_CAP`, `providers/managedProvider.ts`), which fits
> the largest measured first draft (140k) once a day; an operator value still
> wins. The user first chose 300,000, then re-decided on 150,000 once ADR 0821
> (merged the same day) made this cap the FREE allowance, spent before plan
> credits and paid balance and counted per acting subject: a fresh install that
> sells credits gives this much away per member per day. Trade-off accepted: on a
> cookie-per-visitor deploy it is per visitor, at most ~$0.05 per visitor per day
> at MiniMax-M3 prices, so the global ceiling stays the operator's spend backstop
> (WHITE-LABEL.md). Witness: `adr0773-managed-default-cap.test.ts`
> (sabotage-checked at 50k). The three
> G-10e commits from `feat/pair-canvas-graduation-v2` replayed cleanly onto
> `main` (286 commits on); #4348 is superseded by this change.

**Sequencing:** P6 first (it keeps stated promises and is all small); P7 and P8
are independent and can run in parallel branches; P9's append mode must land
before G-05a/b; P10 follows the merged P6–P9 on a deployed build. Each phase
lands as its own PR with its witnesses sabotage-checked.

## Architect review (pre-code, 2026-09-28) — folded in

Track A (host architecture), with Track B limited to confirming the RFC verdict.
Measured on `origin/main` `674970fbc`. Each finding is folded into the decision
text above. The table records what changed and why.

| # | Sev | Dimension | Finding | Disposition |
|---|---|---|---|---|
| A1 | **Blocker** | Replay / data integrity | The first draft claimed that a `:fork` re-serving `suggest-edits` is "deduped on `(conversationRunId, contentHash)`". False twice over: a fork **re-fires** tool calls (ADR 0764:56-57), and it runs under a **new** run id, so the key never matches. Every fork of a pairing conversation would have written an orphan suggestion. | D4: both tools require a pairing-context row for `scope.runId`. A fork has none, so both refuse with a typed `no_pairing_context` and write nothing. P2 witness. |
| A2 | **Blocker** | Coupling | D3 (flush-on-send) was unimplementable. `EmbeddedConversation` owns its submit (`chat/EmbeddedConversation.tsx:62-66`), so the builder has no hook before a send. Without one, "the AI reads what's on screen" is a false claim on the can-see strip. | A generic chat-owned `beforeSend` prop at the ONE embed submit choke, covering every send path. P1 witness: a path that bypasses it is red. |
| A3 | High | Performance | `GET suggestions?workflowId=&conversationRunId=` implied a `DurableCollection.list()`, a cross-tenant full scan on every turn settle and every tool return. | Keyed `${tenant}:${conversationRunId}`, one active suggestion per run (supersede), plus a per-workflow index row for room-shared suggestions. Every hot read is a point `get`, enforced by a source-scan ratchet. |
| A4 | High | Data integrity | `addNode` ids chosen by the model could collide with a peer's concurrent add, and keeping an edge whose ghost endpoint was dropped would leave a dangling edge that fails the next save's validation. | Server-minted `sg_*` ids. `dependsOn` per op. A dependency that was dropped makes the op `inapplicable`. |
| A5 | High | Authorization / cohesion | `requireWorkflowRead` does not exist, and `requireWorkflowWrite(req)` (`host/workflowWriteAuthority.ts:32`) is request-shaped, while tools have a scope, not a request. A builder-pair-local helper would be the second authority for "may write this workflow", and ADR 0770 P2 (`WBWF-17`) needs the same scope-shaped check for every AI lane. | A scope-shaped `canReadWorkflow`/`canWriteWorkflow` in `workflowWriteAuthority.ts`. `requireWorkflowWrite` becomes a wrapper, and routes and tools share it. |
| A6 | Medium | Pattern / UX | "A viewer sees no Pair tab" removed Explain and Diagnose from read-only users, which is a capability loss dressed as a fix for `WBUX-11`. | Viewers get Pair read-only: `read-canvas` works, `suggest-edits` is a typed `forbidden`, and the strip says so. |
| A7 | Medium | Performance / rate limit | A context PUT debounced on every selection change would spend the per-IP write budget (60/min, ADR 0640/0771) that autosave already uses. It is the exact "feature-rich page walls a single user" class ADR 0640 fixed. | Written only in `beforeSend`. Chips and strip are client-side. |
| A8 | Medium | Testability | A toggle-off 404 witness passes with the gate deleted, because "not found" and "disabled" both return 404 (the recorded lesson). | The P1 witness asserts 404 on a suggestion that returns 200 when the toggle is on, sabotage-checked by deleting the gate. |
| A9 | Low | Cohesion | Approval-gate typeIds are scattered literals (`host/workflowTemplates.ts:81`, `host/approverResolution.ts:281`, `features/campaign-orchestration/orchestrationWorkflow.ts:46`), and no host constant exists. | `APPROVAL_GATE_TYPE_IDS` is a new host constant. The ADR 0582 witness and `approverResolution` are named consumers. The other literals are not migrated here (not in scope, no behavior at stake). OQ4 still decides whether the catalog `role:"gate"` replaces it. |

**Boundaries.** No duplicate concept exists. There is no pairing, context, ghost
or preview model in `builder/` or `host/` (grep for
`surfaceContext|pageContext|canSee|hostContext|pairing|ghost|previewDefinition`:
no builder or chat hits). The two names that would collide ("proposal") are
avoided. The only host edit is the authority predicate, which this ADR makes
reusable rather than forked.

**Track B — RFC verdict confirmed: additive host extension, no wire change.**
Routes are under `/v1/host/openwop-app/builder-pair/*`. The tool ids use the
host-local `openwop:feature.*` tool namespace, which is not a protocol surface.
The three chat props are client-only. The conversation-turn body, `agent.*`
events, envelopes and `/.well-known/openwop` are untouched, and pairing context
travels in a separate host route, never in the turn. Nothing new is advertised.

| Category | Status | Issues |
|---|---|---|
| Boundaries & Duplication | Pass | 0 |
| Security & Authorization | Pass after fold | 2 (A5, A6) |
| Data Integrity & Failure Modes | Pass after fold | 2 (A1, A4) |
| Coupling & Cohesion | Pass after fold | 2 (A2, A9) |
| Performance & Scale | Pass after fold | 2 (A3, A7) |
| Error Handling | Pass | 0 (every refusal is typed: `no_pairing_context`, `forbidden`, `feature_disabled`, `workflow_head_moved`, per-op invalid) |
| Pattern Compliance | Pass | 0 |
| Testability | Pass after fold | 1 (A8) |
| Wire / Capability / Replay (Track B) | Pass | 0 |

**Top 3 priorities before code:** (1) witness that `scope.runId` is the
conversation run (OQ1), because the A1 fork guard and the context key both rest
on it; (2) land the `beforeSend` seam with its every-path witness first, because
D3 and the can-see honesty depend on it; (3) land the scope-shaped authority
predicate as its own reviewed change, because ADR 0770 P2 will reuse it.

## Implementation record (2026-09-28)

Branch `docs/adr-pair-canvas`. Toggle `builder-pair` ships **OFF**; with it off
the builder is byte-for-byte today's (the drawer, the toolbar button, the
Inspector rail).

| Phase | Shipped | Witness |
|---|---|---|
| P1 context | `features/builder-pair/` (feature, routes, stores, service), `canReadWorkflow`/`canWriteWorkflow` as `hasWorkflowScope` + `requireWorkflowRead` in `host/workflowWriteAuthority.ts`; `read-canvas`; chat embed props `beforeSend` / `onConversationId` / `onToolActivity` / `prompt`; `builder/pair/PairRail` (Pair · Inspect, both panels stay mounted), `PairPanel` (can-see strip, chips, `+ node` cite picker, palette drop), `QuickAsk` | `adr0773-builder-pair.test.ts` (route gate distinguishes disabled from missing — **sabotage-checked** by deleting the gate; ids dropped closed-world; viewer pairs read-only; `read-canvas` fresh revision; typed `no_pairing_context` / `acting_user_required`) |
| P2 suggestions | `editOps.ts` (closed op kinds, server-minted `sg_*`/`sge_*` ids, forward refs, `dependsOn`, preimages, `gateSensitive`, raw-index errors), `suggest-edits`, suggestion store (one per conversation, supersede, room index, 1-day age-out + read-time 24 h, `eraseBuilderPairSubject`), GET/PATCH; `APPROVAL_GATE_TYPE_IDS`; D8 `persist` CAS; frontend `suggestionModel.ts`, `pairStore.ts`, `builderStore.applyEditOps` (ONE undo entry), ghost nodes/edges, `SuggestionInstrument`, `SuggestionReview`, Inspector `SuggestionDiffCard`; Architect pack 1.2.0 + builder-mode prompt; steward manifest regenerated | `editOps.test.ts` (5), `adr0773-builder-pair.test.ts` (suggest never writes the head; moved head; per-op invalid; cycle; viewer forbidden; **replay fork refused — sabotage-checked**; keep/drop requester-only; room read-only), D8 persist (**sabotage-checked**); `pairSuggestionModel.test.ts` (stale per op, inapplicable, dependency order, projection, auto-keep narrowness) |
| P3 point & ask | near-selection toolbar on the one selected node (Ask · Explain), `⌘.`, `FillWithAi` per config field, `EdgeAsk` in the edge inspector, palette "Describe it to the Architect", auto-keep preference (config/rename on the selection, never gate-sensitive, never structural) | `pairSuggestionModel.test.ts` › auto-keep |
| P4 run & repair | Diagnose on a failed node (toolbar) → `lastRunId` → `read-canvas` returns the ADR 0764 digest; keep → re-run through the existing Run / debug lanes | `adr0773-builder-pair.test.ts` › `lastRunId` validated on write |
| P5 first draft | `FirstDraft` on an empty workflow with a phase strip driven by `onToolActivity` (never a timer); the ADR 0137 seed goes to the Pair thread; room sharing (`visibility:'room'`, peers read-only) | — |

**Deviations from the decision text, each forced by the code:**

- **The pairing key is the chat SESSION id, not the conversation run id (OQ1,
  resolved).** An embed opens its conversation run on the first SEND, so on the
  first turn `beforeSend` has no run id to key by. The tool scope carries the
  session as `conversationId` (threaded from `run.metadata.chatSessionId`,
  ADR 0309 — never a tool input). Because a `:fork` COPIES that metadata
  (`routes/runs.ts:1828`), the fork guard (A1) is now the ambient replay
  context: `suggest-edits` refuses when `currentEffectContext()?.replaying` —
  the same backstop ADR 0764 D3's run-start guard rides. Witnessed.

  > **CORRECTED 2026-09-29 (independent review CR-4) — that guard was a NO-OP in
  > production and "Witnessed" was false.** The chat tool loop runs from
  > `routes/interrupts.ts` → `handleConversationResolve` →
  > `runConversationAgentToolTurn`, and nothing on that path establishes an
  > effect context (only the executor, compensation, the pack broker and the
  > retry seam call `runWithEffectContext`). The test built the context by hand,
  > so it proved the branch, not the wiring — the mechanism-vs-wiring lesson.
  > **The fork guard is now the RUN BINDING:** the pairing row carries
  > `boundRunId` (sent by the client when it holds its run, else bound by the
  > first tool call of the live run), and both tools refuse a `scope.runId` that
  > differs. A fork copies `chatSessionId` but runs under a new run id, so it
  > reads and writes nothing. The replay-context check stays as a belt. Witness:
  > the live run binds, a "fork" (same session, different run) is refused on
  > read AND write — sabotage-checked by deleting the mismatch refusal.
  > Also corrected: the session id is CLIENT-supplied, not "never a tool input"
  > in any sense that makes it unforgeable — so the suggestion is keyed by the
  > ACTING USER as well (CR-3 below).
- **`persist` requires `baseRevision` on the chat-tool lane only.** The
  meta-workflow's `persist` NODE (the `ctx.features['workflow-author']` surface)
  has no read step to learn a revision from; forcing it would break that lane.
  A supplied revision is CAS-checked on every lane. **`WBWF-17` stays open for
  the node lane** — recorded, not closed.

  > **CLOSED 2026-09-29 (G-10c).** The node lane is now CREATE-ONLY: the
  > surface passes `requireBaseRevision: true`, so the meta-workflow (which has
  > no read step) can author new workflows but an overwrite without the
  > revision a caller read is a typed `base_revision_required`. The two
  > write-integrity tests that pinned node-lane overwrite now pin the refusal
  > and witness the disclosure relay through a revision-carrying surface call.
- **`suggest-edits` is `contentTrust: 'untrusted'`.** Its op summaries echo node
  names read from the stored, user-authored definition; the RFC 0137 §F1
  trusted-set pin caught it.
- **Drag-to-cite covers palette items; canvas nodes are cited with the `+ node`
  picker.** xyflow node drags are pointer gestures, not HTML5 DnD, so a canvas
  node cannot be dropped on the composer without a second drag system.
- **Edge "+": the point-and-ask lives in the edge inspector** ("Ask about this
  connection") rather than as a hover "+" on the edge; the hover affordance
  (and the ports-filtered picker beside it) remains the deferred
  `UX_UPGRADE-workflows-builder.md` item.
- **Review keys are ⌘⏎ keep / ⌘⌫ drop / ⇧⌘⏎ keep all** (J/K step). Bare ⏎/⌫
  collide with the keyboard-connect path and xyflow's node delete.
- **Independent review corrections (2026-09-29).** A fresh-eyes review of the
  branch found nine defects the self-review had passed; all fixed, each with a
  witness:

  | # | Sev | Defect | Fix |
  |---|---|---|---|
  | CR-1 | High | The empty-sheet first draft could never send: an empty workflow cannot save (the serializer refuses it), so `beforeSend` blocked and the context PUT 404'd | An unregistered workflow id pairs as an EMPTY draft (revision `absent`); an id that exists but is foreign is still a 404. `beforeSend` does not block an empty canvas on a failed save |
  | CR-2 | High | A suggestion about workflow A could be kept into workflow B after a switch (`refresh` and `keep` did not check `workflowId`) | Every read/write path goes through `current()`; sabotage-checked |
  | CR-3 | Medium | The client-supplied session id let one member overwrite another's suggestion; the room listing exposed `conversationId` + `requestedBy` | Suggestions keyed `(tenant, user, conversation)`; GET/PATCH are the caller's own; the room listing is a sanitized view |
  | CR-4 | Medium | The replay guard was a no-op on the chat path | The run binding (above) |
  | CR-5 | Medium | An edit to a node the suggestion adds read as `stale` and keep-all skipped it | Preimages on dependency-minted nodes are not checkable until the dependency lands |
  | CR-6 | Low | `null` cleared a config value in the builder but was stored on the server | `null` clears on both sides |
  | CR-7 | Low | An op the builder could not apply (unknown typeId, missing endpoint) was still marked kept; a model-named port could name no handle | `applyEditOps` returns per-op `applied`; only landed ops are kept; unknown ports fall back to the node's real port |
  | CR-8 | Low | Several `QuickAsk`s shared one input id | `useId()` |
  | CR-9 | Low | ⌘. was documented as working from a text field; the registry skips text contexts | Comment corrected |

- **Not yet built — now scheduled in the Gap-closure plan (P6–P10) above:** a chain template opened as a ghost suggestion (the gallery
  lives on `/builder`, and turning a chain expansion into ops is its own piece of
  work); per-keep flushing of the collab adapter (a keep inside a live room
  follows the adapter's 300 ms debounce, so two quick keeps can share one
  `Y.UndoManager` step); **graduation** — toggle ON by default and deleting
  `CreateWithAiPanel` — which should follow dogfooding, not ship with the
  feature.

### Gap closure (P6–P10) — implementation record (2026-09-29)

Every `G-nn` row of the gap-closure plan, as built. Frontend witnesses live in
`builder/__tests__/pairGapClosure.test.ts` (narration never narrates a keep and
the auto-keep undo toast are both **sabotage-checked**); backend witnesses in
`test/adr0773-builder-pair.test.ts` › "P7/P9".

| Gap | Built | Notes |
|---|---|---|
| G-03a | `toast.withAction` (additive `ui/toast` action) + Undo that pops exactly that keep and returns the ops to pending; refuses if anything was edited since | sabotage-checked |
| G-04a | "Keep and re-run from here" (review footer, after a Diagnose): keep all → flush + drain the write queue → `runFromNode(failedNode, 'from-here')`; a failed save starts no run | |
| G-06a | `pair/narrate.ts`: debounced, coalesced "You …" lines; kept suggestions move the baseline silently (a keep landing mid-debounce settles the manual edits against the PRE-keep state); moves ignored | sabotage-checked |
| G-01a | `PairStatus` in a new additive `statusExtra` slot of `CanvasSurfaceShell` | |
| G-01b | "Run from here" in the node toolbar (the Inspector's `runFromNode`) | |
| G-03b | dropped adds stay as faint ghosts; Restore on the ghost and in the review | |
| G-03c | per-op segments on the instrument, colour + the words in the list | |
| G-03d | optional `why` per op (≤ 280, rendered as text) in the review row and the Inspector diff | |
| G-03e | "Edit before keeping" field in the Inspector diff; keeps the edited value as one undo step | |
| G-03f | "Use the AI's" on a stale VALUE op, behind `ui/confirm`; structural ops are never forceable | |
| G-03g | the revisions list gains `createdByName` (host-extension, additive, fail-soft); the stale explanation names the head's author, else says "someone" | |
| G-01c | `followUps` (≤ 3) on `suggest-edits`; rendered as chips that send | |
| G-01d | additive query-driven command sources in `ui/commandContributions` + the palette; the builder registers "Ask the Architect: …" | |
| G-01e | **Decision: the review stays in the rail.** A chat-registry card would be a second review surface beside the rail and the Inspector diff; the turn's receipt already names the `suggest-edits` call, and the Pair tab badge carries the pending count. Recorded, not built | |
| G-02a/b | `SelectionToolbar` (xyflow `NodeToolbar` over the selection): Ask, **Label as group**, Extract as sub-chain (a suggestion to review), Explain | **Deviation:** the builder has no group primitive, so "Wrap in a group" became "Label as group" — a client-only sticky note placed above the selection, one undo step |
| G-02c | a small inline ask's result (≤ 3 value ops) also shows a toast with **Keep**; Drop stays in the rail | **Deviation:** a toast carries ONE action, so the toast offers Keep only |
| G-02d | a cite handle on every node (native DnD, `nodrag`); dropping it on the Pair panel cites the node | |
| G-02e | `PairEdge`: "+" at the midpoint on hover/selection → ports-filtered steps (insert = remove + add + 2 edges as ONE `applyEditOps` undo step) + a scoped inline ask; says how many more fit | |
| G-01f | `PaletteSuggestions`: up to 4 port-compatible steps after the selected node (deterministic), added connected | |
| G-05a/b | `mode: 'append'` + `plannedOps` on `suggest-edits` (ids continue, cross-batch `dependsOn`, validated against head + prior ops); the store merges an append keeping local decisions and animates the new ghosts in (reduced-motion safe); "placing n of N" | |
| G-05c/d | three input-free templates on the empty sheet → `POST …/builder-pair/suggestions/from-chain` expands the chain into ops (carrying `inputs` + `triggerRule`) against the EMPTY draft; nothing is registered until kept | **Deviations:** chains with sub-chains are refused (the gallery's `from-chain` owns ADR 0770 D3 co-registration); chains with REQUIRED params are refused rather than drawn with blanks (a missing param freezes to `''` — the ADR 0507 fabrication class) |
| G-05e | Stop on the progress strip → an additive `stopSignal` embed prop → the composer's own cancel | |
| G-04b | a quiet digest card (failed node + its recorded error, from the run overlay the builder holds — never from the model) | |
| G-04c | Retry step (`runFromNode 'only'`) + Debug session (the shell's `onDebugFromOverlayRun`, via a store request) in the failed node's toolbar | |
| G-04d | "n fixes ready" chip beside a failed node with pending ops | |
| G-06b | the room listing adds `requesterName` (display name, never the id) + `ghostOps`; peers see read-only ghosts (distinct outline, "Suggested by …") and no keep/drop | |
| G-10a | **Functional half implemented as a merge-gate ratchet** — `frontend/react/e2e/pair-canvas.spec.ts` (Playwright, runs in `npm run ci`, model-free): toggle OFF leaves the builder unchanged (Create with AI present, no Pair tab); ON shows Pair · Inspect, hides the drawer, offers Ask on a selected node; on an EMPTY sheet a template draws ghosts, Keep all lands them, one Undo removes them. **It found a real defect on its first run:** with no AI provider the Pair chat shows its provider gate and never mints a conversation id, so the model-free template lane failed with “Couldn’t draw …”. Fixed: the template lane addresses its suggestion by its own per-workflow id (`templateConversationId`) when no chat conversation exists; witnessed by the e2e case (born red) and `pairGapClosure.test.ts` (sabotage-checked). **Keyboard half:** two more e2e cases drive keep (⌘⏎), undo (⌘Z) and drop (⌘⌫) with no mouse. Disabling the ⌘⏎ shortcut turns only the keep case red. J/K stepping stays covered by the store tests, because both fixture templates draw a single step. **Visual half (local build, light + dark, 1440×900):** found and fixed four defects the functional cases could not see: (1) the review row named an added template step by its raw typeId; it now uses the palette label the ghost card shows (`opSummary`); (2) the review footer's checkbox labels inherited the mono-uppercase caption register, and Drop all wrapped onto the share line; they now read as sentences, with the actions on their own row; (3) the top suggestion toolbar let Keep all wrap to two lines; its buttons no longer shrink; (4) the first fit onto a single ghost zoomed to the 2× ceiling; it is now capped at 1×. **Deployed-build pass DONE 2026-10-01** on app.openwop.dev at `b1fa6f656`, 1440×900, as an anonymous visitor (the toggle is ON for every tenant in production, by the operator's choice; graduation G-10e — the default flip and the drawer's deletion — is still not merged). Passed: Pair · Inspect opening on Inspect, the pending badge, a two-step template drawing numbered ghosts, Keep all then ONE Undo, keyboard-only ⌘⏎ / ⌘Z / ⌘⌫ after activating a template with Enter, ⌘. opening Ask on a selected step, and dark mode (switched with the real control; no contrast defect). **It found five defects the single-step e2e fixtures cannot reach, all fixed in the same change:** (1) a suggested connection between two ghost steps was listed in the review and NOT drawn: the ghost card has one unnamed handle per side and the edge named a port (`ghostEdgeHandles`); (2) its review row read `Connect sg_b0ebd1c33f_1 → sg_b0e…` — step names now replace generated ids (`opSummary`); (3) the status bar read "1 steps · 1 connections" (plural keys in all four locales); (4) the suggestion bar's text was squeezed to "Archite…" and sat on the canvas hint chip (it wraps to its own row and sits below the chip); (5) a kept step landed 30px under its source (gap 140 → 180). Verified again in a local build of the fix. Not covered: anything that needs a model, and widths below 1440. | `e2e/pair-canvas.spec.ts` · `pairGapClosure.test.ts` G-10a |
| G-10b | **RUN 2026-09-30 on the managed tier (`openwop-free` = MiniMax-M3), the model every workspace gets by default: 2/6 scripted cases pass (33%) — BELOW the bar for graduation.** Details and per-case notes: `docs/evals/builder-pair-architect.md`. The first run found three defects, all fixed in the same change: (1) the managed tool round never split MiniMax's inline `<think>` reasoning, so a 17k-char chain-of-thought reached the chat as the answer (every managed-tier tool chat, not only Pair); (2) the round's 4096-token default ended a reasoning model's turn mid-thought, with no tool call; (3) the prompt told the Architect how to behave "in the builder" but gave it no way to know it was — it now calls `read-canvas` first on any change request (agent pack 1.3.2). What is left is MODEL behaviour plus one UI defect: clarifying questions instead of drawing (2), distrusting its own untrusted-fenced `read-canvas` result (5), a whole-graph rewrite on "make it better" (8), and the empty-sheet draft running without the Pair chat rendering the turn (4). **G-10e is therefore NOT cleared** on the default model. **Re-run 2026-10-01 on `8c5dbd16f`: 4/6 (67%)** after the prompt-gating fix (#4293), the scoped catalog read and three prompt rules (#4294, ADR 0791). Cases 1, 3, 5 and 8 pass; the empty-sheet turn now renders. Cases 2 and 4 still fail the same way: the Architect announces the draw and the turn ends with no `suggest-edits` call. The cause is not diagnosed (no per-round finish reason is logged). First draft from an empty sheet is one of the two, so G-10e stays NOT cleared. **Four further runs the same day** (per-round outcome log, a "call first" prompt rule, catalog search default 5, the ADR 0796 follow-up round) did not change that: cases 2 and 4 never passed, with a different failure shape each time, and a first draft costs 54–75k prompt tokens against the managed tier's 50,000-token daily cap. Two things therefore block G-10e on the default model: multi-step turns are unreliable on MiniMax-M3, and the free-tier cap is smaller than one first draft. Neither is a Pair Canvas defect that another prompt edit closes. **A second run (same day) was invalid** (load 86; a case hit the managed daily cap) but exposed the dominant cost: `workflow-author.nodes.draft` returns the WHOLE node catalog, ~220k tokens (882 KB), compaction-exempt by design, so ONE catalog read exceeds the managed tier's 50k daily cap and costs ~$0.60 per read on a paid model. Until the catalog read is scoped (a query/typeId filter, so a turn reads only the node types it needs), Pair is not viable on the free tier regardless of model quality. Also fixed that day: an embed `prompt` sent before the agent catalog loaded went out as plain chat with no tools (the empty-sheet "Draft it" reached the model with `tools=0`). | `docs/evals/builder-pair-architect.md` · `minimax-tools-round.test.ts` (think split + budget, sabotage-checked) |
| G-10c | node lane create-only (`requireBaseRevision: true` on the surface) | tests updated to pin the refusal |
| G-10d | `setActiveCollabFlush` — the adapter registers its graph flush; `applyEditOps` flushes it at once in a live room | |
| G-10e | **Rebuilt on `main` 2026-10-03 as branch `feat/pair-canvas-graduation-v2`** (the original branch was 229 commits behind; both commits cherry-picked cleanly, and the remaining live pointers to `CreateWithAiPanel` — CLAUDE.md, ADR 0073, the grade-ai-exchange skill, two code comments and a backend test's comments — now name `builder/pair/PairPanel`). Merge it ONLY when the graduation bar above is met. **Originally done on branch `docs/adr-pair-canvas-graduation`** (that commit: `builder-pair` default ON; `CreateWithAiPanel`, its drawer, toolbar button, CSS and its two handoff tests deleted; the ADR 0137 work-graph seed goes to the Pair thread). Merge it ONLY after G-10a + G-10b pass. **Previously:** prepared on branch `docs/adr-pair-canvas-graduation` (toggle default ON + `CreateWithAiPanel`/drawer/toolbar button deleted) — deliberately NOT in this PR, so merging it does not flip every workspace before G-10a/G-10b | |

### Canvas parity (P11) — added and implemented 2026-09-29

A second gap analysis against the design canvas (boards 00–08, re-read at its
newest version) after P6–P10 found ten remaining details. **One was a wrong
claim of mine:** "the composer is docked in both tabs" was already built
(`PairRail.tsx` docks `QuickAsk` under the Inspector); I had grepped
`Inspector.tsx` only. The other nine:

| Item | Canvas | Built | Witness |
|---|---|---|---|
| P11-1 Esc hides the review | board 03 keys | `closeReview()`; the instrument hides, the changes stay drawn, J/K brings it back; gated like the other review verbs | e2e "Esc hides the review" (sabotage: removing the hide reddens only it) · `pairP11.test.ts` · `shortcutScope` 17→18 |
| P11-2 J/K pans the sheet | board 03 keys | the canvas centres the focused change's node (a ghost shares its op's node id), zoom unchanged, instant under reduced motion | not browser-witnessed: both fixture templates draw one step |
| P11-3 stepping flips to Inspect | board 03 | stepping onto a VALUE change on an existing node selects it and flips to Inspect, where the diff card already highlights the focused op; structural changes stay in Pair | `pairP11.test.ts` |
| P11-5 Fit to suggestion | boards 01, 07 | an additive `extraFit` entry on the shared `ZoomCluster` menu, present only while changes wait; fits every pending change, never past 1× | e2e "Fit to suggestion only while changes wait" |
| P11-6 cite a run step | boards 02, 07 | a cite button on each run-drawer row: drag it onto the Pair panel, or click (the keyboard path); cites the node AND attaches the run (the existing run chip) | `pairP11.test.ts` |
| P11-7 ⌘. inline at the selection | board 02 | with a node (or a multi-selection) selected and focus on the canvas, ⌘. opens the inline prompt at the selection; otherwise it focuses the rail composer as before | e2e "⌘. … opens the prompt at that node" (sabotage: removing the branch reddens only it) |
| P11-8 freshness line | boards 01, 04 | "Applies to the sheet as it is now" / "n changes are out of date", derived from the same per-change check the keep path uses — never from the revision number (a keep moves the revision without making anything stale) | rendered in the review card |
| P11-9 status counts | board 01 | "n steps · m connections · selected: X", then the pending count, J/K and Esc hints | e2e "status edge counts the sheet" |
| P11-10 template sizes | board 05 | chips show "· n steps · k approvals" (an additive `nodeCount` beside `approvalGateCount` on the chain requirements, host-extension, fail-soft on an older backend) and a "Browse all templates" link | e2e "template chips say their size" |

**Still deliberately different from the canvas:** the review keys keep their
modifiers (⌘⏎/⌘⌫/⇧⌘⏎: bare ⏎/⌫ already edit and delete on the canvas); "Wrap in
a group" is "Label as group" (no group primitive); the node is cited by a handle,
not by dragging the node itself (xyflow owns that drag); the inline result toast
offers Keep only (a toast carries one action); templates that need inputs stay
off the empty sheet (they would draw blanks — "Browse all" reaches them); the
phase strip has no separate "Validate" step, because validation is inside
`suggest-edits` and emits no event of its own (the honest-receipts rule forbids a
timer-driven phase); edges are not draggable into the composer. The failed-node
fix stays a "n fixes ready" chip rather than a drawn config-diff card; the diff
itself is in the Inspector.

## Corrections the audit forced on the design canvas

- "Proposal" → **`WorkflowEditSuggestion`**. Two lanes already own that word (ADR
  0473, RFC 0096). Canvas copy may keep "proposal" as a user-facing word; code,
  routes and tools must not use it.
- **Decision 2 (bypass auto-keep) → a builder preference.** The chat permission
  mode is not observable to tools or to the builder.
- **Decision 3 (fetch on tool return) needs a chat seam.** Tool events reach the
  client but not the embed consumer. D1 adds the generic `onToolActivity`, which
  is a trigger, never a payload.
- **Context rides a tool read, not the turn.** The embed has no turn-context seam,
  and adding one would be client-asserted.
- **Workflow-level edits are out of v1.** Undo covers only nodes and edges.

## Open questions

- [x] **OQ1 (resolved — see Implementation record):** keyed by the chat session id instead. Original question: is `scope.runId` the conversation run for every Architect tool call,
  including a turn after "Continue in full chat" promotion (ADR 0768 P4)? P1
  must witness it. If not, key by `(tenant, actingUser, workflowId)` with
  last-focus-wins, and state that in the strip.
- [ ] **OQ2:** should suggestion TTL (24 h) survive a "Continue in full chat"
  promotion, so that a suggestion drafted in full chat can be opened on the canvas
  later? Proposed: yes, while its `workflowId` exists.
- [ ] **OQ3:** widening `pushHistory` to workflow-level fields (it is BLD-7-adjacent,
  ADR 0770 P4) would unlock `setInputSchema` ops. Out of scope here. Revisit after
  ADR 0770 P4.
- [ ] **OQ4:** should `APPROVAL_GATE_TYPE_IDS` move into the node catalog as
  `role: "gate"` for host nodes (`nodeRoleMap` gap), instead of a host constant?
  The constant is chosen for P2 because it is testable today.
- [ ] **OQ5:** where the drawer (`aiOpen`) state and ADR 0137 hand-off seeds
  (`workGraphSeed`) land in P5: proposed to seed the empty-sheet composer.
