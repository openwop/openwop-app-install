# Production Intelligence (unit D4) — chat-first port review

**Scope:** `backend/typescript/src/features/production` + `frontend/react/src/features/production` (ADR 0172). Reviewed read-only against the app's real primitives.

**Headline:** The feature is a well-built, correctly-bounded *page + engine* surface — the Vendor Directory, the KB mirror, the artifact type, and plan-generation **inside the campaign spine** all ride real owners. But its **marquee chat capability is theater**: the Production Planner agent's `toolAllowlist` names two nodes that the runtime agent-tool provider never resolves, so the agent is offered **zero tools** in chat. Every "Plan with AI" affordance leads to an agent that can only hallucinate a plan in prose — nothing is built, persisted, or rendered as an artifact.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Manage Vendor Directory (list/create/edit/delete/portfolio, pricing editor) | REST CRUD (`routes.ts:76-184`) + bespoke admin page (`ProductionPage.tsx:109-305`) | **PAGE-LEGIT** | Keep. Reference-data admin over a net-new store; forms are structural data entry, not a substitute for a chat primitive. |
| Vendor pricing field-redaction (editors+ only) | `vendorRedaction.ts:22` shares `resolveEffectiveAccess`; applied by route + surface + KB | **RIDES** (access control) | Leave. Fail-closed, one helper, three consumers. |
| Vendors mirrored to KB for agent retrieval | `productionKnowledgeService.ts` over `kbService` (createCollection/upsertDocument), deterministic ids, toggle-gated, fail-open | **RIDES** (KB owner) | Leave. Instantiates the owner; no shadow store. |
| `production.plan` artifact rendered in the workbench | `artifactTypes.ts:81` `registerArtifactType` (AJV-validated, run-output, ADR 0055/0083) | **RIDES** (artifact registry) | Leave. |
| `ctx.features.production` workflow surface | `surface.ts:41` thin adapter over `productionService` + `productionContext` | **ADAPTER** | Leave; watch for drift. Projects internal columns out, applies redaction, one write (`savePlan`). |
| Generate a production plan **inside the campaign spine** | `orchestrationWorkflow.ts:74` slots `feature.production.nodes.plan-generate` as a real node in the registered `CAMPAIGN_ORCHESTRATION` builtinWorkflow | **RIDES** (real workflow run) | Leave. role:action, recorded output, replay/fork-safe, idempotent `pln:run:<runId>`, skips honestly when toggle off (`index.mjs:73-76`). |
| View generated plans (list + detail, deep-link `?plan=`) | REST reads (`routes.ts:187-205`) + `PlansTab`/`PlanDetail` | **PAGE-LEGIT** | Keep; honesty loop is complete (every field reads from the durable `ProductionPlan`). |
| Advance plan lifecycle status (approve → in_production → completed) | Bespoke buttons (`ProductionPage.tsx:434-444`) → `POST …/plans/:id/status` → `transitionPlan` | **PAGE-LEGIT** (advisory) | Keep, with a tripwire: the plan is decoupled + advisory (confers no authority, gates no run), so this is bookkeeping, not a HITL gate. If it ever gates the campaign spine, it MUST become a shared approval kind (see Blocker B2). |
| **AI production planning via the chat ("Plan with AI")** — Production Planner agent builds context | `feature.production.agents` allowlists `openwop:feature.production.nodes.context-build`; page deep-links `navigate('/?agent=…production-planner')` (`ProductionPage.tsx:338`) | **THEATER** | Register the read as a `registerFeatureAgentTool` (Blocker B1). |
| **AI production planning via the chat** — Production Planner agent generates + persists the plan | allowlists `openwop:feature.production.nodes.plan-generate`; prompt tells the model to call it (`prompts/production-planner.md:10-15`) | **THEATER** | Ship an agent tool that **ignites a run** of a small production-plan workflow (Blocker B1). |

**VERDICTS: R=4 A=1 P=0 T=2 PL=3**

---

## Blockers (from scouting) — each with the honest alternative

### B1 — The Production Planner agent is offered ZERO tools in chat (the whole "Plan with AI" path is theater)

**The chain, pinned:**

1. The agent pack declares `toolAllowlist: ["openwop:feature.production.nodes.context-build", "openwop:feature.production.nodes.plan-generate"]` (`packs/feature.production.agents/pack.json:21-24`) and the prompt instructs the model to call both (`prompts/production-planner.md:10-15`).
2. The chat tool loop compiles an agent's tools as `compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, …)` (`conversationToolLoop.ts:304`).
3. `compileAgentTools` → `filterTools([...availableTools], allow)` → `available.filter(t => allow.has(t))` (`agentDispatch.ts:488, 185-189`). **`available` is `builtinAgentToolIds()` — the keys of the `BUILTINS` map only.**
4. `BUILTINS` (`agentToolProvider.ts:412-421`) = the six static builtins + RAG retrievers + `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` + anything a feature registers via `registerFeatureAgentTool`. `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` is **only** `feature.insights-suite.nodes.variance-compute` and `…talent-score` (`agentToolProvider.ts:45-48`).
5. Production ships **no `agentTools.ts` and never calls `registerFeatureAgentTool`** (grep of `features/production` = empty; contrast the 23 features that do). Its two node ids are therefore **not in `builtinAgentToolIds()`**, so `filterTools` drops them, `resolveAgentTools` (`agentDispatch.ts:459-470`) emits an empty list, and the model is handed no tools.

**Net effect:** when a user clicks "Plan with AI" (`ProductionPage.tsx:349, 355`) and lands in the chat scoped to this agent, the model can only produce a prose "plan." No `plan-generate` run fires, no `ProductionPlan` row is written, no `production.plan` artifact is emitted, nothing appears in the Plans tab. The ADR's central claim — "the chat-drivable path (ADR 0058), no bespoke panel … chat-drivability = agent + nodes" (`0172:226, 242-243`) — **was declared but the runtime bridge was never built.**

**Why the parity test stays green (false comfort):** `agent-prompt-tool-ids.test.ts` builds its "universe" from *pack-declared node typeIds* (`test:36`), so both ids resolve as declared nodes and the lint passes. The test pins "this id is a real node," **not** "the chat loop can offer this node as a tool." This is a platform-wide tripwire gap, not just a production bug (filed as TODO T1 below).

**Honest alternative (the `registerFeatureAgentTool` pattern the other 23 features use):** add `features/production/agentTools.ts`, called from `feature.ts` init, registering two tools whose ids match the allowlist:

- `openwop:feature.production.nodes.context-build` → a **read** tool wrapping `buildProductionContext` via the surface; shares the route's `authorizeOrgScope`/`canSeeVendorPricing` predicate; fails EMPTY without an acting user (the ADR 0308 read-tool rule).
- `openwop:feature.production.nodes.plan-generate` → an **action** tool. Because plan-generate does an AI call + a durable write + an artifact emission (it is **not** a pure compute node — so it cannot ride the `computeNodeTool` projection, which is documented for "PURE compute nodes … minimal synthesized ctx," `agentToolProvider.ts:35-42`), the correct target is a tool that **`startWorkflowRun`s a small single-node production-plan workflow** and posts the authoritative `workflow_run` conversation turn — so the plan is generated *inside a run* (recorded, replay/fork-safe, artifact emitted through the run envelope), exactly as the campaign spine already does. This preserves the ADR's own "generation is a run" invariant (`0172:112, 252`) for the chat path too, instead of the current chat path that generates nothing.

Keep the ids byte-identical to the allowlist and the prompt so the parity test and the model's vocabulary stay aligned.

### B2 — Plan "approve" is a bespoke button, but the plan gates nothing (advisory-only)

`PlanDetail` renders Approve / Mark in production / Mark completed buttons (`ProductionPage.tsx:434-444`) driving `transitionPlan` (`productionService.ts:402-414`), which is documented "advisory-only … no side-effects." This is **not** a HITL gate (no run suspends on it; the campaign spine has its own `kernel-approve` gate). So it is acceptable as page-level bookkeeping today — **but** it is a latent PARALLEL to the approvals/reviews owner. Honest rule to encode: if plan approval ever becomes a precondition for anything (spend, spine progression, vendor outreach), it must migrate to a shared approval kind rendering in the reviews inbox with a durable decision record — never grow side-effects behind this button.

---

## Demolition list (with regression pins to add)

Production has **almost nothing to demolish** — it is page-shaped where it should be. The one demolition is conditional on B1 landing:

- **None of the Vendor Directory or Plans UI is a demolition target** — both are PAGE-LEGIT (reference-data admin + read-only plan view). Keep.
- **After B1:** the "Plan with AI" affordances (`ProductionPage.tsx:338, 349, 355`) stay (they correctly deep-link the ONE chat, no second panel) — but they only become *honest* once the agent tools resolve. Pin a regression test: **an integration test asserting the Production Planner's compiled tool list is non-empty** (`compileAgentTools(productionPlanner, builtinAgentToolIds(), provider.resolveTool, …).length === 2`). This is the test that would have caught B1 and prevents a re-regression if someone removes the tool registration.

No bespoke "talk to AI" textarea, no shadow chat, no parallel roster/identity/store were found (the ADR's boundary discipline holds — `0172:247-249`).

---

## New-code inventory (small)

1. `backend/typescript/src/features/production/agentTools.ts` — two `registerFeatureAgentTool` registrations (context-build read; plan-generate action). Ids identical to the allowlist. ~1 file.
2. A single-node **production-plan workflow** (or reuse of the existing `plan-generate` node wrapped by `startWorkflowRun`) so the chat action tool ignites a real run + posts the `workflow_run` turn. ~1 small workflow def, or reuse.
3. `feature.ts` — call the new `registerAgentTools()` from init (one line).
4. **Reads:** none new — `buildProductionContext` + `savePlan` already exist; the tools compose them.
5. **Tests:** the compiled-tool-list regression pin (above) + one chat-loop integration test that the plan-generate tool call writes a `ProductionPlan` and emits the artifact.

---

## Phased plan (gated on real gates; compliance/bridge first, never demolish before replacement works)

- **Phase 1 — Bridge the agent (B1).** Add `agentTools.ts` + `feature.ts` wiring so the two allowlisted ids resolve in `builtinAgentToolIds()`. Read tool shares `authorizeOrgScope`/`canSeeVendorPricing`; action tool ignites a run. Close with `/code-review` (authority-parity: tool predicate == route predicate) + `/ux-review` (the chat "Plan with AI" flow now produces a real plan + artifact). Gate: backend vitest + the new non-empty-tool-list test green.
- **Phase 2 — Tripwire the platform gap (TODO T1).** Extend `agent-prompt-tool-ids.test.ts` (or add a sibling) to assert every agent pack's `toolAllowlist` id resolves against the **runtime** `builtinAgentToolIds()` surface, not just the declared-node universe — so the next toothless agent fails CI instead of shipping. Repo-wide; coordinate (this is a cross-cutting seam, filed as a TODO not a local workaround).
- **Phase 3 — Encode the B2 rule.** Add an ADR correction note to 0172 that plan-status is advisory-only and must become a shared approval kind if it ever gates anything. No code change unless the gating requirement appears.

---

## Deferred honestly

- **Portfolio-media byte extraction into KB** (OCR/transcription) — the ADR marks it a documented follow-on (`productionKnowledgeService.ts:16-19`), not built. Correctly deferred-visibly; only capability names/descriptions are indexed today. No theater.
- **`ctx.features.profiles` surface** — deferred by ADR (Alt. 5, `0172:277-279`); the in-package `listProfiles` read is honest and sufficient. Not a port blocker.
- **Plan lifecycle side-effects** — intentionally none in v1 (`productionService.ts:401`). Advisory status is honestly labeled as such; do not paint it as an approval that does anything until B2's rule is met.
