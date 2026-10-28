# ADR 0989 — RFC 0244 G3 eval memory tool, the host half

Status: Accepted (2026-10-26; the corpus owner reviewed the design and
pre-registered the cut).

The user approved building, training and deploying this on 2026-10-26.

Builds on ADR 0889 (the agent eval runner), ADR 0977 (the eval counter, whose
door and `outcome` exception this reuses) and ADR 0983 D6 (the named
unlisted-fixture set). It implements a contract the corpus released in 2.46.27
(`conformance/fixtures.md`, the memory tool `conformance.eval:memory`, #2042).
This host pins 2.46.31. The wire is unchanged, so no new RFC is needed.

## Context

RFC 0244 §B says a trial's memory writes are invisible to every other trial.
The fixture `conformance-eval-memory-isolation` (2 trials) has each trial read a
seeded entry, read `trial-note`, write it and read it back, all through the
reserved tool. Every seed read must return the seed, and exactly half of the
note reads must come back empty. The contract requires the tool to answer from
"the store its trials really use".

This host already gives every agent-lane trial a fresh `ephemeralMemory(seed)`
port (`agentEvalRun.ts`). Two things were missing:

1. The scripted lane, which runs every conformance fixture, built no memory at
   all.
2. The ephemeral port dropped entry ids. The contract reads and writes by `id`,
   and `AgentMemoryPort` already allows an `id` on read results and an upsert
   on write.

ADR 0983 D6 therefore left the fixture unlisted, so the row read `inapplicable`.

## Decision

**D1 — One factory, both lanes.** `runScriptedTrial` builds this trial's memory
with the same `ephemeralMemory(task.fixtures?.memorySeed)` the agent lane hands
to dispatch. A new port per trial is the isolation under test, so the tool
observes the real mechanism, not a stand-in.

**D2 — The port keeps ids.** A seed's `id` and a written `id` are stored. A write
with an `id` upserts, as the port contract says, and reads return the `id`
beside the content. The returned type adds a host-internal `get(id)`.
Production memory ports are untouched. Eval trials wire no ADR 0944 D6 read
receipts, so returning ids there changes nothing else.

**D3 — The tool** (`evalMemoryTool.ts`):
- `{op: "write", id, content}` stores the entry and returns `{id}`;
- `{op: "read", id}` returns `{id, content}`, with `content: null` when the
  trial's memory has no such entry;
- anything else is the typed error `invalid_memory_input`.

It is dispatched BEFORE the fixture interceptor, so it is never served from
`toolResponses` and never counted as a miss. The door is the counter's: a
fixture-sourced suite only (`metadata.eval.suiteSource`). A tenant suite naming
the tool gets today's path.

**D4 — `outcome` on every memory call**, the `{id}` or `{id, content}` above.
This is the ADR 0977 D4 exception, extended to one more reserved tool.

**D5 — List the fixture.** `conformance-eval-memory-isolation` leaves
`UNLISTED_FIXTURE_SUITES`. `conformance-eval-gate-failing` stays unlisted.

## Alternatives considered

- **A separate in-memory map just for the tool.** It would pass the fixture
  while proving nothing about the store trials use, which the contract forbids.
  Rejected.
- **Keep it unlisted.** That is honest, but it leaves the last causable RFC 0244
  row inapplicable when the mechanism already exists. Rejected at the user's
  decision.

## Plan and checklist

- [x] P1 — one PR:
  - D1–D5;
  - tests:
    - port ids, upsert and `get`;
    - the tool's ops and bad input;
    - over HTTP, the fixture run shows every seed read returning the seed,
      exactly n of 2n note reads empty, every memory call carrying `outcome`
      and no fixture misses;
    - a tenant suite cannot reach the door;
  - sabotage witnesses.

  Then the prod-gate m2 lane.
- [x] Cut prediction against 236c (500/0/11/379):
  `0244.trial-memory-isolated` inapplicable → executed-pass, so
  **501/0/11/378 = 890**, with nothing else moving.
- [ ] Train and deploy; certified cut; bundle to the corpus owner for the G3
  closure.

### P1 record (2026-10-26/27)

| Claim | Test | Sabotage (red when) |
|---|---|---|
| D1 each trial has its own memory | `adr0989` HTTP: seed seen twice; 2 of 4 note reads empty | one port shared across trials |
| D2 the port keeps ids, upserts, `get` | `adr0989` port test | seed `id` dropped |
| D3 before the interceptor; never a miss | `adr0989` HTTP (`fixtureMissCount` 0, suite passes) | routed through the interceptor |
| D3 door: fixture-sourced only | `adr0977` door test (nodes on): a tenant suite gets no outcome and no seed | door ignores `suiteSource` |
| D4 `outcome` on every memory call | `adr0989` HTTP | outcome omitted |
| D5 listed | `adr0989` + `adr0898` opt-in | re-added to the unlisted set |

- Typecheck is clean, and 11 related eval test files pass (153 tests). The ADR
  0983 discovery test now pins `eval-gate-failing`, not memory-isolation, as
  unlisted. All 6 sabotages went red.
- The ci.sh node statics pass. The FE lint, build and test types pass, and so
  do eventVocabulary and kicktodoWireParity.
- Prod-gate m2 (`RFC 0244` and `RFC 0251` filters): `0244.trial-memory-isolated`
  is `executed-pass` (2 assertions). Every other row is unchanged: the 0244 and
  0251 rows pass, and the inapplicable rows are the same four as before.
  **Prediction stands: 501/0/11/378 = 890.**
