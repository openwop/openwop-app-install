# ADR 1027 — A run whose every terminal was skipped completes (RFC 0257)

Status: implemented (P1 #5466, P2 #5492, P3 #5500) and certified in production
(cut 196, see §Certified). RFC 0257 is `Accepted` (openwop #2078, `a3cc5c1b`; it
went `Active` in openwop #2076, `62640e5c`, suite 2.46.41).

## Context

CS70WF-38 (`docs/steward/workflows-assessment/2026-10-31-engine-skipped-terminal.md`)
found runs in which no node failed and every terminal node was skipped: a guard
that declined, a router that matched no branch, or an `any_failed` handler whose
source succeeded. #5443 stopped reporting them as `internal_error` "unknown node
failure" and failed them with the host code `all_terminals_skipped` (major 2:
`openwop-app.all_terminals_skipped`). That run status still claimed a failure no
node produced. It dead-lettered the run, raised a failure notification, and
failed a `core.subWorkflow` parent under the default `onChildFailure: fail-parent`.

RFC 0257 (owned by the spec session `openwop-be`) settles the state for the
corpus. The run ends `completed`, and `run.completed` carries `skippedTerminals`.
A sub-workflow parent completes and sees `childSkippedTerminals`.

## Decision

Implement RFC 0257 §A and §B on this host, against the shape `openwop-be` proposed
on 2026-11-02 (answers 1–8; "LOCKED" pending the user's confirmation in that
session).

1. **Disposition** (`executor/scheduler.ts` `inspectDisposition`). Quiescent, no
   node failed, no terminal completed, at least one terminal → `status:
   'completed'` with `skippedTerminals`. In that branch every terminal is
   `skipped` (no other state survives the quiescence checks), so the list is every
   terminal. Unchanged: a failed node with every terminal skipped still fails on
   that node's error (RFC 0257 Open spec gap 2). A definition with no terminal is
   not this state (RFC UQ8 answer). A `disabled` node is a node like any other.
2. **Marker** (`executor/executor.ts` `finalizeRun`, `skippedTerminalsInOrder`).
   `run.completed.skippedTerminals` holds the terminals in the definition's
   `nodes[]` order, each once. It is absent whenever a terminal completed (§A.3).
   It is a function only of the pinned definition and the recorded outcomes
   (§A.4). `outputs` is unchanged; when no terminal completed this host records
   `{}` (RFC G11, measured by the test). The CS70WF-38 failure branch and its code
   are deleted.
3. **Sub-workflow parent** (`executor/subWorkflowDispatcher.ts`, `bootstrap/nodes.ts`).
   A completed child's marker is read from its recorded `run.completed` (the v1
   spelling, `contract: 1`), never recomputed. The `core.subWorkflow` node's
   outputs gain `childSkippedTerminals`. `onChildFailure` does not apply: the
   child did not fail. A replay that serves the node re-reads the recorded outputs.
4. **Major-2 wire.** Until the vendored `schemas/v2/run-event-payloads.schema.json`
   declares `runCompleted.skippedTerminals`, the major-2 read carries the key under
   `vendor.openwop-app` (ADR 0725 D3, RFC 0185 §C): carried, never dropped, never
   claimed. When the schema sync lands the key is seated with no code change. The
   test asserts whichever arm the vendored schema selects, and validates the
   projection against the v2 def either way.

### Replay

A run recorded before this change keeps its `run.failed` (no rewrite). A `replay`
fork whose `fromSeq` precedes the terminal event re-derives `completed` under
current code and records `replay.diverged` (`replay.md` §Divergence). A replay
fork of a run recorded under this ADR ends with the same terminal event and the
same `skippedTerminals`, with no divergence. All three are witnessed.

### Advertising

There is no capability flag. The disposition is core run behaviour. The three
RFC fixtures (`conformance-error-route-only`, `conformance-all-terminals-skipped`,
`conformance-subworkflow-skip-parent`) are NOT added to discovery `fixtures[]`
here. They are added once RFC 0257 is `Active` and the suite version that carries
them is pinned (P2).

## Alternatives

RFC 0257 §"Alternatives considered" weighs keeping `failed` with a registered
code, an author declaration, a new status and registration-time refusal. This ADR
does not re-decide the corpus question. The one host-level choice was where the
parent reads the child's marker: from the child's recorded log (chosen,
replay-stable) or from `executeRun`'s return value. The return value is not
available when a child is resumed later and the parent re-reads its final state.

## Consequences

- On production, runs that ended `failed` / `all_terminals_skipped` now end
  `completed`: failure counts drop, and those runs are not dead-lettered and raise
  no failure notification. `career.apply` with a declining guard is the
  run-confirmed case. The other eight chains in the steward table are static-scan
  candidates.
- A `core.subWorkflow` parent no longer fails on a child that reached no terminal.
  One that must stop routes on `childSkippedTerminals` (`truthy` → `core.fail`).
- P3 (frontend, §P3): run surfaces present "no final step ran" for a completion
  with the marker, rather than an empty deliverable (RFC 0257 §C).

## Phases

| Phase | What | State |
| --- | --- | --- |
| P1 | Disposition, marker, sub-workflow field, tests | #5466 |
| P2 | Pin suite 2.46.41 (RFC 0257 `Active`); the schema sync seats `skippedTerminals`; the three fixtures are vendored and so advertised; fixture edge conditions are mapped at load | #5492 (see §P2) |
| P3 | SPA presentation of a no-terminal completion | #5500 (see §P3) |
| Cert | Certified in production by cut 196 (see §Certified) | done |
| G10 | Production count, read-only (2026-11-02): **0** `run.failed` `all_terminals_skipped` since #5443, and **0** of the pre-#5443 shape (`internal_error` "unknown node failure") across all 22,689 retained runs. Control: the same query path returns `approval_rejected` 745, `deterministic_fail` 288 (30 days). Quoted in the RFC 0257 register | done |

## Witnesses

Tests: `test/adr1027-rfc0257-skipped-terminals.test.ts` (6),
`test/adr1027-rfc0257-subworkflow-replay.test.ts` (3),
`test/cs70wf-38-all-terminals-skipped.test.ts` (rewritten to RFC 0257 on the real
`career.apply` chain), and `test/career-apply-chain-gate.test.ts` (one expectation
moved from `failed` to `completed` with the marker; its substance, that the
browser is never reached, is unchanged).

Sabotage, each run against the three new or rewritten files (10 tests):

| Sabotage | Red |
| --- | --- |
| S1 `inspectDisposition` returns `failed` again | 7 |
| S2 `finalizeRun` drops the marker | 7 |
| S3 the marker on every completion | 2 (the §A.3 positive control, the parent's own marker) |
| S4 scheduler order instead of `nodes[]` order | 1 (the order leg) |
| S5 the dispatcher ignores the child's marker | 1 (the §B leg) |

Restored: 10/10 green. Targeted runs at `VITEST_MAX_WORKERS=2`: 93 files touching
disposition, sub-workflows, payload carry, trigger rules and edge conditions
(929 tests), and 16 files that drive the nine steward chains (214 tests) — all
green after the one `career-apply-chain-gate` expectation above moved.

## P2 — the suite pin and the fixtures (2026-11-02)

- **Pin 2.46.38 → 2.46.41** (`@openwop/openwop-conformance` and `@openwop/spec-artifacts`,
  installed with npm 10.9.8: the lockfile moved only those two packages, and
  `@azure/core-rest-pipeline` is present). `sync-schemas.sh` and `sync-fixtures.sh` ran
  at tag `v2.46.41`. `runCompleted.skippedTerminals` is now seated, so the major-2
  read no longer boxes it under `vendor.openwop-app`. The test takes the seated arm
  and validates against the def, with `ids.schema.json` registered.
- **Fixtures.** `conformance-error-route-only`, `conformance-all-terminals-skipped` and
  `conformance-subworkflow-skip-parent` are vendored. This host advertises every
  vendored fixture, so the RFC 0257 legs gate on.
- **A defect P2 found, fixed here.** The first wire-shaped edge `condition` in any
  vendored fixture (`conformance-all-terminals-skipped`) reached the executor unmapped.
  `loadConformanceFixtures` (`host/index.ts`) copied edges raw, so `path` and `op`
  were undefined and the edge never fired. The suite's positive control (`ok: true`)
  failed: `act` was skipped and the run reported a marker. Fixture edges now pass
  through `normalizeEdgeCondition`, the ingest authority the register route and chain
  expansion already use. Witness: `adr1027-rfc0257-subworkflow-replay` "the vendored
  fixture, as the suite runs it" (red with the mapping removed).
- **The 2.46.39 and 2.46.40 contents this pin also takes.** 2.46.39 is RFC 0253
  (`v2-proposal-pack-readback`, `getInstalledPack` in the path manifest). This host
  lists no pack kind in `readback`, so its legs are inapplicable, and
  `GET /installed-packs/{name}` answers `404 not_found`
  (`v2-unadvertised-operation-not-found`, green). 2.46.40 has no suite change.
- **Measured at major 2** (`OPENWOP_TARGET_MAJOR=2`, the three scenario files):
  `v2-all-terminals-skipped` 6/6 (before the loader fix 5/6, positive control red),
  `v2-proposal-pack-readback` 12/12 and `v2-unadvertised-operation-not-found` 4/4.

> **CORRECTION (train 184d, 2026-11-02):** the 2.46.41 path manifest also adds
> the root `/installed-packs`. Without a Firebase rewrite, the SPA catch-all
> answered it with `text/html`, so Gate 6 (`check-hosting-wire-rewrites`) refused
> the tree and every PASSES case in `scripts/test-deploy-gates.sh` went red.
> `a35fe6b64` routes `/installed-packs` and `/installed-packs/**` to Cloud Run,
> where the unadvertised operation answers a JSON `404`. A pin bump that adds a
> v2 manifest root needs a `firebase.json` rewrite in the same PR.

## P3 — presenting a completion with no final step (2026-11-02)

RFC 0257 R1 names the risk the marker exists for: a run that did nothing reads as
a success. So the SPA shows it as its own state, through the existing surfaces
(no new component).

- **One reader.** `chat/lib/skippedTerminals.ts` reads `skippedTerminals` off the
  `run.completed` payload. It accepts the seated key and, for a host serving an
  older v2 schema, the `vendor.openwop-app` carry. It never derives the list from
  the graph: the host records it from the pinned definition (§A.4), and the SPA
  may not have the graph.
- **Chat.** Both paths that finalize a chat run (the live SSE handler and the log
  reconcile) copy the marker into `WorkflowRunState.skippedTerminals`. The
  persisted message carries it, so a reload shows the same state.
  `WorkflowCompletionCard` renders a muted row titled "Completed: no final step
  ran" that names the skipped steps (builder names, ids as fallback) and offers
  no View button, because there is no output.
- **Run detail.** The `StatusBadge` reads "Completed: no final step ran" in the
  warning tone rather than the success tone, and a warning `Notice` names the
  skipped final steps. The snapshot status stays `completed`: the run did
  complete.
- **Copy** in all four locales of the `chat` and `runs` namespaces.

Witnesses: `frontend/react/src/chat/__tests__/rfc0257SkippedTerminals.test.tsx`
(9) and `frontend/react/src/runs/__tests__/rfc0257NoFinalStep.test.tsx` (2). Each
claim has a positive control (a `run.completed` without the marker stays a plain
success).

| Sabotage | Red |
| --- | --- |
| S1 the reader ignores the seated key | 5 |
| S2 the live SSE path drops the marker | 1 |
| S3 the log reconcile drops the marker | 1 |
| S4 the card ignores the marker | 2 |
| S5 the card shows "no final step" on every completion | 1 |
| S6 run detail ignores the marker | 1 |
| S7 run detail badges every completed run | 1 |

Restored: 11/11. `npm run build` (tsc and every token, CSS and i18n check) and
eslint on the changed files are green. 101 existing test files that import the
changed modules or the locale tables pass (788 tests, 3 expected-fail).

> **CORRECTION (2026-11-03):** that list of checks left out
> `npm run check:test-types`. `npm run build` does not typecheck test files, and
> vitest does not typecheck at all. The fixture `ChatMessage` in
> `rfc0257SkippedTerminals.test.tsx` lacked the required `createdAt`, so train 185
> went red on that lane. The release manager added the field (`604889c35`) and
> re-ran the train. Run `check:test-types` with the build before freezing a
> frontend head.

## Certified — production evidence (2026-11-03)

Release cut 196 certified RFC 0257 in production. The served backend was
`d2c7e089b`, which carries P1 and P2 (P3 is presentation only and has no
conformance row).

- **Bundle:** `gs://openwop-dev-certification-bundles/openwop-app-backend/d2c7e089bb752e90546ac14281fb3fcdca5282da/major-2.json`,
  sha256 `583c4de499cf…`, generated 2026-11-03T00:10:54Z, suite 2.46.41. It is
  the canonical bundle for RFC 0257 (openwop #2078).
- **Rows, all `executed-pass`:** `openwop.scenario.v2-all-terminals-skipped`, and
  `openwop.requirement.0257.` `shape`, `condition-skip-completes`,
  `trigger-rule-skip-completes`, `terminal-completed-no-marker`,
  `subworkflow-child-skipped` and `replay-same-disposition`.
- **Totals:** 541 executed-pass, 0 executed-fail, 11 skipped, 369 inapplicable,
  0 blocked.

These were read from the bundle itself, not from a summary of it.
