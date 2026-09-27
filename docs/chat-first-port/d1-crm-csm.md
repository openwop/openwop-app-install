# CRM + CSM (unit D1) — chat-first port review

**Scope:** `backend/typescript/src/features/{crm,csm}` + `frontend/react/src/features/{crm,csm}` + the vendored chain/agent/node packs (`packs/feature.crm.*`, `packs/feature.csm.*`, `examples/workflow-chain-packs/{crm-ops,csm-ops}`).

**Headline:** This is a **mature, largely chat-first-compliant** unit — the risky orchestration already rides the engine (event-bound governed-write chains, a shared approval gate, the steward ApprovalsInbox, variant-stamped triage runs, scheduler-fired Gmail sync). There is **no parallel chat, no second approvals owner, and no bespoke AI-behind-a-button route**. The real defects are two **orphaned agent entrypoints**: the `segment-author` copilot and the `csm-health` insights agent ship, ride the engine correctly, but are **not reachable from their own feature surfaces**, so the only path a user discovers is a bespoke form. The port is small: two deep-link affordances, not a rebuild.

---

## Step 1 — Contract scouting (pinned evidence)

**Declared vs ignited orchestration**

- The feature packages **never call `startWorkflowRun`** themselves (`grep startWorkflowRun` over both dirs = empty). Ignition is entirely through generic host mechanisms, which is correct:
  - **Triage runs** are minted directly against the run engine in `backend/typescript/src/features/crm/routes.ts:470` (`POST …/crm/contacts/:id/triage`) → `insertRunWithStartContext` at `routes.ts:508`, workflow resolved from `OPENWOP_CRM_TRIAGE_WORKFLOW_ID ?? 'openwop-app.uppercase'` (`routes.ts:481`), variant + bindings stamped into `run.metadata.featureVariant` (`routes.ts:496-500`). The toggle's A/B variants bind the two triage nodes (`feature.ts:69-80`). **Real igniter.**
  - **Governed-write chains** live in `examples/workflow-chain-packs/crm-ops/pack.json` (`core.openwop.workflows.crm-ops`), loaded via the in-tree fallback root at `backend/typescript/src/host/workflowChainPackLoader.ts:188`. `crm-ops.route-new-lead` is a `core.trigger.event` DAG bound to `host.crm.contact.created` (`crm-ops/pack.json` node `trigger`), ignited by the host-event dispatcher via the shared `startWorkflowRun` recipe (`runStarter.ts:89` cites this exact chain as its executor test). `crm-ops.deal-hygiene` carries a real `core.chat.approvalGate` node in the **parent** run. `crm-ops.gmail-sync` / `csm-ops.health-from-crm` are scheduler-fired. **Real igniters.**
- **Agent tool allowlists vs capability** — the personas are honestly scoped:
  - `feature.crm.agents.sales-ops` (`packs/feature.crm.agents/pack.json`): reads + exactly two assistive writes (`log-activity`, `create-task`). Create-contact/company/deal, move-stage, convert-lead are **deliberately excluded** — those ride the `crm-ops` chains behind a human gate (pack description + `prompts/sales-ops.md:32-35`). This is the correct governed-write split, not a toothless persona.
  - `feature.crm.agents.segment-author`: the closed-world `schema.lookup` + `segment-vocabulary` + `validate-segment` + `list-segment-members` + `persist-segment` trio — the A+ draft→validate→persist grounding pattern. Rides the engine correctly.
  - `feature.csm.agents.health-insights`: read-only (`health-read` only) — honest "reports, does not mutate" scoping.
- **Owner instantiation (RIDES grep):**
  - Approvals: `contactMergeApproval.ts:17` imports `registerContactMergeApprovalHandler` / `resolveApproval` / `reopenApproval` from `host/approvalService.js` and CAS-flips the shared `PendingApproval` before the side effect (`contactMergeApproval.ts:38-48`). **Instantiates the approvals owner.**
  - Node write path: every `feature.crm.nodes` action node calls the **same** `ctx.features.crm` surface function the HTTP routes call (`packs/feature.crm.nodes/pack.json` description; `surface.ts`), so agent/workflow writes and human writes are indistinguishable to the audit trail. **Thin honest adapter.**
  - Connection lifecycle: `feature.ts:54` wires `onConnectionRevoked('crm-gmail-sync', …)` → `pauseGmailSyncsForRevokedConnection`. CSM wires `onCrmRecordDeleted` → `scrubCrmRefsForDeletedCompany` (`csm/feature.ts:25`). Lifecycle seams present.
- **Chat entrypoint:** `CrmPage.tsx:80-84` renders one "Ask Sales Agent" button that deep-links `navigate('/?agent=feature.crm.agents.sales-ops')` (`CrmPage.tsx:35`, test-pinned `__tests__/CrmPage.test.tsx:197`). It embeds **no** bespoke chat panel — the ADR 0058 chat-drivability pattern, done right.

**Assumptions that FAILED (blockers):**

- **B1 — the `segment-author` copilot has no surface entrypoint.** `grep segment-author frontend/react/src` = empty. The agent + nodes are A+, but no button/deep-link opens the chat scoped to it. The only discoverable segment-authoring path is the bespoke filter form in `ContactsTab.tsx:233-235` (`createSegment`). Honest alternative: add the one-line deep-link affordance (mirror `askSalesAgent`); keep the form as the manual fallback.
- **B2 — the `csm-health` insights agent has no surface entrypoint.** `grep agent= frontend/react/src/features/csm/CsmPage.tsx` = empty. `CsmPage.tsx` is a pure bespoke health-CRUD grid (`CsmPage.tsx:267-283`, health number-input at `:271`). The read-only insights persona ships but the CSM surface never surfaces it. Honest alternative: add an "Ask CSM Health" deep-link → `/?agent=feature.csm.agents.health-insights`.
- **B3 — `leadScore` / `propensity` are computed + route-exposed but never surfaced in the CRM UI.** Consumers are `routes.ts` and `signTargets.ts` only (`grep`), zero React consumers (`grep propensity|leadScore frontend` = empty). The reads are real and explainable (`leadScoreService.ts` header; `propensityService.ts` reuses `computePriority`), so this is not theater — but it's a computed capability with no in-feature honesty loop. Honest alternative: surface it as a projection column/panel, or mark it deferred-visibly; do not leave a route with no consumer implying a capability the UI never shows.

---

## Step 2/3 — Verdict table (per capability, with port tests applied)

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Sales-ops chat assist (Q&A + log-activity + create-task) | Deep-link to shared chat scoped to `sales-ops`, tools over `ctx.features.crm` sharing the routes' predicate | **RIDES** | Leave. `CrmPage.tsx:80` + `feature.crm.agents/pack.json` |
| Governed CRM writes (owner-on-new-lead, deal-hygiene, convert/create) | `crm-ops.*` chains, event-bound + scheduler-fired, `deal-hygiene` has a parent-run `core.chat.approvalGate` | **RIDES** | Leave. `examples/workflow-chain-packs/crm-ops/pack.json`, `runStarter.ts:89` |
| Contact-merge steward approval | `registerContactMergeApprovalHandler` → shared `PendingApproval` / ApprovalsInbox, CAS-flip-then-merge | **RIDES** | Leave. `contactMergeApproval.ts:17-48` |
| Match-candidates → propose merge | `matchCandidates` → queues `kind:'contact-merge'` approval (`routes.ts:321,337`) | **RIDES** | Leave; dispositioned in the shared inbox, no bespoke merge UI |
| Gmail inbox → CRM activity sync | `crm-ops.gmail-sync` chain, per-user scheduler job, revoke-pauses via `onConnectionRevoked` | **RIDES** | Leave. `feature.ts:54`, `gmail-sync` node |
| Contact triage (A/B variant) | `POST …/triage` mints a variant-stamped run on the engine | **RIDES** | Leave. `routes.ts:470-515` |
| CRM node write path (create/update/convert/move/log) | Action nodes call the same service fn as the routes; deterministic ids | **ADAPTER** | Leave; watch route↔node drift (one service, both callers) |
| **Author a segment with AI (copilot)** | Agent + closed-world nodes ship but **no surface entrypoint** | **THEATER** | Add "Draft segment with AI" deep-link → `/?agent=feature.crm.agents.segment-author` |
| **CSM health insights (agent)** | Read-only persona ships but **CsmPage has no chat deep-link** | **THEATER** | Add "Ask CSM Health" deep-link → `/?agent=feature.csm.agents.health-insights` |
| Save-as-segment (manual filter form) | Bespoke form over `createSegment` | **PAGE-LEGIT** | Keep as manual fallback beside the copilot deep-link. `ContactsTab.tsx:233` |
| Contacts / Companies / Deals / Tasks grids | Direct human CRUD over the owning REST routes (66 endpoints) | **PAGE-LEGIT** | Keep — the route IS the owner; structural viewing/editing |
| CSM accounts + health CRUD | Bespoke form/grid over `csm/routes.ts` | **PAGE-LEGIT** | Keep; the number-input is the legitimate manual health override |
| Booking links + public booking/manage pages | Operator config + visitor slot-claim (own flow) | **PAGE-LEGIT** | Keep; the claim is a visitor action, not app HITL |
| E-signature request + public sign page | Request node + signer-token flow (own flow) | **PAGE-LEGIT** | Keep; signer action ≠ app HITL |
| Pipeline reports | `computePipelineReport` read (`orgRoutes.ts:70`), snapshot daemon | **PAGE-LEGIT** | Keep read-only projection |
| Suppression summary | Counts-only analytics node/read, no PII | **PAGE-LEGIT** | Keep |
| Lead-score / propensity | Computed-on-read, explainable, route-exposed — **no CRM UI consumer** | **PAGE-LEGIT** (honesty gap) | Surface as a projection or mark deferred-visibly (B3) |

**Port-test notes worth flagging:**
- *Agency test:* both action-capable personas (sales-ops governed split, segment-author trio) pass; both read-only personas (segment-author's reads, csm-health) fail EMPTY without a user — correct. The failure is discoverability (B1/B2), not agency.
- *HITL test:* `deal-hygiene`'s `core.chat.approvalGate` lives in the parent run (visible); the merge steward decision leaves a durable `PendingApproval` record. No bespoke approve/submit button exists in the CRM/CSM frontend (`grep approve|merge` = tests only). Passes.
- *Card-mechanism test:* nothing in this unit renders agent-authored interactivity; the approval is a plain interrupt/inbox card and the deal-hygiene gate is `core.chat.approvalGate`. No mis-picked A2UI or hand-built typed renderer. Passes.
- *Authority-parity test:* node writes and routes share one `ctx.features.crm` service + tenant/org guard (CTI-1); the CSM surface deliberately omits the unguarded by-id `getAccount` (`csm/surface.ts:6-9`). Passes.

---

## Blockers (with honest alternatives) — recap

- **B1 (segment-author orphaned):** add a deep-link on the Contacts/segment surface; the machinery is already A+ — do **not** build a new panel.
- **B2 (csm-health orphaned):** add an "Ask CSM Health" deep-link to `CsmPage`.
- **B3 (unshown lead-score/propensity):** either surface the projection or mark it deferred-visibly; don't ship a route that implies a capability the UI never renders.

---

## Demolition list (with regression pins)

Nothing to demolish — there is no parallel chat, no duplicate approvals owner, and no bespoke AI route to tear out. The two ports are **additive deep-links**, not replacements. Pins to add:

- Test asserting the segment surface renders a control that calls `navigate('/?agent=feature.crm.agents.segment-author')` (mirror `CrmPage.test.tsx:197`).
- Test asserting `CsmPage` renders a control that deep-links `feature.csm.agents.health-insights`.
- Keep the existing `CrmPage.test.tsx:197` sales-ops pin (guards against regressing the one entrypoint that already works).

---

## New-code inventory (small, as expected)

1. One header-action deep-link button in the segment/Contacts surface (`ContactsTab.tsx`) → `segment-author` — ~5 lines, mirrors `CrmPage.tsx:80-84`.
2. One header-action deep-link in `CsmPage.tsx` → `health-insights` — ~5 lines.
3. (Optional, B3) a lead-score/propensity projection column or panel + its i18n keys — or a one-line deferred-visibly note in the ADR if not surfacing now.
4. Two regression tests (above). No new backend, no new node, no new workflow, no new envelope.

---

## Phased plan (real gates)

- **Phase 1 — chat-first entrypoints (B1, B2):** add the two deep-links + 4-locale i18n keys + the two regression pins. Gate: `( cd frontend/react && npm run build )` + the new tests green. Close with `/code-review` + `/ux-review`, apply fixes.
- **Phase 2 — honesty loop (B3):** decide surface-or-defer for lead-score/propensity; if surfacing, add the projection + read-back; if deferring, record it in the CRM ADR's deferred list. Gate: build + tests; `/ux-review` for the new panel.

No compliance-seam phase is needed — tenant/org guards, approval CAS, lifecycle seams, and deterministic ids are already in place.

---

## Deferred honestly

- **Lead-score / propensity UI (B3):** computed and route-exposed today; no in-feature UI consumer. Explicitly deferred until Phase 2 decides surface-vs-defer — not painted as a shipped capability.
- **Chat-driven governed writes:** the `sales-ops` agent can *point at* the governed-write chains but cannot *ignite* them from chat (chains are event-bound/scheduler-fired/operator-bound via Host events). Honest and by design (ADR 0208 §2 keeps high-blast-radius CRM writes off the direct agent call). If a future ADR wants "run the deal-hygiene sweep now" from chat, that is a new igniter tool (`startWorkflowRun` + the `workflow_run` turn), not a change to this unit — filed, not hacked.
