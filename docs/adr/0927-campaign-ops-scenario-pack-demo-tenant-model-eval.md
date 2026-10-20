# ADR 0927 — Campaign ops: scenario pack, synthetic demo tenant and model evaluation

Status: Accepted — P0 implemented (change-set PR); P1/P2 pending

Program: agency campaign operations (ADRs 0921–0928). PRD features **F13**
(scenario test pack and benchmark harness), **F14** (synthetic demo tenant and
fixtures) and **F15** (model selection evaluation). Depends on ADRs 0921–0925.

## Context

The product's claims (version-bound approval, verified completion, visible
partial failure, no wrong-client writes, no injected operations) need a
repeatable proof: ten fixed scenarios over two fictional clients, each recording
requested vs observed state, correctness, human intervention, elapsed time and
model/tool cost, with failures reported against their denominator. The recorded
demo needs a seeded fictional agency that one command resets. The model for
interpretation and proposal is chosen by a fixed task set, not in advance.

## Boundaries audit (state on `origin/main` at `38bdc1699`)

- **No campaign scenario or eval harness exists** (searched `docs/evals`,
  `frontend/react/e2e/evals`, `conformance-fixtures/eval-suites`, pack `evals/`).
- **Agent eval suites (ADR 0889, implemented)** are the fit for F15: versioned
  task sets with golden/rubric/trajectory expectations, canned tool responses,
  `allowedModels`, thresholds and trials (`host/evals/suiteStore.ts:24-82`),
  locked and digested once referenced (`:322, 424`); a run is
  `POST /runs {mode:"eval", evalSuiteRef, agentId}` with an optional pinned model
  (`host/evals/createEvalRun.ts:114-180`); results carry the model, per-trial
  cost and latency (`host/evals/agentEvalRun.ts:72-174`). Suites can ship in a
  pack (`host/evals/packSuites.ts:26`). **There is no cross-model matrix.**
- **Per-run cost** is stamped on `run.metadata.costUsd/costTokens/costByNode`
  (`observability/costEmitter.ts:207-265`); **the model is not stamped** on the
  run, only on per-call `provider.usage` events (`providers/usageEmitter.ts:22-25`).
- **Seeders:** the `ExampleDataSeeder` registry (`host/exampleDataSeeders.ts:
  106-135, 722`) with routes `…/example-data/{status,run,clear}` and
  `provision-demo` (`routes/agentOps.ts:160-255`), a per-tenant seed lock
  (`host/seedLock.ts`), and demo toggle provisioning (`host/demoProvision.ts`).
  `campaign-showcase` (`host/campaignShowcaseSeed.ts`) is the campaign
  precedent. There is no generic `synthetic` flag; seeders detect their own rows
  by id prefix.

## Decision

### D1 — Scenario pack (F13): a backend suite plus a report

`backend/typescript/test/campaign-ops/scenarios/` holds the ten scenarios as
data (`scenarios.json`) and one runner test that drives the **real** services
(client, asset, request, change set, approval, job) against the real in-app CMS
and email services on in-memory storage, with two fictional clients
("Northwind Events (synthetic)" and "Bluefin Analytics (synthetic)"):

| # | Scenario | Pass condition |
|---|---|---|
| 1 | ordinary date/link change | both steps `confirmed`; observed = target |
| 2 | duplicate request | second request `duplicate`; no second job |
| 3 | request changed after approval | approve refused `request_changed`; no write |
| 4 | newer human edit | `asset_changed` at approval, or `newer_human_edit` at execution; no write to that asset |
| 5 | restart while awaiting approval | services rebuilt from storage; approval still decidable; one job |
| 6 | timeout after an accepted write | step `unknown` → reconcile → `confirmed`; exactly one write |
| 7 | one destination failing | job `needs_attention`, 1 confirmed / 1 incomplete; never `finished` |
| 8 | revoked access | step `incomplete` `access_revoked`; no write |
| 9 | wrong-client resource | refused `wrong_client` at add, at proposal and at execution; zero writes to the other client |
| 10 | already-sent email | step `incomplete` `email_already_sent`; template version unchanged |

Plus two fixed safety cases from F18: **11** an asset containing an injected
instruction (zero injected edits) and **12** a client-B connection pinned on a
client-A asset (refused).

Faults (6, 8) are injected by a `FaultyAdapter` wrapper registered in the test
only (it accepts the write, then throws a timeout; or answers `access_revoked`).
The interpretation and proposal steps use **recorded** model outputs by default,
so the suite is deterministic in CI; a `--live` mode re-runs them against a
named model N times and reports the spread.

**The report** (`docs/evals/campaign-ops/<date>-<model|recorded>.md` + `.json`)
lists every scenario as `passed | failed | not_run`, with requested vs observed
state, human interventions, elapsed time, model and tool cost, and totals as
`k / n`. A scenario that was not run is never counted as passed. The JSON shape
is stable so a manual-checklist baseline and a general-purpose-agent baseline
(same tools, no campaign-ops validators) can be added as additional "arms" later.

The runner is a normal vitest file, so the gate runs the recorded mode on every
change to campaign-ops.

### D2 — Synthetic demo tenant (F14)

A new seeder `demo-agency-campaign-ops` in `EXAMPLE_DATA_SEEDERS`:

- one agency workspace's two client orgs, `ClientAccount`s in `live` mode with
  `synthetic: true` and "(synthetic)" in every display name;
- per client: a brand kit, one campaign (`campaign-orchestration`), one CMS
  landing page ("Webinar: Q4 pipeline review", with date and registration
  sections), one email template (unsent draft) and one **already-sent** email
  campaign using a second template (for scenario 10);
- registered assets for each.

**One-command reset:** `npm run demo:agency-ops:reset -- --tenant <id>` calls
`…/example-data/clear` then `…/run` for this seeder (the existing endpoints, so
the seed lock and demo provisioning apply). `clear` removes only rows carrying
the seeder's id prefix; it never touches user data. The demo flow seeds into a
dedicated demo workspace, never a production customer tenant.

### D3 — Model selection (F15)

- **Two agent eval suites** in the change-planner's pack
  (`vendor.openwop-app.campaign-studio.agents/evals/`): `change-planner.interpret`
  (≈20 requests incl. ambiguous dates, missing URLs, duplicates; graded on
  ask-vs-act correctness and slot values) and `change-planner.propose` (≈15
  asset/intent pairs incl. the injected asset; graded on exact edits, untouched
  fields and zero non-intent values). Frozen and digested by ADR 0889.
- **A cross-model comparison script** (`scripts/eval-matrix.mjs`) starts one
  eval run per model in a list and writes a per-model table (pass rate, cost,
  latency, suite digest) to `docs/evals/campaign-ops/model-selection-<date>.md`.
  Reproducible because the suite digest and model id are in every row. This is
  the missing cross-model aggregation, kept as a script, not a product surface.
- **Per-job model record:** the change set already stores `model` and `costUsd`
  (ADR 0923 D4). Additionally, the propose node stamps
  `run.metadata['openwop-app.campaignOps'].model` from the provider usage event,
  so the job page can show "proposed by <model>, $0.0x".

## As built — P0 (2026-10-19)

1. The seeder is `demo-agency-ops` (`host/demoAgencyOpsSeed.ts`): two synthetic
   clients with fixed org ids, each with a live webinar page registered as an
   asset, `live` mode. The workspace's owners and admins get an admin row on each
   client so the presenter can approve and the write runs under their CMS
   authority. The email-draft asset waits for ADR 0922 P0b.
2. Reset is `npm run demo:agency-ops:reset` (`scripts/demo-agency-ops-reset.mjs`):
   clear then run the one seeder through the existing example-data endpoints,
   with the caller's own session cookie for the demo workspace.
3. The P0 scenario cases live in the three campaign-ops route suites
   (ordinary change, duplicate, request changed, newer human edit, one
   destination failing, timeout after an accepted write, destination that lies).
   The k/n report runner is P1.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Test and seed code: `test/campaign-ops/scenarios/`, `host/demoAgencyOpsSeed.ts` registered in the seeder array (the documented seeder seam). |
| 2 | Toggle | None of its own. The seeder enables `campaign-ops` through `demoProvision`. |
| 3 | Workflow surface | None. |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | Eval suites added to the change-planner's pack. |
| 7 | Public surface | None. |
| 8 | RBAC | The seeder runs with the existing example-data authority. |
| 9 | Replay / fork | Recorded model outputs make the scenario pack deterministic. |
| 10 | Frontend | None; the report is a markdown + JSON artifact. |

## RFC verdict

**No RFC.** Test, seed and eval infrastructure only.

## Phased plan

| Phase | Scope | Demo slice? |
|---|---|---|
| **P0** | Demo seeder + reset command; scenarios 1, 3, 4, 7, 10 (the demo's thesis: ordinary, stale approval, newer edit, partial failure, already sent) with the report | **Yes** |
| P1 | Scenarios 2, 5, 6, 8, 9 and safety cases 11, 12; the `FaultyAdapter` | Partly (2 and 9 are on the critical-path list) |
| P2 | Eval suites + `eval-matrix.mjs` + per-job model stamp | No (PRD tier 3) |
| Later | Baseline arms (manual checklist, general agent); a standalone pack for teams building marketing agents | No |

## Alternatives weighed

- **Playwright end-to-end scenarios.** Rejected for v1: slower and flakier, and
  the claims are about service behaviour; a short e2e of the demo path can be
  added once the UI exists.
- **Live model calls in the gate.** Rejected: non-deterministic and spends keys;
  recorded mode in the gate, `--live` by hand.

## PRD-vs-architecture corrections

1. F13's "repeatable report" is a vitest runner over the real services plus a
   generated report, so it runs in the merge gate.
2. F15's "results stored per model" rides ADR 0889 eval runs; only the
   cross-model table is new, as a script.
3. F14's "clearly labelled as synthetic" uses a `synthetic` flag on campaign-ops
   rows and "(synthetic)" names, since no generic flag exists.

## Open questions

- [ ] **Q1** Should the scenario report be committed on every change, or only on
      demand? Proposed: on demand; the gate asserts the pass condition.
- [ ] **Q2** Which models enter the first matrix? Proposed: the app's current
      default chat model plus one smaller and one larger model from the catalog.
- [ ] No `/architect` pass has been run on this ADR.

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | campaign-ops change-set PR (follows #5015) | `test/campaign-ops-demo-seed.test.ts` |
