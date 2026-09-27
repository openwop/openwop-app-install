# Brand + briefs (unit E2) — chat-first port review

Scope: `backend/typescript/src/features/{campaign-brief, brand, creative-briefs}`
+ `frontend/react/src/features/{campaign-brief, brand, creative-briefs}` + their
packs (`feature.campaign-brief.{agents,nodes,artifact-types}`,
`feature.brand.{agents,nodes}`, `feature.creative-briefs.nodes`).

**Headline:** The two "authoring" agents in this unit — the **Campaign Brief
Strategist** and the **Brand Steward** — are toothless. Their `toolAllowlist`s
are pack **node typeIds** that are never projected into conversational tools, so
at chat dispatch they resolve **zero** tools and fall back to a bare narrating
completion. The flagship "generate the messaging kernel" and the entire
`campaign-studio.market-intel` pipeline have **no igniter anywhere** (not a
route, not the scheduler, not a chat tool). Creative-briefs is the honest
counter-example: its reel workflow rides a real route igniter and its
`openwop:creative-briefs.list` tool is properly registered and allowlisted —
proof the pattern is achievable, and that campaign-brief/brand simply skipped the
projection step.

---

## Contract scouting (pinned)

### The projection gap (the root cause, and the cross-cutting pattern)

The chat tool loop offers an agent exactly `builtinAgentToolIds()` and
intersects it with the agent's allowlist:

- `conversationToolLoop.ts:304` — `compileAgentTools(agent, builtinAgentToolIds(), …)`
- `agentDispatch.ts:488` — `compileAgentTools` → `resolveAgentTools(filterTools(availableTools, allow), …)`
- `agentDispatch.ts:185-189` — `filterTools` returns `available.filter(t => allow.has(t))` (a strict **intersection**, bounded by `available`)
- `conversationToolLoop.ts:305` — `if (tools.length === 0) return null;` → caller takes a single bare completion.

`builtinAgentToolIds()` = the keys of `BUILTINS` (`agentToolProvider.ts:413-428`):
the static platform tools (knowledge.search, schema.lookup, web-research,
http.fetch, code-exec, kanban.add-todo), the RAG retrievers, **only two**
projected compute nodes (`agentToolProvider.ts:45-48`:
`feature.insights-suite.nodes.variance-compute`, `…talent-score`), plus whatever
`registerFeatureAgentTool` adds (`agentToolProvider.ts:441-443`).

The two agents in this unit allowlist **pack node typeIds that are in none of
those sets**:

- Campaign Brief Strategist (`packs/feature.campaign-brief.agents/pack.json` toolAllowlist):
  `openwop:feature.campaign-brief.nodes.{get-brief,validate,generate-kernel,extract-seeds,extract-voc,generate-angles,build-targeting}` — **7 ids, 0 projected**.
- Brand Steward (`packs/feature.brand.agents/pack.json` toolAllowlist):
  `openwop:feature.brand.nodes.{list-brands,resolve-voice,compliance-check}` — **3 ids, 0 projected**.

Neither `campaign-brief/` nor `brand/` calls `registerFeatureAgentTool` (grep:
zero hits). So both agents' allowlist ∩ `builtinAgentToolIds()` = ∅ → `return null`
→ bare completion. **The Brand Steward prompt even instructs the model: "You act
only through the `feature.brand.nodes` tools"** (`packs/feature.brand.agents/prompts/brand-steward.md:9-19`)
— a prompt telling the model it has tools it does not have.

### Why the tripwire missed it

`test/agent-prompt-tool-ids.test.ts` `collectUniverse()` step 1 adds **every
pack-declared node typeId** to the "real tool universe". So `…nodes.generate-kernel`
"resolves" because it is a declared node — the lint never checks it is
**projected** into a chat tool. This class shipped green.

### Igniter inventory

| Declared orchestration | Igniter? | Evidence |
|---|---|---|
| `campaign-studio.market-intel` (`intelWorkflows.ts:21`, extract-voc→angles→targeting→approvalGate) | **NONE** | no `startWorkflowRun` caller; compose-and-run refuses registered ids (`workflowComposeTool.ts:106`); FE only deep-links the toothless strategist (`CampaignBriefPage.tsx:130,354`) |
| `feature.campaign-brief.nodes.generate-kernel` (the kernel) | **NONE** | no route, no workflow contains it, not a chat tool; grep repo-wide = only `intelWorkflows.ts` + docs |
| `openwop-app.creative-briefs-reel` (`reelWorkflow.ts:19`) | **YES — route** | `creative-briefs/routes.ts:294-327` POST `/briefs/:briefId/reel` → `buildRunRecord` + `insertRunWithStartContext` + `dispatchRunInBackground` (the shared run recipe) |

### Owners instantiated vs shadowed

- **RIDES:** notifications (`campaign-brief/feature.ts:32`), media library (renders/moodboard bytes owned by media — `creative-briefs/surface.ts:46-59`), documents/renderer (PDF, ADR 0057), share-links owner (`purgeLinksForResource`), comment-thread owner (`pruneThreadsForResourceAndComposites`), accessControl (brand governance — `brand/feature.ts` doc + no second ACL), the run engine (reel).
- **SHADOWS:** the **approvals/reviews owner** — creative-briefs review→approve is a bespoke privileged status flip (`creative-briefs/routes.ts:149-162`, `creativeBriefsService.ts:210-218`), not an approval kind / reviews-inbox card with a durable decision record.

### The honest counter-example

`openwop:creative-briefs.list` is registered via `registerFeatureAgentTool`
(`creative-briefs/agentTools.ts:21-78`), shares the route's authz predicate
(`resolveEffectiveAccess`, `workspace:read` parity, `agentTools.ts:59-61`), fails
closed on the toggle and empty without an acting user — and the **chief-of-staff
agent actually allowlists it** (`packs/feature.assistant.agents/pack.json:40`).
That is the ADR 0308 seam done right; campaign-brief and brand did not do it.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Persona CRUD | form/page (`campaign-brief/routes.ts:82-135`) | PAGE-LEGIT | keep (config entity) |
| 2 | Campaign-brief CRUD / duplicate / versions | form/page (`routes.ts:138-221`) | PAGE-LEGIT | keep |
| 3 | Brief validate (completeness + channel set) | route+surface (`surface.ts:32-36`) | RIDES | leave |
| 4 | **Generate messaging kernel (flagship)** | deep-link → toothless strategist chat; node never run (`CampaignBriefPage.tsx:354`; `generate-kernel` unreachable) | **THEATER** | registerFeatureAgentTool action tool → kernel run + human gate |
| 5 | **Market-intel pipeline** (VOC→angles→targeting→approve) | declared builtinWorkflow with **no igniter** (`intelWorkflows.ts:21`) | **THEATER** | action tool → `startWorkflowRun(MARKET_INTEL)` + authoritative `workflow_run` turn; approvalGate renders in parent run |
| 6 | VOC / angles / targeting / hook curation pages | list+delete+promote (`routes.ts:222-322`, `IntelWorkspace.tsx`) | PAGE-LEGIT | keep — but **producers (nodes) are dead** until #5 ignites; empty by construction |
| 7 | Kernel-staleness notification (KB change → notify) | `feature.ts:29-41` | RIDES | leave |
| 8 | Brand CRUD + fonts + audit (read) | form/page (`brand/routes.ts:104-194`) | PAGE-LEGIT | keep (identity/voice config) |
| 9 | Brand voice resolve (`resolveVoice` surface) | node-facing read (`brand/surface.ts:48-53`) | RIDES | leave |
| 10 | Brand deterministic compliance @ ads-dispatch edge | `setAdsComplianceChecker` (`brand/feature.ts:35-39`, `scoring.ts`) | RIDES | leave (real enforcement) |
| 11 | Brand governance via accessControl | `brand/feature.ts` doc; no 2nd ACL | RIDES | leave |
| 12 | **Brand Steward: explain voice / audit compliance from chat** | agent with 3 node-typeId tools, **0 projected** (`packs/feature.brand.agents/pack.json`) | **THEATER** | registerFeatureAgentTool read tools (list-brands, resolve-voice, compliance-check) sharing brand route authz |
| 13 | Creative-brief CRUD / versions / diff | form/page (`creative-briefs/routes.ts:95-200`) | PAGE-LEGIT | keep |
| 14 | Creative-brief review → **approve** | bespoke privileged status flip (`routes.ts:149-162`) | **PARALLEL** | approval kind → reviews inbox, durable decision record; keep the entity state machine |
| 15 | Moodboard (deterministic weighted media selection) | route+surface (`routes.ts:200`, ADR 0352) | RIDES (media) | leave |
| 16 | Renders (composite → media asset) | surface (`creative-briefs/surface.ts:46-99`) | RIDES (media) | leave |
| 17 | Generate reel (text-to-video) | route → real run (`routes.ts:294-327`) | RIDES (engine) | leave; chat-drivability optional (deferred) |
| 18 | PDF export | route (`routes.ts:222`, ADR 0057) | RIDES | leave |
| 19 | Approved-only share links | `purgeLinksForResource` owner | RIDES | leave |
| 20 | Brief comments / threads | thread owner (`pruneThreadsForResourceAndComposites`) | RIDES | leave |
| 21 | `openwop:creative-briefs.list` chat read | registered + chief-of-staff allowlists it (`agentTools.ts:21-78`) | ADAPTER | leave; the reference for #4/#5/#12 |

**VERDICTS: R=11 A=1 P=1 T=3 PL=5**

---

## Blockers (from scouting) — each with the honest alternative

1. **Node-typeId allowlists never project into chat tools.** Both agents resolve
   zero tools → bare completion (`conversationToolLoop.ts:304-305`;
   `agentDispatch.ts:185-189,488`; `agentToolProvider.ts:45-48,413-428`).
   *Alternative:* expose each needed capability via `registerFeatureAgentTool`
   (the `creative-briefs.list` / ADR 0308 precedent) — read tools failing EMPTY,
   action tools failing typed, each sharing its HTTP route's authz predicate
   (one helper, route + tool both call it) — then allowlist the **registered
   tool ids**, not raw node typeIds.

2. **The `agent-prompt-tool-ids` tripwire validates existence, not projection.**
   `test/agent-prompt-tool-ids.test.ts` adds every declared node typeId to the
   universe, so a non-projected allowlist entry passes.
   *Alternative:* extend the lint so every `openwop:`-prefixed **toolAllowlist**
   entry must be a member of `builtinAgentToolIds()` (the projected set), not
   merely a declared node. This is a repo-wide fix — it catches the whole class,
   not just E2 (record as a cross-cutting TODO).

3. **`campaign-studio.market-intel` has no igniter.** Not a route, scheduler,
   or chat tool; compose-and-run refuses registered ids (`workflowComposeTool.ts:106`).
   *Alternative:* an action tool `openwop:campaign-brief.research.run` →
   `startWorkflowRun(MARKET_INTEL_WORKFLOW_ID)` + emit the authoritative
   `workflow_run` conversation turn; the existing `core.approvalGate` node
   (`intelWorkflows.ts:46-51`) then renders inline in the **parent** run (gates
   are invisible from child runs — keep it top-level).

4. **`generate-kernel` (the flagship) is unreachable.** No route, no containing
   workflow, not a chat tool.
   *Alternative:* an action tool that runs a one-node kernel workflow
   (`assembleContext` → `callAI` → `setKernel`, all already in the surface,
   `surface.ts:42-86`) with the human approving the kernel via a gate/interrupt
   — never success-with-empty; one bounded repair on the authoring leg.

5. **Creative-brief approve is a parallel approval.** `transitionBrief` is a
   privileged status write (`routes.ts:149-162`), not the approvals owner.
   *Alternative:* route the review→approve **decision** through the reviews
   inbox as an approval kind (the challenge-publish precedent), leaving a durable
   decision record; keep the entity's `STATUS_TRANSITIONS` state machine but
   drive the `approved` transition from the approval decision, not a bare button.

---

## Demolition list (with regression pins)

- **"Generate with Strategist" / "Run research" deep-links**
  (`CampaignBriefPage.tsx:130,354`, `IntelWorkspace.tsx:87`): the deep-link
  *pattern* is correct ADR 0058, but today it opens a chat that can't act. Keep
  it **only after** #4/#5 land. *Pin:* a test asserting
  `compileAgentTools(BRIEF_STRATEGIST, builtinAgentToolIds(), …)` is non-empty
  (a toothless strategist fails the suite).
- **Brand Steward toothlessness.** *Pin:* assert every
  `feature.brand.agents.brand-steward` allowlist id ∈ `builtinAgentToolIds()`.
- **Creative-brief bespoke approve button.** Demolish once the reviews-inbox
  approval kind exists. *Pin:* a direct `POST /transition {status:'approved'}`
  that leaves no approval decision record fails the suite.

## New-code inventory (small)

- `campaign-brief/agentTools.ts` (**new**): read tools `get-brief`, `validate`
  (fail EMPTY); action tools `research.run` (→ `startWorkflowRun(MARKET_INTEL)`),
  `generate-kernel` (→ kernel run + gate) — all sharing the campaign-brief route
  authz predicate. Allowlist the **registered** ids in the agent pack.
- `brand/agentTools.ts` (**new**): read tools `list-brands`, `resolve-voice`,
  `compliance-check` sharing the brand route authz predicate.
- Lint extension in `test/agent-prompt-tool-ids.test.ts`: allowlist ⊆
  `builtinAgentToolIds()`.
- One approval kind + `workflow_run` turn wiring for research/kernel runs; one
  approval kind for creative-brief approve.
- **No new nodes** — extract-voc / generate-angles / build-targeting /
  generate-kernel already exist; they only lack an igniter.

## Phased plan (gated on real gates)

- **P1 — tripwire first (compliance seam before demolition).** Extend the
  `agent-prompt-tool-ids` lint to require projection. This turns the two toothless
  agents RED honestly. Gate: backend vitest. `/code-review`.
- **P2 — make the personas tool-real (reads).** Register brand + campaign-brief
  **read** tools sharing route authz; allowlist them. Brand Steward becomes
  honest immediately (it is a read/advise persona). Gate: lint green +
  `/code-review` + `/ux-review`.
- **P3 — ignite the pipeline (actions).** Register `research.run` +
  `generate-kernel` action tools that `startWorkflowRun` and emit the
  authoritative `workflow_run` turn; approvalGate renders in the parent run. Now
  #4/#5 are real; the FE deep-links become honest. Gate: an ignition test (a run
  is created + the turn appears) + `/code-review` + `/ux-review`.
- **P4 — reconcile the approval.** Move creative-brief review→approve onto the
  reviews-inbox approval kind; demolish the bespoke button with its regression
  pin. Gate: `/code-review` + `/ux-review`.

## Deferred honestly

- **Kernel's real consumer may live outside E2.** If the channel-fanout feature
  (campaign-channels, a different unit) is the intended igniter of
  `generate-kernel` via ADR 0157/0158, that cross-feature coupling must be made
  explicit — it is not assumed here. Filed as a cross-feature TODO; within E2 the
  kernel is unreachable.
- **Reel chat-drivability.** The reel already rides the engine via a route
  igniter (honest). Wrapping it in an agent action tool is polish, deferred.
- **VOC / angles / targeting curation pages** stay empty-by-construction until
  P3 ignites their producing nodes; they are PAGE-LEGIT and honest (real reads,
  honest empty state) — not painted green.
