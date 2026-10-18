# ADR 0898 — eval-suite fixtures opt in without the agent registry

Status: implemented (flag ON in prod since 2026-10-17 13:17Z; cut 115d matched the prediction)

## Context

ADR 0889 P5 vendored the RFC 0244/0246 eval-suite fixtures
(`conformance-fixtures/eval-suites/`, five suites) and the scripted agent they
target, `core.conformance.agents.scripted`. All three entry points are gated on
`conformanceNodesEnabled()` (`host/evals/fixtureSuites.ts`):
`resolveFixtureSuite`, `listFixtureSuiteIds` and `registerScriptedEvalAgent`.
Prod runs the auth posture, so that switch is off (LEAK-8). The result is that
prod lists none of the five suites, and the 0244/0246 host rows certify as
`inapplicable` on every prod cut (109c: 447/0/11/381).

Turning `OPENWOP_ENABLE_CONFORMANCE_NODES` on in prod is not an option: it mounts
`core.conformance.mock-agent`, `conformance.secret.echo` and the other
conformance nodes LEAK-8 keeps off.

A narrower flag that just widened all three gates was reviewed (security read
for 67/ec, 2026-10-16) and has one **blocker**: `registerScriptedEvalAgent`
puts a manifest with **no `ownerTenant`** into the global agent registry, and
`agentVisibleToTenant` treats that as public (`host/agentVisibility.ts`). Every
surface that resolves agents through the registry would then offer it as a
live-dispatch agent making real model calls. That covers `/agents`, chat
(`chatContext.ts`), dispatch (`agentDispatch.ts`, the `/agents/:id/dispatch`
route), workflow agent nodes (`bootstrap/nodes.ts`), channels, voice and the
chat widget. The eval lane itself is safe: `runScriptedTrial` replays
`task.input.script` with no model and `allowLive:false`, and the suites are
golden-only.

## Decision

1. **`OPENWOP_CONFORMANCE_EVAL_FIXTURES=true`** (env-read per call, matching
   `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES`) sets
   `conformanceEvalFixturesEnabled() = conformanceNodesEnabled() || flag`.
   `resolveFixtureSuite` and `listFixtureSuiteIds` read it, so the suites are
   in discovery `fixtures[]` and can be run.
2. **`registerScriptedEvalAgent` stays gated on `conformanceNodesEnabled()`
   only.** The flag never puts the scripted agent in the registry.
3. **The scripted agent exists only inside an eval run of a fixture suite.**
   `scriptedEvalAgentFor(agentId, source)` returns the manifest only when
   `agentId === SCRIPTED_AGENT_ID`, `source === 'fixture'` and the flag is set.
   `createEvalRun` reads it before the registry gate. Any other case falls
   through to `resolveAgentForTenant`, where the agent is absent under the flag
   alone, and gets the same 404 dispatch gives (`agent '…' is not installed on
   this host`). That includes a tenant or pack suite naming the scripted id.
   The runner never reads the manifest: `runTrial` routes the scripted id to
   `runScriptedTrial`. Resume re-resolves only the suite (`resumeEvalRun.ts`).
4. The conformance posture is unchanged. With nodes on, the agent is registered
   as before, and every path behaves as it did.

## Alternatives considered

- **Widen all three gates.** Rejected because of the public-registry blocker above.
- **Register the agent with an `ownerTenant`.** Rejected: no tenant is the
  right owner. The suite runs under whichever tenant the certify principal
  uses, and a registry entry is still a dispatch target for that tenant's chat.
- **Turn on the conformance nodes in prod.** Rejected because it reverses LEAK-8.

## Consequences

- With the flag off (the default, and prod today) behaviour is byte-identical.
- With the flag on, the predicted prod cut (from 109c 447/0/11/381) is
  **453/0/11/375**. Six rows move from `inapplicable` to executed-pass:
  `0244.trajectory-graded`, `trials-per-task`, `trial-stats-formula` and
  `fixture-miss-fails`, plus `0246.mean-gated` and `suite-gated`.
  `0244.unadvertised-feature-refused` most likely stays `inapplicable`, because
  prod advertises every 0244 feature. No existing row changes.
- Cost: an eval run of a fixture suite makes no model call and no live tool
  call, and it runs under the existing tenant run limit and cost ceiling.

## Tests

`backend/typescript/test/adr0898-eval-fixtures-opt-in.test.ts` boots the app with
nodes off and the flag on. Each assertion was sabotage-witnessed red:

| assertion | sabotage that reddens it |
| --- | --- |
| suites in discovery `fixtures[]`; a fixture run grades task by task | suite gates back to `conformanceNodesEnabled()` |
| scripted agent absent from the registry / `resolveAgentForTenant` (chat, nodes, channels, voice, widget); absent from `GET /agents`; dispatch 404 | `registerScriptedEvalAgent` gated on the flag |
| an eval run of a tenant suite naming the scripted id → 404 | `scriptedEvalAgentFor` ignores `source` |
| LEAK-8: `core.conformance.mock-agent`, `conformance.secret.echo` unresolvable | the flag also turns the conformance nodes on |

## Checklist

- [x] Flag + gates + tests: #4895, merged `5ff16fd7b` (train 115, 2026-10-17 02:35Z), together with the conformance 2.46.14 pin.
- [x] Prod: `scripts/update-env.sh OPENWOP_CONFORMANCE_EVAL_FIXTURES=true`, user-approved (slot 115d). ON since 2026-10-17 13:17Z on rev `00990-zc9`, the same image `420fe1891`.
- [x] Cut after the flag: **115d, bundle `3dce87c98584`, suite 2.46.14, 453/0/11/375. This MATCHED the prediction.**

## Implementation record (2026-10-17)

| check | prediction | measured |
| --- | --- | --- |
| cut 115c (flag OFF, the 2.46.14 pin alone) | 0 row changes vs 109c | 0 |
| cut 115d (flag ON) | 453/0/11/375 | 453/0/11/375 |
| rows moved 115c → 115d | the 6 below, `inapplicable` → `executed-pass` | exactly those 6 |
| `0244.unadvertised-feature-refused` | stays `inapplicable` | `inapplicable` (by construction: prod advertises `.trials`, so the refusal leg has no unadvertised feature to try) |
| existing rows changed | 0 | 0 |
| discovery `fixtures[]` | lists all 5 eval suites | all 5 listed (read-only probe, 13:33Z) |
| scripted agent on `GET /agents` | absent | absent (signed-in anon session, 104 agents listed) |

Rows moved: `0244.fixture-miss-fails`, `0244.trajectory-graded`,
`0244.trial-stats-formula`, `0244.trials-per-task`, `0246.mean-gated` and
`0246.suite-gated`.

An unauthenticated `GET /agents` answers `401`, so an empty list from it would
prove nothing. The absence check above was made with a session.

**RFC 0246 sabotage witness (requested by ec for the 115d check-in).** This was
run locally, never against prod, on `7b1add969` with
`OPENWOP_LEDGER_PATH=<file> OPENWOP_TARGET_MAJOR=2 npm run test:conformance -- --filter "RFC 0246"`.
Reverting §B in `agentEvalRun.ts` was a two-line change: the task passed on
`meanScore`, and the suite passed on `aggregateScore`. That turned
`0246.mean-gated` and `0246.suite-gated` from `executed-pass` to
`executed-fail`, with 10 assertions each. `0246.gated-fields-shape` (the schema
leg) stayed `executed-pass`, and undoing the revert restored 4/4. The local run
lists the fixtures through the conformance-nodes posture rather than this flag.
The rows and assertions are the ones prod runs.
