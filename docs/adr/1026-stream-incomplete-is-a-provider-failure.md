# ADR 1026 — A stream without its terminal signal is a provider failure

Status: Accepted

Source: Book AI upstream proposal P37 item 4 (seam (d)), live qualification
2026-10-28.

## Context

Every chat dispatcher in `backend/typescript/src/providers/dispatch.ts` reads a
server-sent-event stream and builds the reply from its deltas. Each one set
`finishReason` only from a chunk that carried one. After the loop, nothing
checked whether one had arrived. A stream the provider closed early (a cut
connection, a server-side failure mid-stream) therefore came back as a normal
`DispatchResult` holding a fragment. `normalizeFinishReason` maps a missing
reason to `undefined`, so no later layer could tell either.

Book AI measured the effect on 2026-10-28. Under load Google returned 503s, and
every truncated structured Gemini reply ended with no `finishReason`: cut at
133–1,064 output tokens with `maxOutputTokens` 12000. The one complete reply
ended `STOP`. The fragment reached `dispatchStructured` as text, failed
`JSON.parse` ("Unterminated string") and was recorded as a `parse-error`. Its
one repair retry usually failed the same way, and the run ended
`envelope_invalid` ("did not emit valid JSON"), which blames the model for a
provider outage.

## Decision

**A complete stream carries its provider's terminal signal. A stream without
it throws a retryable provider failure instead of returning its text, for every
provider whose protocol guarantees that signal.**

### The provider inventory

| Dispatcher (providers) | Terminal signal on a complete stream | Source | On absence |
|---|---|---|---|
| `dispatchGoogle` (google; managed tiers on google) | `candidates[0].finishReason` on the last chunk | Gemini API reference, `GenerateContentResponse` / `Candidate.finishReason`: "If empty, the model has not stopped generating tokens." Book AI 2026-10-28 measurement above | **Fail**, unless `promptFeedback.blockReason` is set: a blocked prompt has no candidate and ends on the block reason, which the existing refusal path handles |
| `dispatchAnthropic` (anthropic; managed tiers on anthropic) | `message_delta.delta.stop_reason`, then `message_stop` | Anthropic Messages streaming docs: the flow ends with `message_delta` and a final `message_stop`; `stop_reason` is null only in `message_start`. An in-band `event: error` (e.g. `overloaded_error`) can arrive mid-stream, and was silently ignored before this ADR | **Fail** when BOTH are absent. Either alone counts as the end: `dispatch-anthropic-adaptive-thinking`'s stub ends on `message_stop` with no `message_delta`, and a stream that sent `message_stop` was not cut. The in-band error type, when sent, is named in the failure |
| `dispatchOpenAI` (openai) | `choices[0].finish_reason` non-null, then `data: [DONE]` | OpenAI Chat Completions streaming reference (chunk `finish_reason`; the stream ends with `[DONE]`) | **Fail** (gated on `finish_reason`, not `[DONE]`) |
| `dispatchOpenAICompatible` → minimax | same OpenAI chunk shape | MiniMax OpenAI-compatible API docs | **Fail** |
| `dispatchOpenAICompatible` → copilot (loopback sidecar) | the sidecar always writes a `finish_reason` chunk (`stop`, or `error` on a mid-stream failure) and `[DONE]` | `clients/copilot-provider/src/server.js` | **Fail**, and `finish_reason: 'error'` (the sidecar's own report of a mid-stream failure, which used to return the fragment as `other`) fails the same way |
| `dispatchOpenAICompatible` → compat (RFC 0108 self-hosted; subscription at-own-risk) | conforming servers send `finish_reason`, but the endpoint is an operator's black box with no guarantee | RFC 0108 / ADR 0121 | **Warn only** (`compat_stream_ended_without_finish_reason`); the text is returned as before |

Every existing repo fixture for Anthropic and the OpenAI shape already ends with
one of its terminal signals. Some Gemini stubs did not (`dispatch-gemini-fileapi`,
`dispatch-google-thinking` and others). Those are hand-written stubs, not
captures, so they say nothing about the provider, and they were given `STOP`.

Not streamed, so untouched: the tools rounds (`dispatchAnthropicTools`,
`dispatchMiniMaxTools`, `dispatchProviderTools`), `dispatchMock`, and the
non-stream JSON branch of the OpenAI-compatible dispatcher
(`completeOpenAICompatibleJson`). A non-stream response arrives whole or fails
as a whole, so the bug can't happen on those paths.

### The error

`dispatch.ts` cannot import `AiProviderError`, because `aiProvidersHost`
imports `dispatch.ts`. It throws `<provider>_stream_incomplete: stream ended
without a finish reason`, tagged `streamIncomplete: true`, in the same
`Object.assign` idiom as `ProviderHttpError`, and exports
`isStreamIncompleteError`. Each consumer maps it to the code it already uses for
a transient provider outage. No parallel error class is added.

- `aiProvidersHost.mapDispatchErrors`: `AiProviderError('provider_unavailable',
  'Provider stream ended without a finish reason.', { provider, reason:
  'stream_incomplete' })`. Without this it would have fallen to
  `internal_error`, because it has no `_NNN:` status.
- `classifyProviderRefusal` already treats `provider_unavailable` as transient.
  So the structured-output loop retries it after a backoff under the ADR 0911
  `x-host-openwop-app-provider-error` reason. It is never recorded as
  `parse-error`, and on exhaustion the run fails `provider_unavailable`, not
  `envelope_invalid`.
- `conversationToolLoop.isTransientProviderFailure` (the chat single-completion
  and tool-loop retry) accepts the typed form (`reason: 'stream_incomplete'`)
  and the raw form the managed and chat paths propagate. Before this, it
  required an HTTP 5xx status.
- `errorRecovery.classifyDispatchError` classifies the raw form as
  `network` / `retry`. The typed form already was.
- The Copilot dispatcher's transport-error scrub passes it through, since its
  message carries no credential or URL.

### Observability, and why not `provider.usage`

`provider.usage` is a wire event. `schemas/run-event-payloads.schema.json`
`providerUsage` is `additionalProperties: false` and has no finish-reason field,
so naming the reason there would need an OpenWOP RFC. This ADR adds a log line
only: `provider_stream_incomplete` with `{provider, model, chunkCount,
completionLength, outputTokens?, streamError?}`. A failed stream emits no
`provider.usage` at all, exactly like any other thrown dispatch.

### Replay (ADR 1002)

The structured call's final failure is recorded through `failureEnvelopeFor` as
`{kind: 'provider', code: 'provider_unavailable', message}`. A replay
rethrows that code and message without dispatching. `test/adr1026-stream-incomplete.test.ts`
measures this: zero fetches on the replay, with the same code and message as the live run.
A replayed failure carries no `details`, so its `reason` is dropped. That matches
a recorded 5xx today, whose `status` is dropped the same way.

## Alternatives

- **Synthesize a `google_503:` style status.** Every classifier would work
  unchanged, but the error would claim an HTTP status that never happened (the
  response was a 200).
- **Treat a missing reason as `length` and let the RFC 0033 truncation path
  double the budget.** Wrong cause. The budget was not exhausted (133 of
  12000), so doubling it spends more on the same outage, and the run would end
  `envelope_truncation_unrecoverable`.
- **Gate on the end-of-stream marker (`[DONE]`, `message_stop`).** Weaker.
  `finish_reason` / `stop_reason` is what the reply's completeness is reported
  in, and the Gemini stream has no separate marker.
- **Fail compat too.** It would break operator servers that end a complete
  reply bare, which RFC 0108 lets them run at their own risk.

## Consequences

- A caller that streamed deltas to a user (`onDelta`) has shown the fragment
  before the failure arrives. The chat surface then shows the retry or the
  error, instead of a fragment presented as a complete reply.
- A cut stream now costs one retry where the old code returned the fragment.
  The provider billed the fragment's tokens either way.
- A Gemini File-API upload is deleted before the failure is thrown, and the
  retry uploads again.

## Implementation

| Change | Where |
|---|---|
| terminal-signal checks, the error, its guard | `src/providers/dispatch.ts` |
| mapping to `provider_unavailable` | `src/aiProviders/aiProvidersHost.ts` `mapDispatchErrors` |
| chat retry classifier | `src/host/conversationToolLoop.ts` `isTransientProviderFailure` / `providerFailureFields` |
| run-failure classifier | `src/observability/errorRecovery.ts` |
| tests (sabotage-witnessed) | `test/adr1026-stream-incomplete.test.ts` |
