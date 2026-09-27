# Merchandising (unit E8) — chat-first port review

**Scope:** `backend/typescript/src/features/{discovery, recommendations, promotions}`
+ `frontend/react/src/features/{product-discovery, recommendations, promotions}`
+ the six packs `feature.{discovery,recommendations,promotions}.{nodes,agents}`.
Context: MERCH-A recommendations/upsell/FBT (ADR 0273), MERCH-B promotions +
loss-leader (ADR 0274), MERCH-C discovery search/collections/merch-rules (ADR 0275).

**Headline:** The engine-composition layer of this unit is genuinely good — the
promotion checkout discount rides the commerce order path via a hook, the affinity
sweep reuses the bounded-interval pattern, and every REST route is RBAC/IDOR-gated
over a real single-source-of-truth service. But the **entire "chat-first" story is
theater**: all three feature agents (Discovery Curator, Merchandiser, Promotions
Manager) declare `toolAllowlist`s of node typeIds that are **never projected into
conversational tools**, so at dispatch every one of their tools is silently dropped
— toothless personas that load, respond, and can do *nothing*. No workflow, seed,
schedule, or chat surface ever creates a run of the three node packs. The pack
descriptions' claim "Driven through the ONE chat (EmbeddedChatPanel scoped by
agentId)" is false in every consumer: no page embeds chat or deep-links an agent.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| A1 | Recommendation placements (create/list/toggle/delete slot→source, segment, holdout) | Bespoke admin form + REST (`recommendations/routes.ts:49-96`, `RecommendationsPage.tsx:125-157`) | **PAGE-LEGIT** | Keep the management list/toggle/delete; move *authoring* to the Merchandiser agent (see A4) |
| A2 | Resolve/preview recs — operator preview + public storefront resolve | REST (`recommendations/routes.ts:99-130`) | **PAGE-LEGIT** (read/projection) | Keep; public route's no-`contactId` IDOR invariant is correct |
| A3 | Affinity rebuild (6h daemon + manual button) | Feature-owned unref'd interval, the `reservationSweep` clone (`affinityRebuild.ts:32-50`) | **RIDES** | Leave alone — no parallel scheduler primitive |
| A4 | **Merchandiser agent: chat-drive resolve + author placements** | Agent pack whose tools are dropped at dispatch (`feature.recommendations.agents/pack.json:24-28`) | **THEATER** | Register the surface fns via `registerFeatureAgentTool`; deep-link/embed the agent |
| B1 | Promotions CRUD (create cart_threshold/product_discount/loss_leader, list, toggle active, delete) | Bespoke admin form + REST (`promotions/routes.ts:23-71`, `PromotionsPage.tsx:112-153`) | **PAGE-LEGIT** | Keep management list; authoring → agent (B4); *activation* → reviews inbox (B5) |
| B2 | Checkout discount application | Composes the commerce order path via `promotionSeam` hook, delta after `resolvePrice`, no-op when off (`promotions/feature.ts:24-26`, `promotionsService.ts:284-293`) | **RIDES** | Leave alone — textbook additive composition |
| B3 | Apply-preview (hypothetical cart discount) | Read surface + node (`promotions/surface.ts:30-35`) | **PAGE-LEGIT** (read) | Keep; becomes a Promotions-Manager tool once B4 is real |
| B4 | **Promotions Manager agent: list/preview/draft-proposed promotions** | Agent pack whose tools are dropped at dispatch (`feature.promotions.agents/pack.json:25-29`) | **THEATER** | Register surface fns; the `create`→`active:false` "proposed" firewall (`promotions/surface.ts:37-46`) is sound but currently dead |
| B5 | "Agent proposes, human confirms" activation of a money-moving promotion | Bespoke list toggle → `updatePromotion({active:true})` (`PromotionsPage.tsx:70-73`) | **PARALLEL-risk** (deferred) | When B4 is live, a proposed promotion should surface as an approval in the reviews inbox, not require hunting the list |
| C1 | Collections (create manual/dynamic, list, delete) | Bespoke admin form + REST (`discovery/routes.ts:38-62`, `DiscoveryPage.tsx:124-153`) | **PAGE-LEGIT** | Keep management; authoring → agent (C5) |
| C2 | Merch rules (pin/boost/bury/hide, list, delete) | Bespoke admin form + REST (`discovery/routes.ts:65-80`, `DiscoveryPage.tsx:155-168`) | **PAGE-LEGIT** | Keep management; authoring → agent (C5) |
| C3 | Faceted search — operator preview + public storefront search | REST (`discovery/routes.ts:93-121`) | **PAGE-LEGIT** (read) | Keep; toggle-honest empty on OFF tenant is correct (`routes.ts:113-114`) |
| C4 | Semantic embedding index rebuild + invalidation | Manual REST + in-mem index seam (`discovery/routes.ts:83-90`, `productEmbeddingIndex.ts`) | **ADAPTER** | Leave; watch for drift (lexical/embedding approximation, no vector DB — honest) |
| C5 | **Discovery Curator agent: chat-drive search + author collections/rules** | Agent pack whose tools are dropped at dispatch (`feature.discovery.agents/pack.json:23-27`) | **THEATER** | Register surface fns; deep-link/embed the agent |

**Totals: R=2 A=1 P=0 T=3 PL=7** (P counted 0 — the one parallel concern, B5, is a
*prospective* risk that only bites once B4 is revived; recorded as deferred, not a
live second implementation).

---

## Blockers (from scouting) — each with the honest alternative

### BLOCKER 1 (severity: this is the whole unit) — the node-pack tools are never projected into chat, so all three agents are toothless

The dispatch tool surface is `builtinAgentToolIds()` — the keys of the `BUILTINS`
map (`agentToolProvider.ts:426-428`, `:413-422`). That map contains only
`knowledge.search`, `schema.lookup`, `ai.research.web`, `http.fetch`, `code-exec`,
`kanban.add-todo`, the RAG retrievers, and **exactly two** projected compute nodes
(`PROJECTABLE_COMPUTE_NODE_TYPE_IDS = insights-suite.variance-compute /
talent-score`, `:45-48`). The merch node typeIds are in none of these, and **no merch
feature calls `registerFeatureAgentTool`** (`discovery/feature.ts`,
`recommendations/feature.ts`, `promotions/feature.ts` register routes + seams only —
grep for `registerFeatureAgentTool` across the three dirs is empty; the 23 features
that *do* call it are listed in the scout log).

Consequently:
- `compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, …)`
  (`conversationToolLoop.ts:304`) §A14-filters the agent's allowlist against
  `availableTools`, and the merch ids aren't in `availableTools` → filtered out
  (`agentDispatch.ts:185-188`).
- Even if they survived the filter, `resolveTool(name)` reads `BUILTINS.get(name)?.def`
  (`agentToolProvider.ts:505`) → `undefined` → "Tools the host can't describe … are
  silently dropped" (`agentDispatch.ts:457-467`).

The agents themselves DO load into the `AgentRegistry` (`agentLoader.ts:129-160` →
`agentRegistry.installAgents`), so the persona is selectable and will chat back — it
just has an **empty effective tool set** and can never search, author a collection/
rule/placement, preview, or draft a promotion. This is the skill's THEATER definition
#2 ("an agent whose tools can't act") exactly, and the repo-wide pattern the lead
flagged.

**Honest alternative:** each feature ships an `agentTools.ts` (the documents / goals /
cdp precedent, `registerFeatureAgentTool` at `agentToolProvider.ts:441-443`) that
registers one `BuiltinTool` per node, delegating to the **same surface fns** the nodes
and REST routes already call (`discovery/surface.ts`, `recommendations/surface.ts`,
`promotions/surface.ts`), and sharing the routes' `authorizeOrgScope` access predicate
(the LLM-EXCHANGE rule: one helper, route + tool both call it). The node-pack
`index.mjs` + workflow nodes stay untouched for workflow runs — the chat tool is a
sibling registration, not a replacement.

### BLOCKER 2 — chat tools need an `orgId` the chat scope does not carry

Every surface fn takes an `orgId` (`discovery/surface.ts:16`, `recommendations/surface.ts:33`,
`promotions/surface.ts:27`); the node path gets it node-supplied. But the chat call
scope is `{ tenantId, runId, agentProfileId?, actingUserId?, conversationId? }`
(`agentToolProvider.ts:471-483`) — **no `orgId`**. A registered chat tool must either
take `orgId` as a tool arg (model-supplied, validated against the acting user's
org-scope) or resolve the sole org for the tenant.

**Honest alternative:** accept `orgId` as a required tool arg and validate it through
the same `authorizeOrgScope`/`getOrg` predicate the routes use (`discovery/routes.ts:11`,
`:111`); default to the tenant's single org when there is exactly one (the common
demo case). Fail typed (never empty) on ambiguity — the ADR 0308 acting-user pattern.

### BLOCKER 3 — no chat surface or deep-link exists; the pack descriptions claim one that isn't there

All three pack manifests advertise "Driven through the ONE chat (EmbeddedChatPanel
scoped by agentId) — no second panel" (e.g. `feature.recommendations.agents/pack.json:3`),
but **none of the three frontend pages import `chat/` or `EmbeddedChatPanel`, and none
deep-link `/?agent=`** (`DiscoveryPage.tsx`, `RecommendationsPage.tsx`,
`PromotionsPage.tsx` are pure form/table surfaces). The claim has zero consumers.

**Honest alternative:** add a per-page entry point — a "Curate with AI" / "Tune
recommendations" / "Draft a promotion" action that either deep-links
`navigate('/?agent=feature.discovery.agents.curator')` (the agents-page precedent in
CLAUDE.md) or renders the shared `chat/EmbeddedChatPanel` scoped to the agentId (the
`builder/CreateWithAiPanel` reference consumer). Never a bespoke textarea.

### BLOCKER 4 (deferred) — promotions "human confirm" bypasses the shared HITL machinery

The money-moving firewall is real on the write side (`promotions/surface.ts:43` forces
`active:false`, "never auto-live from a run"), but the confirm side is a bespoke list
toggle (`PromotionsPage.tsx:70-73` → `updatePromotion({active:true})`). There is **no
approvals/reviews/interrupt usage anywhere in the three features** (grep for
`approval|reviews|interrupt|suspend` across all three service dirs is empty). Today
that's moot because the agent can't author anything (Blocker 1); it becomes a PARALLEL
against the approvals owner the moment B4 is revived.

**Honest alternative:** when a run/agent authors a proposed promotion, emit a reviews-
inbox approval card (the challenge-publish / strategy-CDP precedent) whose approval
flips `active:true`; keep the page toggle as the manual operator override.

---

## Demolition list (with regression pins to add)

The bespoke pages are **PAGE-LEGIT management surfaces** and mostly stay — this unit's
problem is *missing* chat wiring, not a duplicated primitive. Demolitions are narrow:

| Demolish / change | Why | Regression pin |
|---|---|---|
| The "no consumer" chat claim in the 3 agent-pack descriptions (`feature.*.agents/pack.json:3`) | Dishonest until Blockers 1-3 close | A test asserting each merch agent, dispatched with `builtinAgentToolIds()` ∪ registered tools filtered by its allowlist, compiles a **non-empty** tool set (this is the exact silent-drop catch; `merchandising-packs.test.ts` currently only asserts the allowlist *strings*, `:85-91`, never that they *resolve*) |
| (After chat authoring lands) the create-forms on the 3 pages MAY slim to a chat entry point | Authoring by intent → chat | Test that no bespoke "talk to AI" textarea is introduced (the AiAuthorPanel regression); the management list/toggle/delete stays |
| (B5) the promotions page toggle as the *only* activation path | Money-moving confirm belongs in reviews inbox | Test that an agent-authored proposed promotion produces an approval record, not just an inactive row |

No table/list/preview/public-storefront surface is demolished — those are legitimate
pages and projections.

---

## New-code inventory (small)

1. **3 × `agentTools.ts`** (`discovery/`, `recommendations/`, `promotions/`) — each
   registers its nodes as `registerFeatureAgentTool` `BuiltinTool`s delegating to the
   existing surface fns; ~1 thin wrapper per node (8 tools total). Read tools fail
   EMPTY, action tools fail typed; all share the routes' `authorizeOrgScope` predicate.
2. **One `orgId` resolver helper** (accept-arg-or-sole-org), reused by all three.
3. **Frontend:** one entry point per page deep-linking `/?agent=<id>` or embedding
   `EmbeddedChatPanel` — reuse only, zero new chat code.
4. **Promotions:** a reviews-inbox approval emission on agent-authored proposed
   promotions (Phase 3).
5. **Tests:** the per-agent non-empty-toolset dispatch regression (the headline pin).

No new node packs, no new workflow, no new scheduler, no new owner — the composition
layer is already correct.

---

## Phased plan (gated on real gates; compliance seams first, never demolish before the replacement works)

- **Phase 1 — make the agents able to act (backend, no UI).** Add the 3 `agentTools.ts`
  registrations + the shared `orgId`/authz helper + the non-empty-toolset regression
  test. Gate: a chat tool loop with each agent executes a real search/author/preview/
  draft against its surface. Close with `/code-review` + `/grade-ai-exchange` (the tools
  must share the route predicate and fail typed). *Corrects Blocker 1, 2.*
- **Phase 2 — reach the agents from the product (frontend).** Add the per-page "Curate
  with AI / Tune recommendations / Draft a promotion" entry point (deep-link or
  `EmbeddedChatPanel`); update the 3 pack descriptions to reflect the now-true chat
  path. Gate: `/ux-review`. *Corrects Blocker 3.*
- **Phase 3 — promotions money-confirm through the reviews inbox.** Route agent-authored
  proposed promotions to an approval card; approval flips `active:true`; keep the page
  toggle as manual override. Gate: `/code-review`. *Corrects Blocker 4 / B5.*
- **Phase 4 — honesty sweep.** `/grade-code` + `/grade-data` over the ported unit;
  verify no page's create-form silently duplicates the chat authoring; confirm lifecycle
  seams (`onProductDeleted` pruning, `discovery/feature.ts:22-24`, `promotions/feature.ts:29-31`)
  still hold. Apply fixes.

---

## Deferred honestly

- **Semantic search is a lexical/embedding approximation, not a vector DB.**
  `productEmbeddingIndex.ts` builds an in-memory index; there is no external vector
  store on this host. Already honest in code — keep it deferred-visibly, don't paint it
  as production semantic search.
- **Public-storefront personalization is deliberately inert** (no `contactId` on the
  public resolve — `recommendations/routes.ts:113-130`, the ADR 0273 IDOR invariant).
  Not a gap; keep.
- **B5 reviews-inbox approval** is deferred to Phase 3 and depends on Phase 1 landing
  first (no agent authoring ⇒ nothing to approve). Stated, not faked.
