# Assistant / Chief of Staff (unit A1) — chat-first port review

Scope: `backend/typescript/src/features/{assistant,agent-knowledge}` +
`frontend/react/src/features/{assistant,agent-knowledge}`, plus the two packs
`packs/feature.assistant.{agents,nodes}` and the host wiring they depend on.
Read-only audit. Judged against the app's real primitives (the ONE chat, agent
packs + `registerFeatureAgentTool`, `startWorkflowRun` + the node catalog, the
shared approvals/HITL + reviews inbox, the single owners).

## Headline

The assistant's **substrate rides the engine correctly** — the perception loops
are real scheduled workflows, the memory graph is a legitimately-owned store,
action execution rides `runStarter`, approvals ride the shared CAS, and
agent-knowledge composes the KB/memory/profile owners with no parallel store.
But the feature's **three agent personas are toothless in the ONE chat**: every
assistant-*owned* action tool in their allowlists
(`enqueue-action`, `upsert-commitment`, `populate-board`, `compose-briefing`,
`prioritize`) is a declared **node typeId that is never projected into a chat
tool**, so `resolveTool` drops it and the agents run read-only. The
anti-phantom lint passes (it accepts node typeIds) while the chat agent
silently loses all agency. Separately, the `email.send` / `calendar.*` action
kinds have **no live igniter at all** — the only thing feeding the
otherwise-excellent approval/execution pipeline is *another* feature
(service-desk).

## Contract scouting (pinned)

**The chat-tool universe is a fixed BUILTINS map + feature-registered tools —
node typeIds are NOT auto-projected.**
`host/agentToolProvider.ts:413-422` builds `BUILTINS` from exactly:
`knowledge.search`, `schema.lookup`, `web.research`, `http.fetch`, `code-exec`,
`kanban.add-todo`, the two `core.rag.retriever-*` ids, and
`PROJECTABLE_COMPUTE_NODE_TYPE_IDS` (`agentToolProvider.ts:45-48` — only
`insights-suite` *pure compute* nodes). `resolveTool` is literally
`BUILTINS.get(name)?.def` (`agentToolProvider.ts:505`), and the chat loop
compiles tools via `compileAgentTools(agent, builtinAgentToolIds(),
toolProvider.resolveTool, effectiveToolAllowlist(...))`
(`host/conversationToolLoop.ts:304`). An allowlist id that is neither a builtin
nor registered via `registerFeatureAgentTool` resolves to nothing and is
filtered out.

**The assistant feature registers ZERO chat tools.**
`grep registerFeatureAgentTool features/assistant/` → no hits; there is **no
`features/assistant/agentTools.ts`**. So none of `feature.assistant.nodes.*`
are chat-callable.

**Chief-of-Staff allowlist, resolved at chat time**
(`packs/feature.assistant.agents/pack.json`, `toolAllowlist`):
- Resolves (READ tools, ADR 0308 `registerFeatureAgentTool`, fail-EMPTY without
  acting user): `schema.lookup`, `goals.list`, `projects.list`,
  `proposals.list`, `tasks.deck`, `conversations.search`,
  `documents.get`/`list-templates`, `media.list`, `channels.list`,
  `creative-briefs.list`, `intent-ledger.get`, `cdp.identity.resolve`,
  `bi.list-metrics`/`bi.run-metric` (each verified to a `features/*/agentTools.ts`).
- **Does NOT resolve (silently dropped):** `feature.assistant.nodes.upsert-commitment`,
  `feature.assistant.nodes.populate-board`, `feature.assistant.nodes.prioritize`,
  `feature.assistant.nodes.compose-briefing`, `feature.assistant.nodes.enqueue-action`,
  `feature.kb.nodes.rag` (the builtin RAG ids are `core.rag.retriever-*`, a
  different id), `feature.priority-matrix.nodes.*`, `feature.strategy.nodes.*`
  (neither feature calls `registerFeatureAgentTool`), and the
  `core.openwop.mcp.*` / `openapi-call` ids. **Every assistant-owned ACTION is
  unreachable in chat.**

**Extractor** allowlist = `[feature.kb.nodes.rag,
feature.assistant.nodes.upsert-commitment]` → **both unresolved → zero chat
tools.** **Drafter** allowlist = `[feature.assistant.nodes.enqueue-action]` →
**unresolved → zero chat tools.** Both hit the "no resolvable tools" fallback
(`conversationToolLoop.ts:22-27,255`) and can act on nothing.

**Why the tripwire misses this.** `test/agent-prompt-tool-ids.test.ts:30-37`
adds **every pack-declared node typeId** to the "universe," so
`feature.assistant.nodes.enqueue-action` counts as resolved *because it is a
real node* — the test proves the id is not a typo, not that the agent can call
it. This is a genuine coverage hole (a filed TODO below), not an assistant bug
alone.

**The graph IS maintained — by scheduled workflows, not the agents.** The loops
(`loops.ts:40-113`) are real `WorkflowDefinition`s of existing nodes
(`core.openwop.http.fetch` + `feature.assistant.nodes.ingest-commitments` /
`compose-briefing`); `enableLoop` registers a real RFC-0052 scheduler job
carrying the agent's rosterId + `configurable.connections:['google']` + D2
`actingUserId` (`loops.ts:145-183`). Igniter = the scheduler. Graph writes go
through `ctx.features.assistant` (`surface.ts:84-228`). RIDES.

**The action pipeline is well-built but under-fed.** Enqueue creates the typed
`PendingAction` + a `PendingApproval` on the shared queue + the inbox
notification, resolved through the SAME CAS-guarded `resolveApproval` shared
with core `/approvals/:id/{claim,reject}` (`actionApproval.ts:55-161`); the
`/pending-actions/:id/{approve,reject}` routes call `decideActionViaApproval`
(`routes.ts:241-272`). Execution is `startWorkflowRun` under the approver's
identity with a terminal projection (`actionExecution.ts:95-208`). The ONLY
production enqueuer is **service-desk's** agent tool
(`features/service-desk/agentTools.ts:80-81`, kind `servicedesk.reply`). The
`email.send` / `calendar.invite` / `calendar.reschedule` kinds are enqueued
only by `surface.enqueueAction` (`surface.ts:150-167`), which runs only inside
the `enqueue-action` node — and **no registered workflow and no chat tool ever
runs that node**, so those kinds have no igniter.

**Interface already correct.** The assistant is driven through the ONE chat: a
`type:'workspace'` conversation whose participant is the assistant-capability
agent (`routes.ts:94-142`), opened via `openWorkspaceConversation`
(`client/chatSessionsClient.ts:236`, `chat/hooks/useChatSessions.ts:253`). No
bespoke "talk to AI" panel exists — the standalone `/assistant` page was already
removed (`feature.ts:64-69`, `assistantClient.ts:1-19`).

**Capability-not-named is honored in the backend, violated in one UI gate.**
Resolution is pure-capability, never `roleKey` (`capability.ts:25,47-93`). But
the workspace UI still gates the loops/health panels on
`entry.roleKey === 'chief-of-staff'` (`agents/AgentWorkspacePage.tsx:412`,
`agents/RecurringTasksPanel.tsx:10`, `agents/AgentHealthPanel.tsx:11`) — a
second holder of the `assistant` capability would show no loops. Minor drift,
noted.

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Open/resume the workspace conversation with the assistant | `type:'workspace'` chat routed to the capability agent (`routes.ts:94-142`) | **RIDES** | Leave |
| Chief-of-Staff drives the graph / drafts / briefs *in chat* | Agent whose action tools are declared node typeIds that don't project to chat tools (`pack.json` allowlist vs `agentToolProvider.ts:413-422,505`) | **THEATER** | Project the 5 assistant nodes as `registerFeatureAgentTool` action tools sharing the routes' predicate |
| Extractor agent (extract commitments from a source) *in chat* | Allowlist `[kb.rag, upsert-commitment]` → both unresolved → zero tools | **THEATER** | Same projection (`upsert-commitment` + a real RAG-read tool) |
| Drafter agent (draft reply for approval) *in chat* | Allowlist `[enqueue-action]` → unresolved → zero tools | **THEATER** | Project `enqueue-action` as an action tool → feeds the existing approval loop |
| `email.send` / `calendar.*` action ignition | No workflow and no chat tool runs `enqueue-action` (`surface.ts:150-167`) | **THEATER** | The drafter/CoS `enqueue-action` tool becomes the igniter (service-desk already proves the pipeline works, `service-desk/agentTools.ts:80`) |
| Perception loops run (calendar/drive ingest, morning briefing) | Real workflows + scheduler job + Connections cred (`loops.ts:40-183`) | **RIDES** | Leave |
| Loop enable/disable + status | `RecurringTasksPanel` over `/loops*` reading the job row (`loops.ts:129-188`) | **PAGE-LEGIT** | Keep; re-gate on the capability not `roleKey` (`AgentWorkspacePage.tsx:412`) |
| Memory-graph writes (commitments/decisions/meetings/stakeholders) | `ctx.features.assistant` from loop nodes (`surface.ts:104-167`) | **RIDES** | Leave |
| Memory-graph reads (projects/commitments/…) | REST GETs (`routes.ts:145-234`) | **PAGE-LEGIT** | Keep as owner API |
| Memory-graph CRUD (create/update/delete project & commitment) | `workspace:write` REST routes with **no frontend consumer** (`routes.ts:148-208`; `assistantClient.ts:13-19`) | **PAGE-LEGIT** (UI-less owner API) | Keep the API; chat mutation arrives via the `upsert-commitment` tool above — no bespoke form to build |
| Pending-action approve / reject / edit | Thin routes funneling into the shared `resolveApproval` CAS (`actionApproval.ts:128-161`, `routes.ts:241-295`) | **ADAPTER** | Leave; watch drift — card renders in the reviews inbox, not a bespoke button |
| Action execution (nudge / email / calendar / servicedesk.reply) | `startWorkflowRun` + terminal projection (`actionExecution.ts:95-208`) | **RIDES** | Leave |
| Briefing compose + GET | `briefing.ts` composer shared by the morning loop + route (`surface.ts:174-194`, `routes.ts:300-302`) | **RIDES** / PAGE-LEGIT read | Leave |
| Assistant health metrics | Superadmin-gated read (`routes.ts:305-308`, `AgentHealthPanel`) | **PAGE-LEGIT** | Keep |
| Agent-knowledge curation (documents / notes / bindings) | Thin composition of kb + subjectMemory + `agentProfile.knowledge`, no new store (`agent-knowledge/service.ts:1-45`, `feature.ts:1-53`) | **RIDES** | Leave |
| Agent-knowledge retrieve/ingest nodes + auto-ingest workflow | Read + `role:action` KB write over the surface; `feature.agent-knowledge.auto-ingest` registered (`feature.ts:30-46`, `surface.ts:26-53`) | **RIDES** | Leave |

Counts: R=6, A=1, P=0, T=4, PL=4.

## Blockers (from scouting) — each with the honest alternative

1. **B1 — Node typeIds in an allowlist are not chat tools.** Assumed the CoS
   agent could call its allowlisted `feature.assistant.nodes.*`. It cannot:
   `resolveTool` = `BUILTINS.get` (`agentToolProvider.ts:505`) and the feature
   registers nothing. *Alternative:* add `features/assistant/agentTools.ts`
   calling `registerFeatureAgentTool` for `upsert-commitment`, `populate-board`,
   `prioritize`, `compose-briefing`, `enqueue-action`, each wrapping the SAME
   surface method the loop node uses and sharing the route's `workspace:write`
   predicate + `actingUserId` fail-closed (the ADR 0308 documents.draft
   reference). Reads (`list-commitments`, etc.) become fail-EMPTY read tools.
2. **B2 — `enqueue-action` has no igniter for its own kinds.** The
   approval/execution machinery only fires for `servicedesk.reply` (a different
   feature). *Alternative:* B1's `enqueue-action` tool becomes the igniter for
   `email.send`/`calendar.*`; the existing `resolveAgentPolicy` deny gate
   (`actionApproval.ts:83-91`) + write-scope Connection re-consent already
   fail-close it. No new pipeline.
3. **B3 — The anti-phantom lint proves the wrong thing.** `agent-prompt-tool-ids.test.ts`
   accepts node typeIds as "resolved," so a toothless action allowlist ships
   green. *Alternative (platform TODO):* extend the lint (or add a companion)
   to assert that an allowlisted **action** id resolves to a builtin or a
   `registerFeatureAgentTool` site, not merely to a declared node. This is a
   cross-feature hole — file it, don't patch it locally.
4. **B4 — `feature.kb.nodes.rag` in the allowlist is a dead id in chat.** The
   real chat RAG tools are `core.rag.retriever-*` / `knowledge.search`
   (`agentToolProvider.ts:233,420`). *Alternative:* swap the allowlist entries
   to the real ids so extractor/CoS can actually read a source.

## Demolition list (with regression pins)

Little bespoke UI exists — the `/assistant` page demolition already happened.
Remaining cleanups:

- **Retire the misleading allowlist entries** (`feature.priority-matrix.nodes.*`,
  `feature.strategy.nodes.*`, `feature.kb.nodes.rag`, `core.openwop.mcp.*`) OR
  make them resolve. **Pin:** a test asserting every *action-class* id in
  `feature.assistant.agents/pack.json` resolves to a callable chat tool (the B3
  companion), scoped to this pack until the platform lint lands.
- **Re-gate the loops/health panels on the `assistant` capability**, deleting
  the `roleKey === 'chief-of-staff'` checks (`AgentWorkspacePage.tsx:412`,
  `RecurringTasksPanel.tsx:10`, `AgentHealthPanel.tsx:11`). **Pin:** a test that
  a non-`chief-of-staff` roleKey agent with the capability shows the panels.
- No approve/submit button to demolish — decisions already render in the
  reviews inbox via the shared approval card. **Pin:** keep the existing
  `agent-policy-assistant-enqueue` + approval-CAS tests.

## New-code inventory (small)

- `features/assistant/agentTools.ts` — 5 action tools + a few read tools, each a
  thin wrapper over the existing `surface.ts` methods (no new logic).
- A parity test pinning action-tool resolution for this pack (B3 companion).
- One-line allowlist fixes in `pack.json` (B4) + capability re-gate in 3 FE
  files.
- Platform TODO filed for the lint gap (B3) — not code here.

Everything else (loops, graph store, approval/execution pipeline, briefing,
agent-knowledge) is already correct and needs no new code.

## Phased plan (gated on real gates)

- **Phase 1 — restore agency (compliance seam first).** Add
  `features/assistant/agentTools.ts`; register the 5 action tools + read tools
  sharing the routes' predicate + `actingUserId` fail-closed; fix the B4
  allowlist ids. Close with `/code-review` + `/ux-review`; gate: `npm run ci`.
- **Phase 2 — pin the honesty.** Add the action-tool-resolution parity test
  (B3 companion) and file the platform-lint TODO. Verify the drafter can now
  enqueue an `email.send` action end-to-end into the reviews inbox. Gate:
  backend vitest.
- **Phase 3 — capability re-gate.** Replace the `roleKey === 'chief-of-staff'`
  UI checks with the `assistant`-capability check; add the regression test.
  Close with `/ux-review`.

Never demolish before the replacement works: the allowlist entries stay until
their tools resolve.

## Deferred honestly

- **The B3 platform-lint gap** is cross-feature; other packs may allowlist
  action node typeIds that don't project (worth a repo-wide sweep, out of scope
  here) — deferred to a filed TODO, not faked.
- **Chat-driven graph *structural* editing** (a canvas over projects/commitments)
  is not proposed — the graph is agent-maintained substrate + a read API; manual
  CRUD has no UI and needs none once the `upsert-commitment` tool exists. Left as
  an honest owner API, not painted as a feature.
- **Agent-knowledge note curation via chat** ("remember that…") is a plausible
  future chat capability, but the curation panel is honest management UI over
  real owners today — not a demolition target.
