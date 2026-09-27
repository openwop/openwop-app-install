# 0635 — Serve the RFC 0173 §C.1 effect-seam manifest, derived from the guard call sites

Status: Accepted

## Context

`spec/v2/facets/replay.schema.json` pins `effectSeamsManifest` to the literal
`/host/effect-seams`, and it is a **required** facet of the `replay` capability
family. So this host cannot advertise `replay` until it serves that path — which
matters more than it first appears, for a reason that only became visible by
measuring rather than by reading the family names.

**The four "missing families" are not four of a kind.** Measured against
`schemas/v2/capabilities.schema.json`:

| family | required beyond `status`/`since`/`witness` | blocked by |
|---|---|---|
| `replay` | `modes`, `effectSeamsManifest` | this manifest, absent until now |
| `interrupt` | `tokenAlgs` (items enum: `hs256` only) | opaque store-backed interrupt tokens |
| `idempotency` | — | nothing structural |
| `eventLog` | — | nothing structural |

And `replay.effectSeamsManifest` is the **same surface** as the missing floor seam
`fireEffectSeam`. So one piece of work unlocks three items that read as
independent: this manifest, that seam, and `forceEffectTransportRetry` (which
needs a manifest row to name). The ordering is invisible from a flat backlog, and
ADR 0634 records that I argued the opposite on the record first — that `replay`
was merely under-advertised and could be turned on — before measuring.

## Decision

Serve `GET /host/effect-seams`, and **derive the rows from the guard call sites**.

**Canonical, not a test seam.** It is registered in the normal route table and is
not gated on `OPENWOP_TEST_SEAM_ENABLED`. Gating it would make an advertised
capability facet point at a path that 404s for the consumer the facet exists to
inform.

**The rows are one half of a pair, and the other half is the point.**
`effect-seam-manifest.test.ts` enumerates every `assertEffectAllowed(` call site
in `src/` and fails if one is unclassified, if a declared site no longer holds a
call, or if a row is unguarded. Without it this file is precisely the artifact
#2871 already produced in this repo: a side-effect allowlist that kept claiming
protection after 55 chain nodes were retargeted off it — protecting nothing, and
reading green throughout.

That guard is not optional politeness, because **`replay.md` makes the failure
silent**: a seam omitted from the manifest is *invisible to the suite*, not an
error. Nothing external can tell an honest short manifest from a stale one. A
self-declaration whose only guarantee is that someone remembered to update it is
not a guarantee.

`guardedBy` names both mechanisms, because neither alone covers the claim: ADR
0341's typeId fast path SERVES the source run's recorded outcome so the node never
executes, and the ADR 0531 ambient-context backstop can only THROW. I checked that
this obligation is genuinely honoured here before building a witness for it.

## The corpus changes this produced

Implementation found three defects the corpus fixed in suite `2.0.0-rc.61`:

1. **The `kind` enum could not express an SMTP seam.** `smtpEgress.ts` guards a
   direct SMTP connection; `http` is false about the protocol, `provider-sdk`
   false about the mechanism, `queue` false about both. Both available moves were
   dishonest — mislabel, or omit and become invisible — which is what made it
   worth asking rather than choosing. The enum gained `smtp` and `other`, and
   `other` exists so the next host with an unlisted mechanism is not forced into
   the same corner.
2. **`kind` had no description at all**, so "the outbound effect path" read as the
   wire protocol while the five values mixed protocol with transport role. Now
   stated: `kind` is the outbound wire mechanism.
3. **`core/replay.md` described the row with different field names than the schema
   it points at** (`{ id, suppressedBy }` against `{ seam, guardedBy }`). Nobody
   was looking for this; it would have silently failed the next host that built
   from the prose instead of the schema.

An RFC erratum was also upheld: §C.1 stated the path as `/v1/host/effect-seams`
against ten unversioned statements elsewhere. Harmless on a dual-stack host, since
the negotiator rewrites unversioned major-2 onto `/v1` — and therefore invisible
until a v2-only host reads the RFC instead of the facet.

## Verification

| Claim | Sabotage | Result |
|---|---|---|
| A new guarded effect cannot reach the wire unclassified | add a real `assertEffectAllowed` call to `src/` | red |
| A dropped classification is caught | remove a call-site row | red |
| A stale row is caught | declare a file with no call | red |
| §C.1's "every row guarded" holds | set `guarded: false` | red |
| The body is a valid manifest | invalid `kind` | red |
| Required fields are enforced | drop `guardedBy` | red (two legs) |

The schema leg validates the **served body** against the **vendored** schema — not
against the TypeScript type, which would be circular, and my reading of this exact
enum is what turned out to be wrong. It also asserts the validator rejects a
known-bad body, so a mis-compiled schema cannot report a clean pass.

## What this does not do

It does not advertise `replay`. That needs `modes` stated truthfully as well, and
it should land with the `fireEffectSeam` seam so the claim arrives with the
witness rather than ahead of it.
