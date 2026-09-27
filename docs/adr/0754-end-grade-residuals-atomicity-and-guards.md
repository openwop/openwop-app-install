# ADR 0754 — END-pass residuals: fork gate atomicity, create-only content writes, the artifact lookup, a deployment-wide issuer guard

Status: implemented

Date: 2026-09-26. Follows ADR 0755, which fixed the RFC witness program's `/grade-code`
Blockers and listed its residuals. Team-lead asked for every residual rated Improvement
or higher to be closed, with `/architect` deciding each one. Nice-to-haves stay in ADR
0755 with their reasons. `WIT-WH-3` (an expired previous webhook secret kept at rest) was
closed separately by the `/grade-data` pass (WHROT-1). The envelope-trust decision
(`WIT-A2UI-2`) stands as ADR 0755 recorded it.

## D1 — Fork gate re-creation atomicity (`WIT-FORK-2`): proven by the execution claim, not by a migration

**Finding.** `ensureForkInterrupts` reads the open rows, then inserts one, with no unique
constraint underneath. The review asked for a partial unique index on the open
`(run_id, node_id)` pair.

**Options.**
- (a) Partial unique index. Rejected, for the reason the `/grade-data` pass gave: nobody
  has ruled out that a node legitimately holds more than one open row (loops, fan-out),
  and a constraint built over existing dirty data fails the migration at boot.
- (b) A deterministic interrupt id with insert-or-ignore. Rejected: a conflicting row
  can be one that is already *resolved*, and deciding what an ignored insert means then
  is a new semantics problem.
- (c) Check whether the race is reachable at all. **Chosen.**

`ensureForkInterrupts` runs inside `executeRunBody`, so it runs only after ADR 0740's
execution claim. A checkpoint resume does not get refused at a held claim; it waits for
the holder to release (`RESUME_CLAIM_WAIT_MS`). Two concurrent deliveries of one fork
therefore **serialize**, and the second one finds the first one's gate already open.

The only unfenced path is `executionPreclaimed`, used by the orphan sweeper. Its
`claimOrphanedRuns` is itself atomic and only takes a run whose dispatch lease has
expired.

**Witness.** The "two CONCURRENT deliveries" leg in
`adr0751-fork-suspended-checkpoint.test.ts` drives two real `executeRun` deliveries of
one fork at once and asserts exactly one open gate. With the fence sabotaged
(`acquireExecutionClaim` returning unfenced), the same leg finds two open gates.
`WIT-FORK-6` (a concurrent idempotency test) is closed by the same leg.

**What would reopen it:** a fourth delivery path that sets `executionPreclaimed` without
an atomic claim of its own.

## D2 — Content create is create-only (`WIT-CNT-6`)

**Finding.** Both of ADR 0755's content checks, the tenant-wide `pageId` check and the
slug check, were reads that ran before the write. Two concurrent creates both passed
them, and then one of two things happened:
- the second write overwrote the first, because kernel `put` updates a row that
  already exists; or
- `createPage` silently renamed the slug to `slug-2`.

**Decision.**
- `putSystemEntity` gets `createOnly`. Its absent branch was already a CAS against
  `null`, but a lost race fell through to the update branch on the retry. With the flag
  set, any existing row is a `409 conflict`.
- The kernel adapter exposes this as `create()`.
- `createPage({ createOnly })` refuses rather than taking its idempotent seed early
  return: handing a create-only caller someone else's page counts as an overwrite.
- For the slug there is no row to CAS, so there is a post-write re-check. If the slug is
  not held by our page alone, or our page came back renamed, we withdraw our page and
  answer `409`. Both racers may withdraw, and a retry then succeeds. There are never two
  pages on one slug and never a silent rename.
- A slug-claim table was rejected: it would need release on rename and on delete, a
  second source of truth for slugs.

**Witness.** `test/adr0754-content-create-race.test.ts` races two creates for real. Two
sabotages each turn a leg red:
- going back to `put`, or letting the early return through, fails the one-`pageId` leg;
- removing the re-check fails the one-slug leg.

## D3 — The artifact lookup is one database read (`WIT-ART-4`), with no new index

**Finding.** `getArtifact` paged the run's log into the process: 500 events per
round-trip, up to 100 round-trips. Past event 50,000 it silently answered `404`.

**Decision.** A new `Storage.findFirstEventByPayload(runId, type, key, value)` does it in
one query:
- Postgres uses `payload->>$3 = $4`; SQLite uses `json_extract`.
- The existing `(run_id, sequence)` index narrows the scan to one run.
- The event-era wrapper translates `type` into the run's stored vocabulary, exactly as
  `appendEvent` does.
- `payloadKey` must match an identifier grammar (`PAYLOAD_KEY_RE`), so it can never be a
  path or SQL.

The 50k cap and its silent miss are removed.

**Why no new `(run_id, type)` index.** `events` is this host's largest table. A migration
runs in the boot transaction, so the index cannot be built `CONCURRENTLY`, and building it
would block event writes on a `db-f1-micro` for as long as the build takes, on every
instance's boot. The run-scoped index already bounds the scan to one run's rows. The
cost this fixes was round-trips and the cap, not the per-row filter. If a single run's
log ever makes the filter itself slow, the index belongs in an operator-run
`CREATE INDEX CONCURRENTLY`, not in a boot migration.
The operator option, accepted as the escape valve and deliberately not shipped, runs
outside any transaction against the live database:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_run_type ON events (run_id, type);
```

`IF NOT EXISTS` keeps a later boot migration that names the same index a no-op.

**Witness.**
- The parity test `findFirstEventByPayload finds the first matching event` runs on
  SQLite. It checks that the first match of the right *type* wins, that a miss returns
  null, and that an injection-shaped key is refused. The real-Postgres version is in the
  testcontainers parity file; pg-mem cannot append events.
- The `adr0746` artifact tests now read through the method.

## D4 — The harness-issuer guard fires on any deployment (`WIT-AUTH-4`)

**Finding.** The ADR 0745 D4 guard fired only when `K_SERVICE` was set. It protected the
one deployment this repo operates and no white-label adopter's.

**Decision.** A new `deploymentMarker(env)` recognises three kinds of signal:
- Managed-platform markers, each set by its platform on every instance: Cloud Run,
  Kubernetes, Fly, ECS, Lambda, Azure App Service, Heroku, Render and Railway.
- The enterprise `auth` deployment posture.
- A durable (Postgres) control-plane store.

Every local and harness boot this repo runs uses `memory://` (`release-conformance.sh`,
`e2e-routes.sh`, `ci.sh`, `test-shutdown.sh`), so none of them trips it.

An explicit local-only marker would have been an escape hatch, which this guard
deliberately never has. A local Kubernetes (kind/minikube) conformance boot is now
refused. The colocated `docker run` recipe in `CERTIFY-RUNBOOK.md` is unaffected.

**Witness.** In `adr0745-oidc-trust-guard.test.ts`, each marker on its own arms the
guard, for both a harness issuer and harness env. A control leg shows that the
release-image lane's exact env (no marker, `memory://`, `NODE_ENV=production`) still
boots.

## Remaining residuals — left in ADR 0755 with their reasons (team-lead scoped this follow-up to the four above)

`WIT-AUTH-6`, `-7`, `-10`, `WIT-ART-3`, `-7`, `WIT-FIX-1`, `-2`, `-5`, `WIT-A2UI-3`, `-6`,
`WIT-FORK-3`, `-4`, `WIT-CNT-8`, `-10`, `-11`, `WIT-WH-8`, `-10`.
