# Campaign Connectors & Intel (unit E4) — chat-first port review

Scope: `backend/typescript/src/features/{campaign-connectors,campaign-intel}` +
`frontend/react/src/features/{campaign-connectors,campaign-intel}` + the packs
`feature.campaign-connectors.nodes`, `feature.campaign-intel.{nodes,agents}`, and
the `core.openwop.workflows.campaign-sync` workflow-chain pack.

**Headline:** the read/import/sync/apply surfaces are honest and mostly ride the
engine — but the unit's *marquee* capability, "Ask the Campaign Intelligence
Analyst in chat" (ADR 0160's whole reason to exist), is **THEATER**: the analyst's
three allow-listed tools are never projected into the chat tool catalog and
*cannot* be (they are surface-backed, not pure-compute), so the agent is
dispatched in chat with **zero tools**. The drift ships green because the pinning
test asserts the allow-list string, not that the string resolves to a real tool.

---

## Step 1 — Contract scouting (pinned evidence)

### The chat dispatch tool catalog is a fixed map + a two-entry compute allowlist
The chat conversation loop compiles an agent's tools from `builtinAgentToolIds()`
filtered by the agent's `toolAllowlist`:

- `conversationToolLoop.ts:304` — `compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, effectiveToolAllowlist(agent.toolAllowlist, …))`.
- `compileAgentTools` is a **set intersection** — `agentDispatch.ts:487-488`:
  `resolveAgentTools(filterTools([...availableTools], allow), resolveTool)`. Tools
  in the allow-list but absent from `availableTools` are **silently dropped**.
- `builtinAgentToolIds()` = `[...BUILTINS.keys()]` (`agentToolProvider.ts:426-427`).
- `BUILTINS` = the fixed built-ins **plus** `PROJECTABLE_COMPUTE_NODE_TYPE_IDS.map(computeNodeTool)` (`agentToolProvider.ts:421`).
- `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` is an **explicit two-entry allowlist**
  (`agentToolProvider.ts:45-48`): only
  `feature.insights-suite.nodes.variance-compute` and `…talent-score`.

### The Campaign Intelligence Analyst's tools are none of those
- `packs/feature.campaign-intel.agents/pack.json` `toolAllowlist`:
  `openwop:feature.campaign-intel.nodes.{budget-optimize,forecast,plan-budget}`.
- None of those three ids are in `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`, none are
  fixed built-ins, and **campaign-intel registers no `registerFeatureAgentTool`**
  (no `agentTools.ts` in the package — confirmed: `ls src/features/campaign-intel`
  has only `attribution/budgetPlanner/feature/intelligence/pacing/routes/surface`).
  Contrast the features that *do* bridge a surface into chat tools —
  `goals`, `cdp`, `projects`, `task-deck`, `kicktodo-core`, `slides`, `bi`,
  `documents`, `intent-ledger` all ship a `registerFeatureAgentTool` `agentTools.ts`.
- ∴ `filterTools(builtinAgentToolIds(), analyst.toolAllowlist) = ∅`. The analyst
  runs in chat with **no tools**.

### Even the projection that exists cannot run these nodes
`computeNodeTool` synthesizes a bare `NodeContext` with **no `features` surface**
(`agentToolProvider.ts:62-72` — `inputs/config/configurable/secrets/emit` only).
The intel nodes hard-require `ctx.features['campaign-intel']`:
`packs/feature.campaign-intel.nodes/index.mjs` `ensureIntel(ctx)` throws
`host_capability_missing` when `ctx.features['campaign-intel']` is absent — and
`campaign-intel.test.ts:63-64` pins exactly that fail-closed behavior with
`{ features: {} }`. So adding these node ids to the compute allowlist would only
turn "silent drop" into "every call throws `host_capability_missing`". The nodes
are **surface-backed, not pure compute**; the compute-projection path is the wrong
lane by construction.

### The pinning test locks the drift in place
`campaign-intel.test.ts:84-87` ("loads the Campaign Intelligence Analyst") asserts
`loaded[0].toolAllowlist` *contains* `openwop:feature.campaign-intel.nodes.budget-optimize`
— but **never asserts that id is dispatchable** (never intersects it with
`builtinAgentToolIds()` or a registered-tool set). The allow-list→catalog gap is
green today. This is the exact cross-cutting pattern flagged for the whole sweep.

### What DOES ride the engine (contrast)
- The `campaign-sync` **workflow-chain pack is boot-loaded and executes on the
  real executor**: `test/workflow-chain-campaign-sync-execution.test.ts:150-151`
  ("chain must be loaded at boot") drives `campaign-sync.daily-metrics` (sync node
  → `core.openwop.integration.notification-push`) and `campaign-sync.pacing-check`
  end-to-end. It is schedulable on the ONE scheduler (RFC 0013) — a real igniter.
- The `/sync`, `/audience-sync`, `.../conversions/dispatch`, and
  `/recommendations/apply` routes all go through the shared governed
  `makeAdsAdapter` broker with its approval/spend gates (`routes.ts:59,93,138` in
  connectors; `campaign-intel/routes.ts:122-135`). No second ads client, no forked
  egress.
- Every route shares one org-scope predicate — `requireOrgScopeFor` /
  `authorizeOrgScope` (`campaign-connectors/routes.ts:33-38,110`;
  `campaign-intel/routes.ts:34-39`) — a clean authority spine to reuse for tools.

### Constraint that bounds the port
Chat tools for these features **must** be registered via `registerFeatureAgentTool`
(`agentToolProvider.ts:441-442`) and share the routes' `requireOrgScopeFor`
predicate (read tools fail EMPTY, action tools fail typed), NOT projected through
`computeNodeTool`. The node pack stays as-is for workflow/scheduler use.

---

## Step 2 — Capability inventory + verdicts

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| C1 | Import ad-platform CSV → performance store | page modal + `POST /import` + `import-csv` node (`connectors/routes.ts:211`; `CampaignConnectorsPage.tsx:177`) | **PAGE-LEGIT** | keep the paste-CSV intake form; node already rides the executor |
| C2 | Live "Sync Now" (pull yesterday's metrics) | button → `POST /sync` → `makeAdsAdapter`; `sync` node; `campaign-sync.daily-metrics` boot chain (`connectors/routes.ts:47`; `campaign-sync/pack.json`) | **RIDES** | none — real chain on the ONE scheduler + CAS cooldown (`surface.ts:33`) |
| C3 | Segment → hashed ad audience | `POST /audience-sync` + `audience-sync` node behind the adapter's approval gate (`connectors/routes.ts:78,97`) | **RIDES** | none — approval gate owns the upload |
| C4 | Dispatch queued conversions (Meta CAPI / TikTok) | `POST /orgs/:o/conversions/dispatch` → `adapter.sendConversion` (`connectors/routes.ts:133-156`) | **ADAPTER** | none — thin wrapper over governed egress; watch for drift |
| C5 | Public pixel loads + conversions relay intake | consent-gated public routes (`connectors/routes.ts:169,186`) | **PAGE-LEGIT** | keep — honest consent-fenced public endpoints |
| C6 | Pixel config CRUD | `PixelsCard` + `GET/PUT/DELETE …/pixels` (`CampaignConnectorsPage.tsx:207`; `connectors/routes.ts:108-128`) | **PAGE-LEGIT** | keep — operator config surface |
| C7 | KPI summary + records read | page cards/table + `/kpi`,`/records` (`CampaignConnectorsPage.tsx:113`; `connectors/routes.ts:246,257`) | **PAGE-LEGIT** | keep; optional read-tool for analyst grounding |
| C8 | Budget-reallocation recommendations (read) | page table + `/budget` (`CampaignIntelPage.tsx:214`; `intel/routes.ts:45`) | **PAGE-LEGIT** | keep |
| C9 | Goal-based budget planner ("$X → N conv") | page form + `POST /plan-budget` (deterministic) (`CampaignIntelPage.tsx:146`; `intel/routes.ts:59`) | **PAGE-LEGIT** | keep the page form; ALSO expose via the analyst (see C14) |
| C10 | Forecast / creative-fatigue (read) | page list + `/forecast` (`CampaignIntelPage.tsx:285`; `intel/routes.ts:160`) | **PAGE-LEGIT** | keep |
| C11 | Attribution join (read) | page table + `/attribution` + `attribution` node (`CampaignIntelPage.tsx:261`; `intel/routes.ts:141`) | **PAGE-LEGIT** | keep |
| C12 | Budget pacing report + band alerts | page + `/pacing` (read) + `pacing-check` node via `campaign-sync.pacing-check` chain → notifications (`CampaignIntelPage.tsx:240`; `campaign-sync/pack.json`) | **RIDES** | none — alerts ride the scheduler + notifications owner |
| C13 | Apply a budget recommendation (governed write) | `POST /recommendations/apply` → `adapter.updateBudget` behind the spend/approval gate (`intel/routes.ts:109-137`) | **THEATER** | governed write with **no igniter** — no UI button, no chat tool, not in any chain; wire it |
| C14 | **Ask the Campaign Intelligence Analyst in chat** | deep-link `/?agent=…` + agent pack allow-listed to 3 nodes (`CampaignIntelPage.tsx:103`; `campaign-intel.agents/pack.json`) | **THEATER** | project the intel **surface** as `registerFeatureAgentTool` chat tools + repoint the allow-list |

**Counts: R=3, A=1, P=0, T=2, PL=8.**

---

## Step 3 — Port tests (the two failing capabilities)

**C14 — Ask the Analyst (THEATER).**
- *Interface test*: "how should I allocate $5k?" is **describing intent** → belongs
  in the ONE chat with a tool-bearing agent. The deep-link is correct (it reuses
  the ONE chat, no bespoke panel — good). The failure is agency, not interface.
- *Agency test*: **FAILS.** The persona exists but its ACTION/read tools resolve to
  nothing (`filterTools(builtinAgentToolIds(), allowlist) = ∅`). A persona with no
  tools driving nothing is the skill's textbook toothless agent. It will answer
  budget/forecast questions with **hallucinated numbers** (no read behind them).
- *Composition test*: the analysis lives in a real surface (`intelligence.ts`,
  `budgetPlanner.ts`) reachable by routes — the composition is fine; only the
  chat lane is missing.
- *Card-mechanism test*: N/A today (no card renders because no tool runs). After
  the port, tool results are plain assistant text / a typed recommendation — no
  A2UI needed.
- *Honesty-loop test*: **FAILS** — ADR 0160 §Implementation marks Phase 1 "✅ Done
  … answers NL budget/forecast questions through the one chat" (`0160…md:22,30,67`).
  No read backs that claim in chat. False green.

**C13 — Apply a recommendation (THEATER).**
- *Ignition test*: **FAILS.** `/recommendations/apply` is a governed one-click-apply
  route (the ADR 0357 P3 "ZERO new write paths" design) but **nothing calls it** —
  no frontend caller (`grep recommendations/apply frontend/…/campaign-intel` finds
  only comments/i18n), no chat tool, not in the sync chain. A governed write with
  no igniter reads as capability and delivers none.
- *HITL test*: the write path itself is correct — `adapter.updateBudget` returns
  `requires_approval` with an `approvalId` through the shared spend gate
  (`intel/routes.ts:129-136`). It just needs a button or an agent action tool to
  reach it.

All other capabilities pass their tests: authority-parity holds (one
`requireOrgScopeFor` gates every route); SSoT is the performance store read at
request time; lifecycle/retention is inherited (no new durable rows introduced by
the port).

---

## Blockers (with the honest alternative)

- **BLOCKER 1 — the intel nodes cannot be chat tools via node projection.**
  `computeNodeTool` gives a `ctx` with no `features` surface
  (`agentToolProvider.ts:62-72`); the intel nodes throw `host_capability_missing`
  without `ctx.features['campaign-intel']` (`index.mjs ensureIntel`;
  `campaign-intel.test.ts:63-64`). *Honest alternative:* do **not** touch
  `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`. Bridge the **feature surface** into chat via
  `registerFeatureAgentTool` (`agentToolProvider.ts:441`) — the sanctioned
  per-feature path every other AI feature uses (`goals`, `cdp`, `projects`…). Each
  tool calls the same `requireOrgScopeFor` predicate as its route; read tools fail
  EMPTY, action tools fail typed. The node pack stays for workflow/scheduler use.

- **BLOCKER 2 — the drift is invisible to the suite.**
  `campaign-intel.test.ts:84-87` pins the allow-list *string* but never asserts it
  resolves to a dispatchable tool, so the empty-tool analyst is green. *Honest
  alternative:* add a repo-wide parity tripwire (the `agent-prompt-tool-ids` /
  `promptCatalogParity` family precedent) asserting **every** manifest agent's
  `toolAllowlist ⊆ builtinAgentToolIds() ∪ registered-feature-tool-ids**. This is
  the cross-cutting fix the sweep needs — it would have caught this and any peer
  feature with the same drop.

---

## Demolition list (with regression pins)

Minimal — the pages are legitimately page-shaped and the unit already reuses the
ONE chat via deep-link (no bespoke "talk to AI" panel to demolish).

- **`/recommendations/apply` as a dangling route** — once C13 has an igniter (UI
  button and/or agent action tool), pin it: a test that the route is reachable
  from a real caller, and (optional) an ESLint/grep guard that a governed write
  route has at least one caller. If a resurrected bespoke apply-form appears,
  the parity test + the "one adapter" invariant should reject it.
- **Regression pin for C14**: the BLOCKER-2 parity tripwire *is* the demolition
  pin — it fails the moment an agent's allow-list references a non-dispatchable
  tool again.

No page removals: C1/C5–C11 are read/config/intake surfaces the skill classifies
as PAGE-LEGIT.

---

## New-code inventory (small)

1. `src/features/campaign-intel/agentTools.ts` — `registerFeatureAgentTool` for the
   intel surface: `budget-optimize`, `forecast`, `plan-budget` (and, for grounding,
   `anomalies`, `attribution`, `pacing`). Each resolves the acting user + org and
   calls the **same** `requireOrgScopeFor(orgId,'workspace:read')` used by the
   routes; the money/apply action shares `workspace:write`. Read tools fail EMPTY
   without an acting user (ADR 0315 baseline discipline).
2. Repoint `feature.campaign-intel.agents/pack.json` `toolAllowlist` to the
   `registerFeatureAgentTool` ids (bump the agents-pack version).
3. One repo-wide parity test (BLOCKER 2) — the tripwire.
4. C13 igniter: an "Apply" button on the budget-recommendation table calling
   `POST /recommendations/apply` **and/or** an analyst action tool `apply-budget`
   (behind the existing spend/approval gate) so the Analyst can propose→apply with
   the HITL card. Add i18n keys (en/es/fr/pt-BR) for any new button/tool copy.
5. (Optional) `campaign-connectors` KPI read tool so the Analyst can cite live
   performance when it reasons.

No new durable rows, no new owner, no new wire surface → **no RFC** (rides the
Accepted RFC 0095 broker + RFC 0013 chains, per ADR 0159/0160).

---

## Phased plan (gated on real gates; compliance seam first)

1. **Tripwire first.** Add the agent-allowlist⊆available-tools parity test. It goes
   **RED** immediately, proving the analyst drop (and surfacing any peer feature
   with the same defect). `npm run ci`.
2. **Bridge the surface.** Ship `campaign-intel/agentTools.ts` + repoint the pack
   allow-list. The tripwire goes GREEN; the Analyst now reads the performance store
   and answers with real numbers in the ONE chat. Add a test that a dispatched
   analyst turn actually invokes `budget-optimize`/`forecast` (not just that the
   pack loads). `( cd backend/typescript && npm test )`.
3. **Ignite C13.** Wire the "Apply" button (+ optional analyst `apply-budget`
   action tool) to `/recommendations/apply`; assert the `requires_approval` path
   renders the shared spend-gate HITL. `( cd frontend/react && npm run build )`.
4. Close each phase with **/code-review + /ux-review**; apply fixes. Then
   `/grade-ai-exchange` to update `docs/steward/LLM-EXCHANGE-AUDIT.md` with the new
   tool-mediated analyst surface + its parity tripwire row.

---

## Deferred honestly

- **Live OAuth sync beyond meta/google** is already honest-off — the `sync` node
  returns `connector_not_configured` for other platforms and CSV import is the
  path (`feature.campaign-connectors.nodes/pack.json`; toggle description).
  No new deferral is introduced by this port.
- **No `campaign-sync` schedule is seeded** — the chain is boot-loaded and
  runnable, but nothing auto-schedules it, so pacing/metrics stay fresh only if an
  operator schedules it or clicks "Sync Now". This is a legitimate scheduler-driven
  design (RIDES), noted so it is not mistaken for automatic freshness. Not a blocker
  for the chat-first port; a candidate follow-up (seed a default daily schedule).

---

SLUG: e4-campaign-connectors-intel
