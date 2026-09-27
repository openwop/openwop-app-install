# ADR 0639 — Completing the seam floor, and the four gaps that became visible

Status: implemented

## Context

`seamsFloorServed()` requires every floor operation in `SEAM_OPERATIONS` to be
served before the host advertises `openwop-conformance-seams-v2`.
`forceEffectTransportRetry` (RFC 0173 §D.2 G4) was the last unserved one, and the
profile gates a large set of scenarios through `seamsProfileAdvertised(doc)` —
including `v2-effect-seam-no-refire`, which is the only leg that exercises
`fireEffectSeam`. **Measured** by instrumenting the route: the fire seam was
called **zero** times across a full v2 lane.

## The seam

`POST /conformance/seams/sample/test/idempotency/effect-retry` issues one logical
effect to `providerUrl` and performs a transport retry of it, so the suite's
fixture provider observes two attempts. The obligation under test is that both
carry the **same** key.

**The key is resolved once and reused.** `providerIdempotencyKey()` allocates a
logical-invocation ordinal per call, because "two distinct logical invocations
MUST receive different identities". A transport retry is not a second logical
invocation — it is one effect attempted twice. Resolving per attempt would have
produced two keys and failed the leg for the right reason at the wrong layer.

**The seam forces the retry rather than provoking a failure.** `ctx.http.safeFetch`
deliberately does not auto-retry — it carries arbitrary node traffic including
non-idempotent POSTs, and silently re-sending those would be a worse defect than
the one being witnessed — and the seam cannot make the suite's fixture fail on
demand. So the seam forces the second attempt, while the thing under test (the
key and its stability) is the production derivation from ADR 0638, the same
function `stripeApi.ts` calls on every POST.

`effectId` in the 201 body comes from the **shared** `effectIdFor()` the ledger
projection uses. A consumer follows that id from the seam straight into
`GET /runs/{runId}/effects`, so two independent derivations would name different
effects while both stayed schema-valid.

## What completing the floor exposed

Advertising the profile un-skipped six scenarios. Two were host defects fixed here:

**RFC 0177 §A.1 / §B.1 — pack install refusals never existed.** Neither
`pack_engine_unsupported` nor `pack_peer_dependency_undefined` appeared anywhere
in `src/`. Two rules, both non-obvious:

- A range with **no upper bound reads as `<2.0.0`** on a v2 host. Under plain
  semver `>=1.0.0` includes 2.x, so a host running `satisfies()` would *accept*
  the pack the spec says to refuse.
- A `peerDependencies` key must be a family named by `spec/v2/declaration.json`.
  The obvious substitute — `capabilities.schema.json`'s property names — is
  **wrong**: measured, 88 properties against 86 families. So `declaration.json` is
  now vendored, following the `event-codemap.json` / `path-manifest.json`
  precedent.

**Scope, and why it is not the whole spec's scope.** packs.md says the check MUST
run "at install on every publication path". It is applied at the mirror ingest.
It is **not** applied at boot-time registry install, and the reason is measured:
**all 40** of this host's own packs declare `>=1.0.0 <2.0.0` or `>=1.1.0 <2.0.0`,
so enforcing there would refuse every pack the host ships and brick the node
runtime. That is a real, recorded incompleteness — the fix is to bump the packs'
ranges and republish, then extend the gate — not something to enforce blind.

**The era-2 seed seam addressed its fixture to an unreadable tenant.** It used
`SEED_TENANT = 'sample-era2-tenant'` for isolation; the run was also unreadable by
the caller that created it, so every seed-then-read scenario got `403
id_tenant_mismatch` from the id-only tenant check. `fireEffectSeam` had the
identical defect and was corrected first — this site was not swept at the same
time, which is the recurring shape of a class fixed at one instance.

## The four that remain, declared not hidden

Fixing the 403 moved those scenarios from "refused" to "answered", which exposed
three deeper obligations, and a fourth alongside them. All four are recorded in
`scripts/conformance-v2-known-red.txt` with their measured symptoms:

| Scenario | Obligation | Symptom |
| --- | --- | --- |
| `v2-unmapped-type-refused` | persistence.md §"The reader rule" — an unmapped, unprefixed era-2 type MUST fail the read `500 event_type_unmapped` | reads tolerantly, answers **200** |
| `v2-v1-events-translated` | replay.md — a fork whose prefix holds an unmapped type MUST fail the read | **404** |
| `v2-fork-a-v1-run` | replay.md §"Forking a v1 run" — a v2 host MUST fork a run created before the cut | **404** |
| `v2-pinned-run-disposition` | persistence.md §"Runs pinned to v1" — a run pinned to an unimplemented change id MUST be cancelled | followed silently |

**These are not new.** They are pre-existing MUST violations that were
soft-skipping behind an unadvertised profile. The first two share a root cause:
the era-2 translation never refuses, so it binds **every** reader (poll, SSE,
fork, replay divergence, debug bundle, summary memory) and is a storage-boundary
change, not a route patch.

## Alternatives weighed

- **Withhold the seams advert to keep the lane green.** Rejected. It turns the
  lane green by making the host *unverifiable*, which is the direction
  `routes/discovery.ts` argues against in its own comment: "Under-advertising is
  not the safe direction. It removes external verification of behaviour that is
  actually shipping."
- **Mark the seam `served: false`.** Rejected as simply false — the route exists,
  is mounted, and is tested against a real fixture provider.
- **Fix all four here.** Rejected on coherence, not size: they are one unit (the
  era-2 reader rule plus its two dependents, and the pinned-run disposition) and
  belong in a focused change with its own witness, rather than appended to a seam
  PR whose gate they would dominate.

## CORRECTION 2026-09-06 — "`blocked` passes" was wrong, and the method it implied was worse

This ADR and its PR described the sabotage as showing that *"a sabotage cannot
show this — breaking the seam yields a `blocked` soft-skip, which passes, so the
lane reads identically whether the seam works, is broken, or is never called."*

**The first clause is right and the conclusion drawn from it was wrong.**
`v2-effect-seam-no-refire` does record `blocked` on a non-201 `fire`. But
`blocked` does **not** pass at the level that decides anything: in
`certification-bundle-verify.ts`, `notCertifiable` is exactly
`{blocked, executed-fail}`, and a profile's `certified` is
`derivable ∧ evidenceValid ∧ every required row certifiable`. A `blocked`
required row denies certification — RFC 0168 §C.1's rc.62 erratum calls it
bundle-wide fatal, which is why blocking on an unclaimed instrument once denied
certification to hosts that had merely not mounted the seams.

So the corpus **already** draws the distinction this ADR said was missing:

| State | Disposition | Consequence |
| --- | --- | --- |
| seam advertised, does not answer | `blocked` | **no certification** |
| profile unadvertised | `inapplicable` | benign |

Both are green on the vitest lane. **The lane counts `it`s; the bundle carries the
verdict.** What the sabotage actually demonstrated is not that the distinction
does not exist — it is that `71/71` was never the verdict, and I asked the one
instrument that structurally cannot answer.

**The correct method is therefore cheaper than the one recorded here**, and worth
stating because a future reader would otherwise reach for instrumentation first:
run `--certify` and read the RFC 0148 §A dispositions. Instrumenting the route is
still the right tool for "was this code path entered at all", which is what the
`0 → 1` fire-seam measurement needed; it is the wrong tool for "did the suite
accept this", which the bundle answers directly.

The narrower true gap: the four skip branches carry distinct notes already
(family gate, seams gate, no guarded row, empty ledger) and a cut bundle names
which fired — but the **lane log does not surface it**. That is a reporting gap,
not a disposition gap.

**Also strengthened, not corrected:** the peer-dependency trap above is worse than
"88 against 86". The sets are not nested. Measured on the vendored files: **17
capability properties are not families** (a host reading peer-deps off
`capabilities.schema.json` would ACCEPT `peerDependencies: { protocolVersion: … }`,
which `packs.md` says to refuse) and **15 families are not capability properties**
(it would REFUSE a pack legitimately requiring `chat`, `canvas`, `brand`,
`coordination`, …). A host using the schema fails in **both directions at once**.

## Implementation record

| Change | Site |
| --- | --- |
| The seam | `src/routes/effectTransportRetrySeam.ts` |
| Shared `effectIdFor()` (was duplicated in the projection) | `src/host/effectIdentity.ts` |
| Pack install gate (engine range + peer deps) | `src/host/packManifestV2Gate.ts` |
| Applied at mirror ingest | `src/routes/packs-test.ts` |
| Two error codes registered | `src/types.ts` |
| `declaration.json` vendored | `scripts/sync-schemas.sh`, `schemas/v2/declaration.json` |
| Seed seam uses the caller's tenant | `src/routes/eventLogSeedSeam.ts` |
| Seam tests against a real recording provider (3) | `test/v2-effect-transport-retry-seam.test.ts` |
| Floor-ledger + env-var guards updated | `test/v2-conformance-seams-mount.test.ts` |

Sabotage-checked: varying the key per attempt turns the seam's fixture test red.
The floor-ledger assertion is now `[]`, so it gained a **denominator** check — an
empty `missing` is also what a `SEAM_OPERATIONS` that lost its floor rows would
produce. The "env var alone cannot turn the claim on" leg asserted *absence* and
passed only because a floor seam was unserved; it now asserts **irrelevance** in
both directions, which is strictly stronger than what it replaced.
