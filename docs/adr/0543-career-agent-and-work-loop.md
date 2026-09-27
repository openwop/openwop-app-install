# ADR 0543 — the career agent: a persona and chains, not a second work loop

Status: implemented

Parent: [ADR 0539](0539-job-search-vertical-strategy.md). Composes: roster/agent-profile
(ADR 0031/0036), heartbeat work loop (ADR 0313/0318), kanban (ADR 0311), **ranked work
selection (ADR 0534)**, **stranded-card recovery (ADR 0535)**, approvals, the ONE chat
(ADR 0073), workflow-chain packs (RFC 0013 / ADR 0163).

Module: `features/job-search/agent/` · Toggle: **`job-search`** (the ONE vertical flag — ADR 0539 D0). No toggle of its own.

## Context

The prior art's autonomous loop is a genuinely good autonomous loop: fetch a server-compiled agenda, take
the single top item, claim it with a TTL, do exactly one thing, record it, exit — and let an
external orchestrator re-inject. Its lessons were studied in depth and the transferable ones
have **already been ported**: ranked selection (ADR 0534) and work-item recovery (ADR 0535)
landed and are deployed.

So what remains is not a loop. It is a **persona** and the **work it knows how to do**.

## Decision

### D1 — No second loop. The heartbeat is the loop.

| the prior art Pilot | openwop-app equivalent | Status |
|---|---|---|
| server-compiled ranked agenda | `orderWorkCandidates` + the `work-selection` compiler | **shipped** (ADR 0534) |
| claim with TTL + heartbeat + release | run dispatch lease + `claimOrphanedRuns` + sweeper | **shipped** |
| abandoned claim returns work | card restore on terminal run | **shipped** (ADR 0535) |
| one item per cycle | one card per heartbeat pass | **shipped** |
| journal | run events + `workforceHistory` + kanban card history | **shipped** |
| questions to a human | approvals / interrupt cards + Notifications | **shipped** |
| cadence + caps | ADR 0318 admin cadence + `checkAutonomousRunBudget` | **shipped** |

Building a `pilot` feature would duplicate every row. **This ADR ships no loop.**

### D2 — The agent is a roster member with an agent profile

A named career agent (persona, e.g. "Sam") is a standing roster member with an
`agentProfile` (ADR 0031/0036) declaring its capability activation, its `hitl` action
classes, and its `permissions.never` set. Per the house law — *nothing unique to a named
agent lives in source* — the persona is **data**: an agent pack plus a profile, not a
special case in `heartbeatService`.

Its autonomy level composes the existing resolver: `review` proposes every pick, `guided`
proposes high-priority picks, `auto` runs. Auto-**submit** is separately bounded by the
ADR 0541 grant — two independent gates, deliberately.

### D3 — The work is chains and stacks, never hard-coded

`ARCHITECTURE.md` is explicit: a workflow ships as a **chain** (RFC 0013 pack, builder-
editable, `/`-runnable) or a **stack** (kanban todos), never an in-tree
`builtinWorkflows` module — a code-pinned workflow is invisible to the builder and the `/`
picker and cannot be edited.

the prior art's skills therefore become **chain packs**:

| the prior art skill | Ships as |
|---|---|
| `search` | `career.search` chain — board search (0542) → score (0540) → create pending applications |
| `auto-apply` | `career.apply` chain — eligibility (0540) → tailor résumé (0540 D4) → submit under a grant (0541) → record outcome |
| `scan-inbox` | **nothing new** — CRM `gmailSyncService` already syncs Gmail → CRM activity; the chain classifies and proposes a stage move |
| `networking` | `career.outreach` chain over CRM contacts + the email spine |
| `tailor-resume` / `cover-letter` | nodes in `feature.job-search.nodes`, invoked by the apply chain |
| `pilot` | **nothing** — the heartbeat is the loop (D1) |

A campaign is a **stack**: cards on the agent's board, ranked by ADR 0534, recovered by
ADR 0535. "Auto-apply up to 25" is a grant (0541) plus a stack of cards — not a bespoke
campaign runner.

> **Correction note (2026-08-15, WF-JS-1).** As shipped, this D3 was half-true:
> the chains existed but the campaign had NO dispatch lane at all —
> `runCampaign`/`applyToListing` had zero production callers
> (WORKFLOWS-ASSESSMENT § job-search, the one Blocker), and the shipped node
> pack had over-tightened this section's own table ("submit under a grant") into
> "deliberately NO submit node". The law's substance is **no node may route
> AROUND the grant**, not "no node may submit". Closed the doctrine-fit way:
> a `career.campaign` chain (one `run-campaign` node that takes NO target — it
> triggers the tenant's standing campaign, every submission inside it
> grant-consulted, pace-bounded, claim-CAS'd), registered SAME-ID chain-backed
> so board cards can name it; `POST …/agent/queue-campaign` files the card
> (grant-gated 409, idempotent); execution rides this ADR's loop unchanged —
> ranked pick → policy → budget → review-approval → run. Two stored promises
> gained teeth on the way: the grant's `ratePerHour` (epoch-hour window inside
> the `consumeSubmit` CAS) and the steering `dailyCap` (CAS'd per-subject
> UTC-day counter). The `career.search`/`career.apply` chains keep the strict
> no-submit-node law verbatim; boards without a hardened submission integration
> report `board-no-submit-lane` in the pass digest rather than pretending.

### D4 — Chat-drivability is the ONE chat

Per the reuse law, no second chat panel and no bespoke "talk to your career agent" textarea.
The agent is reachable by deep-linking the main chat scoped to it
(`navigate('/?agent=<agentId>')`), or by embedding `chat/EmbeddedChatPanel` in the
job-search surface. Capability comes from the agent pack + node packs, not from a new UI.

### D5 — Human questions ride the existing approval path

the prior art posts a `PilotQuestion` with a deep link and parks the job. Here that is an
**approval/interrupt card** (already chat- and notification-surfaced, already delivering
deep links, already the thing `heartbeatService` proposes through), and the parked card
sits in the board's waiting lane. No new question store.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `src/features/job-search/agent/` — a MODULE: the agent pack, chain packs, and provisioning. Thin: it wires, it does not execute. |
| 2 | **Toggle** | **`job-search`** — no toggle of its own (ADR 0539 D0). `computer-use` stays optional: without it the chains degrade to manual-entry applications rather than failing. |
| 3 | **Workflow surface** | **None of its own** — it *consumes* `ctx.features['job-search']` and `['job-boards']`. A package that only orchestrates should not also be a surface. |
| 4 | **Node pack** | **None new.** Nodes live with their domains (0540/0542). This package ships **chain** packs, which is the point of D3. |
| 5 | **Envelopes** | **None.** |
| 6 | **Agent pack** | `feature.career-agent.agents` — one persona. Tool allowlist is explicit, never added to the ADR 0315 default-on baseline. |
| 7 | **Public surface** | **None.** |
| 8 | **RBAC** | Provisioning requires `workspace:write`. The agent acts under its roster identity; every write goes through the owning service's authz (CRM, Documents), never a direct store write. |
| 9 | **Replay/fork** | Chains are pinned by definition id (ADR 0474 — a recovered run re-executes the exact definition it ran). Grant id + remaining budget stamp on the run (0541 D4). Selection rationale stamps via ADR 0534 D3. |
| 10 | **Frontend** | The agent's existing workspace (Board / Activity / Instructions tabs) — including the ADR 0534 "Up next" panel, which already explains what it will do next and why. Plus a job-pipeline view (0540). **No new agent shell.** |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | Agent pack + profile + provisioning (roster member, board, default instructions). | The agent appears in the roster, gets a board, and is chat-reachable — with zero core edits. |
| **P2** | `career.search` chain over 0540 + 0542. | Chain loads through the built loader, shows in the builder gallery and the `/` picker, instantiates tenant-owned + editable. |
| **P3** | `career.apply` chain, submit gated by the 0541 grant. | End-to-end: no grant ⇒ approval card; valid grant ⇒ submit + decrement + audit row. |
| **P4** | `career.outreach` + the inbox-classification chain over CRM Gmail sync. | Untrusted-content fixture: an email body instructing an action is classified, never obeyed. |
| **P5** | Instructions/goals surface (the agent's steering input). | Route tests; the goals PROSE never reaches ranking, and the structured policy it shapes does. |

*(P5 verification corrected by architecture review, before implementation.)* The row
originally read "the goals text is the tie-break input the ADR 0534 ranking already
consumes" — which **contradicts OQ-2 in this same ADR** and is false about the code.
`computePriority(set, scores: Record<string, number>)` takes numbers only; there is no
text input anywhere in the ranking, and adding one would mean inventing a semantic
scorer whose output cannot be reproduced — voiding the ADR 0534 D3 replay stamp, which
is the thing that lets a past decision be explained.

OQ-2 is the correct half and the implementation follows it: goals are a human-readable
steering DOCUMENT, and they shape the **policy** (roles, locations, floors) which ranks
deterministically. The policy is ADR 0545 D5's, so this phase writes to that one store
rather than standing up a second.

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Port the Pilot loop as a `pilot` feature** | **Rejected** — D1: every row already has an owner, several shipped days ago. |
| **Hard-code the campaign workflows in-tree** | **Rejected** — `ARCHITECTURE.md` forbids it; invisible to builder + `/`, not user-editable. |
| **A bespoke career-agent chat panel** | **Rejected** — the single-chat law; the precedent (`AiAuthorPanel`) was built and removed. |
| **Persona + chains over the existing loop (chosen)** | Ships the vertical without a second execution model. |

## RFC gate

**Host work, no RFC.** Chain packs ride the already-Accepted RFC 0013; agent packs are an
existing shape. Nothing new on the wire.

## Open questions

- **OQ-1 — one persona. RESOLVED: one.** Per-action-class autonomy (ADR 0036) already gives
  separate pause control over applying vs outreach, so a second agent buys nothing and costs
  the shared context. And under ADR 0546 D0 the two tracks are the *same* judgement about the
  *same* role — precisely the thing that should not be split across two agents with two
  memories. Prior art separates them as worker roles; here they are chains, which is the
  right seam.
- **OQ-2 — goals. RESOLVED: a human-readable steering document, NOT a ranking input.** A
  semantic tie-break would make selection non-deterministic, which voids the ADR 0534 D3
  replay stamp — a stamp that cannot reproduce its own decision explains nothing. Goals shape
  the *policy* (roles, locations, floors), and the policy ranks deterministically.
- **OQ-3 — cadence. RESOLVED: event-driven, per-agent.** Wake on the two events that
  actually matter — a **new matching listing** and an **inbound reply** — rather than polling
  a fixed interval. A job search has no work between those events, so a fast poll burns
  budget to discover nothing, and a slow poll makes a recruiter reply sit unread. Falls back
  to the ADR 0318 cadence when no event source is wired.

## Implementation record

| Phase | Evidence |
|---|---|
| P1 | Agent pack + persona prompt + idempotent provisioning (roster member + owned board). Tests assert NO host source names the agent and the heartbeat was untouched. The CFP-1 ratchet caught node ids in a `toolAllowlist` and exposed that ADR 0540's chat tools were never built. |
| P2 | `career.search` chain. Three ratchets caught three manifest defects: `outputs` written as node refs, every parameter dead, and required whole-value params joining the ADR 0504 debt. |
| P3 | `career.apply` — prepares, then starts a computer-use session. Found that `applyContext` was READ by the commit gate and SET by nothing, so ADR 0541's grant integration was unreachable. |
| P4 | Inbox classification (closed label set ⇒ never obeyed) + warm-intro drafting (no send capability). Rejected reusing `proposals` and `screenPostingText`, both for stated reasons. |
| P5 | Steering: prose + policy in ONE store, with the prose provably outside ranking. |

**The recurring lesson across these five phases** is the difference between a
mechanism working and a mechanism being REACHABLE. P3's defect — a grant consult
that no caller could trigger — passed every test written for it, because those
tests constructed the input by hand. Three of the five phases were corrected by
reading what the code actually consumes rather than what the ADR said it did.
