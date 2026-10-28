# ADR 0912 — Native structured output, a corrective retry, jsonrepair, and an excerpt of an unparsable reply

Status: Accepted (implemented in this PR)

## Context

This ADR implements Book AI upstream proposals P22 and P7 item 1, from
`bookai/docs/upstream-proposals.md`.

`dispatchStructured` (`aiProviders/aiProvidersHost.ts`) asked for JSON by prompt
alone. It appended "Respond with a JSON object that matches this schema …" and
parsed the reply. `providers/dispatch.ts` sent no native JSON mode to any
vendor. Its own comment said: "Real production hosts use provider-native
structured output … Sample-grade: prompt nudge + retry."

When a reply did not parse:

- `tryLenientParse` tried a ```json fence and a brace walker, but nothing
  handled an unescaped `"` inside a string. `RecoveryPath` already names
  `jsonrepair`; no path implemented it.
- The loop resent the identical request, so a model that slipped once tended to
  slip the same way again.
- The reply was kept nowhere. The retry events said only "JSON.parse failed +
  lenient recovery paths exhausted".

Book AI's live run on `gemini-3.8-flash` (2026-10-18) failed its canon pass on
dialogue-heavy text this way: three short unparsable replies per run, and no
record of what the model wrote.

## Decision

- **D1 — Native JSON where the vendor has it** (`DispatchRequest.jsonSchema`, set
  by `dispatchPlain` whenever the call carries a `responseSchema`):
  - **Google:** `generationConfig.responseMimeType: 'application/json'`, plus
    `responseSchema` as projected by the existing `providers/geminiSchema.ts`
    converter when the projection has no violations. A schema it cannot express
    faithfully (a free-form member, for example) gets JSON mode with no schema.
    A web-search turn gets neither, because grounding tools and controlled
    generation do not combine.
    - An `INVALID_ARGUMENT` 400 drops the schema on the same thinking rung,
      before the ADR 0706 thinking ladder advances. Otherwise a schema 400 would
      walk every rung and memoise the wrong one.
  - **OpenAI:** `response_format: {type: 'json_schema', json_schema: {name, schema,
    strict: false}}` for an object root. On a 400 that names the format, it falls
    back to `json_object`, then to none.
  - **Anthropic, MiniMax, compat, Copilot:** unchanged (prompt hint). Anthropic's
    tool-use form needs a different response parse; it is a follow-up.
    > **IMPLEMENTED 2026-10-19 (Anthropic arm, user decision "proceed with your
    > recommendations").** A structured call to Claude forces ONE tool call,
    > `respond`, whose `input_schema` is the response schema
    > (`tool_choice: {type:'tool', name:'respond'}`). The streamed
    > `input_json_delta` chunks are the reply, so `structuredMode` reports `tool`.
    > Anthropic refuses a forced `tool_choice` while thinking is on. Adaptive-only
    > models (Opus 5.5, Fable 5.1) always think, so those calls, and any call with
    > thinking enabled, keep the prompt hint. A 400 that names
    > `tool_choice`/`tools`/`input_schema` falls back to the prompt hint once. A
    > forced-tool `tool_use` stop is reported as `end_turn`, the expected clean
    > end. A `max_tokens` stop still routes to truncation. Tests:
    > `test/adr0912-anthropic-native-structured-output.test.ts`.
  - `DispatchResult.structuredMode` records which mode answered (logged at
    debug). It is not added to the `ctx.callAI` result: that is spec surface (P7
    items 2–3 need an RFC, see below).
  - The prompt hint is still sent in every mode, and the caller still validates
    every reply. Native mode makes a valid reply likelier; it is never the check.
- **D2 — A corrective fragment on retry** (RFC 0033 §C):
  - After a parse failure, the next attempt's system prompt names the engine's
    parse error and says how to write a quote and a line break inside a JSON
    string.
  - After a schema violation, it names the missing required keys.
  - Truncation retries still carry no fragment (RFC 0033 §B).
- **D3 — `jsonrepair` recovery** (`envelopeReliabilityEmit.ts`
  `repairJsonStrings`):
  - Inside a string value it escapes a `"` that is not followed by `,` `}` `]`
    `:` or the end, and it escapes raw newlines and tabs.
  - The repair is used only when the result then parses, and the caller still
    schema-validates it. It emits `envelope.recovery.applied` with `path:
    'jsonrepair'` (an existing enum value) and costs no retry (RFC 0033 §D).
- **D4 — A bounded excerpt of the reply:**
  - On a parse failure, the retry event's `previousError` / `finalError` carries
    the parse error, the reply length, and its first 200 characters.
  - Before the excerpt reaches the event log, it is scrubbed with
    `sanitizeFreeText` and the run-secret and credential-shape pass.
  - A schema violation names the missing keys.

## Not in this ADR (needs an RFC first)

P7 items 2–3 would change spec surface:

- returning the attempt count and total output tokens with each `ctx.callAI`
  result;
- a per-call opt-out of host retries, or a cap on `maxTokens` growth.

Both change the `ctx.callAI` contract or the envelope events, so they need an
openwop RFC before this host implements them. `provider.usage` is already
emitted once per provider attempt (RFC 0026 §B). A node can count real calls
from that today.

## Alternatives

- **A JSON-repair library.** It is a new dependency for one failure class. The
  scan is 30 lines, and its only failure mode is "still unparsable".
- **`strict: true` for OpenAI.** It needs `additionalProperties: false` and every
  property required throughout the schema. Most pack schemas are not written
  that way, so strict mode would reject them.

## Consequences

- Gemini and OpenAI structured calls get vendor-enforced JSON. The prompt-only
  failure classes (prose preamble, a fence, a missing brace) mostly disappear.
- A request that names a schema a vendor rejects costs one extra round trip; the
  fallback is logged.
- An unparsable reply can now be diagnosed from the run record.

## Implementation

| Part | Where |
| --- | --- |
| D1 dispatch | `backend/typescript/src/providers/dispatch.ts` (`jsonSchema`, `structuredMode`, Google + OpenAI) |
| D1 wiring, D2, D4 | `backend/typescript/src/aiProviders/aiProvidersHost.ts` (`dispatchPlain`, `dispatchStructured`) |
| D3 | `backend/typescript/src/host/envelopeReliabilityEmit.ts` (`repairJsonStrings`, `tryLenientParse`) |
| Tests | `backend/typescript/test/adr0912-native-structured-output.test.ts` |

## Checklist

- [x] D1–D4 with tests
- [x] Anthropic native structured output: a forced single tool call (2026-10-19)
- [ ] RFC for P7 items 2–3 (attempts and tokens on the call result; per-call retry opt-out)
- [ ] Tell Book AI the PR number

Recovery correction (2026-10-21): forced `respond` calls disable parallel tool
use explicitly. The stream parser also binds input deltas to the one declared
`respond` block and refuses multiple or unmatched tool blocks, so a provider
contract violation cannot concatenate separate valid objects into one reply.
Deterministic stream witnesses cover both violations; execution and the canonical
gate are pending the serialized release slot.
