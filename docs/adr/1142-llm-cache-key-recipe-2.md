# ADR 1142 — LLM cache key recipe 2 (`openwop-llm-key-2`) on the effect ledger (RFC 0260)

Status: Accepted (P1 implemented behind the default-off flag `OPENWOP_LLM_CACHE_KEY_RECIPE_2`; P2 waits on the suite 2.49.6 pin, openwop-app#6045)

## Context

`spec/v2/core/replay.md` makes RFC 0041's content-addressed key the cache key
for an LLM-calling node. That recipe hashes model, provider, messages, tools,
temperature and responseSchema. Two calls that differ only in `maxTokens`,
`stop` or `seed` share a key, so a replay can serve a result recorded for a
different request.

RFC 0260 (openwop, `Active`, suite 2.47.0+) defines recipe 2. Its rules:

- The key is the hex SHA-256 of the RFC 8785 (JCS) serialization of
  `{recipe, model, provider, messages, tools, toolChoice, responseSchema, params}`.
- `params` names eight sampling parameters. One the host does not SEND is
  `null`; any other sent parameter goes under `params.extra`.
- A host opts in by advertising `replay.llmCacheKeyRecipe: "openwop-llm-key-2"`
  and records `cacheKey: {recipe, digest}` on the effect record of every LLM
  provider call (`GET /runs/{runId}/effects`).

The user asked openwop-app to implement it on 2026-11-16 ("ask openwop-app to
implement them"), so it can go `Accepted`. The suite's scenario is
`v2-replay-llm-cache-key`. Its fixture `conformance-llm-cache-key` is already in
`conformance-fixtures/`; its node is not registered, so the fixture is withheld.

Two facts about this host shape the decision:

1. **No provider adapter sends `temperature` or `stop`.** `dispatchPlain` passes
   `maxTokens` and `jsonSchema` to `dispatchChat`, and nothing else. RFC 0150's
   digest hashes `temperature` (the requested value), but no provider ever
   receives it. Recipe 2 hashes what is SENT, so a key that named
   `temperature: 0` for an Anthropic call would be false.
2. **The fixture pins provider `conformance-mock` and model `conformance-mock-1`.**
   The host's mock provider id is `mock`. The suite recomputes the key over the
   fixture's ids (`0260.key-portable`), so the preimage must carry the ids the
   fixture names.

## Decision

- **D1 — the flag.** `OPENWOP_LLM_CACHE_KEY_RECIPE_2` (`true` or `1`) turns
  recipe 2 on. It is read on every call, like `OPENWOP_INTERRUPT_RESOLVED_VIA`.
  Off, nothing changes: no facet, no ledger field, no new code path.
- **D2 — discovery.** With the flag on, the `replay` family record carries
  `llmCacheKeyRecipe: "openwop-llm-key-2"`. `idempotency` is already advertised
  unconditionally, so §A.3 holds.
- **D3 — the key is computed from the request the adapter actually receives.**
  `providers/llmCacheKey2.ts` builds the preimage from the `DispatchRequest`,
  not from `AiCallRequest`. Each provider declares the parameters it forwards,
  in `SENT_PARAMS`:
  - `anthropic`, `openai`, `google`, `minimax` and `compat` forward `maxTokens`
    only, which is the truth today.
  - The conformance mock forwards `maxTokens`, `temperature` and `stop`.

  A parameter outside the provider's set hashes `null`, as §B.1 requires for an
  unsent parameter. When an adapter starts sending one, its set grows in the
  same change. That is the one place the claim lives.
- **D4 — `temperature` and `stop` reach the mock.** `DispatchRequest` gains
  optional `temperature` and `stopSequences`. `dispatchPlain` passes them only
  when the provider's `SENT_PARAMS` includes them, so real providers receive
  exactly what they received before.
- **D5 — the conformance mock's id.** `conformance-mock` routes to the existing
  `mock` dispatcher, behind the same gate as `mock`
  (`mockProviderEnabled()`, refused in the `auth` posture by LEAK-4). It is
  added to `SUPPORTED_PROVIDERS` next to `mock`. Its only model is
  `conformance-mock-1`.
- **D6 — the fixture node.** `conformance.callai.cache-key` registers under the
  RFC 0248 fixture switch (`callAiFixtureEnabled()`, ADR 0967), and only while
  the flag is on. It makes exactly one `ctx.callAI` call:
  `{provider: 'conformance-mock', model: 'conformance-mock-1',
  messages: [{role: 'user', content: request.prompt}]}` plus the named
  parameters in `request.params`, mapped `stop` → `stopSequences`. It outputs
  `{text}`. A parameter this host cannot send (`seed`, `topP`, `topK`, the
  penalties) fails the node `validation_error` and is not silently dropped. The
  fixture's advertisement follows the node: `listLoadedConformanceFixtures`
  lists a fixture only when its node resolves.
- **D7 — the record.** `invocation_log` gains a nullable `llm_cache_key TEXT`
  column (sqlite mig 54, postgres mig 52). It holds `"<recipe>:<digest>"`.
  - `putInvocation` takes it in `opts`, and keeps the stored value when an
    update carries none (the `presented_key` COALESCE).
  - Every write of an LLM provider call carries it while the flag is on:
    success, failure, and the replay copy. This covers the BYOK `callAI` path
    and the ADR 1002 replay lane (managed `callAI`, and the BYOK and managed
    tools rounds). For a tools round, the tool definitions are computed once
    (`sentToolsFor`, after the ADR 0148 diet), so the dispatch and the key see
    the same array.
  - `listRunEffects` reads it, and `GET /runs/{runId}/effects` projects it as
    `cacheKey: {recipe, digest}`. The record holds no preimage (§C.2).
- **D8 — replay and fork (§C.3).**
  - The fork's copy-on-read of a source record copies the source's stored
    `llm_cache_key` verbatim and does not recompute it.
  - A source record that carries a recipe-2 key is served to a replay only
    when the replay's recomputed key equals it. On a mismatch the replay
    dispatches live.
  - A source record with no key was recorded under RFC 0041's recipe and keeps
    today's matching.
- **D9 — sabotage switches.** Under `OPENWOP_TEST_SEAM_ENABLED` only,
  `OPENWOP_SABOTAGE_LLM_KEY` takes one value. Each one makes exactly one RFC 0260
  leg go red (RFC 0263 §C):
  - `omit`: no `cacheKey` → `key-recorded`;
  - `drop-max-tokens`: `maxTokens` hashed as `null` → `params-in-key`;
  - `nonce`: a per-call nonce in the preimage → `key-stable`;
  - `model`: a different model id in the preimage → `key-portable`.

## Alternatives

- **Hash `AiCallRequest` (what the caller asked for).** Rejected: it would name
  `temperature` for providers that never receive it, which is the false claim
  §B.1 exists to stop.
- **Start sending `temperature` and `stop` to every provider.** It is a real gap
  (the parameters are accepted and ignored), but it changes sampling for every
  production call. It is a separate decision, and D3 makes it a one-line change
  per provider when it is taken.
- **Store the key inside the `result` JSON.** That would give a verbatim fork
  copy for free, but `result` is served back to the node as the call result and
  the projection deliberately never reads it. A column keeps the record
  content-free.

## Phases

| Phase | What | Commit / test |
| --- | --- | --- |
| P1 | D1–D9 behind the flag. Tests: `test/adr1142-llm-cache-key-recipe-2.test.ts` (both RFC known-answer digests, per-provider sent sets, the four sabotage switches) and `test/adr1142-llm-cache-key-fixture.test.ts` (discovery, the fixture end to end through `GET /runs/{id}/effects`, a replay fork carrying the key verbatim; dropping that copy turns it red) | this PR |
| P2 | Suite pin 2.49.6 (separate PR); production flag on after deploy; certified cut; RFC 0260 `Accepted` upstream | — |

## Open questions

- **`params.extra`.** No adapter sends an unnamed sampling parameter today, so
  `extra` is always omitted. RFC 0260 records the mapping as claims-check; it is
  stated in `conformance.md`.
