# ADR 0071 - Durable chat UI state and feedback

**Status:** implemented  
**Date:** 2026-06-18  
**PRD:** `docs/ai-chat-a-plus-prd.md`  
**Depends on / composes:** ADR 0043 (read state), ADR 0068 (review projection), ADR 0069 (artifact workbench), `frontend/react/src/chat/hooks/useChatSession.ts`, `frontend/react/src/chat/types.ts`, host-extension persistence.  
**Surface:** host-extension `/v1/host/openwop-app/ui-state/*` and `/v1/host/openwop-app/chat/messages/:messageId/feedback`.  
**RFC gate:** host work only. Feedback becomes protocol work only if OpenWOP standardizes feedback events.

## Why this exists

The PRD separates orchestration state, business state, and UI state. The app already moved conversation read markers into a dedicated store in ADR 0043, but several AI-chat details remain local or message-embedded: feedback, selected panels, compare mode, dismissed notices, expanded provenance, and raw interrupt resume history used for rendering.

Important user state should survive reload and device changes, while authoritative review and artifact decisions must not be hidden in frontend-local message blobs.

## Feature-refinement audit

| Concept | Existing owner | Decision |
|---|---|---|
| Conversation read markers | `conversationReadState.ts` | Keep; do not move high-cardinality read markers into generic UI state. |
| Review decision history | Interrupts, approvals, ADR 0068 | Keep authoritative; UI state may store view preferences only. |
| Artifact revision selection | ADR 0069 workbench | UI state may store selected revision/compare mode, not artifact content. |
| Chat transcript | ADR 0043 chat messages | Keep message content; compact duplicated raw resume payloads after review history is authoritative. |
| Message feedback | Local chat message field today | Move to a server-side feedback route. |

## Decision

Add a minimal per-user UI-state store for non-authoritative display preferences and a server-side feedback store for quality signals.

```ts
interface UiStateEntry {
  tenantId: string;
  subjectRef: string;
  resourceType: 'conversation' | 'review' | 'artifact' | 'message';
  resourceId: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

interface MessageFeedback {
  tenantId: string;
  conversationId: string;
  messageId: string;
  subjectRef: string;
  rating: 'up' | 'down' | 'neutral';
  reason?: string;
  createdAt: string;
  updatedAt: string;
}
```

The UI-state route stores only small, redacted values. It must not store resume payloads, artifact contents, credentials, hidden prompts, or provider traces.

## Route plan

```text
GET /v1/host/openwop-app/ui-state?resourceType=&resourceId=
PUT /v1/host/openwop-app/ui-state
DELETE /v1/host/openwop-app/ui-state/:resourceType/:resourceId/:key

POST /v1/host/openwop-app/chat/messages/:messageId/feedback
GET  /v1/host/openwop-app/chat/messages/:messageId/feedback
```

Feedback routes check conversation visibility and bind feedback to the current user subject. Admin analytics can aggregate later through a separate route with explicit authorization.

## Storage rules

- Key by `(tenantId, subjectRef, resourceType, resourceId, key)`.
- Bound value size and reject binary/large payloads.
- Redact with existing helpers before persistence.
- Keep read markers in `conversationReadState.ts`.
- Keep review decisions in source records.
- Keep artifact content in Documents/Media/run events.

## Phased plan

1. **UI-state service.** Add bounded host-extension store and routes.
2. **Feedback service.** Move message feedback to server-side storage.
3. **Frontend clients.** Add `uiStateClient` and feedback client; hydrate artifact workbench and review panel preferences.
4. **Compaction.** Stop indefinitely duplicating raw resume values into chat message state once ADR 0068 history is available.
5. **Metrics.** Expose aggregate feedback to authorized quality tooling.

## Acceptance criteria

- Loss of localStorage does not lose selected artifact revision, compare mode, expanded panels, dismissed notices, or message feedback.
- UI state is per-user and per-tenant.
- Feedback survives reload and is not stored only in `ChatMessage.feedback`.
- Review decisions and artifact content are not stored in UI state.
- Value-size, redaction, authorization, and no-existence-leak tests pass.

## Alternatives considered

- **Keep everything in localStorage.** Rejected because important cross-device chat state disappears and cannot inform quality metrics.
- **Store UI state on the source objects.** Rejected because per-user display preferences would create write contention and blur ownership.
- **Put feedback into the chat message record.** Rejected because feedback is user-specific and may have multiple reviewers per message.

## Open questions

- What retention period applies to feedback and UI-state entries?
- Should feedback allow free-text reasons in v1, or only structured reason codes?
- Which UI-state keys are allowed initially, and should the backend enforce an allowlist?

## Implementation record

Phases 1–3 + 5 landed; Phase 4 (raw-resume-payload compaction) is deferred.

| Phase | Change |
|---|---|
| 1 UI-state service | `host/uiStateStore.ts` — bounded `DurableCollection<UiStateEntry>` keyed `(tenantId, subjectRef, resourceType, resourceId, key)`. `routes/uiState.ts` (new `ROUTE_MODULE`): GET/PUT/DELETE. resourceType ALLOWLIST (fail-closed 400), 4 KB value cap, `sanitizeFreeTextDeep` redaction. |
| 2 Feedback service | `host/messageFeedbackStore.ts` — `DurableCollection<MessageFeedback>` keyed `(tenantId, conversationId, messageId, subjectRef)`; reason secret-scrubbed + bounded. Routes folded INTO `routes/chatSessions.ts` (POST/GET `/chat/messages/:messageId/feedback`) to reuse its `isVisibleTo`/existence guards. |
| 3 Frontend clients | `chat/state/uiStateClient.ts` + `chat/state/messageFeedbackClient.ts`; `useChatSession.setFeedback` now write-throughs to the server (optimistic local kept). |
| 5 Metrics | Aggregate-feedback read remains a deferred admin route; `listMessageFeedback` (all raters) is in place for it. |

**Corrections / decisions vs the plan:**
- *Boundary (the key finding):* an existing `src/client/feedbackClient.ts` is RFC 0056 **run annotations** (per-RUN, wire-native, capability-gated). ADR 0071 feedback is a **distinct** per-(user, message) chat signal (a conversation run holds many messages — not 1:1 with a run annotation; multiple users may rate one message). The new client is named `messageFeedbackClient` and does NOT shadow the RFC 0056 one. A future bridge per-turn-message → `run.annotated` is possible but out of scope.
- *Subject authority:* the `subjectRef` is ALWAYS derived from the session (`user:<userId>`), never accepted from the client — so a caller only ever reads/writes their OWN UI-state + feedback. That is the complete authz model.
- *Feedback visibility:* the POST/GET carry `conversationId`; the route checks the session EXISTS (the null-meta path reads as visible) AND `isVisibleTo` → 404 on either failure (no existence leak).
- *Keys (open question):* enforce the `resourceType` allowlist + bound key/value + redact; NO per-key allowlist in v1 (the keys are FE display prefs).
- *RFC gate:* none — host-ext only, no wire, no capability.

Deferred: Phase 4 raw-resume-payload compaction (a chat-message-state refactor that collides with a parallel session), an aggregate-feedback admin route, structured reason codes, and a retention policy.

Tests: `backend/test/ui-state-feedback.test.ts` (caller-scoped UI-state CRUD, second-user sees none, resourceType-allowlist 400, value-cap 400, feedback round-trip + per-user overwrite, non-visible-conversation 404, rating-vocabulary 400).

