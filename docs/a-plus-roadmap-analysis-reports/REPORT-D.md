# REPORT-D — Slice D: program / idempotency / CI ADRs (pass 2, deep)

Verified against: openwop-app `origin/main` = `9b2af4839` (shared checkout, read-only), openwop `main` = `54f29548`,
roadmap `c60ee3645`. Live reads 2026-08-18: `gh workflow list`, branch-protection API, `gh pr list`,
`https://app.openwop.dev/api/.well-known/openwop`, `/api/readiness`, `/build-info.json`. No suite/build was run.

Artifacts: ADR 0548, ADR 0549, ADR 0550 (existing); proposed ADR 0580, 0582, 0583.

---

## ADR 0548 — OpenWOP app A-grade readiness program

### 1. Identity
- Path `docs/adr/0548-openwop-app-a-grade-readiness-program.md`, 174 lines.
- `Status:` (line 3, verbatim, abridged): `Accepted — program in execution; children 0549–0556 all Accepted, and 0549 + 0550 are now implemented on their own phase lists. Exit criteria as of 2026-08-17: P0 met, P1 met, P2 met for durability but not multi-instance (0551 P3 open), P3 MET …, P4 partial (0554 P0–P2b + wire flip and 0556 P0/P1/P3§A§B shipped; 0555 stops at P1), P5 not started. Residue register reconciled 2026-08-17 …; program roll-up in § "Implementation record — program roll-up, reconciled 2026-08-17 (H44)"`
- Last substantive edit: `a847daa50 2026-08-17 12:22 -0400 docs(adr): implementation records 0548–0556 reconciled to the merged tree (H44) (#3314)`.
- Sections: Context / Decision (gap→child table :30-39) / Program invariants (:41-56) / Boundaries audit / Feature matrix / Program phases + exit criteria (:85-94) / Implementation record — program roll-up H44 (:96-155) / Alternatives / Open decisions (:167-173).

### 2. What it decides
- Umbrella contract for eight child ADRs 0549–0556; each child extends an existing owner, no ninth subsystem (:22-23, :30-39).
- Five program invariants (:43-56): safety before breadth; one owner per concept; honest discovery ("test-seam success cannot license a production claim"); no wire-by-ADR (phrased as "wait for the RFC to reach Accepted"); measured graduation ("a child ADR moves to implemented only with a phase-to-commit/test record… umbrella closes only after external deployment evidence").
- Six program phases P0–P5 with exit criteria (:87-94); P5 = independently reproducible qualification evidence.
- Alternatives rejected: one giant ADR; one ADR per audit sentence; declare app non-production (:157-165). No wire impact of its own.

### 3. Artifact quality
- **Roll-up stale within hours of H44** (`a847daa50` is the last edit). Program merges since then that the roll-up table (:102-111) and the exit-criteria re-read (:141-155) do not know: `4dbc7e325` #3315 (0553 H47), `1f422e383` #3317 (0555 **P2**), `2fb186f02` #3318 (0556 **P2**), `eb3e041d4` #3319 (0550 H48), `76a684281` #3322 (0554 **P3**), `9b2af4839` #3325 (0553 **P3**). So the Status line's "0555 stops at P1" (:3, :151) is false since #3317; "0556 P2/P4 open" (:152) false since #3318; "0554 P3/P4 open" (:152) false since #3322. Six of eight children moved after the last roll-up.
- Contradiction inherited from a child: ADR 0554 :3 opens "P0–P2 + the wire advert implemented; **P3/P4 open**" and later in the same line "**P3 Operations recovery SHIPPED 2026-08-17**" — the umbrella cannot be reconciled against a child whose own status line disagrees with itself.
- :9-11 "no dependent wire behavior… until its RFC is **Accepted**" — the rung-name test CLAUDE.md § "A spec change needs an RFC" corrected twice; the residue register and `test/agrade-wire-blocked-residue.test.ts:834-877` enforce the three-part gate instead. No correction note at :9-11.
- Invariant 5 (:54-56) already states "accepted ≠ evidence" — the roadmap bullet is satisfied as TEXT; what is missing is a MECHANISM: `scripts/` has no status/roll-up parity script (`ls scripts | grep -iE 'adr|status|rollup|parity'` → only `check-adr-refs.mjs`, `check-registry-parity.sh`; `check-adr-refs.mjs:81` only checks a reservation says `Status: Proposed`).
- Only tests citing 0548: `agrade-wire-blocked-residue.test.ts` (invariant 4 negative space + register↔test agreement :834-877), `a2a-profile.test.ts:47` (invariant 3), `conformance-quarantine.test.ts`. None reads the roll-up or child Status lines.
- Part V template: Decision ✓; Implementation ✓ but stale; Verification — none of its own; Claim record — none (delegated to 0550 P4).
- Unmeetable-as-phrased: P5 exit depends on an open decision (:172-173) with no owner and no date.

### 4. Implementation reality on current main
- Not a code artifact. Program-level H-items (:119-125) verified present (`35a12948a`, `756a9938d`, `9b342b3be`, `5bd850706`, `3318d7062` all resolve).
- Exit criteria re-read on `9b2af4839`: P0 met; P1 met; P2 durability met / multi-instance open (0551 P3, unchanged); P3 met (+0553 P3 #3325); P4: 0554 P0–P3 shipped (P4 open), 0555 P0–P2 shipped (P3/P4 open), 0556 P0–P3§A§B shipped (P4 open) — "P4 partial" is still the right word but every sub-clause is stale; P5 not started.
- Evidence level of the umbrella: `test-seam` (register/test agreement) only.
- Changed between `fa968b428` and `9b2af4839`: only `#3325` (0553 P3) — one more child staler.

### 5. Roadmap bullet-by-bullet (roadmap :506-510)
| Bullet | Verdict | Evidence |
|---|---|---|
| Accept and update as umbrella | DONE (Accepted; update stale) | :3; §3 |
| Raise target A→A+ using this doc's definition | OPEN | `grep -c 'A+' docs/adr/0548*` = 0 |
| Convert completion table into generated/parity-checked ledger | OPEN | no script (§3); roll-up hand-typed (:98-100) |
| Link all existing and proposed ADRs | OPEN / premature | proposed 0580–0585 don't exist; 0549–0556 linked (:30-39) |
| Prevent "ADR accepted" from counting as evidence | DONE as text, OPEN as mechanism | invariant 5 :54-56 |

### 6. Cross-artifact
- Depends on 0549–0556 + RFCs 0148–0156. Owns no seam; overlaps none.
- RFC 0147 §A.1 wire freeze: not mentioned; invariant 4 covers only the "no wire-by-ADR" half.
- Part III matrix: 0548 appears in no row — correct.

### 7. Defects & gates-that-cannot-fail
- Gate that cannot fail: the H44 roll-up is prose; a child can ship three phases and nothing goes red. The only enforcement (`agrade-wire-blocked-residue.test.ts:834-877`) checks the RESIDUE register, not the roll-up. Fix: a derived roll-up (`scripts/adr-rollup.mjs --check` reading each child's `Status:` + phase table, diffing against 0548's table) — small; owner 0548.

### 8. Verdict
Roadmap treatment accurate but under-states drift: roll-up went stale within ~8 h of H44 and now trails SIX program merges; the Status line makes three false claims about 0554/0555/0556. Needs an amendment (re-reconcile at `9b2af4839`) and the derived roll-up the roadmap asks for — the only fix that stays fixed. **P2** (doc honesty; nothing on the wire depends on it).

---

## ADR 0549 — Tenant-scoped durable run-idempotency ledger

### 1. Identity
- Path `docs/adr/0549-tenant-scoped-durable-run-idempotency-ledger.md`, 631 lines.
- `Status:` (:3, verbatim): `implemented — P0–P2 2026-08-12 (bfec8b9e4), P3 2026-08-16 (e6f22d739, #3273; quarantine residue retired in 3653cd90d, #3283). Merge provenance reconciled 2026-08-17 (H44) — see § "Merged-tree provenance"`
- Last substantive edit: `a847daa50` (H44, #3314). Phase content last changed by `e6f22d739` (#3273).
- Sections: Context / Decision + CORRECTIONS 1–4 (:26-118) / Boundaries / Matrix / Phases + CORRECTIONS 5–7 (:146-194) / RFC gate / Implementation record: H44 provenance (:204-234), P0 (:236-252), P1 (:254-306), P2 (:308-337), three findings (:339-381), P3 (:383-622 incl. CORRECTIONS 8–9, recipe map, migration, vectors, `runId` residual :452-478, verification + sabotage :480-538, suite contradiction :540-604, not-done :606-622) / Alternatives.

### 2. What it decides
- ONE durable ledger `idempotent_response` keyed `(tenant_id, endpoint_id, idempotency_key)` owned by `Storage`; the daemons' fire-once mutex stays on the separate `idempotency` table (`claimOnce`) — lanes split, not re-keyed (CORRECTION 1–2, :30-57).
- Claim state machine (:84-93): atomic insert-pending with lease + random claim token; digest mismatch → `idempotency_key_replay_mismatch`; live pending → typed in-flight; expired pending → atomic reclaim (CAS on old token); winner commits with CAS on token; pre-commit failure releases in `finally`, never overwriting a completed row.
- Lease DERIVED from request timeout (+60 s) (:267-278). No RFC 8785 at P1 (:286-294).
- P3 = RFC 0150 §B/§C: `host/effectIdentity.ts` v2 logical invocation id, `llmCacheKey.ts` semantic digest v2 (JCS, no NFC), §E dual-read; 11/11 corpus vectors from the installed package (:442-450).
- Decided NOT to derive `runId` from the key (:458-474); the crash-between-writes residual "stays open, owned by ADR 0551 P4 … with the CAS-on-claim-token option as the cheaper host-local alternative" (:476-478).
- Wire impact: none new; the honest advert `llmCacheKeyRecipe: spec-rfc-0041` is what P3 made true (CORRECTION 8, :390-399). Alternatives rejected: tenant-prefix in route; in-memory mismatch hash; permanent `__pending__` (:624-630).

### 3. Artifact quality
- **Status `implemented` while carrying an un-owned open defect.** :279-284 (P1) and :452-478 (P3) both record that a crash between `insertRun` and `complete` yields a second run; :476-478 hands it to "ADR 0551 P4 (§D fencing)". ADR 0551's P4 row (`0551…md:191`) is "Multi-region qualification — partition/reconciliation/effect-fence evidence"; the file never mentions the admission window, `claim token`, or 0549 in a P4 context (`grep -n '0549\|CAS-on-claim\|claim token\|insertRun\|admission' 0551…md` → only P1 outbox lines :244-310, :295 an analogy). The hand-off was never accepted → owned by nobody, absent from `docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md` (`grep -n 'crash\|insertRun'` → none), pinned by no test (§4).
- **Phantom witnesses in the H44 table** (:213): P0–P2 "Witness tests: `idempotent-response.test.ts`, `run-idempotency-*.test.ts`". Neither exists on ANY ref (`ls backend/typescript/test | grep -E 'idempotent-response|run-idempotency'` → nothing; `git log --all --diff-filter=A -- …` → nothing). Real witnesses: `idempotency-tenant-isolation.test.ts`, `idempotency-migration-and-logs.test.ts`, `idempotency-lane-tripwire.test.ts`, `storage-adapter-parity-testcontainers.test.ts` (:289-560), `storage-postgres.test.ts` (pg-mem DDL only). Prior audit confirmed.
- :7-8 "RFC 0150 (Draft)" — stale header; RFC 0150 is Accepted (`5e2220bb`, stated at :385). No correction at the header.
- Correction notes: nine, exemplary. Sabotage table (:490-511) is a model. Part V: Decision ✓, Implementation ✓, Verification ✓ (SQLite; PG evidence exists but ungated — §4), Claim record ✓ (advert honesty :427; `crossRegion` non-claim pinned).

### 4. Implementation reality on current main (`9b2af4839`)
| Phase | State | Witness | Evidence level |
|---|---|---|---|
| P0 identity | LANDED `bfec8b9e4` | `idempotency-tenant-isolation.test.ts:110-435`; `idempotency-lane-tripwire.test.ts`; sqlite mig 37 / pg mig 35 (`storage/sqlite/schema.ts:851-885`, `storage/postgres/schema.ts:810-840`) | test-seam (SQLite gated); real-PG **ungated** |
| P1 liveness | LANDED `bfec8b9e4` | `…tenant-isolation.test.ts:437-660` (lease/reclaim/CAS/release/derived lease/route release); PG `storage-adapter-parity-testcontainers.test.ts:529+` | same |
| P2 retention/migration/logs | LANDED | `idempotency-migration-and-logs.test.ts:42-193`; metrics deferred → 0556 P1 (`routes/runs.ts:377` `recordIdempotencyClaim`) | test-seam |
| P3 RFC 0150 §B/§C | LANDED `e6f22d739` | `effect-identity-v2.test.ts` (:48-330 incl. cross-scope :319), `semantic-request-digest-v2.test.ts` (vectors from installed pkg :10,:51), `effect-identity-migration.test.ts`, `llm-cache-key-advert-parity.test.ts` | test-seam (+ deployed advert, not re-read) |
| §D crossRegion | OPEN by design (0551 P4) | negative pin `agrade-wire-blocked-residue.test.ts` | — |
| **Admission crash window** | **OPEN, un-owned** | no test | — |

**The admission ordering, line by line (`backend/typescript/src/routes/runs.ts` @ `9b2af4839`):**
1. `:363` `claimIdempotentResponse` — SQLite: one `db.transaction` (`storage/sqlite/index.ts:758-816`); Postgres: `INSERT … ON CONFLICT DO NOTHING RETURNING`, then on conflict a separate `SELECT` and a separate CAS `UPDATE` reclaim (`storage/postgres/index.ts:1087-1146`).
2. `:385/:401` throw 409 on mismatch / in-flight (leave via `catch` → `finally`; no claim held → no release).
3. `:415` budget check (may throw 429) — **boundary A**: exception here → `finally :529` DELETEs the pending row → retry re-claims → correct (no run yet). Crash here → row stays `pending` for the lease (90 s default: `resolveRequestTimeoutMs()` 30 000 + 60 000, `idempotentResponse.ts:158-164`, `requestTimeout.ts:20`) → then reclaim → correct.
4. `:457` `insertRunWithStartContext(storage, run, {enqueueDispatch:true})` → `host/runInsert.ts:81-90`: `await stampRunStartContext(...)` (no DB write) then `storage.insertRun(run, {dispatchOutbox})` — SQLite `insertRunWithOutboxTxn` (`sqlite/index.ts:988-996`), Postgres `BEGIN … INSERT runs … INSERT dispatch_outbox … COMMIT` (`postgres/index.ts:470-490`). **The run + outbox row are now durable; the outbox worker WILL start it after `DISPATCH_OUTBOX_HINT_GRACE_MS` (10 s, `runInsert.ts:46`).**
5. `:466-476` `seedRunVariables`, `reserveConcurrentSlot`, `auditSink.record` (sync/in-memory).
6. `:495` `completeIdempotentResponse` — a SEPARATE autocommit statement (`sqlite/index.ts:1470-1481`; `postgres/index.ts:1147-1166`), CAS `WHERE claim_token=? AND state!='completed'`. **Its boolean result is ignored by the route** (`:495`, no assignment).
7. `:511` `heldClaimToken = undefined` → `:514` `res.status(201)` → `:517` dispatch hint.
8. `:518-541` `catch → next(err)`; `finally` releases (`DELETE … WHERE claim_token=? AND state!='completed'`) iff a token is still held.

**What happens at each boundary between 4 and 6 (the window):**
- **Process death after `insertRun` COMMIT and before `complete`** (Cloud Run instance kill/OOM/SIGTERM; on Postgres two network round-trips apart): ledger row stays `pending` under the dead token; run row + outbox row exist; the outbox worker starts run #1 within seconds. The client sees a dropped connection, retries with the same key: for ≤ 90 s → `in-flight` 409 (**with the non-canonical code, §7 D3**); after the lease → `reclaim` succeeds (`sqlite/index.ts:796-806` / `postgres/index.ts:1124-1140`) → the handler mints run #2 with a NEW random `runId`, inserts + enqueues it, completes the ledger with #2's response. **Two executing runs for one key; the client only ever learns about #2; #1 is orphaned but live.** Nothing looks up `runs.idempotency_key` — the column exists on both schemas (`sqlite/schema.ts:24`, `postgres/schema.ts:48`) with no index and no reader (`grep -rn idempotency_key src/storage/*/index.ts` → only the ledger table + `rowToRun`).
- **Exception between 4 and 6** (realistically only a DB error inside `complete`; step 5 is sync in-memory): `catch → next(err)` (5xx) and `finally` DELETEs the pending row → **the next retry creates run #2 immediately** (no lease wait). Run #1 is enqueued and executes.
- **`complete` returns `false`** (CAS lost — a reclaimer took the token because this holder outlived its lease): the route still sends 201 with ITS `runId` while the reclaimer completes the ledger with a different `runId`; both execute. Guarded only by "lease > request timeout" (`idempotency-tenant-isolation.test.ts:569-596`); the ignored boolean means no second line of defence and no metric.
- **After 6 succeeds** — a crash before `res.json` is safe: retry replays the committed 201 (`:393-399`).
- **`userAgents.ts` has the identical shape** (`:109` claim → `:185 insertUserAgent` → `:212` complete) — same window, lower stakes (no dispatch).

Postgres-only claim-path race (small, real): between the conflicting `INSERT` (`postgres/index.ts:1094-1102`) and the loser's `SELECT` (`:1105-1110`), the winner's `finally` DELETE (release) can remove the row; `rows[0]!` (`:1113`) is then `undefined` and `r.request_digest` throws a TypeError → 500 for a retry that should have re-claimed. SQLite is immune (single transaction). Fix: treat empty `rows` as "retry the INSERT once".

**Gate placement (confirms + sharpens the prior audit):** the real Postgres ledger SQL (`postgres/index.ts:1087-1175`) is exercised ONLY by `storage-adapter-parity-testcontainers.test.ts`, which (a) self-skips under `OPENWOP_SKIP_TESTCONTAINERS=1` (`:40`), (b) `scripts/ci.sh:261-262` sets exactly that for the vitest run, (c) `ci:full`'s live block (`ci.sh:690-693`) names only `pgvector-live`, `pg-sql-live`, `opensearch-live`, (d) hosted `ci.yml:143-148` sets it too and its three live jobs (`:156-212`) are the same three files. The pg-mem file `storage-postgres.test.ts` does NOT run the adapter: it substitutes a hand-written double (`:337-395` — no lease, no reclaim, `releaseIdempotentResponse: async () => {}` "not exercised under pg-mem", `completeIdempotentResponse` with no CAS). `storage-adapter-parity.test.ts:409-440` covers `claimOnce` (mutex lane), not the ledger. **The production adapter's ledger is witnessed by no lane that runs.** ADR 0549's own finding 2 (:347-354) — "this file had NEVER executed" — is exactly the class; un-skipping it was the P0 fix, but it was given no gate.

Corpus side (`/Users/david/dev/openwop` @ `54f29548`): RFC 0150 §A (`RFCS/0150…md:28`) requires state `pending|completed|retryable-failure|terminal-failure` and says "A crashed or expired pending owner MAY be reclaimed atomically"; the app's states are `pending|completed` + DELETE-as-release (`storage.ts:474-495`). `idempotency.md:62` canonical in-flight body is `{ error: "idempotency_in_flight", details: { retryAfter } }`; the app throws `idempotency_key_conflict` with `{ idempotencyKey }` (`runs.ts:401-405`, `userAgents.ts:139,164`; type at `types.ts:560`) — `grpc-transport.md:126` still maps `idempotency_key_conflict`, so the corpus is inconsistent with itself (confirmed). The named RFC 0150 scenario `idempotency-pending-lease-recovery.test.ts` (`RFCS/0150…md:107`) does not exist in `conformance/src/scenarios/` (ls → `idempotency.test.ts`, `idempotencyRetry.test.ts`, `idempotency-key-determinism.test.ts`, `multi-region-idempotency*.test.ts`); the only 409-code assertion is `highConcurrency.test.ts:99-116`, which tolerates `errorCode === undefined` and, on an in-process SQLite boot where claim→complete has no real I/O between them, plausibly never observes a 409 — not run by me; the certify run's `executed-fail: 0` (ADR 0550 :1085) with this code on the wire is consistent with the leg being unexercised on this host.

Changed between `fa968b428` and `9b2af4839`: nothing in this artifact's code paths.

### 5. Roadmap bullet-by-bullet (roadmap :518-524)
| Bullet | Verdict | Evidence |
|---|---|---|
| Complete RFC 0150 semantic-digest + effect-identity adoption | DONE §B/§C (`e6f22d739`); §A state vocabulary + canonical in-flight code OPEN (small); §D deliberately not (0551 P4) | ADR :410-427; `RFCS/0150…md:28`; `runs.ts:401` |
| Consume cross-language vectors | DONE for §C (11/11 from installed pkg, `semantic-request-digest-v2.test.ts:51`); FALSE-PREMISE for §B (corpus ships ONE vector file; no §B/effect-identity vectors exist — slice B's domain, consistent with the prior audit) | ADR :444-450 |
| Qualify lease expiry + stale-owner | DONE at test-seam SQLite (gated) + real PG (**ungated**) | `…tenant-isolation.test.ts:437-560`; testcontainers `:529+` |
| Business-level effect-identity tests | DONE (one pin: commerce refund) | `effect-identity-v2.test.ts:319-330` |
| Resolve crash window via 0582 | OPEN — defect real (§4); ownership WRONG (0549 records + pre-names the fix; 0551 P4 never took it) | ADR :279-284, :471-478 |
| Publish matching SQLite + PG evidence | OPEN — PG evidence exists in a file no lane runs; not "published" anywhere | `ci.sh:261-262,690-693` |

### 6. Cross-artifact
- Depends on RFC 0150 (Accepted); feeds 0551 P4 (§D), 0556 P1 (metrics), 0554 (effect identity), 0550 (vectors from pinned suite).
- Ownership overlap: the admission crash window sits between 0549 (ledger), 0551 P1 (run+outbox txn) and proposed 0582 — rule 6 says amend the owner; the owner is 0549 (its own text at :471-478 pre-names "an `insertRun` CASed on the claim token"). RFC 0150 §A already permits atomic reclaim → no wire change → no RFC. **RFC 0147 §A.1 wire freeze: irrelevant (host-internal).**
- Part III row "Idempotent admission crash window | RFC 0150 | ADR 0549, ADR 0582" → should read `ADR 0549 (P4)`; "Retry-stable effect identity | RFC 0150 | ADR 0549" → correct.

### 7. Defects & gates-that-cannot-fail
| # | Defect | Where | Why | Fix size / owner |
|---|---|---|---|---|
| D1 | Duplicate run admission across a crash/exception between run+outbox commit and ledger complete (two executing runs; client sees only the second) | `runs.ts:457` vs `:495`; `userAgents.ts:185` vs `:212` | ledger commit is outside the run+outbox txn; reclaim mints a fresh run; nothing looks up `runs.idempotency_key` | medium — extend `InsertRunOptions` with `{ledger:{tenantId,endpoint,key,claimToken,responseStatus,responseBody}}` and put the CAS `UPDATE idempotent_response` INSIDE `insertRunWithOutboxTxn` / the PG `BEGIN…COMMIT` (0 rows → ROLLBACK + throw); build `CreateRunResponse` before insert (needs only `runId` + host). Owner 0549 (P4). Tests: storage-layer fault injection (a `Storage` wrapper that throws AFTER `insertRun` resolves) on SQLite AND real PG, asserting `runs` count = 1 and the retry replays; a route-level throw is NOT sufficient (it exercises the `finally`, not the crash). |
| D2 | `completeIdempotentResponse` boolean ignored → CAS loss silent | `runs.ts:495`, `userAgents.ts:212` | a lost CAS means a reclaimer owns the key; handler still 201s its own run | tiny; folds into D1 (inside the txn, 0 rows = rollback) |
| D3 | Non-canonical in-flight error `idempotency_key_conflict` + `{idempotencyKey}` echo instead of `idempotency_in_flight` + `details.retryAfter` | `runs.ts:401-405`, `userAgents.ts:139,164`, `types.ts:560` vs `idempotency.md:62` | canonical error semantics; also `details.idempotencyKey` puts the raw caller key on an error body the log/audit path may record — §F says logs MUST NOT | small; same PR as D1; corpus editorial for `grpc-transport.md:126` |
| D4 | Real-PG ledger parity in NO gate; pg-mem exercises a double | `ci.sh:261-262,690-693`; `storage-postgres.test.ts:337-395` | production adapter's ledger SQL unwitnessed by any lane | gate placement — add the file to `ci:full`'s live block under a hard-require env like the other three; owner 0549/0551 |
| D5 | PG claim path: `rows[0]!` after a concurrent release → TypeError 500 | `postgres/index.ts:1105-1113` | two autocommit statements where SQLite has one txn | tiny (retry INSERT once when `rows` is empty) |
| D6 | RFC 0150 §A state vocabulary (`retryable-failure`/`terminal-failure`) not modelled | `storage.ts:474-495` DELETE-as-release | shape gap; behaviourally the app re-executes retryable failures (correct per `idempotency.md:55`) but never caches non-retryable 4xx after the claim (only 201 completes) | small; low priority until a corpus scenario exercises it |
| G1 | Gate-that-cannot-fail: nothing can go red on D1 (no test asserts "one run per key across a crash") | — | pin the residue: at minimum a `host-evidence` row in `AGRADE-WIRE-BLOCKED-RESIDUE.md` that `agrade-wire-blocked-residue.test.ts` demands, until D1 lands with its fault-injected test |
| G2 | H44 witness names are phantoms — the provenance table cites files that never existed | ADR :213 | a reader verifying by filename concludes the tests were deleted | doc fix |

### 8. Verdict
The roadmap's residue for 0549 is right on the crash window and wrong on ownership; four of its six bullets describe landed work. The artifact is `implemented` while its own text records an open, un-owned correctness defect (D1) that produces two executing runs on the product's primary endpoint under a realistic Cloud Run event, on the production adapter whose ledger SQL no lane runs (D4). Needs: a **P4 "atomic admission"** phase (D1+D2+D3 in one PR, fault-injected on SQLite + real PG), the real-PG file into a lane that runs, the residual pinned in the register until fixed, phantom witnesses corrected, header "(Draft)" corrected. **P1** — a real duplicate-effect defect with a medium fix and no wire dependency; the roadmap's Phase 1 placement is right, the artifact number is wrong.

---

## ADR 0550 — Conformance, provenance, CI and claims attestation

### 1. Identity
- Path `docs/adr/0550-conformance-provenance-ci-and-claims-attestation.md`, 1343 lines.
- `Status:` (:3, verbatim, abridged): `Accepted — P0–P1 implemented 2026-08-11 (bfec8b9e4), P1 quarantine burned down 2026-08-13 (5b70f0876), P2 implemented 2026-08-13 (022357c71, 738346db7); P3 verifier + signer + Operations projection implemented 2026-08-13 (022357c71) — residue: nothing invokes scripts/sign-attestation.mjs …; P4 implemented 2026-08-17 … merged as 54229aa61 (#3309). P0–P4 all implemented; the ADR is implemented on its own phase list. Residue that is NOT a phase: nothing invokes scripts/sign-attestation.mjs. … Also not a phase: the vendored-fixture parity invariant + guard (H48, 2026-08-17) …`
- Last substantive edit: `eb3e041d4 2026-08-17 15:48 -0400 fix(conformance): the fixture advert missed the bare conformance. prefix … (ADR 0533 correction / H48) (#3319)`.
- Sections: Context (:11-26) / Decision — three lanes (:28-61) / Boundaries / Matrix / Phases (:88-96) / Implementation record: H44 provenance (:100-138), P0 (:140-166), P1 (:168-255, two corrections), measurement (:256-300), P2 design + corrections (:302-530), P2 first run (:531-603), P3 verifier (:604-685), container-lane defects (:687-812), P2 CORRECTION moving corpus (:813-849), P4 block + corrections (:850-929), P4 shipped (:930-1071), P4 measured run (:1072-1124), H48 vendored fixtures (:1125-1334) / Alternatives (:1335+).

### 2. What it decides
- Three non-substitutable lanes (:30-61): **Lane 1** "Block every PR on explicit backend `npm run typecheck`, build, unit/integration tests, schema/pack checks, and a fast non-vacuous core conformance profile"; **Lane 2** boot the release ARTIFACT and run the declared profile matrix, opted-out profiles recorded as not-claimed; **Lane 3** post-deploy black-box subset + a SIGNED attestation binding commit/container digest/revision, corpus+suite versions, profile list + discovery digest, environment class, counts + evidence digest, signer + expiry; public renderer reads only a valid unexpired attestation.
- Phases P0 typecheck + lock parity; P1 fast core conformance in PR CI (shrink-only quarantine); P2 release-artifact matrix; P3 attestation verifier + Operations projection; P4 public exact-profile claims (RFC 0148 §A ledger; any non-`executed-pass` floor row → NOT claimed).
- Rules: "a signer may only sign what it can verify" → no runtime signer (:618-637); `environmentClass` inside the signed payload; `commitSource: 'env'` refused (:639-647); a claim is decided at certify time and served verbatim (:996-1000); deletion of stale `build-meta/*` (:955-960); `--skip-certify` costs the claim, never weakens it (:962-971).
- Wire impact: `capabilities.conformance.certificationBundleUrl` (RFC 0089 §D) + `contractProvenance.suiteVersion` (RFC 0146). P3 rejects runtime/KMS signing with measured reasons.

### 3. Artifact quality
- **Nowhere records that the hosted workflow is disabled** (`grep -n -i 'disabled\|branch protection\|protected\|required status' 0550…md` → :1011/:1074 are about the quarantine). Live: `gh workflow list --all` → `CI disabled_manually`; `gh api …/actions/workflows/290520170` → `state: disabled_manually, updated_at: 2026-07-21T21:36:21-04:00` (#2359 `ac88ed8bf`; CLAUDE.md:225 "deliberately disabled"). ADR dated 2026-08-11 (:5), three weeks after. Lane 1 says "Block every PR" (:34) and P0's table (:145) cites `.github/workflows/ci.yml:109,120` as a shipped hosted gate — a workflow that has not run since 2026-07-22 (last three runs, all `failure`).
- **P0 introduced the broken hosted order.** `git show bfec8b9e4 -- .github/workflows/ci.yml` inserts the `Typecheck` step (`run: npm run typecheck`, `working-directory: backend/typescript`) at :120-124 BEFORE the pre-existing `npm ci` at :129. `typecheck` = `tsc --noEmit` (`backend/typescript/package.json:13`) — no `tsc` on a clean runner. Never noticed because the workflow was already disabled. The guard `test/ci-gate-coverage.test.ts:65-80` asserts the WORKFLOW CONTAINS `run: npm run typecheck` and the job name — existence, not order (the `ci.sh` half at :47-55 DOES assert order). Prior audit confirmed.
- **Local gate is stronger than the hosted one ever was**: `scripts/ci.sh` runs vendored-schema drift (:126), vendored-fixture parity (:134), ADR refs, gate-tooling + deploy-gate self-tests (:216,:225), typecheck (:240), vitest (:262), full conformance (:281), production `npm audit` with expiring exceptions (:668), registry parity (:700); hosted `ci.yml` (212 lines) has NONE of conformance/audit/parity/provenance. But it is opt-in: `core.hooksPath` is unset in this checkout (`git config core.hooksPath` → empty; `hooks:install` at `package.json:15`), and `gh pr list --state merged --limit 5` → #3321–#3325 all `statusCheckRollup: [], reviews: []`; branch protection API → 404 "Branch not protected"; rulesets → `[]`.
- Correction notes: many and good (P1 burn-down, P2 corpus, P4 block lifted, H48 → ADR 0533). Missing: the disabled-CI correction; the P0 order defect.
- Unmeetable-as-phrased: Lane 1's "Block every PR" cannot be met by this ADR (needs billing + admin) — should be a recorded human gate, not a phase item.
- Part V: Decision ✓, Implementation ✓ (rich), Verification ✓ (sabotage tables), Claim record ✓ (P4 :1092-1097 claimed/not-claimed lists) — strongest of the three.

### 4. Implementation reality on current main
| Phase | State | Witness | Evidence level |
|---|---|---|---|
| P0 typecheck in local gate | LANDED `bfec8b9e4` | `ci.sh:240`; `ci-gate-coverage.test.ts:35-63` | test-seam (text) |
| P0 hosted job | LANDED as TEXT, **cannot run** (order) and **does not run** (disabled) | `ci.yml:120-129` | none |
| P1 conformance in gate + quarantine ratchet | LANDED; quarantine `entries: []` since `3653cd90d` | `ci.sh:281`; `conformance-quarantine.test.ts`; `conformance-harness-determinism.test.ts` | local-live (in-process boot) |
| P2 release-artifact lane | LANDED opt-in `OPENWOP_CI_RELEASE_CONFORMANCE=1` (`ci.sh:727-736`, "1 remaining, dispositioned") | `022357c71`,`738346db7`,`f9ad587f1` | local-live (container) when invoked; not in `ci`/`ci:full` |
| P3 verifier + Operations projection | LANDED | `src/host/deploymentAttestation.ts` (binds `commit`, `commitSource`, `containerDigest: string|null` :63-69, `environmentClass` :73, `profiles`+`discoveryDigest` :85-86, evidence digest :95, `expiresAt` :98); `test/deployment-attestation.test.ts`, `attestation-signer-parity.test.ts`, `operations-attestation.test.ts` | test-seam |
| P3 signer | LANDED as a script, **zero callers** (`grep -rn sign-attestation scripts/*.sh scripts/*.mjs DEPLOY.md package.json` → only itself); `deploy.sh` runs `--certify` (:213-235) but never signs | — | none |
| P4 public claims | LANDED `54229aa61`; **deployed-live**: `https://app.openwop.dev/api/.well-known/openwop` → `capabilities.conformance.certificationBundleUrl = …/v1/host/openwop-app/conformance/certification-bundle`, `contractProvenance.suiteVersion = "1.135.2"` (deploy of `fb6cbbcba`; readiness `build.commit = fb6cbbcba…, commitSource: image`) | `conformance-claims.test.ts`, `conformance-claims-routes.test.ts`, `check-wire-claims.mjs` via `verify-deploy.sh:110-128` | deployed-live |
| H42 stamp derivation | LANDED `5bd850706` | `write-build-commit.mjs:80-131` (deletes a stale `corpus-suite.txt`) | local |
| H48 fixture parity | LANDED `eb3e041d4` (#3319, before `fa968b428`; unchanged since) | `check-vendored-fixtures.mjs`, `ci.sh:134` | test-seam |
| Pin | `^1.136.0` (`backend/typescript/package.json:70`), lock `1.136.1`, npm latest `1.136.3`; **this shared checkout's `node_modules` holds `1.106.0`** (would trip `ci.sh:117`); no freshness window anywhere (`grep -rl 'freshness window' docs scripts src test` → 2 unrelated hits) | — | — |

Changed between `fa968b428` and `9b2af4839`: nothing for 0550.

### 5. Roadmap bullet-by-bullet (roadmap :532-544)
| Bullet | Verdict | Evidence |
|---|---|---|
| Correction recording CI disabled + no required checks | OPEN — true fact, absent from the ADR | §3 |
| Re-enable GitHub CI | EXTERNAL (billing) — TRAP: as-is the backend job cannot pass (order) | `ci.yml:120-129` |
| `npm ci` before typecheck on clean runners | OPEN (one-line reorder + extend `ci-gate-coverage.test.ts:65-80` to assert order) | — |
| Require typecheck/build/tests/frontend build/conformance/audits/parity/provenance | DONE locally (`ci.sh`), OPEN hosted (`ci.yml` lacks conformance/audit/parity/provenance) | `ci.sh:126-281,668`; `ci.yml` |
| Remove the assumption that local `ci.sh` protects hosted merges | OPEN — the ADR never made the assumption explicit; CLAUDE.md:213-232 records the 2026-07-21 decision "local CI is THE gate"; honest fix: RECORD that decision in 0550 with residual risk (opt-in hook, 0 reviews) rather than pretend Lane 1 exists | CLAUDE.md:213 |
| Pin/auto-update within a freshness window | OPEN — pin exists (lag 2 patches), window undefined, no Dependabot/renovate (`ls .github/dependabot.yml renovate.json` → none) | — |
| Generate release-candidate profile evidence | DONE (P2 container lane, opt-in) + P4 `--certify` on deploy (in-process boot; the ADR itself says the container is the stronger witness, :1110-1114) | `ci.sh:727-736`; `deploy.sh:213-235` |
| Signed deployment attestations under RFC 0160 | OPEN — verifier + signer exist; nothing signs; RFC 0160 does not exist; predicate format = RFC 0154 UQ3 (slice C) | :604-685; `sign-attestation.mjs` |
| Compare deployed discovery with attested build | DONE at mechanism level (`discoveryDigest` read-time drift `deploymentAttestation.ts:82-86`; `check-wire-claims.mjs` in `verify-deploy.sh:110-128`) — but no attestation is ever produced, so nothing to compare in production | — |
| Enforce exact public profile claims | DONE, deployed-live (10 claimed, `openwop-replay-fork` not claimed, :1092-1097; live pointer verified) | — |

### 6. Cross-artifact
- Depends on RFC 0148/0155/0156 (Accepted); RFC 0146; RFC 0089 §D. Feeds every child (the gate).
- Overlaps: proposed 0580 (delivery control plane) = 0550 Lane 1's own scope; proposed 0583 (freshness/vendoring) = 0550 P0 lock parity + H48 + `check-vendored-schemas`; RFC 0160 evidence signing = 0550 P3's signer.
- RFC 0147 §A.1: `certificationBundleUrl` and `contractProvenance` are already-locked RFC 0089/0146 fields; nothing new.
- Part III rows: "Vacuous or weak certification evidence | RFC 0148, RFC 0160 | ADR 0550, ADR 0580" — 0580 owns nothing here (drop); "Disabled CI and unprotected merges | RFC 0156 claims policy | ADR 0550, ADR 0580" — RFC 0156 says nothing about hosted CI or branch protection (its only CI MUST is the claims-token gate, `RFCS/0156…md:68`; the corpus repo IS protected: `gh api repos/openwop/openwop/branches/main/protection` → required check `Validate spec corpus (server-free)`) — app-only gap, app-only owner; "Pack provenance | … | ADR 0550, ADR 0555" — 0550 has no pack-provenance content (pack sigs are `host/packSignature.ts`) — questionable.

### 7. Defects & gates-that-cannot-fail
| # | Defect | Where | Fix / owner |
|---|---|---|---|
| D7 | Hosted backend job orders `typecheck` before `npm ci` — cannot pass on a clean runner | `ci.yml:120-129` (introduced by `bfec8b9e4`) | one-line move; 0550 |
| G3 | `ci-gate-coverage.test.ts:65-80` asserts step EXISTENCE, not order — green over a workflow that cannot pass; the whole file is text-level, so a disabled workflow reads as a passing gate | add an order assertion mirroring :47-55; add a live check outside vitest (`gh api …/workflows/<id>` state) to a steward/preflight script — vitest cannot see GitHub state | small; 0550 |
| G4 | Lane 3 signer has zero callers; `deploy.sh` certifies but does not sign; Operations projection can only verify a hand-produced file | `deploy.sh:198-235`; `sign-attestation.mjs` | wire the signer into `deploy.sh` after `--certify` (needs a key/predicate decision — RFC 0154 UQ1/UQ3, slice C) |
| D8 | ADR text vs reality: "Block every PR" (:34) and `ci.yml:109,120` cited as shipped (:145) while the workflow is disabled and `main` unprotected — the honesty class the ADR itself names for H42/H43 | :32-37, :145 | correction note; 0550 |
| D9 | Real-PG storage parity file in no lane (0549 D4) — belongs to 0550's gate design as much as 0549 | `ci.sh:690-693` | gate placement |
| D10 | This shared checkout: installed conformance `1.106.0` vs lock `1.136.1` — a stale-deps state `ci.sh:117` would catch; recorded so nobody reads a suite result from this tree as a gate result | `backend/typescript/node_modules/@openwop/openwop-conformance/package.json` | `npm ci` in a worktree, never here |

### 8. Verdict
The roadmap's FACTS about 0550 are all true (confirmed live: disabled since 07-21, unprotected, 0 checks/0 reviews on #3321–#3325, order defect at :120-129). Its WEIGHTING is off: the local gate is materially stronger than the hosted one ever was, and the missing piece is ENFORCEMENT (a human with billing/admin), not conformance/audit/parity mechanics, which exist. The artifact needs (a) a correction note recording the 07-21 disable + current posture and either recording "local `ci.sh` is the deliberate merge gate" as the decision or flipping Lane 1 to a human-gated item, (b) the `ci.yml` reorder + an order guard, (c) a decision on who signs (Lane 3 is a verifier with no producer). **P1 (doc + reorder, hours) / P0 human (enable + protect).** Not a new ADR.

---

## Proposed ADR 0580 — Protected Delivery Control Plane and Bounded CI

### 1. Premise check (roadmap :648-652)
Every clause TRUE on `9b2af4839`: hosted control plane disabled (`disabled_manually`, 2026-07-21); backend workflow orders typecheck before install (`ci.yml:120-129`); recent PRs have no status checks (#3321–#3325); `main` unprotected (404, rulesets `[]`); local fan-out unbounded — `backend/typescript/vitest.config.ts` sets `testTimeout`, `hookTimeout`, `setupFiles` and NO `maxWorkers`/`poolOptions`/`fileParallelism`; `frontend/react` vitest/vite config has none (`grep -n 'maxWorkers\|maxForks\|poolOptions'` → nothing); no `NODE_OPTIONS`/`--max-old-space-size` in `ci.sh`, `package.json`, `ci.yml`; `preflight-suite.sh` DETECTS (`--check` exit 1, `--wait`, `:38-40`) and `ci.sh:84` runs it advisory `|| true`. CLAUDE.md:96-104 records the measurement (one fleet → 57 MB free, four fleets → load 144). "Why a NEW ADR": half true — the delivery-control-plane half is 0550 Lane 1's own stated scope (:32-37); the bounded-local-execution half is owned by no ADR (nothing in `docs/adr/` owns `vitest.config.ts` worker policy — CLAUDE.md § "Working in parallel sessions" is the only text).

### 2. Existing owners
- Protect main / re-enable CI / npm ci first / required check set → ADR 0550 Lane 1 (:32-37), P0 (:140-166), `ci-gate-coverage.test.ts`; CLAUDE.md:213-232 (the recorded 2026-07-21 decision that local CI is THE gate).
- Refuse duplicate suites / inspect live processes → `scripts/preflight-suite.sh` (+ `test-preflight-suite.sh` self-test, `ci.sh:227-228`), CLAUDE.md:96-104 (process notes, not an ADR).
- Worker/heap/timeouts/artifacts → NO owner.

### 3. Genuinely new residue
Bounded local/hosted execution: `poolOptions.forks.maxForks` (or `maxWorkers`) cap keyed to CPU count, per-worker heap ceiling, hosted per-job timeouts already exist (`ci.yml:12,55,114` 10/20/20 min), heap-crash attribution to a test file, artifact upload without secrets (partial: `ci.yml:99-106` playwright traces only). Plus a decision on `preflight-suite` posture in `ci.sh` (`--wait` vs `--check`).

### 4. Wire/freeze/compat
Host-local, no wire. RFC 0147 §A.1 irrelevant.

### 5. Recommendation
**SPLIT: AMEND-0550 for the delivery control plane + a small NEW ADR for execution bounds only** (do NOT re-decide Lane 1 in it).
- 0550 amendment: correction note (disable date, posture), Lane 1 restated as "local `ci.sh` gate + opt-in hook is the CURRENT merge gate; hosted enforcement is a human item with an owner", `ci.yml` reorder, order guard.
- New execution-bounds ADR acceptance tests, each falsifiable: (a) `vitest.config.ts` exports a numeric `maxWorkers`/`maxForks` ≤ `min(os.cpus().length, N)` — a config test reading the resolved config, red when the cap is absent; (b) `NODE_OPTIONS=--max-old-space-size=<X>` present for the vitest step, asserted by `ci-gate-coverage.test.ts` (removing it → red); (c) `test-preflight-suite.sh` already proves the detector fires — extend with "in `ci.sh` the preflight runs in `--wait` mode by default" asserted textually (changing to `|| true` → red); (d) "clean Node 22 from empty deps" acceptance = the reordered job actually completing once CI is enabled (`gh run view` conclusion `success`; cannot be pinned by vitest).
- Trap: enabling `ci.yml` as-is → every PR red on `backend` (D7) and probably `e2e` (untested since 07-22).
- Priority: P1 for the bounds ADR (self-inflicted outages on this box are measured); P0 human for enable + protect.

---

## Proposed ADR 0582 — Atomic Run Admission and Idempotent Creation

### 1. Premise check (roadmap :707-709)
TRUE and VERIFIED line by line (0549 §4): claim `runs.ts:363` → run+outbox one txn `:457` → ledger complete separate `:495` → `finally` DELETE `:529`. Crash after `:457` and before `:495` → run #1 enqueued and executed by the outbox worker; retry after the 90 s lease reclaims and mints run #2. Exception in that window → run #1 executes and the immediate retry mints #2. The `complete` boolean is ignored (`:495`).

### 2. Existing owners
- ADR 0549 P1 :279-284 (records the residual), P3 :452-478 (declines `runId` derivation; pre-names "an `insertRun` CASed on the claim token" and "§D's fencing token"; hands to 0551 P4 with the CAS option "if 0551 P4 stays parked"). 0551 P4 (`0551…md:191`) never accepted it.
- ADR 0551 P1 owns `insertRun(run, {dispatchOutbox})` = the txn to extend (`storage.ts:80-85`; `sqlite/index.ts:988-996`; `postgres/index.ts:470-490`; `runInsert.ts:48-91`).
- RFC 0150 §A (`RFCS/0150…md:28`): composite key, pending lease, "MAY be reclaimed atomically" — silent on HOW the host achieves at-most-once admission; no RFC needed. "Preserve wire-visible random run IDs" — already the case (`buildRunRecord`, `runDispatch.ts:53,79`).
- "Never use a process-local map" — already true since `bfec8b9e4` (0549 P0 deleted the `Map`, ADR :125).

### 3. Genuinely new residue
Nothing decisional. The fix is a host-local storage change under existing owners: extend `InsertRunOptions` with the ledger completion so `insertRunWithOutboxTxn` / the PG `BEGIN…COMMIT` also runs `UPDATE idempotent_response … WHERE claim_token=? AND state!='completed'` and ROLLS BACK when 0 rows. With that, "reclaim returns the already admitted run" (roadmap :717) becomes MOOT: a `pending` row can only belong to a holder that died BEFORE the atomic commit (no run exists) or one whose commit succeeded (row is `completed` → replay). The roadmap lists bullets 1 and 3 as if both were needed; they are alternatives (bullet 1's "or" clause IS bullet 3).

### 4. Wire/freeze/compat
Host-internal; wire-visible ids unchanged; error-code fix (D3) is conformance to already-locked `idempotency.md:62`. RFC 0147 §A.1 irrelevant.

### 5. Recommendation
**DON'T author 0582; AMEND-0549 with a P4 "Atomic admission"** (relieve 0551 P4 of the hand-off explicitly at :476-478 with a correction note). Shape:
- `Storage.insertRun(run, { dispatchOutbox, idempotentResponse?: {tenantId, endpoint, key, claimToken, responseStatus, responseBody} })` — one txn on both adapters; 0 rows on the CAS → rollback + typed error → route maps to `idempotency_in_flight` (the reclaimer owns the key). Route builds `CreateRunResponse` before insert (needs only `runId` + `req.protocol`/host). Keep the `finally` release (no-op on a committed row). Same for `userAgents.ts`.
- Fix D3 (`idempotency_in_flight` + `details.retryAfter`, drop the raw-key echo) in the same PR.
- Acceptance tests (falsifiable): (i) a fault-injecting `Storage` wrapper (SQLite AND real PG via testcontainers) that resolves `insertRun` then throws BEFORE the handler continues → the ledger row is `completed` inside the same txn, so the retry REPLAYS and `SELECT count(*) FROM runs WHERE idempotency_key=?` = 1; (ii) with the fix reverted (complete outside the txn) test (i) goes red — verify by sabotage; (iii) "stale claimant cannot enqueue": expire the lease, let a reclaimer complete, then have the original holder attempt admission → 0 rows, ROLLBACK, `dispatch_outbox` count unchanged; (iv) SQLite/PG parity: run (i)–(iii) through the shared parity harness; (v) put `storage-adapter-parity-testcontainers.test.ts` into `ci:full`'s live block (D4) so (iv) runs somewhere. A route-level `vi.spyOn` throw is NOT acceptable (it exercises the `finally` and passes without proving the crash path).
- Priority **P1**; days, not weeks; roadmap Phase 1 is the correct phase, wrong number.

---

## Proposed ADR 0583 — Continuous Protocol Freshness and Contract Vendoring

### 1. Premise check
The roadmap gives NO "why a new ADR" paragraph for 0583 (:728-745 starts at "Decisions"). Facts: pin `^1.136.0`, lock `1.136.1`, npm `1.136.3` (lag = 2 patches, visible only by hand); vendored schema drift guarded for the LOAD-BEARING subset only (`check-vendored-schemas.mjs:1-30`, direction-classified via `schemaDrift.mjs`, corpus-less fallback reads GitHub raw `main` — a MOVING reference, `:29-31`); vendored fixtures guarded vs the PINNED suite (`check-vendored-fixtures.mjs`, `ci.sh:134`, H48); `contractProvenance` derived from the installed package's `CORPUS-STAMP.json` (`contractProvenance.ts:15,73-79`) — but in production the package is absent (`npm ci --omit=dev`) so the wire carries `suiteVersion` ONLY, no `corpusCommit` (`chooseProvenance`, `:117-129`; live wire: `contractProvenance: {suiteVersion: "1.135.2"}`); `/build-info.json` carries commit only (live: `{commit, stamped, dirty, builtAt}`); SDK↔suite coherence gate is still a "future hardening idea" (`sync-schemas.sh:9-12`); packs↔corpus has `sync-packs.sh` but no `check-vendored-packs`; no Dependabot/renovate config; no delta-classification requirement anywhere.

### 2. Existing owners
- Vendored schemas: `check-vendored-schemas.mjs` (H34 note names the RFC 0157 incident) — home = 0533-era + 0550; vendored fixtures: ADR 0550 H48 (:1125-1334); provenance stamp: ADR 0550 H42 + RFC 0146; conformance pin bumps: 0550's H44 table rows (each bump PR carried witness notes, :111-115); packs: `sync-packs.sh` (owner ADR not verified).
- Roadmap Part III also assigns 0583 "Chain compensation drift" (RFC 0157 mirror parity — actually `check-vendored-schemas.mjs`'s `workflow-definition.schema.json` reference entry, ADR 0554/S36) and "Capability typo/ghost risk" (RFC 0155/0161 lint — nothing in the app named 0583 does this; the typo lint is corpus-side). Both mis-assigned.

### 3. Genuinely new residue
A freshness WINDOW policy (keyed to minors, not "npm latest"); a `corpusCommit` that survives to production (bake it into the image stamp alongside `corpus-suite.txt`); packs↔corpus and SDK↔suite parity gates; a delta-classification checklist for bump PRs; whether to run a bot (and the ordering constraint: bot PRs into an unprotected `main` with 0 checks are a supply-chain vector — sequence AFTER 0550/0580 enforcement).

### 4. Wire/freeze/compat
Host-local (CI policy) except `contractProvenance.corpusCommit`, an already-defined RFC 0146 field. RFC 0147 §A.1 irrelevant.

### 5. Recommendation
**AMEND-0550** (a short "freshness + vendoring policy" section) rather than a new number, unless a policy ADR is wanted as a citation target for three scripts — then a SHORT policy ADR that composes `check-vendored-schemas`, `check-vendored-fixtures`, `contractProvenance`, `write-build-commit` and adds: window ("pin within the current minor; a new minor opens a 14-day window"), `corpusCommit` in the image stamp, packs/SDK gates, bump-PR checklist. Acceptance tests (falsifiable): (a) `check-suite-freshness.mjs` comparing the pin to the registry's latest minor, FAILING past the window (stub the registry answer in a self-test to prove it can go red); (b) `contract-provenance.test.ts` asserting the image-stamp path yields `corpusCommit` too (delete the stamp field → red); (c) `check-vendored-packs.mjs` in `ci.sh` mirroring H48's fixture guard (edit a vendored pack byte → red); (d) existing H48/schema guards keep their sabotage records. Bot PRs only after branch protection exists. Priority **P2**.

---

## Corrections to prior audit (PRIOR-AUDIT.txt, 2026-08-17 ~23:00Z)

1. **Confirmed, sharpened — 0549 real-PG parity "pg-mem gates" (:179):** worse than "the real-PG file is in no gate". The pg-mem file (`storage-postgres.test.ts:337-395`) does not run the Postgres adapter's ledger code at all — it substitutes a hand-written double with no lease/reclaim/CAS and a no-op release; `storage-adapter-parity.test.ts:409-440` covers `claimOnce` (mutex lane) only. The production adapter's ledger SQL (`postgres/index.ts:1087-1175`) executes in NO lane.
2. **Confirmed — 0548 staleness (:83,:359):** now SIX program merges behind H44 (#3315, #3317, #3318, #3319, #3322, #3325), one more than at the prior pass (#3325 landed after `fa968b428`).
3. **Confirmed — 0549 crash window (:85,:105,:159):** verified line by line; ADDITIONALLY the `complete` CAS boolean is ignored (`runs.ts:495`) and there is a PG-only claim-path race (`postgres/index.ts:1105-1113`, `rows[0]!` after a concurrent release) the prior audit did not name. `userAgents.ts` has the same window.
4. **Confirmed — 0549 phantom witnesses (:85,:367):** never existed on any ref.
5. **Confirmed — 0550 facts (:87,:377-381,:177):** disabled 2026-07-21 21:36 -04:00 (`disabled_manually`), unprotected (404 + rulesets `[]`), #3321–#3325 0/0. New: the broken order was INTRODUCED by 0550 P0 itself (`bfec8b9e4`), on a workflow already disabled — which is why it was never observed.
6. **Confirmed — 0582 (:105,:147,:455):** RFC 0150 §A permits atomic reclaim; ownership 0549 P4. Refinement: under atomic admission the roadmap's "reclaim returns the admitted run" bullet is moot (alternative, not additional); prior :455's "tenant-scoped lookup on (tenant_id, idempotency_key) (index needed)" is the weaker design and unnecessary under the one-txn shape.
7. **Confirmed — 0580 (:101,:143,:451) and 0583 (:107,:149,:457).** New for 0583: the production wire carries `suiteVersion` only — `corpusCommit` never reaches the deployed advert (`chooseProvenance`, `contractProvenance.ts:117-129`; live read), so "record the exact upstream protocol commit" is only half-done even in dev.
8. **Prior :167 hedged "likely unobserved because in-process SQLite never yields between claim and complete."** I did not run the scenario either; I add the concrete reason it can pass anyway: `highConcurrency.test.ts:99-116` accepts `errorCode === undefined` and asserts `retryAfter` only when present — an unobserved 409 passes silently. Still a hypothesis; the certify ledger's `executed-fail: 0` (ADR 0550 :1085) is consistent with either.
9. **Nothing in the prior audit's Slice-D claims was found WRONG.**
10. **This checkout's `node_modules` conformance = 1.106.0 vs lock 1.136.1** (prior :381) — re-confirmed; also `core.hooksPath` is unset here (pre-push gate not installed in the shared tree), which the prior audit did not state.
