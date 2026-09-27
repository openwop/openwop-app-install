# ADR 0180 — RFC 0121 subscription auth: at-own-risk un-park (acquisition + advertisement)

**Status:** implemented — 2026-07-01
**Depends on / extends:** ADR 0179 (the RFC 0121 subscription-scope safety rail — §B.8 `credential_scope_forbidden`, the user-scope enforcement, the `/v1/host/sample/credentials/bind` witness seam, and the honest-off advertisement plumbing). ADR 0121 (self-hosted / operator-configured OpenAI-compatible endpoint class — the dispatch path reused here). ADR 0024 (BYOK).
**Surface:** host runtime + a gated BYOK frontend surface. **NON-NORMATIVE — no new RFC** (rides Active RFC 0121).

> **Origin.** RFC 0121 (subscription-reuse provider auth) is `Active` in the openwop spec. Its UQ1 (does any provider's consumer-subscription ToS permit third-party API-shaped reuse?) has **no documented clearance**; the steward instead issued an **at-own-risk waiver** (RFC 0121 Status history `f23eb6fe`) — a host MAY implement/advertise the acquisition-bearing surface **at the operator's and end-user's own risk**. This is a **RISK WAIVER, NOT a legal/ToS clearance**; risk **R1** (ToS violation / account suspension) stands and is **operator-accepted**. The operator (David Tufts) explicitly accepted the risk and authorized this un-park **with safeguards** (this ADR is those safeguards). Produced via the openwop-app ↔ openwop crosstalk integration.

> **CORRECTED 2026-09-26 (ADR 0756).** For `anthropic` and `google` the waiver below no longer applies: both providers' current terms explicitly prohibit third-party routing through consumer-plan credentials, so this host refuses to advertise, store or dispatch them regardless of the flags. `openai` stays under this ADR unchanged. GitHub Copilot is a CLEARED provider with its own path (ADR 0757), not an at-own-risk one.

## The honesty constraint (load-bearing — read first)

A genuine "borrowed-session" (RFC 0121 §C shape 1) acquisition against a consumer subscription (Claude Pro/Max, ChatGPT Plus) requires calling the **provider's private web API** — there is no lawful, stable, API-shaped endpoint that accepts a consumer-subscription session token. Shipping a *hardcoded, working* Claude-Pro/ChatGPT integration would therefore mean putting **ToS-circumventing, reverse-engineered, brittle** provider code into a public open-source reference host — the R1 harm expressed in code.

**This ADR does NOT do that.** It ships the **mechanism only**:

- a user-scoped `subscription` **credential kind** (a user-supplied token stored at `scope:"user"`);
- dispatched via the **existing operator-configured endpoint path** (the ADR 0121 compat/base-URL seam) — the operator points it at whatever endpoint *they* accept the risk of;
- advertised **only** when an operator explicitly opts in (off by default).

The host ships **no** provider-private-API code, no scraped endpoints, no session-cookie reverse-engineering. Whether a given token actually works against a given endpoint is the operator's/user's at-own-risk concern. A drift-guard grep asserts no such code exists (see Tests).

## Decision

Un-park the RFC 0121 acquisition + advertisement surface behind **three safeguards**, extending the ADR 0179 rail:

### 1. Off-by-default operator flag (the risk-acceptance switch)
`aiProviders/aiProvidersHost.ts` `subscriptionAcquisitionConfigured()` (the rail's hard-`false`) now returns `process.env.OPENWOP_SUBSCRIPTION_AT_OWN_RISK === 'true'`. `subscriptionEnabledProviders()` returns a provider **iff** the at-own-risk flag is on **AND** the provider is in `OPENWOP_SUBSCRIPTION_PROVIDERS`. **Both unset by default ⇒ the host is DARK** — discovery advertises no `subscription` mode. **The public demo (`app.openwop.dev`) leaves the flag unset**, so it never ships a live `subscription` advertisement. §B.9 honesty preserved (advertise only when configured); §B.7 force-include of an advertised subscription provider into `byok` (from the rail) still holds.

### 2. User-scope, consent-gated credential bind (§B.8 preserved)
`POST /v1/host/sample/credentials/bind` (+ the app-canonical mirror):
- **§B.8 is unconditional and checked FIRST** — a `tenant`/`workspace` scope → `credential_scope_forbidden`/403 **regardless of consent**.
- An **empty** `value` is the **acquisition-free scope-rail probe** (the conformance witness) — resolves no credential, stores nothing, echoes no secret (unchanged from the rail).
- A **supplied** `value` (an at-own-risk acquisition) **REQUIRES `acknowledgedRisk: true`** — absent/false → `validation_error` with a message naming the ToS/account-suspension risk. On consent, the token is stored at **user scope** (the requesting principal's own binding) via `byok/subscriptionCredential.ts`; the response returns only the credential-ref name + scope — **never the secret**.

### 3. Mandatory user-facing risk disclosure (frontend)
The BYOK keys surface (`byok/KeysPage.tsx` + `byok/SubscriptionCredentialCard.tsx`) exposes subscription-credential entry **only** when the host advertises the `subscription` mode (read from `/.well-known/openwop` `authModes` — hidden when the host is dark), and **gates the bind behind an explicit, required acknowledgement** (a `ui/` Notice + a required checkbox: reusing a personal subscription may violate the provider's ToS and risk account suspension). The frontend sends `acknowledgedRisk:true` only after the user checks it; the server re-enforces it (defense in depth). 4-locale i18n.

## RFC verdict
**Host-extension — rides Active RFC 0121; no new RFC.** The advertisement value (`aiProviders.authModes:"subscription"`) is RFC 0121's wire vocabulary (already `Active`); everything else (the flag, the user-scope storage, the consent gate, the disclosure UI) is host-internal. The advertisement is honest (§B.9: emitted only when configured). No wire field/event/capability/endpoint/MUST is added beyond RFC 0121.

## Risk posture (explicit)
- **R1 (ToS violation / account suspension) is REAL and operator-accepted** — the waiver is not a clearance. The safeguards (off-by-default, mandatory disclosure, user-scope-only) bound but do not eliminate it.
- **Public demo stays dark** (flag unset) — no ToS-violating advertisement ships by default.
- **§B.8 user-scope-only MUST** is unconditional (a personal single-seat credential can never bind tenant/workspace-shared).
- **Mechanism-only** — the host ships no provider-private-API integration; the operator supplies the endpoint and owns that risk.

## Alternatives weighed
1. **Ship a hardcoded Claude-Pro/ChatGPT integration.** Rejected — reverse-engineering a provider's private API in a public reference host is the R1 harm in code, is untestable, and is brittle. The mechanism-only shape delivers the capability without it.
2. **Refuse to un-park (stay at the rail).** The architect's recommendation; overridden by the operator's explicit, informed at-own-risk decision. This ADR is the safe implementation of that decision.
3. **Advertise on the public demo by default.** Rejected — a dishonest/ToS-violating advert; the off-by-default flag keeps the demo dark.

## Open questions
1. **OQ-1 — Session-token lifecycle.** A consumer session token rotates/expires; the host stores it as an opaque user-scoped secret and surfaces re-entry on failure (reuses the existing BYOK `credential_unavailable` path). No refresh mechanism is shipped (would be provider-specific).
2. **OQ-2 — Graduation.** With the waiver, an at-own-risk advertising host *could* become a full RFC 0121 witness, but openwop-app's public demo stays dark, so it remains the **scope-safety / reference-impl** witness (ADR 0179), not a full-advertisement witness. Recorded 0106-style in INTEROP-MATRIX. 0121 stays `Active`.

## Tests
- Backend: discovery advertises `subscription` (+ §B.7 byok force-include) only with `OPENWOP_SUBSCRIPTION_AT_OWN_RISK=true` + the provider listed; **dark by default**. Bind seam: user-scope without `acknowledgedRisk` → rejected; with consent → stored at user scope (no secret echoed); tenant/workspace → `credential_scope_forbidden` regardless of consent. A **drift-guard** asserts no provider-private-API/reverse-engineering code.
- Frontend: the disclosure gate blocks the bind until acknowledged; the subscription entry is hidden when the capability isn't advertised.
