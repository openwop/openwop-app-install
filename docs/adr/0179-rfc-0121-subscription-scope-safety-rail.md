# ADR 0179 — RFC 0121 subscription-scope safety rail (acquisition-free host portion)

**Status:** implemented — the acquisition-free scope-safety rail shipped (`byok/subscriptionCredential.ts` + `test/rfc0121-subscription-at-own-risk.test.ts`; see § Implementation). The advertisement/acquisition portion is explicitly OUT OF SCOPE here (gated on RFC 0121 UQ1). *(Status-corrected 2026-07-21 — the header lagged the shipped rail.)*
**Date:** 2026-07-01
**Depends on:** RFC 0121 (subscription-reuse provider auth — `Active`; this ADR rides the rail portion), ADR 0121 (RFC 0108 self-hosted / compat provider — the honest-off advertisement precedent this mirrors), ADR 0024 (BYOK + managed provider tiers).
**Surface:** host runtime only — one new host-extension seam + one discovery field + one error code. **NON-NORMATIVE — no new RFC** (rides Active RFC 0121; host-extension route under `/v1/host/sample/*`, never touches the wire).

> Scope is deliberately narrow. This ADR records ONLY the **acquisition-free scope-safety rail**. The live `subscription` advertisement and any credential-**acquisition** mechanism are OUT OF SCOPE — deferred/gated on RFC 0121 UQ1 (see below).

## Why this exists

RFC 0121 defines `subscription` as a new `aiProviders.authModes` value: a provider credential supplied by **reusing the caller's existing personal, non-metered consumer subscription** (e.g. Claude Pro/Max, ChatGPT Plus) instead of a metered API key. Such a credential is **personal to one human**; binding it at `tenant`/`workspace` scope would silently share one person's subscription across an org — the misuse the RFC's §B.8 `subscription-credential-user-scope-only` invariant forbids.

RFC 0121 is `Active`, but a **steward amendment narrowed the UQ1 (ToS/legal) gate**: the live `subscription` advertisement and any acquisition mechanism remain UQ1-gated (they carry the ToS/legal exposure), but the **acquisition-free scope-safety rail MAY be built pre-UQ1** — it is a pure property of the credential-binding path and carries no acquisition risk. This ADR builds exactly that rail so the safety guarantee is witnessable now, honestly, without a dishonest wire claim.

## Decision

Build four rail-scoped pieces + this ADR; build **nothing** acquisition-bearing.

1. **New error code `credential_scope_forbidden`** (`types.ts` `OpenwopErrorCode`, near `credential_forbidden`) — the canonical code RFC 0121 §B.8 names.
2. **Pure invariant `assertSubscriptionScopeAllowed(scope)`** (`byok/subscriptionCredentialScope.ts`) — throws `credential_scope_forbidden` (403) for any `scope !== 'user'`. Tiny + pure; the single source of truth for the `subscription-credential-user-scope-only` invariant.
3. **§B.8 witness seam** — `POST /v1/host/sample/credentials/bind` (+ the app-canonical `/v1/host/openwop-app/credentials/bind` alias), registered alongside the existing `/v1/host/sample/ai/*` seams. Reads `{provider, mode, scope}`; validates fields (`validation_error` 400); for `mode:'subscription'` calls the invariant — tenant/workspace → `credential_scope_forbidden`/403 via the canonical error-envelope middleware, `user` → `200 {bound:true, scope:'user'}`. A **STUB**: it resolves NO credential, stores NOTHING, echoes NO secret material. Non-subscription modes are `validation_error` (the seam is subscription-scope-only for now). The conformance scenario soft-skips on 404, so the route is really wired.
4. **Honest-off `authModes` plumbing (discovery)** — a helper `subscriptionEnabledProviders()` returns the providers with a **configured** subscription mechanism (§B.9/§C), gated behind BOTH an operator opt-in env (`OPENWOP_SUBSCRIPTION_PROVIDERS`, unset by default) AND a lawful-acquisition-mechanism check (`subscriptionAcquisitionConfigured()`, a hard `false` pending UQ1). Discovery emits `aiProviders.authModes` mapping each byok provider to `['apiKey']`, adding `'subscription'` ONLY for a provider in `subscriptionEnabledProviders()` — **never, by default**. §B.7 invariant: `buildProviderAuthModes` force-includes any subscription provider into `aiProviders.byok`. Since the helper is always `[]` today, this is inert but correct (a unit test forces the helper input to exercise it).

## Honest-off posture (the ADR 0121 / selfHosted precedent)

The advertisement stays **DARK** — no provider ever advertises `subscription` — until a lawful acquisition mechanism is configured. This mirrors ADR 0121's RFC 0108 `selfHosted` honest-flip exactly: advertise a capability only when it is actually backed and lawful. The two-gate design (`OPENWOP_SUBSCRIPTION_PROVIDERS` **AND** `subscriptionAcquisitionConfigured()`) makes it impossible for an operator to light up a `subscription` claim by env alone — the mechanism does not exist yet, so `subscriptionAcquisitionConfigured()` is a hard `false`. Under `OPENWOP_REQUIRE_BEHAVIOR=true` this stays honest: nothing advertises `subscription`, so nothing is asserted that isn't backed.

## Explicitly deferred / gated on RFC 0121 UQ1

- The **live `subscription` advertisement** (lighting up `subscriptionEnabledProviders()`).
- Any **credential-acquisition mechanism** (obtaining/using a personal subscription credential).

Both carry the ToS/legal exposure the UQ1 gate protects and are NOT built here. The steward amendment narrowed UQ1 to exactly these acquisition-bearing surfaces; the rail in this ADR is pre-UQ1-safe by construction.

## Deploy-model constraint

openwop-app on Cloud Run is an **ephemeral, multi-instance** deploy with no durable per-user subscription-login story. It is therefore the **scope-safety / reference-implementation witness** for RFC 0121 (§B.7 cross-field consistency + §B.8 bind-seam), **NOT** a full-advertisement witness. RFC 0121's §B.8 gating is deliberately keyed on the SEAM, not on live advertisement, precisely so a host in this posture can prove the safety rail without lawfully advertising the mode. A host with durable per-user login is the natural home for the deferred advertisement + acquisition portion.

## RFC verdict

Rides **Active RFC 0121** (the rail portion). Host-extension only — the seam lives under `/v1/host/sample/*` (non-normative), the discovery `authModes` field is already in the RFC 0121 schema, and `credential_scope_forbidden` is the code the RFC names. **No new RFC required.**

## Implementation (Phase → artifact)

| Piece | Artifact |
|---|---|
| (c) error code | `backend/typescript/src/types.ts` (`credential_scope_forbidden`) |
| (c) pure invariant | `backend/typescript/src/byok/subscriptionCredentialScope.ts` |
| (d) witness seam | `backend/typescript/src/routes/agents.ts` (`credentialsBindSeam`) |
| (a) honest-off helper | `backend/typescript/src/aiProviders/aiProvidersHost.ts` (`subscriptionEnabledProviders`, `buildProviderAuthModes`) |
| (a)+(b) discovery | `backend/typescript/src/routes/discovery.ts` (aiProviders `authModes` + force-included `byok`) |
| tests | `test/rfc0121-subscription-scope-rail.test.ts`, `test/subscription-credential-scope.unit.test.ts` |

## Open questions

- When UQ1 clears: which durable-login host advertises `subscription`, and does `subscriptionAcquisitionConfigured()` become a real per-provider mechanism probe (parallel to `hostAdvertisedSelfHosted()`'s reachable-endpoint check)?
