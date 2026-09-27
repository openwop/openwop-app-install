# ADR 0642 — The v1 surface: what it actually is, and when it can go

Status: Accepted

## Context

A request to "remove all OpenWOP v1 support and deprecated code" prompted this.
The removal **cannot happen yet**, and the inventory that says why is worth
having written down before the date arrives rather than rediscovered under it.

## The decision: do not remove v1 before the overlap ends

`spec/v2/core/versioning.md` §5:

> Through the overlap a host MUST advertise both majors, MUST emit
> `OpenWOP-Version` on every response, and MUST serve `/.well-known/openwop` as
> one resource whose representation the request header selects. […] **Through the
> overlap `preferredVersion` MUST name a 1.x member.** […] v1 operations keep
> their `/v1/…` path keys unchanged through the overlap.

This host is anchored on the **v1 EOS clock, 2026-12-04**. Until then:

- A header-less request **is** a v1 client's request. Dropping `/v1/…` makes this
  host non-conformant, not modernised.
- The dual-stack conformance scenario creates a run through `/v1/runs` and reads
  it through `/runs` with `OpenWOP-Version: 2`. It is a required row.
- Ending the overlap early changes a normative MUST, which is an **RFC in
  `../openwop/RFCS/`**, not a host PR (CLAUDE.md § "A spec change needs an RFC").

## The inventory — and a correction to the number I first gave

I initially reported **838 `/v1/` references across 236 files**. That was a loose
grep counting comments, doc prose and string fragments. Measured properly — actual
route registrations, `app.<verb>('/v1/…')`:

| Class | Count | Removed at EOS? |
| --- | --- | --- |
| **v1 protocol paths** | **47** | **Yes** — these are the wire |
| `/v1/host/openwop-app/*` host extensions | 705 | **No** — non-normative, never part of the v1 wire |
| `/v1/host/sample/*` conformance seams | 43 | **No** — the suite's own addresses |
| Total registrations | 529 (102 files) | |
| Modules with a `major === 1` branch | 2 | Yes — the negotiator and the era adapter |

**The headline is that ~94% of the `/v1/` surface is not v1 protocol.** Host
extensions live under a `/v1/host/openwop-app/*` prefix by convention and are
explicitly non-normative; they outlive the major. Anyone who greps `/v1/` and
plans a deletion from the raw count will plan to delete the host's own API.

## What can be removed now, and what was

Four of five `@deprecated` markers were host-internal and are gone in this change:

- `features/assistant/chiefOfStaff.ts` — a three-function shim forwarding to
  `capability.ts`. **No production code imported it**; two test files did, and
  were migrated to `findAssistantAgent`. Two stale comments naming the file were
  repointed. File deleted.
- `observability/metrics.ts` `LOCAL_SCRAPE_CARDINALITY_LIMIT` — zero references
  workspace-wide, including none reading it as "the response's reported ceiling"
  its own docstring claimed. Deleted.

**The fifth stays, deliberately.** `routes/discovery.ts` carries a `'host.forms'`
dotted mirror whose removal condition is *"remove once `host-capabilities.md`
§host.forms shows the plain key."* That document **does not exist in the v2
corpus** (`spec/v2/core/` has no `host-capabilities.md`; forms lives at
`capabilities.md` §forms). So the stated condition cannot be evaluated, and the
key is **wire-visible** — removing it changes what this host advertises. A
capability advertisement is not the place to act on an unverifiable condition.

## The staged plan for 2026-12-04

**CORRECTED 2026-09-09, before any of it was executed.** The plan first published
here opened with *"Advertise-side first: stop naming a 1.x member in
`preferredVersion`… this is the honest signal and it is reversible."* **That step
is not a smaller first step — it is illegal.** `versioning.md` §1.1 binds two
clauses that leave no gap between them:

> **Through the overlap `preferredVersion` MUST name a 1.x member.** […] A host
> that drops v1 from `protocolVersions[]` advertises a `2.x` `preferredVersion`.

While any `1.x` remains in `protocolVersions[]`, a `2.x` `preferredVersion` is a
violation; `preferredVersion` moves **because** v1 leaves the array, in the same
change. There is no conformant intermediate. **v1 retirement is atomic.** A peer
host raised this and withdrew the same recommendation; the clauses were then read
here directly rather than taken on report.

So the ordered plan is:

1. **One atomic change**: drop `1.x` from `protocolVersions[]`, move
   `preferredVersion` to `2.x`, and retire the 47 v1 protocol paths together.
   Splitting it produces a non-conformant intermediate, not a safer rollout.
2. **Then the two `major === 1` branches** — the negotiator's contract selection
   and the era adapter's v1 read path — which are dead once nothing negotiates 1.
3. Re-cut a certification bundle; the dual-stack row becomes inapplicable rather
   than failing.

### The host-extension paths need a decision, not a default

The first version of this ADR said the 705 `/v1/host/openwop-app/*` paths are
**"never removed"**. That is right about the *wire* and wrong as guidance, and the
distinction matters on the day:

- They are genuinely non-normative — the spec neither requires nor forbids them,
  so v1 EOS does not *oblige* their deletion.
- But they carry a `/v1/` **prefix**, and `spec/v2/path-manifest.json` (51
  operations, verified) has **no home for host-proprietary paths**. After EOS the
  host either keeps a vestigial `/v1/` prefix on a host that no longer serves v1,
  or migrates them to a host-chosen prefix and breaks every existing caller.

Neither is free, and "never removed" reads as though the question is settled. It
is not. This is spec territory — every tier-2 host with a proprietary surface
meets it on the same day — and a peer has raised it upstream. **The 705 paths are
NOT part of the atomic change above**; they are a separate migration whose shape
depends on that upstream answer.

## Alternatives weighed

- **Remove now.** Rejected: breaks a normative MUST while the spec still requires
  the overlap, and un-certifies the host on a required scenario.
- **Remove only `/v1/` paths that have v2 twins.** Rejected: same breakage, and it
  would silently take host-extension routes with it on any prefix-based sweep.
- **Do nothing until December.** Rejected as the reason for this ADR — the
  inventory is the expensive part, and doing it now makes the December work a
  scripted execution rather than archaeology.

## Consequences

- The removal is a dated, ordered plan against a known clock rather than an open
  question.
- The 94% finding is the load-bearing one: it is the difference between a 47-path
  change and a 529-path catastrophe, and it is invisible to the obvious grep.

## Implementation record — the inventory is now executable (2026-09-10)

Asked to confirm there is **zero** reliance on major 1 anywhere in this app, I
re-measured from `origin/main` rather than re-reading this ADR. The answer is
**no, and it is four structural layers deep** — none of which the table above
captures, because the table counts *paths* and three of the four are not paths.

| Layer | Measured | File |
|---|---|---|
| Header-less default contract | `PREFERRED_VERSION = PROTOCOL_VERSION_V1` (`1.1`) | `middleware/protocolVersion.ts:72` |
| v2 routing | ``req.url = `/v1${req.url}` `` — v2 is a **rewrite onto the v1 handlers**, not a second route tree | `middleware/protocolVersion.ts:452` |
| Storage seat | `currentContract()` returns `1` by default — *"the v1 wire and every background worker"* | `storage/eventEraAdapter.ts:67` |
| Our own SPA | **630** `/v1/` call sites across 266 files, and **zero** `OpenWOP-Version` headers | `frontend/react/src/**` |

Two of these change the shape of the December work as this ADR described it:

1. **v2 is a façade over v1, not a peer.** Every major-2 request is served by
   prepending `/v1` and dispatching to the same handler. So "retire the 47 v1
   protocol paths" is not a deletion — the handlers must be **re-rooted** and the
   rewrite inverted, or the v2 surface disappears with the v1 one. The staged
   plan above is unaffected in ORDER but materially larger in CONTENT.

2. **The SPA cannot migrate ahead of the spec, and the blocker is measured.**
   Of its 630 `/v1/` call sites, **543 are `/v1/host/openwop-app/*`**. The v2
   rewrite allowlist is *derived* from `schemas/v2/path-manifest.json`, which has
   **51 operations and exactly 2 under `/host/*`** — both protocol surfaces
   (`/host/effect-seams`, `/host/events`), neither a vendor path. So those 543
   calls have **no v2 address at all** and would `404` under major 2. Inventing
   one (`/host/openwop-app/*`) would pre-empt the ruling the corpus steward has
   recorded as *undecided, not permissive*.

**What is already v1-free:** the vendored schema corpus — `schemas/v1` is **0
files**, `schemas/v2` is **97**.

**Why zero is not the target today.** `versioning.md` §1.1 requires
`preferredVersion` to name a 1.x member for as long as `protocolVersions[]`
carries one. A host that removed v1 now would be **non-conformant, not early** —
the same correction this ADR already carries about staging.

### `scripts/check-v1-reliance.mjs`

The half that *is* enforceable today is that the migration surface must not
**grow**, so it is now a ratchet in `npm run ci`, baselined in
`scripts/v1-reliance-baseline.json`. A hand audit is a claim with a timestamp;
this re-derives the numbers on demand and fails when a new `/v1/` call site
appears.

Direction is **per metric**, and that was a real defect caught by sabotage
rather than review: the first version ratcheted everything one way, so adding
`OpenWOP-Version: 2` to the SPA — the single most desirable step toward v2 —
failed as *"new v1 reliance"*. A check that fails the migration it exists to
enable is worse than none, because it gets cited as a reason not to migrate.
`spaOpenWopVersionHeaders` now ratchets the other way. All three legs are
independently sabotage-verified (new v1 call site → fail; v2 header added →
pass; v2 header removed → fail).

### Correction (2026-09-10) — the SPA call-site count was inflated by comments and tests

The "630 `/v1/` call sites across 266 files" above, and the ratchet baseline
first cut from it (87 protocol / 543 host-extension), came from a grep that
counted every occurrence of the literal — in comments, doc headers and test
expectations as well as code. Re-measured on the same tree with comment lines
dropped and test files excluded: **14 protocol + 328 host-extension call sites
in code.** The four structural layers stand unchanged; the count does not. The
instrument was corrected in ADR 0647's PR after it reported a migration as a
regression and was re-baselined over before the numbers were read — the
failure mode this ADR's own inventory warns about, in the tool built to police
it.
