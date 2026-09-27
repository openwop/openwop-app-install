# ADR 0549 — Tenant-scoped durable run-idempotency ledger

Status: implemented — P0–P2 2026-08-12 (`bfec8b9e4`), P3 2026-08-16 (`e6f22d739`, #3273; quarantine residue retired in `3653cd90d`, #3283). Merge provenance reconciled 2026-08-17 (H44) — see § "Merged-tree provenance"

Date: 2026-08-11

Composes: `routes/runs.ts`, `storage/storage.ts`, SQLite/Postgres adapters, ADR
0380 retention, RFC 0150 (`Accepted` 2026-08-12; this header said `Draft` until 2026-08-18) for the corrected effect-identity recipe.

## Context

`POST /v1/runs` currently passes the raw `Idempotency-Key` to storage
(`routes/runs.ts:338-366`). Both durable schemas make that raw key the sole
primary key (`storage/sqlite/schema.ts:88-93`,
`storage/postgres/schema.ts:121-126`), and Postgres claims/reads/upserts only on
that key (`storage/postgres/index.ts:879-918`). A caller in tenant B can collide
with tenant A and receive A's cached response. This is a critical isolation
defect and violates the current protocol requirement to scope by tenant and
endpoint.

Mismatch detection is also process-local (`routes/runs.ts:60-77`), uses a
non-RFC-8785 serializer, and disappears on restart. The durable `__pending__`
placeholder has no lease/expiry/release operation (`storage/storage.ts:248-271`),
so an exception after claim can strand retries forever.

## Decision

Replace the raw-key cache with one durable ledger owned by `Storage`.

> **CORRECTION 1 (2026-08-11, pre-implementation architecture review).** This ADR
> was written as if `claimIdempotency` were only an HTTP response cache. It is
> not: it is also the app's **distributed fire-once mutex**, called by ~11
> daemons (`host/scheduleDaemon.ts:77`, `host/heartbeatService.ts:549`,
> `host/retentionSweepDaemon.ts:102,108`, and 8 feature sweeps). The two lanes
> share one table and one column, and that sharing is itself a **critical
> security defect this ADR did not name** — see CORRECTION 2. The decision below
> is therefore amended: the HTTP lane moves to a NEW `idempotent_response` table
> with the composite key; the mutex lane KEEPS the existing `idempotency` table
> unchanged, with its interface renamed (`claimOnce` / `pruneClaimsByPrefix`) to
> say what it actually is.
>
> The split is not tidiness. **Step 7 of the claim state machine below —
> "any pre-commit failure releases the claim in `finally`" — is unimplementable
> on a shared table**: releasing a daemon's slot on failure lets another
> instance re-fire the same scheduled work. One of the two lanes has to be
> wrong, so they cannot be one lane.
>
> **CORRECTION 2 (same review) — an unnamed CRITICAL defect.** The
> `Idempotency-Key` header is **not validated anywhere** (no format check, no
> middleware, no schema; `routes/runs.ts:338` reads it and passes it straight
> through). Because caller-supplied keys share a keyspace with host-generated
> mutex keys, any authenticated tenant can send
> `Idempotency-Key: schedule-fire:<jobId>:<slot>`, win the claim, and make the
> scheduler **skip that job's fire** — likewise against heartbeat, retention,
> CMS publish and connection refresh. Suppressing host-scheduled work is a
> denial-of-service with no tooling required. The lane split closes it by
> construction: a caller key can never reach the mutex table.
>
> **CORRECTION 3 (same review) — the defect is on TWO routes.** This ADR names
> only `routes/runs.ts` and pins `endpointId` to the literal `POST:/v1/runs`.
> `routes/userAgents.ts:104` performs the identical raw-key `claimIdempotency`,
> and `:194` the identical `putIdempotency`. P0 fixes **both**; shipping one is
> worse than shipping neither, because it manufactures a false "the idempotency
> leak is fixed" belief. A third consequence of the shared keyspace: even within
> ONE tenant, a key reused across the two endpoints returns the other endpoint's
> body (a `CreateRunResponse` served with 201 from `/v1/user-agents`), which is
> what makes `endpointId` load-bearing rather than defensive.

### Identity and schema

The logical key is `(tenantId, endpointId, idempotencyKey)`, where `endpointId`
is the stable route identifier `POST:/v1/runs`, not a raw URL. Persist:

- `tenant_id`, `endpoint_id`, `idempotency_key` (composite primary key);
- `request_digest` (SHA-256 over RFC 8785 canonical JSON plus the endpoint's
  semantic request version);
- `state` = `pending | completed | released`;
- `claim_token`, `claim_expires_at`, `created_at`, `updated_at`;
- final `response_status`, `response_headers`, `response_body`, and `run_id`.

The key and request digest are never logged in plaintext; logs use a truncated
salted digest. The API returns no other tenant's existence signal.

### Claim state machine

1. Atomically insert `pending` with a lease and random claim token.
2. On conflict, load only within the same composite key.
3. Different request digest returns the prescribed replay-mismatch error.
4. Live `pending` returns the protocol's typed in-flight response and retry hint.
5. Expired `pending` is atomically reclaimed with a new claim token.
6. The winner commits the final response using compare-and-set on claim token.
7. Any pre-commit failure releases or shortens the claim in `finally`; it never
   overwrites a completed winner.

### Migration

Raw-key rows cannot be assigned a trustworthy tenant after the fact. The
migration creates the new table, stops reads from the legacy table, retains the
old table for one rollback window, then drops it. Old cached responses are not
replayed across the cutover; this is safer than guessing ownership.

> **CORRECTION 4 (same review) — "then drops it" is wrong; do NOT drop the
> table.** Under the lane split the legacy `idempotency` table is not legacy at
> all: it remains the mutex lane's live storage for the ~11 daemons. What stops
> is HTTP-lane *use* of it. The corrected migration is: create
> `idempotent_response` **empty**, repoint both routes at it, rename the mutex
> interface, and leave `idempotency` in place permanently. There is also no
> one-time cleanup of HTTP leftovers in it — any "delete rows that look like
> caller keys" heuristic is unsound for exactly the reason in CORRECTION 2
> (callers can forge daemon-shaped keys); the existing prefix prune ages them
> out.
>
> **The consequence this section omits, stated plainly:** HTTP keys in flight
> across the deploy lose their cache, so a client retrying mid-deploy creates a
> **second run** instead of replaying the first. That is real and user-visible.
> It is still strictly safer than serving another tenant's response, so it is
> accepted — but it belongs in the deploy note rather than being discovered in
> production.

## Boundaries audit

| Concept | Owner |
|---|---|
| Claim/complete/release/reclaim | `Storage` interface and each adapter |
| Request canonicalization | one host utility imported by the route and tests — note there are currently **two** copy-pasted implementations to fold in, `routes/runs.ts:68,70` and `routes/userAgents.ts:69,71`, each with its own process-local `Map`; the comment at `runs.ts:60-67` that licenses the in-memory gap ("a bonus, not a primary correctness signal") is deleted in the same commit that makes it durable |
| Fire-once mutex (daemons) | the existing `idempotency` table via `claimOnce` / `pruneClaimsByPrefix` — a SEPARATE concept from this ledger (CORRECTION 1); host-generated keys only, never caller-supplied |
| HTTP response/error mapping | existing runs route/error middleware |
| Retention | ADR 0380's existing sweep, updated for composite keys/states |
| Provider invocation idempotency | executor invocation log; not duplicated here |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core storage + run route; no feature package. |
| 2 | Toggle | None. Tenant isolation is unconditional. |
| 3 | Workflow surface | Existing run creation only. |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None. |
| 7 | Public surface | Same endpoint and response contract; typed in-flight behavior follows the accepted protocol. |
| 8 | RBAC | Tenant comes only from authenticated middleware, never request body. |
| 9 | Replay/fork | Cached create response is byte-stable; effect identity remains executor-owned. |
| 10 | Frontend | No new UI. |

## Phases and verification

| Phase | Scope | Verification |
|---|---|---|
| P0 | Composite tenant/endpoint key and no legacy reads | Cross-tenant adversarial tests in memory, SQLite and Postgres; Tenant B never receives A's run id/body/status. |

> **CORRECTION 5 (same review) — "memory, SQLite and Postgres" is TWO adapters,
> not three.** `storage/index.ts:34-37` resolves `memory://` by re-opening the
> **SQLite** backend at `:memory:` ("Avoids carrying a second in-memory
> implementation in the sample"). There is no independent memory adapter, so a
> memory run is a SQLite run wearing a hat and must not be counted as separate
> evidence. P0's adversarial suite runs against **SQLite and Postgres**.
>
> **P0 additionally carries the forcing function**, which this ADR lacked
> entirely: (a) the ledger API takes a **closed** `IdempotentEndpoint` union, so
> a third route is a compile error until it registers — a free string would let
> `POST:/v1/runs` and `post:/v1/runs` become two keyspaces and reopen the bug;
> and (b) `test/idempotency-lane-tripwire.test.ts`, modelled on the
> `capability-token-tripwire.test.ts` precedent named in `ARCHITECTURE.md:133`,
> fails when any file under `src/routes/**` or `src/features/**` calls the mutex
> API or passes `req.header('idempotency-key')` to anything but the ledger, with
> the daemon call sites as a no-growth allowlist.
>
> **CORRECTION 6 (post-implementation) — the P0/P1 line moved, and why.** As
> written, P0 was "composite key" and P1 was "durable request digest + claim
> lease/CAS/release". Implementing it that way would have left the process-local
> `Map` alive through P0 while the route around it was already rewritten,
> touching the same lines twice for no gain. The digest is one column and the
> same call site as the claim, so it shipped WITH P0; what P1 retains is the
> genuinely separable and harder half — the **lease, claim token, expiry
> reclaim, CAS commit and release-in-`finally`** — plus the RFC 8785
> canonicalization upgrade. The redrawn line is: **P0 = identity** (who owns a
> key, and is it the same request), **P1 = liveness** (what happens when the
> owner stalls or dies). The P0 columns are created by migration 37/35 but
> unused until P1, so P1 needs no second table rebuild.
>
> **CORRECTION 7 (post-implementation) — a THIRD header reader exists, and it
> is fine.** The tripwire found `features/crm/bookingRoutes.ts:234`, which the
> `claimIdempotency` grep had missed because it never calls storage's
> idempotency API at all. It is a genuinely different and safe pattern: the key
> is a **guard field** compared against `prior.idempotencyKey` on a row whose id
> is already `bookingIdFor(bookingLinkId, slotStartUtcMs)` — deterministic and
> link-scoped, hence tenant-scoped (`bookingService.ts:210-217`). No shared
> keyspace, so nothing to collide in. Recorded as a reviewed exemption in the
> tripwire with that reasoning, plus a stale-exemption check so it cannot later
> cover a real reintroduction on the same path.
| P1 | Durable request digest + claim lease/CAS/release | Restart, exception, timeout, concurrent-winner, mismatch and expired-claim tests. |
| P2 | Retention/migration/observability | Forward and rollback migration tests; bounded cardinality metrics; plaintext-key log canary. |
| P3 | RFC 0150 recipe v2 | Only after RFC 0150 Accepted: align logical invocation ordinal/provider retry semantics and split-brain fencing. |

## RFC gate

P0–P2 implement requirements already present in the current protocol and are an
urgent security correction. They do not wait for RFC 0150. P3 changes the
cross-host effect-identity recipe and MUST wait for RFC 0150 to be Accepted.

## Implementation record

### Merged-tree provenance — reconciled 2026-08-17 (H44)

Each phase block below was written on its own branch, so it names branch commits
and the merge is missing. This table is the phase → PR → **merge commit on
`origin/main`** mapping. Every row was verified with `git show <sha> --stat`
against the tree, not read off the PR body.

| Phase | PR | Merge commit | Merged | Witness tests |
|---|---|---|---|---|
| P0–P2 | — (pre-dates the program's PR discipline) | `bfec8b9e4` | 2026-08-11 | `idempotency-tenant-isolation.test.ts`, `idempotency-migration-and-logs.test.ts`, `idempotency-lane-tripwire.test.ts`, `storage-adapter-parity-testcontainers.test.ts` — **corrected 2026-08-18**: this cell named `idempotent-response.test.ts` and `run-idempotency-*.test.ts`, neither of which has existed on ANY ref (`git log --all --diff-filter=A` finds no such file). A reader verifying by filename would have concluded the witnesses were deleted |
| P3 — RFC 0150 §B/§C effect identity + semantic request digest v2 | [#3273](https://github.com/openwop/openwop-app/pull/3273) | `e6f22d739` | 2026-08-16 | `effect-identity-v2.test.ts`, `semantic-request-digest-v2.test.ts`, `effect-identity-migration.test.ts`, `llm-cache-key-advert-parity.test.ts` (+ `context-economy-caching`, `executor-durability-adr0326`, `storage-postgres`, `storage-adapter-parity-testcontainers` extended) |
| P3 residue — the two `replay-llm-cache-key*` quarantine entries retired | [#3283](https://github.com/openwop/openwop-app/pull/3283) | `3653cd90d` | 2026-08-16 | `conformance/quarantine.json` → `entries: []`, `maxEntries: 0` |

Sabotage evidence for P3 is 14 breaks / 14 red, tabled in #3273 (ordinal returns
`attempt` → 6 red; ordinal pinned to `0` → 3 red; `tenantId` dropped from the
preimage → 4 red; NFC normalization inside JCS → 2 red; `tools[]` sort removed →
2 red; the v1 exclusion set restored → 4 red; `providerOptions` dropped → 2 red;
retry-stable `latest()` removed → 1 red; `credentialRefHashed` smuggled back → 1
red; §E dual-read removed → 1 red; migration DROP-and-recreate → 2 red; bare
`RENAME` → 1 red; a `crossRegion` posture advertised → 1 red; `beginNodeActivity`
made a no-op → 3 red across two files).

**Re-measured at `fb6cbbcba` (H44):** the four P3 witness files are **4 files /
44 tests green**. That is a re-run, not new evidence — it says the phase still
holds on today's tree, nothing about the sabotages, which are only ever evidence
at the time they were applied.

**NOT done, unchanged by this reconciliation:** the `runId`-derivation residual
(decided, not re-deferred — see below), and cross-region effect identity, which
is 0551 P4's row in `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` and not this
ADR's.

### P0 — shipped 2026-08-11

| Item | Where |
|---|---|
| Lane owner + closed endpoint union + digest + log redaction | `src/host/idempotentResponse.ts` (new) |
| Ledger interface (`claimIdempotentResponse` / `completeIdempotentResponse` / `pruneIdempotentResponses`) | `src/storage/storage.ts` |
| Mutex lane renamed `claimOnce` / `putOnce` / `pruneOnceByPrefix` | `src/storage/storage.ts` + 10 daemon call sites |
| `idempotent_response` table | sqlite migration 37, postgres migration 35 |
| Adapters | `src/storage/sqlite/index.ts`, `src/storage/postgres/index.ts` |
| Both vulnerable routes repointed | `src/routes/runs.ts`, `src/routes/userAgents.ts` |
| Ledger retention on the ADR 0380 tick | `src/host/retentionSweepDaemon.ts` |
| Adversarial + restart tests (SQLite) | `test/idempotency-tenant-isolation.test.ts` (12) |
| Adversarial tests (REAL Postgres) | `test/storage-adapter-parity-testcontainers.test.ts` (5) |
| Forcing function | `test/idempotency-lane-tripwire.test.ts` (7) |

Gate: backend `tsc --noEmit` clean; full vitest **1495 files / 11053 tests, 0
failures**; real-Postgres parity 14/14.

### P1 — shipped 2026-08-11

Liveness: what happens when the claim holder stalls or dies.

| Item | Where |
|---|---|
| `idempotencyLeaseMs()` — DERIVED from the request timeout | `src/host/idempotentResponse.ts` |
| Lease + claim token on claim; expired-claim reclaim with CAS | both adapters |
| `completeIdempotentResponse` returns `boolean`, CAS on the token | both adapters |
| `releaseIdempotentResponse` — DELETE, no-op once completed | both adapters |
| Route `try/finally` releases an uncommitted claim | `routes/runs.ts`, `routes/userAgents.ts` |
| Lease/reclaim/CAS/release tests (SQLite + REAL Postgres) | 10 new cases |

**The lease is derived, not chosen, and that IS the safety property.** Reclaiming
is only safe if an expired claim implies a *dead* holder rather than a slow one.
The claim→complete critical section runs entirely inside one HTTP request, which
`requestTimeoutMiddleware` bounds — so `lease = requestTimeout + 60s` makes a
live holder structurally unable to outlive its lease. Had the lease been a
hand-picked constant shorter than a legal request, reclaim would have *caused*
the duplicate execution this whole feature prevents: holder and reclaimer would
each create a run, and while the CAS means the client sees only one response,
the other run still exists and still executes. A config-invariant test asserts
`lease > requestTimeout` at every configured value, including
`OPENWOP_REQUEST_TIMEOUT_MS=0` (middleware disabled ⇒ the bound becomes Cloud
Run's `--timeout=300`).

**Residual, accepted and stated:** a holder that crashes *between* `insertRun`
and `complete` has already created a run, so the reclaimer creates a second.
That window is narrow and real. Fixing it would mean deriving `runId` from the
idempotency key — `runId` is wire-visible and load-bearing for replay/fork, so
that is its own decision, not a P1 detail.

**RFC 8785 was deliberately NOT implemented in P1**, reversing this ADR's own
plan. Every digest is compared only against digests this host wrote, so
cross-implementation agreement is not required yet; it becomes required at P3
under RFC 0150. Measured while deciding: because the body is `JSON.parse`d
before hashing, `1.0`/`1` and `1e2`/`100` **already digest identically** — the
number-canonicalization argument for JCS does not apply. Only NFC differs, and
it fails toward a 409, never a wrong body. The false claim to the contrary in
`idempotentResponse.ts` was corrected rather than left to justify a needless
dependency.

**Two vacuous tests were caught and fixed during P1**, both by asking whether
the test could fail:
- the route-level release test first used an unknown `workflowId` — which
  throws at `runs.ts:317`, **before** the claim at `:343`, so no claim was ever
  taken and the retry trivially passed. Rewritten to force the ADR 0482 budget
  cap (`:391`), the first throw that genuinely lands after the claim, and then
  verified to FAIL (409 instead of 201) with the release disabled.
- a mechanical edit had left `claimToken: c.outcome === 'claimed' ? … :
  'not-claimed'` in several tests. A placeholder token makes `complete`
  silently no-op — which is what the CAS is *for* — so the test would fail
  elsewhere or not at all. Replaced with a `tokenOf()` helper that throws.

### P2 — shipped 2026-08-11 (partially; one item deferred with a reason)

| Item | Status |
|---|---|
| Retention (`pruneIdempotentResponses` on the ADR 0380 tick) | **Shipped in P0** — see finding 1 below; deferring it would have shipped a growth leak |
| Forward-migration integrity (7 tests, `legacyDbAtVersion`) | Shipped |
| Rollback/replay safety | Shipped — replaying migration 37 over a live table preserves rows |
| Plaintext-key log canary | Shipped |
| **Bounded-cardinality metrics** | **DEFERRED to ADR 0556 P0 — see below** |

The migration tests use `legacyDbAtVersion(36)` rather than a hand-rolled
schema, per that fixture's own warning: a hand-rolled table models a database
that has never existed, and doing so caused three consecutive breaks (#1851,
#1868). They assert the things whose failure would be silent — that the primary
key really is `(tenant_id, endpoint_id, idempotency_key)` (a wrong key leaves
the cross-tenant leak open while every other test still passes), that all three
PK columns are `NOT NULL` (SQLite permits NULLs in a PK and treats multiple NULL
rows as non-conflicting, which would make the claim non-atomic on one adapter
only), that the mutex table is **not** dropped, and that nothing is backfilled.

**Metrics are deferred, and this is a boundaries decision, not a shortcut.**
This ADR asks P2 for "bounded cardinality metrics", but the app has **no metrics
or counter seam** — `src/observability/` is tracer, logger, spans and cost
emission only. Emitting counters here would mean standing up a second telemetry
path beside the one **ADR 0556 P0** exists to build ("metric catalog,
SDK/export/shutdown, cardinality lint"). That is precisely the parallel-system
failure `ARCHITECTURE.md` forbids, and the cardinality lint 0556 P0 brings is
exactly what a per-key/per-tenant idempotency counter needs. The ledger's metric
emission therefore lands as part of 0556 P1 ("instrument critical seams"), and
is recorded in that ADR's dependency list rather than being quietly dropped.

### Three findings the phase produced beyond its own scope

1. **The `pruneOnceByPrefix('')` sweep was the HTTP cache's only cleaner.**
   Splitting the lanes silently orphaned the new table's retention, trading a
   security defect for an unbounded-growth one. `pruneIdempotentResponses` and
   two tests (`ledger has its OWN retention`, `pruning one lane does not prune
   the other`) landed in P0 rather than P2 for that reason.

2. **`storage-adapter-parity-testcontainers.test.ts` had NEVER executed.** Its
   `skipIf` predicate was a module-level `const` derived from a `dockerAvailable`
   flag that a later `beforeAll` assigned — and module scope evaluates during
   COLLECTION, so the predicate was permanently `true`. The file reported green
   while covering nothing, on Docker-equipped machines included. The probe was
   made synchronous and moved to module scope. **This is the exact class ADR 0548
   invariant 3 names: a test-seam success licensing a claim the deployment
   profile never witnessed.**

3. **Un-skipping it exposed SIX live Postgres defects**, all one class:
   node-postgres marshals a JS **array** parameter as a Postgres array literal,
   which a `JSONB` column rejects with `invalid input syntax for type json`
   (objects are unaffected — the driver JSON-stringifies those — which is why
   every fixture in the repo passed). Each was confirmed by a failing probe
   against real Postgres before being fixed; none was patched on suspicion.

   | Site | Column(s) | Reachability |
   |---|---|---|
   | `insertRun` | `inputs` | **Caller-supplied.** `RunRecord.inputs` is `unknown` and arrives verbatim from the `POST /v1/runs` body — a client sending a top-level array made run creation fail outright on the product's primary endpoint |
   | `resolveInterrupt` | `resolved_value` | **Caller-supplied**, from the resume request body |
   | `appendEvent` | `payload` | Any event carrying an array payload |
   | `insertWebhook` | `events`, `tags` | **Webhook registration was broken on every Postgres deployment** — and this is literally the first entry in the test file's own `PG_MEM_INCOMPAT` list |
   | `insertInterrupt` | `data`, `resume_schema` | An interrupt offering a list of choices was unstorable |
   | `putInvocation` | `result` | Any array-valued invocation result |

   Checked and deliberately NOT changed, because their types cannot be arrays:
   `notifications.metadata` (`Record<string, unknown>`) and
   `webhook_deliveries.payload` (already a JSON `string` — wrapping it would
   double-encode). Fixed via a shared `jsonbParam()` helper whose doc-comment
   names that hazard.

   The severity is worth stating plainly: **on Postgres — the production
   adapter — `POST /v1/runs` with an array `inputs` returned a 500.** SQLite
   deployments were unaffected, which is why the sample and every local run
   looked healthy.

### P3 — implemented 2026-08-16

RFC 0150 `Accepted` (openwop `5e2220bb`), so the three-part gate in
`docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` clears for §B + §C. §D stays with
ADR 0551 P4; the host advertises no `crossRegion` value and that non-claim is
now pinned positively rather than left as an absent register row.

> **CORRECTION 8 (P3) — the phase table's "Only after RFC 0150 Accepted" was
> right about the RFC and wrong about the cost of waiting.** It read as though
> deferral were neutral. It was not: the host has advertised
> `capabilities.multiAgent.executionModel.replayDeterminism.llmCacheKeyRecipe:
> "spec-rfc-0041"` since RFC 0041, and per RFC 0041 §A that value **claims the
> spec-canonical recipe**. The canonical recipe became v2 the moment
> `replay.md` did, so every day of deferral was a day the host advertised a
> recipe it did not compute. The advertisement is unchanged by this phase —
> implementing v2 is what makes it honest again, which is the opposite of the
> "new capability, new advert" shape the phase was scoped as.

> **CORRECTION 9 (P3) — this ADR's row 9 said "effect identity remains
> executor-owned", which located it in the wrong module.** It is not the
> executor's: it was `aiProviders/aiProvidersHost.ts`'s, computed inline as
> `computeProviderKey(...)` plus a `{runId, nodeId, attempt, providerKey}`
> literal, with no owner and no name. That is why it carried `attempt` and
> omitted `tenantId` without anything being able to notice. P3 gives it an owner
> (`host/effectIdentity.ts`), which is the change that makes the composition
> reviewable at all.

#### Recipe → host mapping

| Spec | Requirement | Where it lands |
|---|---|---|
| `idempotency.md` §B | `logicalInvocationId = base64url(sha256("openwop:activity:v2"‖tenant‖run‖node‖ordinal‖providerKey))` | `src/host/effectIdentity.ts:logicalInvocationId` |
| §B | `attempt` MUST NOT participate | the input type has no field for one; `attempt` stays a *column*, never a preimage term |
| §B | ordinal assigned once per logical activity, stable across transport/provider retries | `effectIdentity.ts:nextLogicalInvocationOrdinal` — per `(runId,nodeId)`, **rewound** by `beginNodeActivity`, which `executor.ts` calls at every node launch (and as a safety net when the attempt changes) |
| §B | two distinct logical invocations get different ordinals even on identical inputs | same allocator, incremented per `callAI` within an attempt |
| §B | `tenantId` in the preimage | `scope.tenantId`, threaded from `AdapterScope` |
| §B v1.4 | cross-scope effects additionally keyed on a business identity | already true — `features/commerce/commerceService.ts` keys Stripe refunds `commerce-refund:<orderId>`; P3 **pins** it (`effect-identity-v2.test.ts` § cross-scope) |
| §"Engine guarantees" 1–2 | persist before returning; a retry resolves the record | `getLatestInvocation` (new) is the live, retry-stable read |
| `replay.md` §C | canonical object `{recipe, provider, model, request, providerOptions?}` | `src/providers/llmCacheKey.ts:projectSemanticRequestV2` |
| §C.2 | RFC 8785 JCS, **no** Unicode normalization | `llmCacheKey.ts:canonicalize` — code-unit key sort, `undefined` dropped, no `normalize()` |
| §C.1 | `providerOptions` carried, never dropped | `projectSemanticRequestV2`, asserted by the `provider-options-carried` vector + a value-sensitivity leg |
| §C §A | transport-only fields excluded | `credentialRefHashed` **removed** from the digest; the host key is pinned to `semanticRequestDigestV2` exactly |
| §E | dual-read v1 records; write v2 only | `aiProvidersHost.ts:legacyProviderKeyV1`, read on a v2 miss; nothing writes v1 |
| §E | recipe stamps distinguishable | the tags are IN both preimages (`openwop:activity:v2`, `openwop-semantic-request-v2`) — a v1 and a v2 digest cannot be mistaken for each other |
| RFC 0041 §A | advertised recipe must be the one honoured | `routes/discovery.ts` unchanged (`spec-rfc-0041`); the `llm-cache-key` seam now answers v2 and echoes `recipe` |

#### Migration

sqlite **39** / postgres **37**: `invocation_log.provider_key` → `invocation_id`.
A pure `RENAME COLUMN`, guarded by a column probe so a replay is a no-op. The
primary key is untouched, which is what keeps pre-P3 rows resolvable through the
§E dual-read. A drop-and-recreate would have passed every existing test while
invalidating the Layer-2 cache of every run in flight across the deploy — and the
observable consequence is not an error, it is a second paid provider call.

`attempt` deliberately survives as a column. §B retired it from the IDENTITY, not
from the record: the spec keeps it as telemetry, and ADR 0326 P3a's replay
fidelity needs the per-attempt outcome sequence.

#### Vectors

**11/11 reproduce byte-for-byte**, canonical preimage *and* digest, loaded from
the pinned `@openwop/openwop-conformance` **1.106.0**
(`vectors/semantic-request-digest-v2.json`, byte-identical to the corpus copy at
`40617a4d`). Read from the package rather than copied into `test/fixtures/`
deliberately: a copied fixture pins this host to a snapshot of the contract and
goes green forever after the corpus moves, which is the exact failure the file
exists to prevent.

#### The `runId`-derivation residual — P3 does NOT derive it

P1 left this open: a holder that crashes between `insertRun` and `complete` has
already created a run, so the reclaimer creates a second. P1 said fixing it would
mean deriving `runId` from the idempotency key and deferred the decision here.

**Decision: no, and not later either in this form.** Three reasons, in order of
weight:

1. **It would defeat §F structurally.** The caller key is caller-controlled and
   routinely embeds customer identifiers, which is precisely why §F requires it
   never be logged in plaintext and why P0 ships `redactKey`. A derived `runId`
   is wire-visible — it appears in URLs, run events, webhook deliveries, OTel
   spans and every log line. Deriving it would publish, on the busiest surface
   the host has, the value one section over says must never be printed.
2. **It hands a caller the Layer-2 keyspace.** `runId` is in the §B preimage. A
   caller who can choose `runId` can pre-compute the logical effect identities
   of a run before creating it — within their own tenant, but that is enough to
   collide two runs' invocation logs deliberately.
3. **It is the wrong instrument.** The residual is a *crash between two writes*,
   which is an atomicity problem. What closes it is making run creation part of
   the claim's compare-and-set (an `insertRun` CASed on the claim token), or
   §D's fencing token. Neither needs the run id to carry caller data.

Recorded rather than silently re-deferred: the residual stays open, owned by
**ADR 0551 P4** (§D fencing) with the CAS-on-claim-token option as the cheaper
host-local alternative if 0551 P4 stays parked.

#### Verification

| Test | Cases | What it pins |
|---|---|---|
| `test/semantic-request-digest-v2.test.ts` | 18 | 11 golden vectors (canonical + digest) + the three PAIR relationships + transport-field exclusion |
| `test/effect-identity-v2.test.ts` | 16 | §B composition recomputed from the spec, ordinal semantics, **G9 host-tier retry stability**, §E dual-read, cross-scope business key |
| `test/effect-identity-migration.test.ts` | 5 | rename, row preservation, PK intact, replay-safety, migration actually reached |
| `test/llm-cache-key-advert-parity.test.ts` | 4 | the ADVERTISED recipe is the one the host computes — see the conformance finding below |
| `test/agrade-wire-blocked-residue.test.ts` | 13 | 0549 P3 out of the blocked set; §D `crossRegion` still unclaimed |

**Sabotage table** — every new assertion was verified capable of failing by
breaking the thing it guards, watching it go red, and restoring:

| # | Sabotage | Result |
|---|---|---|
| 1 | ordinal returns `attempt` (identity varies per retry) | 6 red |
| 2 | ordinal pinned to `0` (a node's two calls collapse to one effect) | 3 red |
| 3 | `tenantId` dropped from the preimage | 4 red |
| 4 | NFC normalization added inside JCS | 2 red — the Unicode PAIR, exactly as designed |
| 5 | `tools[]` sort removed | 2 red |
| 6 | `seed`/`stop`/`maxOutputTokens` excluded again (the v1 defect) | 4 red |
| 7 | `providerOptions` silently dropped | 2 red |
| 8 | the retry-stable `latest()` read removed | 1 red |
| 9 | `credentialRefHashed` smuggled back into the digest | 1 red |
| 10 | §E dual-read removed | 1 red |
| 11 | migration DROPs and recreates instead of renaming | 2 red |
| 12 | migration guard removed (bare `RENAME`, not replay-safe) | 1 red |
| 13 | a `crossRegion` posture advertised | 1 red |
| 14 | `beginNodeActivity` made a no-op | 3 red, across two files |
| 15 | the seam drifts back to a v1-shaped digest | 1 red |
| 16 | the advertised recipe renamed to `homegrown-v9` | 1 red |
| 17 | the advertised recipe dropped entirely | 1 red |

**A defect the phase found on its own.** The ordinal was first rewound only when
`attempt` changed — which is invisible to the case that matters most. A HITL
`SuspendSignal` unwinds out of a node and the resume re-runs the handler **from
the top at the SAME attempt**, so the resumed body's first AI call would have
taken ordinal 1 instead of 0, minted a different identity, missed the cache and
called the provider a second time for an effect already performed. That is the
duplicate effect Layer 2 exists to prevent, arriving through the ordinal instead
of the retry counter — a defect the v2 composition would have introduced while
looking conformant. Fixed with an explicit `beginNodeActivity(runId, nodeId,
attempt)` that the executor calls at every node launch; sabotage 14 pins it.

The same change resolved an ambiguity two ADR 0326 P3a tests had been relying
on. They drove `callAI` twice at one attempt and expected the second to replay
the first, which §B now says is a SECOND logical effect ("a node that calls the
same provider twice on purpose is performing two effects"). Pre-P3 the two cases
were literally indistinguishable; the tests now declare which they mean.

**Sabotages 9 and 10 went GREEN on the first pass**, and that is the finding
worth recording: the two properties had no coverage at all, and the file read as
though they did. The credential-exclusion case originally compared two
`credentialRef` values through the `mock` provider — which `resolveCredential`
short-circuits, so both calls resolved the same sentinel and the assertion was
structurally unable to fail. It was replaced with an exact pin of the emitted key
against `semanticRequestDigestV2`, which catches ANY smuggled input rather than
the one field it was probing for. Without running the sabotage, both would have
shipped as green tests covering nothing.

#### The conformance suite contradicts itself, and the host follows the spec

Switching the `llm-cache-key` seam to v2 turned **four** scenarios red in the
pinned `@openwop/openwop-conformance` 1.106.0:
`replay-llm-cache-key.test.ts` (2) and `replay-llm-cache-key-portable.test.ts`
(2). All four recompute the expected key with the **v1** projection.

This is suite staleness, not host non-conformance, and the suite says so itself:
the same package ships `semantic-digest-v2.test.ts`, whose docblock states that
v1's exclusion of `max_tokens`/`stop`/`seed` "**is wrong**… a cache keyed
identically for both returns the wrong response — not a miss, a wrong hit."
Neither v1 scenario mentions RFC 0150. They were simply not re-pointed when §C
landed. `replay.md` itself is internally consistent — v2 is the recipe, and the
v1 exclusion list appears only inside a blockquote labelled as the defect — so
there was no spec ambiguity to stop on.

Three options were weighed and two rejected:

- **Answer v1 from the seam.** Suite fully green. Rejected: the seam would then
  report a recipe `callAI` does not compute, so a peer running conformance
  against this host would conclude our LLM cache keys follow v1 and that
  cross-host replay works under v1 rules. Both false. A green scenario
  licensing a false belief is precisely ADR 0548 invariant 3's failure mode.
- **Stop exposing the seam** (the scenarios self-skip on 404). Rejected for the
  reason `QUARANTINE.md` already states about the opt-out list: it converts a
  failure into an absence.
- **Quarantine the two files, keep the seam honest.** Taken. Entries carry the
  reason and the exit condition (a suite bump that re-points them at v2);
  `maxEntries` 0 → 2, which the ratchet permits as a reviewed decision.

**Quarantining a file also drops the assertions in it that were still right**,
and one was load-bearing — *"hosts advertising version: 4 MUST advertise
`replayDeterminism.llmCacheKeyRecipe`"*. Dropping a correct assertion to hide a
stale one is how a quarantine becomes decoration, so it was re-pinned at host
tier in `test/llm-cache-key-advert-parity.test.ts` and **strengthened**: the
conformance scenario only checked the advertisement is a *string*; this checks it
is *true*, by comparing the seam's answer to the same `semanticRequestDigestV2`
the live path calls.

> **EXIT CONDITION MET — 2026-08-16, the quarantine is empty again.** The
> entries were written to leave on one specific event: "a conformance bump that
> re-points these two files at v2". `openwop#1011` did exactly that (suite
> `1.109.0`), and the pin bump `^1.106.0` → `^1.123.0` brings it in. Both
> entries removed and `maxEntries` lowered 2 → 0 in that same commit, per the
> ratchet rule. Verified against the **installed** package rather than the
> sibling working tree — they are different artifacts and only the installed one
> is what the lane executes: both
> `node_modules/@openwop/openwop-conformance/src/scenarios/replay-llm-cache-key*.test.ts`
> now reference `openwop-semantic-request-v2`.
>
> Nothing host-side changed to close this. The host answered v2 the whole time;
> the suite stopped asking for v1. That is the outcome the third option was
> chosen for, and it is worth contrasting with the file's other emptying (the
> 2026-08-13 one), which was a harness defect that had made a machine-dependent
> measurement durable. This entry was a debt that was genuinely owed, carried
> openly with a falsifiable exit condition, and paid. The strengthened
> `llm-cache-key-advert-parity.test.ts` stays regardless — it is a better
> assertion than the one the suite ships.

That test caught its own vacuity twice. It first skipped on `version < 4`
because the boot never enabled Phase 4 — sabotage 16 renamed the advertised
recipe to `homegrown-v9` and the test stayed green. Enabling the phase flag alone
was still not enough: the whole `multiAgent` block is omitted unless the base
flag is set too. Both are now set in `beforeAll`, and the skip was replaced by an
assertion that Phase 4 IS advertised.

#### What P3 did not do

- **§D fenced multi-region ownership** — ADR 0551 P4. The host still advertises
  no `crossRegion` value, and `reconciled-records` would additionally oblige it
  to emit `openwop.idempotency.cross_region_conflicts_total`, which needs the
  metric seam ADR 0556 P0 owns.
- **Provider `Idempotency-Key` header injection.** §"Provider header injection"
  is a SHOULD, and the host's LLM adapters do not inject one today. The identity
  is now stable enough to inject — that is the precondition, and it did not hold
  before this phase — but wiring it per provider is adapter work with its own
  compatibility surface. Recorded here rather than left implicit; the internal
  dedup guarantee (MUST) is met without it.
- **`activityIdentityRecipe` / `semanticRequestRecipe` run stamps (§E).** Not
  needed while exactly one recipe is written and the dual-read is unconditional:
  a stamp whose only value is always `v2` is a field that cannot be wrong, and
  therefore cannot be checked. It becomes load-bearing when a v3 arrives, and
  the domain tags already make v1/v2 records distinguishable in the meantime.

## Alternatives weighed

- Prefixing the raw key with tenant in the route: rejected; endpoint scoping,
  digest, lease and release would still be absent and other callers could drift.
- Keeping the mismatch hash in memory: rejected; restart changes semantics.
- Retaining `__pending__` forever: rejected; it converts transient errors into
  permanent denial of service.

