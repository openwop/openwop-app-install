# ADR 0290 — Data-residency admission-control gate (host tier-1 witness)

**Status:** Accepted
**Date:** 2026-07-06
**Depends on:** RFC **0129** (data-residency, Active), ADR 0262 (CDP program + rulings), ADR 0268 (CDP-F purpose/consent — the sibling privacy-label gate), ADR 0269 (RFC 0128 purpose-propagation advert precedent), `routes/runs.ts` (the single run-admission owner), `routes/discovery.ts` (the capability advert)
**Part of:** CDP program (ADR 0262). Privacy/residency track.

## Why this exists

RFC 0129 (data-residency) is **Active** on the OpenWOP spec. It says a host MAY advertise
the regions it can serve and, when it does, MUST honor-or-reject a run pinned to a region:
a region the host does not advertise is refused at admission, fail-closed, before any run
exists. This app is a conformant host; the spec ships a tier-1 conformance scenario
(`data-residency-admission`) whose witness is exactly this gate. Without it, the app would
either not advertise residency at all (leaving the scenario soft-skipped) or — worse —
advertise it and silently accept an unadvertised region (a hollow advert that the witness
hard-fails). This ADR records the host gate that witnesses RFC 0129 honestly.

## Decision

Add a **single** data-residency admission gate, owned by the existing run-create route,
plus an honest capability advert. No new primitive, no parallel admission path.

### 1. Advert (`routes/discovery.ts`)

`capabilities.dataResidency = { supported: true, regions: [...] }` is emitted **only** when
the operator opts in — `OPENWOP_DATA_RESIDENCY_ENABLED === 'true'` AND at least one region
is pinned via `OPENWOP_DATA_RESIDENCY_REGIONS` (comma-separated, e.g. `eu,us`). Follows the
established spread-gated pattern (`...(flag ? { dataResidency: {...} } : {})`, as
`purposePropagation`/`triggerBridge` do). **HONEST-OFF:** flag unset ⇒ the `dataResidency`
key is absent entirely — the host makes no residency promise. A host that enables the flag
but pins no region stays dark (an empty-region advert is useless and dishonest).

### 2. Admission (`routes/runs.ts`, `POST /v1/runs`)

Read an OPTIONAL `residency.region` (string) from the request body. When residency is
advertised (flag on) AND the body carries a region:

- region ∈ advertised regions → proceed normally (no residency rejection).
- region ∉ advertised regions → reject `residency_unavailable` at **HTTP 422**, and create
  **no run** (no `runId` in the response). Fail-closed.
- flag OFF → ignore `residency` entirely (an unadvertised host makes no residency promise).

The gate sits immediately after principal authentication and before any run is built —
so a rejection provably creates nothing. The run-create route stays the **one** owner of
run admission; the gate is a few lines there, not a new middleware or service.

### 3. Error code + envelope (`types.ts` + `routes/runs.ts`)

`residency_unavailable` is registered in the host's `OpenwopErrorCode` union (documenting
the wire code alongside its RFC 0122 sibling `runner_unavailable`).

**Envelope shape — the important subtlety.** RFC 0129 §3 / `rest-endpoints.md` pin the
**nested** `{ error: { code: "residency_unavailable" } }` shape (the #815 "envelope-not-status"
convention, shared with `runner_unavailable`), NOT this app's legacy **flat**
`{ error: "<code>", message }` `ErrorEnvelope`. The conformance witness reads `error.code`, so
the flat form would fail it. Therefore the gate emits the nested envelope **directly** at the
route (`res.status(422).json({ error: { code, message, details } })`), exactly mirroring
`routes/runnerSeam.ts` — it does NOT route through `middleware/errorEnvelope.ts` (which would
flatten it). `details.requestedRegion` echoes the refused region; `details.availableRegions`
repeats the advertised `regions[]` (already public). HTTP status is 422 (spec allows one-of
400/404/422; the witness asserts the code + no-run, not a byte-identical numeric).

### 4. Shared source of truth (`features/cdp/dataResidency.ts`)

A pure, dependency-free module owns `dataResidencyEnabled()`, `dataResidencyRegions()`,
`dataResidencyAdvertised()`, `residencyRegionAdmissible()`, and `readResidencyRegion()`, so
the advertise-side (discovery) and enforce-side (runs) can never drift.

## Boundaries

- **Single run-admission owner.** The gate extends `POST /v1/runs`; it does not fork a
  parallel admission path. The advert lives in `discovery.ts` with the other capabilities.
- **Falsifiability scoping.** Admission-control is the CONFORMANCE-TESTED MUST. Physical
  byte-location (where data actually lands) is an operator SHOULD — a data-plane / infra
  concern, out-of-band and NOT host-enforced. This ADR adds **no** physical-residency logic;
  it would be an unfalsifiable claim in a reference host.
- **Honest-off by default.** The flag defaults off so production never claims residency until
  deliberately enabled — no dishonest wire claim, no `OPENWOP_REQUIRE_BEHAVIOR` failure.

## No new RFC needed

RFC 0129 is already Active and covers the wire surface (the `dataResidency` capability, the
`residency.region` request field, and the `residency_unavailable` refusal). This is host work
honoring an Active RFC — no protocol surface is being invented here. (`residency_unavailable`
is an RFC-0129 error code; adding it to the host's `OpenwopErrorCode` union is host wiring, not
a wire change.)

## Implementation

| Piece | Location |
| --- | --- |
| Shared enable/regions/admit helpers | `backend/typescript/src/features/cdp/dataResidency.ts` |
| Capability advert (spread-gated) | `backend/typescript/src/routes/discovery.ts` |
| Admission gate in `POST /v1/runs` | `backend/typescript/src/routes/runs.ts` |
| `residency_unavailable` error code | `backend/typescript/src/types.ts` |
| Route test (4 legs) | `backend/typescript/test/cdp-data-residency-admission.test.ts` |
| Conformance witness | `@openwop/openwop-conformance` `data-residency-admission` scenario |

## Open questions

- **Per-region routing of the run itself** is deliberately out of scope (falsifiability
  scoping above). If a future RFC makes byte-location a testable MUST, this gate is the
  natural attach point — it already resolves the admitted region before run creation.
