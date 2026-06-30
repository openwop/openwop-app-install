# ADR 0121 — Local / OpenAI-compatible model provider support (B12)

**Status:** in-progress — **RFC 0108 `Accepted`** (2026-06-24). Host mechanism on main (`host/compatEndpoints.ts`, `compat` dispatch, env-gated config CRUD) + the **FE connect form** (`byok/CompatEndpointsCard` on the Keys page) implemented (2026-06-24). The `aiProviders.selfHosted[]` advertisement remains operator-gated on `OPENWOP_COMPAT_PROVIDER_ENABLED` (default OFF); honest now that RFC 0108 is Accepted.
**Date:** 2026-06-23
**Toggle:** none new as a *feature* — this is **provider configuration**, not a product surface. A local/compat provider is added through the existing BYOK + Connections config path; it is "on" for a tenant exactly when that tenant has configured a base-URL connection. (No `bucketUnit` because there is no A/B-able surface; the gate is "is a compat endpoint configured for this tenant?".)
**Surface:** host-extension `/v1/host/openwop-app/byok/*` + `/v1/host/openwop-app/connections/*` for the **config**; the **dispatch** rides the existing `providers/dispatch.ts` abstraction. **BUT** advertising the new provider class at `/.well-known/openwop` `aiProviders.supported[]` is a **normative wire change** (see RFC verdict).
**Depends on / composes:** ADR 0067 (conversation-run dispatch + BYOK provider policy), ADR 0024 (Connections / credential broker — base-URL + key custody), ADR 0110 (headless default binding — composes as the default for headless ops), the BYOK secret store (`byok/secretResolver.ts`), `host/modelCapabilityProbe.ts` (the vision/tools capability map pattern), `providers/dispatch.ts` (`DispatchRequest`/`dispatchChat`).
**RFC verdict:** **NEEDS a new openwop RFC — blocks host work.** Advertising a self-hosted / OpenAI-compatible provider class in the normative `aiProviders.supported[]` is a wire-honesty claim that `OPENWOP_REQUIRE_BEHAVIOR=true` would fail if dishonest. The RFC MUST reach **≥Accepted before/with** the host work. **Next step: `/prd`** to author it in `../openwop/RFCS/`.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 (B12, P2, HIGH) + §11 (every competitor: "Create ADR (B12 — RFC gate)"). All five competitors ship local/compat endpoints and OpenWOP is **ABSENT — cloud-only** (§2 capability map, §8 gap theme #6: "the one true wire-honesty item"). Competitor impl paths: LibreChat `api/app/clients/OllamaClient.js` + the custom-endpoint path (`api/server/services/Config/getEndpointsConfig.js`, arbitrary `baseURL`+key via YAML, `dropParams`, header placeholder substitution, recent SSRF hardening #13919); Jan `core/.../engines/RemoteOAIEngine.ts` (per-provider base-URL override, `web-app/src/constants/providers.ts`); AnythingLLM `server/utils/AiProviders/{ollama,lmStudio,localai,...}/` (tool-calling emulated via prompt injection when unsupported — `aibitat/providers/helpers/untooled.js`); Open WebUI `routers/ollama.py` + OpenAI-compatible `routers/openai.py`.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a new Ollama client + its own HTTP path + its own key store + its own model list." Every one of those already has a single owner here; re-implementing any is the [[no-parallel-architecture]] violation. The real net-new is **one dispatch case keyed on a configurable base-URL**, the **config to carry that base-URL**, and the **honest capability advertisement** (the RFC-gated part).

| Concern | Existing owner (file:line) | How local/compat reuses it |
|---|---|---|
| Provider dispatch abstraction | `providers/dispatch.ts:138` `dispatchChat(reqIn)` over `DispatchRequest` (`:43`) — switch on `provider` at `:146-152` | Add a `compat` (OpenAI-compatible) dispatch case. The **wire format already exists**: minimax is dispatched as OpenAI-compatible chat-completions against a **configurable base-URL** (`dispatch.ts:506` `MINIMAX_API_BASE_URL ?? MINIMAX_DEFAULT_BASE_URL` → `${baseUrl}/chat/completions`). Ollama/LM Studio/vLLM all speak `/v1/chat/completions` — so this is the **same code path with a per-connection base-URL**, not a new HTTP client. |
| Base-URL + optional key custody | Connections / credential broker (ADR 0024) — `Connection.kind: 'api_key'|'bearer'|'custom'`, KMS-enveloped `encryptedConfig`, `ProviderManifest` registry | A compat endpoint is a `kind:'custom'` (or `api_key`) Connection whose config carries `{ baseUrl, apiKey? }`. **No new secret store** — the BYOK envelope already holds it. Local endpoints may need **no key** (Ollama default), so the manifest allows an empty key. |
| BYOK key resolution | `byok/secretResolver.ts` `resolveSecret({tenantId})` (ADR 0067 §Phase 1, used at `conversationExchange.ts` `dispatchReply`) | The compat key resolves the same way. The base-URL is config, not a secret; it travels with the run as a provider param. |
| Vision/tools capability | `host/modelCapabilityProbe.ts` (static per-provider map, RFC 0031 gate) + the route-level `assertModalitiesAdvertised`/capability gate (ADR 0089 §2) | A compat endpoint's capabilities are **unknown a priori** — extend the probe so a compat connection carries a **declared** capability set (vision/tools/long-context), default-conservative (text-only). The model-capability gate then refuses an unadvertised modality (no dishonest envelope claim). |
| Headless default | ADR 0110 `resolveHeadlessAi(tenantId, modality)` (`host/headlessAi.ts:34` `HEADLESS_PROVIDERS`) | A tenant MAY bind its compat endpoint as the headless default — `HEADLESS_PROVIDERS` widens to include `compat`, the modality map reads the **declared** capabilities (not a hardcoded provider row). |
| SSRF-safe egress | `ctx.http.safeFetch` / `assertPublicUrl` (RFC 0076) + the brokered egress spine (ADR 0024 §4.5) | A user-supplied base-URL is **untrusted** → every compat dispatch MUST ride the SSRF guard (private-IP block, https-only except an explicitly-enabled loopback for true local). This is the LibreChat #13919 lesson. |
| Provider advertisement | `routes/discovery.ts:457` `aiProviders.supported: ['anthropic','openai','google','minimax']` (+`byok`, `toolCalling.providers`) | **The RFC-gated edge.** Adding `'compat'` (or a `local`/self-hosted class) here is a NORMATIVE wire claim. |

**Net new (small in code, large in governance):** one `compat` dispatch case (reuses the minimax OpenAI-compatible path with a per-connection base-URL), a compat `ProviderManifest` + `{baseUrl,apiKey?}` config shape, a **declared** capability extension to `modelCapabilityProbe`, the SSRF guard on the egress, the BYOK/Connections UI to add a compat endpoint, and — **gated on a new openwop RFC** — the honest `aiProviders.supported[]` advertisement.

---

## Decision

Add a **`compat` provider class** to the dispatch abstraction: an OpenAI-compatible chat-completions dispatcher keyed on a **per-tenant configured base-URL** (Ollama / LM Studio / vLLM / any compat endpoint), with an **optional** key, carried as a Connection (ADR 0024) and resolved through the BYOK store. Capability (vision/tools) is **declared per connection** (default text-only) and enforced by the existing model-capability gate so the host never advertises a capability it can't honor. It composes ADR 0110 as a headless default and ADR 0067 as the conversation-run dispatch path. **The whole thing ships behind a new openwop RFC that makes the provider-class advertisement honest on the wire.**

### Data model — a compat endpoint is a Connection + a declared capability set

```ts
// A `compat` ProviderManifest (ADR 0024 registry) — kind:'custom', authFlow:'none'|'manual'
CompatProviderConfig {                 // stored as the Connection's encryptedConfig (KMS-enveloped)
  baseUrl: string;                     // e.g. http://localhost:11434/v1  | https://vllm.internal/v1
  apiKey?: string;                     // optional — Ollama needs none; vLLM/LM Studio may
  // declared capabilities (the host cannot probe a black-box endpoint reliably)
  capabilities?: {
    vision?: boolean;                  // image input parts
    tools?: boolean;                   // function-calling loop (ADR 0089)
    longContext?: boolean;
  };
  models?: string[];                   // optional: the model ids this endpoint serves (for the picker)
}
```

The dispatch request stays the existing `DispatchRequest` (`dispatch.ts:43`) with `provider: 'compat'`; the resolver injects `{ baseUrl, apiKey }` from the connection at dispatch time (never into an event/log — SR-1).

### Replay / fork

The **chosen provider/model + base-URL travel as `run.inputs`** exactly like every BYOK conversation today (`conversationExchange.ts` `dispatchReply` reads `inputs.{provider,model,credentialRef}`). A compat run records its provider/model/connection at creation; **`:fork` reads them verbatim** and re-dispatches against the same configured endpoint (ADR 0031 invariant). The base-URL is a config pointer, not a recomputed value — no nondeterminism is introduced by the dispatch choice itself (the model's output is live, same as any BYOK call; replay reads the recorded turn, never re-runs — ADR 0089 §Q4). The **declared** capability set is read from the connection at creation and gated then, so a later capability edit cannot retroactively change a recorded run's gate decision.

### RBAC & isolation

Configuring a compat endpoint = `workspace:write` on the tenant's BYOK/Connections scope (ADR 0024 §use-gate); using it in a run = the run's acting principal must own/`connections:use` the connection (fail-closed, uniform 404 on insufficient scope). A tenant's base-URL/key never leaks to another tenant (Connection scoping, ADR 0024 §1).

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | Not a feature-package — provider config. Touches `providers/dispatch.ts` (a `compat` case), the ADR 0024 Connections registry (a `compat` manifest), `host/modelCapabilityProbe.ts` (declared caps), `routes/discovery.ts` (gated advertisement). No new `features/*` dir. |
| 2 | Toggle + admin UI | No feature toggle. The "admin UI" is the existing BYOK/Connections page — add a "Local / compatible endpoint" connect form (base-URL + optional key + declared caps). |
| 3 | Workflow surface (0014) | None new — the chat-responder + agent dispatch already consume `dispatchChat`; `compat` is transparent to them once the case exists. |
| 4 | Node pack | None — no new tool. The agent tool loop (ADR 0089) works if the endpoint declares `tools:true` (else single completion, the managed-minimax fallback precedent). |
| 5 | AI-chat envelopes | Inherits ADR 0067 conversation-run dispatch verbatim; the in-chat model picker gains the tenant's compat models. |
| 6 | Agent pack | None — any agent can be pointed at a compat model via run inputs / headless default. |
| 7 | Public surface | None. Config is authed; the base-URL is never echoed to other tenants. |
| 8 | RBAC + isolation (0006) | `workspace:write` to configure; `connections:use` to dispatch; tenant-scoped connection; uniform-404 IDOR. |
| 9 | Replay / fork safety | Provider/model/connection in `run.inputs`, read verbatim on `:fork`; declared caps read at creation and gated then; live dispatch, recorded turn — no re-run on replay (ADR 0089 §Q4). |
| 10 | Frontend | A connect form on the BYOK/Connections page (base-URL + optional key + vision/tools toggles + optional model list); the in-chat model picker surfaces the configured compat models; SSRF/validation errors surfaced honestly. |

---

## Phased plan

> **Phase 0 (GATE — blocks everything): the openwop RFC.** Author + land (≥Accepted) a new RFC in `../openwop/RFCS/` for **capability advertisement of a self-hosted / OpenAI-compatible provider class** — the vocabulary for `aiProviders.supported[]` (a `compat`/`local` class), the honesty rule (advertise only a tenant-configured + reachable endpoint), and how `OPENWOP_REQUIRE_BEHAVIOR=true` verifies it. **`/prd` is the next action.** No host advertisement until this is Accepted. (The non-advertised host plumbing in Phases 1–3 MAY be built behind the RFC, but it MUST NOT light up `aiProviders.supported[]` until Phase 0 lands.)

1. **The `compat` dispatch case.** Add `provider: 'compat'` to `DispatchRequest`/`dispatchChat` (`dispatch.ts`), reusing the OpenAI-compatible chat-completions path (the minimax precedent, `dispatch.ts:506`) with a **per-call base-URL** injected by the resolver. SSRF-guarded egress (RFC 0076). Tests: dispatch against a mock compat server, https-only, private-IP refusal.
2. **Config — a `compat` Connection.** A `compat` `ProviderManifest` (ADR 0024) + `{baseUrl, apiKey?, capabilities?, models?}` config (KMS-enveloped); BYOK/Connections routes accept it; the key resolves via `resolveSecret`. Tenant-scoped, `workspace:write`, IDOR-404.
3. **Capability gate.** Extend `modelCapabilityProbe` so a compat connection contributes its **declared** caps; the route-level model-capability/modality gate (ADR 0089 §2) refuses an unadvertised modality. Default = text-only.
4. **Headless + conversation wiring.** `HEADLESS_PROVIDERS` (ADR 0110) widens to `compat`; the modality map reads declared caps. Conversation-run dispatch (ADR 0067) already routes by `run.inputs.provider` — verify `compat` flows through `dispatchReply`.
5. **Honest advertisement (post-Phase 0).** Add the RFC-defined `compat`/`local` class to `routes/discovery.ts` `aiProviders.supported[]`, advertised **only** when a reachable compat endpoint is configured for the tenant (honesty rule). Conformance leg.
6. **Frontend + tests.** The connect form; in-chat picker surfacing compat models; e2e against a local Ollama; replay/fork test that a forked compat run reads its recorded base-URL/model.

## Alternatives weighed

1. **A bespoke OllamaClient (LibreChat-style).** Rejected — minimax already proves the OpenAI-compatible chat-completions path with a configurable base-URL (`dispatch.ts:506`); a separate Ollama client is a parallel dispatcher for the same wire format.
2. **Advertise `compat` on the wire without an RFC.** Rejected — it is a dishonest capability claim; `OPENWOP_REQUIRE_BEHAVIOR=true` fails it, and it breaks cross-host conformance. This is the §8 "one true wire-honesty item."
3. **Probe the endpoint for capabilities at connect time.** A nice *enhancement* (call `/v1/models`, attempt a tiny vision request), but black-box endpoints lie/vary; v1 takes a **declared** capability set (conservative default text-only), probe is an open question.
4. **Emulate tool-calling via prompt injection when unsupported (AnythingLLM `untooled.js`).** Out of scope for v1 — an endpoint that doesn't declare `tools` falls back to single completion (the managed-minimax precedent, ADR 0089). Prompt-emulated tools is a later, separate decision (and a fidelity/replay hazard).

## Open questions

1. **OQ-1 — RFC scope.** Does the openwop RFC define a single `compat` class, or `compat` (OpenAI-wire) + `ollama` (native) separately? Lean: one `compat` class (everyone speaks `/v1/chat/completions`); native Ollama is a later additive flavor.
2. **OQ-2 — Capability probe vs declare.** Declared (v1) vs a connect-time probe (`/v1/models` + a vision smoke test). Lean: declare v1, probe as an enhancement.
3. **OQ-3 — Loopback egress.** True-local endpoints are `http://localhost:11434`. The SSRF guard blocks loopback by default; gate it behind an explicit `OPENWOP_ALLOW_LOOPBACK_COMPAT`/per-connection flag so a cloud tenant can't be tricked into hitting an internal service. Decide the default.
4. **OQ-4 — Managed vs BYOK semantics.** A compat endpoint is BYOK-shaped (the tenant owns it). It is **never** the host's managed tier. Confirm it can't be bound as `managed:*` (it can't — managed refs are host-config, ADR 0110).
5. **OQ-5 — Per-tenant vs per-user.** A compat endpoint is a Connection, so it can be user/org/workspace-scoped (ADR 0024 §1). v1: tenant/workspace; per-user later.

## RFC verdict (Step 5)

**NEEDS a new openwop RFC — blocks host work.** The host plumbing (dispatch case, Connection config, capability gate, headless wiring) is non-normative and rides Accepted RFCs (0024 credentials, 0076 egress, 0031 capabilities) — BUT the **provider-class advertisement** in `aiProviders.supported[]` at `/.well-known/openwop` (`routes/discovery.ts:457`) is a **normative wire-honesty claim** that `OPENWOP_REQUIRE_BEHAVIOR=true` enforces. A new RFC in `../openwop/RFCS/` defining the self-hosted/OpenAI-compatible provider-class capability vocabulary MUST reach **≥Accepted before/with** the advertisement. **`/prd` is the recommended next step** to author it. Until then, the host MUST NOT advertise the class (it MAY ship the un-advertised plumbing behind the pending RFC, dishonestly-advertising nothing).

---

## Implementation progress (dark, pre-Accepted)

**RFC verdict resolved-in-progress:** the gating RFC was authored as **openwop RFC 0108** ("Self-hosted / OpenAI-compatible provider class — `aiProviders.selfHosted[]`"), now **`Active`** (openwop PRs #755 → #756; schema/shape frozen in #757). The advertisement form changed from "add `compat` to `aiProviders.supported[]`" to an **additive `aiProviders.selfHosted[]` subset** of `supported` (mirrors `byok[]`) + the §A.2 truthful-advertisement rule, §A.3/§D endpoint-non-disclosure, and §B capability-non-inference.

**Decisions made during the build (refining the matrix above):**
- **Config storage:** a dedicated tenant-scoped `DurableCollection` (`host/compatEndpoints.ts` `CompatEndpoint`), NOT the OAuth-shaped connector `ProviderManifest` (which carries scopes/apiHosts/mcp fields irrelevant to an AI dispatch endpoint). The optional key rides BYOK (`setSecret`/`resolveSecret`); the base URL is host-only config (§D).
- **Dispatch reuse:** extracted a shared `dispatchOpenAICompatible` from the existing `dispatchMiniMax` (the OpenAI-compatible base-URL precedent) — `compat` and `minimax` both delegate to it (no parallel dispatcher; 105 existing tests green).
- **Two independent default-closed gates:** (1) `OPENWOP_COMPAT_PROVIDER_ENABLED` (env, default OFF) gates the **config surface** (routes 404 when unset) so endpoints can't be configured/used prematurely; (2) the **advertisement** (`selfHosted[]` in discovery) stays dark via a seam-gated `advertisedSelfHostedProviders()` helper (mirrors `advertisedAuthProfiles()`) AND is **not wired into the discovery object at all** until RFC 0108 reaches Accepted. Per the architect review: no bespoke advertise-flag — the seam-gate + not-yet-wiring is the honest mechanism.
- **§D non-disclosure:** the base URL is scrubbed from dispatch errors (`compat_transport_error`), never serialized into events/discovery; the advertised id is an opaque `compat` / `compat:<uuid>` (non-URL, §A.3). SSRF egress guard reused from `webhookEgressGuard` (host-internal per RFC 0108 Alt 4; connect-time IP pinning is a noted hardening follow-up).

**Phase → commit (branch `adr0121/compat-provider-plumbing`, PR openwop-app #725 — dark):**

| Phase / task | Commit | Status |
|---|---|---|
| 1 — `compat` dispatch case (+ SSRF + §D scrub) | `fc9a7169` | ✅ |
| 2/7 — `CompatEndpoint` store + §A.2 dark advertise + §A.3 id + §B caps + resolution | `b10d0ada` | ✅ |
| 4 — conversation-exchange wiring (`provider==='compat'` → endpoint) | `7033be68` | ✅ |
| (B) config CRUD routes + RBAC (env-gated) | `fc2510da` | ✅ |
| 5 — honest advertisement (`selfHosted[]` discovery line) | — | ⛔ **gated on RFC 0108 Accepted** |
| — frontend connect form (BYOK/Connections page) | — | pending |
| — `OPENWOP_TEST_COMPAT_ENDPOINT` conformance seam + non-vacuous honesty pass | — | pending (after openwop-conformance `1.36.0`) |

**Staged flip (with the spec session):** merge #757 (RFC stays `Active`) + publish openwop-conformance `1.36.0` → host flips the one-line advertisement for a configured+reachable endpoint → host passes the shape + honesty scenarios non-vacuously under `OPENWOP_REQUIRE_BEHAVIOR=true` → steward verifies the live discovery doc → RFC 0108 → `Accepted` (single openwop-app witness, no dual-witness for this operator-config surface).

---

## Follow-up action — surfacing audit (2026-06-24)

**Audit verdict (corrected 2026-06-24):** the RFC gate **has cleared — RFC 0108 is now
`Accepted`** (Active → Accepted 2026-06-24, openwop-app PR #725 conformance-harness witness,
single-witness bootstrap steward waiver). The earlier "still Active / make no UI claim"
framing is superseded. The backend mechanism is on main (`hostAdvertisedSelfHosted()`, the
`compat` dispatch case, the env-gated config CRUD); the **only** remaining gap is the **FE
connect form** — so this is now a buildable surfacing task, not a sequencing wait.

**Seam-correct action (host work, RFC-unblocked):**
1. Build the BYOK/Connections **compat-endpoint connect form** (base URL + optional key +
   declared capabilities + model list) on the existing `/keys` page seam → POST the
   `/v1/host/openwop-app/compat-endpoints` CRUD.
2. With a configured+reachable endpoint, `OPENWOP_COMPAT_PROVIDER_ENABLED` may be flipped on
   (the advertisement is now honest: `selfHosted ⊆ supported`, non-vacuous under
   `OPENWOP_REQUIRE_BEHAVIOR`). Keep the env as the operator opt-in (not a per-user toggle).

**Boundary check:** rides the shared compat dispatch + BYOK/Connections seam (no second
provider system); the connect form extends the existing `/keys` page, not a new one. The
status line at the top of this ADR still reads `Proposed` — **stale**; it should be updated
to reflect the Accepted RFC + the on-main host mechanism when this phase lands.
