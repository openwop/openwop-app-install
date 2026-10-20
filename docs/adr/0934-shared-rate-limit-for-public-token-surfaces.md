# ADR 0934 — Shared rate limits for public token surfaces

Status: Accepted — P0 implemented, P1 age-out registered (this PR); portal adoption lands with ADR 0924 P1

Port item **B3** of `MYNDHYVE-PORT-SWEEP.md` §1 (owner-approved 2026-10-18).
Gates ADR 0924 P1 (the public client approval link). A correction, not a port:
MyndHyve kept its counters in Firestore (shared across instances, fail-open);
openwop-app keeps them in process memory.

## Context

`middleware/rateLimit.ts` (ADR 0640) limits per IP in memory per process, using
sliding windows of timestamps in `Map`s (`:186-194`), 600 reads / 60 writes per
minute; its header (`:1-18`) already notes it is evadable across instances
(SEC-3). With `maxScale` instances the effective limit is N×, and every deploy
resets it. That is acceptable for general traffic, but not for a public
capability link that decides a client's approval (ADR 0924 D5): a token-guessing
or comment-spam attempt gets N× the budget.

## Audit (state on `origin/main`)

- No route can opt into a custom limit; features build their own: an in-memory
  `Map` (`features/developer-keys/cliLoginRoutes.ts:23, 65`), fixed windows
  (`features/consent/routes.ts:29, 125`; `features/analytics/routes.ts:41-55`),
  count caps (`features/forms/formsService.ts:777-790`;
  `features/crm/bookingService.ts:234-237`).
- **Shared primitives:** `Storage.kvCompareAndSwap` (`storage/storage.ts:1571`;
  Postgres `INSERT … ON CONFLICT DO NOTHING` / guarded `UPDATE`,
  `storage/postgres/index.ts:3412`; SQLite in a transaction,
  `storage/sqlite/index.ts:3266`). `host/planRunLimit.ts:47-95` is a durable
  fixed-window counter with a CAS loop. `createKvCore.atomicIncrement`
  (`host/durable/durableStore.ts:249-260`) is a CAS increment, but it **drops the
  TTL envelope on every increment** (it calls `encodeEnvelope(next)` with no TTL),
  so it cannot back an expiring window as it is.
- No `rate_limit` table exists.

## Decision

### D1 — `host/sharedRateLimit.ts`: a fixed-window counter on the KV CAS

```ts
takeShared({ scope, key, limit, windowS, cost = 1 }):
  Promise<{ allowed: boolean; remaining: number; resetAt: number; degraded?: true }>
```

- Row key `hostext:ratelimit:<scope>:<sha256(key)>:<windowIndex>`; value
  `{n, windowEnd, updatedAt}`. The window index is in the key, so a new window is
  a new row and old rows are never read again. Hashing the key keeps IPs and
  tokens out of storage.
- `kvGet` → if `n + cost > limit`, refuse without writing; else
  `kvCompareAndSwap(raw → n + cost)`, retried up to 8 times (the `planRunLimit`
  shape). A refused request spends nothing.
- Old window rows are deleted by the existing KV age-out lane:
  `registerKvAgeOut({ id: 'ratelimit:shared', prefix: 'hostext:ratelimit:',
  ttlDays: 1, timestampField: 'updatedAt' })` (`host/kvAgeOut.ts:92-170`, the
  `paywallFunnel.ts:99` precedent). Its granularity is days, which is fine: rows
  are tiny and correctness never depends on deletion. No new sweeper.
- **Postgres and SQLite** both work through `kvCompareAndSwap`; `memory://` (tests)
  works too. One extra read and one CAS write per limited request, which is why
  this is **only for public token surfaces**, not the global middleware.

### D2 — Failure posture

- **Decision/mutation endpoints** (the approval POST): **fail closed**. If the
  counter cannot be read or swapped, answer 503 with `Retry-After: 5`. A public
  write that decides a client's approval does not run unmetered.
- **Read endpoints** (the approval page GET): **fail open to the in-process
  limiter**, marked `degraded: true` and logged once per minute.
- MyndHyve failed open everywhere; this keeps that only for reads.

### D3 — Where it applies

- **ADR 0924 public portal (required before P1 ships):** per token 20 requests /
  10 min and 5 decisions / hour; per IP 60 / min across all tokens; per client
  org 300 / hour. A refusal is the portal's uniform 404 body with 429 status and
  `Retry-After` (status differs, body does not, so it does not reveal whether a
  token exists).
- **Candidates later** (not changed here): public forms submit, e-sign, booking,
  the CLI login map. Each can switch to `takeShared` in its own PR.
- The global ADR 0640 middleware stays in memory.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Package | `host/sharedRateLimit.ts` (host seam; features call it). |
| 2 | Toggle | None (infrastructure). |
| 3–6 | Workflow surface, nodes, envelopes, agents | None. |
| 7 | Public surface | It is the public surface's abuse control (D3). |
| 8 | RBAC | n/a. |
| 9 | Replay / fork | n/a (request-time only). |
| 10 | Frontend | None. |

## RFC verdict

**Host extension, no RFC.**

## Phased plan

| Phase | Scope |
|---|---|
| P0 | `takeShared` with tests on SQLite and pg-mem: concurrent takers across two storage clients never exceed the limit; a refusal spends nothing; an expired window resets; fail-closed and fail-open postures |
| P1 | Age-out registration for the prefix; adoption by the ADR 0924 portal (lands with 0924 P1) |
| Later | Forms, e-sign, booking, CLI login adopt it |

## Alternatives weighed

- **Make the global middleware shared.** Rejected: a DB round trip on every
  request for a limit whose job is cheap shedding.
- **Redis or Memorystore.** Rejected: new infrastructure and spend for a low
  volume of public decisions; Postgres is already there.
- **Fix `atomicIncrement` to keep the TTL and use it.** Possible, but it belongs
  to the workflow KV surface with its own consumers; changing its envelope
  semantics needs its own review. Recorded as a follow-up.

## Open questions

- [ ] **Q1** The per-token and per-org numbers in D3 are first guesses. Revisit
      after the first real client approvals.
- [ ] **Q2** `atomicIncrement` dropping the TTL: a bug or intended? Owner of the
      durable KV surface to decide.
- [ ] No `/architect` pass has been run on this ADR.

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | `host/sharedRateLimit.ts` `takeShared` (this PR) | `backend/typescript/test/adr0934-shared-rate-limit.test.ts` |
| P1 (age-out half) | `registerKvAgeOut({ id: 'ratelimit:shared', … ttlDays: 1 })` in the module (this PR) | same file, "old windows age out" |
| P1 (adoption half) | lands with ADR 0924 P1 (the public portal) | — |

> **Correction notes from P0 (2026-10-19).**
> - **D1 "retried up to 8 times" → 64.** A loser re-reads the value the CAS returns
>   (no extra round trip), so a burst of N racers on one key needs up to N attempts
>   for the last one to land. MEASURED: 40 racers across two SQLite clients with 8
>   attempts admitted 8 of 10 under a `closed` limit (sustained contention refuses
>   by design, D2). With 64 attempts the race admits exactly 10.
> - **D1 is on the raw host KV, not a `DurableCollection`.** `takeShared` takes an
>   optional `storage` so the cross-client race can be tested with two real clients
>   on one database. The row key and shape are exactly D1's.
> - **P0 "pg-mem" witness: partial.** pg-mem reports `INSERT … ON CONFLICT DO
>   NOTHING RETURNING` as a returned row even when it inserted nothing (MEASURED
>   with a direct probe: a second absent-key CAS "swapped" and the value did not
>   change), and it cannot migrate a second client. So the absent-key race cannot
>   be witnessed on pg-mem; it runs on two SQLite clients, and the sequential cases
>   run on both. The adapter SQL (`storage/postgres/index.ts` `kvCompareAndSwap`)
>   is correct on real Postgres, where that statement returns no row on conflict.
>   A live-Postgres race case belongs in the `OPENWOP_PG_TEST_DSN` lane (the ADR
>   0868 precedent) and is a follow-up.
> - The age-out registration runs when the module is imported. Nothing imports it
>   until ADR 0924 P1, which is also the first time a row can exist.
