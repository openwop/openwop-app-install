# D7 — CDP + Consent (+ destination-sync) — chat-first port review

Scope (single-feature / unit mode): backend `features/{cdp, destination-sync,
consent}`, frontend `features/{cdp, consent}`. Program context: CDP-A…H (identity
resolution, event schema registry + collection, segments/journeys, destination-sync /
CDC / reverse-ETL, governance decision log + audit chain, purpose-consent graph, data
residency), ADR 0262 rulings, ADR 0265 segment-author copilot (crm-owned), ADR 0289/0292
egress, RFC 0128/0129.

## Headline

This unit is overwhelmingly **honest engine-riding plumbing, not chat theater** — no
shadow chat, no bespoke "talk to AI" panel, no toothless authoring agent, no parallel
owner. Every concept with an owner instantiates the real one (crm identity index, the
single `isAllowed` consent chokepoint, `approvalService`, `brokeredEgress`,
`subjectErasure`, the host-event→journey bridge). The chat-first gaps are the **inverse**
of the usual: there is *too little* surface, not too much. Two real problems: (1) the
entire destination-sync egress spine (config CRUD + onward-sync workflow + governed
warehouse load) has **no igniter and no frontend at all** — it is reachable only by a
hand-rolled `POST /v1/runs`, which makes the "operator vehicle" workflow **THEATER**; and
(2) the CDP-F/G compliance capabilities (governance decision log, audit-chain verify,
event schema registry, collected-events) are **real, tenant-scoped, admin-gated reads
with zero operator surface** — the "CDP console" is only an identity-resolve form.

## Contract scouting (pinned)

- **Identity resolve rides crm, does not shadow it.** `resolveIdentity` composes the
  crm-owned identifier index + crm contact + analytics anon→known link
  (`identityService.ts:11-19,61-95`); the package "owns NO contact store" (`feature.ts:6-7`).
  Route and agent tool share ONE access helper `resolveIdentityWithAccess`
  (`routes.ts:74-76`, `agentTools.ts:57`, `identityService.ts:105-119`) — they cannot drift.
- **The identity agent tool is genuinely reachable in the ONE chat.** Registered via
  `registerFeatureAgentTool` (`agentTools.ts:24-61`) and allowlisted into the chief-of-staff
  persona (`../openwop/packs/feature.assistant.agents/pack.json`). Fail-closed on toggle +
  requires an acting user (`agentTools.ts:46-52`); PII pinned masked for the agent
  (`agentTools.ts:56-57`). This is the reference cross-feature read-tool.
- **Consent enforcement is a true single owner.** `isAllowed` is the ONE evaluator Analytics
  + Email call (`consentService.ts:263-307`); `isPermittedForPurpose` is a thin purpose→
  category adapter over it, not a second evaluator (`consentService.ts:164-167`); strict
  WhatsApp opt-in flows through the same evaluator (`consentService.ts:41,269-276`).
- **Governed warehouse write rides the shared owners.** `warehouseLoad` uses
  `approvalService` (`warehouseLoadService.ts:34,111`), `governanceService.actionPolicyOf`
  (`:33,94`), `brokeredEgress.brokeredPost` (`:31,139`), deterministic fork-stable idemKey
  (`:71-77`), default fail-closed `approval-required` (`:41,90-98`). Textbook — but see
  ignition gap below: no run ever mints the approval, so the HITL is correct-but-dark.
- **Egress composes the existing node catalog.** Onward-sync workflow = `prepare-onward` node
  → `core.openwop.http.fetch` (`onwardSyncWorkflow.ts:47-89`), "egress rides the http node,
  NOT a bespoke sender" (`:6-8`). Node packs declare `prepare` / `prepare-onward` /
  `warehouse-load` as surface verbs over `ctx.features['destination-sync']`
  (`packs/feature.destination-sync.nodes/pack.json`). No parallel engine.
- **Segment-entered journey trigger rides the host-event bridge.** Boot daemon
  (`index.ts:69,752`) diffs watched-segment membership and emits `crm.segment.entered`
  host events (`segmentEntryDaemon.ts:47-69`) that existing `HostEventBinding` journeys bind
  to — "does NOT build a parallel trigger source" (`:8-9`). First-observation seeds without
  firing (`:40-44`); per-(segment,slot) idempotency claim (`:53`).
- **IGNITION HOLE (the load-bearing scout finding).** `ONWARD_SYNC_WORKFLOW_ID`
  (`onwardSyncWorkflow.ts:51`) is registered via `builtinWorkflows` (`feature.ts:20`) but
  **nothing in the app creates runs of it** — grep for the id / `startWorkflowRun` /
  `feature.destination-sync.nodes` outside the feature dir returns nothing. No chat tool,
  no agent, no UI button, no scheduler. The doc itself says "To fire a leg: POST /v1/runs
  … for this workflowId" (`onwardSyncWorkflow.ts:35-36`) — i.e. a human crafts raw JSON.
- **NO destination-sync frontend exists.** Grep of `frontend/react/src` for
  `destination-sync|destinationSync|warehouse-load|prepareOnward` → **empty**. Config CRUD
  (`destination-sync/routes.ts`) has no operator UI.
- **Frontend is two thin pages.** `/cdp` = identity-resolve form ONLY
  (`CdpConsolePage.tsx`, `cdp/routes.tsx`); `/consent` = policy + records + data-subject
  erase (`ConsentPage.tsx`). Neither embeds chat; neither surfaces event schemas, collected
  events, governance decisions, audit chain, or purpose vocab (all backend-only routes).
- **Lifecycle:** `cdp:collected-event` has a retention purger (`collectService.ts:132-140`);
  consent erasure fans out via `eraseSubject` (`consentService.ts:245-249`). But
  `cdp:segment-snapshot` (holds contactId lists, `segmentEntryDaemon.ts:35`) and
  `cdp:destination-sync` config have no eraser/retention (snapshot self-heals next tick; low
  severity but unpinned).

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Identity resolution (golden-record lookup) | crm-composing read; route + surface + node + **chat tool** + `/cdp` form | **RIDES** | Leave. Already drivable from the ONE chat; console is PAGE-LEGIT convenience |
| 2 | Consent enforcement (`isAllowed`) | single chokepoint Analytics+Email call | **RIDES** | Leave — the reference single-owner gate |
| 3 | `isPermittedForPurpose` (purpose→category) | thin adapter over `isAllowed` | **ADAPTER** | Leave; watch for a second evaluator sneaking in |
| 4 | Data-subject (GDPR) erasure | `/consent` lookup+erase → `eraseSubject` fan-out | **RIDES** | Leave — rides the subject-erasure seam; confirmed destructive page action is correct |
| 5 | Governed warehouse load (reverse-ETL BigQuery) | surface verb + node over `approvalService`+`governanceService`+`brokeredEgress` | **RIDES** | Leave the write; **ignite it** (see #12) so the HITL approval actually surfaces |
| 6 | CDC prepare / advance / dry-run (watermark + field-map) | pure surface verbs + nodes; egress via http.fetch | **RIDES** | Leave the nodes; needs an igniter (see #11/#12) |
| 7 | Segment-entered journey trigger | boot daemon → host events → existing journeys | **RIDES** | Leave — reuses the trigger bridge, seeds without firing |
| 8 | Data-residency admission (RFC 0129) | env-gated `/v1/runs` admission gate, honest-off | **RIDES** | Leave — host wire gate, not a feature UI capability |
| 9 | CDP agent tool (`cdp.identity.resolve`) | `registerFeatureAgentTool`, shares route helper, masked | **ADAPTER** | Leave — the sanctioned chat-time read seam |
| 10 | Consent policy (regions + default mode) | `/consent` config page | **PAGE-LEGIT** | Keep — structured operator config, not describe-intent |
| 11 | Consent records + public capture endpoint | records list/filter + unauthed opt-in POST | **PAGE-LEGIT** | Keep — collection page + cookie-banner ingest target |
| 12 | Destination-sync config CRUD | backend routes only, **no UI, no chat** | **PAGE-LEGIT (headless)** → port | Give destination-sync an **agent + action tools** in the ONE chat (describe-intent authoring); a read page lists syncs |
| 13 | Onward-sync operator workflow (openwop-host egress) | `builtinWorkflows`, **no igniter** | **THEATER** | Ignite from the destination-sync agent tool (`runSync` → `startWorkflowRun` + authoritative `workflow_run` turn), or stop calling it "the operator vehicle" |
| 14 | Event schema registry (register/list/validate) | backend routes only, no UI/agent/node | **PAGE-LEGIT (headless)** | Build the read/manage page OR a schema-registry read-tool; deferred-invisibly today |
| 15 | Event collection (collect / batch / CSV import) | backend ingest routes; SDK target | **PAGE-LEGIT / API substrate** | Keep the ingest API; add the `collected-events` debugger read surface |
| 16 | Governance decision log + audit-chain verify | admin-gated backend reads, **no UI** | **PAGE-LEGIT (headless)** | Build the compliance console (law 7) OR compliance-agent read-tools; the reads are real but invisible |
| 17 | Purpose-vocabulary registry + strict flag | consent routes, no FE | **PAGE-LEGIT (headless)** | Fold into the consent page (advisory catalog editor) |

**Tally: R=6, A=2, P=0, T=1, PL=8.**

## Blockers (with the honest alternative)

- **B1 — The destination-sync egress spine has no igniter (root cause of the only
  THEATER).** The onward-sync workflow (`onwardSyncWorkflow.ts:51`), the CDC `prepare`
  nodes, and the governed `warehouseLoad` (`warehouseLoadService.ts:182`) are all built and
  correct, but the ONLY way to run any of them is a hand-authored `POST /v1/runs`
  (`onwardSyncWorkflow.ts:35`). A declared "operator vehicle" nobody creates runs of is
  theater by the skill's ignition test.
  **Honest alternative:** ship a **destination-sync agent** (capability at core, activated
  via `agentProfile` — David's law) driven through the ONE chat, with ACTION tools that
  share the route predicate: `createDestinationSync` (wraps the existing service),
  `dryRunSync` (wraps `prepareSyncBatch`), and `runSync` → `startWorkflowRun` of the
  built-in workflow + the authoritative `workflow_run` conversation turn. "Sync my contacts'
  email + stage to BigQuery when they change" is a describe-intent task → chat, per law 1.
  The governed warehouse approval (already wired to `approvalService`) would then actually
  render inline in the run / reviews inbox — the HITL becomes live instead of dark.

- **B2 — CDP-F/G compliance capabilities are real reads with zero surface.** Governance
  decision log (`routes.ts:175-183`), audit-chain verify (`routes.ts:188-198`), event
  schema registry (`routes.ts:87-116`), collected-events (`routes.ts:163-171`) are all
  tenant-scoped, admin-gated where appropriate, and back real state — but the `/cdp` page
  renders only identity resolve (`CdpConsolePage.tsx`). An operator cannot see that any of
  this exists. This is deferred-**invisibly**, which law 6 forbids.
  **Honest alternative:** these are legitimately PAGE-LEGIT (read-only provenance/status/
  reporting) — build the console reads (a governance-decision viewer, an audit-chain status
  card, a schema-registry list). Optionally expose the two READS as compliance-agent
  read-tools ("show me where this subject's marketing consent was denied") that fail EMPTY
  without an acting user, sharing the route predicate. Do NOT force these into chat as the
  primary surface — a decision log is a page.

- **B3 — No frontend for destination-sync at all.** Even the config catalog (list/create a
  sync) has no page, so an operator has no entry point. B1's agent + a thin "your syncs"
  read page closes this together.

## Demolition list (with regression pins)

Near-empty by design: **this unit has no bespoke parallel UI to tear down** — the defect is
absence, not duplication. The two pages that exist are PAGE-LEGIT and stay.

- Nothing to demolish. Pin the *absence* of the anti-patterns instead:
  - **Regression pin:** assert the identity route + agent tool keep calling the single
    `resolveIdentityWithAccess` helper (guard against a future divergent tool copy) —
    extend the existing `agent-prompt-tool-ids` / prompt-catalog parity coverage.
  - **Regression pin:** if B1 lands, pin that destination-sync authoring stays in the ONE
    chat — a test that fails if a bespoke `<DestinationSyncBuilder>` form or a second "talk
    to AI" panel appears under `features/destination-sync` (the `AiAuthorPanel` lesson).
  - **Regression pin:** assert `isPermittedForPurpose` delegates to `isAllowed` (no second
    evaluator) — a resurrected parallel consent check fails the suite.

## New-code inventory (small)

1. **1 agent pack** — `feature.destination-sync.agents` (a "Data Sync" persona), activated
   via `agentProfile`; no logic unique to the named agent.
2. **3 thin action tools** via `registerFeatureAgentTool`, each sharing the route's predicate
   (one helper, route + tool both call it): `createDestinationSync`, `dryRunSync`,
   `runSync` (→ `startWorkflowRun` of `ONWARD_SYNC_WORKFLOW_ID` / a warehouse variant + the
   `workflow_run` turn). No new node, no new workflow — reuse what exists.
3. **Reads (pages), not stores:** a destination-sync "your syncs" list page; a CDP governance
   console (governance-decision log + audit-chain status + event-schema list) reading the
   existing routes; fold purpose-vocab into `ConsentPage`.
4. **Optional 2 compliance read-tools** (governance-log, audit-status) — fail EMPTY without
   an acting user, pack-allowlisted, never added to the default baseline.
5. **1 lifecycle seam:** register a subject-key resolver/eraser (or a bounded retention) for
   `cdp:segment-snapshot` so a contactId doesn't linger between ticks; confirm tenant-delete
   cascades `cdp:destination-sync` config.

No new RFC (RFC 0128/0129 are the accepted wire; egress rides Accepted nodes). ADRs 0262/
0266/0289/0292/0302 already cover the decisions — the port is host UI/agent work.

## Phased plan (gated on real gates)

- **Phase 0 — honesty first (no demolition).** Build the CDP governance console reads (B2)
  and a destination-sync "your syncs" list page (B3). These make existing real state visible
  and are prerequisite context for driving anything. Close with `/code-review` + `/ux-review`.
- **Phase 1 — ignite egress via chat (B1).** Add the destination-sync agent pack + the 3
  action tools; drive `createDestinationSync` / `dryRunSync` / `runSync` through the ONE
  chat (deep-link `?agent=`), firing the existing built-in workflow. Verify the warehouse
  approval now renders inline in the run + reviews inbox. Close with `/code-review` +
  `/ux-review`; `/grade-ai-exchange` for the new tools (schema-from-SSoT, typed failures).
- **Phase 2 — compliance read-tools + purpose-vocab UI (optional).** Add the two governed
  read-tools; fold purpose-vocab into `ConsentPage`. Close with reviews.
- **Phase 3 — lifecycle pins.** Segment-snapshot eraser + config cascade; `/grade-data`.

Never demolish before a replacement works — but here there is nothing to demolish, so every
phase is additive; ordering is honesty-surface-first, then ignition, then polish.

## Deferred honestly

- **Onward-sync + warehouse egress stay flag-gated OFF** until RFC 0128 is witnessed
  (`destinationSyncService.ts:133-135`, `surface.ts:40-41`) — the port adds the *igniter*,
  not the wire promise; the advert stays dark. State this, don't paint it green.
- **Data-residency** where bytes physically land is an operator SHOULD, out of band
  (`dataResidency.ts:14-21`) — only admission control is host-enforced. Not a UI capability.
- **ADR 0265 segment-author copilot and the segments/journey definitions themselves are
  crm-owned** (`features/crm/segmentsService.ts`, `feature.ts`) — out of this unit's scope;
  D7 only consumes them via the segment-entered daemon. The "who opts a segment into
  `watchEntries`" surface lives in crm and is not audited here.
- **`cdp:segment-snapshot` between-tick retention of contactIds** — low severity (self-heals
  next sweep), filed as a Phase-3 lifecycle TODO, not faked as covered.
