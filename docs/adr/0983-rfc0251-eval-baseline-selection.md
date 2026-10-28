# ADR 0983 — RFC 0251 eval baseline selection, the host half

Status: implemented (P1 #5256, merged 24b6a05ff 2026-10-26; live on rev 01051-nxf; certified cut 230c). Reviewed with /architect 2026-10-26; one blocking finding and three notes folded in below.

The user approved this work on 2026-10-26, to start after suite 2.46.28
published. It has. Its train and deploy need the user's own go.

Builds on ADR 0889 (the agent eval runner), ADR 0898 (the eval-fixture opt-in)
and ADR 0977 (the eval counter). It implements RFC 0251 (`Active`, wire locked,
released in 2.46.28): `api/v2/openapi.yaml` createRun `evalModes` /
`baselineRunId`, and the `agents.evalSuite.baselineSelection` facet member.
RFC 0251 itself does not gate advertisement, so no further RFC is needed.

## Context

RFC 0081 regression mode compares an eval run with a baseline. The v2 createRun
body had no way to name one, so this host took `configurable.evalModes` and
`configurable.baselineRunId` (`createEvalRun.ts` `EVAL_CONFIGURABLE_KEYS`). Under
OpenWOP-Version 2 that is a bypass. The `mode: "eval"` branch in
`routes/runs.ts` returns before the closed-root check and before the RFC 0171
closed-`configurable` check, so a v2 eval create accepts keys the v2 wire does
not have. No other host can rely on that, and a conformance suite cannot witness
it. RFC 0251 fixes the carrier and the rules.

The 2.46.28 conformance legs (`v2-eval-regression-baseline`):
`0251.shape`, `0251.baseline-echoed`, `0251.baseline-refused`,
`0251.baseline-uniform` (needs `OPENWOP_TEST_TENANT_B_API_KEY`),
`0251.fields-refused`, `0244.regression-paired`,
`0244.regression-no-false-verdict`. The fixtures
`conformance-eval-regression-base` (1.0.0) and `-candidate` (1.1.0) share one
`suiteId`. Every paired task scores the same, while the aggregates differ by 1/3.

Three host defects stand between this host and those legs:

1. **No carrier.** Covered above.
2. **The refusals tell foreign from unknown.** `baseline_not_found`,
   `baseline_other_suite` (echoing the baseline's suite ref) and
   `baseline_not_completed` (echoing its `status`) are three distinguishable
   answers. RFC 0251 §C requires one indistinguishable refusal for every unusable
   baseline, with no id echoed.
3. **`scoreDelta` is the wrong number.** `pairedRegressionVerdict` returns the
   difference of the PAIRED means. The schema says "`aggregateScore` minus the
   baseline's", and RFC 0251 §D repeats it. On the 0251 fixtures this host would
   report `0` where the contract says `1/3`.

## Decision

**D1 — Root `evalModes` and `baselineRunId` on an eval create.** Both majors
read them from the body root. Validation, in `createAgentEvalRun`:
- `evalModes`: a non-empty array of distinct strings, each in the suite's
  `modes` and in the host's `IMPLEMENTED_MODES`. Absent ⇒ the suite's modes, as
  today.
- `baselineRunId` requires `regression` among the effective modes, and an
  explicit `evalModes` that includes `regression` requires `baselineRunId`.
- Either property on a create without `mode: "eval"` is refused `400
  validation_error` in `routes/runs.ts`, before the workflow path.

All refusals are `400 validation_error` before the run starts.

**D2 — Retire the v2 bypass.** Under major 2, `configurable.evalModes` and
`configurable.baselineRunId` are refused `400 validation_error`, naming the
root property to use instead. Under major 1, where `configurable` is an open map,
and for the in-host callers (the `agent-evals` chat tool and the run-suite node,
which call `createAgentEvalRun` directly), the `configurable` spelling stays and
keeps its existing rules: a baseline on a golden-only suite is still allowed
there. The RFC 0251 pairing rule (D1, second bullet) binds the root properties,
which are the wire. Other eval-only `configurable` keys (`ai`, `mockProvider`)
and `overrideTargetAgent` are out of scope here; they are recorded as residual
v2 debt below.

**D3 — One refusal for every unusable baseline**, on both spellings: unknown,
an unparseable or foreign-tenant id, not an agent eval run, another `suiteId`,
or not completed with a summary. Each answers `400 validation_error`, message
"The baseline run cannot be used.", details `{field, reason:
'baseline_unusable'}`, with no id, suite ref or status anywhere in the body.
Run reads on this host are tenant-scoped (`runAccess.ts` `loadReadableRun`), so
"a run the caller's owner triple can read" is "a run of the caller's tenant".

> **Architect finding (blocking, 2026-10-26):** the "same suite" test compared
> the baseline's `suiteRef.split('@')[0]` with `suite.suiteId`
> (`createEvalRun.ts:170`). A fixture run's `suiteRef` is the
> `https://conformance.openwop.dev/eval-suites/<file>` URI, not
> `suiteId@version`, so every fixture baseline, the conformance pair included,
> would have been refused as "another suite". The comparison now reads the
> baseline's stored `evalSummary.suiteId`, which every usable baseline has
> (completion with a summary is itself a condition).
>
> Notes:
> - A foreign-tenant wire id (`<tenantB>/<opaque>`) already fails `fromWireRunId`
>   (`runIds.ts`) and takes the unknown-id path. Malformed ids do the same.
> - The echo is the stored id. The major-2 projector already maps `baselineRunId`
>   to the wire spelling (`v2-runid-projection-keys`), so the client reads back
>   the id it sent. A v2 route test pins this.
> - `evalModes` is validated, not stored. No runner path reads it. Unchanged.

**D4 — `scoreDelta` is the aggregate difference.** `summary.regression.scoreDelta`
becomes `aggregateScore − baseline.aggregateScore` whenever the baseline summary
exists. `pairedRegressionVerdict` keeps computing the verdict, the method and
`pairedTaskCount` from the paired tasks (RFC 0244 §F). When the baseline summary
is gone (`baseline_unavailable`), the delta stays `0`, as today, beside an
`inconclusive` verdict.

**D5 — Advertise `baselineSelection: true`**, only while the vendored v2 schemas
carry the member, following the RFC 0245 `fixtureErrors` pattern.

**D6 — Pin 2.46.28 in the same PR, and decide each new fixture.** The loader
lists every vendored `eval-suites/*.json`, and listing is the opt-in. 2.46.27
and 2.46.28 add four:
- `conformance-eval-regression-base` / `-candidate`: listed, because D1–D5 ship
  here.
- `conformance-eval-efficiency-ungated`: listed. It needs no host change,
  because this host never gates on `efficiency`.
- `conformance-eval-memory-isolation`: **not listed.** It needs the reserved
  `conformance.eval:memory` tool (RFC 0244 G3), which this host does not
  implement. The loader gains one named exclusion set with its reason, and the
  ADR 0898 opt-in test pins listed = vendored − excluded. Unlisted reads
  `inapplicable`, which is honest. Listing it would fail.

## Alternatives considered

- **Keep `configurable` as the carrier on v2.** It is not on the wire, so no
  other host or client can rely on it. Rejected.
- **Apply the pairing rule to the `configurable` spelling too.** That would
  break v1 clients and the chat tool, which compare golden-only suites today.
  Rejected; the wire properties carry the rule.
- **Refuse a foreign baseline with 404.** RFC 0251 §C fixes one status for every
  unusable value, and an unknown id is a validation failure of the create, not a
  missing resource. Rejected.
- **Implement `conformance.eval:memory` now.** The user approved 0251. G3 is a
  separate decision, and leaving the fixture unlisted is honest. Deferred.

## Risks

- **D4 changes a reported number.** A stored summary keeps the old value. New
  runs report the contract's number. Paired-mean deltas were never on the wire
  as such, and the verdict is unchanged.
- **Residual v2 debt:** an eval create under major 2 still skips the closed-root
  and closed-`configurable` checks for keys other than the two above. It is
  tracked here, not fixed.

## Plan and checklist

- [x] P1 — one PR:
  - pin `^2.46.28`; sync schemas and fixtures at `v2.46.28`;
  - D1–D6;
  - tests: root props accepted and echoed; each D1 refusal; the v2 bypass
    refused; the uniform refusal (unknown vs foreign vs other suite vs not
    completed, no id echoed); `scoreDelta` equals the aggregate difference
    with the verdict unchanged; `baselineSelection` advertised; listed equals
    vendored minus excluded;
  - sabotage witnesses for each.

  Then the prod-gate m2 lane with `OPENWOP_TEST_TENANT_B_API_KEY`.
- [x] Cut prediction against the latest certified cut, from a
  `requirements.json` diff, not from row counting.
- [x] Train and deploy on the user's go; certified cut; bundle to the corpus
  owner for RFC 0251 Accepted.

### Ship record (2026-10-26)

| Step | Result |
|---|---|
| Merge | #5256 → `24b6a05ff`, train 230 (docs #5258 ahead of it); main's tree equal to the gated tree |
| Deploy | 230b: `24b6a05ff` on rev `01051-nxf`, suite 2.46.28. Discovery gained `conformance-eval-efficiency-ungated`, `-regression-base`, `-regression-candidate` and `baselineSelection: true`; memory-isolation unlisted; PRM unchanged |
| Cut | 230c **certified, 500/0/11/376 = 887**. Bundle sha256 `2e19442f3f44`, witness `9da648fd4a82` |
| vs 741c | +9 `executed-pass`: `0251.shape`, `baseline-echoed`, `baseline-refused`, `baseline-uniform`, `fields-refused`, `0244.regression-paired`, `regression-no-false-verdict`, `efficiency-never-gated`, `scenario.v2-eval-regression-baseline`. +1 `inapplicable`: `0244.trial-memory-isolated`. 0 moved, 0 gone |
| Spec | Bundle sent to the corpus owner for RFC 0251 Accepted |

> **Correction to the P1 prediction:** it said 499/0/11/376 = 886, and the cut is
> 887. All nine predicted requirement rows landed exactly. The extra row is the
> new scenario file's own `openwop.scenario.v2-eval-regression-baseline`, which a
> `requirements.json` id diff does not count. Each new scenario file adds one
> such row.

### P1 record (2026-10-26)

| Claim | Test | Sabotage (red when) |
|---|---|---|
| D4 `scoreDelta` is the aggregate difference | `adr0983-rfc0251-eval-baseline`: 1/3 on the conformance pair, 2 pairs, `unchanged` | `scoreDelta = r.scoreDelta` (paired mean) |
| Architect finding: same suite by `summary.suiteId` | same | compared by `suiteRef` (fixture URI) |
| D3 one refusal: unknown = foreign = other suite, no id | same, whole-body equality | a foreign id refused with its own reason |
| D1 baseline ⇔ `regression` | same | the pairing rule skipped |
| D1 refused without `mode: "eval"`, before the workflow resolves | same (an unknown workflow: 404 without the check) | the check removed |
| D2 the v2 `configurable` bypass refused | `adr0889-store-integrity` | the major-2 refusal removed |
| D5 `baselineSelection` advertised | `adr0983` discovery | advert removed |
| D6 memory-isolation unlisted; listed = vendored − excluded | `adr0898` opt-in + `adr0983` discovery | exclusion removed |

- Typecheck is clean. The 11 related eval test files pass (153 tests, 5 new).
  The 8 sabotages all went red. A first version of the D1 non-eval test was
  vacuous: v1 is retired (406), and the v2 closed-root check also refuses once a
  workflow resolves. It now uses an unknown workflow.
- The ci.sh node statics, the FE lint, build and test types, and
  eventVocabulary/kicktodoWireParity all pass.
- Prod-gate m2 (`--filter "RFC 0244"` and `"RFC 0251"`, nodes and the mock
  provider off, prod opt-ins on, tenant-B key from the runner): these are all
  `executed-pass`:
  - `0251.shape` (5), `0251.baseline-echoed` (3), `0251.baseline-refused` (6),
    `0251.baseline-uniform` (3), `0251.fields-refused` (4);
  - `0244.regression-paired` (1), `0244.regression-no-false-verdict` (2),
    `0244.efficiency-never-gated` (3).

  `0244.trial-memory-isolated` is `inapplicable` (unlisted). Every earlier
  0244 row is unchanged.
- `requirements.json` 2.46.26 → 2.46.28: 2846 → 2855, +9 ids, none removed.
  **Cut prediction: 499/0/11/376 = 886**, i.e. +8 pass and +1 inapplicable
  over 228c's predicted 491/0/11/375 (rows from other PRs in the same deploy
  are split out by source).
