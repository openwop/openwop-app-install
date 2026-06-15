# Executive Assistant / Chief-of-Staff Agentic Gap Analysis

**Date:** 2026-06-11  
**Scope:** OpenWOP app in-flight Executive Assistant / Chief-of-Staff feature, ADR 0023, ADR 0024, `feature.assistant.*` packs, backend assistant graph, Connections broker, and the current Assistant frontend.

## Executive Summary

The in-flight OpenWOP Executive Assistant is directionally strong. It is not framed as a chatbot; it is framed as a chief-of-staff agent with a structured memory graph, proactive scheduled loops, connected enterprise data, draft-only actions, and approval gating. That is broadly aligned with the leading agentic pattern emerging in the industry: an agentic work operating layer that combines persistent work memory, enterprise connectors, policy-scoped action, human review, and observable execution.

The current gap is not the architecture thesis. The thesis is good. The gap is product and runtime maturity: the graph exists, the connection broker exists, and the approval queue exists, but the actual connector injection, live proactive loops, source-grounded briefings, indirect prompt-injection controls, admin policies, and eval/observability loop are still immature or not wired end to end.

**Overall rating: B-**

- Architecture/concept: **A-**
- Current implementation: **C+**
- Path to competitive parity: **B**

## Industry Direction

Leading products in this space are converging around a few patterns:

1. **Agentic work graph, not isolated chat.** The assistant maintains durable context about people, projects, commitments, meetings, decisions, and work state.
2. **Connected enterprise memory.** Email, calendar, meetings, documents, chat, tickets, CRM, and work-management systems become the perception layer.
3. **Scoped delegated action.** Agents can draft, route, update, schedule, and eventually execute, but sensitive actions are constrained by policy and often require review.
4. **Human-in-the-loop by default for risky writes.** Approvals are no longer a generic yes/no; they include action cards, diffs, provenance, policy reason, and source citations.
5. **Admin-governed connectors.** Enterprise products expose provider allowlists, group controls, data-retention controls, connector logs, and write-scope policy.
6. **Observability and evals.** Production agents need metrics for extraction quality, stale tasks, false positives, approval rate, autonomy level, latency, budget, and connector failures.
7. **Defense against connected-data attacks.** Email, docs, transcripts, calendar descriptions, and Slack messages are untrusted instruction surfaces. Mature systems separate instructions from data, taint tool outputs, and constrain sensitive actions.

Representative industry signals:

- OpenAI Apps / Connectors emphasize connectors, action controls, admin management, approval UX, and logs: <https://developers.openai.com/apps-sdk/>
- OpenAI Agents platform emphasizes tools, handoffs, guardrails, tracing, and evals: <https://platform.openai.com/docs/guides/agents>
- Microsoft Copilot Studio frames agents as composed from knowledge, tools, triggers, topics, flows, and human review: <https://learn.microsoft.com/en-us/microsoft-copilot-studio/>
- Google Workspace Gemini is pushing integrated help across Gmail, Drive, Docs, Calendar, and Meet with enterprise controls: <https://workspace.google.com/solutions/ai/>
- Asana Dash is positioned as an AI chief of staff over work-management context, meetings, Slack, email, and other apps: <https://asana.com/product/ai>

## Current OpenWOP Solution

The in-flight implementation has three important layers.

### 1. Executive Assistant Memory Graph

ADR 0023 defines the assistant as a named chief-of-staff agent with a structured graph of:

- Projects
- Commitments
- Decisions
- Meetings
- Stakeholders
- Pending actions

The backend implementation in `backend/typescript/src/features/assistant/assistantService.ts` follows that model. The graph is tenant-scoped, idempotent for key extraction paths, and layered over existing owners rather than creating parallel systems. People are represented as `PersonRef`s, unstructured knowledge points back to `kb`, and commitments can project to Kanban cards.

### 2. Connections Credential Broker

ADR 0024 defines a generic Connections broker for Google, Slack, ServiceNow, Zoom, and future providers. The implementation in `backend/typescript/src/features/connections/connectionsService.ts` separates non-secret metadata from BYOK-enveloped secret material, models user/org/workspace scope, and includes a resolver that chooses the most specific credential.

This is architecturally strong because it avoids a Google-only subsystem and composes with existing OpenWOP MCP/HTTP/integration nodes.

### 3. Assistant Frontend Surface

`frontend/react/src/features/assistant/AssistantPage.tsx` currently exposes:

- Pending actions awaiting approval
- Open commitments
- A clear notice that outbound actions are draft-only until approved

This is a good safety posture, but still a thin user experience relative to the chief-of-staff ambition.

## Ratings

| Dimension | Rating | Assessment |
|---|---:|---|
| Strategic fit with agentic-work trend | A- | The thesis is very strong: durable context, proactive loops, connected sources, and approvals. It matches the direction of Asana, Microsoft, OpenAI, and Google. |
| Architecture boundaries | A- | The assistant owns the graph only; I/O stays in core node packs; credentials are owned by Connections; RAG stays in `kb`. This is the right shape. |
| Memory/work graph | B+ | The graph covers the right objects and includes source refs, idempotency, and tenant guards. Missing richer graph queries, source UI, conflict resolution, and lifecycle analytics. |
| Connections/integrations | B- | The generic broker is promising and better than provider-specific sprawl. But `resolveConnectionCredential()` is not yet consumed by node execution, MCP, HTTP, or assistant loops. |
| Proactive loops/autonomy | C | ADR 0023 has the right eight-loop design, but the runtime product is still mostly graph + pack + page. The loops need to actually run against connected sources. |
| Human approval/action safety | B | Draft-only is the correct early posture. Gap: approval only marks state; it does not yet execute, show diffs, enforce risk tiers, or bind action parameters to policy. |
| Security against connected-data attacks | C+ | Credential handling is thoughtful. But connected-data agents need explicit indirect prompt-injection defense, tainting, source trust, and sensitive-write constraints. |
| Governance/admin controls | B- | Feature toggles, tenant scoping, BYOK, RBAC, and provenance shape are good. Missing admin-grade connector/action policy UI and audit surface. |
| UX/product depth | C | The Assistant page is useful but thin: tables for commitments and approvals. A chief-of-staff experience needs briefings, explanations, source citations, cadence settings, and triage. |
| Observability/evals | D+ | OpenWOP run events help, but there is no assistant-specific eval harness or operating dashboard for quality, safety, latency, cost, and action outcomes. |
| Scale/performance | C | DurableCollection scans are acceptable in-memory tier, but not sufficient for large inbox/calendar/document workloads. |
| Commercial readiness | C+ | The architecture is credible; the demo needs live connected loops and polished chief-of-staff surfaces to feel market-comparable. |

## Gap Analysis

### Gap 1: Connector Injection Is Not Wired End to End

**Rating: C**

The Connections broker exists, but the resolver is not yet called from production node execution paths. Without this, the assistant cannot actually read Gmail, Calendar, Drive, Slack, or other apps through the broker.

**Impact:** The product claims “connected chief of staff,” but the current runtime is closer to a prepared substrate.

**Best-practice target:** Every MCP/HTTP/integration node that needs a provider credential should resolve through Connections using the acting principal, inject secrets host-side, stamp provenance, and fail closed when scopes are missing.

**Recommended next steps:**

- Wire `resolveConnectionCredential()` into the core HTTP/OpenAPI credential path.
- Wire MCP provider auth references through the same resolver.
- Stamp `run.metadata.connectionUse[]` for every credential use.
- Add tests for user, org, workspace, denied org use, expired token, and missing connection.

### Gap 2: Proactive Loops Are Designed But Not Productized

**Rating: C**

ADR 0023 describes eight loops: Drive ingestion, commitment extraction, Kanban population, meeting lifecycle, briefings, calendar intelligence, communications triage, and stakeholder cadence. The code has the graph and node/agent packs, but the actual always-on value is not yet visible.

**Impact:** Users will not perceive this as a chief of staff until it proactively reads, summarizes, extracts, and routes work.

**Best-practice target:** Start with three high-value loops that run reliably:

- Daily/morning briefing from calendar, commitments, and open approvals.
- Commitment extraction from connected documents/email/meeting notes.
- Approval-gated drafting for email/nudges/reschedules.

**Recommended next steps:**

- Ship a scheduler-backed morning briefing loop.
- Ship one connected ingestion path, preferably Calendar + Drive or Gmail + Drive.
- Add replay/idempotency tests around repeated ingestion and loop reruns.
- Surface loop status and last run outcome in the Assistant UI.

### Gap 3: Approval UX Is Too Thin For Sensitive Actions

**Rating: C+**

The current UI has Approve and Reject buttons for pending actions. That is a necessary start, but not enough for enterprise-grade agent action.

**Impact:** Users cannot confidently approve emails, invites, nudges, or reschedules without knowing the source, risk level, affected recipients, changed fields, and why the assistant recommends the action.

**Best-practice target:** Approval cards should include:

- Action kind and destination
- Source citations
- Draft preview
- Recipient/attendee diff
- Risk tier
- Required scopes
- Why this action is recommended
- “Approve once,” “Reject,” “Edit,” and eventually “Always allow under policy”

**Recommended next steps:**

- Replace approval table rows with structured action cards.
- Store and render `sourceRefs`, `riskLevel`, `requiredScopes`, and `reason`.
- Require explicit re-approval after edits or changed recipients.
- Add audit entries for every approval/rejection.

### Gap 4: Indirect Prompt-Injection Defenses Are Missing

**Rating: C**

The assistant is intended to read email, docs, transcripts, calendar descriptions, and chat. Those are untrusted content surfaces. Credential storage is not enough; the agent also needs instruction/data separation.

**Impact:** A malicious email or document could instruct the assistant to disclose private data, create misleading summaries, draft harmful messages, or manipulate calendar/work state.

**Best-practice target:** Connected content must be treated as data, not authority. Tool outputs should be tainted, and tainted content should not be allowed to directly authorize sensitive actions.

**Recommended next steps:**

- Add source trust metadata to `SourceRef`.
- Track whether an action was derived from untrusted external content.
- Require heightened approval for tainted write actions.
- Add prompt templates that explicitly separate principal instructions, system policy, and retrieved content.
- Add tests with hostile email/doc fixtures.

### Gap 5: Governance Needs Admin-Grade Policy

**Rating: B-**

The current solution has feature toggles, RBAC, tenant isolation, and scoped credentials. That is a solid base. Enterprise best practice now expects more granular admin policy.

**Impact:** Without admin policy, rollout is hard in organizations that need connector restrictions, auditability, and data handling controls.

**Best-practice target:** Admins should control which connectors exist, which groups can use them, which write actions are allowed, which scopes are allowed, and what logs are retained.

**Recommended next steps:**

- Add provider allowlist and group-based connector access.
- Add per-action policy: email draft, email send, calendar invite, calendar reschedule, Slack post, external webhook.
- Add write-scope consent separation in the UI.
- Add connector use audit log.
- Add retention controls for assistant memory and source-derived data.

### Gap 6: Source-Grounded Briefings Are Not Yet First-Class

**Rating: C+**

The graph can store source references, but the visible product does not yet make source grounding a first-class experience.

**Impact:** A chief-of-staff assistant must earn trust by showing where claims came from and why something is important.

**Best-practice target:** Briefings and commitments should cite source documents, emails, calendar events, meeting notes, and prior decisions.

**Recommended next steps:**

- Add source citation rendering to commitments and pending actions.
- Add “why this is surfaced” explanations.
- Add project/meeting briefing views.
- Link graph entities back to `kb` documents and connected provider records.

### Gap 7: Observability And Evals Are Underdeveloped

**Rating: D+**

OpenWOP has run events, but the assistant needs product-specific quality and safety metrics.

**Impact:** Without evals, it will be difficult to safely increase autonomy or know whether the assistant is useful.

**Best-practice target:** Treat the assistant as a production agent with evals and telemetry for quality, safety, cost, latency, and outcomes.

**Recommended next steps:**

- Add eval fixtures for commitment extraction, meeting decisions, priority scoring, and draft quality.
- Track false positives, missed commitments, approval rate, edit rate, stale items, and source citation coverage.
- Add operational metrics for connector failures, token refresh failures, loop latency, and budget use.
- Add a small “Assistant health” admin/debug page.

### Gap 8: Scale Model Is Still Sample-Grade

**Rating: C**

The service uses `DurableCollection.list()` scans for many list and lookup paths. That matches an in-memory tier but will struggle with real email/calendar/document volumes.

**Impact:** A connected executive assistant can generate high-cardinality data quickly.

**Best-practice target:** Index by tenant, provider, source, status, owner, due date, and project. Avoid cross-tenant collection scans in hot paths.

**Recommended next steps:**

- Add deterministic indexes for common assistant queries.
- Index connections by `(tenantId, provider, userId/orgId/workspace)`.
- Index commitments by status, owner, due date, project, and source hash.
- Add load tests around ingestion and morning briefing.

## Competitive Comparison

| Capability | Emerging best practice | OpenWOP status | Grade |
|---|---|---|---:|
| Work graph | Durable graph of commitments, projects, meetings, people, decisions | Present and well-modeled | B+ |
| Enterprise connectors | Admin-governed connectors with scoped credentials and provenance | Broker present, injection not wired | B- |
| Proactive assistant loops | Scheduled and event-triggered perception/action loops | Designed, mostly deploy-gated | C |
| Meeting follow-up | Extract decisions/actions from transcripts and calendar context | Designed, not visibly productized | C |
| Daily/weekly briefings | Source-grounded, personalized, actionable briefings | Designed, not yet first-class UI | C+ |
| Email/calendar drafting | Drafts with approval, citations, recipient diffs, risk tiers | Draft queue exists; UX thin | C+ |
| Human-in-loop controls | Policy-aware action cards and review workflows | Basic approve/reject | C+ |
| Admin governance | Provider allowlists, action policies, audit logs, data controls | Partial foundation | B- |
| Prompt-injection defense | Tainting, source trust, data/instruction separation | Not explicit | C |
| Evals/observability | Agent quality, safety, cost, latency, outcome metrics | Minimal assistant-specific evals | D+ |

## Recommended Delivery Order

1. **Wire Connections into core I/O.** This unlocks the whole product. Without it, the assistant is not truly connected.
2. **Ship one real perception loop.** Prefer Calendar + Drive or Gmail + Drive, with idempotent graph writes and source citations.
3. **Ship morning briefing.** This is the fastest way to make the product feel like a chief of staff.
4. **Upgrade approvals.** Replace table-only approval with source-grounded action cards and risk metadata.
5. **Add safety gates for connected content.** Instruction/data separation and tainting should land before write autonomy expands.
6. **Add assistant evals.** Measure extraction quality, missed commitments, approval/edit rates, and citation coverage.
7. **Add admin policy controls.** Provider allowlists, action policies, group scopes, and audit logs.
8. **Scale storage and query paths.** Move hot-path scans to indexed lookups before large connected-data ingestion.

## Final Assessment

The OpenWOP design is unusually well aligned with where the industry is heading. The strongest idea is that the assistant is a chief-of-staff agent operating over the same rails as other agents: identity, work graph, schedules, tools, approvals, and observable runs. That is the right long-term architecture.

The weak spot is that the compelling behavior is still mostly latent. To move from **B- architecture preview** to **A- product direction**, the next tranche should focus less on expanding the model and more on closing the loop: real connected data in, source-grounded commitments and briefings out, approval-gated actions, and admin-visible safety controls.

