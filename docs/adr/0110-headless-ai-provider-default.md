# ADR 0110 — Tenant default AI provider for headless operations (ADR 0108 OQ-1: BYOK media fallback)

**Status:** implemented (2026-06-23) — all 3 phases
**Date:** 2026-06-23
**Toggle:** none new — the binding is optional per tenant; behavior is unchanged when unset.
**Capability:** none new on the wire. Uses an INTERNAL media-modality map (not the RFC 0031 advertised-capability vocabulary).
**Depends on / composes:** ADR 0108 (`mediaToTextViaLLM`), the BYOK secret store (`/byok/secrets` + `secretResolver`), `dispatchChat`/`dispatchManagedChat`, `modelCapabilityProbe` (pattern).
**Surface:** host-extension `/v1/host/openwop-app/ai/default` (non-normative).
**NON-NORMATIVE — no OpenWOP RFC.**

## Why this exists

ADR 0108 made KB media → text (image OCR, audio transcription) run through the host MANAGED provider (`managed:openwop-free`). If that managed model is **not multimodal**, ingest 422s — and there is **no way to fall back to a tenant's own capable model**, even when the tenant has a BYOK key for a vision/audio-capable provider (OQ-1).

The blocker is structural, confirmed by audit: a tenant's BYOK keys are stored as **opaque `credentialRef` strings** (`/byok/secrets`, `[a-zA-Z0-9_.-:]{1,128}`) → value. **A `credentialRef` carries no provider or model metadata** — `provider`/`model` are supplied per-conversation via `run.inputs`. A headless service op (KB media ingest, with no user-selected provider) therefore has nothing to resolve a usable BYOK `{provider, model, key}` from. We need a small new primitive: a tenant-level **default AI provider binding** for headless operations.

## Decision

Add an optional, per-tenant **`HeadlessAiDefault`** binding:

```ts
interface HeadlessAiDefault {
  tenantId: string;
  provider: 'anthropic' | 'openai' | 'google';  // a real dispatch provider
  model: string;                                  // e.g. 'gpt-4o', 'gemini-2.0-flash'
  credentialRef: string;                          // a pointer into the BYOK store — NOT the key
  updatedBy: string;
  updatedAt: string;
}
```

It binds the three things a headless `dispatchChat` needs that a bare `credentialRef` lacks: **provider + model + the ref**. Stored in a `DurableCollection` (one row per tenant); managed via a tiny host-extension route + a Settings UI. The key itself never leaves the BYOK store — the binding holds only the `credentialRef`.

### The headless provider resolver

`resolveHeadlessAi(tenantId, modality: 'image' | 'audio'): Promise<Dispatch | null>` — the single owner of "which provider does a headless op use," with a **capability-aware, cost-ordered fallback**:

1. **Managed first (cheapest)** — if the managed provider's underlying provider supports `modality` (per the internal modality map), use `dispatchManagedChat`. (Today's behavior.)
2. **Tenant BYOK default** — else, if a `HeadlessAiDefault` is set AND its `provider` supports `modality`, resolve `credentialRef` via `resolveSecret(ref, {tenantId})` (SR-1: host-side only, never in an event/log) and `dispatchChat({provider, model, apiKey})`.
3. **Neither** — return `null` ⇒ the caller 422s honestly ("a vision/audio-capable provider is required; configure a default AI provider").

### Internal media-modality map (NOT a wire capability)

```ts
const MEDIA_MODALITY: Record<string, { image: boolean; audio: boolean }> = {
  google:    { image: true, audio: true },   // Gemini: vision + audio
  anthropic: { image: true, audio: false },  // Claude: vision, no audio input
  openai:    { image: true, audio: false },  // GPT-4o vision; audio via a separate API, not chat parts
};
```
This is a **separate internal concern** from `modelCapabilityProbe`/RFC 0031's advertised capabilities (which gate envelope/tool-use behavior). Keeping it separate avoids touching the normative capability vocabulary — **no RFC**. It is conservative (audio only where the chat-parts path is verified — Gemini), matching `dispatch`'s actual audio support.

## Phased plan

| Phase | Scope |
|---|---|
| 1 | **The primitive + resolver.** `HeadlessAiDefault` `DurableCollection` + `headlessAiService` (get/set, tenant-scoped, `credentialRef` validated against the BYOK store); `resolveHeadlessAi(tenantId, modality)` with the modality map + the cost-ordered chain. Host-extension route `GET/PUT /v1/host/openwop-app/ai/default` (workspace:write to set). |
| 2 | **Wire `mediaToTextViaLLM` to the resolver.** ✅ Replaced the hardcoded `dispatchManagedChat` with `resolveHeadlessAi(tenantId, kind)`; `null` ⇒ 422 "configure a default AI provider". Managed-dispatch responsibility removed from `kbService`. STT budget not consumed on failure (the call throws before `recordMediaUsage`). |
| 3 | **Settings UI.** ✅ `AiDefaultCard` on the `/keys` (BYOK) page — provider + model + stored-key selects (reusing `SelectField`/`Notice`), capability guidance (audio = Google only), empty-state, 4-locale i18n. |

> **Phase 1 landed (correction):** the route is namespaced **`/v1/host/openwop-app/byok/ai-default`** (not `/ai/default`) — `/ai/*` is owned by `agents.ts`, and the binding is BYOK config, so it lives in `byok.ts` under the `/byok/` namespace, same session-tenant scope as the secrets. Audit finding: the reference host's managed target is **MiniMax (text-only)**, so `MEDIA_MODALITY['minimax'] = {image:false,audio:false}` — media→text **always** routes to the BYOK default on the default host (OQ-1 is the primary media path, not just a fallback). `resolveHeadlessAi` returns a **closure** capturing the resolved key (SR-1); ephemeral/expired refs resolve to `null` → caller 422s.

## Alternatives weighed

- **Derive from existing connections/secrets.** Rejected — `credentialRef`s are opaque (no provider/model), and OAuth connections model Drive/email, not LLM keys. Nothing to derive from without guessing.
- **Try every stored BYOK key until one works.** Rejected — opaque refs give no provider/model, so we'd dispatch blind; multiple failed paid calls; non-deterministic which key.
- **Add `vision`/`audio` to the RFC 0031 advertised-capability vocabulary.** Rejected for this purpose — that vocabulary is normative + gates envelope behavior; media-input modality is a different axis. An internal map avoids a wire change.
- **Per-org instead of per-tenant.** The binding is a workspace-level operational setting; tenant-scoped matches where BYOK secrets live (tenant scope). Per-org could be a later refinement.

## Open questions

1. **OQ-A — Managed-modality detection.** Step 1 assumes we can tell whether the *managed* model is multimodal. If the managed provider's mapping is opaque, fall back to "try managed; on a capability error, try BYOK" instead of a static map check. Decide at implementation.
2. **OQ-B — Default vs prefer-BYOK.** Cost says managed-first; a tenant might prefer their own (better) model. A future `preferByok` flag is out of scope.
3. **OQ-C — Other headless callers — ADDRESSED (2026-06-23).** `cms/translate` now routes through `resolveHeadlessAi(tenantId, 'text')` instead of a hardcoded `dispatchManagedChat` — `resolveHeadlessAi` gained a `'text'` modality (every provider handles text, so managed always qualifies → behaviourally identical + a BYOK-default fallback). It's the single owner of headless provider choice. Verified non-recorded (called only from the cms route). Future headless dispatch should adopt it likewise.

## Replay / security

- **Replay-safe by inheritance.** `mediaToTextViaLLM` is only reached on **non-recorded service paths** (ADR 0108 review — verified). A BYOK `dispatchChat` there has no run to fork, so it carries the same replay-safety as the managed call it replaces.
- **SR-1.** The binding stores only a `credentialRef`; the key is resolved host-side at dispatch via `resolveSecret` and never enters an event, prompt, log, or the result.
- **Authz/IDOR.** The setting is tenant-scoped; the route gates `workspace:write`; the `credentialRef` is validated to exist in the caller's BYOK scope (can't point at another tenant's secret).

## RFC verdict (Step 5)

**Host-assembly over existing seams — NO new RFC.** The binding is a host-extension setting under `/v1/host/openwop-app/*`; the modality map is internal (not the normative capability vocabulary); BYOK dispatch + `secretResolver` are existing host mechanisms. No wire surface changes.
