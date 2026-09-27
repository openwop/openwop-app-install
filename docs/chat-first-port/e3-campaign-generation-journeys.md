# Campaign generation & journeys (unit E3) — chat-first port review

**Scope (single-feature / cluster mode):** backend `features/campaign-channels`,
`features/campaign-orchestration`, `features/campaign-journeys`; frontend
`features/campaign-orchestration` (the sole SPA surface — channels and journeys
ship no page). Judged against the app's real primitives: the ONE chat +
`registerFeatureAgentTool` projection, `startWorkflowRun` + the node catalog, the
`core.approvalGate` HITL machinery, the builder canvas, and the single owners
(media, host-events, conversations).

**Headline verdict:** the *services and workflow spines are real and honest*, but
**both advertised chat-first execution surfaces are dead**. The Campaign Strategist
and Channel Generator agents declare tool allowlists of node typeIds that **no
feature ever projects into conversational tools**, so every one is silently dropped
at dispatch — the personas can drive nothing. The orchestration workflow and the
five channel workflows are registered but have **no igniter anywhere in the
codebase**. Journeys, by contrast, correctly ride the engine.

---

## Contract scouting (pinned evidence)

### The node→conversational-tool projection choke (the load-bearing fact)

A model can only call a tool the host can *resolve*. The resolver is the `BUILTINS`
map: `resolveTool: (name) => BUILTINS.get(name)?.def`
(`host/agentToolProvider.ts:505`). The chat loop offers exactly
`toolAllowlist ∩ builtinAgentToolIds()`
(`host/conversationToolLoop.ts:304`), and any allowlisted id the host can't
describe **"are silently dropped"** (`host/agentDispatch.ts:458`, also `:305`).

`BUILTINS` is populated by two paths only: the static entries
(`agentToolProvider.ts:413-422` — `knowledge.search`, `schema.lookup`, web
research, `http.fetch`, code-exec, `kanban.add-todo`, RAG retrievers, and exactly
**two** projectable compute nodes at `:45-48`) and `registerFeatureAgentTool`
(`:441`).

**No campaign feature calls `registerFeatureAgentTool`.** The complete registerer
list (grep of `src/`) contains `goals, cdp, task-deck, intent-ledger, kicktodo-*,
projects, slides, documents, accessibility, creative-briefs, bi, service-desk,
proposals, scheduled-agent-chats, notifications, conversation-search, channels,
entities, app-builder, media` — **zero campaign-\* entries**. There is no
`features/campaign-*/agentTools.ts` file at all (`find` returns nothing).

**Consequence:** every id in the Campaign Strategist allowlist
(`packs/feature.campaign-orchestration.agents/pack.json:21-34` — 12 tools) and the
Channel Generator allowlist (`packs/feature.campaign-channels.agents/pack.json:29-36`
— 6 tools) resolves to `undefined` and is filtered out. Both agents are dispatched
with **none of their declared campaign tools**.

### Why the tripwire is green anyway (the trap)

`test/agent-prompt-tool-ids.test.ts` passes because its universe includes **every
pack-declared node typeId** (`:36`), so `openwop:feature.campaign-channels.nodes.generate`
"resolves" — as a *node that exists*, not as a *tool the model can call*. The lint
proves the id names a real node; it never checks that the node is registered into
`BUILTINS`. This is precisely the cross-cutting silent-drop pattern flagged for
this sweep.

### The strategist prompt actively lies to the model

`prompts/campaign-strategist.md` opens "You compose tools across the Campaign
Studio packs" and enumerates 10 tools to call (validate, generate-kernel, generate,
content-quality-check, 5× publish-*, consistency-check, finalize) with a "How to
run a campaign" procedure. At runtime the model is offered zero of them — a
prompt-to-model lie of exactly the kind the exchange audit exists to prevent.

### Ignition: the workflows are real but nobody starts them

- The orchestration spine is a genuine `WorkflowDefinition`
  (`orchestrationWorkflow.ts:110-125`), registered via `builtinWorkflows`
  (`feature.ts:23` → `CAMPAIGN_ORCHESTRATION` `orchestrationWorkflow.ts:150-152`),
  with real HITL gates (`core.approvalGate` at `:67`) and a parallel RFC-0118
  fan-out. The five channel workflows are equally real (`channelWorkflows.ts:31-57`,
  `generate → core.approvalGate`).
- **No `startWorkflowRun` caller names `campaign-studio.campaign-orchestration` or
  `campaign-studio.channel.*`.** The only repo reference to the orchestration id
  outside its own file is a doc comment in `destination-sync/onwardSyncWorkflow.ts:10`.
  The frontend never starts a run — "Run with Strategist" only deep-links the chat
  (`CampaignStudioPage.tsx:74,83`). No event binding, schedule, or agent tool
  ignites it. The channel workflows are dispatched *only by* the orchestration
  (`orchestrationWorkflow.ts:99-108`), so if the parent never runs, they never run.
- The tests assert workflow *shape* and registration only
  (`test/campaign-orchestration.test.ts:179-249`) and call nodes directly with
  mocked features (`:119-177`); none starts an actual multi-node run.

### The node runtimes DO exist (so the port is cheap)

`index.mjs` is present for all three node packs
(`packs/feature.campaign-channels.nodes/`, `…orchestration.nodes/`,
`…journeys.nodes/`). The nodes execute for real inside a run — the only missing
pieces are (a) projection into conversational tools and/or (b) an igniter.

### Journeys ride the engine correctly

`campaign-journeys` declares **no agent** and **no workflow** — deliberately
(`feature.ts:5-10` "NOT a journey engine"). It ships guard/read *nodes*
(`packs/feature.campaign-journeys.nodes/pack.json`) consumed inside user-authored
RFC 0013 chains, plus the enrollment CAS (`journeyService.ts:93-158`) and the
consent+suppression+has-email eligibility composite (`:193-202`) — the two things
chains can't express. Routes are read-only visibility + an explicit reset
(`routes.ts:20-37`). This is textbook RIDES.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Run a campaign conversationally (Campaign Strategist) | agent pack, 12 node tools allowlisted | **THEATER** — every tool dropped at dispatch (`agentToolProvider.ts:505`, `agentDispatch.ts:458`; no `registerFeatureAgentTool`) | project each allowlisted node via `registerFeatureAgentTool` (ADR 0308) **or** give the strategist one `startWorkflowRun` tool that ignites the spine + drives its gates |
| 2 | Generate one channel conversationally (Channel Generator) | agent pack, 6 node tools allowlisted (`campaign-channels.agents/pack.json:29-36`) | **THEATER** — same silent drop | same projection as #1, scoped to the channel-generation nodes |
| 3 | Orchestration spine (validate→kernel→approve→5 channels→consistency→finalize) | registered `builtinWorkflow` (`orchestrationWorkflow.ts:150`) | **THEATER** — real workflow, **no igniter** (no `startWorkflowRun` caller) | ignite from the strategist tool (a `workflow_run` turn) and/or a "Generate campaign" chat action; gates render inline in the parent run |
| 4 | Five channel child workflows (generate→approve) | `channelWorkflows.ts:59` | **THEATER** — only dispatched by #3, which never runs | rides once #3 is ignited (already `core.dispatch`/`core.subWorkflow` wired) |
| 5 | Finalize a brief into a campaign (Finalize modal → `POST /finalize`) | bespoke modal (`CampaignStudioPage.tsx:158-191`) + REST route (`routes.ts:78-97`) | **PARALLEL** — bespoke intake substituting for the declared `finalize` agent tool (`orchestration.nodes.finalize`); currently the ONLY working path because #1 is dead | keep the REST route as the thin adapter; the chat-first entry is the strategist's finalize tool once projected — demolish the modal only after #1 works |
| 6 | `finalize` node + `finalizeFromBrief` surface | node executes over `ctx.features` (`surface.ts:21-35`, `campaignService.ts:142`) | **RIDES** — real node/service, one-campaign-per-brief upsert, snapshots | leave alone |
| 7 | Campaign status edit / rename / parent / delete | `SelectField`→PATCH + REST (`routes.ts:99-137,186-193`) | **ADAPTER** — thin CRUD over the feature's own entity; delete fires a cascade seam (`campaignService.ts:242`) | leave; watch for drift |
| 8 | Attach media assets to a campaign | surface verb (`surface.ts:40-48`) → `attachCampaignAssets` (`campaignService.ts:197`) instantiates the media usage graph (`syncUsageRefs`/`getAsset`) | **RIDES** — single media owner | leave alone |
| 9 | Campaign lifecycle events (finalized/status-changed/deleted) | `emitHostEvent` through the one dispatcher (`campaignService.ts:50-61`) | **RIDES** — single host-event owner, signed-webhook + trigger fan-out | leave alone |
| 10 | "Design journey" → builder canvas seed | `navigate('/builder', {workGraphSeed})` (`CampaignStudioPage.tsx:87-91`) | **RIDES** — the one builder canvas, no second authoring surface | leave alone |
| 11 | Journey enrollment guard (`enroll`) | CAS one-run-per-(journey,contact) + ADR 0299 arbitration (`journeyService.ts:93-158`), node-backed | **RIDES** — real chain primitive | leave alone |
| 12 | Journey eligibility composite (`eligibility`) | consent+suppression+has-email (`journeyService.ts:193-202`) | **RIDES** | leave alone |
| 13 | Journey depth reads (engagement / frequency / segment-members / split / winback supervisor) | nodes over live reads (`journeyService.ts:213-237`, `surface.ts:47-53`) | **RIDES** — workflow nodes feeding EdgeConditions / `core.dispatch` | leave alone |
| 14 | Journeys-as-chains (RFC 0013 + event bindings) | no bespoke engine (`campaign-journeys/feature.ts:5-10`) | **RIDES** — runs in the executor, monitored in Runs, approved in the Approvals inbox | leave alone |
| 15 | Enrollment ledger read + explicit reset | read route + DELETE (`campaign-journeys/routes.ts:20-37`) | **PAGE-LEGIT** (read) / thin CRUD (reset) | keep as page |
| 16 | Campaign list + search/status facet | `CampaignStudioPage.tsx:54-139` | **PAGE-LEGIT** — read-only collection with the §4.5 kit | keep |
| 17 | Campaign detail: kernel + channels display | `CampaignStudioPage.tsx:213-230` | **PAGE-LEGIT** — read-only provenance | keep |
| 18 | Revision history + campaign workspace projection | `/versions`, `/workspace` reads (`routes.ts:144-173`) | **PAGE-LEGIT** — projection over existing stores, no second store | keep |
| 19 | Launch state + ad dispatch ledger (PAUSED) | `LaunchState` over `listDispatchRecords` (`CampaignStudioPage.tsx:240-291`) | **PAGE-LEGIT** — honest read, real ledger, deliberate "human publishes" posture | keep |

**VERDICTS: R=9 A=1 P=1 T=4 PL=4**

---

## Blockers (from scouting) — each with the honest alternative

- **B1 — Node typeIds in an agent allowlist are NOT conversational tools.** The
  assumption baked into both campaign agent packs ("allowlist the node → the model
  can call it") is false on this host: only `BUILTINS` entries resolve
  (`agentToolProvider.ts:505`), and unresolved allowlisted ids are dropped
  (`agentDispatch.ts:458`). **Alternative:** ship
  `features/campaign-orchestration/agentTools.ts` and
  `features/campaign-channels/agentTools.ts` that call `registerFeatureAgentTool`
  for each allowlisted node, each tool sharing the route's org-scope predicate
  (`resolveEffectiveAccess` / `hasOrgScope`, `routes.ts:32-35`) — the ADR 0308
  "one helper, route + tool both call it" contract. This is exactly how
  `creative-briefs`, `documents`, `media` already do it.

- **B2 — Two competing execution surfaces, neither wired.** The cluster ships BOTH
  a declarative gated spine (#3/#4) AND an agent meant to hand-call the same nodes
  (#1/#2). Building the projection (B1) resurrects the *hand-call* path but leaves
  the spine's approval gates unused; igniting the spine leaves the "selective
  channels" agent advantage unused. **Alternative — pick one, and prefer the
  spine:** give the strategist a single `startWorkflowRun` tool (or a channel-scoped
  variant) that ignites `campaign-studio.campaign-orchestration` with the confirmed
  `briefId`; the kernel approval and each channel approval then render **inline in
  the parent run** through the existing `core.approvalGate` cards (HITL machinery
  already there), and the strategist narrates. This reuses gates instead of asking
  the model to self-police "get approval before publishing" in prose. Keep the
  node-as-tool projection (B1) only for the genuinely conversational verbs
  (validate, consistency-check, finalize) the user asks for out of band.

- **B3 — No igniter for the spine, from any surface.** Even with the agent fixed,
  nothing lets a human start the orchestration except the (broken) agent.
  **Alternative:** the strategist's `startWorkflowRun` tool IS the igniter; no REST
  igniter needed. The "Run with Strategist" deep-link
  (`CampaignStudioPage.tsx:74,83`) then lands on a strategist that can actually act.

- **B4 — The `finalize` REST route + modal are the only working create path.**
  Because #1 is dead, `POST /finalize` (`routes.ts:78`) and the Finalize modal are
  load-bearing, but they bypass kernel-generation/approval and channel generation
  entirely — they upsert a campaign from an already-kernel'd brief. Honest today
  (the route rejects a kernel-less brief, `routes.ts:91-93`), but it is NOT the
  chat-first flow the ADR advertises. **Alternative:** keep the route as the thin
  finalize adapter (the `finalize` node calls the same `finalizeFromBrief`); move
  the *primary* create-a-campaign journey into chat once B1/B2 land.

---

## Demolition list (with regression pins)

- **Finalize modal** (`CampaignStudioPage.tsx:158-191`) — demolish **only after**
  the strategist can finalize in chat (B1). Pin: a UI test asserting no bespoke
  brief-picker→create form outside the chat; a route test that `POST /finalize`
  remains callable by the projected `finalize` tool's predicate.
- **The strategist prompt's 10-tool "you can do" list**
  (`prompts/campaign-strategist.md`) — not demolished but must be made TRUE by
  B1/B2. Pin: a dispatch-level test that the Campaign Strategist's *resolved* tool
  surface (post-`compileAgentTools`) is non-empty and contains the finalize +
  generate ids — the test that `agent-prompt-tool-ids.test.ts` deliberately does
  NOT do. This is the regression that would have caught the silent drop.
- Nothing in journeys is a demolition target — it already rides the engine.

---

## New-code inventory (small — mostly the missing projection)

1. `features/campaign-orchestration/agentTools.ts` — `registerFeatureAgentTool` for
   `finalize`, `consistency-check`, `setup-check` (and a `startCampaignRun` tool
   that calls `startWorkflowRun` on `campaign-studio.campaign-orchestration` if
   taking the B2/spine route). Each shares `hasOrgScope`.
2. `features/campaign-channels/agentTools.ts` — `registerFeatureAgentTool` for
   `generate`, `content-quality-check`, the five `publish-*`, `render-concepts`.
   Action tools fail typed; reads fail empty; all share the brief's org predicate.
3. Wire both `agentTools` modules from their `feature.ts` init (the `wireX`
   dependency-inversion pattern).
4. **One new test** (the regression pin above): resolved-tool-surface assertion for
   both campaign agents at dispatch time.
5. No new stores, no new workflows, no new nodes, no wire/RFC surface — the nodes,
   workflows, gates, media owner, and host-events already exist.

---

## Phased plan (gated on real gates; compliance/parity first)

- **Phase 1 — Parity seam + failing regression pin.** Add the resolved-tool-surface
  test (proves both agents currently resolve to empty). Land the two `agentTools.ts`
  modules with the shared-predicate helper; wire from `feature.ts`. Gate: `npm run
  ci` green + the new test green (agents now resolve their tools). Close with
  `/code-review`.
- **Phase 2 — Decide B2 and ignite.** Either (a) keep node-as-tool and let the
  strategist hand-call with a lightweight in-chat approval per publish, or
  (preferred) (b) add the `startCampaignRun` tool igniting the spine so kernel +
  channel approvals render as real gate cards in the parent run. Gate: a live
  dispatch test that starts a run and reaches the kernel gate. Close with
  `/code-review` + `/ux-review` (the in-chat gate cards).
- **Phase 3 — Rehome the create flow, then demolish.** Make "Run with Strategist"
  the primary create path; once green, demolish the Finalize modal behind its
  regression pin (keep the REST route as the thin adapter). Close with `/ux-review`.
- **Phase 4 — Grade.** `/grade-ai-exchange` (the strategist is a model-facing
  surface whose prompt↔tool parity was broken — it needs a tracker row + the
  dispatch tripwire), `/grade-code`, `/grade-ux`; apply fixes.

Journeys need **no phase** — verified riding the engine.

---

## Deferred honestly

- **Live social / creative-brief posting** stays a document handoff (RFC-gated, no
  in-app target) — `publish-social-posts`/`publish-creative-briefs` are honestly
  draft-document handoffs (`campaign-channels.nodes/pack.json:56-72`); the prompt
  already says so. Not a port target; keep deferred-visible.
- **Live ad-video dispatch** fails closed `video_dispatch_live_pending`
  (`publish-ad-variants`, `campaign-channels.nodes/pack.json:50`) — RFC/ADR-0411
  §P3c blocked; leave as-is.
- **Which B2 branch to build** (node-as-tool vs ignite-the-spine) is a design
  decision for Phase 2, stated not faked — both are viable; the spine route is
  recommended because it reuses the approval gates rather than re-implementing HITL
  in prose.
