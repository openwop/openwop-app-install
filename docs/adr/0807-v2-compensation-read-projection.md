# ADR 0807 — The v2 compensation read projection, and `compensation` declared at major 2

Status: Accepted (implemented)

Related: ADR 0554 (the compensation ledger and unwind), ADR 0670 (the v2
families, and why `compensation` was ledgered off), `docs/steward/V2-COMPLETION-PLAN.md` W4.

## Context

`compensation` is advertised at major 1 and has been served for a long time.
At major 2 it sat on `conformance/major2Ledger.ts` because declaring it
un-skipped `v2-compensation-read-projection`, which failed its MUST:

> a host advertising `compensation` MUST serve `GET /runs/{runId}/compensation`
> (`security-defaults.md` §Compensation; `getRunCompensation`;
> `schemas/v2/compensation-projection.schema.json`)

This host did not serve that route. The ledger row was an honest opt-out, but
it left a behaviour we ship at v1 unverifiable at v2, so it was one of the
three families between this host and a full v2 advertisement.

## Decision

1. **Serve `GET /runs/{runId}/compensation` under major 2 only.** v1 never
   defined the operation, so under major 1 it is `404`, and no new v1 surface
   appears on the twin. The read gate is the snapshot's (`loadReadableRun`:
   `runs:read` plus tenant ownership; a non-owned run is `404`).
2. **The projection is a pure function of the ledger rows the run is
   accountable for** (`host/compensationProjection.ts`). The bucketing is
   extracted from `compensationStatusForRuns` into `obligationsAccountableTo`,
   and both the snapshot's `compensationStatus` and this projection read it.
   So the two cannot disagree about which rows a run owes: a root sees its
   whole sub-run tree, and a sub-run sees its own rows.
   - `status` is the ledger's own fold. The ledger spells the manual state
     `manual`; this schema spells it `manual-intervention`, which is the only
     mapping.
   - `plan[]` is the ledger in `reverse-completion` order ("the rows ARE the
     plan", RFC 0151 §C), with `irreversibleEffect` set for an `irreversible`
     shape.
   - `attempts[]` holds one entry per resolved obligation: the attempts made,
     the outcome, when it resolved, and the reason.
3. **Declare `compensation` at major 2 and remove the ledger row in the same
   commit** (RFC 0148 §B). The record's facets are spread from the one v1
   owner (`COMPENSATION_CAPABILITY`) minus `supported`, because presence is the
   claim at v2. So the two majors cannot advertise different ordering models.
   `status: experimental`, `witness: witnessable-gated`, like the other ADR
   0670 records.

## What the projection cannot say, stated

- **Intermediate retries are not recorded.** The unwind's retry loop does not
  persist each try, so the failures before a final outcome inside one pass are
  not anywhere to project. The entry carries the count of attempts made, which
  is the number an operator reads to see how close the budget came, rather
  than a reconstructed history.
- **A row minted before ADR 0554 P2 has no `nodeId`.** The schema requires one,
  so such a row is omitted rather than given an invented id. `status` still
  folds over every row, so it is never understated.

## Alternatives weighed

- **Answer `status: "none"` with empty arrays always.** It would pass the
  suite's fresh-run leg, but it is a false claim for any run with an unwind.
  Rejected.
- **Read the projection from the `compensation.*` events.** The events are
  run-level, not per obligation or per attempt, so they hold less than the
  ledger. Rejected.
- **Add per-attempt persistence to the unwind first.** It is a real
  improvement, but a separate decision with its own storage cost. It is not
  needed to make the read honest, as long as the limit is stated.

## Implementation record

| What | Where |
|---|---|
| `obligationsAccountableTo` (extracted), `foldCompensationStatus` exported | `host/compensationLedger.ts` |
| the projection | `host/compensationProjection.ts` |
| the route, major-2 only | `routes/runs.ts` |
| the v2 record | `routes/discovery.ts` (`buildV2Advertisement`) |
| ledger row removed | `conformance/major2Ledger.ts` |
| tests: fresh run → `none` and schema-valid, unknown bound id → `404 not_found`, major 1 → `404`, the v2 record, plus the projection of a run that owes something (order, irreversible flag, attempts, the `manual` mapping, the pre-P2 row) | `test/adr0807-v2-compensation-read.test.ts` |
| the ADR 0670 negative guard moves `compensation` to the positive half | `test/adr0670-v2-advert-validates.test.ts` |
| suite scenario `v2-compensation-read-projection`: 2/2 executed-pass at major 2 (filtered lane) | `npm run test:conformance -- --filter compensation` with `OPENWOP_TARGET_MAJOR=2` |
