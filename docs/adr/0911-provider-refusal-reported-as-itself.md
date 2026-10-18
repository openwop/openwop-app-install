# ADR 0911 — A provider refusal in the structured-output retry loop is reported as itself

Status: Accepted (implemented in this PR)

## Context

Book AI upstream proposal P19 (`bookai/docs/upstream-proposals.md`), also seen
in this host's own Campaign Studio live run on Gemini (ADR 0903 checklist,
"an upstream 5xx is reported as `parse-error`").

`dispatchStructured` (`aiProviders/aiProvidersHost.ts`, the RFC 0032/0033 retry
loop behind every `ctx.callAI` with a `responseSchema`) treated any
`dispatchPlain` exception as `parse-error` and retried at once. When the budget
ran out, the node failed `envelope_invalid`: "Provider did not emit valid JSON
matching the response schema after 3 attempts." The provider's own code
(`provider_rate_limited`, `provider_unavailable`, `byok_required_but_unresolved`,
`model_not_supported`) survived only as text in the retry events, and
`classifyDispatchError` mapped `envelope_invalid` to "Something went wrong".
Three effects:

- An overloaded or rate-limited provider read as a model that wrote bad JSON.
- 5xx attempts landed within about a second of each other.
- A 401/403/404/400, which cannot succeed, was retried twice.

The legacy loop (`OPENWOP_ENVELOPE_RELIABILITY_END_TO_END=false`) behaved the
same way.

## Decision

`aiProviders/providerRefusalRetry.ts` classifies the caught error.

- **D1 — fatal refusals are thrown as themselves at once:**
  `byok_required_but_unresolved` (401/403), `model_not_supported` (404),
  `invalid_request` (other 4xx) and `provider_rate_limited` (429). There is no
  retry and no retry event. A 429 is fatal at this layer because
  `providers/dispatch.ts` `fetchWith429Retry` has already retried it for every
  chat provider: 3 attempts, honouring `Retry-After`. A second layer would make
  9 calls to a provider that asked us to stop.
- **D2 — transient refusals are retried after a backoff:** `provider_unavailable`
  (5xx) and `provider_timed_out`.
  - The backoff is `OPENWOP_PROVIDER_RETRY_BACKOFF_MS × 2^(n-1)`: default base
    1000 ms, capped at 8 s, 0 disables.
  - The attempt is recorded with reason `x-host-openwop-app-provider-error`. RFC
    0032 §B.1 admits `x-host-<host>-<key>` reasons beside the closed enum, so
    this is no wire change.
  - Its `previousError` is the code, the HTTP status, the host message and a
    160-character excerpt of the vendor's own text. The excerpt is scrubbed by
    `sanitizeFreeText`, the credential-shape pass, and a Google key / `key=`
    pass. Today that text is lost: `details.upstreamMessage` is never written
    anywhere.
  - The NL-to-format fallback is skipped when the last failure was a refusal.
    Its text would be from an earlier attempt, and the call would hit the same
    refusing provider.
- **D3 — exhaustion names the refusal.** If the loop ends on a transient
  refusal, that `AiProviderError` is thrown, so `run.failed` carries
  `provider_unavailable` / `provider_timed_out`, and the existing classifier
  arms give the "try again" copy. If the last attempt was a parse or schema
  failure, the run still ends `envelope_invalid`, because that is what happened
  last. `envelope.retry.exhausted` is still emitted before the throw.
- **D4 — the legacy loop follows D1–D3** (rethrow fatal, back off on transient,
  throw the last transient refusal).

## Alternatives

- **Retry 429 here too, honouring Retry-After.** This duplicates
  `fetchWith429Retry`, which already does that one layer down for every chat
  provider (Anthropic, OpenAI, Google, MiniMax, compat).
- **A new closed-enum reason `provider-error`.** That is an RFC 0032 change. The
  host-extension form says the same thing today. A spec reason can follow if
  other hosts want it.
- **Put `upstreamMessage` on `node.failed`.** `AiProviderError.message` keeps
  vendor text out on purpose (vendor bodies have echoed credentials). The retry
  event is the diagnostic surface. Its excerpt is scrubbed and capped.

## Consequences

- Book AI's `bookai-provider-errors/1` workaround is no longer needed for new
  runs. `callModel` sees the provider code directly.
- A fork re-executing a pre-ADR run that exhausted on 5xx now fails
  `provider_unavailable` where the source failed `envelope_invalid`. This is the
  intended change; replay of the source's own events is unaffected.
- 5xx retries now take about 1 s and then 2 s, instead of firing immediately.

## Implementation

| Part | Where |
| --- | --- |
| Classification, excerpt, backoff | `backend/typescript/src/aiProviders/providerRefusalRetry.ts` |
| Both loops | `backend/typescript/src/aiProviders/aiProvidersHost.ts` (`dispatchStructured`, `dispatchStructuredLegacy`) |
| Tests | `backend/typescript/test/adr0911-provider-refusal-retry.test.ts`: real dispatch path, `fetch` stubbed |
| Book AI P21 (same PR) | `frontend/react/src/chat/tabDeck/__tests__/TabChatDeck.badgeAnnounce.test.tsx`: dead `Announcer` mock key removed |

## Checklist

- [x] D1–D4 with tests
- [ ] Tell Book AI the PR number, so it can retire `bookai-provider-errors/1`
- [ ] Optional RFC 0032 follow-up: a spec-level `provider-error` reason
