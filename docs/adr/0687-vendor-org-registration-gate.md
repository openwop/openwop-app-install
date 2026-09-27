# ADR 0687 — the era-2 vendor branch gates on REGISTRATION, not on shape

Status: Accepted (implemented; see § Implementation record)

## Context

`spec/v2/core/events.md:36` — "A vendor type's first segment MUST be an org
registered under `extensions` in `spec/v2/declaration.json`." This host has
never enforced the second half. `storage/eventEra.ts`'s `isVendorType` tested
the *grammar* alone:

```
^(?!openwop\.)<seg>\.<seg>(\.<seg>)?$
```

and `toContractVocabulary` uses it as the escape hatch that lets an era-2 type
the codemap does not name pass through unchanged. So every dotted lowercase
name was a "vendor type", and the refusal the reader rule requires
(`500 event_type_unmapped`) could never fire.

**Why it stayed open, and why that reason is gone.** The gap has been admitted
in `scripts/conformance-v2-known-red.txt` since 2026-09-06 with an explicit
upstream ruling *not* to tighten it: `extensions` then held only `example`,
which is reserved and never assignable, so the strict reading would have refused
**every** vendor-shaped type — measured, 31 emitted types on this host, making
any era-2 log carrying one unreadable. The steward took the registration
procedure through **RFC 0180** instead.

That has now landed on both sides:

- `openwop-app` is a **registered org**, effective from `@openwop/spec-artifacts`
  2.0.12 (`registered: 2026-09-11`); the vendored `schemas/v2/declaration.json`
  carries it alongside `example` and `myndhyve`.
- **ADR 0682** moved this host's five squatting types under it
  (`ai.message.chunk` → `openwop-app.ai.message-chunk`, and four more). Two of
  the five sat in namespaces the **protocol** owns (`node.*`, `conversation.*`),
  which is what made them worth moving regardless of this gate.
- RFC 0180 §A.4a — the proposed amendment that would have made a reader tolerate
  unregistered orgs — was **WITHDRAWN** (`openwop#1347`). The shipping reader
  rule is the registration-gated one.

## Decision

**`isVendorType` requires a well-formed name AND a registered org.** The org set
is `Object.keys(extensions)` from the vendored `schemas/v2/declaration.json`,
read once and cached exactly like the codemap beside it (this predicate is on
the per-event path of every era-2 read; a per-call file read would be a hot-loop
disk hit). A `__resetRegisteredOrgsCacheForTests` seam exists because the orgs
come from a file.

**Shape alone cannot do this job, and that is the whole point.** A protocol
event is spelled `run.started` — two kebab segments, no `openwop.` prefix —
*character for character* the shape of a vendor type. Only codemap membership
separates the two, and the vendor branch is reached precisely when membership
failed. So a grammar-only predicate accepts `node.startd`, a one-character typo
of a real protocol event, as a perfectly good vendor name and silently demotes
it to "carry it, do not act on it", with nothing anywhere reporting it.
Registration is the only discriminator available at that point.

### What this does to data already written

**Measured** (`scripts/era2-vendor-type-census.mjs`, a read-only aggregate over
`events`⋈`runs`): **1273 rows** under `ai.*`, `node.*` and `conversation.*` —
none of those orgs registered, two of them namespaces the protocol owns. After
this change, a **contract-2** read of a run containing one of those rows fails
with `500 event_type_unmapped`.

Note what the census does and does not establish, because an earlier draft of
this ADR said "1273 **era-2** rows" and the query (`:50-55`) carries **no era
predicate** — it groups the whole `events` table. The count is right; the
qualifier was not measured. What the data proves instead is stronger:
967 + 275 + 17 + 12 + 2 = **1273 = exactly ADR 0682's five types**. So the
unnamed-but-grammar-valid population *is* those five and nothing else — which is
what rules out the other 31 vendor-shaped types the old known-red note listed
(`approval.sla-expired`, `commerce.order.paid`, `host.environments.applied`,
`security.breakglass`, …). Those are fan-out and host-extension events; none of
them reaches the run-event log.

That is the specified outcome, not a regression to be worked around:
`persistence.md` §"The reader rule" and `openwop.migration.C9.3` both say a
reader that cannot translate a log must refuse it, and the alternative
(§A.4a tolerance) was withdrawn upstream.

**The blast radius is bounded by the caller, and this is load-bearing.**
`toContractVocabulary` applies the vendor branch only under `if (contract === 2)`,
and this host's header-less default is **major 1**. So the SPA and every existing
v1 client read those same rows unchanged; only a caller that explicitly asks for
`OpenWOP-Version: 2` sees the refusal. ADR 0682 stopped the count from growing
before this landed, deliberately in that order.

## Alternatives weighed

| Option | Why not |
| --- | --- |
| **Keep the grammar-only predicate** | It is the admitted MUST violation. Two conformance scenarios are red on it, and the reason for the deferral (an unpopulated registry) no longer holds. |
| **Backfill-rename the 1273 rows** to their ADR 0682 names | Rejected *for now*, and it is the genuinely close call — see below. |
| **Gate on `reservedOrgs` only** (refuse `openwop`/`vendor`/`effect-seams`/`events`, allow the rest) | Refuses the four names nobody writes and admits every typo. It reads like enforcement and gates nothing — the exact shape this repo has been burned by. |
| **Make the refusal a warning/telemetry counter** | "Success with a warning" is the tolerant reader RFC 0176 forbids, and this repo's own non-negotiable: invalid input is a typed failure, never success-with-empty. |

**On the backfill.** Rewriting the 1273 rows in place would make them readable
at contract 2 instead of fatal, and it is tempting. It is deferred, not
dismissed, because (a) the rows are only unreadable to a caller that opts into
major 2, which today is the conformance lane and nothing else; (b) an event log
is the replay substrate — rewriting a `type` column changes what a `:fork`
replays, and that deserves its own decision with its own witness, not a
subordinate clause in this one; and (c) the honest refusal is what makes the
population *visible*. If a v2-native client surface lands and those runs matter
to it, that is the moment for a migration ADR — with the census script here as
its measurement. **Falsifiability:** the first v2-native client surface that
reads historical runs turns this deferral into a migration ADR — until one
exists, the only caller that can see the refusal is the conformance lane.

## Implementation record

| Phase | Change | Witness |
| --- | --- | --- |
| P1 | `isVendorType` gates on `registeredOrgs()` (`storage/eventEra.ts`) | `test/v2-era2-unmapped-type-refused.test.ts` 3/3 |
| P2 | Un-skip the local witness; add the **discrimination** leg | see below |
| P3 | `conformance-v2-known-red.txt`: delete one admission, REWRITE the other's reason | `scripts/check-conformance-major2.sh` (a stale admission fails the gate) |
| — | Fail loud on an unreadable registry; split `orgsFromDeclaration` out to witness it | 2 unit legs + a sabotage |
| P4 | The fork's inherited prefix copies the source `timestamp` | `v2-fork-a-v1-run.test.ts` + a sabotage |
| P5 | `deploy.sh` gates on the major-2 ratchet | 3 cases in `test-deploy-gates.sh` + a sabotage |

### Finding 2 — one owner for `declaration.json`, and the drift it exposed

The review found **three different relationships to one pinned file**, which is
the "second owner" shape this repo treats as a lead defect:

| site | was | now |
| --- | --- | --- |
| `host/packManifestV2Gate.ts` | reader + own cache + own `locateRepoSchemasDir` sentinel (`ai-envelope.schema.json`) | reads `declaration()` |
| `storage/eventEra.ts` | a **second** reader + cache + sentinel (this ADR's first draft) | reads `registeredOrgs()` |
| `host/discoveryExtensions.ts` | **hand-copied literals** — did not read the file at all | reads `reservedOrgs()` |

`host/specDeclaration.ts` is now the single owner.

**The hand copy had already drifted, and nothing could see it.**
`V2_RESERVED_ORGS` was `new Set(['openwop', 'vendor'])` while the pinned file
carries `["openwop","vendor","effect-seams","events"]` — so `registerV2Extension`
would have accepted `effect-seams.*` and `events.*`, two orgs the corpus
reserves. A literal mirror of a pinned artifact has no failure mode; it does not
break at the pin bump, it just starts disagreeing. That is the argument for the
shared owner, and it is why this was folded in here rather than filed: a
newly-authoritative reader of `extensions` standing beside a stale mirror of
`reservedOrgs` is exactly the two-systems-for-one-concept outcome the change was
supposed to remove. `reservedOrgs()` fails loud on an empty list for the mirror
reason of `orgsFromDeclaration` — an empty reserved list would let an adopter
claim `openwop.*`.

### "Both known-reds share one root cause" was wrong — and finding out fixed a second defect

The plan said the tightening closes **both** admitted scenarios, "which share one
root cause". Measured on the major-2 lane, that was half right in a useful way:

| scenario | before | after the refusal | after the fork fix |
| --- | --- | --- | --- |
| `v2-unmapped-type-refused` | red | **✓ 3/3** | ✓ 3/3 |
| `v2-v1-events-translated` | red (404) | **still red, 1/3** | **✓ 3/3** |

The refusal fix *did* reach the fork — the 404 went away and the fork began
reading its inherited prefix. What that exposed was a **different defect one
layer down**, which the 404 had been hiding for as long as it existed:

```
the fork's inherited prefix: timestamp passes through untouched at sequence 0
Expected: "2026-01-15T10:00:00.000Z"    Received: "2026-09-15T02:16:41.057Z"
```

`routes/runs.ts`'s prefix-copy loop passed `type`, `nodeId`, `payload` and
`causationId` to `getEventLog().append` and **omitted `timestamp`**, so the log
applied its default `new Date()` and every inherited event claimed to have
happened at fork time. `persistence.md` §"The reader rule" says `timestamp`
passes through untouched, and `toContractVocabulary`'s own docstring says the
same — the fork path just never honoured it. A copy that re-stamps is not a copy.

Fixed here: `append` takes an optional `timestamp` documented for exactly one
caller (the fork's inherited prefix), and nothing a node can reach passes it —
`ctx.emit` goes through `normaliseEmitArgs` and the executor, neither of which
forwards one, so this is a copy seam and not a forgery seam.

**The transferable part is the sequencing, not the fix.** A defect that fails
early masks every defect behind it, and the mask is invisible while it holds: the
ledger line said "same root cause as the line above" and no evidence available at
the time could contradict it. It took closing the first defect to learn the
second existed. So the general rule — a known-red's stated cause is a hypothesis
with a timestamp, and re-measuring it is part of closing the one in front of it.

The lane now reports **490 files, 263 executed-pass, 0 red**, and
`conformance-v2-known-red.txt` is **empty**.

**The third leg is the one that makes the first mean anything.** The refusal leg
and the "a mapped era-2 log still reads" leg both pass against a predicate that
returns `false` for *everything* — one wants a refusal, the other carries no
vendor type at all. Only a **registered** vendor type arriving at the reader
under its own name shows the gate discriminates rather than simply denies.
Proved by sabotage, both directions:

| sabotage | expected | measured |
| --- | --- | --- |
| admit `foo` as registered | the refusal leg reds | 1 failed / 2 passed ✓ |
| empty the org set | the pass-through leg reds | 1 failed / 2 passed ✓ |

The local witness also had a defect of its own, found on the first green run:
it asserted `body.error.code`, while this host emits the flat `{error: 'code'}`
form. The corpus reads it through `readErrorCode`, which accepts **both** — so
the test was failing a host that was answering correctly. It now mirrors the
helper instead of picking a shape.


## Step 4 — deploy-day certification at major 2

The plan's phrasing was "set `OPENWOP_TARGET_MAJOR=2` in `deploy.sh`'s certify
invocation". **Implemented differently, deliberately**, because the suite's own
default makes the literal reading a dishonest claim.

`--target-major` **defaults to the host's `preferredVersion`** (RFC 0179), else
`max(protocolVersions[])`. So the certify bundle already certifies the major this
host *advertises*. Forcing 2 would publish a claim about a major the host does
not prefer while `/v1` is still served and preferred until the EOS clock
(2026-12-04, ADR 0669's cut switch) — the same class of dishonesty as
advertising a capability you do not honour, pointed the other way. The
advertisement moves at retirement, and the certify target follows it for free.

What deploy day actually needs is that **no build ships with an unlisted v2
red**. `deploy.sh`'s certify arm now runs `scripts/check-conformance-major2.sh`
and refuses to ship on failure. It sits inside the certify arm, so
`--skip-certify` — the documented "ship deliberately unclaimed" escape — stays
usable.

This gate only became meaningful now. While the ledger admitted two real MUST
violations, a green ratchet proved just that the gaps were the gaps we already
knew about; against an empty list it proves the v2 wire is clean.

### A vacuous assertion, caught by sabotage

The harness case for the new gate first asserted "an `exit 1` within 6 lines of
the call". A sabotage rewriting the guard to
`if bash …; then true; else true; fi` followed by `if false; then … exit 1` left
it **green** while the ratchet's result was discarded entirely — a proximity grep
measures layout, not control flow. It now asserts the call is the `if !`
condition, and the same sabotage reds it. Worth recording because the case was
written specifically to prevent this failure and did not, until it was attacked.
