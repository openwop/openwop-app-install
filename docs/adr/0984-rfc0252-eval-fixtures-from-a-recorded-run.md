# ADR 0984 — RFC 0252 on this host: an eval task takes its fixtures from a recorded run

Status: Accepted (P1 and P2 implemented 2026-10-26: pin 2.46.32 carries RFC 0252; P3, live-run sources through D7, implemented 2026-10-26; the certified cut that witnesses it is open)

## Context

RFC 0252 adds an optional `createRun` property, `fixtureRuns: {<taskId>: <runId>}`,
for `mode: "eval"`. The host derives each named task's `toolResponses` from the
source run's recorded tool calls of the eval's agent and runs the task under
`onMiss: "fail"` (RFC 0244 §D). It is advertised by
`agents.evalSuite.recordedFixtures`, which requires `fixtureMatching`.

The RFC was filed `Draft` on 2026-10-26 with a 7-day window. The user waived the
window the same day (relayed by the openwop steward session, openwop-be), and
the steward is taking it to `Active`. The same ruling settles four of its
unresolved questions:

- **UQ 4:** an eval run may be a source. The scenario's sources are eval runs.
- **UQ 1 and 2:** every invocation's calls, in sequence order, `argsMatch: "exact"` only.
- **UQ 3 and 5:** no memory seeding; the tool boundary only.

`Accepted` needs a certified openwop-app cut whose bundle records the `0252.*`
host legs as `executed-pass`. That makes this host the witness.

Prior art on this host:
- ADR 0889 (eval runs, the D9 promote-from-run export);
- ADR 0898 (the eval-fixture opt-in and the scripted agent);
- ADR 0929 (RFC 0245, a recorded failure served as an error);
- ADR 0977 (the counter tool and its one live door).

## Decision

**D1 — The source is the run's own event log.** The agent-side boundary is
`agent.tool-called.inputs` (the arguments as the agent passed them) paired by
`callId` with its `agent.tool-returned`. It is never an egress request, so a
credential the host resolved after the call cannot enter a derived entry
(RFC 0252 §D, SR-1).

Rejected: the ADR 0889 D9 capture store (`agent:tool-boundary`). It is opt-in
per agent and off by default, it truncates results to 16,000 characters, and it
sanitizes free text, so it does not hold the calls "as executed".

**D2 — A source is usable only if every call is held completely.** The source
must be terminal and hold at least one invocation of the eval's agent. Each of
that agent's calls must carry its inputs and a return:
- a success with `outcome` becomes `{tool, args, argsMatch: "exact", response: outcome}`;
- a return with status `error`, `failed`, `forbidden` or `rate_limited` becomes
  `isError: true`, with the recorded `error` (or `{code: <status>}`) as the response.
  That is allowed only while this host advertises `fixtureErrors` (RFC 0245).

A success recorded without `outcome`, a call without a return, or a call
without inputs makes the whole run unusable. A guessed response would turn a
replay into a different test. Delegates (other `agentId`s) are excluded, which
is the RFC 0244 §A default.

> **Correction 2026-10-26 (D7, OQ1 resolved):** the live-lane consequence below
> no longer holds for an agent whose capture is ON. D7 records each of its calls
> host-internally, so such a run can be a source. The wire is unchanged.

**Consequence, stated plainly:** this host's live dispatch lane never sets
`outcome` on a successful tool return (WFAU-4; RFC 0064 §F allows that), so a
live agent's run is not usable as a source today. The scripted agent's counter
calls do carry `outcome` (ADR 0977 D4), which is what the scenario uses.
Recording the as-executed result for the live lane is the follow-up that would
widen this (see Open questions).

**D3 — One refusal for every unusable source.** The refusal is
`400 validation_error`, message "A fixtureRuns source run is not usable for this
eval.", details `{field: "fixtureRuns"}`, with no id and no reason. The same
answer covers every case, so another tenant's run is indistinguishable from no
such run (RFC 0252 §C, the RFC 0251 §C pattern):
- an id that does not decode;
- an unknown or unreadable run;
- a run outside the eval's tenant;
- a run whose payload this caller may not read;
- a run that is not terminal, never invoked the agent, or is not fully held.

The source reader is built in the `/runs` handler and asks what a run read
asks:
- `loadReadableRun` for the scope and the tenant, never through a stream token;
- the same tenant as the eval, even for a wildcard operator who may read across tenants;
- `runPayloadReader`, because a member who is not an admin reads only their own
  run's payload (#4543), and replayed tool answers are payload.

Callers without a request (the eval node pack, the agent tools) pass no reader,
so any `fixtureRuns` they were handed is refused the same way.

**D4 — Request rules before the run exists** (RFC 0252 §B). These are refused
with `400 validation_error`, `field: "fixtureRuns"`:
- `fixtureRuns` on a non-eval create, in either major. This rides the ADR 0983
  D1 refusal (RFC 0251's `evalModes` / `baselineRunId`): one list, one message,
  `fixtureRuns applies only to mode "eval"`;
- a non-object or an empty map;
- a key that is not a `taskId` of the suite;
- a non-string value;
- a named task whose suite `fixtures` carries `toolResponses` or `onMiss` (the
  two sources are never merged);
- `live-shadow` among the requested modes. This host does not implement it, so
  the mode check refuses it first.

**D5 — The derived entries are suite content, frozen at create.** They live in
the run's reserved `metadata.eval.recordedFixtures`. The caller cannot forge
that key, and the v2 snapshot projects only `callerMetadata`, so the entries
never reach the wire. A trial substitutes them for the task's fixtures with
`onMiss: "fail"`. The scripted trial intercepts a recorded task even when its
source made no calls, so every call then misses fail-closed.

An eval run cannot be paused, resumed or forked here (409
`eval_run_not_forkable`). A host resume reads the frozen entries, never the
source, so RFC 0252 §E holds without a re-resolution path.

**D6 — Advert and wire move with the vendored schemas** (the ADR 0889 D7 rule).
`rfc0252WireAvailable()` is true when the vendored `capabilities.schema.json`
names `recordedFixtures` and `evalStarted` defines `fixtureRuns`. Only then is
`recordedFixtures` advertised and `fixtureRuns` accepted. Before the pin, an
eval create carrying it is refused `400 validation_error` ("This host does not
advertise agents.evalSuite.recordedFixtures"), which the RFC's MAY permits.

The `/runs` handler takes the eval branch before the closed v2 root-key check,
so `fixtureRuns` needs no entry in `V2_CREATE_ROOT_KEYS`. The capability check
in `createAgentEvalRun` is the gate. (The P1 draft also exempted it in the
closed-key check. That code could not run and was removed in the rebase onto
ADR 0983.) `eval.started` carries the map verbatim either way. Until the
vendored `evalStarted` defines it, the v2 projector places it under
`vendor.openwop-app`.

**D7 — An eval run of a live agent is a source, through a host-internal
as-executed record (OQ1, resolved 2026-10-26 by the user, relayed by
openwop-be).** RFC 0252 §C requires the host to HOLD every call as executed,
not to put it on the wire. So every wire event stays as it is (`argsHash`, no
`inputs`, no `outcome`), and run readers, webhooks and exports see nothing new.

- **Where it records: the live eval trial lane only.** That lane emits
  `agent.invocation.started` and ends terminal, so its runs can pass D2. With
  the agent's ADR 0889 capture switch ON (`agent:eval-capture`, off by default),
  `maybeRecordExactCalls` wraps the trial's executor OUTSIDE the fixture
  interceptor, so each row holds what the agent's tool loop received. A
  trial that SERVES fixtures (suite or recorded) is not recorded: its rows
  would be an unlinked copy of another run's content with a fresh retention
  clock, and chained replays would keep it alive past its source. A tool that
  throws is recorded with the content the dispatcher reports for it. The
  workflow and chat lanes record nothing new: they emit no invocation event,
  so a record there would be content that nothing can use.
- **What a row holds.** The input as passed and the returned `content`, SR-1
  stripped (`stripSecretsFromPersisted`), with no cut and no free-text pass
  (D1's two reasons). Also the `callId` and `computeArgsHash(input)`. A call
  over `MAX_EXACT_BYTES` (100,000 UTF-8 bytes) per side is kept
  `complete: false`, without content. A run past `MAX_EXACT_CALLS_PER_RUN`
  (200) is marked over the cap and is never a source.
- **Where it lives.** It is kind `exact` in `agent:tool-boundary`, keyed
  `<tenant>:#x:<runId>:…`, outside the capture readers' `<tenant>:<runId>:`
  scans. The run delete cascade has its own pattern for it (`runKvKeys.ts`).
  The 30-day TTL, the retention purger (`confidential-pii`), tenant teardown
  and subject erasure also cover it.
- **Pairing.** A provider may reuse a call id (Gemini restarts its ids each
  round), and a gate answers with a return and no call. So a return pairs with
  the oldest unanswered call of its id, in log order. The i-th hash-only call of
  an id takes the i-th record of that id, and the counts must agree. A record is
  used only when it is complete, its tool and `argsHash` equal the event's, and
  its error flag agrees with the return. Anything else gets the D3 refusal.
- **Who may use it.** A source that yields record-derived entries is usable
  only by the user who ran it (`metadata.actingUserId`). An operator who may
  read another member's run never saw its tool results, and a replay could echo
  them onto the new run's events.
- **The copy.** The entries a create derives from a record are frozen in the
  same store (kind `frozen`), never in run metadata. They are keyed under the
  SOURCE run (`<tenant>:#x:<source>:#frozen:<evalRun>:<task>`) and stamped with
  the source record's oldest time. That way a copy shares its source's
  retention and erasure (RFC 0252 Security, added at the Accepted flip):
  - deleting, purging or aging out the source removes every copy;
  - erasing any of the source's record removes every copy of that source;
  - deleting the eval run removes its own copies (a second cascade pattern).

  The run's metadata keeps only `recordedFixturesStored: {taskId: sourceRunId}`.
- **A copy that is gone.** The run is refused before any trial, with
  `eval_recorded_fixtures_gone`. It is never re-derived from the source and
  never run live. The copy can disappear between create and start, or before a
  resume.
- **Readers.** `readExactCalls` is called only by `recordedFixtures.ts`, and
  `readFrozenFixtures` and `maybeRecordExactCalls` only by `agentEvalRun.ts`. A
  ratchet test pins all three. No route, export or promote path reads either kind.

**Known limits, accepted (second review, 2026-10-26).**
- *Owner identity.* The check compares the source's
  `metadata.actingUserId` (`req.userId ?? principalId` on the HTTP lane) with
  the caller's. One person on two credential kinds can show two ids (the
  two-identity-keys hazard), and is then refused their own source with the
  uniform answer. That fails closed. The chat-tool and node-pack lanes cannot
  pass `fixtureRuns` today.
- *Cascade cost.* An eval run's own copies are found by
  `…:#x:%:#frozen:<runId>:%`, which scans the tenant's D7 rows on each run
  delete. Those rows exist only for opted-in agents, at most 200 calls per run,
  and live 30 days, so the scan stays small. If it grows, index the copies
  under the eval run.
- *Crash between freeze and insert.* This leaves copies with no eval run. They
  are keyed under the source and aged from it, so they go with the source.
- *P1 pairing.* D7 changes how scripted sources pair a call with its return.
  A return now pairs with the oldest unanswered call of its id, and a gate's
  return with no call is ignored. Before, the last return of an id won. A
  scripted source that reuses call ids or has gate answers now derives
  correctly instead of mislabelling.

The response a replay serves is the content string the agent's tool loop
received, so a replay compacts it as the source did. An argument that the SR-1
pass rewrote cannot match on replay. Such a call misses fail-closed, which is
the safe direction.

> **Correction 2026-10-26 (independent review of the first D7, `bb0512484`).**
> The first version recorded in the workflow and chat capture wrapper and froze
> the derived entries into run metadata. Both were wrong:
> - Only eval trials emit `agent.invocation.started`, so no workflow or chat run
>   could ever be a source. The record was content stored for no reader.
> - A metadata copy escaped every lifecycle the source has. A subject erasure
>   would delete the source's row and leave the copy in each eval built from it.
>
> The review also found:
> - unbounded growth;
> - capture readers loading the large rows;
> - a reused call id letting a gate's refusal relabel a success as an error;
> - an operator echo path.
>
> This version fixes each. A second review found that a replay trial with
> capture ON re-recorded the fixtures it served under its own id: an unlinked
> copy with a fresh retention clock. Fixture-serving trials are no longer
> recorded, and thrown tool calls now are.

## Alternatives weighed

- **Derive from the capture store (ADR 0889 D9).** Rejected in D1: it is opt-in,
  truncated and sanitized, so it is not as executed.
- **Accept a partially held source and leave the gaps to miss.** Rejected: the
  replay would fail on the host's retention, not on the agent's change, and the
  caller could not tell which.
- **A distinct refusal per reason** (`source_not_terminal`, …). Rejected: it
  turns the refusal into an existence oracle across owners and tenants. RFC 0252
  §C requires one answer.
- **Put `inputs` and `outcome` on the live lane's wire events (D7).** Rejected:
  every run reader, tenant webhook and export would receive raw tool content for
  every live agent run, and RFC 0252 does not require it.
- **Derive from the ADR 0889 capture rows as they are (D7).** Rejected for D1's
  reasons (truncated, sanitized), and because those rows have readers.
- **Store the derived entries in a separate collection.** Rejected: the run row
  already carries the frozen eval configuration and is erased with the run. A
  second store would need its own cascade.

## Implementation plan

| Phase | What | Evidence |
| --- | --- | --- |
| P1 | `host/evals/recordedFixtures.ts` (parse, derive, the uniform refusal); `createEvalRun` resolves `fixtureRuns` into `metadata.eval`; `agentEvalRun` substitutes per trial and echoes `eval.started.fixtureRuns`; `/runs` builds the source reader and refuses `fixtureRuns` on a non-eval create (with ADR 0983's keys); `evalCapability` gains `rfc0252WireAvailable` and `recordedFixtures` | `adr0984-rfc0252-recorded-fixtures.test.ts`, 9 cases: the scenario legs host-side, in the suite's order (source, replay, drift, a probe source: +1 not +2 on `inc R`, `read P` unchanged); the uniform refusal; the request refusals; derived entries absent from a run read; the advert following the schemas; the derivation rules. Six sabotage witnesses, each red. Eval sweep: 42 files / 366 tests; create-body and run-read tests: 26 files / 243 tests. After the rebase onto ADR 0983 (RFC 0251, pin 2.46.28): eval sweep 38 files / 338 tests |
| P3 | D7: the as-executed record of live eval trials (`toolBoundary.ts` kinds `exact`, `exact-cap`, `frozen`; `maybeRecordExactCalls`, `readExactCalls`, `freezeRecordedFixtures`, `readFrozenFixtures`); the dispatcher passes `callId`; the derivation pairs in order and falls back to the record; create freezes record-derived entries under the source; the runner refuses a run whose copy is gone (`eval_recorded_fixtures_gone`, four locales) | `adr0984-d7-live-source-record.test.ts`, 9 cases, the scenario through real eval runs over HTTP: off by default; a recorded run replays with the wire unchanged and the copy in the store, and a replay trial records nothing, a drift fails closed, and erasing the source removes every copy and refuses a run that needed one; only the user who ran it may use it; in-order pairing over a reused call id; the cap and the byte limit; a thrown tool recorded as the dispatcher reports it; the workflow and chat wrapper records nothing; erasure; the reader ratchet. `adr0889-run-delete-cascade.test.ts` now deletes D7 rows on both adapters through `deleteRun` and the prune sweep. Twelve sabotage witnesses, each red (9 cases). Targeted sweep 271 files / 2,770 tests; frontend build and evals tests green |
| P2 | Bump the conformance pin to the suite that carries RFC 0252 (not 2.46.31: that release is RFC 0251's Accepted cut, #2049, and carries no RFC 0252 schema or fixture). This syncs the schemas and the three fixtures (`conformance-eval-recorded-source`, `-replay`, `-drift`), which lists them in discovery and turns D6 on. The test then asserts `eval.started.fixtureRuns` on the wire and drops its forced switch. Then deploy, and the release manager runs the certified cut | **Implemented 2026-10-26** at pin 2.46.32 (tag `v2.46.32` = `61319e27`; lock delta: the two pinned packages only). The test now runs the three VENDORED fixtures (loaded at boot, no in-test copies) against the real schemas: the advert is on without the forced switch, and `eval.started.fixtureRuns` is asserted on the wire, not under `vendor.openwop-app`. The pin also vendors `conformance-eval-gate-failing` (2.46.29, RFC 0082 §E at major 2). Listing it declares an eval-gated promote of the scripted agent, which this host does not implement (no `requiredEval`, no `eval_gate_unmet`), so it joins `UNLISTED_FIXTURE_SUITES` with that reason (honest `inapplicable`). The certified cut, run by the release manager after the deploy, is open |

## Open questions

1. **Live-lane sources.** RESOLVED 2026-10-26 as D7: a host-internal record,
   opt-in per agent, SR-1 stripped, 30-day retention, read only by the derivation.
2. **Uniform refusal of an id that does not decode.** A malformed id is refused
   with the same answer as an unknown one. RESOLVED 2026-10-26 (user, relayed by
   openwop-be): kept. Under RFC 0252 §C it is the "does not exist" case.
