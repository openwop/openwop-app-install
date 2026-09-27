# ADR 0756 — RFC 0121 at-own-risk subscription path: anthropic and google are prohibited

**Status:** implemented — 2026-09-26
**Supersedes (in part):** ADR 0180 (the at-own-risk mechanism, for `anthropic` and `google`) and ADR 0182 (the Claude Code harness of the local subscription shim). Everything else in both ADRs stands.
**Depends on / extends:** ADR 0179 (the §B.8 scope rail), ADR 0180, ADR 0182. Companion: ADR 0757 (GitHub Copilot, the RFC 0121 cleared provider).
**Surface:** host runtime + the local shim. **NON-NORMATIVE — no new RFC** (narrows this host's use of Active RFC 0121; no wire change).

## Why this exists

ADR 0180 un-parked RFC 0121's acquisition surface under an **at-own-risk waiver**: a RISK waiver for an unresolved question (RFC 0121 UQ1: does any provider's consumer-subscription terms permit third-party API-shaped reuse?). On 2026-09-26 the steward's RFC 0121 research re-read the providers' current terms. For two of them the question is no longer unresolved — it is resolved **against** this use:

- **Anthropic** — <https://code.claude.com/docs/en/legal-and-compliance> (fetched 2026-09-26): *"Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."*
- **Google** — <https://geminicli.com/docs/resources/tos-privacy/> (fetched 2026-09-26): directly accessing the services behind Gemini CLI with third-party software using Gemini CLI OAuth *"is a violation of applicable terms and policies."*

A waiver for an open question cannot cover a closed one. The steward (David Tufts) decided on 2026-09-26 to remove both providers from the at-own-risk path. OpenAI's terms are silent rather than prohibitive, so `openai` stays under the existing ADR 0180 waiver, unchanged.

## Decision

No operator flag can advertise, store, or dispatch an `anthropic` or `google` subscription credential.

1. **One source of truth** — `byok/subscriptionCredentialScope.ts` gains `isSubscriptionProhibitedProvider()` (`{anthropic, google}`, with the verbatim citations) and `assertSubscriptionProviderPermitted()` → `403 credential_forbidden`.
2. **Advertisement** — `subscriptionEnabledProviders()` (`aiProviders/aiProvidersHost.ts`) drops prohibited providers from `OPENWOP_SUBSCRIPTION_PROVIDERS` even with `OPENWOP_SUBSCRIPTION_AT_OWN_RISK=true`, so neither the v1 `authModes` map, the v2 `aiProviders` family, nor the `openwop-app.ai-providers` extension can name them. (It also drops ADR 0757's cleared providers: a cleared provider has its own path and must never fall back to paste-and-consent.)
3. **Storage** — the bind seam (`routes/agents.ts`) refuses a **value-bearing** bind for a prohibited provider with `credential_forbidden`, checked **before** the consent gate, so no `acknowledgedRisk` can override it. The **empty-value** §B.8 scope probe (the conformance witness) stays provider-agnostic: it stores nothing, so there is nothing to prohibit, and `tenant`/`workspace` still answer `credential_scope_forbidden`.
4. **Dispatch** — `host/exchange/dispatchTurn.ts` refuses a `subscription:anthropic` / `subscription:google` credentialRef before resolving any secret. This covers a credential bound before this change: it is never used, though it stays at rest in the user's own tenant until the user deletes it.
5. **Local shim (ADR 0182)** — the `/v1/messages` → `claude -p` route, `runClaude`, and the Claude login detection are **removed** (not made unreachable): the route existed only to drive a Claude consumer login, which is exactly what Anthropic prohibits. The backend's file-only detector (`aiProviders/subscriptionCliDetect.ts`) loses its Claude branch too, so `subscriptionLoginDetected('anthropic')` is always `false`. The Codex route and detection are untouched.

## Alternatives weighed

| Option | Verdict |
|---|---|
| Keep both under the waiver with a stronger warning | **Rejected.** The waiver was issued for an unresolved question; shipping a mechanism in a public reference host for a use the provider explicitly prohibits is the R1 harm with the uncertainty removed. |
| Filter at advertisement only | **Rejected.** A direct `POST …/credentials/bind` or a previously stored credential would still reach dispatch. The rail is enforced at all three points. |
| Delete previously stored `subscription:anthropic` secrets | **Deferred to the user.** The host never reads another principal's personal tenant to garbage-collect; the dispatch refusal makes a stale secret inert. |

## Tests

| Test | Pins |
|---|---|
| `test/subscription-credential-at-own-risk.unit.test.ts` | `subscriptionEnabledProviders()` drops anthropic/google and `github.copilot` with both gates on; openai stays |
| `test/rfc0121-subscription-at-own-risk.test.ts` | discovery never advertises anthropic/google with both gates on (openai does); value bind for anthropic/google → 403 `credential_forbidden` even with consent, nothing stored; the empty-value probe still 200 / tenant still 403 |
| `test/subscription-credential-scope.unit.test.ts` | `assertSubscriptionProviderPermitted` refuses anthropic/google (403) and permits openai/github.copilot |
| `test/subscription-cli-detect.unit.test.ts` | a valid Claude login is never detected |
| `clients/subscription-provider` `node --test` | `/v1/messages` → 404; Codex route unchanged |

**Sabotage (run 2026-09-26):** removing the advertisement filter and the bind check turned 4 of these tests red (both unit filters, the discovery test, the bind refusal); restoring them turned all 62 green.

## Out of scope, recorded

- **FIXED 2026-09-26 (follow-up PR):** `dispatchOpenAICompatible` now takes a declared `application/json` response as one complete chat.completion (think-block split, finish_reason, usage incl. cached tokens, refusal — as the stream path does; body capped at 8 MiB, refused not truncated); a missing/unknown content type stays on SSE. Regression: `test/dispatch-openai-compatible-json.test.ts` (5 of 6 fail on the old dispatcher; the SSE control passes both ways). The note below is kept as the record of the defect.
- **The ADR 0182 shim answers plain JSON, but the backend's OpenAI-compatible dispatcher parses SSE only** (`providers/dispatch.ts` `dispatchOpenAICompatible`), so an at-own-risk Codex turn through the shim produces an empty completion. Pre-existing and unrelated to this narrowing; ADR 0757's Copilot sidecar streams SSE from the start. Filed here so it is not lost.
