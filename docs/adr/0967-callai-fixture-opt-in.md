# ADR 0967 — The RFC 0248 fixture node on its own operator opt-in

Status: implemented (user decision 2026-10-22 ~20:46Z, relayed by the release manager; certified in cut 169c)

Follows [ADR 0966](0966-callai-attempt-accounting-and-retry-policy.md).

## Context

ADR 0966 shipped RFC 0248 (`ctx.callAI` attempt accounting and the per-call
retry policy) and #5142 advertised `aiProviders.callAccounting {attempts: true,
retryPolicy: true}`. Production's first major-2 cut on that build (165c, commit
`2404797bf`, bundle `…/2404797bf…/major-2.json`) recorded all nine RFC 0248 rows
**inapplicable**: `openwop.scenario.v2-callai-attempt-accounting` and the eight
`openwop.requirement.0248.*` rows. The detail was "the host does not advertise
fixture conformance-callai-attempt-accounting".

The behaviour is live for every pack. Only its witness was withheld, by two gates:

1. **Registration.** `conformance.callai.echo-attempts` was registered inside
   `registerConformanceNodes()` (`bootstrap/nodes.ts`), which runs only under
   `conformanceNodesEnabled()`. Production leaves that off on purpose (LEAK-8),
   so the node did not resolve and the fixture was withheld.
2. **The advert predicate.** `fixtureNeedsConformanceNodes()` (`host/index.ts`)
   treats every `conformance.*` and `core.conformance.*` type id as needing the
   conformance posture, except the two probes that have their own switches. This
   second gate was found only by running the m2 lane with conformance nodes OFF
   (below). Fixing the first gate alone would have shipped a second inapplicable
   cut.

The local m2 lane that cleared #5142 ran with conformance nodes ON, so it could
not see either gate. That is the variable the proof below now holds.

## Decision

### D1 — The switch

`OPENWOP_CONFORMANCE_CALLAI_FIXTURE=true` (case-insensitive) registers the node
without the conformance posture. **Off by default.** It is read once at
registration (`bootstrap/conformanceCallAiFixture.ts`, `callAiFixtureEnabled()`),
like the other conformance switches; a change needs a new boot.

- The conformance posture still registers it, as before.
- **The `auth` (enterprise) posture ignores the opt-in**, with a
  `callai_fixture_opt_in_ignored` boot warning. LEAK-4 already refuses
  `provider:'mock'` there, and LEAK-8 fails the conformance posture closed there
  for the same reason.
- `fixtureNeedsConformanceNodes()` exempts the node, on the same footing as the
  storage probe (ADR 0858) and the table-schema probe (ADR 0909). Whether the
  fixture is advertised is then decided by whether its node resolves.

Precedents already on in production: `OPENWOP_CONFORMANCE_EVAL_FIXTURES`
(ADR 0898) and `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES`.

### D2 — Why LEAK-3 does not forbid it

LEAK-3 (ADR 0195) keeps `local.sample.demo.mock-ai` unregistered in the `auth`
posture so that a real tenant never receives fabricated LLM output presented as
AI ("Mock response to: …"). This node is outside that harm:

- It returns only `outputs.attempts` (counts and token sums), never model text.
  Nothing it produces reaches chat, an agent, a document or another node as prose.
- Every reply it consumes was written by the same caller, in the same run's
  inputs. It invents nothing the caller did not supply.
- It hard-codes `provider: 'mock'`. It cannot reach a real provider, a credential
  or spend.
- It is not an agent, so it cannot be offered in chat, channels, voice or the
  widget.
- It sits in the conformance-reserved namespace.

**The honest residual:** a tenant could put the node in its own workflow, and
the builder's node catalog lists every registered type id, as it already does for
the storage probe. Its output is harmless; it is visible. Hiding conformance ids
from the palette would be a separate change for every such node, not this one.

### D3 — Fix 1: a fixture script is scoped to its run

The mock's program store (`providers/dispatchMock.ts`) was a process-global map
keyed by node id only. The fixture's node id is `callai-echo` in every run of it,
in every tenant, so two concurrent runs could read each other's script: wrong
counts, and one tenant's script steering another's reply.

The node now calls `programMockForRun(runId, nodeId, …)`. `dispatchMock` reads the
run-scoped key first, then the node-only key, so every existing harness caller
(the test seam, the eval runner, the unit tests) is unchanged. `callAI` passes
`runId` with `nodeId` to the mock (`aiProviders/aiProvidersHost.ts`,
`dispatchPlain`). Run-scoped programs are bounded (`RUN_SCOPED_PROGRAM_CAP` = 64,
oldest dropped), because this store now lives on a production host.

### D4 — Fix 2: a replay reads the recorded invocation

`callAI` skips the replay shortcut while a mock program is pending
(`aiProviders/aiProvidersHost.ts`, the `mockProgramPending` check before the
`replayInvocationsFromRunId` fallback). That rule exists for RFC 0041 §B: a
harness-staged program is a deliberate divergence injection the replay must
reach. But this node re-scripts on every execution, a replay fork included, so
its replay always re-dispatched live. ec found it (ADR 0966, "Known tensions");
#5142's repeat-last padding made it certain.

A run-scoped program is the run's own input, not an injection, so it no longer
counts: `hasPendingDivergenceProgram()` ignores it. A node-keyed (harness-staged)
program still holds the replay off, exactly as before.

## Evidence

**Tests** (`test/adr0967-callai-fixture-opt-in.test.ts`, 9 cases; ADR 0966's
file updated to read run-scoped budgets). Each mechanism is sabotage-witnessed:

| Sabotage | Red |
| --- | --- |
| The opt-in ignores the auth posture | the auth-refusal case |
| The run-scoped program stored under the node id (the old keying) | the two-runs-same-node case |
| A run-scoped program counted as a divergence injection | the replay case (the fork sent 2 requests to the mock), plus the two unit cases that read it |
| No cap on run-scoped programs | the bounded-store case |
| No advert exemption | the production-gate advert case |

The end-to-end concurrent pair passes either way (the two runs did not interleave
under the old keying in this process). The deterministic unit case is the witness
for D3.

The 25 test files that touch the mock store, the fixture gate or the node pass
(187 tests). Backend `tsc` is clean.

**The m2 lane under the production gate.** Both runs at the same tree, with
`OPENWOP_ENABLE_CONFORMANCE_NODES=false` and `OPENWOP_MOCK_PROVIDER_ENABLED=false`
(production's values), 2 workers at nice 19:

| Flag | Fixture | executed-pass | inapplicable | The nine RFC 0248 rows |
| --- | --- | --- | --- | --- |
| unset | withheld (`unresolvableTypeIds: [echo-attempts]`) | 690 | 4176 | all nine listed inapplicable, as in 165c |
| `true` | advertised | 699 | 4167 | none listed: all witnessed |

Same 654 passing files either way. The nine rows are the only change.

## Cut prediction

After this merges and deploys, and the user flips the flag in production with
`scripts/update-env.sh OPENWOP_CONFORMANCE_CALLAI_FIXTURE=true` (the user's own
go; this ADR does not authorise it):

- Against 165c (459/0/11/381): **468/0/11/372**. The nine rows go inapplicable →
  executed-pass, and no other row moves. `claimedProfiles` is unchanged.
- With the flag left off, the cut is unchanged from 165c.

Preflight before the cut: `/.well-known/openwop` under `OpenWOP-Version: 2` lists
`conformance-callai-attempt-accounting` in `fixtures[]`.

## Checklist

- [x] D1–D4 with sabotage-witnessed tests
- [x] m2 lane under the production gate, flag off and on
- [x] Merge and deploy: #5147 merged as f17ee3753 (train 168), live in deploy 168b
- [x] Production flag flip (the user's go): verified `true` on revision 01025-lg2
- [x] Discovery preflight, then the re-cut against 165c: 91 fixtures listed, cut 169c matched (see Outcome)
- [ ] ec checks in the bundle; RFC 0248 Active → Accepted (bundle handed to ec 2026-10-23)
- [x] Tell Book AI the fields are certified (no release tag promised; that is a separate decision)

## Outcome (2026-10-23, cut 169c)

The prediction above matched exactly.

- Bundle: `gs://openwop-dev-certification-bundles/openwop-app-backend/f17ee375358426741c9bbed333fdce61169068f6/major-2.json`,
  sha256 `f98d673d761f…`, suite 2.46.19, signed `openwop-app-bundle-2`.
- Totals 468/0/11/372, against 165c's 459/0/11/381.
- Diffed by row id, independently by the release manager and by this ADR's author:
  851 rows each side, exactly nine changed, all `inapplicable` → `executed-pass`:
  `openwop.scenario.v2-callai-attempt-accounting` and the eight
  `openwop.requirement.0248.*` rows. `claimedProfiles` is identical.
