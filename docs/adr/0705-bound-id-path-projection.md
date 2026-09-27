# ADR 0705: a tenant-bound id travels as one `~`-escaped path segment

Status: implemented

## Context

Conformance suite **2.2.0** ships `v2-bound-id-path-projection.test.ts`, a
major-2 scenario that needs no seam and creates one run — so it runs against
this host unconditionally. It asserts RFC 0184 §A.1: a tenant-bound id
(`<tenantId>/<opaque>`) travels as **one** path segment under a `~`-escape
projection, a host MUST accept it, MUST emit it in links, and MUST still accept
the percent-encoded form.

**This host is the measurement the RFC was written from.** RFC 0184 §Motivation
cites it by name: on 2026-09-05 a run created at `https://app.openwop.dev` under
major 2 could not be read, polled, cancelled or streamed at
`https://app.openwop.dev`. Firebase Hosting decoded the bound id's `%2F` back to
`/` before forwarding, the backend correctly had no route for a literal slash,
and every bound-id scenario recorded `blocked` — while the direct `*.run.app`
URL, one hop behind the front door, answered every read 200. We fixed our front
door; the corpus concluded the spelling itself was the defect, because handling
`%2F` correctly requires an intermediary to distinguish a percent-encoded
**reserved** octet (RFC 3986 §6.2.2.2: a normalizer MUST NOT decode it) from an
**unreserved** one (it SHOULD), and deployed front doors do not. `~` is
unreserved (§2.3), so `~2F` arrives byte-for-byte and asks nothing of anyone.

Measured on `d5c15ac7f` with the 2.2.0 pin installed: the major-2 lane ran 73
files, 72 pass, **1 red** — `v2-bound-id-path-projection`, failing its first leg
with `404 not_found for default~2F5979280b-…`. The ratchet
(`scripts/check-conformance-major2.sh`) treats an unlisted red as a gate
failure, so the bump left exactly two options: implement the projection, or
admit a live MUST violation on `scripts/conformance-v2-known-red.txt`.

### A thing worth stating rather than absorbing

**RFC 0184's `Status:` line reads `Draft` in the v2.2.0 tag**, while its
conformance scenario ships in that release and is enforced with no capability
gate. `CLAUDE.md`'s wire test is three-part — shape LOCKED, the RFC does not
itself gate advertisement, the host honours it — and it is deliberately not a
status name, precisely because a rung is the wrong instrument. This change
advertises nothing new: it adds an accepted spelling on an existing surface and
changes the spelling of links the host already emitted. So the `Draft` rung is
not a blocker here. It is recorded because a later reader comparing this ADR to
the rule is owed the discrepancy rather than left to find it; raised with the
corpus steward on the session bus rather than resolved unilaterally here.


> **CORRECTION, same day — the "exactly two options" framing above is wrong, and
> the steward's ruling is the reason.** §Context says the bump "left exactly two
> options: implement the projection, or admit a live MUST violation on
> `scripts/conformance-v2-known-red.txt`". On the corpus steward's reading
> (session bus, `00c0`) it left **one**. `identity.md` §5 is a `spec/v2/core/`
> document, so the projection is a **core MUST**, not an optional family;
> RFC 0168/0169 class a core MUST as `witnessable-unaided`, and
> `scenario-majors.json` registers the scenario at major 2 with no seam. Admitting
> a core MUST on the known-red list would have been the substitution the corpus
> forbids — so it was never a legitimate option, only an available one.
>
> The decision this ADR records does not change; the reasoning that reached it was
> weaker than the decision deserved. Recorded because the two-option framing would
> license the wrong choice next time someone reaches this file with a core MUST
> red and a deadline.
>
> **The same ruling also corrected the shape of my own objection.** I raised
> RFC 0184's `Draft` status as an ungated-enforcement concern, i.e. I was half
> looking for a capability gate. The steward's answer is that gating it would have
> been the error, and the defect is the **status line alone** — a lifecycle
> violation (`Draft` = "open PR, under discussion"; a maintainer flips `Active` on
> merge) with a named precedent in RFC 0182's `Draft → Active` plus a logged
> comment-window waiver. RFC 0183 carries the identical defect and neither appears
> in the waiver ledger. Both flips are the steward's act and David's call; nothing
> in this ADR depends on them.
>
> **On the evidence tier, so this file does not overclaim:** tonight's major-2 lane
> (73 pass / 0 red, `v2-bound-id-path-projection` executed-pass) is a
> merge-candidate branch on a laptop. It becomes tier-1 acceptance evidence for
> `Active → Accepted` only once merged and cut into a bundle — not before.
---

## RFC 0183 — the SECOND obligation, and how it was nearly missed

**Suite 2.2.0 brings two host obligations, not one.** §Context above was written
when I believed it brought one, and that belief came from a method error worth
recording in the same file as the fix.

`interrupt-approval.test.ts` went red at 2 tests, zero timeouts: the host
accepted a `refine` approval resolution and then emitted an `interrupt.resolved`
carrying neither `action` nor `refineFeedback`, and accepted a `refine` that
supplied no feedback at all. **A reader of the event log could see that a gate
resolved and never what was decided.**

| | fix | evidence |
|---|---|---|
| §A.1 | the emitted payload carries `action` | legs 1, 7 |
| §A.2 | `refine` without `refineFeedback` refused 400; `edit-accept` without `editedArtifactData` refused 400 | legs 2, 3, 4 |

Refused at **resolve** time, not dropped at **emit** time: the host cannot
record what it was never given, and accepting the resolution then emitting an
incomplete event would put the violation in the durable log, where replay
reproduces it forever.

**Both arms, though suite 2.2.0 exercises only `refine`.** §A.2 is one sentence
binding two actions. Shipping the half the suite tests leaves a rule that greps
as implemented and is not, so `edit-accept` is enforced and carries leg 4 — the
only evidence that arm has, since no scenario reaches it.

### Two process failures, recorded because neither was a coding mistake

**1. One lane answered a question about all lanes.** I ran the major-2 ratchet,
got 73 pass / 0 red, and announced on the session bus that the bump's host cost
was known. `check-conformance-major2.sh` greps `v2-*` scenario FILES. RFC 0183's
witness is `interrupt-approval.test.ts` — not a `v2-` file, therefore outside
that ratchet's field of view by construction. The ratchet was not wrong; the
inference drawn from it was.

**2. The tell was in hand and filed as bookkeeping.** `sync-fixtures.sh`
reported `conformance-approval-refine.json` as **MISSING (in pin, not
vendored)**. A NEW FIXTURE IN A PIN BUMP IS A NEW SCENARIO ANNOUNCING ITSELF.
The commit that re-vendored it discussed the nine DRIFTED files at length and
never asked what the new one was for.

**3. And one inside the tests themselves — leg 5 was a gate that could not
fail.** It claimed a non-approval kind is untouched but asserted only
`validateResumeValue`, which returns early for those kinds and never reaches
the emit helper. Sabotaging that helper left all six legs green. Retargeted at
`resolvedActionFields` directly, which is why that helper is exported. The
sabotage pass is the only reason this was found, twenty minutes after the test
was written.

### A corpus observation, raised not blocked on

**§A.1's prose says SHOULD; its scenario asserts MUST.** The RFC: *"A host that
resolves an approval-kind interrupt SHOULD record the action it applied. It is
OPTIONAL rather than required because the def serves all eight `kind` values."*
The scenario's message: *"the resolved payload MUST carry `action`"*, and the
falsifiability table lists it as a normative row. `COMPATIBILITY.md` §2.3
governs exactly this — a scenario stricter than spec text is a **suite-version**
requirement, not a spec requirement — and it is not marked as one. A host
reading only the RFC concludes it has a choice; a host reading only the suite
concludes it has none. Implemented regardless, because the behaviour is right
either way and the suite is the gate. Raised with the steward on the bus.


## Decision

Implement the projection at the two chokepoints that already exist, and vendor
the codec with a parity ratchet against the corpus's own copy.

### 1. The codec — `src/host/boundIdProjection.ts`

A copy of `@openwop/openwop-conformance` `src/lib/bound-id.ts`, **not an
import**: the conformance package is a devDependency, and making production
import the suite that grades production is the wrong direction. A copy is a
MIRROR, and an unpinned mirror drifts silently in the worst possible way — the
projection is how every bound id reaches this host and how every link leaves it,
so a one-character divergence strands ids without failing anything that looks
related. `test/bound-id-projection-parity.test.ts` imports the **oracle** and
asserts byte equality over a vector set. When the two disagree the corpus is
right by definition; the test encodes that asymmetry rather than treating them
as two opinions.

### 2. Accept — `middleware/v2Identity.ts`

One chokepoint already existed: the major-2 identity middleware, mounted once
after `authMiddleware()`, which strips the tenant segment so the shared `/v1`
handler sees the id it has always seen. It percent-decoded unconditionally; it
now tries the projection **only when the `~` marker is present**, so a legacy
`%2F` segment takes byte-identically the path it always took. `RUN_PATH`'s
character class is `[^/?#]+`, which already admits `~` — no grammar change was
needed, only a decoder.

A malformed escape (`~` not introducing two hex digits) is **`400
validation_error`, not 404**: a 404 would answer "no such run" about a request
that never named one.

The colon operation (`:fork` / `:pause` / `:resume`) rides inside the same
segment. Because the op is split off **after** decoding, both spellings work —
a client may project only the id and append `:fork` literally, or project the
whole thing and send `~3Afork`. Both land on the same code path.

### 3. Emit — `host/v2Ids.ts`

`projectV2RunIds` rewrote `eventsUrl` / `statusUrl` with `encodeURIComponent`,
i.e. `%2F` — the exact spelling that stranded every client following one of
these links at our own front door. It now projects. **Applied exactly once**:
the value there is the segment from the *v1* URL, an unbound percent-encoded
id, which is percent-decoded, bound, then projected — one projection, on a value
that has never been projected. The codec is deliberately **not** idempotent
(escaping its own marker is what makes it injective), so a second application
would silently yield a different id and strand our own links.

### 4. Three accepted spellings, deliberately

`~2F` (emitted), `%2F` (released behaviour — withdrawing it would be breaking),
and the bare decoded `/` that a normalising proxy actually forwards, which
ADR 0631's `v2-origin-decoded-bound-id.test.ts` added for the original outage.
Only the first is handed out.

## Alternatives considered

| Option | Why not |
|---|---|
| **Admit it on the known-red ratchet** | It is a live MUST on the host that motivated the RFC, and the fix is ~30 lines at two existing chokepoints. An admission is for a gap we cannot close, not one we would rather not. |
| **Import the corpus codec into production** | Makes the runtime depend on the suite that grades it. Rejected; the parity test gets the same guarantee without the dependency edge. |
| **Project at each call site** | The `persistence.md` §"The seat" failure — a wrapper some call sites bypass. Both directions already have exactly one chokepoint; use them. |
| **Switch to `~` and drop `%2F`** | Breaking. RFC 0184 is explicit that it adds a spelling and retires none. |
| **Make the codec idempotent** so double-projection is harmless | It would destroy injectivity, which is the property the escape exists for — and would make the double-projection leg pass for the wrong reason. Sabotage S-D confirms the leg notices. |

## Implementation record

| Phase | Change | Evidence |
|---|---|---|
| P1 | `sync-schemas.sh --tag v2.2.0`; pins `@openwop/openwop-conformance` + `@openwop/spec-artifacts` → `^2.2.0` in ONE commit | `check-vendored-schemas.mjs:279` requires installed == `CORPUS_TAG`; moving either alone reds main |
| P2 | `host/boundIdProjection.ts` | `test/bound-id-projection-parity.test.ts` 9/9 |
| P3 | Accept side, `middleware/v2Identity.ts` | `test/v2-bound-id-path-projection.test.ts` legs 1, 3, 6, 7 |
| P4 | Emit side, `host/v2Ids.ts` | leg 5 |
| P5 | Major-2 ratchet | 73 files, **73 pass, 0 red** (was 72/1) |

**Sabotage, measured — and the first draft of the test's own comment guessed two
of the four sets wrong, which is why they were run:**

| Sabotage | Red set |
|---|---|
| Revert the emit side (`projectBoundId` → `encodeURIComponent`) | leg 5 alone |
| Revert the accept side (always percent-decode) | legs 1, 3, 6, 7 |
| Let a malformed `~` fall through instead of throwing | leg 7 alone |
| Make the codec idempotent (skip already-projected input) | leg 4 alone |

Leg 4 needed S-D most: it asserts a **404**, which a vacuous test also gets for
free, so without that sabotage it was indistinguishable from a gate that cannot
fail. The parity test was sabotaged separately — marker unescaped → 4 red, UTF-16
code units instead of UTF-8 bytes → 3, decoder tolerating a lone `~` → 1.

## Lockfile

`npm install` under **`npx -y npm@10.9.8`**, and that pin is load-bearing again:
`CLAUDE.md`'s 2026-09-09 correction recorded "MEASURED: local npm is `10.9.8`",
i.e. the safeguard was a no-op. **MEASURED today: local npm is `11.6.2`** — the
prune hazard is live once more, and that note is corrected in this PR. Result:
701 lockfile `node_modules/` entries before and after, `added: 0, removed: 0`,
only the two `@openwop/*` versions and their integrity hashes moved.
`@openwop/openwop` (the SDK) is a separate release line and stays at 2.1.0.

## Open

- **`identity.md` §5's MUST is "every tenant-bound path parameter"**, and the
  five bound kinds are `runId`, `interruptId`, `subscriptionId`, `deliveryId`,
  `effectId`. This host's only tenant-bound **path** parameter at major 2 is
  `runId` — `v2Identity.ts` mounts one `RUN_PATH`, and `v2Ids.ts` binds the
  others in payloads rather than in paths. If a bound id ever reaches a path
  under another kind, it needs the same decode, and the chokepoint is the same
  middleware. Recorded so the next reader does not have to re-derive that the
  narrow scope was checked rather than assumed.
