# PRD: AI Chat A+ Human-in-the-Loop Workflow Orchestration

Status: Draft  
Owner: OpenWOP app maintainers  
Created: 2026-06-18  
Source analysis: `Designing AI Chat Interfaces for Human-in-the-Loop Workflow Orchestration.pdf` plus local implementation review  
Scope: `openwop-app` host application, not a normative OpenWOP protocol RFC unless explicitly called out below

## 1. Summary

The OpenWOP app AI chat already implements a strong foundation for human-in-the-loop workflow orchestration: run-backed chat turns, inline interrupt cards, A2UI surfaces, workflow progress panels, agent-event transparency, persistent conversation metadata, notifications, and a durable approval queue. The target of this PRD is to move the implementation from a strong B+/A- foundation to an A+ industry-leading experience by closing gaps in wire-native conversations, artifact lifecycle, unified review state, multi-reviewer approvals, enterprise auditability, and durable UI state.

This PRD deliberately composes existing OpenWOP primitives first: runs, events, interrupts, capabilities, artifact types, chat sessions, host-extension routes, and the `host.chat` surface. New wire protocol work is only recommended where the current host-extension surface would otherwise become a de facto protocol claim.

## 2. Background And Research Synthesis

The research document identifies a convergence across leading AI products:

- Chat alone is not sufficient. Mature systems combine chat with structured work surfaces: inline cards, side panels, artifact previews, editors, diff views, and approval views.
- Human approval is a runtime state, not just a UI button. The runtime must pause, serialize state, notify reviewers, accept typed decisions, and resume safely.
- Successful systems separate orchestration state, business state, and UI state.
- Agent-authored UI should be declarative and host-rendered, not arbitrary code execution.
- Enterprise-grade experiences expose provenance, tool traces, permissions context, audit logs, stale-decision handling, notifications, and recovery paths.
- Artifact-heavy workflows need a lifecycle: generate, preview, revise, compare, approve, publish or export.

The local OpenWOP app already matches several of these patterns:

- `frontend/react/src/chat/MessageFeed.tsx` renders inline interrupt cards, HITL decision artifacts, workflow completion cards, and artifact previews.
- `frontend/react/src/chat/workflowProgress/WorkflowProgressPanel.tsx` provides a companion progress surface.
- `frontend/react/src/chat/a2ui/A2uiSurfaceCard.tsx` renders declarative A2UI forms with fail-closed validation and confined actions.
- `backend/typescript/src/routes/interrupts.ts` implements interrupt resolution, token lifecycle checks, timeout handling, and conversation exchange routing.
- `backend/typescript/src/routes/chatSessions.ts` implements persistent conversation metadata, participants, read state, visibility gates, and group/project chat binding.
- `backend/typescript/src/host/approvalService.ts` implements a durable approval queue with CAS-style resolution.

The main remaining gap is that the app has not yet made all of those pieces a single durable review and artifact system.

## 3. Goals

1. Make the AI chat a wire-native, durable orchestration surface rather than a per-turn transcript wrapper.
2. Provide first-class artifact review: previews, revisions, diffs, provenance, approvals, publish/export, and rollback.
3. Unify in-flight interrupts and pre-execution approvals into one user-facing review model without conflating their underlying runtime semantics.
4. Support enterprise HITL patterns: multi-approver gates, stale-decision defense, notifications, audit trails, permissions context, and replay-safe recovery.
5. Expand A2UI into a safe, useful catalog for forms, decisions, artifacts, diffs, citations, and review matrices.
6. Preserve OpenWOP wire honesty: advertise only behavior that is fully implemented and conformance-covered.

## 4. Non-Goals

- Do not create a second chat runtime.
- Do not create a parallel approval system.
- Do not treat host-extension routes as normative OpenWOP wire unless an RFC is opened and accepted in `../openwop`.
- Do not allow agent-authored code, raw HTML, scripts, arbitrary network calls, or arbitrary host API calls from A2UI.
- Do not make the UI depend on localStorage as the source of truth for review decisions, artifact state, or approvals.
- Do not advertise optional capabilities until behavior is honored end to end.

## 5. Current Implementation Grade

Overall grade: B+ / 87.

| Category | Current Grade | Rationale |
| --- | --- | --- |
| Chat plus structured work surface | A- | Inline cards, progress panel, A2UI, and event inspector are strong. |
| OpenWOP runtime alignment | A- | Uses runs, interrupts, SSE, idempotency, capabilities, and event logs. |
| Conversation model | B | Conversation primitive exists, but frontend production path is still per-turn by default. |
| HITL approval UX | B+ | Good inline resume cards and durable approval queue; review model is split. |
| Artifact lifecycle | C+ | Preview modal exists, but no durable artifact/revision/diff/publish model in chat. |
| Enterprise governance and audit | B | Good authz and CAS foundations; needs unified audit/review records. |
| Production polish | B | Good recovery details; some important state is still local or best-effort write-through. |

## 6. Target Experience

### 6.1 User Narrative

A user asks the assistant to perform multi-step work. The chat opens or resumes a durable conversation. The assistant creates a run, streams progress, and renders compact inline cards for status and decisions. When an artifact is produced, the user sees a preview card and can open a side workbench with full preview, revision history, provenance, diffs, and actions. If the workflow requires human input, a review request appears inline, in the side panel, and in the user's review inbox. The user can approve, reject, request changes, edit-and-approve, escalate, defer, or ask for more information. Decisions are idempotent, audited, stale-safe, and recoverable after reloads.

### 6.2 Operator Narrative

An operator can inspect a run and answer:

- What did the agent do?
- Which tools were called?
- Which model/provider was used?
- Which artifact revision was approved?
- Who approved it, when, and under what permissions?
- What changed between revisions?
- Was any approval stale, timed out, overridden, or escalated?
- Which OpenWOP capabilities were used or required?

## 7. Product Requirements

### 7.1 Wire-Native Conversation Transport

Requirement:
The AI chat should use a long-lived OpenWOP conversation run by default, backed by `core.conversationGate`, while preserving the existing per-turn path as a fallback during rollout.

Current evidence:

- Frontend conversation transport is present but gated off by default in `frontend/react/src/chat/conversationTransport.ts`.
- Backend conversation exchange is implemented in `backend/typescript/src/host/conversationExchange.ts`.
- Discovery advertises `conversationPrimitive: true` in `backend/typescript/src/routes/discovery.ts`.

Acceptance criteria:

- [ ] `VITE_OPENWOP_CHAT_CONVERSATION` no longer needs to be manually enabled for normal production chat.
- [ ] BYOK-direct conversation exchange works for the same providers/models as per-turn chat.
- [ ] Conversation exchange supports streaming or equivalent progressive updates.
- [ ] Conversation event reconstruction pages or tails events instead of always polling from sequence 0.
- [ ] Reload restores the active conversation run and pending gate state.
- [ ] Closing a chat closes or archives the conversation run intentionally.
- [ ] Per-turn chat remains available behind a fallback flag for one release.
- [ ] Tests cover open, exchange, close, reload, stale run recovery, BYOK, managed provider, mock provider, and addressed-agent routing.

Technical requirements:

- Extend `backend/typescript/src/host/conversationExchange.ts` to dispatch through the same BYOK provider path used by `openwop-app.chat.turn`.
- Preserve `stripSecretsFromPersisted` and `sanitizeFreeText` for all persisted conversation events.
- Add idempotency keys to exchange operations so a retried exchange cannot duplicate user/agent turns.
- Keep `conversation.exchanged` events replay-safe and deterministic enough for reconstruction.
- Add route-level tests in `backend/typescript/test/*conversation*.test.ts`.
- Add frontend integration tests for `frontend/react/src/chat/conversationTransport.ts` and `useChatSession`.

Protocol stance:
No new RFC is required if the implementation only consumes the already advertised `conversationPrimitive` behavior. If additional event fields or endpoint contracts are needed, author an RFC in `../openwop/RFCS/`.

### 7.2 Durable Artifact And Revision Lifecycle

Requirement:
Workflow outputs surfaced in chat should become durable artifacts with revisions, previews, diffs, provenance, permissions, and lifecycle actions.

Current evidence:

- `frontend/react/src/chat/ArtifactPreviewModal.tsx` heuristically previews node outputs.
- `frontend/react/src/chat/MessageFeed.tsx` renders `WorkflowCompletionCard` and an artifact preview modal.
- `FEATURES.md` notes Documents and Templates exist, but typed `artifact.created` is deferred for some surfaces.

Acceptance criteria:

- [ ] Terminal workflow outputs can be promoted to durable `Artifact` records.
- [ ] Every artifact has at least `artifactId`, `artifactTypeId`, `ownerSubject`, `createdBy`, `createdAt`, `latestRevisionId`, and permissions context.
- [ ] Every revision has `revisionId`, `artifactId`, `parentRevisionId`, `contentRef` or `payload`, `summary`, `createdBy`, and `createdAt`.
- [ ] Chat completion cards link to the durable artifact, not only raw node output.
- [ ] The artifact workbench supports preview, raw JSON, revision history, and diff view.
- [ ] Approval requests bind to a specific artifact revision, not a mutable latest value.
- [ ] Publish/export actions operate only on an approved revision when policy requires it.
- [ ] Artifact records are tenant-scoped and subject-access gated.

Technical requirements:

- Reuse the existing artifact-type registry where possible: `backend/typescript/src/host/artifactTypes.ts`.
- Add a host-extension artifact store only if no existing Documents/Media surface can own the artifact.
- Prefer `ownerSubject` over soft org/project tags.
- Add backend routes under `/v1/host/openwop-app/artifacts/*` only for host-specific artifact management.
- Emit or project `artifact.created` and revision lifecycle events where the OpenWOP wire already supports them.
- Add UI workbench components under `frontend/react/src/chat/artifacts/` or a shared feature package if artifacts also appear outside chat.

Protocol stance:
If artifact lifecycle remains a host-extension projection over existing run outputs and accepted artifact-type concepts, no RFC is needed. If new normative run event fields, artifact event types, or artifact schema guarantees are required, author an OpenWOP RFC first.

### 7.3 Unified Review Request Model

Requirement:
Users should see one review model across in-flight interrupts and pre-execution approvals, while the backend preserves the correct distinction between runtime interrupts and pending approvals.

Current evidence:

- Runtime interrupts resolve through `backend/typescript/src/routes/interrupts.ts`.
- Pre-execution approvals live in `backend/typescript/src/host/approvalService.ts`.
- Chat stores resolved interrupt history as a render-time index in `frontend/react/src/chat/types.ts`.

Acceptance criteria:

- [ ] A unified review inbox lists pending runtime interrupts and pending host approvals.
- [ ] Each review item exposes a normalized shape: `reviewId`, `kind`, `source`, `status`, `runId`, `nodeId`, `approvalId`, `artifactId`, `revisionId`, `requestedBy`, `requestedAt`, `dueAt`, `actions`, `risk`, `provenanceRefs`.
- [ ] Actions available in the UI are derived from the authoritative backend record.
- [ ] Resolving a runtime interrupt still calls the interrupt API.
- [ ] Resolving a pre-execution approval still calls the approval queue API.
- [ ] Resolved review history is audit-grade and not only stored in local message state.
- [ ] Review cards render consistently in chat, side panel, notifications, and inbox.

Technical requirements:

- Add a backend projection route, for example `/v1/host/openwop-app/reviews`, that composes open interrupts and pending approvals.
- Do not move runtime interrupt ownership into `approvalService`.
- Add stable review IDs with prefixes such as `interrupt:<interruptId>` and `approval:<approvalId>`.
- Store reviewer decisions in the source-of-truth subsystem and project them into unified history.
- Add frontend review card components that accept the normalized review shape.

Protocol stance:
Host-extension projection requires no RFC. A standard OpenWOP review-list endpoint would require an RFC because it exposes cross-host API semantics.

### 7.4 Multi-Approver And Quorum Support

Requirement:
Support enterprise approval patterns: quorum, explicit approver lists, override roles, rejection policies, timeouts, and stale-decision handling.

Current evidence:

- Discovery intentionally does not claim quorum profile support in `backend/typescript/src/routes/discovery.ts`.
- `approvalService` supports single pending-to-resolved transitions with CAS.
- Interrupt token lifecycle and timeout handling exist in `routes/interrupts.ts`.

Acceptance criteria:

- [ ] Approval requests may specify approvers, groups, required count, rejection policy, override policy, and timeout.
- [ ] Each approver decision is recorded in an append-only decision ledger.
- [ ] The final gate resolves only when quorum/rejection/timeout policy is satisfied.
- [ ] Stale UI actions fail with an explicit already-resolved or stale-review response.
- [ ] The frontend disables or replaces cards after resolution.
- [ ] Notifications target only eligible approvers.
- [ ] Discovery advertises quorum only after route tests and conformance evidence exist.

Technical requirements:

- Extend interrupt approval data handling and/or `approvalService` with a decision ledger.
- Use CAS or transactional compare-and-swap for the final transition.
- Add route tests for simultaneous approvals, simultaneous reject/approve, timeout, override, non-approver denial, and stale click.
- Keep identity opaque and tenant-scoped.

Protocol stance:
If claiming `openwop-interrupt-quorum`, finish the behavior and update discovery. If the current OpenWOP spec does not fully cover the desired quorum fields, author/update an RFC in `../openwop`.

### 7.5 A2UI Catalog Expansion

Requirement:
Expand A2UI from basic fields/buttons into a practical review and artifact UI catalog while preserving the current fail-closed security model.

Current evidence:

- `A2uiSurfaceCard` validates a pinned catalog and confines actions to interrupt resume or conversation exchange.

Acceptance criteria:

- [ ] Catalog supports read-only sections for provenance, risk, citations, artifact previews, diffs, and approval matrices.
- [ ] Catalog supports input controls needed for review: text, textarea, select, checkbox, date/time, radio/segmented choice, and comment.
- [ ] Catalog supports action buttons with `resume` or `exchange` only.
- [ ] Unknown components, unknown catalog versions, malformed payloads, and unsafe payloads render fail-closed.
- [ ] Every catalog component has schema tests and render tests.
- [ ] A2UI surfaces can bind to review/artifact IDs without exposing secret or credential material.

Technical requirements:

- Extend `frontend/react/src/chat/a2ui/catalog.ts` and corresponding schema fixtures.
- Add fixtures for valid and invalid surfaces.
- Add Playwright or component tests for keyboard, screen reader labels, disabled states, and stale actions.
- Keep action payloads explicit and schema-validated.

Protocol stance:
A2UI core behavior appears to be accepted and implemented locally. New catalog components may be host-local unless they need cross-host wire guarantees.

### 7.6 Durable UI State And Feedback

Requirement:
Important UI state must be durable, per-user, and separate from business/review state.

Current evidence:

- `useChatSession` persists messages through localStorage and backend write-through.
- `ChatMessage.feedback` is local signal-only.
- `InterruptHistoryEntry` stores raw resume values in chat message state as a render-time index.

Acceptance criteria:

- [ ] Feedback persists server-side and can be included in agent quality metrics.
- [ ] Per-user UI state persists for selected artifact revision, compare mode, expanded panels, read markers, and dismissed notices.
- [ ] Raw resume payloads are not indefinitely duplicated into chat message blobs.
- [ ] UI state is scoped by tenant, conversation, user, and resource.
- [ ] Loss of localStorage does not lose review history, artifact selection, or feedback.

Technical requirements:

- Add a small UI-state host-extension store keyed by `(tenantId, subjectRef, resourceType, resourceId, key)`.
- Migrate feedback from `ChatMessage.feedback` to a backend route.
- Compact persisted chat message state after review history is stored authoritatively.
- Keep high-cardinality read markers in their existing separate store pattern.

Protocol stance:
Host-extension only. No OpenWOP RFC needed unless feedback becomes a normative event.

### 7.7 Transparency, Audit, And Provenance

Requirement:
Every significant orchestration and review action must be explainable and auditable.

Acceptance criteria:

- [ ] Review cards show who/what requested the decision, the target artifact/revision, risk, permissions context, and provenance.
- [ ] Artifact workbench shows source run, node, tool calls, model/provider, citations, and relevant confidence/verifier events.
- [ ] Audit entries are append-only for review requested, decision recorded, revision created, revision approved, publish/export, timeout, override, and stale-decision rejection.
- [ ] User-facing views avoid leaking credentials, hidden prompts, or cross-tenant data.
- [ ] Admin/debug views clearly distinguish redacted from unavailable data.

Technical requirements:

- Project existing run events into artifact/review provenance views.
- Add audit events in the existing observability namespace rather than inventing ad hoc logs.
- Reuse `stripSecretsFromPersisted` and existing redaction helpers.
- Add tests for no credential leakage in review/artifact payloads.

## 8. Technical Architecture

### 8.1 Durable Objects

Target durable object model:

| Object | Owner | Purpose |
| --- | --- | --- |
| Conversation | Existing chat session/meta store | Durable chat container, participants, read state. |
| Run | OpenWOP runtime | Orchestration execution and event log. |
| Interrupt | OpenWOP runtime | In-flight pause/resume gate. |
| ReviewRequest | New host projection | Unified view over interrupts and pending approvals. |
| PendingApproval | Existing `approvalService` | Pre-execution proposal gate. |
| Artifact | New or composed host store | Durable produced work item. |
| Revision | New or composed host store | Immutable artifact version. |
| ProvenanceRef | Projection over events | Links artifact/review to run, node, tool, citation, source. |
| AuditEntry | Existing observability/audit path | Compliance trail. |
| UiState | New host-extension store | Per-user non-authoritative display state. |

### 8.2 State Ownership Rules

- Run status and replay history belong to the OpenWOP runtime.
- In-flight resume state belongs to interrupts.
- Pre-run proposal state belongs to `approvalService`.
- Artifact content and revision history belong to the artifact/document owner.
- Chat transcript belongs to the conversation store.
- UI expansion/selection state belongs to per-user UI state.
- No object should be owned by both frontend localStorage and backend storage.

### 8.3 Route Plan

Candidate host-extension routes:

```text
GET  /v1/host/openwop-app/reviews
GET  /v1/host/openwop-app/reviews/:reviewId
POST /v1/host/openwop-app/reviews/:reviewId/actions/:action

GET  /v1/host/openwop-app/artifacts
POST /v1/host/openwop-app/artifacts
GET  /v1/host/openwop-app/artifacts/:artifactId
GET  /v1/host/openwop-app/artifacts/:artifactId/revisions
POST /v1/host/openwop-app/artifacts/:artifactId/revisions
GET  /v1/host/openwop-app/artifacts/:artifactId/revisions/:revisionId
GET  /v1/host/openwop-app/artifacts/:artifactId/diff?from=&to=

GET  /v1/host/openwop-app/ui-state
PUT  /v1/host/openwop-app/ui-state

POST /v1/host/openwop-app/chat/messages/:messageId/feedback
```

These are host-extension routes. Do not document them as OpenWOP v1 protocol endpoints unless an RFC graduates them.

### 8.4 Frontend Component Plan

Candidate components:

```text
frontend/react/src/chat/reviews/ReviewCard.tsx
frontend/react/src/chat/reviews/ReviewInboxPanel.tsx
frontend/react/src/chat/reviews/reviewClient.ts
frontend/react/src/chat/artifacts/ArtifactWorkbench.tsx
frontend/react/src/chat/artifacts/ArtifactPreview.tsx
frontend/react/src/chat/artifacts/ArtifactDiffView.tsx
frontend/react/src/chat/artifacts/RevisionTimeline.tsx
frontend/react/src/chat/artifacts/ProvenancePanel.tsx
frontend/react/src/chat/state/uiStateClient.ts
```

Reuse existing UI primitives: `Modal`, `Notice`, `StatusBadge`, `DataTable`, `IconButton`, and shared icon components.

## 9. Phased Plan

### Phase 1: Conversation Cutover Readiness

Deliverables:

- BYOK support in conversation exchange.
- Idempotent exchange.
- Event tailing/pagination for conversation reconstruction.
- Frontend flag default changed in staging, then production.
- Regression suite for per-turn fallback.

Exit criteria:

- Conversation transport passes parity tests with per-turn chat.
- No known credential leakage in event payloads.
- Manual QA validates managed, BYOK, mock, reload, close, and addressed-agent turns.

### Phase 2: Unified Reviews MVP

Deliverables:

- `/reviews` projection endpoint.
- Review card component consuming normalized review shape.
- Inbox integration for interrupts plus existing pending approvals.
- Stale-decision and already-resolved UI handling.

Exit criteria:

- A user can resolve an in-flight interrupt or pre-exec approval from the same review surface.
- Backend tests prove authorization, no existence leak, and idempotent resolution.

### Phase 3: Durable Artifacts And Revisions

Deliverables:

- Artifact/revision data model.
- Promotion from workflow output to artifact revision.
- Artifact workbench with preview and revision history.
- Review requests pinned to revision IDs.

Exit criteria:

- Approval of an artifact is approval of an immutable revision.
- Artifact workbench survives reload and can be opened from chat history.

### Phase 4: Diffs, Publish, Export, And Provenance

Deliverables:

- Diff service for text/JSON/markdown artifacts.
- Publish/export lifecycle actions.
- Provenance panel linked to run events, citations, model/provider, and tool calls.
- Audit events for lifecycle transitions.

Exit criteria:

- A reviewer can compare two revisions and approve/request changes from the same surface.
- Published/exported output records the exact revision.

### Phase 5: Multi-Approver Enterprise Controls

Deliverables:

- Approval decision ledger.
- Quorum and rejection policies.
- Override and timeout handling.
- Targeted notifications.
- Discovery update only if profile is fully honored.

Exit criteria:

- Concurrent claims produce exactly one final policy outcome.
- Quorum profile is advertised only after tests and conformance evidence pass.

### Phase 6: A2UI Catalog Expansion And UI State Persistence

Deliverables:

- Expanded A2UI catalog for review/artifact components.
- Server-side UI state.
- Server-side feedback.
- Compaction of raw resume payload duplication from chat messages.

Exit criteria:

- Loss of localStorage does not lose important review/artifact/UI state.
- A2UI remains fail-closed under malformed/unknown/unsafe payloads.

## 10. Acceptance Criteria Summary

The AI chat reaches A+ when all of the following are true:

- [ ] Production chat defaults to wire-native conversation runs.
- [ ] BYOK, managed, and mock providers work in conversation exchange.
- [ ] Inline cards, side panel, inbox, and notifications all consume one review projection.
- [ ] Artifacts and revisions are durable, permissioned, previewable, diffable, and approvable.
- [ ] Review decisions are idempotent, stale-safe, audited, and recoverable after reload.
- [ ] Multi-approver policies are implemented and honestly advertised.
- [ ] A2UI supports real review/artifact use cases without code execution.
- [ ] Feedback and UI state persist server-side.
- [ ] No credential, prompt, hidden reviewer, or cross-tenant data leaks through chat cards, artifacts, reviews, events, or debug surfaces.
- [ ] Frontend build, backend tests, and relevant route/component/e2e tests pass.
- [ ] Discovery claims match behavior.
- [ ] Any protocol-surface change has an accepted RFC in `../openwop`.

## 11. Test Plan

Backend:

- Conversation open/exchange/close with managed, BYOK, and mock providers.
- Conversation exchange idempotency and retry behavior.
- Interrupt resolution authorization, timeout, stale token, cancelled run, already-resolved.
- Review projection authorization and no-existence-leak behavior.
- Approval CAS under concurrent approve/reject.
- Artifact/revision create/read/diff/publish authorization and tenant isolation.
- Secret redaction in persisted events and review/artifact payloads.

Frontend:

- Chat reload restores conversation, pending review cards, and artifact workbench links.
- A2UI render invariants for known, unknown, malformed, and version-mismatched surfaces.
- Review cards disable or replace stale actions after resolution.
- Artifact preview, diff, revision timeline, and provenance panel keyboard/a11y tests.
- Server-side feedback round-trip.

End-to-end:

- User asks for work, workflow creates draft artifact, reviewer requests changes, agent creates revision, reviewer approves, artifact publishes.
- Multi-user reviewer sees only eligible review requests.
- Removed project member cannot read project chat or artifact.
- Browser reload during a suspended run resurfaces the review card.

Verification gates:

```bash
( cd backend/typescript && npm test )
( cd frontend/react && npm run build )
```

Use the canonical frontend build, not bare Vite, because the build includes token and CSS integrity checks.

## 12. Risks And Mitigations

| Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- |
| Conversation cutover regresses streaming UX | High | Medium | Keep per-turn fallback for one release; add parity tests. |
| Artifact model duplicates Documents feature | High | Medium | Reuse Documents/Media/ArtifactType ownership where possible; architect review before implementation. |
| Unified review projection hides important semantic differences | Medium | Medium | Keep source-specific action handlers; projection is view-only normalization. |
| Quorum implementation creates authority bugs | High | Medium | Finish identity model and route-level authz tests before advertising profile. |
| A2UI catalog expansion weakens security | High | Low | Closed schema, pinned catalog version, fail-closed renderer, no arbitrary actions. |
| Persisting UI state stores sensitive resume payloads | Medium | Medium | Store minimal canonical state; redact/compact raw payloads. |
| Host-extension routes become accidental protocol | Medium | Medium | Mark host-extension clearly; open RFC for cross-host semantics. |

## 13. Open Questions

1. Should durable artifacts compose the existing Documents feature for markdown/business documents, or should chat artifacts be a thinner projection over run outputs?
2. What is the minimum useful diff set for v1: text, markdown, JSON, or typed artifact-specific diffs?
3. Should review requests be addressable from notifications by `reviewId`, or should notifications continue to link to source-specific routes?
4. What is the retention policy for resolved review decisions and artifact revisions?
5. Which approval policies are needed first: quorum, override, timeout, required roles, or delegated approvers?
6. Should conversation-native chat become default before or after artifact/review MVP?
7. Which A2UI components should be standardized upstream versus kept host-local?

## 14. Dependencies

- Existing OpenWOP run, event, interrupt, and capability behavior.
- Existing chat session/conversation metadata routes.
- Existing approval queue.
- Existing artifact type registry and/or Documents feature.
- Existing notification infrastructure.
- Accepted A2UI behavior and local renderer.
- Provider dispatch parity for managed and BYOK chat.

## 15. Protocol And RFC Decision Matrix

| Change | Host Work Only | Needs OpenWOP RFC |
| --- | --- | --- |
| Default frontend to existing `conversationPrimitive` | Yes | No |
| BYOK parity in conversation exchange | Yes | No |
| Host `/reviews` projection route | Yes | No |
| Standard cross-host review-list endpoint | No | Yes |
| Durable host artifact workbench | Yes | No |
| New normative artifact event fields | No | Yes |
| A2UI host-local catalog components | Yes | Maybe |
| Standardized A2UI review/diff components | No | Yes |
| Claiming quorum interrupt profile | Yes, if already spec-covered | RFC if spec gaps remain |

## 16. References

- Research source: `Designing AI Chat Interfaces for Human-in-the-Loop Workflow Orchestration.pdf`
- `docs/adr/0043-persistent-conversations.md`
- `docs/adr/0051-a2ui-agent-authored-chat-surfaces.md`
- `docs/adr/0053-documents-and-templates.md`
- `docs/adr/0054-collaborative-project.md`
- `docs/adr/0055-host-artifact-type-registry.md`
- `docs/adr/0067-ai-chat-conversation-run-default.md`
- `docs/adr/0068-unified-review-projection.md`
- `docs/adr/0069-chat-artifact-workbench.md`
- `docs/adr/0070-quorum-review-policies.md`
- `docs/adr/0071-chat-ui-state-and-feedback.md`
- `frontend/react/src/chat/MessageFeed.tsx`
- `frontend/react/src/chat/a2ui/A2uiSurfaceCard.tsx`
- `frontend/react/src/chat/conversationTransport.ts`
- `frontend/react/src/chat/hooks/useChatSession.ts`
- `backend/typescript/src/host/conversationExchange.ts`
- `backend/typescript/src/routes/chatSessions.ts`
- `backend/typescript/src/routes/interrupts.ts`
- `backend/typescript/src/host/approvalService.ts`
- `backend/typescript/src/routes/discovery.ts`
