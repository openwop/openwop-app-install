# ADR 0929 — RFC 0245 host witness: a recorded tool error replays as an error

Status: implemented (#4989 `05048832b`, train 154, 2026-10-19; cut 154c matched the prediction; RFC 0245 `Accepted`)

## Context

RFC 0244 §D fixtures had no way to record a FAILED call. This host's response
was the AEV-6 stopgap: promotion refused a run whose captured calls included an
error, rather than let a replay serve the failure as a success. RFC 0245 adds
`fixtures.toolResponses[].isError` and the capability member
`agents.evalSuite.fixtureErrors`.

**Can this host advertise it? The CLAUDE.md three-part test:**

1. **The wire shape is locked.** RFC 0245 is `Active`. Both wire items, the
   suite field and the capability member, are ticked in its acceptance criteria
   and shipped in suite 2.46.12. This host already vendors both:
   `schemas/v2/agent-eval-suite.schema.json` and
   `schemas/v2/capabilities.schema.json:3336`.
2. **The RFC does not gate advertisement.** It has no hold. `Accepted` waits on a
   host advertising `fixtureErrors` and passing `0245.fixture-error-replayed`.
3. **The host honours the behaviour:** §B and §C, below.

## Decision

### D1 — Serve an `isError` entry as a tool error (§B)

The fixture interceptor (`agentEvalRun.ts` `fixtureInterceptor`) matches and
consumes an `isError` entry like any other entry (RFC 0244 §D, first unconsumed
match). It then returns `{ content, isError: true, errorCode }`, where
`errorCode` is `deriveToolErrorCode` (`host/toolHooks.ts`), the same derivation
the live lane uses for a failing tool. Concretely:

- **Not a miss.** The `misses` counter is untouched.
- **Never live.** The interceptor returns before `inner`, so the entry never
  reaches a live tool, whatever `onMiss` says.
- **Live-agent lane:** `agentDispatch` already records an `isError` result as
  `agent.tool-returned` with `status: "error"`, `error {code, message}` and no
  `outcome`.
- **Scripted lane** (the conformance agent): records `error { code, message:
  'tool error (recorded fixture)' }`, `status: "error"` and no `outcome`. The
  message is fixed, so the payload is never echoed (§D SHOULD).

For the conformance fixture, the response is MCP-shaped with no top-level
`code` or `error`, so the code is `tool_execution_failed`. RFC 0245 UQ 1 notes
that no registered code exists; the leg asserts only that `code` is non-empty.

### D2 — ~~A successful scripted return carries a content-free `outcome`~~ REJECTED

> **REJECTED 2026-10-18 (ec, relayed by 67), before it shipped.** ec's reasoning:
> RFC 0245 owns only one thing. The `isError` entry is recorded as an error
> (`error`, no `outcome`, `status: "error"` under hooks), and the success entry
> is not. Requiring `outcome` on the success was the judge overreaching the core
> schema, where `outcome` is optional (RFC 0064 §F). A placeholder `outcome`
> invented for a judge is the wrong fix. ec's side: suite **2.46.18** relaxes the
> success leg (the second return has no `error`, and `status` is not `"error"`),
> plus an RFC 0245 erratum. This host keeps its successes exactly as they were,
> with no `outcome`, and the test asserts that. The pin is **2.46.18**: under
> 2.46.17 this build reds the success leg. The original proposal is kept below
> for the reasoning trail.

The conformance judge's success leg (`lib/eval-fixture-error-witness.ts`) needs
the return after the error to carry `outcome`. This host never set `outcome` on
a tool return (WFAU-4: results reach the model, not the wire; RFC 0064 §F
permits that). It does not invent one here either.

On a scripted-lane success it now sets `outcome: { contentOmitted: true }`.
That is a real, truthful result object: the call succeeded, and its content is
withheld, because suite content never reaches the wire (RFC 0244 §H, extended to
`response` by RFC 0245 §D). The fixture's response is **not** copied into
`outcome`, and the end-to-end test asserts that (no argument value, no payload
text). The live-agent lane is unchanged. Its success returns still omit
`outcome`, which is spec-legal and not exercised by any RFC 0245 leg.

### D3 — Advertise only with the schema (§C)

`evalSuiteCapability()` adds `fixtureErrors: true` only when
`rfc0245WireAvailable()`, meaning the vendored suite schema carries `isError`
and the capabilities schema carries `fixtureErrors`. That is the ADR 0889 D7
rule: the v2 `agents` record is closed, so an early advert would red this host's
own certified cut.

Run create (`createEvalRun.ts`) refuses an `isError` suite on a host that does
not advertise it with `400 validation_error`, naming the first
`tasks[i].fixtures.toolResponses[j].isError`. Suite validation (`suiteStore.ts`)
accepts `isError` only as a boolean.

### D4 — Promotion keeps a failure a failure (the optional item)

`buildTaskFromRun` writes `isError: true` for an errored boundary row. The
promote route lifts the AEV-6 refusal only when `fixtureErrors` is advertised.
Without the advert, it still refuses with `reason: errored_call`.

### D5 — The suite pin, and the fixture

The fixture `conformance-eval-fixture-error` is loaded from the vendored
`conformance-fixtures/eval-suites/`, under the ADR 0898 opt-in like the other
five. It becomes listed when suite **2.46.18** is pinned (not 2.46.17, which still requires `outcome` on the success; see D2) and
synced. Until then the test inlines ec's fixture. Vendoring it ahead of the pin
would red the vendored-fixture parity gate.

The pin is a lockfile change, so it goes under `npx -y npm@10.9.8` and must
keep `@azure/core-rest-pipeline` (the KMS preflight test is the tripwire).

## ec's pre-registered prediction (against the canonical cut)

- `0245.fixture-error-shape`: → `executed-pass`
- `0245.fixture-error-replayed`: → `executed-pass`
- `0245.unadvertised-refused`: → `inapplicable` (this host advertises the member)
- every other row unchanged

The requested sabotage, serving the error as a success with `outcome`, must red
the replay leg.

## Implementation

| Phase | Change | Witness |
|---|---|---|
| P1 | D1–D4 | `test/rfc0245-fixture-errors.test.ts` (§A validation; §B boundary: typed error, no miss, no live retry; §C advert + listing + refusal naming the field; the replay leg end to end, judged as the conformance judge does; promotion), `test/adr0889-store-integrity.test.ts` (both sides of the promote rule) |
| P2 | D5: pin 2.46.18, sync fixtures, KMS check | `vendored-fixture-parity-gate`, the m2 lane, the cut: **154c** on `3566445be`, bundle `333b89473c89`, served == bucket, 842 rows 459/0/11/372 |

## Open questions

- [x] P2 pin **2.46.18**: in #4989. Lockfile added 0 / removed 0, `@azure/core-rest-pipeline` intact, `kms-backend-preflight` green.
- [x] The cut matching ec's prediction. **154c** (`3566445be`, suite 2.46.18,
  bundle `333b89473c89`, served == bucket): 459/0/11/372, exactly the three
  predicted RFC 0245 rows more than 151c and 141c, and no other row changed.
  ec took the evidence, and RFC 0245 is `Accepted` in openwop.
- [ ] RFC 0245 UQ 1: a registered tool-failure code would replace
  `tool_execution_failed`.
