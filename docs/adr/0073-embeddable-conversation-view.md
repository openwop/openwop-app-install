# ADR 0073 - Embeddable conversation view (one chat, reused everywhere)

**Status:** Accepted
**Date:** 2026-06-19
**Depends on / composes:** the chat surface (`frontend/react/src/chat/`), RFC 0005 conversation primitive, ADR 0058 (chat-drivability = agent + nodes), ADR 0072 (AI Workflow Author), ADR 0054 (`ProjectChatTab` deep-link precedent).
**Surface:** frontend only — a refactor of the chat surface into a reusable inner component + the chrome that wraps it. No wire change, no new RFC.

## Why this exists

The app has ONE capable AI chat (workflow-running, BYOK, persistence, conversations, agents, streaming, HITL interrupts). When a feature needs "talk to AI to do X," the temptation is to build a small bespoke panel — which is what the AI Workflow Author did (`AiAuthorPanel`), duplicating a slice of chat behavior. That fragments capabilities and drifts from the main chat. This ADR records the decision and the architecture to make the chat **reusable** so no feature ever forks it again. (Guardrail also recorded in `CLAUDE.md` and agent memory.)

## Decision

Split the chat into **chrome** + an embeddable **`ConversationView`**, both composing the same shared logic:

- **`ConversationView`** (new) — the slimmed conversation: message feed + composer + inline interrupt/A2UI cards + welcome/error states. **No left rail, no right panel, no header chrome.** This is the unit any surface embeds.
- **Chrome** — the conversations rail (tabbed left sidebar: Conversations / Workflow progress), the header (model pill / cost / toggles), the right progress panel, BYOK wizard. Belongs only to the full chat surface.
- **Shared logic** — `useChatSession` (turn dispatch, streaming, interrupts, persistence) + `useActiveAgents` (lineup + routing) already exist and are the single source of conversation behavior. A thin **`useConversationController(config, scope)`** wraps them + the `onUserSubmit`/mention glue, so both the full surface and the embed get identical behavior from one place. `ConversationView` is presentational over the controller.

**Composition:**
- **Full chat** (a tab in the left-sidebar nav, `/` → `ChatTab`): chrome + `<ConversationView>` driven by the controller. The chrome reads the same session from the controller (no second `useChatSession`).
- **Embedded chat** (e.g. the workflow builder): just `<ConversationView scopeAgentId=… config=…/>` — slimmed, no rails. Scoped to an agent programmatically (not via URL params).

### Workflow Builder application (consolidates ADR 0072's entry)

The bespoke `AiAuthorPanel` is **removed**. "Create with AI" in the builder embeds `ConversationView` scoped to the **Workflow Architect** agent (`feature.workflow-author.agents.workflow-architect`). The agent authors + persists via the existing node pack; the authored workflow lands on the canvas via the builder's **load-by-id** (a `GET /v1/workflows/<id>` fallback in `BuilderTab` — reusable for opening *any* registered workflow, not just AI-authored). The `draft` route + meta-workflow remain as a programmatic/eval API (not a second user entry).

## Phased plan (each phase independently verifiable; full chat must stay byte-behavior-identical)

1. **Extract** `useConversationController` + presentational `ConversationView` from `ChatSidebar`; refactor `ChatSidebar` to render `<ConversationView>` for its conversation column while keeping all chrome wired to the same controller. **Gate:** full FE build + the chat test suite green, full chat visually unchanged.
2. **Scope-by-agent (programmatic)** — `ConversationView`/controller accept a `scopeAgentId` that activates the agent without URL params (generalizes the `?agent=` deep-link in `ChatSidebar`).
3. **Builder embed** — slimmed `ConversationView` panel in the builder + `BuilderTab` load-by-id; "Create with AI" opens it scoped to the Workflow Architect; delete `AiAuthorPanel` + `workflowAuthorClient`.

## Risks / open questions

- **State sharing (the hard part):** the chrome (progress panel, header, rail) needs the live session that the controller owns. Resolve by lifting `useConversationController` to the point that renders both chrome and `ConversationView` (ChatSidebar today), passing the controller result to both — NOT a second `useChatSession`. Verify no double-subscription to the run SSE.
- **Test blast radius:** ChatSidebar is exercised by much of the 2000-test suite + the Playwright a11y/focus smoke. Phase 1 must be behavior-preserving; land it alone, green, before Phase 3.
- **BYOK in the embed:** the builder must supply a `config` (provider+model); when absent, the composer is disabled with the BYOK prompt (reuse the surface's gate), never a degraded mini-chat.

## Reusable seam — `EmbeddedChatPanel` (any feature, not just the builder)

The builder embed is **not** a one-off; it is the first consumer of a turnkey
"drop an AI chat into a feature surface" seam, so the `CLAUDE.md` "reuse, never
recreate" rule has a concrete drop-in. The layering (core → override):

- **`chat/EmbeddedConversation`** (core) — owns the ephemeral
  `useChatSession({persist:false})` + `useScopeToAgent(agentId)` + the slimmed
  `ConversationView`. Requires an already-valid `config: BYOKActiveConfig`
  (presentational-over-session; it has no notion of "no provider").
- **`chat/EmbeddedChatPanel`** (core) — the reusable wrapper any feature renders:
  the **BYOK-provisioning gate** + agent scoping + an empty-state slot. A feature
  supplies the *overrides* — `agentId` (required), `renderEmptyState?`,
  `onManageProvider?` (default: route to `/`), `byokFallback?` — and inherits the
  gate, scoping, and session from the core. **Chrome (heading/close/drawer) stays
  at the call site**; the panel renders gate-or-chat only.
- **A feature wrapper** (e.g. `builder/CreateWithAiPanel`) — owns only its chrome,
  picks its agent, and supplies its context-aware empty state
  (`builder/WorkflowAuthorWelcome`). It is a thin shell, not a chat.

**Import direction:** `chat/` already imports `builder/`, so a feature that
`chat/` does *not* import back may **static-import** `EmbeddedChatPanel`; the
**builder** is the exception and must **lazy-import** it (a static builder→chat
edge would cycle). The component's header documents this.

The generic BYOK-gate copy lives in the **chat** i18n namespace
(`embedNeedsProvider` / `embedManageProvider`) so every feature reuses it; only
feature-specific chrome copy stays in the feature's namespace.

> **Correction note (landed shape):** Phase 1's planned
> `useConversationController` was not extracted as a standalone hook — `ChatSidebar`
> and the embed each compose `useChatSession`/`useActiveAgents` directly (the embed
> via `EmbeddedConversation`), which proved sufficient without a shared controller
> wrapper. The single-source-of-conversation-behavior goal holds; the seam is the
> two components above, not a `useConversationController`.

## RFC verdict

Frontend refactor; **no new RFC**. No wire/capability change.
