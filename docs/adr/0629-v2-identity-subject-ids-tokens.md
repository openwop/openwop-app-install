# ADR 0629 — v2 identity: the Subject as owner, the tenant-bound run id, the key grammar, the token scheme

Status: implemented

v2 charter Phase 4, PR **P4-D**. Follows ADR 0625 (RFC 0165 v1.x preparation),
ADR 0628 (the era key and the storage seat) and the P4-B dual-stack wire
(`middleware/protocolVersion.ts`).

Corpus: `spec/v2/core/identity.md` §1 "The Subject is the owner", §4 "Resume
tokens", §5 "Identifier grammars"; `spec/v2/core/idempotency.md` §"Layer 1";
`spec/v2/core/runs.md` §Identity, §Snapshot; `spec/v2/core/interrupt.md`
§Tokens; `spec/v2/core/events.md` §"The envelope", §Payloads;
`spec/v2/core/persistence.md` §"Everything else a v1 host persisted"; RFC 0170
§A, §D, §E.1; RFC 0171 §A. Pinned at `schemas/CORPUS_TAG` = `v2.0.0-rc.3`.

## Context

RFC 0170 makes the Subject the required owner of a run, gives every id kind a
grammar, gives the `Idempotency-Key` a grammar and a refusal code, and gives the
interrupt resume token a versioned scheme. All four are `witnessable — unaided`:
the conformance suite drives them with nothing but an API key.

Before this ADR this host failed all four on the v2 wire, measured against
`origin/main`:

- `RunSnapshot.owner` carried `principal` and `principalKind` beside the Subject
  (RFC 0165's v1.x shape, ADR 0625) — the v2 block is closed and both are removed.
- `runId` was a bare UUID (`host/runDispatch.ts:94`) where v2 requires
  `<tenantId>/<opaque>`, and no id was checked against the caller's tenant.
- `Idempotency-Key` was free-form.
- The resume token was 32 random bytes with no scheme prefix, and an
  unverifiable token answered `404` with a code the v2 registry does not carry.
- `EventRecord` had no `schemaVersion` (`src/types.ts`), which the v2 event
  envelope REQUIRES.

## Decision 1 — the run id is a wire projection, not a re-mint. Nothing is rewritten.

**This host does not change how a run id is minted, and no historical row is
touched.** `runDispatch.ts` keeps minting a bare v4 UUID; every row, index,
foreign key and `/v1/runs/{runId}` URL keeps the id it has; there is no
migration and no backfill. The tenant-bound form is a projection applied at the
major-2 boundary in both directions:

| direction | seat | transform |
| --- | --- | --- |
| outbound | `middleware/protocolVersion.ts` (the `res.json` wrapper) **and** `host/restTransport.ts` (`sendNegotiatedRunJson`) | `<opaque>` → `<tenant>/<opaque>` |
| inbound | `middleware/v2Identity.ts`, mounted after `authMiddleware()` | `<tenant>/<opaque>` → `<opaque>`, or `403 id_tenant_mismatch` |

Both call one implementation in `host/v2Ids.ts`. There are two outbound callers
because `GET /v1/runs/{runId}` content-negotiates its encoding and therefore
sends through `res.send`, not `res.json`: a wrapper on `res.json` alone would
have missed the single most important body on the surface — the same
"wrapper some call sites bypass" failure `persistence.md` §"The seat" names for
the era adapter.

**Why not mint the new form.** A `/` inside a run id is a path separator in
every `/v1/runs/{runId}` route this host serves, a primary key in three tables,
and the value `POST /v1/runs` has returned since 1.0. Minting it would change
the v1 representation of a run id — a breaking change to a contract
`versioning.md` §1.2 says stays unchanged through the overlap — to satisfy a v2
grammar that a read projection satisfies exactly. The projection is total over
the ids this host mints (a v4 UUID is 36 characters of `[0-9a-f-]`, inside the
host-minted opaque grammar) and reversible, so the id the caller is handed is
the id it can hand back.

**Its blast radius, stated.** The projection is keyed on FIELD NAME, not on
value: `runId` and `parentRunId` anywhere in a major-2 response body, plus
`eventsUrl`/`statusUrl` on the create and fork responses. A run id sitting in a
caller-supplied `variables` or `metadata` bag under some other key is not a
`runId` field and is left alone. An id the v2 grammar cannot express — this host
mints a few host-internal pseudo-run ids such as `hostext:sync:<uuid>`, whose
`:` the opaque grammar excludes — is left bare rather than encoded into
something the inbound half could not reverse; none is reachable on the v2 path
space. **Inbound is tolerant of a bare id**: this host's own frontend and its
`/v1` clients address runs that way, the two majors share one handler, and
refusing there would be a refusal the v1 wire never had.

**A tenant this host uses is outside the v2 tenant grammar.** RFC 0132 anon
tenants are `anon:<hash>`, and `ids.schema.json#/$defs/tenantId` excludes `:`.
Such a run's id is left bare (above) and its `owner.tenant` would fail the v2
schema. Not papered over: recorded as a follow-up, because the honest fix is
either a corpus grammar that admits the separator or a host-side tenant rename,
and neither belongs in this PR.

## Decision 2 — the two v2 lanes are read back from the issuer, never re-minted

`identity.md` §A.2 adds `session` and `anonymous` to the lane enum. This host
mints both under the RFC 0165 §B.3 `api-key` FLOOR with an issuer naming the
real authority (`urn:openwop-app:session`, `urn:openwop-app:anon-surface`) —
recorded upstream as RFC 0165 G6, and the reason §A.2 exists. Re-minting would
put a lane the v1 enum does not contain onto the v1 wire.

So `runOwnerV2()` (`host/runOwner.ts`) is a READ projection over the same
persisted `metadata.owner` stamp the v1 block projects: it drops
`principal`/`principalKind`, reads the lane back from the issuer, enforces the
§A.2 biconditional (`kind: anonymous` ⇔ `lane: anonymous` — a legacy stamp
recorded `kind: anonymous` under the `api-key` floor, which the v2 schema
rejects outright), and keeps `keyClass` only on `saml`/`scim`. This is exactly
migration row `openwop.migration.C3.4`: "a v1 subject minted with the api-key
floor for a session reads back with `lane: session` only if the host attested
it". The issuer IS the attestation. Nothing is re-stamped, which is also what
§A.3 requires ("stamped at first read and MUST NOT be rewritten later").

`owner` is present on EVERY major-2 snapshot: a run this host recorded no
principal for reads with the §1.2 legacy subject (`urn:openwop:legacy`,
`subjectId: "legacy"`, lane `api-key`, kind `user`) rather than omitting a field
the v2 schema requires. `run.started`'s echo is projected by the SAME function
(RFC 0170 §A.1: "the same closed block"), at the storage seat, so the snapshot
and the echo cannot disagree — and because both sides of a fork project
identically, ADR 0628's byte-equivalent-prefix property is unaffected.

## Decision 3 — the resume token gains the scheme, and this host's v1 token is its own legacy form

Minted tokens are now `ow2.hs256.<kid>.<payload>.<mac>`
(`host/interruptToken.ts`). The `payload` is the same 256-bit random credential
this host has always minted — the random value IS the credential, and the row
lookup is the real gate — so the store lookup, the `timingSafeEqual` re-compare
and every consumer are unchanged. What the prefix adds is `kid`: a real
HMAC-SHA256 over `<alg>.<kid>.<payload>` under a secret
(`OPENWOP_INTERRUPT_TOKEN_SECRET`) whose rotation rotates the `kid` in the same
act, which is the agility §4 exists to give.

**The corpus describes a v1 token this host never issued.** `spec/v1/interrupt.md`
gives `base64url(payload).hmac`, two segments; this host issued one opaque
segment. Its `drained` disposition is therefore: **any token without the `ow2.`
prefix is this host's own v1 credential**, resolved by the store lookup it
always took. That is the same `kid: legacy` drain the corpus asks for, spelled
for the credential this host really issued — and it means "unverifiable" and
"unknown" are one observation for those tokens, which is why they answer `404
not_found` rather than `401`. A token that IS `ow2.`-prefixed is fully checkable,
so an unadvertised `alg`, an unheld `kid`, a bad MAC and a malformed string are
one code: `401 interrupt_token_invalid`. Under major 1 every token, prefixed or
not, takes the lookup it always took.

**This changes the bytes of a token on the v1 wire** — 43 characters to 105,
one segment to five. The token is an opaque capability with no v1 grammar (the
`{token}` path parameter carries no `pattern`, which is the defect RFC 0170 §D.1
names) and every consumer already treats it as opaque, but it is a visible
change and is reported as one rather than discovered later. Tokens outstanding
across the deploy keep resolving unchanged.

## Decision 4 — `schemaVersion` is supplied at the read seat, not stored

`events.md` §"The envelope" REQUIRES `schemaVersion` on a major-2 `RunEventDoc`
and the v1 schema makes it OPTIONAL. This host has never versioned an event
payload — every event it has ever written is version `1` — so a column would
hold one constant forever. `Storage.listEvents` (ADR 0628's seat) supplies it on
the major-2 read and only there; a producer that starts versioning a payload
sets `EventRecord.schemaVersion` itself and the seat leaves it alone. Supplying
it on the v1 read would be an additive but real change to a wire §1.2 says stays
unchanged.

## Decision 5 — the closed v2 snapshot costs this host eleven fields

`runs.md` §Snapshot: "the object is closed". v1's `RunSnapshot` is
`additionalProperties: true` and this host uses that. Under major 2,
`host/v2Snapshot.ts` filters the body against the `properties` of the vendored
`schemas/v2/run-snapshot.schema.json` — **read from the artifact, never
retyped**, so a corpus bump moves the filter with it (the discipline
`protocolVersion.ts` already applies to the v2 error registry). Dropped:
`parentRunId`, `parentSeq`, `forkMode`, `parentNodeId`, `inputs`, `removalAt`,
`pinned`, `costUsd`, `costByNode`, plus the route's `childRuns` and `interrupt`.

`parentRunId` and `inputs` are not host extensions in spirit — the v1 wire
carries them, `:fork` ancestry is read off the first and RFC 0022 §A's input
projection off the second — but v2 declares neither and registers no vendor seat
on the snapshot. Reported upstream rather than smuggled through `metadata`.

## What is NOT done

- **The `Idempotency-Key` grammar is enforced; the rest of Layer 1 is unchanged.**
  The record key, the cache rules and `OpenWOP-Idempotent-Replay` are this host's
  existing v1 implementation (ADR 0549). Only the grammar and
  `400 idempotency_key_invalid` are new, and only under major 2.
- **No SSE leg.** The run-id projection covers the JSON senders; the SSE frame
  writer (`routes/streams.ts`) writes its own bytes and still carries the bare
  run id under major 2. `v2-event-type-closed` and `v2-id-grammar` drive poll,
  not SSE. Follow-up.

  > **CORRECTED 2026-09-04 — this bullet is right about SSE and WRONG about the
  > shape of the problem, and the wrongness is the lesson.** It reads as "one
  > known gap, tracked". There were **two**, and the second was live: the
  > **webhook emitter** builds its body at enqueue time
  > (`routes/webhooks.ts` `enqueueDelivery`), is not a `res.json` sender, and
  > shipped the **bare** run id to a client that had been handed the projected
  > one by its own `POST /runs`. Its correlation filter matched nothing — no
  > error, no 4xx, no log line. `v2-webhook-durable-delivery` caught it (2 tests,
  > **zero** delivery attempts observed) only because the scenario correlates the
  > way a real integrator does.
  >
  > **The defect was this enumeration, not the omission from it.** "The
  > projection covers the JSON senders" plus a list of the exceptions someone
  > happened to think of is not coverage — it is a claim that the author
  > enumerated every emitter, made in a codebase where nothing checks that. A
  > projection that holds only where someone remembered to call it is not a
  > projection. **The fix for a forgotten call site is never another call site.**
  >
  > Closed by routing every outbound body through the ONE serialization point
  > (`enqueueDelivery`, three callers, one `JSON.stringify`), keyed on a
  > `protocolMajor` stamped on the SUBSCRIPTION at registration — a delivery is
  > an emission, not a response, so it has no header to negotiate from. **Absent
  > ⇒ major 1**, so every pre-existing subscriber keeps the bare id it has always
  > received; projecting unconditionally would have been the same defect aimed at
  > v1 receivers. Test: `test/v2-webhook-id-projection.test.ts`, born red under
  > two separate sabotages (never-project reddens the v2 leg; always-project
  > reddens the fail-safe leg).
  >
  > **SSE remains genuinely open** and is now the only known emitter outside the
  > seam — but treat that as "the one we have found", not "the one that is left".
- **`interruptId`, `subscriptionId`, `deliveryId` and `effectId` keep their v1
  forms.** §5 makes all five kinds tenant-bound; only `runId` is reachable on
  the surfaces this PR mounts.
- **No `auth.lanes[]` facet.** §2's advertisement (issuers, revocation,
  minimumAssurance, delegationProofs) belongs with the v2 discovery families,
  not here.
- **`SubjectLink` is not a record yet** (§3). The host-internal deny set stands.

## Consequences

The four RFC 0170 scenarios pass unaided, and `v2-event-type-closed`'s envelope
leg passes with them. The v1 wire is unchanged except the token bytes named in
Decision 3, measured by replaying one 31-request v1 transcript against
`origin/main` and this tip on fresh stores and diffing the normalized
responses.

> **CORRECTION 2026-09-05 — the SSE stream was an unprojected wire.** The
> §5 projection was installed as a `res.json` wrapper
> (`installV2ResponseHygiene`), and `routes/streams.ts` writes every frame
> via `res.write`. Under major 2 the stream routed frames through the era
> seat — which translates types and projects the owner echo — and every
> frame still carried the BARE storage run id while the JSON poll of the
> same run carried `default/<id>`. No `v2-*` conformance scenario covers
> SSE, so 55/56 green hid it; found from a peer host's live witness
> (`myndhyve-1`, crosstalk `efcf`). Fixed at the one choke every path
> (replay, live, gap, batch) funnels through (`deliverOnce`), witnessed by
> `test/v2-sse-frame-runid-projection.test.ts` (single-frame + batch +
> major-1-unchanged; sabotage-proven disjoint). The rule this adds to §5:
> **a projection installed on `res.json` covers exactly the handlers that
> call `res.json` — enumerate `res.write`/`res.end` body writers
> separately.** A sibling claim (ETag cross-major validation) was checked
> the same hour and does NOT apply here: the unversioned mount is
> major-2-only on this host (no header ⇒ 404), so no URL serves two bodies.

## Correction — major-2 webhook deliveries projected ids, not vocabulary (2026-09-10)

The major-2 delivery body (`{ runId, workspaceId?, event }`, `routes/webhooks.ts`
`enqueueDelivery`) projected run ids to `<tenant>/<opaque>` and left
`event.type` in the host's in-process v1 dialect. Two consequences, both found
by the 2026-09-10 v2-readiness measurement (crosstalk `8f27` §7b), neither
seen by `test/v2-webhook-id-projection.test.ts`, which asserted `runId` and
`protocolMajor` and never a type:

1. **A major-2 subscriber never received a renamed type in its own dialect** —
   `agent.toolCalled` arrived where `schemas/v2/event-codemap.json` promises
   `agent.tool-called`, in the body and in the `openwop-event-type` header.
2. **A major-2 subscriber filtering on the v2 spelling never fired at all.**
   `POST /webhooks` stores `events[]` verbatim and both storage adapters match
   with an exact `events.includes(event.type)` against the in-process (v1)
   spelling, so a filter of `["agent.tool-called"]` matched nothing.

**Decision.** The in-process event stays v1 (the storage-boundary rule of
`eventEra.ts` applies to fan-out too). Two seam functions in `eventEra.ts`:
`wireEventType(type, contract)` — the codemap's forward spelling for a
major-2 subscriber, **tolerant** on this path (an unmapped host type is
delivered under its only spelling rather than dropped; the read-side refusal
stays `v2-unmapped-type-refused`), and `eventTypeSpellings(type)` — the set
{v1, v2 rename, v1 inverse} a subscription may legitimately carry. Matching
goes through ONE helper (`matchingSubscribers`) used by both fan-out doors
(run events and host-extension events), which lists the tenant's
subscriptions once and matches any spelling — both adapters already load
every row and filter in-process, so this is not an added scan. The delivery
record's `eventType` (the header source) carries the wire spelling.

**Guard.** Four new legs in `v2-webhook-id-projection.test.ts`: v2-spelled
registration matches and receives v2 (body + header); v1 subscriber keeps v1;
v1-spelled registration under major 2 matches and receives v2; an unmapped
host-extension type is delivered unchanged. Sabotage (identity
`wireEventType` + no forward spelling in the set) reddens exactly the two
legs that depend on the fix. Same lesson as ADR 0647's correction: a major
bump is three contracts — address, identity, vocabulary — and each needs a
witness on a row the change actually renames.
