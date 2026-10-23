# ADR 0966 — `ctx.callAI` reports its provider attempts and honours a per-call retry policy (RFC 0248, host)

Status: implemented (certified in cut 169c on f17ee3753, 2026-10-23)

## Context

RFC 0248 is `Active` (openwop `d49a2818`, 2026-10-22). This is the host half,
split with the corpus steward `openwop-ec` the same day. ec owns:
- the `aiProviders.callAccounting` facet member;
- the normative text;
- the `callai-attempt-accounting` scenario and the fixture workflow
  `conformance-callai-attempt-accounting`;
- suite 2.46.19.

The request it answers is Book AI upstream proposal P7, items 2–3. A node's call
budget and its run estimate count `ctx.callAI` calls. But one call can make
several provider requests: RFC 0032 retries, an RFC 0033 truncation retry with a
doubled `maxTokens`, and an NL-to-JSON fallback. The result's `usage` describes
only one of them.

## Decision

- **D1 — count where the request is sent.** A per-call `AttemptMeter` is created
  in `callAI` and threaded into `dispatchPlain`, the one function every
  structured loop, the legacy loop and the NL fallback send through.
  - It counts one attempt per provider request (§A.1).
  - It sums the output tokens each response reported. A failed request, or one
    without usage, sets `usageComplete: false` (§A.2).
  - It keeps the last attempt's `structuredMode`, which maps to
    `structuredOutput` (§A.3). A provider-enforced schema (`schema`,
    `json_schema`, a forced `tool`) is `native`. A prompt-embedded schema is
    `prompt`, and so are JSON-mode-only answers (`mime`, `json_object`).
- **D2 — the record rides the cached result.** `attempts` is attached before the
  invocation-log write, so a replay or a retry-stable read returns the recorded
  value and never recomputes it (§A.5). A record written before this change has
  no `attempts`. `usage` is unchanged (§A.4).
- **D3 — the policy only narrows.** `parseRetryPolicy` validates `retry` at the
  top of `callAI`, before the cache read or any request.
  - The end-to-end loop runs `min(host budget, maxAttempts)` attempts, and so
    does the legacy loop. The NL fallback runs only while the cap has room
    (§B.1).
  - `growMaxTokens: false` keeps the truncation budget at the request's value
    (§B.2).
  - A non-object, a bad `maxAttempts` (not an integer in 1..16), a non-boolean
    `growMaxTokens`, or an unknown key fails `validation_error` with
    `details.field` (§B.5).
  - The executor surfaces `details` on `node.failed` for that one code only, so
    no other failure event changes shape.
- **D4 — the fixture node.** `conformance.callai.echo-attempts` is registered
  among the conformance nodes, so the structural advert rule offers ec's fixture
  as soon as it is vendored.
  - It turns `config.script` into this node's mock program:
    - `invalid-json` is a reply starting with `{`, so it is a parse error that
      cannot trigger the NL fallback;
    - `truncated` stops at `max_tokens`;
    - `valid` is built from the schema, because a truncation retry drops the
      prompt's schema hint.
  - It makes one `ctx.callAI` and outputs `{ attempts }` verbatim.
  - The mock gained three opt-in fields: `noUsage`, `structuredMode`, and
    `clampOutputToMaxTokens`, which reports `min(scripted, this request's
    maxTokens)`. Every existing program is unchanged.

## Not done here

- **The advert.** `aiProviders.callAccounting` is not served until suite
  2.46.19 is published and pinned, because the facet member does not exist in
  the pinned schemas yet. That follows as its own PR: pin bump, advert, cut.
- **`ctx.callAIWithTools` and the managed (non-BYOK) chat path.** The tools loop
  is the pack's own, which is outside RFC 0248 (RFC UQ2). The managed path
  serves ad-hoc chat, not workflow nodes. Neither carries `attempts`.
- **A no-usage attempt emits no `provider.usage`.** That behaviour predates this
  change: `emitProviderUsage` has no counts to report, and inventing zeros would
  misstate them. The corpus legs count by `provider.usage`, so they must not
  depend on a `usage: false` attempt; ec has been told.

## Implementation

| Part | Where |
| --- | --- |
| D1–D3 | `backend/typescript/src/aiProviders/aiProvidersHost.ts` (`AttemptMeter`, `parseRetryPolicy`, `dispatchPlain`, both structured loops, `callAI`); `src/executor/types.ts` (`AiCallRequest.retry`, `AiCallAttempts`); `src/executor/executor.ts` (`details` for `validation_error`) |
| D4 | `src/bootstrap/nodes.ts` (`conformance.callai.echo-attempts`); `src/providers/dispatchMock.ts` |
| Tests | `backend/typescript/test/adr0966-callai-attempt-accounting.test.ts` (8 cases, route-level through the real executor) |

Each mechanism was checked by sabotage:

| Sabotage | Result |
| --- | --- |
| No count | 4 red |
| No cap | 1 red |
| `growMaxTokens` ignored | 1 red |
| No validation | 3 red |
| `attempts` not recorded | 4 red |

The 283 test files that touch the changed modules pass.

## Checklist

- [x] D1–D4 with tests
- [x] Suite 2.46.19 (ec): pin, vendor the fixture, serve `aiProviders.callAccounting` (see the correction below)
- [x] The cut (`0248.*` rows per ec's prediction). **165c (2404797bf) recorded all nine rows inapplicable:** the fixture node was gated off in production. See [ADR 0967](0967-callai-fixture-opt-in.md), which also fixes the replay defect below. **169c (f17ee3753) certified all nine:** see ADR 0967 § Outcome.
- [x] Tell Book AI the fields are live once advertised (told "deployed and advertised" after 2404797bf, then "certified" after 169c)

## Correction (2026-10-22, the 2.46.19 pin)

**D4's node read the wrong place.** It took the request's fields and `script`
from `config`, which is where this ADR's own tests put them. The published
fixture `conformance-callai-attempt-accounting` instead passes `request` and
`script` as **run inputs** (`POST /runs {inputs: {request, script}}`, its
declared variables), and its node has an empty `config`. Under the suite every
case would have run an empty script with no schema and reported `count: 1`, so
every `0248.*` leg except the malformed one would have failed. The node now reads
the variable bag, then `ctx.inputs`, then `config`. A test runs the vendored
fixture exactly as the suite does; making the node ignore run inputs reds it
(`count: 1` vs `2`).

**Known tensions ec raised against the published suite:**
- **`usage: false` emits no `provider.usage`** (see "Not done here"). The legs
  do not count that run, so it does not fail, but it stands against events.md's
  "exactly one `provider.usage` per provider invocation". It is a known tension,
  not a pass.
- **A replay fork re-dispatches the mock live** when a scripted program is still
  pending, where replay.md says a replay reuses recorded facts. The values match,
  so `attempts-replayed` passes, but it is a host defect. It is tracked here
  until it is fixed: the replay path must serve the recorded `ctx.callAI` result
  without reaching the provider.
