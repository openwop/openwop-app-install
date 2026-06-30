# ADR 0151 — AI conversation auto-titling (LLM-generated session names)

**Status:** implemented — 2026-06-27 (all 4 phases). Phase→artifact: **P1** package+toggle+data-model — `src/features/chat-autotitle/{feature,titleGenerator,binding}.ts`, `chat-autotitle` toggle (ON, `user`), `ChatSessionRecord.titleSource` + sqlite mig 32 / postgres mig 29; **P2** first-exchange binding — `maybeAutotitleOnFirstExchange` fired from `conversationExchange.finishExchange` (gated on `titleSource==='default'`, fail-closed, TOCTOU re-check); **P3** `conversation.titled` event + FE `titledFromEvent` consumed in `useChatSession`; **P4** admin (toggle auto-surfaces in `FeatureTogglePanel`) + i18n (title is in the conversation's language ⇒ no new app keys; manual-rename PATCH stamps `titleSource='user'`). Tests: `chat-autotitle-sanitize` (6) + `chat-autotitle-binding` (7) + FE `titledFromEvent` (2); storage-parity 60 + chat-session routes 28 green; backend tsc + FE build gate clean. `/architect` (pre-phase seam audit, with one call-site correction: bind at the first exchange, not close), `/code-review`, `/ux-review` clean.

**Correction note (impl):** §Phase 2 cites mirroring `maybeExtractMemoryOnClose`, which fires at conversation **close**. The title must fire on the **first exchange**, so the binding is called from inside `finishExchange` (after both turns are durable), not from the close path — the *pattern* (fire-and-forget + fail-closed + idempotent-once) is reused, the *call site* differs. Idempotency keys on `titleSource==='default'` (not a turn count), which also structurally fixes the multi-tab `messages.length===0` regression §13 describes.
**Toggle:** new feature-package `chat-autotitle` · default **ON** (product decision 2026-06-27 — auto-naming is expected default behavior; per-user opt-out via the toggle, `bucketUnit: user`). The substring placeholder remains the fallback when OFF or on any failure.
**Surface:** host-extension only — a first-exchange LLM side-effect that writes the existing chat-session **title** and emits a non-normative `conversation.titled` event on the run SSE. **No new wire** (see RFC verdict).
**Composes:** the chat-session title store + route (`routes/chatSessions.ts` `PATCH /v1/host/openwop-app/chat/sessions/:id`), the managed/BYOK chat dispatch (`dispatchManagedChat` + the BYOK adapter), the conversation primitive's exchange hook (`conversationExchange.ts`), and the ADR 0120 / ADR 0130 first-exchange side-effect pattern.
**Source plan:** the in-conversation deep-dive (2026-06-27) on LLM topic-aware session naming, researched against LibreChat (`titleConvo`/`titleTiming: immediate`/`titleMethod`/`titlePrompt`), ChatGPT, and the Vercel AI SDK.

---

## Why this exists

A chat's sidebar/tab name should reflect its **topic**, derived by a model — "Refactor the auth middleware," not the literal first 60 characters of the opening message. Today the app derives the title client-side as `firstUserMessage.slice(0, 60)` (`frontend/react/src/chat/hooks/useChatSession.ts:690`, and the `@mention` path `:1360`). That is the degenerate form of auto-titling: same trigger point, a `substring` instead of an LLM. It's also currently **regressing** (reported "no longer auto-naming") because it hinges on a fragile `s.messages.length === 0` guard that the ADR 0140 multi-tab/backend-keyed session flow can defeat.

This ADR replaces the substring with a **cheap, parallel, in-language LLM title call** — the `immediate`-mode behavior every serious chat product (ChatGPT, LibreChat) converged on — adapted to OpenWOP's replay rules and this app's free-tier (MiniMax) reality. It also incidentally fixes the regression by sourcing the title from the model on the first exchange rather than the FE guard.

---

## Boundaries & pre-existing-surface audit (Step 3)

| Check | Finding | Verdict |
|---|---|---|
| **Title store/route owner** | The chat-session **title** already exists and is owned by `routes/chatSessions.ts` — `POST …/chat/sessions { title? }` (`:5`), `PATCH …/chat/sessions/:id { title }` (`:7`), backed by `chat_sessions` (`:16`). | **Compose it.** Auto-titling WRITES through the existing `PATCH` (or its service). Do NOT create a second title concept. |
| **Existing auto-naming** | FE substring at `useChatSession.ts:690` + `:1360`. | Auto-titling is an **upgrade** of an existing behavior, not a new concept. Keep the substring as the **0 ms placeholder**; the LLM result overwrites it. |
| **LLM-post-process-of-a-conversation precedent** | ADR 0120 `memory-auto-extract` — a toggle-gated package whose `maybeExtractMemoryOnClose(run, turns)` (`conversationExchange.ts:65`) fires a fire-and-forget, fail-closed LLM op over the transcript without blocking the exchange. | **Reuse the pattern verbatim**, fired at the *first* exchange instead of *close*. |
| **First-exchange one-time side-effect precedent** | ADR 0130 model-router lazy stamp (`conversationExchange.ts:~80`) — "on the first exchange where no route is stamped, … persist … written ONCE." | Auto-titling is the same shape: a one-time first-exchange write. |
| **Dispatch** | Managed free tier → `dispatchManagedChat` (MiniMax, provider-hidden, per-tenant daily token cap); BYOK → the policy adapter. | **Reuse**; do not add a provider path. |
| **Route-prefix collision** | `grep -rn "chat/sessions"` → only `routes/chatSessions.ts`. No `autotitle`/`gen_title` route exists. | No collision. |
| **Capability advertisement** | `/.well-known/openwop` — nothing to add (host-extension side-effect). | No advertisement change (honesty preserved). |

**Single owners (compose, don't fork):** title → `chatSessions`; transcript/turns → the conversation primitive; LLM dispatch → the managed/BYOK seam; toggle resolution → the feature-toggle system.

---

## Decision

Ship a minimal feature-package **`src/features/chat-autotitle/`** that, **on the first exchange of a conversation whose title is still the default placeholder and whose owning user has the `chat-autotitle` toggle enabled**, fires a **fire-and-forget, fail-closed** cheap-model title call (the LibreChat `immediate` + `completion` pattern), writes the result to the chat-session title, and emits a `conversation.titled` host event the FE consumes to update the rail/tab live.

### Data model
- **No new entity.** The title is the existing `chat_sessions.title` (ADR 0043/0102). Add an internal marker so we title **once** and never clobber a manual rename — `chat_sessions.titleSource: 'default' | 'auto' | 'user'` (additive; default `'default'`; `PATCH` rename sets `'user'`; the auto pass sets `'auto'` and only runs when `titleSource === 'default'`).
- **Non-replay:** the title is a host-extension display label on the session store, **not** a run-event and **not** `run.metadata` — so the title LLM call (a non-deterministic side-effect) stays entirely outside replay/`:fork`, exactly like memory-extract.

### The title call (researched defaults)
- **Method `completion`** (plain text out, host trims whitespace/quotes), **not** structured/function-calling — the free MiniMax tier's tool-calling is unreliable (see the code-exec saga, ADR 0146), and a title never needs a schema.
- **Prompt** (adapted from LibreChat's default, localized): *"Detect the conversation's language and return a concise title in that language — 5 words or fewer, no punctuation or quotation marks, no preamble."* + a flattened `User: {first user msg}\nAI: {first reply}` transcript (≤ ~1 KB).
- **Model:** the cheapest fast model on the active credential — managed MiniMax for the free tier, or the user's BYOK model; `temperature 0`, `max_tokens ~16`. Counts against the ADR 0106 per-tenant managed daily token cap (≈ ≤ 30 output tokens/chat).
- **Trigger (DECISION — open to revision, OQ-3):** fire on the **first exchange**, in **parallel** with the agent reply, using the **first user message** as context (LibreChat `immediate`). Title lands in ~1–2 s. (Feeding the first *reply* too improves topic accuracy on terse openers but costs one reply's latency — see OQ-3.)

---

## Phased plan

| Phase | Deliverable | Gate |
|---|---|---|
| **1 — package + toggle** | `src/features/chat-autotitle/{feature.ts,titleGenerator.ts,binding.ts}`; toggle `chat-autotitle` (OFF, `user`); append to `BACKEND_FEATURES`. `titleGenerator` runs the completion-method dispatch + trim. | toggle resolves server-authoritatively; honest-off when no credential. |
| **2 — first-exchange binding** | `maybeAutotitleOnFirstExchange(run, turns)` called from `conversationExchange.ts` (mirroring `maybeExtractMemoryOnClose`): fail-closed on toggle/owner, gated on `titleSource === 'default'`, fire-and-forget (never blocks the turn), writes the title via the chatSessions service, sets `titleSource='auto'`. | never blocks/throws into the exchange; idempotent (runs once). |
| **3 — `conversation.titled` event + FE** | Emit a non-normative `conversation.titled` host event on the run SSE; FE consumes it in `useChatSession`/the rail/tab to replace the placeholder live. Keep `slice(0,60)` as the instant placeholder; this also repairs the `messages.length===0` regression. | rail/tab updates within ~2 s; no flicker; manual rename wins. |
| **4 — admin + i18n** | `FeatureTogglePanel` entry; the prompt + any UI strings localized (en/pt-BR/es/fr) — the title is generated *in the conversation's language*, so no app-string leakage. | i18n parity gate green. |

### Core-app extension surface
- **`ctx.<feature>` workflow surface:** **none** — auto-titling is an internal display side-effect, not a workflow capability. (Stated explicitly per the matrix.)
- **Node pack:** **none.**
- **AI-chat envelope:** **none** — no new envelope type; it emits a host event, not a wire event.
- **Agent pack:** **none** — it uses a cheap raw dispatch, not an agent persona.
- **`/.well-known`:** no advertisement.

---

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `src/features/chat-autotitle/`; appended to `BACKEND_FEATURES`; no core route/nav edits; the binding is *called from* `conversationExchange` exactly as `memory-auto-extract` is (core→feature call is the established seam). |
| 2 | Toggle + admin | `chat-autotitle`, **OFF**, `bucketUnit: user`; `FeatureTogglePanel`-managed; graduation-to-ON is OQ-1. |
| 3 | Workflow surface (0014) | **None** (internal side-effect). |
| 4 | Node pack | **None.** |
| 5 | AI-chat envelopes | **None**; emits host event `conversation.titled` (non-normative). |
| 6 | Agent pack | **None.** |
| 7 | Public surface | **None.** |
| 8 | RBAC + isolation (0006) | The write rides the existing owner-scoped `chatSessions` gate; the binding runs in the run's tenant + acting-user scope; fail-closed (no toggle/owner ⇒ no call). |
| 9 | Replay / fork | Host-extension, **non-replay** — title on the session store, never a run-event/`run.metadata`; the LLM call is a side-effect outside replay. Packs: n/a (no pack). |
| 10 | Frontend | `useChatSession` consumes `conversation.titled`; placeholder retained; rail/tab update; tokens/a11y unchanged (text-only). |

---

## PRD-vs-architecture corrections

1. **Deep-dive proposed an FE-initiated `POST …/autotitle` route the client calls.** → **Corrected:** fire from `conversationExchange` (the `maybeExtractMemoryOnClose` seam) instead — the backend already sees the first exchange, so no new FE round-trip; it emits a `conversation.titled` event the FE already-has-a-stream for. Cleaner, matches the established precedent, and avoids a client race.
2. **Deep-dive left `structured` vs `completion` open.** → **Decided `completion`** — the free MiniMax tier can't be trusted to emit clean structured/tool output (ADR 0146 saga); a title needs no schema.
3. **Replay** — the deep-dive correctly flagged host-extension/non-replay; codified here (title on the session store, not the run log).

---

## Alternatives weighed

- **Core-chat, no toggle (like ADR 0117/0102).** Rejected for v1: a per-new-chat LLM call is a real, recurring cost ([LibreChat bill-trimming](https://medium.com/@borysenus/five-things-we-learned-trimming-librechats-llm-bill-b15e36f0dde3) flags title-gen specifically) + a personal preference — a toggle gives opt-out + cost control, matching `memory-extraction`. Graduation to always-on is OQ-1.
- **Structured-output / `generateObject`+Zod (Vercel AI SDK 6).** Rejected as the default — tool-calling-dependent; unreliable on the free tier. May be a BYOK-only fast path later.
- **`final` timing (title after the full reply).** Rejected — 5–30 s of "New chat" reads as broken; `immediate` is the modern default.
- **Keep the substring.** Rejected — it's the regressing status quo and not topic-aware.
- **Re-title on topic drift.** Deferred (OQ-4) — title once on the first exchange (ChatGPT's behavior).

## Open questions / decisions

1. **OQ-1 — Graduate to ON by default? → DECIDED: ON by default** (product decision 2026-06-27). Auto-naming is expected default behavior; the per-user toggle is the opt-out. Cost is bounded by the ≤~16-output-token call + the ADR 0106 per-tenant managed daily cap; revisit only if the token cost proves material.
2. **OQ-2 — `bucketUnit` `user` vs `tenant`? → DECIDED: `user`** (a personal UX preference, like `memory-extraction`); a workspace can still disable it org-wide via the panel.
3. **OQ-3 — Trigger & frequency → DECIDED: title ONCE, on the first exchange; never auto-retitle** (product decision 2026-06-27 — "only autoname after first session"). Message-only `immediate` context (title in ~1–2 s, parallel with the reply); upgrade to +first-reply context only if titles read poorly. **The user can always rename** — a manual rename sets `titleSource='user'` and is never overwritten.
4. **OQ-4 — Retitle on drift? → DECIDED: no** — title once (per OQ-3). A future explicit "↻ rename" affordance could re-run the pass on demand, but never automatically.
5. **OQ-5 — Truncation/sanitation of model output.** Hard-cap to ~60 chars, strip quotes/newlines/leading "Title:", fall back to the placeholder on empty/garbage — so a misbehaving free model degrades to today's behavior, never worse.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** The title is a host-side display label on the chat-session store; `conversation.titled` is a **non-normative host event** on the run SSE (the same class as the host's other chat-session events); nothing touches the OpenWOP wire (no run-event field, capability flag, normative MUST, or endpoint contract). It rides the **already-Accepted RFC 0005** conversation primitive as host work — exactly like ADR 0120 (memory-extract) and ADR 0130 (model-router stamp). `OPENWOP_REQUIRE_BEHAVIOR=true` is unaffected (no new advertisement).

## Consequences

- **Positive:** topic-aware names out-of-box (when enabled); fixes the substring regression by sourcing from the model + a real first-exchange event; reuses three established seams (chatSessions title, the managed/BYOK dispatch, the first-exchange side-effect pattern); non-replay-by-construction; degrades to the substring on any failure.
- **Negative / accepted:** a cheap LLM call per new conversation (token-capped; toggle-gated). Free-tier MiniMax may occasionally return a weak title — bounded by OQ-5 sanitation + the placeholder fallback.
- **Reversible:** toggle OFF ⇒ the substring placeholder is the title (today's behavior); the package is removable without touching the chat core.
