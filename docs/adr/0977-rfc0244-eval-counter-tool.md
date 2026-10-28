# ADR 0977 — RFC 0244 eval counter tool, the host half

Status: implemented (P1 #5225, merged 46cca1e28 2026-10-26; live on fc9f666ed rev 01045-hcc; certified cut 226c). Design reviewed with /architect 2026-10-25; two blocking findings and three notes folded in below.

The user decided (2026-10-25) to build this after suite 2.46.25 shipped, rather than
hold the release for it. Approvals for RFC 0249/0250 do not extend to this work:
trains and deploys need the user's own go.

Builds on ADR 0889 (the agent eval runner) and ADR 0898 (the eval-fixture opt-in).
It implements a contract the corpus has already released (2.46.25,
`conformance/fixtures.md` §Eval-suite fixtures, RFC 0244 G2). The wire is
unchanged, so no new RFC is needed.

## Context

RFC 0244 §D says a fixture miss under `onMiss: "fail"` never reaches a live tool,
and that a served entry is consumed once. Until 2.46.25 nothing could observe
either claim: a scripted call that reached a "live" tool looked exactly like one
that did not. Gap G2 closes that with a reserved, effect-free counter tool,
`conformance.eval:counter`, and two fixtures that drive it:

- `conformance-eval-counter-live` (`onMiss: "live"`): `inc L`, `inc L`, `read F`,
  `read S`. All four calls miss and reach the live counter.
- `conformance-eval-counter-miss` (`onMiss: "fail"`): `inc S` three times against
  two exact entries (`{served:1}`, `{served:2}`), then `inc F`.

The suite runs live → miss → live. Three rows ride on it:
- `0244.live-miss-counted`: `fixtureMissCount > 0`, and the two `L` counts are
  consecutive;
- `0244.first-unconsumed`: served 1, then served 2, then a tool error;
- `0244.miss-no-live-call`: the second live run's first `L` equals the first run's
  last `L` plus one, otherwise `blocked`. Its `F` and `S` reads must be unchanged.

A host lists these fixtures in discovery to opt in. Three things about this host
stand in the way today:

1. **No live path for fixture suites.** `fixtureInterceptor` honours
   `onMiss: "live"` only for a tenant suite (ADR 0889 A10).
   `runScriptedTrial` passes `allowLive: false`, so every scripted miss fails
   closed, and the "live" fallback would be `echo` anyway.
2. **No `outcome` on `agent.tool-returned`.** The scripted trial never sets
   `outcome` (WFAU-4; RFC 0064 §F makes it optional). The counter legs read the
   count from it.
3. **The loader lists every file in `eval-suites/`.** A plain 2.46.25 pin bump
   would therefore list both counter fixtures, opting this host in with no counter
   behind them. The three rows would then fail rather than stay inapplicable.

## Decision

**D1 — The counter store.** A `DurableCollection` named `eval-counter`, one row
per `(tenant, owner, key)`: `{k, tenantId, count, updatedAt}`.
- The key is `${tenant}::${ownerHash}::${key}`. `ownerHash` is the first 32 hex
  digits of sha256 over the run's RFC 0165 owner stamp (principal, subject issuer,
  subject id), so the key grammar never carries raw principal text.
- The hash input is the stamp as stored at run creation, never re-resolved,
  because a resumed trial has no request: `principal`, `subject.issuer` and
  `subject.subjectId`, joined with `\n`.
- Input: `key` matching `^[A-Za-z0-9._-]{1,64}$` and `op` ∈ {inc, read}. Anything
  else is a typed tool error, `invalid_counter_input`.
- An eval run without an owner stamp hashes the literal `anonymous`, which is still
  per tenant.
- `inc` is a compare-and-swap, bounded at 8 attempts like ADR 0973 D2. Losing every
  attempt is the tool error `counter_contention`, never a silent no-op.
- `read` is a point `get`; a missing or aged-out row reads 0.
- Retention: `registerKvAgeOut` with `ttlDays: 1` on `updatedAt`. The contract's
  floor is one hour, and rows are tiny.
- Teardown: a prefix purge hook, the ADR 0973 pattern. The tenant-id grammar check
  moves out of `hostEventLog.ts` into a shared helper so both use one rule.

**D2 — The counter is the only live tool a fixture suite can reach.** This is a
tool, not a policy change:
- `fixtureInterceptor`'s `allowLive` becomes a predicate over the tool name.
- Tenant suites keep `() => true`, which is unchanged behaviour.
- `runScriptedTrial` passes `(name) => name === COUNTER_TOOL`, and only for a
  fixture-sourced suite.
- **The door is keyed on the suite's source, not the agent** (architect pass). Under
  the conformance posture the scripted agent is in the public registry, so a
  tenant suite can target it, and `runTrial` routes it to `runScriptedTrial`. The
  predicate therefore reads `meta.suiteSource === 'fixture'` from the run's
  reserved `metadata.eval`, which the caller cannot forge (ADR 0889 A3).
  A test pins that a tenant suite whose script calls the counter under
  `onMiss: "live"` fails closed.
- In a scripted trial, the "inner" tool is the counter for that name and `echo`
  for everything else. A non-counter miss under `onMiss: "live"` therefore still
  fails closed, as today, and no scripted call reaches any other live tool.
- The counter reads no tenant data and has no external effect, which is why
  fixtures.md calls it safe on a production tenant.

**D3 — Fail-closed is decided per miss, not per task.**
- The interceptor counts misses by how they were answered: `liveMisses` and
  `failMisses`.
- `fixtureMissCount` is still the total, so `live-miss-counted` sees `> 0`.
- The trial fails only on a fail-closed miss. This mirrors `runTrial`'s existing
  `failClosed` rule, which `runScriptedTrial` did not apply because every scripted
  miss was fail-closed. A regression test pins `conformance-eval-fixture-miss`
  unchanged: `fixtureMissCount: 1`, `passed: false`, `score: 0`.

**D4 — `outcome` only for counter calls.** `agent.tool-returned` for a
`conformance.eval:counter` call carries one of:
- the live `{key, count}`, as the parsed object;
- a served entry's `response` verbatim;
- on a fail-mode miss, `error` (as today) and no `outcome`.

Every other tool keeps today's shape. The WFAU-4 note ("this host never sets
`outcome`") gains a correction naming this one exception. The schema types
`outcome` as free-form, so no payload admission changes.

**D5 — Opt-in is honest.** The counter fixtures are listed because the counter ships
in the same PR. Nothing else changes in the loader. A test pins that the listed
ids equal the vendored `eval-suites/*.json` set, so listing stays exactly the opt-in.

> **Correction (architect pass, 2026-10-25):** the first draft said "a fixture
> whose script names a reserved `conformance.eval:*` tool the host does not
> implement is not listed." Every existing fixture scripts `conformance.eval:lookup`,
> `refund`, `refund-all` or `note`. Those are never live tools: each call is
> answered from a fixture entry or by echoing its own arguments. The rule would
> have delisted all six fixtures and turned about 14 passing rows inapplicable.
> Removed.

**D6 — Prod posture.** Nothing new to configure. The counter fixtures are listed
exactly when the other eval fixtures are: under the conformance posture or under
`OPENWOP_CONFORMANCE_EVAL_FIXTURES=true`, which production already sets (ADR 0898).
No env change is needed.

## Alternatives considered

- **Counter state in process memory.** This fails "persists across eval runs" on a
  multi-instance service, or after a redeploy between runs A and C. Rejected.
- **Let fixture suites reach any live tool under `onMiss: "live"`.** This would
  undo ADR 0889 A10 for every conformance suite. The reserved tool is the narrow
  door the contract asks for. Rejected.
- **Set `outcome` on every scripted tool return.** That is a wider wire change than
  the contract needs, and ADR 0929 D2 rejected placeholder outcomes. Rejected.
- **Key by tenant only.** This is simpler, but two principals on one tenant would
  share a counter, and the contract scopes it to the owner triple. Rejected.

## Risks

- **Two concurrent cuts on one tenant** interleave counter increments. The
  persistence leg then records `blocked`, as fixtures.md specifies; this is not a
  host defect.
- **A trial that crashes mid-script is re-run on resume** (a trial is recorded
  only when complete). An `inc` before the crash is then counted twice. This only
  matters inside a conformance run, where the leg goes `blocked` or fails. It is
  accepted rather than adding per-call idempotency keys, which would leave counter
  rows behind on every resume.

## Plan and checklist

- [x] P1 — one PR: pin `^2.46.25`; sync schemas and fixtures at `v2.46.25`; D1–D5;
  tests:
  - counter `inc`/`read`/zero/owner scoping/CAS exhaustion;
  - the interceptor's live predicate (counter live, other tools fail closed, tenant
    suites unchanged);
  - per-miss fail-closed;
  - `outcome` on counter returns only;
  - ~~loader honesty (a fixture naming an unserved reserved tool is not listed)~~
    (dropped with the D5 correction; the opt-in test pins listed ids = vendored files);
  - sabotage witnesses for each.

  Then the prod-gate m2 lane with `OPENWOP_LEDGER_PATH`.
- [x] Cut prediction vs the 2.46.24 cut: the four new 2.46.25 rows
  (`0244.efficiency-tool-calls`, `live-miss-counted`, `first-unconsumed`,
  `miss-no-live-call`) are new rows, not flips. Diff `requirements.json` before
  predicting.

### P1 record (2026-10-25)

| Claim | Test | Sabotage (red when) |
|---|---|---|
| D1 store counts, `read` does not move it, unknown key reads 0 | `adr0977-rfc0244-eval-counter` D1 | `inc` writes `count: 1` |
| D1 scoped by owner and tenant | same, "is scoped by owner and by tenant" | owner hash dropped from the key |
| D2 the door is keyed on `suiteSource`, not the agent | `adr0977-counter-door-tenant-suite` (conformance nodes ON) | `counterDoor = true` |
| D3 only a fail-closed miss fails the trial | E2E live → miss → live | trial fails on any miss |
| D4 `outcome` on counter returns | E2E | `outcome` omitted |
| §D a served entry is consumed once | E2E (run B `{served:1}`, `{served:2}`, then errors) | `consumed` never set |

- Typecheck clean; the new tests plus the related eval tests (ADR 0889 runner and
  run-suite node, ADR 0898 opt-in, RFC 0245 fixture errors, ADR 0973) all pass:
  7 files, 66 tests. All six sabotages went red and were restored.
- The ci.sh static checks, the frontend lint/build/test-types and the
  eventVocabulary/kicktodoWireParity tests all pass.
- Prod-gate m2 (`--filter "RFC 0244"`, conformance nodes and mock provider OFF, prod
  opt-ins ON): `efficiency-tool-calls` (8 assertions), `live-miss-counted` (2),
  `first-unconsumed` (3) and `miss-no-live-call` (3) are all `executed-pass`, and
  every earlier 0244 row is unchanged.
- `requirements.json` 2.46.24 → 2.46.25: 2840 → 2844 ids, +4, none removed.
  **Cut prediction: 491/0/11/373** (+4 pass vs cut 222c, 487/0/11/373).
- [x] Train and deploy on the user's go; certified cut; send the bundle to ec for
  the G2 closure PR.

### Ship record (2026-10-26)

| Step | Result |
|---|---|
| Merge | #5225 → `46cca1e28`, train 226r (main `fc9f666ed`, tree equal to the gated tree) |
| Deploy | 226b: `fc9f666ed` on rev `01045-hcc`, suite 2.46.25. Discovery gained exactly `conformance-eval-counter-live` and `-miss`; PRM unchanged |
| Cut | 226c **certified, 491/0/11/373 = 875**, exactly as predicted. Bundle sha256 `be8b62d16879`, witness `43d9a6d1ebee`, signed `openwop-app-bundle-2` |
| vs 222c | +4 new rows, all `executed-pass`: `0244.efficiency-tool-calls` (8 assertions), `live-miss-counted` (2), `first-unconsumed` (3), `miss-no-live-call` (3). 0 moved, 0 gone, claimedProfiles identical |
| Spec | Bundle sent to the corpus owner for the RFC 0244 G2 closure PR |

The follow-up pin to 2.46.26 rides with this record. It adds two RFC 0244 rows
(`0244.efficiency-model-usage`, `0244.cost-every-trial`). Both read `inapplicable`
here, because the scripted agent makes no model call and the golden and trajectory
suites run no judge.
