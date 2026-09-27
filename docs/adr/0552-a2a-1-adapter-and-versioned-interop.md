# ADR 0552 — A2A 1.0 adapter and versioned interoperability

Status: Accepted — P0 implemented 2026-08-12 (`483862a95`); P1 §B (downgrade
refusal) implemented 2026-08-13; P1 §A (exact-version discovery) implemented
2026-08-15 (`6e7b9ed55`, #3253, at the 1.106.0 conformance bump); **P2 (the
A2A 1.0 codec, card projection, auth and task binding) implemented 2026-08-16**
(`24b9e6c9b`, #3280) — the block expired when RFC 0152 §C/§D/§E landed as spec
prose (`d77d259b`, openwop#1010); **P2 CORRECTION + H19/H24/H25/H26 2026-08-16**
(`5a902f30c`, #3286 — the header-less card is 0.3 while legacy is advertised, and
the A2A peer + packs test-mode now actually RUN in the gate). P3–P4 open, and
their reason CHANGED: not a corpus gap any more but host evidence for the
streaming/push half plus a dated legacy retirement.
See `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` (2026-08-17) and
§ "Merged-tree provenance — reconciled 2026-08-17 (H44)".
**P2 CORRECTION 2026-08-16** — one of P2's two recorded host decisions (which
card a header-less GET returns) was reversed by the spec owner the same day
(openwop#1028); §C now makes header-less = the 0.3 card while `a2a-0.3-legacy`
is advertised. The correction, its reasoning and its guards are inline at
§ "Two decisions the spec left to the host". P2 stays implemented; the phase's
witness at `main` (`24b9e6c9b`) is recorded under § "Sibling-suite witness".

Date: 2026-08-11

Composes: ADR 0035, `host/a2aServer.ts`, `host/a2aTaskStore.ts`,
`host/a2aSurface.ts`, `routes/agents.ts`, discovery. Protocol gate: RFC 0152
(`Accepted`; its §C/§D/§E prose landed in `spec/v1/a2a-integration.md`
2026-08-16 — the "(Draft)" this line carried until P2 was true only on the
date above).

## Context

The existing A2A server is intentionally a v0.3 implementation. The public card
and comments pin `protocolVersion: '0.3'` (`routes/agents.ts:800-805,942-965`),
and the durable task store models the v0.3 state vocabulary. That legacy subset
is useful, but it is not current A2A 1.0 interoperability and must not be
presented as generic A2A support.

## Decision

Keep one A2A route and one durable task/run projection. Add a version adapter
around the existing semantic service instead of forking execution or storage.

1. Introduce an internal version-neutral `A2AService` for card discovery,
   message submission, task read/resubscribe and push configuration.
2. Preserve the current v0.3 codec as an explicit legacy profile.
3. Add the A2A 1.0 codec, Agent Card shape, task/message parts, error mapping,
   authentication declaration and streaming rules defined by accepted RFC 0152.
4. Negotiate only by the standard A2A mechanism selected upstream. Unsupported
   versions fail with a typed response; they never silently downgrade.
5. Bind every task to tenant, authenticated remote principal, protocol version,
   backing run and trace context. Resume/push operations re-authorize against
   that binding.
6. Discovery names exact supported versions and evidence; `supported:true`
   without a version is forbidden.

## Boundaries audit

| Concept | Owner |
|---|---|
| Task/run semantics | existing `a2aServer` service extracted without behavior change |
| Durable task record | existing `a2aTaskStore`, then `Storage`; no v1 duplicate table |
| Wire encoding | version codecs at the route boundary |
| Agent publication | existing `a2aSurface` |
| Auth/tenant guard | existing auth middleware and protocol authorization |
| Outbound push | existing SSRF-guarded webhook egress |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core protocol adapter; no feature package. |
| 2 | Toggle | Existing deployment enablement remains; versions are explicit config/capability, not tenant experiments. |
| 3 | Workflow surface | A2A tasks continue to map to ordinary runs. |
| 4 | Node pack | None. |
| 5 | Envelopes | Existing trust-boundary envelope handling; codecs normalize to it. |
| 6 | Agent pack | Existing published agents; no duplicate pack. |
| 7 | Public surface | Same standard discovery/route family with RFC-accepted version negotiation. |
| 8 | RBAC | Remote identity and task ownership checked on every operation. |
| 9 | Replay/fork | Protocol version and remote principal are recorded facts, not re-negotiated on replay. |
| 10 | Frontend | Operations may show peer/version health; no product page. |

## Phases and verification

| Phase | Scope | Gate |
|---|---|---|
| P0 | Extract version-neutral semantic service; pin v0.3 behavior | Existing v0.3 tests pass unchanged. |
| P1 | Add exact-version discovery and downgrade refusal | Negative negotiation and misleading-advert tests. **§B shipped** (`a2a-version-refusal.test.ts`, sabotage-proven); **§A blocked** on pinned conformance 1.73.0, tripwired. |
| P2 | A2A 1.0 codec/auth/task binding | **SHIPPED 2026-08-16.** Official-shape peer contract tests pass — the corpus suite's four RFC 0152 §C/§D/§E legs execute (not skip) against a locally booted host and are sabotage-proven non-vacuous. See § "P2 — implemented 2026-08-16". |
| P3 | Dual-version durability and push | Restart/resubscribe/push tests for both profiles; cross-tenant task probes. *(Cross-tenant probes landed early with P2 — `a2a-tenant-binding.test.ts`; what P3 still owes is the streaming/push half.)* |
| P4 | Retire legacy | Only after published deprecation window and usage evidence. Window date now FIXED: `A2A_LEGACY_PROFILE_SUNSET` = **2027-03-12** (`a2a-integration.md` §A, from RFC 0152 UQ1). The adopter inventory (RFC 0152 gap G1) is still open. |

> **RFC GATE SATISFIED — verified 2026-08-13 against `../openwop` `origin/main`.**
> All four RFCs of the 0147 program read `Accepted`:
>
> | RFC | status on `origin/main` |
> |---|---|
> | 0151 compensation-and-partial-failure-profile | `Accepted` |
> | 0152 a2a-1-0-versioned-composition | `Accepted` |
> | 0153 mcp-2026-07-28-versioned-composition | `Accepted` |
> | 0154 workload-identity-delegation-telemetry | `Accepted` |
>
> **HOW this was nearly recorded backwards.** Reading the files from the local
> `../openwop` WORKING TREE returned `Draft` for all four — that checkout was
> **56 commits behind** `origin/main`. Same branch-vs-`main` error I had
> corrected the steward on two hours earlier, with the roles reversed, and I was
> more confident because I had just taught the lesson.
>
> The reliable read is `git show origin/main:RFCS/<file>` after a `git fetch`,
> never a path in a sibling worktree. Knowing the failure mode did not prevent
> it; checking the ref's freshness is what would have.

## Implementation record

### Merged-tree provenance — reconciled 2026-08-17 (H44)

Phase → PR → **merge commit on `origin/main`**, each verified with
`git show <sha> --stat`:

| Phase | PR | Merge commit | Merged | Witness tests |
|---|---|---|---|---|
| P0 — version-neutral service | — | `483862a95` | 2026-08-12 | `a2a-profile.test.ts` |
| P1 §B — the downgrade refusal that refused nothing | [#3196](https://github.com/openwop/openwop-app/pull/3196) | `96b3f6be1` | 2026-08-13 | `a2a-version-refusal.test.ts` |
| P1 §A — exact-version discovery (arrived with the 1.73.0 → 1.106.0 pin) | [#3253](https://github.com/openwop/openwop-app/pull/3253) | `6e7b9ed55` | 2026-08-15 | advert DERIVED from `A2A_SUPPORTED_VERSIONS` |
| P2 — A2A 1.0 codec, Agent Card projection, auth, task binding | [#3280](https://github.com/openwop/openwop-app/pull/3280) | `24b9e6c9b` | 2026-08-16 | `a2a-1-0-server.test.ts`, `a2a-codec-1-0.test.ts`, `a2a-durable-route.test.ts`, `a2a-invoke-seam.test.ts`, `a2a-tenant-binding.test.ts` (+ `agrade-wire-blocked-residue`, `subject-erasure-coverage`) |
| P2 CORRECTION + H19 / H24 / H25 / H26 | [#3286](https://github.com/openwop/openwop-app/pull/3286) | `5a902f30c` | 2026-08-16 | `a2a-profile.test.ts`, `a2a-durable-route.test.ts`, `conformance-a2a-invoke-node.test.ts`, `workflow-edge-id-wire-spelling.test.ts` |
| H41 — every ephemeral A2A test server binds `127.0.0.1` | [#3305](https://github.com/openwop/openwop-app/pull/3305) | `3318d7062` | 2026-08-17 | `scripts/check-test-ports.mjs` (repo-wide guard) |
| H27 — the A2A invoke seam's error body converged on the flat envelope | [#3300](https://github.com/openwop/openwop-app/pull/3300) | `9b342b3be` | 2026-08-17 | `a2a-invoke-seam.test.ts`, `flat-error-envelope{,-ratchet}.test.ts` |
| P3–P4 | — | — | **open** — `host-evidence`, see the register | — |

**Re-measured at `fb6cbbcba` (H44):** the eight A2A witness files are **8 files
/ 74 tests green**.

#### What #3286 actually corrected, stated once rather than left to the four H-labels

- **H24 (the ADR correction).** A header-less Agent Card GET now returns the
  **0.3** shape while `a2a-0.3-legacy` is advertised. P2 had shipped
  `absent ⇒ preferred`, which is right only for a host that has DROPPED 0.3.
  The ADR's own sabotage row #6 is **inverted, not deleted** — it used to read
  "header-less card served 0.3-shaped ⇒ RED".
- **H25 (a measurement, not a fix).** `OPENWOP_A2A_FAKE_PEER` was unset in the
  gate, so every leg needing the suite's peer `return`ed early — **neither
  passing nor `blocked`**. Three RFC 0152 §B requirements and both RFC 0100
  reverse drift points were simply unmeasured while the gate was green. Turning
  the peer on then RED drift point #3, which is the whole argument for the
  change: an unset harness flag is a silent opt-out with none of an opt-out's
  honesty, because `OPENWOP_OPTED_OUT_PROFILES` at least declares itself.
- **H19.** `OPENWOP_PACKS_TEST_NAMESPACE_ENABLED`, the same shape: measured
  before/after on the same three files, both runs reporting 34 passed, while the
  RFC 0148 §A ledger moved `pack-registry-publish` from `inapplicable`/0
  assertions to `executed-pass`/17.
- **H26.** The canonical edge-id spelling at the workflow ingest boundary —
  `id` on the wire, `edgeId` internally; host-local, no RFC.

### P0 — shipped 2026-08-12

`host/a2aProfile.ts` (new) is the single owner of which A2A versions this host
serves. `routes/agents.ts:962` now derives the Agent Card's `protocolVersion`
from it instead of pinning the literal `'0.3'` inside the object it decorates.
Tests: `test/a2a-profile.test.ts` (4).

**P0's gate, met exactly as stated** — "existing v0.3 tests pass unchanged": the
six pre-existing A2A suites run green, 44 tests, untouched.

Why a literal was worth removing: a version hard-coded into the card cannot be
negotiated against or refused — it can only be *edited*, which is precisely how
"a legacy subset" becomes "generic A2A support" (this ADR's own Context). The
profile module makes the served set a closed, testable fact, and
`a2a-profile.test.ts` asserts the host does **not** claim `1.0` — adding that
entry without the codec behind it would be the dishonest advertisement ADR 0548
invariant 3 forbids.

### P1 — shipped 2026-08-13 (§B), and the half that could not ship (§A)

**RFC 0152 is `Accepted`**, so the block recorded below expired. Verified with
`git show origin/main:RFCS/0152-…` after a fetch — not from the local worktree,
which is the read that produced a wrong answer twice in this program.

**§B — downgrade refusal, SHIPPED.** `POST /v1/host/openwop-app/a2a` now
classifies the `A2A-Version` header before any dispatch:

| header | outcome |
|---|---|
| `1.0` (or any unserved value, or two conflicting values) | JSON-RPC `-32600`, `data.supportedVersions: ['0.3']`, **no dispatch** |
| `0.3` | served |
| absent | served as 0.3 — §B binds the 1.0 *sender*, so a request without one is a legacy peer |

> **This table is P1 HISTORY, not current behaviour.** P2 added `'1.0'` to
> `A2A_SUPPORTED_VERSIONS`, so `1.0` now reaches the 1.0 codec and the refusal
> row applies to versions outside the array (`0.2`, `99.0`, two conflicting
> values). The RULE is unchanged and is what `a2a-version-refusal.test.ts`
> still pins — "an explicit version this host does not serve is refused, never
> downgraded"; the array grew, the rule did not move. The `absent` row is
> unchanged and load-bearing.

Refusing the absent header was considered and rejected: it would break every
existing 0.3 peer to enforce a rule §B does not place on them. The audit event
is content-free (requested version + outcome, never the body).

**`servesA2AVersion()` had no production caller.** P0 shipped it with five
tests, and those tests exercised the function's own arithmetic — they passed
while every request was silently downgraded, and would have kept passing. The
predicate existed; the refusal did not. Tests:
`test/a2a-version-refusal.test.ts` (5), asserted at the wire, and **sabotaged**
(`if (false)`) to confirm two of them go red.

> **CORRECTION 2026-08-16.** The paragraph below is now history: the pinned
> suite moved to **1.106.0** (`6e7b9ed55`, #3253), the schema grew the fields,
> the tripwire fired as designed, and §A SHIPPED — `routes/discovery.ts`
> derives `a2a.protocolVersions` / `preferredVersion` from
> `A2A_SUPPORTED_VERSIONS` (`host/a2aProfile.ts`), and the tripwire was
> replaced by the positive obligation that the advert and the version SSoT
> cannot disagree. That commit did not update this ADR; this note does. Left in
> place because the mechanism it describes — a deferral that notices its own
> reason expiring — is the part worth keeping.
>
> P2–P4 remain open, and their reason ALSO changed: RFC 0152 is `Accepted`, so
> the block is not the rung; it is that §C (Agent Card / interface projection)
> and §D (task/event translation table — RFC 0152 gap G2) exist only as RFC
> prose and `spec/v1/a2a-integration.md` carries zero 0152 content. A host that
> builds the 1.0 codec now guesses the mapping. The spec-side authoring was
> delegated 2026-08-16 (crosstalk `agrade`, task A-3).

**§A — exact-version discovery, NOT shipped, and the reason changed.** RFC 0152
§A adds `protocolVersions` / `preferredVersion` / `profiles` to the `a2a` slot.
The RFC gate is satisfied and the fields exist on `../openwop` `origin/main`.
What blocks it now is that this repo pins `@openwop/openwop-conformance`
**1.73.0**, whose `capabilities.schema.json` predates the change and marks the
slot `additionalProperties: false`.

MEASURED against the pinned copy, not inferred from the RFC:

```
a2a WITHOUT new fields: VALID
a2a WITH    new fields: REJECTED  <- must NOT have additional properties (x3)
```

Advertising them today would emit a capabilities document that any peer
validating against the pinned contract refuses — a dishonest advert of a
different kind than usual: correct per the spec, invalid per the artifact.
Deferred to the conformance-suite bump, and pinned by a **tripwire** in
`agrade-wire-blocked-residue.test.ts` that goes red the moment the pinned schema
grows the fields. Sabotage-proven by planting `a2a.protocolVersions` into the
pinned schema and watching it fire with the instruction to ship §A.

### P2 — implemented 2026-08-16

**The block expired, and it expired for the reason the register named.** The
P1 correction note above said P2's obstacle was no longer the RFC's status but
that "§C (Agent Card / interface projection) and §D (task/event translation
table — RFC 0152 gap G2) exist only as RFC prose and
`spec/v1/a2a-integration.md` carries zero 0152 content. A host that builds the
1.0 codec now guesses the mapping." That prose landed (`d77d259b`,
openwop#1010) as `a2a-integration.md` § "A2A 1.0 versioned composition": §A
profiles, §B negotiation, §C card/interface projection, §D.1–D.7 including the
stored-state bijection, §E identity. Gaps G2 and G4 are closed there. Nothing
below is a guess; each row cites the section it implements.

#### Spec → host mapping

| Spec | Host | Note |
|---|---|---|
| §A `profiles` / `protocolVersions` / `preferredVersion` | `host/a2aProfile.ts` (`A2A_SUPPORTED_VERSIONS = ['1.0','0.3']`, `A2A_PROFILES` derived via `a2aProfileIdFor`), advertised in `routes/discovery.ts` | §A's "a profile implies its version, not the reverse" is **structural**: `profiles` is `map(a2aProfileIdFor)` over the version array, so there is no second list to drift. |
| §A legacy window | `A2A_LEGACY_PROFILE_SUNSET = '2027-03-12'` | A constant, not a comment, because P4 has to act on it. |
| §B receiver rule (absent ⇒ 0.3) | `codecVersionFor()` + the codec split in `routes/agents.ts` | An explicit `1.0` reaches the 1.0 codec; absent reaches the 0.3 codec byte-for-byte. |
| §B sender rule + no silent downgrade | `negotiateA2aPeer()` in `host/a2aSurface.ts` | Every non-GET call carries `A2A-Version: <negotiated>`; the binding's `version` is what the seam reports, so report and wire cannot disagree. Authenticated downgrade **fails closed**. |
| §B canonical projection | `A2aVersionRefusedError` → `interop_version_unsupported` at the §22 seam | `retriable: false`, `details.protocol/requested/supported`. |
| §C Agent Card, both shapes | `host/a2aCard.ts` | The 1.0 card's `supportedInterfaces[]` version SET **is** `A2A_SUPPORTED_VERSIONS`; the JSON-RPC-at-1.0 floor is the only binding served. |
| §D.1 operations | `host/a2aServer10.ts` (server) + `OPERATION_NAMES` (client) | One table, both directions. 0.3 method names under a 1.0 header are `-32601`, not silently served. |
| §D.2 message / idempotency | `submitMessageTask()` in `host/a2aService.ts` | `(tenant, principal, messageId)` claimed in `a2a:msgclaim`; a message into a running task is `UnsupportedOperationError`, never dropped. |
| §D.3 `Part` oneof | `decodePart10()` / `messageText10()` | Discriminated by MEMBER PRESENCE. Only `text` reaches the run: a `url` is a reference (RFC 0079 egress), `raw` must not be inlined (SR-1). |
| §D.4 `Task` + `TASK_STATE_*` bijection | `a2aCodec10.ts` `STORED_TO_WIRE_10` (+ its derived inverse) | The stored 0.3 vocabulary is **unchanged**; the 1.0 interface renders it. No migration. |
| §D.5 streaming shapes | `taskStatusUpdateEvent10()` | No `kind`, no `final` — terminality is the state. |
| §D.6 push | the 1.0 `CreateTaskPushNotificationConfig` branch | Same RFC 0093 SSRF guard; caller secrets never persisted or echoed. |
| §D.7 errors | `A2A_10_ERROR` + `projectPeerError10()` | Upstream details **dropped, not redacted** (UQ4). |
| §E identity | `host/a2aService.ts` (`resolveTenantOfRecord`, `getA2aTaskFor`) | Tenant hint neutralized content-free; cross-tenant ⇒ `TaskNotFoundError`. |
| §E peer authority | `host/a2aPeerIngest.ts` + `host/a2aPeerAuthorityProbe.ts` | Defence by construction: the ingestion returns text and has no branch that could act on peer metadata. |
| §22 seams | `/v1/host/{openwop-app,sample}/a2a/invoke` in `routes/agents.ts` | Drives `createA2aSurface` — the same client `ctx.a2a.*` uses — per §22's non-vacuity rule. |

#### The eight decisions, as implemented

1. **The pre-existing body IS `a2a-0.3-legacy`.** Served and advertised
   unchanged; retirement is P4, dated by `A2A_LEGACY_PROFILE_SUNSET`.
2. **JSON-RPC at 1.0 is the floor.** The only binding in
   `supportedInterfaces[]`; no HTTP+JSON or gRPC is claimed.
3. **`A2ATaskState.state` keeps the 0.3 lowercase vocabulary as the STORED
   form.** No record was migrated. The bijection is total in both directions
   and pinned by a test that walks every member.
4. **`tenant` is a HINT.** `resolveTenantOfRecord` returns the principal's
   binding always, logs the disagreement content-free, and never reveals
   whether the requested tenant exists.
5. **Cross-tenant `GetTask`/`CancelTask`/`SubscribeToTask` ⇒
   `TaskNotFoundError`.** `getA2aTaskFor` returns null for "missing" and "not
   yours" inseparably; the test asserts the two error bodies are equal.
6. **Upstream error details are DROPPED.** `projectPeerError10` reads three
   fields and cannot leak a fourth — there is no filter to keep correct.
7. **`interop_version_unsupported`** is what the §22 seam emits.
8. **§22 seam wired**, including the additive `peerAuthority` block.

#### Two decisions the spec left to the host, recorded because they are choices

- **A header-less card GET returns the PREFERRED (1.0) shape, not 0.3.** The
  brief for this phase said the opposite ("0.3-shaped otherwise"), and the
  corpus overrules it: `a2a-card-runtime-consistency.test.ts` fetches
  `agentCardUrl` with no `A2A-Version` header and asserts the card has no
  top-level `url`/`protocolVersion` — "a card with both shapes is neither" —
  gated only on `profiles ∋ a2a-1.0`. A 0.3-by-default card would therefore
  FAIL the very leg that is this phase's exit criterion. The 0.3 card is one
  header away (`A2A-Version: 0.3`), and both eras are served on the RPC path
  regardless of card shape. **The cost is real:** a 0.3-era peer that
  discovers this host header-less and resolves the endpoint from `card.url`
  finds none. That is the legacy window closing, and it is why P4 has a date.

  > **CORRECTION, 2026-08-16 (same day) — this decision was REVERSED by the
  > spec owner, and the cost named two sentences up is exactly why.** The
  > openwop maintainers decided (openwop#1028, RFC 0152 register S18 Q1, now
  > normative in `a2a-integration.md` §C) that the §B receiver rule — an absent
  > `A2A-Version` means 0.3 — **applies to the Agent Card GET as to every other
  > inbound request**. While a host advertises `a2a-0.3-legacy` it MUST serve
  > the **0.3-shaped** card header-less and the 1.0 card only to a request
  > carrying `A2A-Version: 1.0`; a 1.0 client MUST send that header on the card
  > GET. A host that has DROPPED 0.3 serves its `preferredVersion` card
  > header-less — so P4 makes this a one-line change in
  > `A2A_SUPPORTED_VERSIONS`, not a second edit.
  >
  > The reasoning that produced the original decision was not wrong about the
  > corpus; it was wrong about which side of the corpus would move. The leg it
  > cited — `a2a-card-runtime-consistency.test.ts` — did fetch header-less and
  > assert the 1.0 shape, and it was that leg that got fixed: from suite
  > 1.122.0 it sends `A2A-Version: 1.0`, and a NEW leg asserts the header-less
  > 0.3 shape while 0.3 is advertised. The maintainers' note says so directly:
  > fetching header-less "is what forced the first 1.0 host onto the wrong side
  > of this rule". Serving 1.0 header-less breaks every 0.3 client that reads
  > `card.url` NOW instead of at the sunset, which defeats the point of
  > advertising the legacy profile at all.
  >
  > **What changed in the host (one function, no new branch):** the selection
  > rule moved out of `routes/agents.ts` into `host/a2aProfile.ts`
  > `cardVersionFor()`, beside `codecVersionFor()` — one receiver rule, stated
  > once, for discovery and operations alike. An UNSUPPORTED version still gets
  > the preferred card rather than a refusal: a card GET is discovery, and
  > refusing it would withhold the very document that names the served versions.
  >
  > Guards: `a2a-profile.test.ts` (unit, both spellings + the 0.3-still-served
  > precondition P4 will flip), `a2a-durable-route.test.ts` (wire: header-less
  > ⇒ 0.3, `A2A-Version: 1.0` ⇒ 1.0, `A2A-Version: 0.3` ⇒ 0.3),
  > `agrade-wire-blocked-residue.test.ts` (the advert-honesty pair — the 1.0
  > assertions now fetch WITH the header, and a new leg asserts the header-less
  > 0.3 card, so the correction ADDS coverage rather than moving it). Sabotage:
  > restoring `absent ⇒ preferred` turns all three red (2 + 1 + 1 assertions).
  > **Sabotage row #6 in the table below is therefore inverted, not deleted** —
  > it used to read "header-less card served 0.3-shaped ⇒ RED"; it now reads
  > "header-less card served 1.0-shaped ⇒ RED".
- **Exactly ONE skill on the 1.0 card** (`OPENWOP_A2A_WORKFLOW_ID`, default
  `openwop-app.approval-gate`). Upstream's 1.0 `Message` carries no skill
  selector, so a host advertising several skills over one JSON-RPC interface
  gives the peer no conformant way to choose. Minting
  `metadata.openwop.skillId` would be a new declared mapping on a namespace
  §D.2 closes to two keys — an RFC, not a host decision. §C's "a skill absent
  from routing MUST NOT appear" is met by advertising only what routes.

#### Codec boundary, and what was NOT forked

ADR 0552's boundaries table survives intact: ONE route
(`POST /v1/host/openwop-app/a2a`), ONE durable task record (`a2aTaskStore` over
`Storage` — **no v1 duplicate table**), ONE outbound push path. What is new is
`host/a2aService.ts`, the version-neutral semantic layer decision 1 asked for:
it owns runs, task authorization, tenant binding and cancellation, and knows
nothing about JSON-RPC method names or `TASK_STATE_*` spellings. `a2aServer.ts`
(0.3) and `a2aServer10.ts` (1.0) are codecs over it.

Two things grew that are worth naming:

- `A2aTaskRecord` gained `tenantId` / `principalId` / `protocolVersion`. The
  first is the §E binding. It is OPTIONAL only because pre-P2 rows have none,
  and the two read arms are **both real and both tested**: the 1.0 arm is
  `strict` (an unbound record is unreadable, not readable-by-all — the
  permissive-resolver trap), the 0.3 arm is `legacy` (unbound records stay
  readable, so no existing peer loses a task it holds) and still refuses a
  record BOUND to another tenant.
- `host/runCancel.ts` — the cancel recipe extracted from `routes/runs.ts` so
  A2A's `CancelTask` drives it instead of a second one. The child cascade is
  normative (`interrupt-profiles.md` §`openwop-interrupt-cascade-cancel`), so a
  re-implementation would have left child runs live. ADR 0556 P1's
  `recordInterruptResolved(itr, 'cascaded', …)` moved into the recipe with it
  and now fires for the A2A path too.

#### Sibling-suite witness (the P2 gate)

The gate reads "official SDK/peer contract tests". The corpus suite's RFC 0152
§C/§D/§E legs landed at **1.112.0**; this repo pins **1.106.0** and the pin was
not moved (publishing is not this phase's call), so `npm run ci` **cannot** see
them — that is stated here rather than papered over. They were run directly:
the host booted in-process via `createApp` (never `main()`, so
`ensureLocalPacksMounted` does not re-point the shared `~/.openwop-packs`) on
`127.0.0.1:19552`, and vitest run from `/Users/david/dev/openwop/conformance`
at `e1ce3c2d` (suite 1.116.0) against it. Re-run unchanged after the rebase
onto `8fbed15d4` (ADR 0556 P3 + 0551 P1), so the numbers below describe this
branch's merge base, not a stale boot: **6 files / 31 tests, all pass.**

| Leg | Result |
|---|---|
| `a2a-card-runtime-consistency.test.ts` | **4/4 PASS (executed)** |
| `a2a-1-0-task-roundtrip.test.ts` | **1/1 PASS (executed)** |
| `a2a-peer-authority.test.ts` | **1/1 PASS (executed)** |
| `a2a-version-negotiation.test.ts` | **4/4 PASS (executed)** |
| `versioned-composition-profiles.test.ts` | 11/11 PASS |
| `a2a-1-0-agent-card.test.ts` | 10/10 PASS (server-free) |
| `a2a-task-roundtrip.test.ts` | 19/20 — **1 FAIL, pre-existing and unrelated** (below) |

> **WITNESS AT `main`, 2026-08-16 (H22).** The run above is this branch's own,
> against an unmerged tree. P2 merged as `24b9e6c9b`, and the spec worker
> `openwop-1` re-drove the legs there — suite **1.120.0+**, strict
> (`OPENWOP_REQUIRE_BEHAVIOR=true`), `OPENWOP_A2A_FAKE_PEER=true` +
> `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`, `memory://` boot on port 18097. RFC
> 0148 §A ledger:
>
> | Requirement | Disposition | Assertions |
> |---|---|---|
> | `a2a-1-0-agent-card` | `executed-pass` | 52 |
> | `a2a-1-0-task-roundtrip` | `executed-pass` | 14 |
> | `a2a-card-runtime-consistency` | `executed-pass` | 11 |
> | `a2a-peer-authority` | `executed-pass` | 4 |
> | `a2a-version-negotiation` | `executed-pass` | 5 |
> | `a2a-task-roundtrip` | `executed-fail` | 29 |
>
> **The one `executed-fail`, itemised** — it is two strict advertise-or-opt-out
> rows that `conformance/run.ts` covers with opt-outs (the witness boot does
> not read that list), plus drift point #3, the `core.conformance.a2a-invoke`
> gap **closed by H25 in this same file**. Nothing in it is an unexplained red.
>
> Worth recording because it cost a first run: the host's FIRST attempt to
> reach the loopback peer was **refused by the RFC 0093 egress guard**
> (`guardedEgressFetch` rejects `127.0.0.1` before the first socket). That is
> the guard working, not a host defect — it is why
> `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` is in the recipe above and now in both
> conformance boots, and why a peer-shaped leg that "does nothing" should be
> checked for an egress refusal before anything else.

**"Executed, not skipped" was PROVEN, not assumed.** All four gate on
`profiles ∋ a2a-1.0` and `return` early when the gate is shut, so a green could
mean nothing ran. Three host sabotages were applied and the suite re-run
against the sabotaged boot:

| Host sabotage | Leg |
|---|---|
| the 1.0 card also carries a top-level `url` | `a2a-card-runtime-consistency` → **RED** |
| `Task.id` minted (`a2a-${runId}`) instead of the runId | `a2a-1-0-task-roundtrip` → **RED** |
| the seam omits the `peerAuthority` block | `a2a-peer-authority` → **RED** |

Restored, all green again.

**The one failure, and why it is not P2's.** `a2a-task-roundtrip.test.ts` drift
point #3 (`AUTH_REQUIRED` → `waiting-input`) fails because the suite's
`conformance-a2a-task-roundtrip` fixture declares node **`core.a2a.invoke`**,
which exists NOWHERE on this host — `core.openwop.a2a` ships
`…a2a.send-message` and fifteen siblings, none named `invoke` — so the run
fails at dispatch. Measured, not inferred (`grep -rl core.a2a.invoke
~/.openwop-packs` is empty). It predates this phase and is invisible in
`npm run ci` for a second reason worth recording: **every A2A leg that needs
the suite's peer calls `getA2AFakePeer()` and returns when it is null, and
`conformance/run.ts` never sets `OPENWOP_A2A_FAKE_PEER`** — so those legs are
not passing and not `blocked`, they simply do not run, and the suite reports
green. Turning the peer on was tried and reverted: it makes the §B legs real
but puts that pre-existing red into the merge gate for a gap this ADR does not
own, and quarantining the file would silence the host-as-server legs that pass
today. Left off with the finding recorded in `conformance/run.ts` itself.

> **CLOSED 2026-08-16 (H25) — the peer is ON in the gate, and drift #3 is
> witnessed.** The gap this paragraph parked was real and its disposition was
> the problem: a leg that returns early is not a leg that passes, so three RFC
> 0152 §B requirements and both RFC 0100 reverse drift points were reported
> green while nothing ran. Both halves landed together, which is why the red no
> longer follows:
>
> - the corpus renamed the fixture's node `core.a2a.invoke` →
>   `core.conformance.a2a-invoke` (openwop#1028), a conformance-RESERVED id on
>   the `core.conformance.side-effect` precedent, with the rule "a host
>   consuming A2A MUST map it to its A2A bridge; a host that does not MUST NOT
>   advertise the fixture" — this host was taking the third option;
> - `bootstrap/conformanceA2aInvokeNode.ts` maps it (and the pre-rename
>   spelling, since the gate pins 1.106.0 and vendors that fixture set) onto the
>   real `createA2aSurface` client, projecting `AUTH_REQUIRED` → a
>   `clarification` interrupt (run status `waiting-input`) and `REJECTED` → a
>   typed `rejected_by_remote` failure, per §"State projection (reverse)";
> - `conformance/run.ts` pins the peer port, sets `OPENWOP_A2A_FAKE_PEER=true`
>   on the suite side and `OPENWOP_A2A_CONFORMANCE_PEER_URL` on the host side,
>   and relies on the `OPENWOP_WEBHOOK_ALLOW_PRIVATE` already set for the compat
>   mock — the RFC 0093 egress guard refuses the loopback peer without it.
>
> MEASURED at the pin: `npm run test:conformance` **425 files / 2745 tests
> pass**, with `a2a-task-roundtrip.test.ts` 10/10 in 549 ms and two real
> `conformance-a2a-task-roundtrip` runs in the audit log — i.e. drift #3 and #4
> executed rather than warning-skipped. The bridge is sabotage-proven
> non-vacuous twice: at host tier
> (`test/conformance-a2a-invoke-node.test.ts` — changing the projection to
> `approval` / `peer_failed` reds 3), and at corpus tier (booting without
> `OPENWOP_A2A_CONFORMANCE_PEER_URL` reds drift point #3 after its full 15 s
> poll).

#### Host-tier tests and sabotage table

New: `a2a-codec-1-0.test.ts` (14), `a2a-1-0-server.test.ts` (11),
`a2a-tenant-binding.test.ts` (9), `a2a-invoke-seam.test.ts` (7). Updated:
`a2a-profile.test.ts` (9), `a2a-version-refusal.test.ts` (7),
`a2a-durable-route.test.ts` (6), `agrade-wire-blocked-residue.test.ts` (13).
All 13 A2A/residue suites: **118 tests green**.

Thirteen sabotages, each applied to production code and confirmed RED:

| # | Sabotage | Goes red |
|---|---|---|
| 1 | `canceled` → `TASK_STATE_COMPLETED` in the bijection | `a2a-codec-1-0` (round-trip) |
| 2 | `Part` decoded by `kind` instead of member presence | `a2a-codec-1-0` (3) |
| 3 | peer error `data` copied into the projection | `a2a-codec-1-0` (3) |
| 4 | `tenant` hint honoured as a selector | `a2a-tenant-binding` (2) |
| 5 | `readableBy` always permits | `a2a-tenant-binding` (4) |
| 6 | header-less card served 1.0-shaped (INVERTED by the 2026-08-16 correction above; was "0.3-shaped") | `a2a-profile` + `a2a-durable-route` + residue (4) |
| 7 | ingestion resolves the peer's asserted approval | `a2a-invoke-seam` (peerAuthority) |
| 8 | authenticated downgrade proceeds silently | `a2a-invoke-seam` |
| 9 | outbound `A2A-Version` header dropped | `a2a-invoke-seam` (2) |
| 10 | `Task.id` minted instead of the runId | `a2a-1-0-server` (3) |
| 11 | `messageId` idempotency claim ignored | `a2a-1-0-server` |
| 12 | explicit 1.0 falls through to the 0.3 codec | `a2a-version-refusal` + `a2a-1-0-server` (12) |
| 13 | `profiles` listed independently of the versions | `a2a-profile` + residue (3) |

The `peerAuthority` block deserves its own note, because three hard-coded
`false`s would satisfy the suite and prove nothing. Each flag is measured: a
REAL approval-gated run is started and parked before the peer is called, the
peer's reply goes through the production `ingestPeerReply`, and the flags
compare run status + open-interrupt count before and after, search the
persisted run for any scope the peer proposed, and read the client's own
outbound call log for the referenced task id. When the peer asserts nothing the
block is **omitted**, so the suite records `blocked` rather than a `false`
nobody measured.

#### The honesty flip, in this commit

`profiles: ['a2a-1.0','a2a-0.3-legacy']` and `'1.0'` in `protocolVersions` ship
in the same commit as the codec, and `agrade-wire-blocked-residue.test.ts`'s
negative — "the a2a slot does not contain `1.0`" — was **inverted, not
deleted**. It now asserts the advert is derived from the version SSoT, that
every profile names a served version, and that the card at `agentCardUrl`
agrees with the advert (`a2a-card-runtime-consistent`, checked at the wire).
A negative removed on the day it stops holding leaves nothing watching what it
protected.

#### What P2 does NOT do

- **Streaming and push at 1.0 (P3).** `SubscribeToTask` /
  `SendStreamingMessage` answer `UnsupportedOperationError` while
  `capabilities.a2a.streaming` is false — the card's own claim enforced, not a
  second policy. The corpus has no streaming peer either (RFC 0152 gap G6's
  one open scenario, `a2a-1.0-stream-push`).
- **Resuming a HITL gate over A2A (P3).** A `SendMessage` carrying a `taskId`
  returns `UnsupportedOperationError` — §D.2's explicit alternative to
  silently dropping it.
- **`ListTasks` pagination.** One page, `nextPageToken: ''`. A token this host
  could not resolve is worse than none.
- **Retiring 0.3 (P4).** Served and advertised; the window closes 2027-03-12.
- **The conformance pin.** Unmoved, so `npm run ci` cannot witness the 1.0
  legs. Recorded above rather than implied.

### P3–P4 — blocked, and not partially attempted

> **CORRECTED 2026-08-13.** The paragraph below was written when RFC 0152 was
> `Draft`, and it bundled P1 with P2 on that basis. RFC 0152 is now `Accepted`;
> P1's §B shipped (see above) and its §A is blocked by the pinned conformance
> schema instead. Only P2–P4 remain blocked on the RFC's codec. Left in place
> rather than edited — the bundling is exactly the error worth being able to see.
>
> **CORRECTED AGAIN 2026-08-16 (P2 shipped).** The heading now reads P3–P4, and
> the paragraph below is fully historical: P2's codec exists. The prediction it
> makes — "when 0152 locks, adding the 1.0 profile is one entry in
> `A2A_SUPPORTED_VERSIONS` plus a codec, rather than a hunt for scattered
> literals" — is the one claim here worth checking against what happened, and
> it **held**: the version entry, `A2A_PROFILES`, both card shapes, the codec
> dispatch and the discovery advert all read that one array, and the only
> literal P0 left behind (`protocolVersion: '0.3'` on the legacy card) turned
> out to mean "this document is a 0.3 card", not "this host prefers 0.3" — so
> it became `LEGACY_A2A_PROTOCOL_VERSION` rather than moving. What P0 did NOT
> foresee is that the codec would need a version-neutral SEMANTIC layer as well
> (`host/a2aService.ts`): 1.0 makes a Task a run, 0.3 makes it an agent
> dispatch, and the shared part is task authorization rather than encoding.

P1 ("exact-version discovery and downgrade refusal") needs the negotiation
mechanism, and P2 needs the codec; **both are defined by RFC 0152, which is
`Draft`** — its wire shape is not locked, so implementing against it means
guessing at a contract (ADR 0548 invariant 4). P0 was scoped so that when 0152
locks, adding the 1.0 profile is one entry in `A2A_SUPPORTED_VERSIONS` plus a
codec, rather than a hunt for scattered literals.

## Claim record

*Part V of `docs/OPENWOP-A-PLUS-ROADMAP.md` requires this block on every artifact
in the program. It is deliberately the LAST section: everything above argues for
a decision, and this states only what is claimed on the wire today and what
backs it. A claim without an evidence rung beside it is the exact failure the
program's invariant 5 names — an accepted document is not evidence.*

### Profiles actually advertised

| Profile | Advertised because | Derived from |
|---|---|---|
| `a2a-1.0` | RFC 0152 §A; A2A 1.0.0 as published 2026-03-12 | `A2A_PROFILES` ← `A2A_SUPPORTED_VERSIONS` via `a2aProfileIdFor` (`host/a2aProfile.ts:79`) |
| `a2a-0.3-legacy` | the §A legacy window, still open | same SSoT; the spelling is the one irregular case (`0.3` → `a2a-0.3-legacy`, not `a2a-0.3`) |

Both are computed from ONE list. That is the claim that matters here: the advert
is not a literal that can drift from what the codec serves. H68's served-profile
metric label (`openwop.protocol.version`, `profile: ServedProfile`) closes the
loop from the other end — what was actually served per request, from a closed
set that is never peer-supplied.

### Profiles explicitly NOT advertised

- **Restart-safe streaming / push (P3).** Blocked above RFC 0100 §4 — it needs a
  protocol amendment, not host work, and is recorded as D7 rather than attempted
  partially. Nothing in the card or capability object hints at it.
- **Exact-version discovery (P1 §A).** Blocked by the PINNED schema, not by the
  RFC; the residue register carries the row and the test asserts the absence.

### Evidence supporting each profile

| Claim | Witness | Rung |
|---|---|---|
| the advert is derived from the version SSoT, not literals | `agrade-wire-blocked-residue.test.ts` — "RFC 0152 §A — the a2a advert is DERIVED from the version SSoT" | test-seam |
| `a2a-1.0` is backed by a 1.0-SHAPED card, not just a version string | same file — "ADR 0552 P2 — the `a2a-1.0` profile advert is backed by a 1.0-shaped card" | test-seam |
| while `a2a-0.3-legacy` is advertised, a header-less card GET returns the 0.3 card | same file — "ADR 0552 P2 CORRECTION" (the spec owner reversed the original reading; the test pins the reversal, not the first guess) | test-seam |
| the profile actually served per request is observable | `openwop.protocol.version` with the `profile` label (H68) | local-live |

**`deployed-live` — REACHED 2026-08-18, and this paragraph used to say it was
not.** The gap was real: nothing fetched the agent CARD from the deployed
origin, so every row above was evidence about a CHECKOUT and a deploy shipping a
different image would not have disturbed any of it.

Closed by extending `scripts/check-wire-claims.mjs` — the lane
`verify-deploy.sh` already runs, rather than a second probe beside it. Three
assertions, each catching what the others cannot:

1. **Advert vs reachability.** The card route 404s unless
   `OPENWOP_A2A_SERVER_ENABLED=true`, so a deployment advertising
   `capabilities.a2a` while serving no card is claiming an interface it does not
   expose. That is an ENV-only misconfiguration and therefore **invisible to the
   commit stamp by construction** — the same class as the four-day
   `sideEffectSuppression` drift that script was built for.
2. **The 1.0 shape is really 1.0**: `supportedInterfaces[]` present AND no
   top-level `url`. Asserting the ABSENCE matters as much as the presence — §C's
   witness says "a card with both shapes is neither", so a presence-only check
   would pass a card no conformant client can classify.
3. **The header-less rule**, which is the one a reasonable person gets
   backwards: while `a2a-0.3-legacy` is advertised a header-less GET returns the
   **0.3** shape. The spec owner REVERSED this host's first reading
   (openwop#1028, RFC 0152 register S18 Q1), and pinning the reversal on the
   wire is what stops a future "simplification" back to the intuitive answer.

MEASURED against `https://app.openwop.dev/api` on 2026-08-18:
`a2a agent card (deployed) OK — 1.0 shape, 2 interface(s), header-less GET is
0.3`. Sabotage, both restored: demanding a top-level `url` on the 1.0 card, and
expecting the header-less GET to be 1.0, each reported BROKEN against the live
origin.

Still NOT reached, and unchanged: `official-peer` and above. No row here may be
read as an interoperability claim about any external implementation.

### Evidence expiry and supersession

- `a2a-0.3-legacy` has a hard expiry in code, not in prose:
  `A2A_LEGACY_PROFILE_SUNSET = '2027-03-12'` (`host/a2aProfile.ts:88`) — A2A
  1.0.0's publication date plus the §A 12-month window. P4 is the retirement
  that acts on it. The constant exists so the date cannot rot inside a comment
  nobody greps.
- The P2 CORRECTION row supersedes the original header-less-card reading. The
  superseded reading is kept in the implementation record rather than edited
  away, because "we tested the wrong thing confidently" is the part a future
  reader needs.

### Public statements updated or prohibited

- **Permitted:** that this host serves A2A 1.0 and the 0.3 legacy profile, and
  that the two adverts derive from one SSoT.
- **Now permitted, as of 2026-08-18:** "app.openwop.dev serves an A2A 1.0 card"
  — backed by a check that runs on every deploy and would go red if it stopped
  being true. This was PROHIBITED in the first version of this record, and the
  prohibition is what produced the probe rather than the other way round. That
  ordering is the point: the record named a claim it could not support, and the
  cheapest way to stop lying was to make it true.
- **Prohibited outright:** any interoperability claim naming a specific external
  peer. No official-peer run has been performed for A2A; the corresponding MCP
  item (53-5) is tracked separately and is likewise unrun.

## Alternatives weighed

- Replace v0.3 in place: rejected; it breaks known peers without negotiation.
- Mount `/a2a-v1`: rejected; versioning belongs to the standard adapter and a
  second route would duplicate authorization, storage and dispatch.
- Translate 1.0 directly inside the executor: rejected; wire version concerns
  belong at the boundary.

