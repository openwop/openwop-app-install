# feature.evals.nodes

Workflow nodes over the `ctx.features.evals` surface (ADR 0889 WF-EV-11).

## `feature.evals.nodes.run-suite`

Starts an agent eval run (RFC 0081 `POST /runs {mode:"eval"}` semantics, through
the same host code as the `openwop:agent-evals.run` chat tool), waits for it, and
outputs the scorecard:

| output | meaning |
|---|---|
| `evalRunId` | the eval run, viewable in the agent's Evals tab |
| `passed` | the suite's own pass rule |
| `regressed` | `true` only with a `baselineRunId` and a `regressed` verdict |
| `ok` | the gate: `passed && !regressed`; branch on it |
| `aggregateScore`, `passedCount`, `taskCount`, `verdict` | from the summary |

- **Typed failures, never a pass:** a refused start (`acting_user_required`,
  `feature_disabled`, `not_entitled`, `not_found`, `validation_error`), an eval run
  that ends `failed` or `cancelled` (its own error code), and `eval_wait_timeout`.
- **Spend stops with the workflow:** cancelling the workflow run, or a timeout,
  cancels the eval run.
- **Replay:** `role:"side-effect"`, so a replay fork is served the recorded outcome
  and never starts a second eval run.
- **Wait bound:** `timeoutMs` defaults to and is capped at 540 000 ms, inside the
  600 000 ms run-duration ceiling. A suite that needs longer is run from the
  Evals tab or `scripts/eval-agent-suite.mts`.

The reference chain is `examples/workflow-chain-packs/agent-eval-regression-gate`.
