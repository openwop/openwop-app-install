# ADR 0321 — Demo-tenant provisioning: idempotency fixes + per-tenant seed lock

Status: Accepted

## Context

The superadmin **"Provision demo tenant"** action (ADR 0292, `/example-data`)
flips the demo feature toggles for a tenant and then runs the full 23-seeder
`runExampleDataSeed` pass, streamed as NDJSON. In production it was observed to
(a) "get stuck halfway / time out" and (b) leave **duplicated** demo data —
most visibly duplicate advisory boards (`@@board-of-directors` twice,
`@@gtm-advisory`, `-2`, `-3`, `-4`, `-5`).

Investigation found three compounding causes:

1. **Cloud Run's 300s request-timeout kills the stream.** ADR 0292 streams the
   seed directly to Cloud Run to dodge the Firebase `/api` ~60s idle cap, but
   Cloud Run still hard-caps *total* request duration. The full reseed (CDP
   ~2200 events, commerce depth, embeddings/affinity rebuilds) exceeds 5 minutes
   → the connection dies before the `summary` line → the client throws
   *"stream ended without a summary."*

2. **A genuine sequential idempotency bug in `demoOpsPlanningSeed`.** Its
   "Go-to-Market Advisory" board guard read
   `advisoryStore.listForTenantIndexed(tenantId)` — a tenant *secondary index*.
   But the advisory-board **service** constructs its `DurableCollection`
   **without** a `tenantOf`, so `createBoard` never writes the index marker
   (`DurableCollection.put` only maintains the index when `tenantOf` is set).
   The guard therefore always read empty → every run created another board, and
   `createBoard` auto-uniquifies the handle (`uniqueHandle` → `-2/-3/…`).
   `strategyShowcaseSeed` created its "Board of Directors" with **no** guard at
   all (its top-level early-return covered a sequential re-run but nothing else).

3. **The seeders' guards are not concurrency-safe.** Every seeder guards each
   create with a read-then-create-by-name/key/id check — idempotent for a
   *sequential* re-run, but not atomic across *concurrent* ones. Because the
   timeout makes the action look stuck, operators re-click Provision, launching
   **overlapping** seed passes (multiple Cloud Run instances). Both read
   "absent" and both create → duplicates across many entity types, not just
   boards. This is the source of the "other data is also duplicated" reports.

A four-way audit of all 23 seeders confirmed causes 2–3 are the *only*
duplication vectors; every other seeder is idempotent (deterministic ids /
existence guards / count early-returns), including the workforce run-history.

## Decision

Three changes, layered defense:

1. **Fix the two non-idempotent board creators to guard by handle** through the
   consistent `listBoards` primary scan (the pattern the working `advisors`
   seeder already uses in `advisoryBoardSeed.ts`). Never rely on a secondary
   index a different writer maintains.

2. **Introduce a per-tenant seed lock** (`host/seedLock.ts`, `withSeedLock`)
   built on the atomic `kvCompareAndSwap` primitive, wired into **both**
   write-path routes (`/example-data/provision-demo` and `/example-data/run`).
   A concurrent seed for the same tenant gets a clean `409` instead of racing
   the guards. A lock orphaned by a platform-killed request auto-expires after
   1h and is stolen (CAS on its exact value), so a crashed provision never
   wedges the tenant. Dry-run (`/run` preview) writes nothing and is not locked.

3. **Raise the Cloud Run request timeout to 3600s** (ops change, not code) so a
   single provision run finishes and the re-click pressure — the trigger for
   cause 3 — disappears.

The lock is the structural fix (it makes *every* seeder's guard safe under
re-click); the two board guards are correctness fixes that also serve as
defense-in-depth; the timeout raise removes the trigger.

## Alternatives considered

- **Only raise the timeout.** Removes the trigger but leaves the guards
  concurrency-unsafe — a determined double-click (or a multi-tab operator) still
  duplicates. Rejected as incomplete.
- **Make every seeder guard atomic (CAS/deterministic-id everywhere).** Correct
  but a large, per-seeder change across 23 modules with ongoing drift risk. The
  single per-tenant lock achieves the same guarantee at one seam. Deferred as
  unnecessary given the lock.
- **Give the advisory-board service a `tenantOf` so the index is maintained.**
  Fixes the specific stale-index read but leaves a footgun (two collection
  instances, one indexed one not, over the same keyspace) and doesn't address
  concurrency. Guarding by the primary scan is simpler and local to the seeder.
- **Move provisioning to a background job the page polls.** The robust long-term
  shape (no dependency on one open connection). Larger change; deferred — the
  timeout + lock solve the reported problem. Recorded as future work.

## Trade-offs

- The lock serializes seeding per tenant. That is the intent; the only visible
  effect is a `409` on a concurrent re-click, surfaced to the operator as
  "already running." No impact across tenants (the key is tenant-scoped).
- The 1h stale-lock TTL means a truly hung provision blocks re-provisioning for
  up to an hour. Acceptable: the raised request timeout is 1h, so a live run is
  never mistaken for stale, and a killed run's connection drop is independent of
  the lock (the TTL is the backstop, not the primary release).

## Implementation

| Change | File |
|---|---|
| Board guard by handle (strategy showcase) | `backend/typescript/src/host/strategyShowcaseSeed.ts` |
| Board guard by handle via `listBoards` (ops planning) | `backend/typescript/src/host/demoOpsPlanningSeed.ts` |
| Per-tenant seed lock | `backend/typescript/src/host/seedLock.ts` (new) |
| Wire `withSeedLock` into both write-path routes | `backend/typescript/src/routes/agentOps.ts` |
| Regression: no gtm-advisory duplication on re-seed | `backend/typescript/test/demo-ops-planning-board-idempotent.test.ts` (new) |
| Ops: `gcloud run services update … --timeout=3600` | Cloud Run `openwop-app-backend` (deploy step) |

Verified: backend `tsc --noEmit` clean; the seed test suites pass (incl. the new
regression). Existing duplicates are removed by **Clear example data** (each
seeder's `clear()` deletes by its seed marker / `createdBy`), then one clean
Provision run rebuilds a single copy.

## Addendum — the clear/delete path (same investigation)

Follow-on symptoms surfaced from the same root: with duplicates accumulated,
**Clear example data** "ran a long time but left tons of data" (orphaned pins,
undeleted boards), and manual board delete "always failed". Causes + fixes:

1. **Clear timed out.** Unlike the seed, the clear route returned plain JSON and
   the UI POSTed it through the Firebase `/api` rewrite (~60s cap). The full
   clear — cascade-deleting ~20 roster members, thousands of CDP rows — exceeds
   60s → killed → partial clear. (Because clear is partial, the roster members it
   never reached keep their sidebar pins — the "pins remain" report; the cascade
   *does* unpin, ADR 0023, once it runs.) **Fix:** stream the clear as NDJSON
   from the direct `*.run.app` URL (header-flush → dodges the `/api` cap and the
   request timer; bounded only by Cloud Run's outer timeout) and take the seed
   lock, exactly like the seed. `runDemoClear` gains an `onStep` emitter and the
   UI shows live progress.

2. **Manual board delete always 403'd.** `deleteBoard` enforced owner-only
   (`createdBy === userId`), but demo boards are created by synthetic seed actors
   (`demo:advisory-seed`, `demo:strategy-showcase`, `demo:ops-planning`) that no
   human is, so nobody could ever delete a leftover seeded board. **Fix:** a
   superadmin may delete any board in the workspace (`allowAdminOverride` passed
   from the route via `isSuperadmin(req)`); non-superadmins keep owner-only.

3. **The `/example-data/status` page 503'd** counting the bloated data past the
   30s request-timeout backstop. Mitigated live (no rebuild) by raising
   `OPENWOP_REQUEST_TIMEOUT_MS` to 120s; it self-resolves once the streamed clear
   drains the bloat (counts are fast again on a clean tenant).

| Change | File |
|---|---|
| `runDemoClear` streams per-step (`onStep`) | `backend/typescript/src/host/exampleDataSeeders.ts` |
| Clear route: stream + seed lock | `backend/typescript/src/routes/agentOps.ts` |
| Superadmin board-delete override | `backend/typescript/src/features/advisory-board/service.ts`, `.../routes.ts` |
| Streaming clear client + live progress | `frontend/react/src/client/exampleDataClient.ts`, `.../settings/ExampleDataPage.tsx` |
| Ops: `OPENWOP_REQUEST_TIMEOUT_MS=120000` | Cloud Run env (live mitigation) |

**Stopped seeding fabricated AI-chat history.** Each of the 10 demo personas
seeded a "kickoff" chat thread (`demo-kickoff:<rosterId>`, 2 opening turns) into
its real chat history — noise a user never wrote, and which the roster cascade
never cleared (orphaned forever). The demo no longer seeds it: the
`conversation` field is removed from `SeedAgent` / `AgentDepthSpec` / the seeder /
`exampleAgents.json`, and `clearExampleAgents` now prefix-sweeps any leftover
`demo-kickoff:*` sessions (session delete cascades its messages; the KV
conversation meta is dropped too). Prefix-scoped, so a user's own chats are never
touched.

| Stop seeding kickoff chat + sweep orphans | `backend/typescript/src/host/demoAgentDepthSeed.ts`, `.../exampleDataSeed.ts`, `.../seed-data/exampleAgents.json` |

Verified: backend `tsc` + seed/advisory-board suites pass; frontend `npm run
build` (token/CSS/bundle gates) clean.

## Open items

- **Background-job provisioning** (poll-based) if we want to remove the
  single-request dependency entirely — deferred.
- **Status count cost** — the per-seeder counts are O(rows); fine on a clean
  tenant, but a future bounded/cached count would harden the page against a
  bloated tenant. Deferred (the streamed clear keeps tenants clean).
