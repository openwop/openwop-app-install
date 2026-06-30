# ADR 0115 — Image-generation node + chat output projection

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): `ctx.callImageGenerator` is now implemented (`aiProvidersHost.ts`, mirroring `callSpeechSynthesizer`) — the existing `core.openwop.ai.image-generate` node produces images via a deterministic test-seam mock + honest `host_capability_missing` for the not-yet-wired real providers. Discovery still advertises `imageGeneration:{supported:false}` (Phase 2 flips it only when a real provider is configured). **Phase 2 (honesty gate) implemented** (2026-06-24): `imageGenerationAdvertised()` (`OPENWOP_IMAGE_PROVIDER_ENABLED`, default false) gates the discovery `aiProviders.imageGeneration.supported` flip — production-honest (advertises true ONLY when the operator opts in with a configured provider, the same honest-flip as the compat provider). **Phase 3 (real dispatch) implemented** (2026-06-24): `host/imageProviderAdapter.ts` — the external text-to-image dispatch wired into `callImageGenerator`, present ONLY when `imageProviderConfigured()` (the advertise flag + a wired `OPENWOP_IMAGE_PROVIDER_ENDPOINT`); else honest-off `host_capability_missing` unchanged. SSRF-guarded (deny private/loopback unless allow-private, https-pinned), wall-clock timeout, §D endpoint non-disclosure; the returned base64 is stored host-side as a Media asset (raw bytes never cross the result boundary). **Phase 6 (agent pack) implemented** (2026-06-24): the `feature.image-gen.agents` pack — an **Image Generator** persona (`feature.image-gen.agents.default`) that drives the `core.openwop.ai.image-generate` node through the EXISTING AI chat (ADR 0058 agent+nodes pattern; no new chat surface), honest-off-aware (host_capability_missing fallback) + artifact-returning. Surfaces in GET /v1/agents. **Phase 5 (cost governance) implemented** (2026-06-24): `host/imageGenBudget.ts` — a per-tenant DAILY image-count budget (`OPENWOP_IMAGE_MAX_PER_DAY`, default 50; 0/unset = uncapped), checked in `callImageGenerator` BEFORE the metered provider call (over ⇒ `provider_rate_limited`, no dispatch, no charge) + the request `n` clamped to the remaining budget + recorded by images returned. Mirrors the ADR 0114 code-exec budget. Media projection coverage + second provider (remaining) pending. **Date:** 2026-06-23
**Toggle:** `image-gen` · default **OFF** · `bucketUnit: tenant` (a paid media-generation surface — a B2B tenant capability).
**Surface:** host-extension only — an `image-gen` feature-package whose node pack `feature.image-gen.nodes` **wires the already-shipped-but-unimplemented** `ctx.callImageGenerator` host capability to real providers (via Connections, ADR 0024), renders the result into chat as a **Media token** through artifact projection (ADR 0069/0083, Media ADR 0007), and is cost-governed by **ADR 0106**. Driven through the **existing chat** via an agent pack (ADR 0058). No new core route/nav edits. **No new wire contract by default** (see RFC verdict).
**Depends on / composes (all implemented — this is wiring + governance, not new infra):**
- **ADR 0001 (feature-package)** — `src/features/image-gen/`, default-OFF, appended to `BACKEND_FEATURES`.
- **The existing `core.openwop.ai` image nodes** — `core.openwop.ai.image-generate`/`image-edit`/`image-upscale` **already exist** as `delegateProvider` shims (`packs/core.openwop.ai/index.mjs:302`) to `ctx.callImageGenerator`/`callImageEditor`/`callImageUpscaler`, **which no host implements today** (`discovery.ts:471` advertises `imageGeneration:{supported:false}`). This ADR implements the missing host capability — it does **not** add a new node family.
- **ADR 0007 (Media) + ADR 0069 / 0083 (artifact workbench + run-output producer)** — the generated image is persisted as a **Media asset** by the **existing** producer (`host/runArtifactStore.ts` base64→`media:` mint, org-quota-asserted) and previews inline in chat/Library. **No new media store.**
- **ADR 0106 (media-generation cost governance)** — image generation is metered under the **same** per-org `mediaBudget` ceiling + pre-flight estimate (`aiProviders/mediaBudget.ts`). **Do NOT fork the budget.**
- **ADR 0024 (Connections)** — providers (OpenAI gpt-image, Google Imagen, …) are brokered Connections via `providerRegistry.ts` (`apiHosts` pin); BYOK + managed tiers.
- **RFC 0076 / `host/brokeredEgress.ts`** — provider calls (and any asset fetch) ride the SSRF-guarded broker.

**RFC verdict:** **default host-extension — NO new RFC.** It implements an **already-defined, already-Accepted** host capability (`callImageGenerator`, the same delegation pattern `callSpeechSynthesizer`/RFC 0105 uses and that this host already serves) and rides existing Media/artifact surfaces; nothing new touches the openwop wire. **EVALUATE:** advertising a **normative cross-host "image-output" capability** in `/.well-known/openwop` (flipping `imageGeneration` to `supported:true` as a *cross-host-observable* claim) is the honesty line — if that claim is to be **conformance-tested cross-host**, confirm the capability's wire shape is covered by an **Accepted openwop RFC** before advertising `supported:true` (mirrors how `speechSynthesis:'supported'` rides RFC 0105). Host-ext routes under `/v1/host/openwop-app/*` never need an RFC.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9/§11 (gap **B5**, HIGH) — OpenWOP today has **vision INPUT only** (ADR 0085 audio/video ingest; no image *output*). Competitors: **Open WebUI** `routers/images.py` + `utils/images/comfyui.py` (DALL·E / A1111 / ComfyUI / Imagen behind one provider seam); **LobeHub** `src/store/image/` + `webapi/create-image/`; **LibreChat** built-in DALL·E / Flux tools. The common shape is a **provider-pluggable image node whose output renders inline in chat** — exactly the seam the `core.openwop.ai.image-generate` node already declares but no host fills.

---

## Context — boundaries audit first (MANDATORY)

The decisive audit finding: **the node and capability seam already exist; only the host implementation + governance + chat projection are missing.** `core.openwop.ai.image-generate` is a `delegateProvider('callImageGenerator')` shim (`packs/core.openwop.ai/index.mjs:302`) that throws `HOST_CAPABILITY_MISSING` because no host wires `callImageGenerator`; `routes/discovery.ts:471` honestly advertises `imageGeneration:{supported:false}`. So this is **wiring an existing seam**, not a new node family — and it is the **sibling of the implemented `callSpeechSynthesizer`** path (RFC 0105), which proves the exact provider-adapter + media-asset + cost-budget pattern end-to-end.

| Concern | Existing owner (file:line) | How `image-gen` reuses it |
|---|---|---|
| The image-generation node | `packs/core.openwop.ai/index.mjs:302` (`imageGenerate = delegateProvider('callImageGenerator')`) + schemas `image-generate.{config,input,output}.json` | **Already exists.** This ADR implements the host `callImageGenerator` it delegates to; no new node. |
| Capability honesty | `routes/discovery.ts:471` `imageGeneration:{supported:false}` (vs `speechSynthesis:'supported'` at :477) | Flip to `supported:true` **only** once wired (the `OPENWOP_REQUIRE_BEHAVIOR` honesty rule), exactly like the TTS precedent. |
| Provider adapter pattern | `aiProviders/aiProvidersHost.ts:713` (`callSpeechSynthesizer`, RFC 0105) — provider dispatch + tier policy + mock | `callImageGenerator` is the **sibling** adapter: same dispatch/mock shape, image providers instead of TTS. Extract a shared adapter scaffold, don't fork. |
| Provider credentials | Connections `providerRegistry.ts:41` (`apiHosts`) + brokered egress | OpenAI / Google Imagen are brokered Connections; BYOK + managed tiers (ADR 0024). |
| Persist the image as a durable asset | `host/runArtifactStore.ts` (ADR 0083) — base64→`media:` mint, org-quota asserted, multi-image capture | The generated image(s) are captured by the **existing** producer → `media:` artifacts; **no new media store.** |
| Render the image inline in chat | The Media token + `ArtifactPreviewModal`/`ArtifactWorkbench` (ADR 0069/0083 render `source:'media'` images inline) | The chat completion card previews the bytes; opens the workbench. **No new renderer.** |
| Per-org cost/spend ceiling | `aiProviders/mediaBudget.ts` + governance (ADR 0106) — `checkMediaBudget`/`recordMediaUsage`, pre-flight estimate | **Extend the same budget** with an `images` unit (count or pixels) — reuse `checkMediaBudget`/`recordMediaUsage`, **do not fork** `mediaBudget`. |
| SSRF-guarded egress | `host/brokeredEgress.ts:114` (`brokeredFetch`) | Provider call + any asset fetch ride the broker (private-IP block, host pin, https-only). |
| Drive AI for the feature | The existing chat + agent pack (ADR 0058/0073) | A `feature.image-gen.agents` "Image Designer" persona scoped to the node; deep-link the existing chat. **No new chat panel.** |

**Net new (small):** the host `callImageGenerator` (+ `callImageEditor`) adapter implementation (the TTS-sibling), image providers in the Connections registry, an `images` unit on the ADR 0106 budget, a `feature.image-gen.agents` persona, and the toggle. The node, schemas, capability flag, media store, chat renderer, and producer are all reuse.

> **Decision: EXTEND ADR 0106, do not create a sibling budget.** Per the prompt's first audit — `mediaBudget` (`aiProviders/mediaBudget.ts`) already governs the paid media path (TTS chars, STT bytes) under a per-org daily ceiling with a pre-flight estimate. Image generation is the same paid-media class; it adds an `images` unit to the **same** counter/override/governance-route, reusing `checkMediaBudget`/`recordMediaUsage`. A separate "image budget" would be the exact fork ADR 0106 §Alternatives already rejected.

---

## Decision

Ship an **`image-gen` feature-package** that **implements the host `callImageGenerator`/`callImageEditor` capability** (the TTS-sibling adapter, providers via Connections), so the **already-shipped** `core.openwop.ai.image-generate` node produces real images; persists each image as a **Media artifact** via the existing producer; renders it inline in chat; and meters it under the **ADR 0106 budget**. Drive it through the **existing chat** via an agent pack — never a new chat panel.

### The host capability (the genuinely new code)

`ctx.callImageGenerator({ prompt, size?, n?, provider?, model? })` → `{ images: [{ base64 | mediaRef, mimeType }] }`, a sibling of `callSpeechSynthesizer` (`aiProvidersHost.ts:713`):
- provider dispatch (OpenAI gpt-image, Google Imagen, …) over brokered Connection credentials; a deterministic **mock** provider for tests/demo (the `callSpeechSynthesizer` mock precedent).
- tier policy mirrors ADR 0106: managed-tier = operator backstop budget; BYOK = opt-in guardrail.
- `callImageEditor` (image+prompt → edited image) follows the same shape for the existing `image-edit` node.

### Data model — no new store

No new persistence: image generation is a normal **executor run**; the produced image(s) are captured by the **existing** `host/runArtifactStore.ts` producer (base64→`media:` mint, org-quota asserted, multi-image `${runId}:${nodeId}#i` capture per ADR 0083). The chat completion card and workbench render `source:'media'` images inline. The only "new" durable shape is the Media asset the producer already mints.

### Chat output projection

The generated image renders into chat as a **Media token** projected through artifact projection (ADR 0069/0083): the run's terminal `image-generate` output → a `media:` artifact → inline `<img>` in the completion preview, openable in the workbench/Library. No new envelope kind, no new renderer.

### RBAC & isolation (ADR 0006)

Org-scoped, fail-closed. Driving the node requires `workspace:write` in the run's org (`accessControlService.ts:125`) + the per-tool gate (ADR 0102) permitting `core.openwop.ai.image-generate` for the tenant. Media-asset reads authorize per-record via the asset's org + `resolveEffectiveAccess` (`accessControlService.ts:975`); non-visible → uniform **404** (IDOR-safe). The provider credential resolves from the run's tenant Connection — never request input. The minted asset URL is tenant-scoped (`media-asset-url-tenant-scoped`, no guessable/SSRF URL).

### Replay / fork safety

The generated image is a **recorded Media artifact**; on `:fork`/replay the recorded asset is read **verbatim** and the image is **NOT re-generated** (determinism + no double-spend). This is the ADR 0083 invariant exactly: the non-deterministic media mint is guarded by a bookkeeping row keyed on the deterministic `${runId}:${nodeId}`, so a re-execution returns the existing `media:` id without re-minting; the producer hook is gated `forkMode !== 'replay'`; `:fork` in `branch` mode legitimately mints a new image under the new runId. Cost is metered post-dispatch (real figure), so replay double-charges nothing (ADR 0106 §9).

### Security

- **SSRF:** provider + asset fetch only via `brokeredFetch` (host-pinned `apiHosts`, private-IP block, https-only).
- **Credentials:** brokered Connection, never raw env in node code; SR-1 redaction on persisted outputs.
- **Spend:** the ADR 0106 budget is the abuse ceiling (an image loop is otherwise unbounded); fail-closed when enabled.
- **Content:** an image-output safety posture (provider-side moderation + an optional host policy) is OQ-4.

Recommend `/architect` (replay/fork + the Media projection) + `/nfr` (SSRF, capability honesty, spend) at implementation.

---

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | **Yes** — `src/features/image-gen/`, default-OFF, appended to `BACKEND_FEATURES`; the host `callImageGenerator` adapter lives in `aiProviders/` (the TTS-sibling), zero core route edits. |
| 2 | Toggle + admin UI | `image-gen` toggle, OFF, `bucketUnit: tenant`, category "Business Tools". Admin enable in the existing toggle panel; budget config in the ADR 0106/0077 Governance panel. |
| 3 | Workflow surface (`ctx.<feature>`, ADR 0014) | None new — the node delegates to the host capability `ctx.callImageGenerator` (the `callSpeechSynthesizer` precedent — a host AI-provider seam, not a `ctx.features.X`). |
| 4 | Node pack | **Already shipped** — `core.openwop.ai.image-generate`/`image-edit`/`image-upscale` (`packs/core.openwop.ai`). This ADR fills the host capability they delegate to; no new pack. (A `feature.image-gen.nodes` is only needed if a feature-scoped convenience node is wanted.) |
| 5 | AI-chat envelopes | None new — the image renders as a **Media** artifact (ADR 0007) via the existing projection (ADR 0069/0083); the chat card previews `source:'media'` inline. |
| 6 | Agent pack | **`feature.image-gen.agents`** — an "Image Designer" persona, `toolAllowlist:["openwop:core.openwop.ai.image-generate","…image-edit"]`, driven through the existing chat (ADR 0058). |
| 7 | Public surface | None — authenticated, org-scoped; no anonymous route. |
| 8 | RBAC + isolation (ADR 0006) | `workspace:write` to run + per-tool gate (ADR 0102); media reads `resolveEffectiveAccess`, uniform-404 IDOR; tenant-scoped asset URL; credential from the run's tenant Connection. Fail-closed. |
| 9 | Replay / fork | Image recorded as a `media:` artifact; on replay/`:fork` read verbatim, **never re-generated**; deterministic `${runId}:${nodeId}` bookkeeping (ADR 0083); cost metered post-dispatch (no double-charge, ADR 0106). |
| 10 | Frontend | No new chat panel/page — reuse the chat completion card + `ArtifactPreviewModal`/`ArtifactWorkbench`/`LibraryPage` (inline image). Optional: an "Image Designer" entry in the chat agent picker; a budget readout in the Governance panel. |

---

## Phased plan

1. **Implement `callImageGenerator` (the TTS-sibling adapter).** In `aiProviders/` mirroring `callSpeechSynthesizer` (`aiProvidersHost.ts:713`): provider dispatch + a deterministic **mock**; one provider first (OpenAI gpt-image) over a brokered Connection. The **existing** `core.openwop.ai.image-generate` node now produces images. Tests: dispatch, mock, missing-credential error.
2. **Capability honesty.** Flip `routes/discovery.ts:471` `imageGeneration` to `supported:true` **only when a provider is configured** (the `speechSynthesis:'supported'`/`OPENWOP_REQUIRE_BEHAVIOR` rule); otherwise stays `false`. Tests: advertise-only-when-wired.
3. **Media projection in chat.** Confirm the producer captures the image as a `media:` artifact and the chat card + workbench preview it inline (ADR 0083 already does base64→`media:` + multi-image capture — likely zero new code; add coverage). Tests: image artifact persisted + previewed; replay reads verbatim (no re-gen).
4. **Cost governance (extend ADR 0106).** Add an `images` unit to `mediaBudget` (`checkMediaBudget`/`recordMediaUsage` + pre-flight estimate at the enqueue route); env default + per-org superadmin override on the existing Governance route. Tests: cap-hit 429, under-cap, off-by-default, replay-no-double-charge.
5. **Agent pack + chat drive + image-edit.** `feature.image-gen.agents` "Image Designer"; wire `callImageEditor` for the existing `image-edit` node; deep-link the existing chat. Tests: agent allowlist, edit roundtrip.
6. **Second provider (Google Imagen) + hardening.** Add Imagen behind the same adapter via Connections; `/architect` + `/nfr`; an optional output-moderation hook (OQ-4).
7. **Core-app extension surface.** All wiring is additive: the adapter slots into the existing `aiProviders` host surface (the node + schemas already install at boot), the feature appends to `BACKEND_FEATURES`, the budget extends ADR 0106, and the agent pack installs at boot — no core route/nav/chat edits.

## Alternatives weighed

1. **A brand-new `feature.image-gen.nodes` node family.** Rejected — `core.openwop.ai.image-generate` already exists; adding a parallel node is the `no-parallel-architecture` violation. Implement the host capability the existing node already delegates to.
2. **A separate "image budget."** Rejected — ADR 0106 already governs the paid-media class; image gen adds an `images` unit to the **same** budget (ADR 0106 §Alternatives already rejected the fork).
3. **Render images via a new chat envelope kind.** Rejected — images are Media (ADR 0007) and project through the existing artifact path; a new envelope would be wire surface for no benefit (and would need an RFC).
4. **Re-generate on replay/fork.** Rejected — non-deterministic + double-spend; record-and-read-verbatim is the ADR 0083/0106 invariant.

## Open questions

1. **OQ-1 — First provider + model.** OpenAI gpt-image vs Google Imagen as the day-1 reference; lean OpenAI gpt-image (BYOK-common, the LibreChat default).
2. **OQ-2 — Budget unit for images.** Image **count** (simple, like TTS chars) vs **pixels/resolution** (closer to provider cost). Lean count for v1; pixels behind the same `mediaBudget` if cost-accuracy demands it.
3. **OQ-3 — Edit/upscale scope.** Ship `image-edit` + `image-upscale` (nodes already exist) in v1, or `image-generate` only? Lean generate first, edit in Phase 5.
4. **OQ-4 — Output safety/moderation.** Rely on provider-side moderation only, or add a host content-policy hook on generated images? Propose provider-side v1, a host hook as a follow-on.
5. **OQ-5 — Local providers (ComfyUI/A1111).** Open WebUI's self-hosted-generator seam — a follow-on adapter behind the same `callImageGenerator`, gated by an explicit allowed-egress-host (it is a private endpoint the SSRF guard would otherwise block).

## RFC verdict (Step 5)

**Default host-extension — NO new RFC.** It implements an **already-defined** host capability (`callImageGenerator`, the `callSpeechSynthesizer`/RFC 0105 sibling) and rides existing Media/artifact/chat surfaces; routes are non-normative `/v1/host/openwop-app/*`. **EVALUATE:** flipping `imageGeneration` to `supported:true` is a *cross-host-observable* capability claim — if it is to be conformance-tested cross-host (so a remote A2A agent relies on "image-output"), confirm the capability's wire shape sits under an **Accepted openwop RFC** before advertising `supported:true` (exactly how `speechSynthesis:'supported'` rides RFC 0105). A genuinely **new** normative "image-output" envelope/capability not covered by an existing RFC earns a **new openwop RFC ≥ Accepted first**. Until wired, stay honest at `supported:false` (the current `discovery.ts:471` posture).

> **Phase 4 (media projection coverage + url-image-array fix) implemented** (2026-06-24):** confirming the image-generate node output projects to a previewable media artifact surfaced a GENUINE gap — the node emits `images: [{ url, mimeType }]` (bytes ALREADY stored as a host media asset by `callImageGenerator`, referenced by serve url), but the ADR 0083 producer's `detectServeRef` only handled a SINGLE `image.url`/`url`, not the ARRAY, so every generated image fell through to a JSON data blob instead of a file/media artifact. Added `detectServeRefAll` (the url sibling of the base64 `detectBase64All` images-array branch) + a capture step that mints a file artifact per image (primary keyed `${runId}:${nodeId}`, extras at `#i`) — so the Library/workbench preview the images, not JSON. Replay-safe: reuses the existing INSERT-ONLY `writeRow` on the deterministic key (a re-exec writes no new rows — verified). /architect (inline — extends the existing ADR 0083 projection; additive detector; no new persistence/wire semantics; the replay-determinism is the existing deterministic-key insert-only path), /code-review clean (0 banned). +1 test (url-image-array → 2 file artifacts, not a JSON blob, replay-idempotent) + 3 sibling artifact suites green (no regression). The base64-image-array projection was already covered. **Remaining: only the SPECULATIVE second image provider (Imagen, ADR step 6) — deferred (no real second provider to wire; faking one would violate advertise-only-honored-behavior).**

> **Phase 6 (second provider — per-provider routing) implemented** (2026-06-24):** the image-provider adapter is now genuinely MULTI-PROVIDER — NOT vendor-blocked. The earlier framing ('needs a real external vendor') conflated 'wire a specific named provider' with 'support a second provider'; the honest gap was per-provider ROUTING. `imageEndpoint(provider)` / `imageApiKey(provider)` resolve `OPENWOP_IMAGE_PROVIDER_ENDPOINT_<PROVIDER>` / `_KEY_<PROVIDER>` (e.g. `_GOOGLE` for Imagen — `google` is already in `IMAGE_PROVIDERS`), falling back to the generic `OPENWOP_IMAGE_PROVIDER_ENDPOINT` (back-compat: one generic endpoint still serves every provider). `imageProviderConfigured(provider)` + `dispatchImageGeneration({provider})` thread it, so `openai` and `google` route to their OWN configured endpoints + keys. INERT until configured (no faked vendor; advertises nothing new — `imageGenerationAdvertised()` still gates on `OPENWOP_IMAGE_PROVIDER_ENABLED`); the SSRF guard + §D endpoint non-disclosure apply per-provider. So an operator with Imagen (or any) credentials gets a real SECOND provider via configuration — the ADR's 'Add Imagen behind the same adapter' the honest, inert-until-configured way (the OpenAI-adapter precedent). /architect (inline — extends the Phase-3 adapter; no new wire/dep; the §D + SSRF invariants preserved per-provider); /code-review clean (0 banned; endpoint never echoed). 4 new tests (google routes to its endpoint+key / openai → generic fallback / honest-off when a provider has no endpoint / back-compat) + image-gen regression (13/13). **ADR 0115 is now COMPLETE.** (Native per-vendor request/response shaping — if a provider doesn't speak the neutral `{prompt,model,size,n}`→`{images:[{base64}]}` shape — is an operator-side gateway concern, the ADR 0108 self-hosted/compat-endpoint pattern.)

---

## Follow-up action — surfacing audit (2026-06-24)

**Audit verdict:** 🟠 backend (per-provider routing) + "Image Generator" agent persona are
complete, but **inert in the deployed demo** — `callImageGenerator` returns
`host_capability_missing` until `OPENWOP_IMAGE_PROVIDER_ENABLED` + an endpoint/key are
configured, and there is no first-class image-gen control: agent-only (ADR 0058, by design).
Note: the backend lives in `aiProviders/` + `host/` (there is **no `features/image-gen/`
dir** on either side) — acceptable (it's an AI-provider capability, not a routed feature),
recorded so the ADR's "feature-package `src/features/image-gen/`" framing isn't read literally.

**Seam-correct action (config + discoverability, mirrors ADR 0114):**
1. **Operator config** — document `OPENWOP_IMAGE_PROVIDER_ENABLED` + `_ENDPOINT[_<PROVIDER>]`
   / `_KEY_<PROVIDER>` + the per-org image budget in `DEPLOY.md`; wire a provider on the demo
   so `imageGeneration.supported` flips true.
2. **Agent discoverability** — surface/deep-link the `feature.image-gen.agents` persona in
   the agent picker.

**Boundary check:** agent-drive is the intended UX (ADR 0058) — no bespoke image page. No new
wire/dep; honest-off until configured.
