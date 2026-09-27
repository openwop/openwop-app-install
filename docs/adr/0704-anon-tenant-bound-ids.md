# ADR 0704 — anon-tenant runs are UNBOUND on the v2 wire, and the fix is not ours yet

Status: Accepted (implemented; see § Implementation record)

## Context

`openwop-1` reported (crosstalk `dd19`) a contradiction they found while writing
RFC 0184: `ids.schema.json#tenantId` admits an `anon:` prefix, while all five
tenant-bound id kinds spelled their tenant segment `[A-Za-z0-9._~-]{1,128}` —
which does not admit `:`. Their warning:

> **If either of you mints anon-prefixed tenants, your runIds were failing schema
> validation** and the five patterns now accept them. Worth a grep on your side.

**Grepped. This host mints them** — `middleware/cookieSession.ts:158` writes
`tenantId: \`anon:\${sid}\`` for every anonymous visitor, and `anon:` is a whole
feature surface here (ADR 0469/0470 anon operator + lead capture).

**But the warning does not apply, and the reason is worth keeping.**

## What is actually true here

`host/v2Ids.ts` guards with `V2_TENANT_ID = /^[A-Za-z0-9._~-]{1,128}$/` — which is
**narrower than `ids.schema.json#tenantId`** — and `toWireRunId` returns the id
UNCHANGED when the tenant fails it. Measured:

```
toWireRunId(uuid, 'acme')              -> acme/7f3a9c1e-…     (bound)
toWireRunId(uuid, 'anon:s7Kq2mVx9Lp4') -> 7f3a9c1e-…          (UNBOUND)
```

So this host never emitted the schema-invalid bound form because **it never
emitted the bound form at all** for anon tenants. Every anonymous visitor's run
is addressed by a bare id on the v2 wire.

**That is a conformance gap, not an isolation hole.** `host/runAccess.ts:117`
refuses `run.tenantId !== req.tenantId` independently of how the id is spelled,
so the tenant check the bound form exists to support is already enforced by a
different mechanism. The bound id is defence-in-depth here, and anon runs are
outside it.

## Decision

**Do not widen the guard yet. Ship a tripwire that says when to.**

RFC 0184 widens the five bound-id patterns to admit `anon:`. The **vendored**
`schemas/v2/ids.schema.json` on this pin does not carry it:

```
tenantId  ^(anon:)?[A-Za-z0-9._~-]{1,128}$      <- admits anon:
runId     ^[A-Za-z0-9._~-]{1,128}/…{16,128}$    <- does NOT
```

Widening `V2_TENANT_ID` today would mint `anon:x/<uuid>` — which fails the
`runId` pattern in the schema this host **ships and validates against**, so ADR
0702's payload audit would flag our own output. That is implementing ahead of the
witness, which is the rule this host adopted from `myndhyve-1` two days ago and
should not break the first time it is inconvenient.

`test/anon-tenant-bound-id-tripwire.test.ts` asserts `V2_TENANT_ID` is **exactly**
the tenant segment of the vendored `runId` pattern — derived from the schema, not
hand-copied. It is bidirectional: it reds if the guard is widened ahead of the
schema, and it will red when the pin advances and the schema is widened ahead of
the guard. Either way the next person is told, rather than expected to remember.

## Alternatives weighed

| option | why not |
| --- | --- |
| **Widen `V2_TENANT_ID` now** | mints ids our own vendored schema rejects; implementing ahead of the witness |
| **Leave it and file a note** | a note is a thing that has to be remembered; a failing test is a thing that arrives |
| **Hand-copy `^(anon:)?…` into the test as the expected future value** | a second copy of a corpus pattern, which is the drift shape `openwop-1` found in four scenarios the same week |
| **Widen and pin the audit baseline to admit the new violations** | admitting a violation to ship a fix inverts what the ratchet is for |

## Implementation record

| change | witness |
| --- | --- |
| tripwire on the guard-vs-schema invariant | 3 legs; sabotage (widening ahead of schema) reds 2 of 3 |

The non-vacuity leg matters here more than usual: it asserts that
`cookieSession.ts` still mints an `anon:` tenant. Without it, the day this host
stops minting them the other two legs keep passing while guarding nothing.

## Follow-up, owned elsewhere

RFC 0184's own scenario (`v2-bound-id-path-projection`) is **not in any published
conformance release** — checked 2.1.5 (our pin) and 2.1.7 (latest); neither
contains it, and neither mentions `~2F`. `openwop-1` asked for a host to pin the
suite and witness it; there is nothing to pin to until they cut a release.

## The tripwire fired (2026-09-17)

Suite **2.2.0** (`f2834ecd7`) vendored RFC 0184's widened grammar: every bound-id
kind's tenant segment is now `(anon:)?[A-Za-z0-9._~-]{1,128}`. The equality leg
went red exactly as designed — measured on `28a675148` merged with this branch.

**Decision (steward, 2026-09-17): keep anonymous runs UNBOUND for now.** Widening
`V2_TENANT_ID` is no longer ahead of the witness, but it would change the id every
anonymous visitor's run links carry, across the ADR 0469/0470 anon surfaces. That
is a product decision with its own review, not the mechanical follow-up the
original Decision anticipated. Isolation is unaffected: `host/runAccess.ts`
enforces the tenant check independently of the id's spelling.

The tripwire's middle leg is restated, not deleted: it asserts the corpus tenant
segment admits `anon:` **and** that `V2_TENANT_ID` is that segment with exactly the
`(anon:)?` prefix removed. It reds if the corpus grammar moves again, or if the guard
is widened without revisiting this ADR.
