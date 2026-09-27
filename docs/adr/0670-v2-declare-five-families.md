# ADR 0670 — two families declared at major 2, and the advertisement is now validated

Status: Accepted (implemented; see § Implementation record)

## Context

`conformance/major2Ledger.ts` carried six honest opt-outs — families this host
does not declare at major 2, so a `--certify` run records them `skipped
(operator declared an honest opt-out)` rather than `executed-fail`. RFC 0148 §B
forbids advertising and opting out at once, so the ledger and the advertisement
must move together.

Five of the six carried the reason **"no closed v2 record declared yet"**.

MEASURED 2026-09-13: that reason is stale for every one of them.
`schemas/v2/capabilities.schema.json` carries **89** properties and declares
all six, each as `{status, since, witness}` plus family facets. And this host
already serves the behaviour — `compensation`, `forms`, `feedback`,
`workflowChainPacks` and `connections` are all advertised and honoured on its
v1 document today.

So the opt-outs were not blocked on the corpus. They were rows whose
justification rotted when the corpus moved, and nothing made anyone re-read
them. This file's own docblock is unusually alert to exactly that failure — it
records that an earlier version of itself claimed a cross-check that did not
exist, and that `family.idempotency` shipped advertised-and-opted-out at the
same time because "the row outlived the work." It happened again, one layer
over: in the reasons rather than the entries.

The sixth, `family.sandbox`, is a genuine opt-out and stays: measured, it is
absent from this host's **v1** document too, so there is no behaviour to
declare.

## Decision — CORRECTED mid-flight, and the correction is the record

I declared **five** and the major-2 ratchet refused them. Declaring a family
**un-skips the scenarios gated on it** (`behaviorGate`), so three executed for
the first time and failed their v2 MUSTs:

| family | scenario | what it found |
| --- | --- | --- |
| `compensation` | `v2-compensation-read-projection` | *"a host advertising `compensation` MUST serve `GET /runs/{runId}/compensation`"* (security-defaults.md §Compensation). This host does not serve that route. |
| `forms` | `v2-form-when-reuses-edge-conditions` | a field carrying `when: { type: "equals", left, right }` is not honoured (form-content-packs.md §"Conditional visibility", RFC 0177 §E.4) |
| `connections` | `v2-provider-conflict` | *"the later registration of a bare provider id MUST NOT install over the qualified form"* (connection-packs.md §"Provider identity", RFC 0177 §D.1) |

So **two** are declared — `feedback` and `workflowChainPacks` — and the other
three went back on the ledger with their **measured** reasons replacing their
stale ones.

**The mistake worth recording is not the three; it is the inference.** The
ledger's original reasons were genuinely stale: the v2 records they said did not
exist do exist. From that I concluded the ROWS should go. **A stale
justification is not the same as a wrong decision**, and for three of the five
the decision was right on grounds nobody had written down. I replaced a reason I
could disprove with a conclusion I had not tested.

What caught it was this repo's own ratchet, and it caught it in the direction
that matters: advertising a family whose v2 scenario fails is a false wire
claim, which is precisely what `discovery.ts` argues against. Under-advertising
removes external verification; over-advertising removes the truth of the claim.

Declare each remaining family, removing it from the ledger in the same commit.

Each record is the v1 facets **minus `supported`**. `capabilities.md` line 39 —
"presence of the record is the claim, and a host that does not support a family
MUST omit it" — is why this host's v2 document carries **zero** `supported`
seats where its v1 document carries **168**.

**`status: 'experimental'` is deliberate.** The BEHAVIOUR is mature; what is new
is the v2 RECORD, and `stable` would assert that the v2 facet semantics are
settled when this host is among the first things to exercise them. Downgrading a
`stable` claim later is a breaking wire change; promoting an `experimental` one
is not. `until` is required whenever status is not `stable` (§8), and `2.1` is
the horizon already used by every other experimental record here.

**Every `witness` is `witnessable-gated`.** A client can drive each property from
the public wire — read a run's compensation projection, list form content packs,
post and read back an annotation, instantiate a chain pack, list connection
packs — but each needs an authenticated, tenant-scoped request. None needs a
test seam, so none may claim `seam-gated`; none is reachable anonymously, so
none may claim `witnessable-unaided`.

## The gate this exposed, which matters more than the five records

**Nothing validated the published v2 advertisement against the v2 schema.** The
schema was vendored and kept current by a drift guard; the document this host
actually serves was never checked against it. The only thing between an invalid
advertisement and production was whoever last edited `buildV2Advertisement`
reading the schema carefully.

That is not hypothetical, and it caught me inside this ADR. I wrote

```ts
deferredParameters: { supported: true },
```

copied from the v1 record — and matching what the v2 schema's own DESCRIPTION
still says, verbatim: *"When `supported: true`, the host offers …"*. The
property list says otherwise. That sub-object declares **no** `supported`
property and sets `additionalProperties: false`, so the record was
**schema-invalid**. The description is stale corpus prose; the properties are
the contract.

`test/adr0670-v2-advert-validates.test.ts` now compiles the vendored v2 schema
tree and validates the built advertisement on every run, with three companions
that keep it from going quiet: a floor asserting the schema tree is actually
present (an absent tree would validate nothing and pass), a non-vacuity check
that the five families are in the document (an advertisement declaring nothing
also validates), and a walk asserting **no `supported` seat at any depth** —
the sub-objects being exactly where one is easy to leave behind.

Sabotage-proved: restoring the invalid nested seat reddens two assertions;
deleting a declared family reddens the non-vacuity one; pointing the validator
at an empty directory reddens the floor.

## Consequences

The major-2 ledger drops from six entries to one. The remaining entry is an
honest opt-out with a measured reason rather than an inherited one.

The reusable lesson is about the ledger, not the families: **a row justified by
a fact about someone else's repository needs re-reading when that repository
moves**, and nothing in this repo made that happen. The five reasons were
correct when written and false when read.

## Implementation record

| phase | what | where |
| --- | --- | --- |
| 1 | five v2 family records | `routes/discovery.ts` |
| 2 | five ledger entries removed, `sandbox` re-justified from measurement | `conformance/major2Ledger.ts` |
| 3 | advertisement validated against the vendored v2 schema + 3 anti-vacuity companions | `test/adr0670-v2-advert-validates.test.ts` |
