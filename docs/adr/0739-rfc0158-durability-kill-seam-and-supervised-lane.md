# ADR 0739 — RFC 0158 durability seam: a real kill, a derived bound, and a supervised lane (WHD-5)

Status: implemented — P1–P4 done. The RFC 0158 `durable-single-instance` rung is WITNESSED on the production image (suite 2.34.2, 2026-09-21; see the P4 correction below)

Implements the host side of **RFC 0158** §"Witnessing the recovery rows" (items
11–12) and closes `WHD-5` in `docs/steward/TODO.md`. No wire change: the seam is
a non-normative host-extension route that advertises nothing (RFC 0158 §E.10),
so this is host work and needs no RFC.

## Context

RFC 0158's `Accepted` gate is one host executing, in strict mode, the five
`durable-single-instance` rows. MEASURED 2026-09-20 on suite 2.31.1 @
`3da7df376` (RFC 0148 ledger, `OPENWOP_REQUIRE_BEHAVIOR=true`):

| row | disposition | why |
|---|---|---|
| `0158.poison-exhaustion` | `executed-pass` | seam-free at major 2 |
| `0158.kill-after-accept` | `inapplicable` | `GET /host/durability/kill` → 404 |
| `0158.kill-during-execution` | `inapplicable` | same |
| `0158.duplicate-delivery` | `inapplicable` | same |
| `0158.bound-is-derived` | `inapplicable` | same |

`inapplicable` is not a witness. The only driver is
`@openwop/openwop-conformance/src/scenarios/v2-durability-recovery.test.ts`; this
ADR builds to that file, not to a paraphrase of it.

Most of the MECHANISM already exists and is not touched here:
`host/runDispatchSweeper.ts` (outbox lane every 5 s; orphan lane every 30 s),
the transactional `dispatch_outbox` row written with the run
(`host/runInsert.ts`), a second `run.started` on re-dispatch
(`executor/executor.ts` — `isResume` is false on the sweeper path), a durable
event log, and the per-class derivation in `host/recoveryBound.ts`. What is
missing is only the means to *exercise* it across a real death.

## Decision

### D1 — The seam rides the EXISTING gate, plus one structural fact. No second flag.

RFC 0158 item 12: "a host that already gates a test seam rides that gate;
minting a second flag for one boundary is itself a hazard". So the seam answers
only when `OPENWOP_TEST_SEAM_ENABLED === 'true'` — the gate every other seam
here uses, `false` on the production service by deliberate choice.

That alone is not enough, and the reason is specific to this repo: the default
conformance lane boots the host **inside the harness process**
(`conformance/run.ts` → `createApp`). There, a genuine kill terminates the
harness, the supervisor-that-does-not-exist, and orphans the detached vitest
child. So the second half of the gate is a **structural fact, not a flag**: the
seam answers only when the host is running as its own process — `main()` in
`src/index.ts` calls `markOwnProcess()`; `createApp` alone never does. In the
in-process lane the route keeps answering 404 → the rows stay `inapplicable`,
which is true: that lane cannot witness a process death.

A flag can be set in one context and not another; "was `main()` the entry
point" cannot. A `main()` boot with seams on and NO supervisor (a dev shell) is
the RFC's own named case — the row records `blocked: restart supervisor`.

### D2 — The kill is `SIGKILL` to self, after the response is flushed.

Item 11 requires "a genuine `exit` / signal, not a simulated one". `SIGKILL`
rather than `process.exit()`: exit hooks and graceful-shutdown handlers are
exactly the code a real crash does not run, and a kill that lets them run
witnesses a politer failure than the one claimed. The kill is armed on the
response's `finish` event so the suite always learns the `runId` it must follow.

- **`after-accept`** is a HOLD-DISPATCH row (item 11). The seam performs the
  real acceptance — `insertRunWithStartContext(…, { enqueueDispatch: true })`,
  the same call `POST /runs` makes — and deliberately does NOT call
  `dispatchRunInBackground`. The outbox row is the whole durable intent. Then it
  dies. Recovery class: **unleased**.
- **`during-execution`** dispatches the run for real and kills from an event-log
  subscriber at the run's first **`node.started`**.

  > **CORRECTION (2026-09-20, found by the supervised lane's first real run).**
  > This said "at the run's own `run.started`", and P1 shipped that. `executeRun`
  > appends `run.started` BEFORE it writes `status: 'running'` and BEFORE it takes
  > the dispatch lease, so that kill left a `pending`, UNLEASED run — which the
  > outbox lane rescued in **11.6 s** while the seam labelled the exercise
  > `leased` / 750 s. All five rows were green. The label named a mechanism the
  > exercise never touched, and nothing black-box can see that: the suite only
  > learns the class from the seam. Hence the unit test now pins the state AT
  > death (`running`, ≥ 1 `node.started`, a lease with > 600 s left), and
  > reverting the kill point reddens it. The original wording is quoted in
  > this note because the reasoning error — "after the durable append" was
  > treated as "while executing" — is the reusable part.

  It honours the requested `workflowId` (the suite sends `conformance-noop`,
  whose execution window is microseconds — the subscriber is what makes that
  window hittable without substituting a slower workflow). Recovery class:
  **leased**.
- The response names the class AND its bound, so a driver waiting out the
  recovery never guesses: `{ runId, mode, recoveryClass, recoveryBoundMs }`.

### D3 — `GET /host/durability/bound` projects `recoveryBound.ts`; it states nothing.

`{ class, bound, terms: [{ name, ms }], classes: { unleased, leased } }`, every
number imported from `host/recoveryBound.ts` / the sweeper constants, with
`Σ terms[].ms === bound` per class. `?class=` selects; the bare read returns
`leased` with `class` NAMED in the body, so the top-level figure is never an
anonymous scalar (RFC 0158 UQ1: a single max is "a lie by aggregation").
`recoveryBoundTerms()` is not spread into the response: its three fields do not
sum to either class bound, and a naive projection fails the row it serves.

### D4 — `duplicate-delivery` delivers a REAL run twice; it does not plant ledger rows.

> **SUPERSEDED IN PART (2026-09-20) — read this first.** Building D4 showed the
> suite's assertion could not fail here: `/effects` projects `invocation_log`,
> whose primary key IS the effect identity, so a double-fire writes one key
> twice and the per-identity count stays 1. MEASURED: with the emitter sabotaged
> to insert the notification twice, the scenario-shaped assertion stayed green;
> only an independent count of the REAL effect went red (that oracle is in
> `test/rfc0158-durability-seam.test.ts`). Reported to the corpus session, which
> redesigned the row (openwop#1443): the scenario now supplies an `effectUrl`,
> the staged work must make EXACTLY ONE outbound HTTP request to it through the
> host's real egress path, and the suite counts ARRIVALS.
>
> **That row is expected to go RED on this host, for a real reason.** The ADR
> 0618 concurrent-duplicate claim has ONE production call site
> (`notifications/emitter.ts`); the HTTP egress seams have replay suppression
> and an escape ledger but no per-identity claim, and `executeRun`'s dispatch
> lease is a best-effort write, not a CAS. What protected the notification
> fixture was incidental — delivery 2 was aborted inside `core.delay` by the
> terminal check (and appended `node.failed` at seq 9 AFTER `run.completed` at
> seq 8, a separate log-integrity finding). Generalising the claim to egress is
> a production effect-path change with its own ADR (it is the "effect fencing"
> ADR 0585 already lists as open). **It is NOT to be worked around in the seam**
> — no serialised deliveries, no staged delay in front of the effect. P2 as
> committed (`eb8f083d8`) implements the 2.31.1/3416ca24 contract below and is
> to be reworked to the `effectUrl` contract as P2b.

The seam accepts a run and hands the same accepted work to `executeRun` twice,
which is what an outbox redelivery is. The witness is then whatever
`GET /runs/{id}/effects` says. Planting `invocation_log` rows (the
`effectSeamFireSeam` shape) was rejected: it would witness the projection, not
the claim path, and would keep passing if dedup broke.

**OPEN, corpus-side:** the suite requests `workflowId: conformance-noop`, which
records no effects on this host (the suite's own `0187…per-kind` row says so),
and an empty projection is `blocked`. Until the corpus rules, the seam uses the
requested workflow when it is effect-producing and otherwise
`conformance-replay-side-effect` (a real notification effect), and SAYS SO in
the response (`workflowId` echoed as used). Raised with the corpus session.

### D5 — A supervised lane, because the default lane structurally cannot.

`scripts/conformance-durability.sh` (`npm run test:conformance:durability`):

1. boots the REAL `main()` as a child — so the sweeper runs, which `createApp`
   never starts — on a sqlite FILE in a directory the supervisor owns (the
   in-process lane's `rmSync` exit hook would delete the evidence at the moment
   of the kill), with `OPENWOP_MOUNT_LOCAL_PACKS=false` (a non-vitest boot
   re-points `~/.openwop-packs`; CLAUDE.md § parallel sessions);
2. restarts it whenever it dies, and counts the deaths;
3. runs the suite's existing external-target mode
   (`OPENWOP_CONFORMANCE_TARGET_URL`) against it, restricted to the durability
   file, with the ledger on;
4. **fails unless** the ledger shows the kill rows `executed-pass` AND the
   supervisor observed ≥ 2 real deaths. A green with zero deaths is the vacuous
   pass this whole exercise exists to exclude.

## Alternatives weighed

- **A dedicated `OPENWOP_DURABILITY_SEAM_ENABLED` flag.** Rejected by RFC item 12.
- **Spawn-the-host inside `run.ts` for every lane.** Rejected: it changes the
  boot of the 520 scenarios that do not need it, to serve one file.
- **`process.exit(1)`.** Rejected (D2).
- **Make `kill-after-accept` pass by draining the outbox before `listen`.**
  Rejected *as a response to the scenario*: 2.31.1 reads `run.started` once, the
  instant discovery answers, while this host's outbox row is not due for 10 s
  (`DISPATCH_OUTBOX_HINT_GRACE_MS`) and the first sweep is at +5 s — so a host
  that resumes correctly at ~15 s, inside its 65 s declared bound, fails.
  That is the scenario mandating a fast bound, which the RFC's own
  "Alternatives considered" rejects. Reported to the corpus session as a suite
  defect (poll to the declared bound). A boot-time drain may still be worth
  having on its merits; it is not smuggled in here to satisfy a race.

## Phases

| phase | content | state |
|---|---|---|
| P1 | `routes/durabilitySeam.ts` — probe, `after-accept`, `during-execution`, `bound`; `markOwnProcess()`; unit tests with an injected terminator — `792cf99e2`, kill point corrected in `31d633f5b` | done; 9 independent sabotages, each reddening a distinct test |
| P2 | `duplicate-delivery`, notification fixture + real-effect oracle — `eb8f083d8` | done against the pre-#1443 contract |
| P2b | the `effectUrl` contract (openwop#1443) — `b02f78b83` | **done, and RED as predicted: 2 arrivals, 2× `run.completed`. Pinned as residue; tracked as `WHD-12`.** Lane run 3 (scenario @ `d8c66bd0`, 2026-09-21 00:21–00:34Z): kill-after-accept 11.7 s ✓, kill-during-execution 726.8 s ✓, bound ✓, poison ✓, duplicate-delivery `executed-fail` ("the suite's receiver observed 2 arrival(s)"), 2 SIGKILLs → lane verdict NOT a witness, which is correct |
| P3 | supervised lane (D5) + death-count floor — `31d633f5b` | run 1: 5/5 `executed-pass`, 2 SIGKILLs (but see the D2 correction — `during-execution` was the easy class); **run 2 (corrected kill point, 2026-09-21 ~00:03–00:17Z): 5/5 `executed-pass`, 2 SIGKILLs; `kill-during-execution` row took 726.8 s — recovery by LEASE EXPIRY + the orphan lane, inside the declared 750 s leased bound; `kill-after-accept` 11.7 s (10 s outbox hint grace + a tick).** Both runs used the scenario file from openwop#1443 @ `3416ca24` swapped into `node_modules` (2.32.0 is unpublished); the installed 2.31.1 file would fail `kill-after-accept` on its single read. The duplicate-delivery row in that file is the PRE-redesign one — see D4 |
| P4 | a CERTIFIED bundle carrying the rows | **operator decision — see Open** |

## Open questions / decisions

- [x] **P4 — DECIDED 2026-09-21 (`/architect`, options mode + a survey of nine
      certification programs): a SEPARATE, non-production Cloud Run service at the
      SAME IMAGE DIGEST, seams on.** Every program surveyed certifies a product +
      version + configuration — never "whatever is serving production": Kubernetes
      conformance certifies a distribution per minor version and its
      production-safe `non-disruptive` mode CANNOT certify; WHATWG test-only APIs
      "must not be enabled in the default shipping configuration"; FIPS 140 scopes
      the certificate to the approved mode and lists the rest. `GOVERNANCE.md`'s
      side-revision rule already says the same. To be honest the evidence MUST
      record: (i) image-digest equality with the serving production revision;
      (ii) the full configuration delta — ideally only `OPENWOP_TEST_SEAM_ENABLED`
      and `OPENWOP_ENABLE_CONFORMANCE_NODES`; (iii) `host.relaxations[]` EMPTY,
      which means a PUBLIC https receiver, not `*_ALLOW_PRIVATE`; (iv) proof the
      seam answers 404 on production. It FITS the connection budget: production is
      pool 4 × maxScale 3 = 12 of ~22 usable; a pool-2, maxScale-1, minScale-0
      side service makes 14 and holds zero connections idle. REJECTED: a tagged
      0%-traffic revision of the production service (shares the production
      database and a budget that has already caused two outages) and accepting
      the local lane's bundle (it runs under `OPENWOP_SAFEFETCH_ALLOW_PRIVATE`).
      **NOT PROVISIONED** — it needs its own database + secret and a public
      receiver: an operator action, and pointless until suite 2.33.1 is
      published (the `kill-during-execution` latch race).
      > **CORRECTED 2026-09-21 (executed) — P4 ran as `docker run` of the EXACT
      > production image digest, not as a Cloud Run service.** Cloud Run's
      > IAM `Authorization` header collides with the app's own bearer key, and a
      > SIGKILLed Cloud Run container comes back as a NEW instance with a cold
      > start. The side host is instead
      > `openwop-app-backend@sha256:4db486e615b8…`, the digest serving
      > production rev `00727-wtn` @ `5f532663c` (image id equality recorded),
      > with `--init --restart=always` as the supervisor. `--init` is needed
      > because PID 1 ignores a self-SIGKILL. It runs against its own
      > `postgres:16-alpine`, pool 2. That makes a ZERO delta on the production
      > connection budget. Config delta vs production:
      > `OPENWOP_TEST_SEAM_ENABLED`, `OPENWOP_ENABLE_CONFORMANCE_NODES`, its own
      > DSN/keys/secrets, and no managed-provider key. Receivers are fronted by a
      > cloudflared quick tunnel, so `host.relaxations[]` is **empty**.
      > **Result, suite 2.34.0:** `0158.kill-after-accept` **executed-pass**
      > (unleased class, observed 12.5 s against a 65 s bound). This is the
      > first witness of a seam row on the production build. The other four
      > rows went `executed-fail` on **`UND_ERR_SOCKET: other side closed`**,
      > reproduced twice. The mechanism: `during-execution` dies at the first
      > `node.started` (D2 correction), which can land SECONDS after the seam
      > responds (3–10 s before the first `node.started` is normal on this
      > host, per WHD-23). The suite's `waitBack` then reads a 200 from the
      > still-living process, and `watch()`, unlike `waitBack`, does not catch
      > transport errors. So the death mid-watch throws, and the later files
      > inherit an unreadable discovery. Docker's port proxy accepts and then
      > closes, rather than refusing, which is why this shows here and not on
      > the local lane. Reported to the corpus session. The host-side option is
      > to answer the seam only once the kill point is reached (armed on
      > `finish`, as D1 had it), which removes the window from both ends.
      > **Not certified; P4 stays open** until one of those lands.
      >
      > > **RE-RUN 2026-09-21 ~19:45Z — the rung is WITNESSED.** Suite **2.34.2**
      > > (openwop#1459) now treats a transport failure mid-watch as an unreadable
      > > observation, so no host change was needed. The side host ran production
      > > rev `00729-5h7`'s digest `sha256:fc22c8e5c732…` (commit `090017634`),
      > > with zero relaxations and a signed bundle (witness `39d3dba89680`). All
      > > five rows are **executed-pass**:
      > > * `kill-after-accept`: unleased class, 11 973 ms against 65 000.
      > > * `kill-during-execution`: leased class, 727 490 ms against 750 000.
      > > * `duplicate-delivery`, `bound-is-derived` and `poison-exhaustion`.
      > >
      > > The CLI printed *"RFC 0158 rung — durable-single-instance"*. The added
      > > config delta was per-IP/session rate limits (limiter still on). The
      > > bundle certifies no PROFILE: the side host did not enable the
      > > packs-test namespace or the auth mint seam, and `v2-run-pause-resume` /
      > > `0176.pinned-run-disposition.cancelled` are real reds (WHD-25). So it
      > > was sent to the corpus as the rung witness only and not committed.
- [ ] *(original question, kept)* **P4 — where does the certified witness come from?** ADR 0735 cuts the
      bundle against the DEPLOYED revision, and production runs with seams OFF
      by design, so a production cut records these rows `inapplicable` forever.
      Enabling a self-terminating route on production is excluded (item 12: "a
      denial-of-service surface"). The candidates are (a) a separate, non-public
      seams-on Cloud Run service on the same image, where Cloud Run is the
      restart supervisor — it needs durable storage, and the demo DB's
      ~22-connection budget (`preflight-deploy.sh` Gate 5) cannot simply absorb
      a second service; or (b) accepting the local supervised lane's bundle as
      the witness, which ADR 0735 currently forbids. Operator + corpus call.
- [ ] Corpus: `duplicate-delivery` fixture (D4); `kill-after-accept` single read
      vs the declared bound; `kill-during-execution` passing on a host that
      never resumes.
- [ ] `leased` class is 750 s. If the suite starts polling to the declared
      bound, that row's 120 s test timeout is the next thing to give.
