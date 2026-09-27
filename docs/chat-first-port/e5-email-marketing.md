# Email Marketing (unit E5) — chat-first port review

**Scope:** `backend/typescript/src/features/email/` + `frontend/react/src/features/email/`
(ADR 0019, the ENGAGE leg — templates + campaigns over CRM contacts, consent-gated
sends, engagement tracking). Toggle `email`, off by default, `dependsOn: ['crm']`
(`backend/typescript/src/features/email/feature.ts:23-39`).

**One-line verdict:** Email already rides the engine for its real write path
(`createDraftCampaign`, ignited by the campaign-channels `publishEmail` workflow node)
and correctly rides the consent/suppression/retention owners; its single chat-first
liability is the **copywriter agent, which is theater** — its declared tools are node
typeIds that are never projected into the chat tool loop (silently dropped at dispatch)
and it has no write tool, so scoping chat to it drafts copy on generic baseline tools and
can persist nothing.

---

## Step 1 — Contract scouting (pinned evidence)

### What the feature declares vs. what ignites it
- **Node pack `feature.email.nodes` v1.1.0** declares three READ/RENDER action nodes:
  `list-templates`, `get-template`, `render`
  (`packs/feature.email.nodes/pack.json` nodes[]; runtime `packs/feature.email.nodes/index.mjs:52-58`).
  These run inside **workflow runs** — the marketing example chain uses
  `feature.email.nodes.render` as its "Newsletter render" node
  (`examples/workflow-chain-packs/marketing/pack.json:131`). **RIDES** as workflow nodes.
- **Agent pack `feature.email.agents` v1.0.0** declares ONE agent, `copywriter`, allowlisted
  to exactly `openwop:feature.email.nodes.list-templates` + `…render`
  (`packs/feature.email.agents/pack.json` agents[].toolAllowlist). Read-only; "writes copy
  only… does NOT send" is self-described.
- **The ONE surface write — `createDraftCampaign`** (`.../email/surface.ts:37-59`) — turns an
  email-sequence draft into draft template + draft campaign per step, idempotent on
  deterministic ids, **never sends**. **It is ignited from a workflow node in a DIFFERENT
  feature**: `feature.campaign-channels.nodes` `publishEmail`
  (`packs/feature.campaign-channels.nodes/index.mjs:502-515`). Email itself creates **no**
  workflow runs (`grep startWorkflowRun|WorkflowDefinition` in `.../email/` → empty).

### BLOCKER-1 — the copywriter agent's tools are silently dropped at dispatch
This is the exact cross-cutting pattern flagged for this sweep. The chat tool loop compiles
tools as:
```
compileAgentTools(agent, builtinAgentToolIds(), toolProvider.resolveTool, effectiveToolAllowlist(...))
```
(`backend/typescript/src/host/conversationToolLoop.ts:304`). The `availableTools` argument is
`builtinAgentToolIds()` (`backend/typescript/src/host/agentToolProvider.ts:426`), and
`filterTools` keeps only allowlist entries that are IN that set
(`agentDispatch.ts:185-189`). The copywriter's allowlist entries are **node typeIds**
(`feature.email.nodes.*`), which are:
- **not** in `builtinAgentToolIds()` (that set is static builtins + `registerFeatureAgentTool`
  sites + the two `PROJECTABLE_COMPUTE_NODE_TYPE_IDS`, which are only
  `feature.insights-suite.nodes.variance-compute|talent-score` —
  `agentToolProvider.ts:45-48`),
- **not** registered by email — there is **no** `features/email/agentTools.ts` and **no**
  `registerFeatureAgentTool` call anywhere in `.../email/` (grep → empty).

So `filterTools` drops both email tools. Because the ADR 0315 resolver unions the manifest
allowlist with the default-on baseline (`conversationToolLoop.ts:303` "override ?? manifest ∪
baseline"), `tools.length` is not 0 (the six generic baseline action tools survive), so the
loop still runs — but the agent is offered **zero email tools**. It can neither read existing
templates nor render. **Honest alternative:** register the read tools (and a write tool) via
`registerFeatureAgentTool` from `feature.ts`, then re-point the allowlist at those builtin ids
— exactly the ADR 0308 pattern the docstring at `agentToolProvider.ts:459-471` describes.

### BLOCKER-2 — the phantom-tool parity test does NOT catch this
`agent-prompt-tool-ids.test.ts` builds its "universe" from **pack-declared node typeIds**
(`backend/typescript/test/agent-prompt-tool-ids.test.ts:30-37`), so the copywriter's
allowlist "resolves" and the suite stays green — even though those ids never reach the chat
tool loop. The test proves the ids EXIST as nodes, not that they are OFFERABLE as agent tools.
**Honest alternative:** the drop is only detectable by a test that intersects each agent
allowlist against `builtinAgentToolIds()` (the real chat-dispatch surface). File as a
cross-layer TODO — it will silently green-light every future toothless agent, not just this
one.

### BLOCKER-3 — the agent pack ships with no in-context entry point
Email ships a copywriter agent (a `requiredPack`, so it loads into the agent registry and is
reachable via `/?agent=feature.email.agents.copywriter`), but `EmailPage.tsx` has **no**
`EmbeddedChatPanel`, no "author with AI" affordance, and no `feature.email.agents` reference
anywhere in `frontend/react/src` (grep → empty). The intelligence the ADR claims is
unreachable from the feature's own surface. **Honest alternative:** deep-link the main chat
scoped to the agent (the ADR 0058 pattern), or drop the persona.

### Owners the feature rides (RIDES grep)
- **Consent** — `sendCampaign` gates every recipient on `isAllowed(...,'marketing.email')` via
  the ONE consent service (`emailService.ts:13,412`); public preference center writes through
  `recordConsent` (`routes.ts:373-385`). RIDES.
- **Suppression** — every send subtracts `isSuppressed` (`emailService.ts:416`); bounce/
  unsubscribe write `addSuppression` (`routes.ts:390`, `bounceWebhooks.ts`). RIDES.
- **Retention/erasure** — per-kind purgers register through `registerRetentionPurger`
  (`engagementService.ts:78,92`); **compliance note honored**: `email:engagement-token`
  ages only dead `click`/`open` beacons and KEEPS `unsubscribe`/`preferences` forever
  (`engagementService.ts:74-86`), subject-erasure still removes them via the emailEraser.
  RIDES.
- **Provider egress** — real dispatch rides the existing brokered SendGrid spine, no parallel
  egress (`routes.ts:220-225`, `brokeredProvider.ts`). RIDES.

### Chassis constraints bounding the port
- The copywriter's tools must be **builtin agent tools** (`registerFeatureAgentTool`), not node
  typeIds, to survive `filterTools`.
- A chat-driven send would need an **interrupt/approval card in the PARENT run**; today's send
  is a human page-button (fine as-is), so no child-gate visibility problem exists yet.
- Any new agent write tool must **share the routes' `authorizeOrgScope` + `checkEntitlement`
  predicate** (`routes.ts:49-53`) — one helper, route + tool both call it.

---

## Step 2–3 — Capability inventory + verdicts

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Draft/optimize campaign copy via copywriter agent (chat) | Agent pack, read-only allowlist of node typeIds | **THEATER** — tools dropped at dispatch (`conversationToolLoop.ts:304` + `agentToolProvider.ts:426`); no write tool; no UI entry point | `registerFeatureAgentTool` read+draft tools, re-point allowlist, deep-link chat scoped to it |
| `ctx.features.email` surface (list/get/render + createDraftCampaign) | Thin adapter over `emailService` | **ADAPTER** | Leave; watch for drift |
| Publish email-sequence draft → draft entities (`createDraftCampaign`) | Surface write, ignited by campaign-channels `publishEmail` node | **RIDES** (`surface.ts:37-59`; `packs/feature.campaign-channels.nodes/index.mjs:515`) | Leave alone |
| Email nodes in workflow runs (list/get/render) | Pack nodes, used by marketing chain | **RIDES** (`index.mjs:52-58`; `examples/.../marketing/pack.json:131`) | Also project read/render as chat tools (part of copywriter fix) |
| Send campaign (consent-gated fan-out) | Page button → route → `sendCampaign`; `confirm()` guard; 501 on unconfigured sender | **PAGE-LEGIT** — rides consent+suppression owners, never auto-sends (`emailService.ts:412,416`; `surface.ts:8`) | Keep; if ever chat-driven, an interrupt/approval card |
| Create/edit/delete templates | Bespoke form on `EmailPage` → routes | **PAGE-LEGIT** (structural editing of a durable row) | Keep; add the agent draft tool so chat can also author |
| Create campaign (template + audience) | Form → `POST /campaigns` | **PAGE-LEGIT** | Keep |
| Sender identity settings | Form → `PUT /settings` | **PAGE-LEGIT** (operator config) | Keep |
| Provider status | Read-only card → `GET /provider-status` | **PAGE-LEGIT** — honest read, touches secret path for a real boolean (`routes.ts:110-131`) | Keep |
| Bounce/complaint webhook config | Operator form → routes, secret KMS-enveloped | **PAGE-LEGIT** | Keep |
| Public unsubscribe / preference center / open pixel / click redirect | Server-rendered public pages, toggle-independent, opaque tokens | **PAGE-LEGIT** — writes through consent/suppression owners (`routes.ts:263-396`) | Keep |
| Engagement stats + send log reads | Read routes → page | **PAGE-LEGIT** | Keep |
| Retention purgers + subject eraser | `registerRetentionPurger` per-kind + emailEraser | **RIDES** (`engagementService.ts:74-101`) | Leave alone |

**Counts:** RIDES = 4, ADAPTER = 1, PARALLEL = 0, THEATER = 1, PAGE-LEGIT = 8.

No PARALLEL: notably, the feature did **not** build a bespoke "talk to AI" panel — the AI path
is (correctly) an agent pack, it is just un-ignited. That is theater, not parallel
architecture.

---

## Blockers (with honest alternatives)
1. **Copywriter tools dropped at dispatch** — node typeIds aren't chat tools. Register via
   `registerFeatureAgentTool`; re-point allowlist. (Evidence: `conversationToolLoop.ts:304`,
   `agentToolProvider.ts:426`, `agentDispatch.ts:185`.)
2. **Parity test can't see the drop** — `agent-prompt-tool-ids.test.ts:30-37` treats node
   typeIds as a valid universe. File a cross-layer TODO for an allowlist-vs-`builtinAgentToolIds`
   intersection lint (protects the whole repo, not just email).
3. **No in-context entry to the agent** — `EmailPage.tsx` has no `EmbeddedChatPanel`/deep-link.
   Add the ADR 0058 deep-link or drop the persona claim.

## Demolition list (with regression pins)
- **Nothing to demolish.** The page surfaces are PAGE-LEGIT; the send correctly is not
  auto-called (`surface.ts:8` "It NEVER calls sendCampaign"). The only "removal" is honesty:
  if the copywriter is not ignited, stop shipping it as a `requiredPack`.
- **Pin to add** (once igniter lands): a test asserting `feature.email.agents.copywriter`'s
  effective chat tools (post-`filterTools` against `builtinAgentToolIds()`) is **non-empty and
  contains the email read/draft tools** — so a future refactor that un-registers them fails red.

## New-code inventory (small)
- `features/email/agentTools.ts` — `registerFeatureAgentTool` for: `email.listTemplates`,
  `email.getTemplate`, `email.render` (read, fail-EMPTY, share `authorizeOrgScope`), and
  `email.draftTemplate` (write → a `draft` template through validate→persist, typed failure;
  reuse the existing `createTemplate`/`createDraftCampaign` service, no new store).
- Register those tools from `feature.ts` init; re-point `copywriter.toolAllowlist` to the new
  builtin ids.
- Frontend: deep-link/entry from `EmailPage` to the scoped chat (or `EmbeddedChatPanel`).
- One regression test (above) + one cross-layer TODO for the parity-lint gap.

## Phased plan (real gates; compliance seams already intact)
1. **P1 — ignite the copywriter (read).** Register `list/get/render` agent tools sharing the
   route predicate; re-point allowlist; add the non-empty-chat-tools regression pin. Gate:
   backend vitest + the new pin. Close with `/code-review`.
2. **P2 — copywriter write path.** Add `email.draftTemplate` (validate→persist, draft-only,
   never send); reuse existing service + deterministic ids. Gate: vitest. Close with
   `/code-review`.
3. **P3 — entry point.** Deep-link `EmailPage` → chat scoped to the copywriter (ADR 0058);
   or, if P1/P2 rejected, demote the agent pack out of `requiredPacks`. Gate: frontend
   `npm run build`. Close with `/ux-review`.
4. **P4 — cross-layer lint TODO** for allowlist↔`builtinAgentToolIds` parity (record, don't
   hack).

## Deferred honestly
- **Chat-driven send with an interrupt/approval card** is deferred — today's human page-button
  send is legitimate and already rides consent+suppression; wiring a chat send is only worth it
  once a Campaign Studio agent owns the end-to-end flow (that igniter lives in campaign-channels,
  unit-adjacent).
- **Repo-wide toothless-agent lint** deferred to a cross-layer TODO — it is not email-specific.
