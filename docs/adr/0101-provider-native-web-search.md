# ADR 0101 — Provider-native web search (one capability, provider-aware backing)

Status: implemented (Phases 1–3 + both Phase 2 deferrals — per-exchange toggle and OpenAI native search via the Responses API; OpenAI/Anthropic capability flags pending one live check)

## Why this exists

A chat-driven research agent (`core.openwop.agents.deep-research`) needs live web
access. The app has BYOK: the user already supplies an LLM provider key on the
keys page. Yet today the only web-search path an **agent** can reach is the host
`ai.research.web` tool backed by a **separate** search-vendor key
(`OPENWOP_WEBSEARCH_API_KEY` / a BYOK `web-search` secret). With no such key the
host returns a *silent demo stub* (`webResearchSurface.exampleSearch`) that the
model can't distinguish from a real result — so the agent answers confidently as
if it researched, when it didn't (the bug that triggered this ADR).

Meanwhile the modern providers the user already pays for ground natively —
Gemini "Grounding with Google Search", OpenAI `web_search`, Anthropic
`web_search_20250305` — using the **same key the user already gave us**. Gemini
grounding is even already implemented (`dispatch.ts` `tools:[{googleSearch:{}}]`
→ `groundingMetadata`→citations) but is **stranded**: reachable only from the
workflow AI node, never from the conversation (`dispatchReply` and the agent
tool loop both drop `webSearch`).

So "web search" already has three unreconciled owners (native grounding, the
host `ai.research.web` tool, the workflow `webSearchNode`) and a dishonest
capability flag (`providers.json` marks `google` `webSearch:false` though it is
implemented). This ADR records the decision to **unify** these into one
capability with a provider-aware backing, rather than add a fourth path.

## Decision

Model web search as **one capability** resolved per `(provider, webSearch
toggle, tenant)`:

- **Native** — when the selected provider advertises native search (and the web
  toggle is on), enable the provider's built-in search on the dispatch/tool
  round, **using the user's existing LLM key**. No second key.
- **Host tool** — otherwise (e.g. the managed/MiniMax free tier, or a host that
  wants search control/caching/allow-lists), the agent's `ai.research.web` tool,
  backed by a BYOK `web-search` secret (keys page) → `OPENWOP_WEBSEARCH_API_KEY`
  (host-operator default).
- **None** — toggle off, or a managed tier with no host key: the host returns an
  **explicit "web search not configured" signal** (never a stub), so the model
  says it answered from its own knowledge.

The agent's declared `ai.research.web` capability and the chat `webSearch` toggle
**converge on this one resolver**; they are not two unrelated flags. The host
search tool is preserved as the honest fallback, so nothing is orphaned.

### Why not the alternatives (see the /architect options table)

- **Native-only** (drop the host tool): loses the managed/MiniMax tier (no native
  search) and host-controlled search, and orphans the `ai.research.web` id agent
  manifests declare (RFC 0003). Rejected.
- **Host-tool-only** (status quo + just document the key): forces every BYOK user
  to provision a *second* key even though their provider grounds natively — the
  exact friction this ADR removes — and leaves the implemented Gemini grounding
  rotting. Rejected.
- **Hybrid (this ADR):** unifies the three existing mechanisms; serves the ask
  (no second key for Gemini/OpenAI/Anthropic) while keeping the managed fallback.

## Capability honesty & the wire

The per-provider `webSearch` capability must be **truthful and single-sourced**.
`providers.json` is the authority (the FE `byok/lib/providers.ts` flag must
derive from it, not duplicate it). A provider's flag is `true` **iff** this host
actually enables its native search.

> **Correction (implementation):** the /architect review flagged the
> `providers.json` flags as dishonest (all `false`). That was a misread — the
> `webSearch` flag is **model-scoped**, and the Gemini models already carry
> `"webSearch": true` (Anthropic/OpenAI carry a `_capabilityNote` deferral). So
> the flags are already honest; **no `providers.json` change was needed**. The
> FE `ChatSidebar` already gates the toggle on `activeModel.webSearch`. The
> remaining single-source cleanup (FE deriving from `providers.json` rather than
> its own list) stays a Phase 3 item. This is a host config attribute, not a
`/.well-known/openwop` advertised capability the SDK types — so **no new openwop
RFC is required** (it rides the existing provider-call seam + the existing
non-normative `ai.research.web` host-tool id). If `webSearch` ever becomes a wire
capability the SDK negotiates, *that* would need an RFC.

## Replay / determinism

Native grounding is a live provider search → non-deterministic. The grounded
**answer text** is captured in the conversation event log (`ai.message.*`), so a
conversation `:fork`/replay reads the captured answer, not a re-search — safe.
Grounding **citations** (`groundingMetadata`) SHOULD also be captured for
fidelity; the chat path already parses them, and any new path (loop / OpenAI /
Anthropic) MUST capture them the same way. No run is re-dispatched on replay, so
no re-search occurs.

## Untrusted content / prompt-injection (the result-body trust boundary)

> Added in the grade-code 2026-06-22 remediation (`WSRCH-1`/`WSRCH-2`) — the
> original ADR reasoned about citation *replay* but not the *trust* of result
> bodies, the higher-risk surface for a feature whose whole job is pulling live
> web content into the agent loop.

Web-search results are the **highest-risk untrusted RAG input** the agent ingests —
attacker-controlled pages the model is then asked to act on. Two ingestion paths,
two postures:

- **Host-tool / agent-loop results** (a `web.fetch`-class tool whose output re-enters
  `runChatToolLoop`): the result body is **fenced as untrusted** before it returns to
  the model — `fenceUntrustedBlock` (`host/untrustedContent.ts`) wraps it in the
  BEGIN/END UNTRUSTED CONTENT delimiter with the data-only instruction and defangs any
  spoofed inner delimiter, the same RFC 0021 boundary KB/memory get. Before this fix
  tool results re-entered as a bare user message. Internal structure (newlines/JSON) is
  preserved — only injection *instructions* are neutralized, not the data the model
  legitimately needs.
- **Provider-native grounding** (Gemini `googleSearch` / Anthropic / OpenAI server
  tool): the provider fetches and ingests the page **model-side**, outside any host
  fence — the host never receives the raw body, only the grounded answer + citations.
  The host cannot fence what it does not receive; the citations it DOES capture are
  treated as data, never executed. **Stated residual risk:** a malicious page surfaced
  by provider-native search could attempt to steer the model within the provider's own
  context. We accept this as the cost of native grounding and rely on the provider's
  injection defenses, to be revisited if a provider exposes a host-side content hook.

## Open question resolved by the Phase 0 spike

Gemini ≥2.0 lifted the old restriction that `googleSearch` grounding could not be
combined with `functionDeclarations` in one request (the user runs Gemini 2.5
Flash-Lite). Phase 1 sends both together; **this needs live confirmation on the
target model** before enabling by default. If a provider/model rejects mixing,
that model's resolver returns **native** *xor* **host-tool** for a turn (grounding
for the research need; the agent's non-search tools that turn forgo function
calling) — recorded as a correction note here when verified.

## Implementation plan

| Phase | Scope | Gate |
|---|---|---|
| 0 | This ADR; confirm Gemini 2.5 grounding+function mixing; confirm citation capture survives `:fork` | live key check |
| 1 | `webSearch` on `AiToolCallRequest`/`ToolsRoundRequest`; thread conversation (`dispatchReply` + tool loop) → resolver; Gemini grounding in the round dispatcher; `providers.json` `google.webSearch=true`; replace `exampleSearch` silent stub with an explicit unavailable signal; FE sends the toggle into conversation inputs | tsc + vitest + FE build |
| 2 | **Anthropic** native search (`web_search_20250305` server tool on the existing Messages call) + **citation capture** (Gemini `groundingMetadata` + Anthropic result blocks → `ToolsRoundResult.citations`, surfaced as a Sources footer). **OpenAI native search + per-exchange toggle DEFERRED** (see below). | tsc + vitest |
| 3 | **`web-search` keys-page card** (a dedicated BYOK card storing the bare `web-search` ref the host resolves — not an LLM-provider tile; excluded from the "unscoped keys" warning). The FE capability flag was **already single-sourced** (`byok/lib/providers.ts` imports `providers.json`) — no-op. | FE build |

### Phase 2 scoping (recorded)

The /architect pre-review narrowed Phase 2 on Boundaries + capability-honesty grounds:

- **OpenAI native search — DEFERRED.** It needs the **Responses API** (a different endpoint/body than the Chat-Completions tool-round dispatcher) or `*-search-preview` models not in the catalog; enabling `web_search_options` on the catalog's standard models would *regress* OpenAI tool turns. Implementing it blind = a parallel OpenAI dispatch shape (Boundaries violation) that can't be live-verified here. Stays deferred (the `_capabilityNote` already documents this).
- **Per-exchange toggle — DEFERRED.** It would add a `webSearch` field to **`ConversationResolve` (RFC 0005 §D)** — a normative wire shape → needs an RFC (a real gate). The Phase 1 open-time capture works without a wire change; per-exchange waits for the RFC.
- **Anthropic dispatcher support landed, flag stays `false` pending live verification.** The `web_search_20250305` tool + citation parse are implemented + unit-tested (mocked), but capability honesty means we don't advertise `webSearch: true` for Anthropic models until a live check confirms the request shape (e.g. whether a beta header is required). Flipping the flag is then a one-line change.

### Both Phase 2 deferrals — now RESOLVED

- **Per-exchange toggle — DONE (the RFC concern was over-conservative).** Re-checking the wire: `validateResumeValue` only validates `kind === 'approval'` interrupts and returns early for a **conversation** resume; the external-event path explicitly *tolerates extra fields*. So `ConversationResolve` is a host-internal type whose conversation payload is **not** schema-validated — adding a `webSearch` field is **not a wire-shape change and needs no RFC**. Implemented end-to-end: the resolve carries `webSearch`, `handleConversationResolve` derives a per-exchange override that beats `run.inputs.webSearch`, threaded into `dispatchReply` + `runConversationAgentToolTurn`; the FE sends the current toggle on every exchange. A mid-chat toggle now takes effect on the next turn (not just a new chat).
- **OpenAI native search — DONE, isolated.** `webSearch + openai` routes through a new **Responses API** round (`openAIResponsesToolsRound`) hosting the built-in `web_search` tool alongside flattened function tools; non-search OpenAI turns stay on Chat Completions, so the existing path can't regress (the fork is contained to the search case — the Boundaries concern). Citations come from `output[].content[].annotations` (`url_citation`). **Unit-tested (mocked); the model `webSearch` flag stays off until a live GPT-5.x check** (capability honesty — same posture as Anthropic).

## Compatibility

**Additive.** New optional `webSearch` plumbing; the host-tool path is preserved
as the fallback. No wire-shape break, no event-shape change, no `MUST` relaxed.

## Open spec gaps

| Gap | Resolution |
|---|---|
| Gemini grounding + function-tool mixing on 2.5 | Live spike (Phase 0); correction note here |
| OpenAI / Anthropic native search not yet wired | Phase 2 |
| FE `webSearch` flag duplicates `providers.json` | Phase 3 — single-source it |
| Citation events for native grounding in the loop | Phase 2 (capture parity with the chat path) |
| Phase 1 captures `webSearch` at conversation OPEN (run.inputs), so a mid-conversation toggle applies on the next new chat, not the current one | acceptable for Phase 1; per-exchange override is a Phase 2 refinement (carry `webSearch` on the resolve) |
