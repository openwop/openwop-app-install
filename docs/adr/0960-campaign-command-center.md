# ADR 0960 — Campaign command center

Status: Proposed

Date: 2026-10-19. Program: Campaign Studio (ADRs 0941–0962), Tier 5 capstone.
Source: the program brief (session 66). Net-new feature, not a MyndHyve port.
Integrates with, not depends on, ADR 0961 (same tier, later): the cockpit reads
any campaign run carrying the ADR 0941 run tag, autopilot or not.

## Context

Once a campaign runs as a durable graph of agent-run nodes with human gates
(ADR 0961), spend caps (ADR 0952), experiments (ADRs 0949/0950) and client
approvals (ADR 0924), the people running it need one place to see it **live**:
which node is running, which agent is on it, which gate is waiting on whom,
how much has been spent against the cap, which experiments are live, what went
wrong, and how the team feels about it. And from any decision they need two
moves nobody else in the market offers: **replay this decision** (show exactly
what the agent saw and did, re-run it deterministically) and **fork from here**
(try a different input from that point without touching the live campaign).

The brief's rule is explicit: **no parallel run viewer.** The app already has a
run detail page, a step inspector with "fork from here", a handoff map, a live
canvas overlay, run diff, an operator inbox design, dashboard tiles and channel
presence. The command center *composes* them, keyed on one campaign.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Backend paths under `backend/typescript/src/`, frontend under
`frontend/react/src/`.

**What exists and is reused:**

| Need | Existing owner | Evidence |
|---|---|---|
| Live per-node status painted on the graph | builder canvas run overlay | `builder/store/builderStore.ts:308-394` (`RunOverlay.nodeStatus`, SSE-fed), `builder/canvas/BuilderCanvas.tsx:291,355`, banner `builder/RunOverlayBanner.tsx` |
| Supervisor → worker → child run flow, handoff notes | `runs/RunHandoffMap.tsx` (ADR 0829) | renders `runOrchestrator.decided`, `agent.handoff`, `node.dispatched`, workflow-chain dispatch phases, confidence escalations |
| Step detail + "fork from here" | `runs/RunStepInspector.tsx:19-46` (`onForkFrom(seq)`), `runs/RunDetailPage.tsx:336-345` (one fork per click, ADR 0772) | |
| Fork (replay / branch) | `routes/runs.ts:1818` `POST /v1/runs/{id}:fork`, modes `replay|branch` `:1840`, overlay branch-only `:1884-1890` | replay never creates a new side effect: `executor/sideEffects.ts:1-25`; live gates re-created with fresh tokens: `executor/forkInterrupts.ts` (ADR 0751) |
| Diff two runs | `routes/runs.ts:1009-1016` `GET /v1/runs/{id}:diff` (RFC 0054) | `runs/RunComparePage.tsx` |
| Run event stream | `routes/streams.ts:64` `GET /runs/:runId/events`; poll `routes/runs.ts:2229` | |
| Pending approvals, SLA, escalation | `host/approvalService.ts` (`APPROVAL_KINDS` `:40`), `host/approvalSla.ts`, `host/escalationNotify.ts`, `host/approvalAudience.ts:186-189` (role refs) | |
| Agent activity | `host/agentActivity.ts:22-69` `projectAgentActivity` (sources heartbeat/schedule/kanban/approval) | |
| Team ledger + drift | ADR 0831 `features/team-intent-ledger/` (`runStamp.ts` `teamLedger` stamp), ADR 0855 `driftCheck.ts` (advisory findings, never blocks), ADR 0853 decisions | |
| Campaign ↔ project (board, chat, ledger) | ADR 0852 `features/campaign-orchestration/campaignProject.ts` | |
| Presence | `features/channels/channelPresenceTracker.ts:16-93` (channel-scoped only) | |
| Spend | `features/campaign-intel/pacing.ts:24-105` `buildPacing` (bands `ok|warning|over` only, no cap) | |
| Dashboard tiles | `features/dashboard/allTiles.ts:26` `ALL_DASHBOARD_TILES` (ADR 0375/0377) | |
| Operator inbox (cross-client cards) | ADR 0926 D1/D2 (Proposed; not on main) | |

**Gaps (measured):**

| Gap | Evidence | Consequence |
|---|---|---|
| C-G1 No campaign → runs index | runs are bound to a project only via kanban/schedule attribution (`team-intent-ledger/runStamp.ts:6-14`); `…/campaigns/:id/dispatches` returns AD dispatch records, not runs (`features/campaign-orchestration/routes.ts:212-221`) | The cockpit cannot list a campaign's runs without a tenant scan |
| C-G2 Run reads are tenant-wide | ADR 0921 G1: `BundleScope` has no `orgId`, `host/runAccess.ts:97-117` | Reading runs through `/v1/runs` would leak other clients' runs |
| C-G3 The live overlay lives inside the builder store | `builderStore.ts:974-1001` (overlay seeded from a builder session) | Reusing it read-only needs a store-free entry point |
| C-G4 Presence exists only for channels | `channelPresenceTracker.ts:71` `joinPresence(channelId, …)` | No "who is looking at this campaign" |
| C-G5 Vocabulary conflict with ADR 0926 | ADR 0926 D1 pins the inbox copy against a denylist including "canvas, node, chain, model, provider" | A run-graph cockpit inside the same tab would violate it |

**Duplication check.** The cockpit must not become a second run viewer, a second
approvals inbox, or a second dashboard. Each panel below is a *projection* over
an existing owner and deep-links to that owner's full page.

## Decision

### D1 — One campaign-scoped read model, gated per client

`GET /v1/host/openwop-app/campaign-orchestration/campaigns/:campaignId/command`
(org-gated through the campaign's `orgId`, `authorizeOrgScope(…,'workspace:read')`)
returns a bounded snapshot:

```ts
interface CampaignCommandSnapshot {
  campaign: { id; orgId; name; autonomyLevel /* 0942 */; playbook?: { id; version } /* 0959 */ };
  runs: Array<{ runId; workflowId; role: 'spine' | 'stage' | 'optimizer' | 'fork';
                status; startedAt; definitionRevision; parentRunId? }>;      // latest 25, truncated flag
  nodes: Array<{ runId; nodeId; label; status /* NodeRunStatus */;
                 agent?: { agentId; name } /* nodes[].agent, 0943 */;
                 human?: { gateId; approverRoles; assignees; slaDueAt; escalated } }>;
  gates: Array<{ approvalId | interruptId; kind; actionClass /* 0942 */; owners; slaDueAt; ageMs }>;
  spend: { capUsd?; spentUsd; band; pausedAtCap? } ;                         // 0952 (pacing today)
  experiments: Array<{ experimentId; mode: 'decide' | 'optimize'; state; leader?; guardrailBreached? }>; // 0949/0950
  alerts: Array<{ source: 'pacing' | 'sla' | 'drift' | 'promotion-rollback' | 'run-failed' | 'policy'; severity; refId; at }>;
  ledger: { ledgerId; version; openDriftFindings: number };                   // 0831/0855
}
```

Every section is filled by calling the owning feature's own read (fanned out,
each gated by the same org check). A section whose owner's toggle is off is
omitted with `unavailable: '<toggle>'` — never an empty list pretending to be
data. Bounded: 25 runs, 100 nodes, 50 gates, with `truncated` flags.

### D2 — Campaign → run index (closes C-G1, respects C-G2)

The cockpit reads ADR 0941's run tag and run index; it adds no stamp and no
index of its own. The run tag (`campaignOrchestration = {campaignId, orgId,
briefId?, goalVersion, role?}`, ADR 0941 D2b) is host-written, reserved from
callers and copied verbatim on `:fork`. Every campaign launcher writes it
through `stampCampaignRun` (ADR 0961's autopilot, 0950's promotion runs, the
orchestration ignition). The same helper writes
`campaign-orchestration:run-index`, keyed `tenant::campaignId::startedAt::runId`
(point reads by prefix, no scan; a fork writes its own row with `forkOf`). The
cockpit shows forks with `role:'fork'` from that row. Forks started elsewhere
are found on the source run's detail page. The cockpit **never** lists runs
through `/v1/runs`; run bodies are read by id only after the index proves the
run belongs to this campaign's org (closes C-G2 for this surface).

### D3 — The live graph is the builder overlay, read-only

Extract the overlay's SSE subscription and status reducer from
`builderStore.ts` into `runs/liveRunOverlay.ts` (a pure hook,
`useLiveRunOverlay(runId)`), consumed by both the builder (unchanged behavior)
and a read-only `<RunGraphView definition overlay readOnly />` that renders the
builder canvas with editing disabled. The command center lazy-imports it (bundle
size; same rule CLAUDE.md sets for builder ↔ chat). Sub-chain children (RFC 0133)
render as collapsible group nodes that expand into the child run's own overlay.
Node badges add the agent (avatar + name from the roster) and, for a suspended
gate, the owning role and SLA countdown. **No new graph renderer.**

`RunHandoffMap` renders under the graph unchanged; selecting a node opens the
existing `RunStepInspector` in a side drawer.

### D4 — "Replay this decision" and "Fork from here"

From any completed node (an agent's output, a gate resolution, a promotion):

1. **Explain** — the step inspector with the node's inputs, outputs, tool calls,
   the frozen policy (`run.metadata` 0942 stamp), the playbook stamp (0959 D8)
   and the ledger version (0831). Read-only.
2. **Replay** — `:fork` with `mode:'replay'` and `fromSeq` just before the node.
   Deterministic; LLM calls are served from the invocation log and side-effect
   nodes reproduce the source outcome (`executor/sideEffects.ts`). Then open
   `:diff` against the source. This is the "prove it" button.
3. **Fork from here** — `:fork` with `mode:'branch'`, an optional input overlay.
   **Safety rule:** a branch fork of a campaign run must not spend, send or
   publish on its own. The 0942 policy stamp is copied verbatim on fork, so the
   cockpit relies on ADR 0942 D10.4's `forkPosture:'attended'`: on a run whose
   record carries `forkMode:'branch'` (stamped by the fork route,
   `routes/runs.ts:2002`; a dispatched child has `parentRunId` but no `forkMode`,
   `:1382-1388`), every external-effect action class resolves to `approve` (or
   `blocked`) regardless of the frozen level. Until 0942 P1 ships that rule, the
   cockpit does not offer branch forks on runs that contain side-effect nodes
   after `fromSeq` (the button is disabled with the reason).

Both actions use the existing endpoints; there is no new fork route and no wire
change (ADR 0474's correction applies: `ForkRunResponse` is normative, so any
cockpit-only data rides host metadata).

### D5 — Panels are projections that deep-link to their owner

| Panel | Source | Deep link |
|---|---|---|
| Gates waiting | approvals + run interrupts for indexed runs, with owners + SLA | the existing approval card / ADR 0926 inbox |
| Spend vs cap | 0952 cap ledger; today `buildPacing` | campaign-intel |
| Experiments | 0949 read, 0950 promotion log | experiment page |
| Alerts | pacing alerts, SLA breaches, drift findings, promotion rollbacks, failed runs, policy denials | the owning card |
| Team | ledger version + open drift (0831/0855), recent decisions (0853), handoffs (0829/0854) | project ledger tab |
| Agents | `projectAgentActivity` filtered to indexed runs | agent page |

Actions in the cockpit are the owners' own actions (approve, pause at cap,
accept drift as decision, roll back a promotion), called through the owners'
routes so each keeps its own authorization and CAS.

### D6 — Presence rides the campaign project's channel (closes C-G4)

The campaign's project (ADR 0852) has a bound channel. Opening the cockpit
joins presence on that channel id (`joinPresence`), so "Maya and the Media
Buyer agent are here" uses the existing tracker. No second presence system.

### D7 — Where it lives, and the vocabulary split (closes C-G5)

The cockpit is a **campaign detail tab** ("Command") inside the
`/campaign-studio` hub, per campaign — not a hub-level tab. ADR 0926's
Operations inbox stays plain-language for operators and links to "Open command
view" for a campaign. The 0926 denylist test applies to the inbox only; the
Command tab is an advanced, technical surface. This boundary is written into
both ADRs' tests (OQ1). A home-dashboard tile "Campaigns needing you" (gates
waiting + alerts across visible campaigns) is registered in `allTiles.ts`,
merging with 0926's tile rather than adding a second (OQ2).

Polling at 10 s for the snapshot; SSE only for the one run whose graph is open
(the existing stream). No new SSE channel.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | **Extends `features/campaign-orchestration/`** (`commandService.ts`, `runIndex.ts`, route) and its frontend package (Command tab). Core touch: none for the stamp (ADR 0941 owns it); the overlay hook extraction in `runs/` is a refactor of shared core UI, not a feature import. |
| 2 | Toggle | **No new toggle** — rides `campaign-orchestration` (default OFF, `bucketUnit: 'tenant'`). Panels degrade per their owners' toggles (D1). |
| 3 | Workflow surface | None (a read surface for people). Agents read campaign state through 0941/0943 tools, not the cockpit. |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None new. The Producer agent (0943) may get a read tool `campaign.command-summary` sharing D1's access predicate (`registerFeatureAgentTool`, fails empty without an acting user) — chat answers "what's blocked on campaign X". |
| 7 | Public surface | None. Clients see reports through ADR 0957, not the cockpit. |
| 8 | RBAC | `workspace:read` on the campaign's client org for the snapshot; fork actions require `runs:create` AND the client org row (the fork route's `loadOwnedRun` is tenant-only, so the cockpit checks the index + org first). Uniform 404 for a campaign in an org the caller cannot see. |
| 9 | Replay / fork | D4: uses `:fork` replay/branch as-is; the ADR 0941 run tag is reserved and copied verbatim; the branch-fork posture rule is owned by 0942 (D10.4). |
| 10 | Frontend | Command tab: graph (lazy `RunGraphView`), handoff strip, inspector drawer, right rail of panels; `ui/` primitives (`StateCard`, chips for status), 4-locale strings, keyboard-reachable node list as the accessible alternative to the canvas. |

## Why this is our advantage

- **OpenWOP primitives used:** durable run event logs and SSE, deterministic
  `:fork` replay with side-effect reproduction, `:diff`, named agents per node,
  role-routed gates with SLA, the team ledger and drift checks.
- **Competitor gap:** Salesforce and Adobe show journey/campaign status and
  approval queues, n8n shows execution logs, Braze Decisioning admits it is hard
  to trace. Nobody can re-run an agent's decision deterministically and show
  that the replay matched, or branch from a decision without risking live spend.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0** | Snapshot route with runs, nodes, gates (D1) over ADR 0941's run tag and run index (D2; needs 0941 P0) | Route test: a client-B operator gets 404 on client A's campaign; a spoofed `campaignOrchestration` in `POST /runs` metadata is stripped |
| P1 | Overlay hook extraction + read-only `RunGraphView` (D3); Command tab with graph, handoff strip, inspector | Builder overlay behavior unchanged (existing tests green); `npm run build` green |
| P2 | Replay + diff (D4.1–2); branch fork gated on 0942 `forkPosture` (D4.3) | Witness: a replay fork of a run with an ad-launch node creates zero new adapter calls |
| P3 | Spend, experiments, alerts, team panels (D5) as owners ship | Each panel shows `unavailable` honestly when its owner is off |
| P4 | Presence (D6), dashboard tile (D7), Producer agent read tool | Tool shares the route predicate (one helper) and fails empty without an actor |

## Alternatives weighed

- **A new campaign run viewer.** Fastest to build, but forks the run detail page
  and drifts. Rejected by the brief.
- **Put everything in the ADR 0926 inbox.** The inbox is deliberately
  plain-language and cross-client; a run graph breaks its copy rule and its
  purpose. The inbox links here instead.
- **A dashboard of tiles only.** Good for "what needs me", but cannot show a
  live graph or support replay. Tiles stay as the entry point.

## RFC verdict

**Host extension, no RFC.** One host route under
`/v1/host/openwop-app/campaign-orchestration/*`; fork/diff/events are existing
normative endpoints used as-is; the run tag is ADR 0941's host-written reserved
metadata key.

## Open questions

1. **(David)** Is the vocabulary split right — plain-language Operations inbox
   (0926) plus a technical Command tab per campaign — or should the cockpit hide
   graph vocabulary behind an "Advanced" toggle for client-facing operators?
2. Merge the 0926 tile and this ADR's tile into one "Campaigns needing you" tile?
   Proposed: yes, owned by 0926.
3. **(David)** Should branch forks of campaign runs be allowed at all for
   non-admins? Proposed: `editor` on the client org, with the 0942 fork posture.
4. Should a client approver (0924 portal) ever see a reduced cockpit? Proposed:
   no; 0957 reports cover clients.
5. *Resolved in program review:* ADR 0941 D2b owns the run tag and the run index.

## Planning rows

- **ROADMAP:** `| 0960 | Campaign command center | campaign-orchestration (extends; no new pack) | live run graph (builder overlay, read-only) + agent/human node status, gates + owners + SLA, spend vs cap, experiments, alerts, ledger/drift, presence; replay-this-decision + fork-from-here via :fork/:diff | deps 0941, 0942, 0943, 0926, 0829, 0831, 0852, 0855, 0949, 0950, 0952; integrates with 0961 | Tier 5 | 🔵 Proposed |`
- **FEATURES (Future features):** `| campaign-orchestration (Command tab) | Campaign command center | One live cockpit per campaign: who (agent or person) is on each step, what is waiting on whom, spend vs cap, experiments and alerts, with replay and fork from any decision. | rides campaign-orchestration (OFF) | tenant | ADR 0960 |`
