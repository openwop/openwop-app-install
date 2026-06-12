# ADR 0023 — Executive Assistant / Chief-of-Staff Agent

**Status:** Accepted — Phase 0 (memory graph + `ctx.features.assistant`) + the loop layer (node/agent packs, prioritization, idempotent board projection) + the frontend **implemented + tested** (`d89505b`, `2c3be99`, `1f78423`). **§12 activation tranches T1–T8 implemented + tested** (2026-06-11 gap-closure plan — see §12 + the Phase ledger): Connections injection (ADR 0024 Phase D), Calendar/Drive ingestion + morning-briefing loops on RFC 0052, action cards on the single approval loop, taint gating (ADR 0027), execute-on-approve, governance (ADR 0028), evals/health + indexes (ADR 0029). **Live Google reads/writes remain deploy-gated** on OAuth client config + (for MCP-reach providers) a registered Google MCP server; the LLM extractor/drafter agents ride agent dispatch on the same gate.
**Date:** 2026-06-10 (implemented 2026-06-11)
**Depends on (hard):** ADR 0024 (Connections broker — per-user/org credentials)
for all perception; ADR 0025 (user/agent orchestration symmetry — the human's
board + the approval loop the assistant feeds); ADR 0014 (feature workflow
surfaces); ADR 0001 (feature-package); ADR 0015 (workspace = tenant); ADR 0006
(RBAC).
**Composes (reuse, do not fork):** the existing node packs
`core.openwop.mcp` (Google I/O via a registered MCP server),
`core.openwop.http` (`fetch`/`openapi-call`), `core.openwop.integration`
(`email-send`/`slack-message`/`notification-push`), `core.openwop.a2a`
(agent-to-agent), `core.openwop.hitl` (`approval-request`/`ask-user`),
`core.agents.tool-{mcp,http,workflow}` (agent tools); plus `kb` (ADR 0011, RAG),
`host.kanban` (`ctx.kanban`), `crm` (ADR 0008, people/companies), Notifications
(ADR 0010), RFC 0052 scheduler, RFC 0083 trigger bridge, RFC 0086
roster + heartbeat, `ctx.memory` (agent scratchpad), `ctx.http.safeFetch`
(RFC 0076 egress), the human-in-the-loop interrupt seam.
**Surface:** `/v1/host/sample/assistant/*` + `ctx.features.assistant`
(host-extension, **NON-NORMATIVE — no RFC**).
**Toggle:** `assistant` · category `Workspace` · default OFF · `bucketUnit: 'tenant'`
· variants = the **prioritization profiles** (`conservative` / `balanced` /
`aggressive`), bound to weighting bindings · packs `feature.assistant.{nodes,agents}`.

> **⚠ CORRECTION (2026-06-11) — the "named roster agent" claim was prose-only;
> now made true.** The original implementation declared this identity but never
> instantiated a `RosterEntry`: `approvalService.createAssistantActionApproval`
> hard-coded `rosterId:'assistant', persona:'chief-of-staff'` — a literal that
> resolved to NO roster member — and the perception loops registered
> `ScheduledJob`s with no `rosterId`, keyed only by tenant. The result was a
> parallel architecture shadowing the roster primitive (the orgs↔accessControl
> trap) plus a standalone `/assistant` page reimplementing the board+schedules+
> approvals surface the generic agent-workspace page already renders.
> **Fixed:** `features/assistant/chiefOfStaff.ts` ensures a real, idempotent
> `RosterEntry` (persona **"Iris"**, role `chief-of-staff`, agentRef
> `host:demo-chief-of-staff`, `review` autonomy); loops register with its
> `rosterId`/`agentId` (so they are that agent's *recurring tasks*, visible in
> its Schedules tab); approvals attribute to it (so they appear in the roster's
> "Waiting on me" lane as the agent). The `/assistant` page is therefore
> redundant and is removed — the Chief of Staff's page IS the agent-workspace
> page. See [[no-parallel-architecture]] for the standing rule this enforces.
>
> **Consolidation (2026-06-11, follow-up).** The Chief of Staff is created
> through the ONE seeder path (`demoAgents.json` → `ensureSeededAgentByRole`),
> never feature code. The `assistant` feature toggle is removed (graduated,
> like Connections/Users); the `/assistant` page is deleted; the loop manager
> is the **"Recurring tasks"** panel at the bottom of the Chief-of-Staff
> agent-workspace page (the agent "Schedules" tab is renamed accordingly).
> Users can **pin** any agent (incl. the Chief of Staff) to an indented
> sidebar sub-menu (`Profile.pinnedAgentIds`, ADR 0005).
>
> **EA features baked into the base agent (2026-06-11, follow-up).** Deleting the
> `/assistant` page meant its rich approval surface had to live where every
> agent's approvals already live — the `ApprovalsInbox`. It is now **polymorphic
> on approval kind**: a *run-proposal* renders the compact "Run X on card Y" row
> (claiming starts the run + navigates); an *assistant-action* renders the rich
> **ActionCard** (kind + destination, risk tier, taint banner, draft preview +
> Edit, recipient diff, why-recommended, source citations with the http(s)-only
> `safeHref` guard). The card metadata rides on the approval row, projected by
> the feature via `registerAssistantActionProjector` — core's approvals LIST
> route stays feature-agnostic (the same hook discipline as the decision
> handler). This also fixed a regression: assistant-action claims return
> `{ actionId }`, not `{ runId }`, so the claim path no longer navigates to
> `/runs/undefined`. The Chief of Staff's **operating health** (`/assistant/health`,
> superadmin-gated) is likewise surfaced as a role-gated panel on its workspace
> page, beside Recurring tasks — reusing the existing endpoint, not a new
> per-agent metrics store. Taint *discipline* (`isAutoAllowEligible`,
> `derivedFromUntrusted`) was already the single backend gate; its user-visible
> surface (the card banner) now rides the base agent inbox. There is no
> auto-allow path on run-proposals to gate, so no further generalization was
> warranted.
>
> **One-line identity.** The assistant is a **named roster agent (RFC 0086) — a
> "Chief of Staff"** — that owns a kanban board, holds a **structured memory
> graph** the host doesn't have today, and runs a set of **scheduled / event-
> triggered OpenWOP workflows** that read that graph and surface only what needs
> the principal's judgment. It is *assembled* from existing host primitives; the
> only genuinely new owned concept is the entity graph.
>
> **This is the app's thesis, not a special case.** The assistant is one more
> orchestration principal on the **same rails** every agent uses: identity + board
> + schedules + assigned workflows + activity + autonomy-gated approvals (RFC
> 0086). Its distinctive move is that it **assigns work to, and routes approvals
> through, the _human's_ board** (ADR 0025) — the human is a peer principal, not a
> chat window. **RAG is the `kb` feature (ADR 0011), full stop** — the assistant
> never stands up a parallel vector store; every unstructured source it ingests
> becomes a `kb` document and every retrieval is `ctx.features.kb`.

---

## 1. Product summary & phasing

A chief of staff, not a chatbot: value comes from **holding context across
sources** and **acting proactively on schedules/triggers**, surfacing to the
principal only decisions, handling or deferring the rest. Three layers:

- **Perception** — Drive, Calendar, Gmail, meeting transcripts, the kanban board
  (ingested via ADR 0024 + existing `kb` ingest).
- **Memory** — a **structured entity graph** (this ADR's new store) layered over
  the **unstructured RAG**, which **is the `kb` feature (ADR 0011)** — the two
  cross-reference via `SourceRef` (graph entity → `kb` document).
- **Action** — proactive workflows that write the graph, populate **the human's
  board** (ADR 0025), and **draft** outbound actions onto the **existing approval
  loop** (heartbeat pending-approval + Notifications) — nothing sends without the
  principal in early phases (decision 4).

### Phasing (memory + first four loops come early, per the brief)

| Phase | Ships | Why here / gate |
|---|---|---|
| **0 — Foundation** | `assistant` feature-package, the **memory graph** stores + `ctx.features.assistant` **read** surface, RBAC, toggle (OFF), the **Chief-of-Staff roster agent**. Seeds from existing `kb`/`crm`/`kanban` — **no Google yet**. | Establishes the graph + the agent identity with zero external dependency. Demoable single-user. |
| **1 — Perception (read)** | ADR 0024 Phases A–B (Connections broker read path — a Google connection + MCP server / `openapi-call`). | **Hard gate:** no ingestion of external sources until this lands. |
| **2 — Loop 1** | Drive→RAG ingestion + scheduled reconciliation sync. | Needs Phase 1 + `kb` Drive-ingest & binary-parse extension. |
| **3 — Loops 2 + 3** | Commitment/action-item extraction (all sources) → **kanban population**. The core PM identity. | Needs the graph (P0) + Drive corpus (P2) + the kanban `sourceId`+`contentHash` dedup field. |
| **4 — Loop 4** | Meeting lifecycle (prep brief + post-meeting extraction → decisions/commitments). | Needs Calendar (P1) + commitment extraction (P3). |
| **5 — Loop 5 + prioritization** | Daily/weekly briefings; the **prioritization layer** goes live (first real surfacing). | First phase that *surfaces*; needs the graph populated. |
| **6 — Loop 6** | Calendar intelligence (conflicts, focus-time, anticipatory reschedule **drafts**). | Needs Calendar + prioritization. |
| **7 — Loop 7** | Comms triage + drafting. | Needs ADR 0024 Phase C (write scopes); **draft-only, approval-gated**. |
| **8 — Loop 8** | Stakeholder cadence nudges. | Needs the graph + contact/meeting history. |

---

## 2. Memory / context data model — as an extension of the existing model

Each entity is a `DurableCollection<T>` carrying `tenantId` (workspace-scoped,
ADR 0015; auto-rekeyed by `reassignTenant`), keyed `${tenantId}:${id}`, with the
IDOR-guard read pattern (`crmEntitiesService.ts` precedent). **People are not a
new entity** — they resolve to CRM contacts. The store owns the *graph between*
projects, decisions, commitments, meetings, and stakeholders.

```
Project {                    // NEW. The strategic spine. No existing owner.
  projectId, tenantId, name, status, priority(0..100), summary,
  boardId?,                  // → host.kanban board (tactical surface)
  kbCollectionId?,           // → kb collection (its document corpus)
  stakeholderIds[], createdAt, updatedAt }

Commitment {                 // NEW. The PM core. PROJECTS onto a kanban card.
  commitmentId, tenantId, projectId?,
  owner: PersonRef,          // who owes it (CRM contact | self | bare email)
  description, dueAt?, status('open'|'in-progress'|'blocked'|'done'|'dropped'),
  confidence(0..1),          // extraction confidence (drives surface vs auto-file)
  source: SourceRef,         // ← the cross-layer link to where it came from
  kanbanCardId?,             // ← back-ref to the host.kanban card (Loop 3 writes)
  createdAt, updatedAt }

Decision {                   // NEW.
  decisionId, tenantId, projectId?,
  statement, decidedAt, decidedBy: PersonRef, rationale,
  source: SourceRef, supersedesDecisionId?, createdAt }

Meeting {                    // NEW. Bridges Calendar ↔ transcript(kb) ↔ graph.
  meetingId, tenantId, calendarEventId,   // → Google Calendar (ADR 0024)
  title, startAt, endAt, attendees: PersonRef[],
  prepBriefRef?,             // generated brief (a kb doc or artifact)
  transcriptKbDocId?,        // → kb document (post-meeting transcript)
  decisionIds[], commitmentIds[], createdAt }

StakeholderProfile {         // NEW. A thin OVERLAY on a CRM contact.
  stakeholderId, tenantId, person: PersonRef,   // identity lives in CRM
  importance(0..100), intendedCadenceDays,
  lastMeaningfulContactAt, notes, createdAt, updatedAt }

PendingAction {              // NEW (thin). A typed draft attached to the EXISTING
  actionId, tenantId,        //   heartbeat pending-approval + Notifications loop
  kind('email.send'|'calendar.invite'|'calendar.reschedule'|'nudge'),  //   (ADR 0025 §4) — not a parallel queue.
  payload, draft, status('pending'|'approved'|'rejected'|'sent'|'failed'),
  sourceCommitmentId?, createdBy:'assistant', approvedByUserId?, createdAt }

// value objects (embedded, not stored standalone):
PersonRef = { kind:'crm-contact', orgId, contactId }   // ← CRM owns the person
          | { kind:'self' }
          | { kind:'email', address }                   // unresolved → may promote to a contact
SourceRef = { kind:'drive'|'gmail'|'calendar'|'transcript'|'kb-doc'|'manual',
              externalId, kbDocumentId?, url?, contentHash, capturedAt }
```

> **Extension (2026-06-11 — gap-closure plan, architect-reviewed).** Two value
> shapes gain **additive** fields; nothing existing changes meaning:
>
> - `SourceRef` gains **`contentTrust?: 'trusted' | 'untrusted'`** — the RFC 0021
>   vocabulary already flowing through `envelopeAcceptor`/`promptCompose`, **not a
>   new enum** (ADR 0027). Ingestion loops stamp `'untrusted'` on everything
>   provider-derived; absent = `'trusted'` (manual/internal) for back-compat.
> - `PendingAction` gains the **action-card metadata** the approval UX renders:
>   `riskLevel?('low'|'medium'|'high')`, `requiredScopes?: string[]`, `reason?`,
>   `sourceRefs?: SourceRef[]`, `recipientDiff?: {before: string[], after: string[]}`,
>   `derivedFromUntrusted?: boolean` (OR over its sources' `contentTrust`, ADR
>   0027), `approvalId?` (→ the `PendingApproval` carrying the approval act, §7),
>   and `editedAt?`/`editedByUserId?` (an edit re-pends the action — changed
>   drafts/recipients always re-approve).

**How the two layers reference each other.** A `Commitment`/`Decision`/`Meeting`
carries a `SourceRef` whose `kbDocumentId` points at the **unstructured** chunked
document in `kb`, and whose `externalId`+`url` point at the **origin** (Drive
file, Gmail message, Calendar event). So "show me the email this commitment came
from" is a graph→`SourceRef`→`kb`/Gmail traversal; "what commitments did this doc
produce" is the reverse index. `contentHash` is the idempotency key for re-ingest.

**Relationships:** `Commitment→owner(PersonRef→CRM)`, `Commitment→Project`,
`Commitment→kanban card`, `Commitment→SourceRef`; `Decision→Project / decider /
SourceRef / supersedes`; `Meeting→attendees / calendarEvent / transcript(kb) /
produced Decisions+Commitments`; `StakeholderProfile→CRM contact`;
`Project→{board, kb collection, stakeholders}`.

**Memory write paths (which input/loop creates or updates which entity):**

| Writer | Creates / updates |
|---|---|
| Loop 1 (Drive→RAG) | `kb` documents + `SourceRef`s (unstructured layer); links a `Project.kbCollectionId` |
| Loop 2 (commitment tracking) | **primary writer of `Commitment`**; resolves `owner→PersonRef` via `crmService` (find-or-create contact) |
| Loop 3 (kanban) | projects `Commitment`→kanban card; writes `kanbanCardId` back; dedup `(sourceId, contentHash)` |
| Loop 4 (meeting) | `Meeting`; post-meeting → `Decision` + `Commitment` + transcript `kb` doc |
| Loop 7 (comms) | `PendingAction` (drafts); never sends without approval |
| Loop 8 (cadence) | `StakeholderProfile.lastMeaningfulContactAt` from calendar/email/meeting signals |

---

## 3. The eight loops — triggers / steps / state transitions

Every loop is an OpenWOP **workflow** (a DAG of node `typeId`s, ADR 0014)
dispatched by the **Chief-of-Staff roster agent**, triggered by a **scheduler job**
(RFC 0052) or the **trigger bridge** (RFC 0083). All runs are
**run-budget-ceiling-gated** (`runBudgetService`) — essential for an always-on
agent — and inspectable via `/v1/runs` + `/v1/runs/{id}/events`.

> **Design principle — compose existing self-contained nodes for all I/O.** The
> loops do **not** call a bespoke Google client. Drive/Gmail/Calendar reads use
> **`core.openwop.mcp.{read-resource, subscribe-resource, invoke-tool}`** against
> a **registered Google MCP server** (or **`core.openwop.http.openapi-call`** on
> Google's Discovery docs); outbound mail uses
> **`core.openwop.integration.email-send`**; approvals use
> **`core.hitl.approval-request`**; delegation to other agents uses
> **`core.openwop.a2a.*`**. ADR 0024 supplies only the **per-user token** those
> nodes inject. The Chief-of-Staff agent is granted these as tools via
> **`core.agents.tool-mcp` / `tool-http` / `tool-workflow`**, so it can run the
> scheduled loop-workflows directly. The assistant's **own** node pack
> (`feature.assistant.nodes`) is thin: it holds only the **graph/logic** nodes
> (`extract-commitments`, `populate-board`, `prioritize`, `compose-briefing`) —
> not I/O.

**1 · Drive→RAG ingestion + sync.**
*Trigger:* scheduler job, hourly (configurable) — **or** event-driven via
`core.openwop.mcp.subscribe-resource` on the Drive folder (fires on
`notifications/resources/updated`). *Steps:* `mcp.read-resource` (or
`http.openapi-call` Drive `files.list`) → diff against a stored
`DriveSyncState{fileId→{contentHash, kbDocId}}` → for new/modified: read text →
`ctx.features.kb` ingest; moved/renamed: metadata update; deleted: tombstone the
`kb` doc. *State:* per-file `synced|stale|deleting`; *idempotent* via
`contentHash`; *partial-failure:* per-file claim + resumable cursor, rate-limit
backoff handled by `ctx.http.safeFetch` (RFC 0076). *Only new `kb` work:* binary
(PDF/Office) text extraction (the MCP server may already return text; otherwise a
`kb` parse extension).

**2 · Commitment / action-item tracking.**
*Trigger:* trigger-bridge events from Loop 1 (new/changed `kb` doc),
`core.trigger.mailhook`/`email-imap` **or** `mcp.subscribe-resource` on Gmail
(new mail), Loop 4 (transcript), chat envelopes. *Steps:*
`feature.assistant.agents.extractor` reads the source via `ctx.features.kb.rag`,
emits candidate commitments (owner, description, due, confidence) → resolve `owner` to a `PersonRef` (`crmService` find-or-create) →
upsert `Commitment` keyed by `(SourceRef.contentHash, normalized-description)`
(dedup). *State:* `open→in-progress→{done|blocked|dropped}`; re-extraction of a
changed source **updates in place** (same key), never duplicates.

**3 · Kanban population & maintenance.**
*Trigger:* on `Commitment` upsert (Loop 2). *Steps:* `ctx.kanban.taskCreateBatch`
**onto the owner's board — the human's personal board (ADR 0025) when the owner is
the principal, or an agent's board when delegated** — with `source:'agent'`,
`sourceLabel:'assistant:commitment'`, the new **`sourceId`+`contentHash`** card
fields, `assignmentReason` (= why surfaced), `dueAt`, `priority` (from the
prioritization layer). Write `kanbanCardId` back to the `Commitment`. *Source-
changed/deleted behavior (explicit):* same `sourceId` + changed `contentHash` →
**update card in place**; source deleted → **flag** the card (move to a "Review"
column + `blockerNote:'source removed'`), never silently delete the principal's
work. *Dedup across runs:* `(sourceId, contentHash)` lookup before create.

**4 · Meeting lifecycle.**
*Before — trigger:* scheduler scan for events starting within the lead window
(`mcp.invoke-tool` / `http.openapi-call` Calendar `events.list`).
*Steps:* assemble a **prep brief** from the event (attendees) + per-attendee open
`Commitment`s + `ctx.features.kb.retrieve` (relevant docs) + prior `Meeting`s;
store `Meeting{prepBriefRef}`; surface via Notifications.
*After — trigger:* transcript arrives (Drive/Meet file via Loop 1, or upload).
*Steps:* ingest transcript→`kb`; `extractor` → `Decision`s (logged to graph) +
`Commitment`s (→ Loop 2/3). *State:* `scheduled→prepped→occurred→processed`.

**5 · Daily / weekly briefings.**
*Trigger:* scheduler (morning / end-of-day / Friday). *Steps:* query the graph +
board via `ctx.features.assistant` + `ctx.kanban.boardReview` → run the
**prioritization layer** → compose: today's meetings+prep, top priorities,
what's at risk, what's waiting on the principal; weekly wrap adds closed/slipped/
needs-decision. *Delivery:* Notifications inbox (ADR 0010) + optional messaging
relay; **no new channel built.**

**6 · Calendar intelligence.**
*Trigger:* scheduler + `core.trigger.artifact`/calendar-change events. *Steps:*
detect conflicts/over-booking, protect focus-time, attach prep to events, run a
periodic time-audit, draft anticipatory reschedules when an upstream event moves.
*All mutations are `PendingAction` drafts* (decision 4) until ADR 0024 Phase C.

**7 · Communications triage & drafting.**
*Trigger:* `mailhook`/`email-imap` on inbound. *Steps:* classify by urgency ×
sender-importance (`StakeholderProfile`) → prioritization layer decides
surface/handle/defer → `drafter` agent writes a reply **in the principal's voice**
→ `PendingAction{kind:'email.send'}` routed through a **`core.hitl.approval-request`**
node. Chase unanswered threads (both directions) as nudges. **The assistant may
*draft* freely; it may *send* nothing without approval** — an approved action
executes via **`core.openwop.integration.email-send`** (or the Google MCP `send`
tool) using the user's write-scoped token (ADR 0024 Phase C).

**8 · Stakeholder cadence.**
*Trigger:* scheduler, daily. *Steps:* for each `StakeholderProfile`, compare
`now - lastMeaningfulContactAt` against `intendedCadenceDays`; if overdue and
importance high → surface a nudge (`PendingAction{kind:'nudge'}`). Updated by
Loops 4/7 (meeting/email = meaningful contact).

---

## 4. Prioritization layer

A single **tunable scoring function** over every item the loops emit (a
`SurfaceItem` = a commitment, a draft, a meeting, a nudge). It decides **surface /
handle / defer**.

- **Signals:** `senderImportance` (`StakeholderProfile.importance` + CRM
  relationship), `deadlineProximity` (`dueAt`), `projectPriority`
  (`Project.priority`), `priorEngagement` (`lastMeaningfulContactAt` + thread
  history). Score = weighted sum → bucket by two thresholds.
- **Outcome:** `surface` → morning brief / approval queue (needs judgment);
  `handle` → autonomous **within the approval policy** (early phases: only
  non-outbound handling — file, tag, update graph); `defer` → snooze with a stored
  reason (re-evaluated next run).
- **How the principal tunes it (two levers, no redeploy):**
  1. **Profile (coarse) = a toggle variant.** The feature declares candidate
     profiles `conservative|balanced|aggressive` as **variant bindings** (the
     existing admin-administered binding system, FEATURES.md § "Variant → behavior
     bindings"). An admin picks the active profile per workspace from the
     Feature-toggles screen. **Replay-safe:** the resolved profile stamps into
     `run.metadata.featureVariant` at run creation, read verbatim on `:fork`.
  2. **Weights + overrides (fine) = per-tenant config.** A
     `PriorityConfig{tenantId, weights, perProjectOverrides, perPersonOverrides,
     thresholds}` `DurableCollection`, edited from the assistant settings page.
- **Why this design:** reuses the host's sticky-bucketing/variant engine and
  replay-stamp discipline rather than inventing a parallel config system — the
  same reuse choice ADR 0018 made for A/B.

---

## 5. Mapping table — each new piece → existing component / new extension point

| New piece | Attaches to / extends | New extension point? |
|---|---|---|
| `Project/Commitment/Decision/Meeting/StakeholderProfile/PendingAction` graph | `DurableCollection` (storage), `reassignTenant` (migration) | **New store** (the only new owned concept) |
| People (`PersonRef`) | **CRM** `crmService` (find-or-create contact) — compose | no — reuse |
| Action items on a board | **`host.kanban`** `ctx.kanban.taskCreateBatch/moveTask` — compose | **kanban `sourceId`+`contentHash` card fields** (small extension for idempotent population) |
| Unstructured docs / RAG | **`kb`** `ctx.features.kb` — compose | **`kb` Drive ingestion + binary (PDF/Office) text extraction** |
| Agent scratchpad/working memory | existing **`ctx.memory`** (distinct from the graph) — compose | no — reuse |
| **Google Drive/Gmail/Calendar I/O** | **`core.openwop.mcp`** (registered Google MCP server) + **`core.openwop.http.openapi-call`** + **`core.openwop.integration.email-send`** — compose | no — reuse the nodes; ADR 0024 supplies only the **per-user token** |
| Outbound-action approval | **`core.hitl.approval-request`** — compose | no — reuse |
| Agent-to-agent delegation | **`core.openwop.a2a.*`** — compose | no — reuse |
| Granting the agent these tools | **`core.agents.tool-{mcp,http,workflow}`** — compose | no — reuse |
| The agent runner / "Chief of Staff" identity | **`rosterService` + `heartbeatService`** (RFC 0086) — compose | no — reuse |
| Scheduled loops | **RFC 0052 scheduler** `/scheduler/jobs` — compose | no — reuse |
| Event triggers (mail/doc-change) | **RFC 0083 trigger bridge** + `core.openwop.triggers` pack — compose | no — reuse |
| Surfacing / briefings / approvals | **Notifications (ADR 0010)** + **interrupt seam** — compose | no — reuse |
| Per-user access to Google/Slack/Zoom/… | existing `core.openwop.{mcp,http,integration}` nodes + a registered provider MCP server | **the generic Connections broker (ADR 0024)** supplies the per-user/org credential; the assistant is just one consumer |
| The human as a board-owning principal (assign work + approvals) | **ADR 0025** (user/agent symmetry) | reuse — the assistant feeds the human's board on the same rails an agent uses |
| Prioritization tuning | **toggle variant bindings** + per-tenant config | no — reuse |
| Cost / always-on safety | **`runBudgetService`** autonomous-run ceilings | no — reuse |

---

## 6. Feature Evaluation Matrix (ADR 0001 / 0014)

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `src/features/assistant/` (service + `routes.ts` + `feature.ts` + `surface.ts`); appended to `BACKEND_FEATURES`/`FRONTEND_FEATURES`; no core route/nav edits; imports core (kb/crm/kanban/notifications) — core never imports it. |
| 2 | **Toggle + admin UI** | id `assistant`, default **OFF**, `bucketUnit:'tenant'` (workspace), category `Workspace`; variants = prioritization profiles with bindings; manageable in `FeatureTogglePanel`. |
| 3 | **`ctx.features.assistant`** | reads: `listProjects/getProject`, `listCommitments`, `listDecisions`, `getMeeting`, `listStakeholders`, `listPendingActions`. writes (gated, `role:action`): `upsertCommitment`, `logDecision`, `recordMeeting`, `enqueueAction`, `approveAction`. `sideEffects` map marks read vs write. |
| 4 | **Node pack** | `feature.assistant.nodes` is **thin — graph/logic only**: `extract-commitments`, `populate-board`, `build-prep-brief`, `compose-briefing`, `triage-inbox`, `cadence-scan`, `prioritize` (signed Ed25519+SRI). **All I/O reuses existing nodes** — `core.openwop.{mcp,http,integration}`, `core.hitl.approval-request`, `core.openwop.a2a.*`. No new I/O node is authored. |
| 5 | **AI-chat envelopes** | `assistant.ask` (query the graph), `assistant.approve`/`assistant.reject` (act on a `PendingAction`) → routed to the service. Schema-validated per the envelope acceptor. |
| 6 | **Agent pack** | `feature.assistant.agents` — `chief-of-staff` (orchestrator/roster persona), `extractor`, `drafter`. `toolAllowlist` = the assistant graph nodes + `ctx.features.kb` nodes + the **existing** `core.agents.tool-mcp` (Google MCP), `core.agents.tool-http` (Google OpenAPI), `core.agents.tool-workflow` (the loop-workflows), `core.openwop.integration.email-send`, `core.hitl.approval-request`. |
| 7 | **Public surface** | **None.** Entirely authenticated, principal-private. Not added to `PUBLIC_PATH_PREFIXES`. |
| 8 | **RBAC + isolation** | every mutating route gated (toggle + `workspace:write`); reads `workspace:read`; graph keyed by `tenantId` (IDOR-guarded); `PersonRef` into CRM re-checks org membership; **fail-closed**. Connector acts as the **acting userId**, never the workspace. |
| 9 | **Replay / fork** | prioritization profile stamped to `run.metadata.featureVariant` at creation, read verbatim on `:fork`; packs decoupled from toggle state; outbound effects are `role:action` (recorded, not re-sent on replay). |
| 10 | **Frontend** | `assistantClient.ts` + pages (Dashboard/brief, Approval queue, Memory-graph browser, Settings) + `routes.tsx` (`featureId:'assistant'`); nav under **Workspace** group; `ui/` cohesion + tokens (`/ux-review`). |

---

## 7. Approval boundaries & observability

- **Approval (decision 4):** the action layer **only drafts**; nothing reaches a
  provider until the principal approves. The hold reuses the **existing**
  autonomy/approval rails (ADR 0025 §4): a `core.hitl.approval-request` node and/or
  the heartbeat **`review`-mode pending-approval** queue, surfaced one-tap from the
  **Notifications** inbox/bell (ADR 0010) and shown in the "Waiting on me" lane of
  the human's board. `PendingAction` is just the typed draft the UI reads — **not a
  parallel approval system**. Autonomy expands later by mapping the prioritization
  buckets onto the agent autonomy levels (`auto`/`guided`/`review`) — a config
  change, not new code.

  > **Implementation pin (2026-06-11 — architect review).** The Phase-0 code
  > shipped `decidePendingAction()` marking state on the `PendingAction` row
  > directly, with no `PendingApproval` created — functionally a second approval
  > queue, which ADR 0025 §4 forbids ("no new approval store"). The activation
  > tranches close this: enqueueing a `PendingAction` **also** creates a
  > `host/approvalService.PendingApproval` (additive `actionId` back-ref) so the
  > approvals inbox, Notifications, and the "Waiting on me" lane are the single
  > loop. The **approval act** is `resolveApproval()` — whose pending→resolved
  > transition is an atomic compare-and-swap across instances (A7) — and the
  > **winning claim alone** dispatches the action workflow via the shared
  > `runStarter` (replay/fork/observability inherited), through the ADR 0024
  > Phase-D credential path under the provider's **write** scopes. The
  > `PendingAction` row remains the assistant's typed **domain record** (draft,
  > sources, diff, risk metadata); its `status` is a projection of the approval
  > act, never an independent decision surface.
- **Permissions:** an admin (ADR 0006) configures folders, schedules, mappings,
  and the prioritization profile; **send-authority is the principal's alone** and
  is never delegated to the workspace.
- **Observability (every scheduled run inspectable):** each loop run emits
  structured `createLogger` lines + an `appendAudit` entry
  (`action:'assistant.loop.<name>'`, payload = counts of changed/failed/surfaced/
  handled/deferred) + run events; `emitCost` attributes token spend; the daily
  brief is itself the human-readable digest of "what changed, what failed, what I
  surfaced vs handled." Consistent with the existing daemon logging pattern.

---

## 8. RFC gate — determination

**Host work — NO new RFC required.** Every surface is under
`/v1/host/sample/assistant/*` (non-normative) and the feature rides **already-
Accepted** RFCs: 0052 (scheduler), 0083 (trigger bridge), 0086 (roster/heartbeat),
0050 (auth), 0079 (credential provenance, via 0024), and the ADR 0014 surface
pattern. The multi-sub-agent perception/drafting orchestration stays **host-local**
(workflows compose existing node/agent packs + `ctx` surfaces; no new run/agent
orchestration **event** crosses the wire). Advertisement at `/.well-known/openwop`
stays under non-normative `hostExtensions.featureSurfaces`. **Tripwire to watch:**
if a future phase needs other hosts to honor an "agent surfaced X for approval"
**run event**, that becomes wire surface → a new RFC in `../openwop/RFCS/` (`/prd`)
before/with the work. Not needed for the phases above.

---

## 9. Boundaries audit (the orgs↔accessControl trap, avoided)

| Concept | **Single owner** | The assistant |
|---|---|---|
| People / contacts / companies | **`crm`** (`crmService`) | references via `PersonRef`; never stores a person |
| Tactical action items (board cards) | **`host.kanban`** | projects commitments onto cards via `ctx.kanban`; the `Commitment` (intent) and the card (tactical) are distinct, linked by `kanbanCardId` |
| Unstructured documents / embeddings | **`kb`** | ingests + queries; never embeds itself |
| Agent working/scratchpad memory | **`ctx.memory`** (existing) | reuses for the agent's scratchpad — **distinct** from the structured graph |
| Named-agent runner / roster | **`rosterService`** (RFC 0086) | the Chief-of-Staff **is** a roster member |
| Per-user Google credentials | **`connectors`** (ADR 0024) | consumes; never stores tokens |
| The **structured entity graph** | **`assistant` (this ADR)** | the one new owner |

Route check: `grep -rn "/v1/host/sample/assistant" backend/typescript/src` → no
prior registrant. The pre-existing `/v1/host/sample/memory` surface is **agent
scratchpad memory**, a different concept and a different namespace — **no
collision**, deliberately not reused as the graph's home.

---

## 10. Extensibility — building for the next integration, not just this one

The design is deliberately a set of **open seams**, so future problems are
*configuration*, not new subsystems:

1. **New external app (Salesforce, Jira, ServiceNow, …)** = drop a
   `ProviderManifest` (ADR 0024). The assistant's loops call it through the same
   `core.openwop.{mcp,http,integration}` nodes — **zero assistant code**.
2. **New perception source** = a new trigger (`core.openwop.mcp.subscribe-resource`,
   `core.trigger.{rss,mailhook,webhook,form}`, or a provider webhook on the RFC
   0083 bridge) feeding the same extraction loop. The memory graph doesn't care
   where a `SourceRef` came from.
3. **New surfaced artifact type** = a new `kind` on `Commitment`/`PendingAction`
   + a node; the prioritization layer and the board/approval rails are generic.
4. **New autonomy** = widen what the prioritization buckets map onto in the agent
   `autonomy` levels — a per-tenant config flip, replay-stamped.
5. **Any principal can be a chief-of-staff target** — because the human is a
   board-owning principal (ADR 0025), the assistant can serve a person, a team, or
   delegate to *another agent* via `core.openwop.a2a.*`. The orchestration graph
   extends to N agents + N humans without a new model.
6. **RAG stays the one `kb`** — every new document type flows through `kb` ingest,
   so semantic recall improves globally, not per-feature.
7. **Marketplace path (ADR 0022)** — provider manifests, agent packs, and the
   assistant's own node pack are all installable artifacts; new capability can ship
   as a signed pack without a redeploy.

The invariant: **the assistant owns only the memory graph + the loop logic.** Every
I/O, credential, board, schedule, approval, notification, and RAG concern is a
reused host seam — so the foundation hardens once and every future integration
inherits it.

## 11. Open questions & decisions (ranked by architectural impact)

1. **(Highest) Shared-workspace ingestion model.** Per-member tokens (ADR 0024)
   give each user their own Drive/Gmail; does an enterprise also want one
   **admin-connected** org corpus (domain-wide delegation)? This changes whether
   `Project.kbCollectionId` is per-user or shared. *Recommend:* per-user v1, defer
   org-corpus to ADR 0024 Phase C+.
2. **(High) Transcript source.** Which provider feeds Loop 4 — Google Meet
   recordings (Drive), or a third-party (Fireflies/Otter/Zoom)? Drive/Meet rides
   the connector we already build; a third party is a **new connector** (another
   ADR 0024-style subsystem). *Recommend:* Meet-via-Drive + manual upload for v1.
3. **(High) "Handle silently" floor.** Even pre-write, how much may the assistant
   mutate **internal** state (move cards, reprioritize, snooze) without surfacing?
   Defines the `handle` bucket's reach. *Recommend:* internal-only mutations are
   autonomous; anything leaving the host is always a `PendingAction`.
4. **(Medium) Commitment↔card lifecycle authority.** If the principal manually
   moves/edits a card the assistant created, does the next sync respect the manual
   edit (treat the card as principal-owned) or reconcile to source? *Recommend:*
   manual edits win; sync only flags drift.
   > **Resolved (2026-06-12) — implemented.** `projectCommitmentToBoard` is now
   > drift-aware (`assistant-loops.test.ts`): once a card exists it is
   > principal-owned and **never overwritten**. A re-projection compares the kept
   > card against its source — if they diverge (the human renamed/retimed the
   > card, or the source was re-extracted) it sets `Commitment.driftsFromSource`
   > and returns `status: 'drifted'`; an unchanged card returns `'reused'`. A card
   > the principal **deleted** is **not resurrected** (the pre-fix code recreated
   > it): the back-ref resolves to nothing → `status: 'dismissed'`, no
   > replacement. The Assistant page shows a `diverged` chip on a drifted
   > commitment.
5. **(Medium) Briefing channel.** Inbox-only, or also a messaging relay
   (Slack/Discord) and/or a scheduled email (needs write scope)? *Recommend:*
   inbox v1; relay opt-in.
6. **(Lower) Voice fidelity for drafting.** How is "the principal's voice"
   sourced — sent-mail corpus (needs Gmail read of Sent), a style sample, or a
   tuned prompt? *Recommend:* prompt + opt-in Sent-mail style sampling.

---

## 12. Activation tranches (2026-06-11 — gap-closure plan, architect-reviewed)

The 2026-06-11 gap analysis (`docs/executive-assistant-agentic-gap-analysis.md`)
rated the in-flight product **B-**: thesis strong, runtime maturity lagging —
the broker, graph, and approval queue exist but are not wired end to end. The
delivery plan below closes it; an architect review folded three corrections in
(single approval loop per ADR 0025 §4; `contentTrust` not a new trust enum;
`toolHooks` as the one policy-enforcement point). **No new RFC anywhere** — every
wire touchpoint rides Accepted RFCs (0046/0047/0051/0052/0064/0079/0081/0093).

| Tranche | Ships | ADR home | Gate / order rationale |
|---|---|---|---|
| **T1** | `resolveConnectionCredential()` consumed at node exec — landed as ADR 0024 §4 **Option C** (run-level `configurable.connections` opt-in, curated `apiHosts` eTLD+1 match, `connectionUse[]` stamp; this plan's per-node annotation superseded — see ADR 0024 Phase D correction) | ADR 0024 §4 / Option C | Unlocks all perception/action; first by dependency |
| **T2** | Calendar+Drive ingestion as RFC 0052 jobs; `contentHash` idempotency; `contentTrust:'untrusted'` stamped at ingest; per-tick volume cap; **commitments secondary index** (pulled forward); loop-status surface | this ADR (loops 1/6 read-path) | Needs T1 |
| **T3** | Morning/weekly briefing job → `compose-briefing`; briefing view with source citations + "why surfaced"; one batched briefing route (per-IP rate-limit discipline) | this ADR (loop 5 delivery) | Needs T2 data |
| **T4** | Action cards (kind/destination/draft/diff/risk/citations/reason; Approve/Reject/Edit); `PendingAction`→`PendingApproval` single-loop wiring (§7 pin); edit ⇒ re-pend; `appendAudit` per decision | this ADR + ADR 0025 Phase 3 | UX only — no execution yet |
| **T5** | Taint: `contentTrust` on `SourceRef`, `derivedFromUntrusted` on actions, prompts via existing `promptCompose`+`wrapForLLMPrompt`, heightened approval for tainted writes, hostile fixtures | **ADR 0027** | Must precede write autonomy |
| **T6** | Execute-on-approve: winning CAS claim dispatches via `runStarter` through T1 credentials under **write** scopes; per-kind gating via `toolHooks` `requiredScopes` | this ADR + ADR 0024 C | Gated on T1+T5 |
| **T7** | Admin governance: policy store **configures** `toolHooks` (provider allowlist, per-action-kind scopes, group access); audit = read view over `appendAudit` + `agent.toolCalled` + `connectionUse` (no new audit store); retention controls | **ADR 0028** | Needs T1 seam |
| **T8** | Evals (RFC 0081 scorecards: extraction/decisions/priority/draft-quality fixtures; approval/edit/citation metrics), "Assistant health" page; remaining secondary indexes + load tests | **ADR 0029** | Needs T2 loops to measure |

---

## Phase ledger

| Phase | Commit | Tests | Status |
|---|---|---|---|
| 0 Foundation — memory graph + `ctx.features.assistant` + REST + toggle | `d89505b` | `assistant-feature.test.ts` (7) | ✅ implemented |
| 2/3 Loops 2+3 — `feature.assistant.{nodes,agents}` + prioritization + idempotent board projection | `2c3be99` | `assistant-loops.test.ts` (6) | ✅ implemented (graph/logic + packs) |
| 5 Loop 5 + prioritization layer (scorer + profiles as variants) | `2c3be99` | `assistant-loops.test.ts` | ✅ implemented |
| FE Assistant page + approval queue | `1f78423` | `npm run build` gate | ✅ implemented |
| §12 T2 — loop activation layer: `ingest-commitments` node (idempotent, taint-stamped, capped), `assistant.loop.{calendar,drive}-ingest` workflow definitions (Phase-D `config.connection`), RFC 0052 enable/disable + status routes, commitment secondary indexes (ADR 0029 pull-forward), loop UI | — | `assistant-loops-activation.test.ts` (7) + FE build gate | ✅ implemented (live Google reads remain deploy-gated on OAuth config) |
| §12 T3 — briefing productized: `briefing.ts` single composer (citations + "why surfaced" + at-risk lane), `GET /assistant/briefing` batched route, `assistant.loop.morning-briefing` (notify→Notifications inbox), briefing card UI | — | `assistant-loops-activation.test.ts` (10) + FE build gate | ✅ implemented |
| §12 T4 — single approval loop + action cards: enqueue creates the `PendingApproval` (additive `actionId`/`kind` on the host queue), CAS-shared decision path for `/approvals` claim/reject AND the assistant routes, edit-re-pend, audit rows, card UI (risk/taint/diff/citations/reason) | — | `assistant-action-approval.test.ts` (5) + FE build gate | ✅ implemented |
| §12 T5 — taint gating (ADR 0027): `isAutoAllowEligible` single predicate, hostile-fixture suite (injection-bearing calendar/drive content stays data; `<UNTRUSTED>` wrap via the canonical guard; no path to `sent` without the human claim) | — | `assistant-taint.test.ts` (5) | ✅ implemented |
| §12 T6 — execute-on-approve: winning claim dispatches `assistant.action.<kind>` via `runStarter` AS the approving human (Phase-D credential, write scopes, fail-closed); `prepare-action-request` pure node; nudge = internal notification; terminal projection → `sent`/`failed` + `executionRunId` | — | `assistant-action-execution.test.ts` (6) | ✅ implemented (live sends remain deploy-gated on Google OAuth write re-consent) |
| §12 T7 — governance (ADR 0028): policy store configuring the connect/resolve/dispatch seams (provider allowlist, per-kind action policy), `storage.listAudit` + governance routes (shared superadmin gate), admin panel | — | `governance.test.ts` (4) + FE build gate | ✅ implemented |
| §12 T8 — evals + health + approvals index (ADR 0029): extraction precision/recall + priority-profile evals, health snapshot + admin card, approvals `(tenant,status)` index on the heartbeat hot path | — | `assistant-evals-health.test.ts` (4) + FE build gate | ✅ implemented |
| 1 Perception — Drive→`kb` sync | composes ADR 0024 + `core.openwop.mcp.subscribe-resource` | — | ⏳ deploy-gated (needs a registered Google MCP server + OAuth read scopes) |
| 4 Loop 4 — meeting lifecycle | composes Calendar (0024) + extractor | — | ⏳ deploy-gated |
| 6 Loop 6 — calendar intelligence | composes Calendar | — | ⏳ deploy-gated |
| 7 Loop 7 — comms triage/drafting (draft-only) | drafter agent + `enqueue-action` shipped; send path needs ADR 0024 C | partial | ⏳ deploy-gated (write scopes) |
| 8 Loop 8 — stakeholder cadence | `StakeholderProfile` + `upsertStakeholder` shipped; scheduled scan is a scheduler job | partial | ⏳ deploy-gated |

> **What "deploy-gated" means:** the orchestration *surface* every remaining loop
> composes — the memory graph, the node/agent packs, the prioritization layer, the
> Connections broker, and the user/agent board — is built and tested. Each remaining
> loop is then a **workflow definition** (a DAG of the shipped + existing core nodes)
> registered as a **scheduler job** (RFC 0052) plus a **registered Google MCP
> server** + OAuth read/write scopes (ADR 0024 Phases B/C). Those steps require live
> Google credentials + a deploy and cannot be exercised in the sandbox, so they are
> sequenced as the next deploy, not coded blind here.
