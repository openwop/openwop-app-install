# ADR 0124 — In-chat model/provider switch + capability-aware selector

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): the capability read endpoint. `GET /v1/host/openwop-app/chat/model-capabilities` projects `probeProviderCapabilities` (RFC 0031) per configured provider (anthropic/openai/google/minimax) — static introspection, no tenant state, so the composer can badge/disable a model by capability. **Phase 2a (client) implemented** (2026-06-24): `fetchModelCapabilities()` + `ProviderCapabilities` in `chatSessionsClient.ts` — reads the Phase-1 `/chat/model-capabilities` endpoint (degrades to [] on error). **Phase 3 (per-exchange switch, backend) implemented** (2026-06-24): the conversation resolve payload accepts an optional `model`/`provider` per-exchange override (host-internal, mirroring the `webSearch` override — not a wire-shape change); `dispatchReply` applies it via the pure `applyExchangeOverride` at HIGHEST precedence (override > route stamp > run inputs; partial override keeps the other field). So the in-chat selector can switch the model for a single turn. **Phase 2b (FE plumbing) implemented** (2026-06-24): `conversationClient.exchange` + `conversationTransport.sendConversationTurn` now thread an optional per-exchange `model`/`provider` into the resolve payload (additive, mirroring the `webSearch` override), so a chosen model reaches the Phase-3 backend override. The composer selector COMPONENT (a capability-aware dropdown reading `fetchModelCapabilities`, wired to send) + a11y (Phase 2c/4) pending. **Date:** 2026-06-23
**Toggle:** none — *core-chat architecture* (see Scope note); no feature-package, no node/agent pack, no `ctx.<feature>` surface.
**Surface:** frontend chat composer/header + the existing chat conversation run (`run.inputs.provider`/`model`). No new wire contract; no new route.
**Depends on / composes:** ADR 0067 (AI chat = the RFC 0005 conversation run; `provider`/`model`/`credentialRef` already carried in `run.inputs`), BYOK provider abstraction (`providers/dispatch.ts`, `providers/managedProvider.ts`), the model-capability layer (`host/modelCapabilityProbe.ts`, `executor/modelCapabilityGate.ts`, `host/modelCapabilityGateConfig.ts` — RFC 0031), ADR 0102 (chat-history projection), ADR 0073 (`ConversationView` — the composer surface), ADR 0006 (RBAC).
**RFC verdict:** **host-extension — NO new RFC.** Provider/model selection already rides `run.inputs` on the existing non-normative chat conversation run; the capability set the selector reads is the **already-Accepted RFC 0031** model-capability declaration (`probeProviderCapabilities`). Switching the value in the composer is a pure FE/host change — nothing new on the wire. (RFC 0067's gate stands: any *new* event field, endpoint contract, or capability *claim* would need an RFC — this ships none.)

> **Scope note.** This is a *core-chat architecture* ADR (the ADR 0102 shape), not a feature-package (ADR 0001). Chat lives in core (`frontend/react/src/chat/`, `routes/chatSessions.ts`, `host/conversation*`), so there is **no toggle, no node/agent pack, and no `ctx.<feature>` surface** — those evaluation-matrix rows are **N/A**. The live concerns are correctness (the chosen model is what dispatches), replay safety (the model is stamped on the run), capability honesty (gate vision/audio/PDF/tools), and a11y.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 (model selection) + §11 (gap ranking — B15, MEDIUM). Competitor implementations: LibreChat `useAvailableModels` + Model Specs (per-conversation model switch); LobeHub `ModelSwitchPanel/`; Open WebUI `ModelSelector/` (capability badges). Today OpenWOP selects provider+model **upfront** at BYOK config (`useChatSession.ts:677` `openConversationSession({ provider: config.provider, model: config.model, … })`) with **no in-chat switch** — to change model the user reconfigures BYOK.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a model registry + a selector + a per-message model override." Provider dispatch, the BYOK config, and the capability set already exist; the only true gap is a composer-level affordance to change the run's `provider`/`model`. Re-implementing any owned piece is the `no-parallel-architecture` violation.

| Concern | Existing owner (file:line) | How the switch reuses it |
|---|---|---|
| The active provider/model | ADR 0067 — carried in `run.inputs` (`host/conversationExchange.ts:141-144` reads `inputs.provider`/`inputs.model`); set at open (`useChatSession.ts:677`) | The switch **updates the active `config.{provider,model}`** used on the *next* `openConversationSession`/exchange. No new home for "current model." |
| Provider dispatch | `providers/dispatch.ts` (`dispatchChat`) + `providers/managedProvider.ts` (`dispatchManagedChat`) | Unchanged — the chosen provider/model flow through the same dispatch path. No new dispatcher. |
| BYOK credential resolution | ADR 0067 BYOK-direct (`resolveSecret({tenantId})` → `dispatchChat`; `conversationExchange.ts:164`) | Switching provider re-resolves that provider's credential; an unconfigured provider fails closed (`credential_unavailable`, 422 — already the behavior). No new credential store. |
| Which providers/models are available | The BYOK config + the host capability advertisement (`capabilities.aiProviders.supported[]`) | The selector lists **configured** providers (BYOK) + the host's managed default; it does not invent models the host can't dispatch. |
| Model capabilities (vision/audio/PDF/tools) | RFC 0031 — `host/modelCapabilityProbe.ts:63` `probeProviderCapabilities(provider)` + `:73` `aggregateAdvertisedCapabilities`; `executor/modelCapabilityGate.ts:67` `evaluateModelCapabilityGate` | The **capability-aware** selector reads `probeProviderCapabilities` to badge/disable a model that lacks a needed modality (e.g. a pending image attachment needs `vision`). No new capability source. |
| The composer surface | ADR 0073 `ConversationView` / `ChatInput.tsx` / `ChatHeader.tsx` | The selector lives in the composer/header — one shared surface, inherited by the full chat AND every embed. No second composer. |
| RBAC | ADR 0067 — exchange authorized against the visible conversation + backing run | A model switch is just a new run input on the same authorized conversation; no new authz surface. |

**Net new (small):** a capability-aware model selector component in the composer/header (`ChatInput.tsx`/`ChatHeader.tsx`), reading the configured providers + `probeProviderCapabilities`, that updates the active `config.{provider,model}` for the next turn — and a host endpoint that returns the **advertised capability set per configured provider/model** (a thin read over `modelCapabilityProbe`) so the FE badges correctly.

---

## Decision

Add a **capability-aware model/provider selector** to the chat composer that switches the **active model for the next turn** by updating `config.{provider,model}` (the values ADR 0067 already carries in `run.inputs`). The selector lists only providers the host can actually dispatch (configured BYOK + the managed default), and **badges/disables models by capability** (vision/audio/PDF/tools) read from the RFC 0031 capability layer, so a user can't pick a text-only model for a turn that carries an image. The chosen model is **stamped on the run** (already true — see Replay) so replay/fork reproduce it.

### How the switch works (next-turn, not retroactive)

ADR 0067's conversation run carries `provider`/`model`/`credentialRef` in `run.inputs` (read at `conversationExchange.ts:141-144`). The chat opens one long-lived conversation run per session. So a mid-conversation model switch is a **next-turn** semantic:

- Changing the selector updates the FE active `config`. The **next** exchange/open uses it.
- Because the conversation is **one** suspended run (ADR 0067 §3), switching model mid-thread means either (a) the run's `inputs.model` is updated for subsequent exchanges (host-ext write on the conversation run inputs), or (b) a new conversation run is opened for the new model and linked as the continuation. **Decision: (a)** — a single conversation run whose `model` input is updated per exchange, so the thread stays one replay-safe run; the *event* records which model produced each turn (the existing `conversation.exchanged` already carries the producing model in its turn meta, surfaced by `MessageBubble.tsx:239` `{message.meta.provider}/{message.meta.model}`). This keeps "one conversation = one run" (ADR 0067) intact. **`/architect` should confirm the per-exchange `inputs.model` update is replay-coherent** (the gate run replays each exchange with the model that produced it, not a single terminal model).

### Capability-aware selection (vision/audio/PDF/tools)

The selector is **capability-honest**: it reads the host's advertised capability set per provider (`probeProviderCapabilities(provider)`, `modelCapabilityProbe.ts:63`) and, when the pending composer state requires a modality (an attached image → `vision`; an attached PDF → the PDF/document capability; an audio attachment → `audio`; a tool-bearing agent → `tools`), it **badges** capable models and **disables** incapable ones with an explanatory tooltip. This mirrors the existing **`evaluateModelCapabilityGate`** (`modelCapabilityGate.ts:67`) which already routes a payload to substitute/insufficient when a model lacks a capability — the selector surfaces that gate *before* the user sends, rather than failing at dispatch. No new capability taxonomy — the same RFC 0031 set.

### Data model — no new entity

No new persisted entity. The selection is the **active `config`** (already FE state) reflected into the conversation run's `inputs.model`/`inputs.provider` per exchange. Per-turn provenance is already recorded on each `conversation.exchanged` turn's meta (rendered at `MessageBubble.tsx:239`). The only host addition is a **read endpoint** projecting the advertised capability set per configured provider/model for the selector to badge against (a thin wrapper over `modelCapabilityProbe`, no new state).

### RBAC & isolation (fail-closed)

A model switch is a new run input on an **already-authorized** conversation (ADR 0067 — exchange authorized against the visible conversation + backing run; participant-scoped per ADR 0043/0102). No new authz surface. **Credential fail-closed:** switching to a provider with no configured BYOK key (and no managed fallback) fails closed with the existing `credential_unavailable` (422, `conversationExchange.ts:164-178`) — the selector should pre-disable such providers, but the dispatch-time guard is the backstop. The capability list is per-tenant-configured providers only — no leak of providers the tenant hasn't configured.

### Replay / fork safety

- **The chosen model is already part of the run inputs** (ADR 0067 — `run.inputs.provider`/`model`, read at `conversationExchange.ts:141-144`). **Confirmed: it is stamped on the run**, so replay/fork reproduce the exact dispatch. This ADR changes *when/how* the value is set (in-composer, per next turn), not *whether* it's on the run.
- Replay reads each exchange's producing model **verbatim** from the run events; it does not re-pick a model. A `:fork` carries the run inputs forward unchanged.
- **No new run-stamp is introduced.** The per-exchange `inputs.model` update writes to an existing input field on an existing run — not a new wire field (that would be an RFC trigger, per RFC 0067's gate).

---

## Evaluation matrix

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package architecture | **N/A** — core-chat; extends `chat/` composer + a thin capability-read host route, no `features/<x>` package. |
| 2 | Toggle / admin UI / `bucketUnit` | **N/A** — core chat, always-on. |
| 3 | Workflow node pack | **N/A** — no node pack; reuses the existing chat conversation run + provider dispatch. |
| 4 | Agent pack / persona | **N/A** — model selection is the user's, orthogonal to the agent persona. |
| 5 | AI-chat envelope / `ctx.<feature>` | **N/A** — no new envelope; `provider`/`model` already in `run.inputs`. |
| 6 | RBAC | **Yes** — switch rides the already-authorized conversation/run; credential + capability fail-closed; per-tenant providers only. |
| 7 | Replay / fork | **Yes (confirmed)** — model already stamped in `run.inputs`; replay reads each exchange's producing model verbatim; no new run-stamp. |
| 8 | RFC gate | **host-ext, NO new RFC** — selection rides existing `run.inputs`; capability set is already-Accepted RFC 0031; no new wire field. |
| 9 | a11y | **Yes** — selector is a labeled combobox/menu (keyboard-navigable, `aria-activedescendant`); disabled-by-capability options carry an explanatory `aria-disabled` + reason; capability badges have text labels, never icon/color-alone. |
| 10 | Tests | Selector lists only configured providers; incapable model disabled when an image/PDF/tool turn is pending; switch updates next-exchange `inputs.model`; per-turn provenance rendered; switch to unconfigured provider fails closed (422). |

---

## Phased plan

1. **Capability read endpoint (backend).** A thin `GET …/chat/model-capabilities` projecting `probeProviderCapabilities(provider)` per configured provider/model (no new state; reads `modelCapabilityProbe`). Route test.
2. **Composer model selector (frontend).** A capability-aware selector in `ChatInput.tsx`/`ChatHeader.tsx` (within `ConversationView`, so the embed inherits it) listing configured providers + managed default, badging/disabling by capability against the pending composer state; updating the active `config.{provider,model}`. Reuses the BYOK gate for unconfigured providers.
3. **Per-exchange model input + provenance.** Update the conversation run's `inputs.model`/`inputs.provider` on the next exchange (decision (a)); confirm each `conversation.exchanged` turn meta records its producing model (already surfaced at `MessageBubble.tsx:239`); `/architect` replay-coherence review.
4. **Tests + a11y.** Capability gating, fail-closed credential, replay reads producing model verbatim, keyboard/AT for the selector.

## Alternatives weighed

1. **A per-message model override stored separately.** Rejected — the producing model is already on each turn's event/meta; a parallel override store would shadow it (`no-parallel-architecture`) and risk drift from the run.
2. **Open a new conversation run per model switch (decision (b)).** Rejected as the default — it fragments "one conversation = one run" (ADR 0067) and complicates the linear transcript/replay. (a) keeps one run whose per-exchange model input is recorded on each event.
3. **A free-text model field (type any model id).** Rejected — it lets a user pick a model the host can't dispatch (fails at runtime) and bypasses capability honesty. The selector lists only dispatchable, capability-badged models.
4. **A new run-event field for "active model" on the wire.** Rejected — RFC 0067's gate: a new normative field needs an RFC. The model already rides `run.inputs`; no wire change needed.

## Open questions

1. **OQ-1 — Per-exchange vs per-session model.** (a) update `inputs.model` per exchange (chosen) vs (b) lock the model per conversation. Chosen (a) for flexibility; `/architect` confirms replay coherence.
2. **OQ-2 — Managed-default capability honesty.** When the host runs a managed provider (ADR 0110 headless default), the selector must badge the managed model's capabilities from the same probe — confirm `probeProviderCapabilities` covers the managed provider id.
3. **OQ-3 — Mid-stream switch.** Disallow switching while a turn is streaming (the active exchange already dispatched); the selector disables during `isSending`.
4. **OQ-4 — Capability mismatch UX.** When a needed modality has *no* configured capable model, surface a clear empty/disabled state (reuse the BYOK gate copy pattern) rather than a silent failure.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** Provider/model selection already rides `run.inputs` on the existing non-normative chat conversation run (ADR 0067); the capability set the selector reads is the **already-Accepted RFC 0031** model-capability declaration. Moving the selection into the composer + the capability read endpoint are pure FE/host changes under `/v1/host/openwop-app/*` — no new event field, endpoint contract, or capability *claim* on the wire. A new RFC is warranted only if a normative cross-host "active model" run-event field is later required (RFC 0067's standing gate) — this ships none.

> **Phase 2c (selector component + composer wiring) implemented** (2026-06-24): the `model-capabilities` route now also returns the selectable models per provider (from the providers catalog); `ModelSwitcher` (a labeled, keyboard-reachable dropdown over `fetchModelCapabilities`) renders in the `ChatHeader` controls via a slot prop and threads the choice through the EXISTING composer — `ChatSidebar` state → `useChatSession.send`'s `SendOptions.model/provider` → `sendConversationTurn` → the Phase-3 backend override. Extends the ONE chat (no fork). Degrades to the run default when no models are advertised. /architect GO (the SendOptions seam = the webSearch precedent), /code-review + /ux-review clean. The per-exchange model provenance badge + a11y polish (Phase 4) pending.

> **Phase 2d (model provenance) — wire RFC filed** (2026-06-24): per-turn model attribution touches the normative `conversation-turn` wire (`/architect` NO-GO on host-only work), so the wire change was authored as **openwop RFC 0109 — conversation-turn model provenance (`agent.model`)** (Draft, openwop/openwop PR #766) via the five-architect `/prd` pass: an OPTIONAL, additive `{provider, model}` on the agent turn (non-secret only; verbatim on :fork; capability-gated). The host stamp (read the resolved provider/model in conversation-exchange `makeTurn` → `agent.model`) is the follow-on host work, gated on RFC 0109 reaching **Accepted** — it MUST NOT ship as a host-only wire claim before then (the `OPENWOP_REQUIRE_BEHAVIOR` honesty rule).

> **Phase 2d (model provenance host stamp) implemented** (2026-06-24):** with **openwop RFC 0109 now `Accepted`** (merged openwop/openwop#766 — `agent.model` on `conversation-turn.schema.json` + the `conversationTurnModelProvenance` capability + a server-free conformance scenario; promoted Draft→Accepted via the documented bootstrap single-maintainer comment-window waiver, the RFC 0101 precedent), the host stamp is now an HONEST wire claim. `conversationExchange` stamps `agent.model: {provider, model}` on the answering agent's turn via `resolveModelProvenance(run, override)` — resolved the SAME way `dispatchReply` resolves the dispatch target (run inputs → stamped `modelRoute` read verbatim on :fork → per-exchange override), so provenance matches what dispatched. NON-SECRET (identifiers only; stripSecretsFromPersisted-safe — provider/model aren't secrets); `undefined` (no stamp) when unresolved. Discovery advertises `conversationTurnModelProvenance: { supported: true }`. /architect (the prior NO-GO on host-only work is now resolved — the wire RFC is Accepted, so this is honest host work); /code-review clean (0 banned; agent.model carries provider+model only). 4 provenance unit tests (inputs / route precedence / override highest / undefined-when-unresolved) + conversation-exchange + multi-party regression (12/12). **ADR 0124 is now COMPLETE.**
