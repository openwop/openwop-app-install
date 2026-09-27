# Funnels (E6) — chat-first port review

**Scope:** `backend/typescript/src/features/funnels` + `frontend/react/src/features/funnels`
(single-feature mode). Feature toggle `funnels` (default OFF), ADR 0294 / Funnel A.

**Headline:** The backend is a model citizen — funnels is a thin composition layer
that RIDES CMS pages, the CDP event spine, the forms submission-sink, and the shared
variant assigner, shadowing no owner. But its ONE AI capability is pure theater: the
**Funnel Architect agent's five allowlisted node tools are silently dropped at chat
dispatch** (they are never projected into the chat tool universe), and the frontend
never surfaces the agent at all. The declared "chat-drivability = agent + node pack"
(the whole reason two packs exist) delivers nothing.

---

## Contract scouting (pinned evidence)

### What is declared vs what can actually run

- **Agent declared:** `feature.funnels.agents.funnel-architect`, a RESEARCH persona whose
  `toolAllowlist` is exactly five node tools —
  `openwop:feature.funnels.nodes.{list,get,create,set-steps,step-stats}`
  (`packs/feature.funnels.agents/pack.json`). Prompt promises review/diagnose/propose/
  recommend-experiments (`packs/feature.funnels.agents/prompts/funnel-architect.md`).
- **Node pack declared:** `feature.funnels.nodes` — five `role:"action"` nodes that call
  `ctx.features.funnels.{list,get,create,setSteps,stepStats}`
  (`packs/feature.funnels.nodes/index.mjs`; `packs/feature.funnels.nodes/pack.json`).
- **Surface declared:** `ctx.features.funnels` with `list/get/create/setSteps/stepStats`
  (`backend/typescript/src/features/funnels/surface.ts:22-58`) — `create`/`setSteps` author
  **draft** state only (surface.ts:32-45; "agent proposes, human disposes").
- **Both packs are `requiredPacks`** of the feature (`feature.ts:36-39`).

### The break — node tools never reach the chat tool surface (THEATER root cause)

The chat tool loop offers a model only the intersection of the **builtin tool universe**
and the agent's allowlist, then drops any name with no resolver:

- `conversationToolLoop.ts:304` compiles tools with
  `compileAgentTools(agent, builtinAgentToolIds(), resolveTool, effectiveToolAllowlist(...))`.
- `builtinAgentToolIds()` = `[...BUILTINS.keys()]` (`agentToolProvider.ts:426`). `BUILTINS`
  is registered builtins **plus** `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` only
  (`agentToolProvider.ts:419-424`).
- `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` is an **explicit two-node allowlist**
  (`feature.insights-suite.nodes.variance-compute`, `…talent-score`) and is *deliberately*
  restricted to **pure compute nodes with no host-surface ctx** — the doc comment excludes
  exactly the `ctx.features.*`-backed nodes funnels ships (`agentToolProvider.ts:35-48`).
- `filterTools(available, allowlist)` intersects the two sets; anything not in the builtin
  universe is gone (`agentDispatch.ts:184-190`). `resolveAgentTools` then "silently drops"
  any surviving name with no `resolveTool` hit (`agentDispatch.ts:458-471`).

**Funnels registers NO builtin agent tools.** `feature.ts:20-25` calls
`registerFunnelsRoutes` + `registerFunnelsFormsSink` + `startFunnelStatsSweep` — never
`registerFeatureAgentTool`. There is **no `features/funnels/agentTools.ts`** (every other
`ctx.features.*` agent has one — e.g. `features/goals/agentTools.ts:16`
`registerFeatureAgentTool({ name: GOALS_LIST_TOOL_ID … })`).

⇒ At dispatch, `builtinAgentToolIds() ∩ funnel-architect.toolAllowlist = ∅`. **All five
tools drop.** The Funnel Architect is a toothless persona: it can chat about funnels but
cannot list, get, create, edit-steps, or read stats. Its prompt's "Review / Propose /
Recommend" contract is unbacked.

- **No parity test guards this.** No `.test.ts` asserts `toolAllowlist ⊆
  builtinAgentToolIds()`, and funnels has **no `promptCatalogParity.test.ts`** (the feature
  is absent from the list of features that ship one). The drift shipped green.

### Frontend — the agent is never surfaced

`FunnelsPage.tsx` (490 lines) has **zero** chat/agent references: no `EmbeddedChatPanel`, no
`navigate('/?agent=…')` deep-link, no "Optimize with AI" affordance (grep for
`agent=|EmbeddedChat|funnel-architect|useChat` in `features/funnels/` → nothing). Even if
the tools were wired, a user would have to know to hand-pick "Funnel Architect" in the
global chat. `routes.tsx` registers only the page + nav fragment.

### What the feature RIDES correctly (the good news)

- **Pages stay CMS-owned** — steps hold validated `pageId` refs via `getPage`, never a second
  page model (`funnelsService.ts:154-166, 330-334`).
- **Public serving composes** the existing CMS public page read + shared variant assigner
  (`assignWeightedVariant`, `funnelsService.ts:421-426`) + CDP events (`routes.ts:254-312`).
- **Analytics is a derived cache over the CDP event spine** (`listCollectedEvents`,
  `funnelStats.ts:75,183`; ADR 0211 "never authoritative" doctrine, funnelStats.ts:2-13).
- **Forms attribution rides the ADR 0332 submission-sink seam** (`formsAttributionSink.ts:1-17`).
- **Routing is a pure function** (`funnelRouting.ts:2`).
- **Public viewer composes** CMS `RenderSections` + the forms embed seam, never re-implements
  (`viewer/FunnelViewerPage.tsx:1-20`).

No PARALLEL architecture found — funnels instantiates the owners it needs.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Review funnels + read per-step stats **via chat** (agent `list`/`get`/`step-stats`) | Agent tools declared, **dropped at dispatch** (`agentDispatch.ts:458-471`) | **THEATER** | Register the reads as builtin agent tools sharing the route predicate; wire the deep-link |
| Draft / edit a funnel **via chat** (agent `create`/`set-steps`) | Declared drafts; tools dropped; frontend never opens the agent | **THEATER** | Register as action tools (draft-only, already enforced in surface.ts:32-45) |
| Recommend/diagnose challenger experiments **via chat** | Prompt promises it; agent can't even read stats to ground it | **THEATER** | Falls out once `step-stats` reaches the model; keep "human starts experiments" |
| Node pack over `ctx.features.funnels` | Thin, honest wrapper calling the same service fns as routes (`index.mjs`) | **ADAPTER** | Correct — but currently reachable by nothing (no workflow ignites it, chat can't see it). Keep; wire it in |
| Per-step analytics rollups (derived cache over CDP) | `funnelStats.ts` rebuild sweep + on-demand | **ADAPTER** | Honest derived cache over the CDP spine; leave, watch for drift |
| Create / edit funnel (human, form + REST) | `FunnelsPage.tsx:124-167`; `routes.ts:112-132` | **PAGE-LEGIT** | Keep — human authoring/disposal surface; simple ordered list, not canvas-shaped |
| Publish / unpublish / archive / delete (lifecycle) | Bespoke buttons (`FunnelsPage.tsx:137-156`); `routes.ts:134-168` | **PAGE-LEGIT** | Keep as direct operator control; it IS the "human disposes" gate for agent drafts |
| Step A/B experiment start/stop (human) | `FunnelsPage.tsx:169-190`; `routes.ts:172-188` | **PAGE-LEGIT** | Deliberately human (public-serving change); keep |
| Analytics reads + daily trend + experiment results | `FunnelsPage.tsx:402-484`; `routes.ts:190-236` | **PAGE-LEGIT** | Honest reads; complete — every displayed number has a real read |
| Public funnel serving (entry / step / routed `/next`) | `routes.ts:254-312` composing CMS + CDP + assigner | **RIDES** | Leave alone |
| Forms opt-in attribution (submission → lead) | `formsAttributionSink.ts` on the ADR 0332 sink | **RIDES** | Leave alone |
| Public viewer page (`/fn/:orgId/:slug`) | `viewer/FunnelViewerPage.tsx` composing CMS render + forms embed | **PAGE-LEGIT** | Leave alone |

**Counts:** RIDES 2 · ADAPTER 2 · PARALLEL 0 · THEATER 3 · PAGE-LEGIT 5.

---

## Blockers (from scouting) — each with the honest alternative

**B1 — Funnel node typeIds are not projectable as chat tools, by design.**
The only node→chat-tool bridge is `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`, and it *excludes*
`ctx.features.*`-backed nodes on purpose (they need host-surface ctx, secrets, egress —
`agentToolProvider.ts:35-48`). So you cannot fix the toothless agent by "adding funnel nodes
to the projection list" — that list is only for pure compute.
**Honest alternative:** do what `goals`, `cdp`, `slides` do — add
`features/funnels/agentTools.ts` that calls `registerFeatureAgentTool` for each funnel
capability, calling the **same service functions** the routes call, behind the **same
authorization predicate**. That is the sanctioned "chat-drivability = agent + nodes" path;
the node pack is then still valid for a future *workflow* that runs the nodes.

**B2 — No acting-user / authority-parity plumbing exists on the funnels agent path.**
The REST routes gate every call with `authorizeOrgScope(req, FEATURE, 'workspace:read|write')`
(`routes.ts:98,114,…`). The surface (`surface.ts`) takes a `BundleScope` with only `tenantId`
and hard-codes `createdBy: 'agent'` — there is no shared predicate a tool could reuse.
**Honest alternative:** extract one `assertFunnelsOrgAccess(actingUserId, orgId, mode)` helper
that both `authorizeOrgScope`'s handler body and the new agent tools call (the CLAUDE.md
"one helper, route + tool both call it" rule). Read tools fail **EMPTY** without an acting
user; write tools fail **typed**. Without this, a chat tool would either bypass RBAC or run
unscoped — worse than the current dead agent.

**B3 — Frontend has no chat entry point to the agent.**
Even after B1/B2, nothing opens the chat scoped to the Funnel Architect.
**Honest alternative:** an "Optimize with AI" action on `FunnelsPage` that deep-links the ONE
chat (`navigate('/?agent=feature.funnels.agents.funnel-architect')`, the agents-page /
`ProjectChatTab` precedent in CLAUDE.md) — or, if an embedded surface is wanted, the shared
`chat/EmbeddedChatPanel` with `agentId` override. **Do not** build a bespoke funnels chat panel.

---

## Demolition list (with regression pins)

There is little bespoke UI to demolish — the page surfaces are PAGE-LEGIT. The demolitions
are of the **false capability claims**, pinned so they can't silently reappear:

1. **Delete the toothless-agent illusion.** After the port, add a repo-wide (or funnels)
   test asserting `funnel-architect.toolAllowlist ⊆ builtinAgentToolIds()` **after the
   feature registers its tools**. Pin: the test fails today (∅ intersection) and must pass
   only once `agentTools.ts` registers all five. This is the regression guard the missing
   parity test should have been.
2. **Pin the draft-only firewall.** A test that the `create`/`set-steps` agent tools produce
   `status: 'draft'` and that **no** publish/experiment tool is ever registered for the agent
   (a resurrected "publish via chat" tool fails the suite) — the promotions firewall
   (surface.ts:1-9).
3. **Pin authority-parity.** A test that the agent read tools fail EMPTY without an acting
   user and the write tools fail typed, sharing the route predicate (B2).

No forms/buttons are demolished — the human authoring/lifecycle/experiment surfaces stay.

---

## New-code inventory (small)

- `features/funnels/agentTools.ts` — five `registerFeatureAgentTool` calls (list/get/step-stats
  reads; create/set-steps draft writes), each calling the existing service fns via the shared
  predicate. Wire from `feature.ts` registerRoutes. **(the one substantive add)**
- `assertFunnelsOrgAccess(actingUserId, orgId, mode)` — one predicate extracted from
  `authorizeOrgScope`'s funnels usage; routes + tools both call it (B2).
- `FunnelsPage` "Optimize with AI" deep-link button (B3) — ~1 handler, no new chat.
- Tests: allowlist⊆builtin parity; draft-only firewall; authority-parity EMPTY/typed;
  a `promptCatalogParity.test.ts` for funnels (the missing per-feature guard).

No new workflow, no new envelope kind, no new owner, no wire/RFC change (host-extension only).

---

## Phased plan (gated on real gates; compliance seams first)

**Phase 1 — Authority seam.** Extract `assertFunnelsOrgAccess`; refactor the route handlers
to call it (behavior-identical). Gate: `npm run ci` green; existing route tests unchanged.

**Phase 2 — Ignite the agent (THEATER→RIDES).** Add `features/funnels/agentTools.ts`
registering all five tools through the Phase-1 predicate (reads fail EMPTY, writes draft-only);
wire from `feature.ts`. Add the allowlist⊆builtin parity test + draft-only firewall test +
funnels `promptCatalogParity.test.ts`. Gate: parity test now passes; a live dispatch offers
the model five tools. `/code-review` + fixes.

**Phase 3 — Surface the agent.** `FunnelsPage` "Optimize with AI" deep-link to the ONE chat
scoped to `funnel-architect`. Gate: frontend `npm run build`; `/ux-review` + fixes.

**Phase 4 — Optional: in-chat proposal card.** If a "here's the draft funnel I built — open
it in the builder" confirmation is wanted, use a **typed registered interrupt card**
(app-known shape, i18n-critical) — **not** A2UI (no model-variable layout, trusted producer).
Keep publish as the human gate in the builder. Defer unless product asks.

---

## Deferred honestly

- **Publish-via-approvals-inbox** is intentionally NOT ported: funnels publish is a direct
  operator action in the builder, and the agent only drafts. If a future flow wants "agent
  proposes a funnel, human approves in the reviews inbox" (the promotions challenge-publish
  precedent), that is a new phase — not claimed as done here.
- **A workflow that runs the funnel nodes** does not exist and is not needed for the chat
  port; the node pack stays valid for that future use but nothing ignites it today (no
  `startWorkflowRun` caller references funnel nodes). Stated, not faked.
- **Experiment authoring via chat** stays out of scope — starting/stopping A/B splits changes
  public serving for consented visitors and is deliberately human (`surface.ts:6-8`).
