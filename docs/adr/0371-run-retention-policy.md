# ADR 0371 — Run retention: removal-time rows, pinned exemptions, export-before-delete

Status: implemented (Phases 1–5, 2026-07-15)

| Phase | PR | Landed |
|---|---|---|
| 1 removal_at seam + migrations + graced backfill | #1859 | `withRemovalStamp` at the one storage seam; pg mig 33 / sqlite mig 35 |
| 2 sweeper + exemptions | #1860 | pin/hold/non-terminal + override re-stamp; rides ADR 0077's ONE retention loop |
| 3 export-before-delete + admin holds | #1862 | opt-in NDJSON export; admin counters + legal-hold endpoints |
| 4 the ADR 0369 GC | #1863 | archived transient defs with zero remaining runs hard-delete (closes 0369 P6) |
| 5 FE pin + retention note | (this PR) | run-detail Pin/Unpin + "removed on <date>" / "Pinned" note; i18n ×4 |
Date: 2026-07-15
Lane: cross-cutting data seam + schema migration (runs table) — no new feature package
RFC verdict: **host work only.** Retention is host storage policy; the wire's
90-day-style expectations are a host property, not a protocol surface. The one
wire-adjacent obligation is honesty: a purged run's endpoints return the same
`run_not_found` they do for a never-existed run (already true — `deleteRun`
precedent). No `../openwop` RFC.

## Why this exists

The app retains every run forever. Every comparable platform ships a policy
(Temporal 72 h/30 d + archival; n8n 14 d/10 k with pinned exemptions; Step
Functions a 90-day hard limit; Camunda per-definition TTL + batch-window
cleanup; even Power Automate prunes at 28 d) — "keep forever" is the outlier
posture, it is a known DATA-ASSESSMENT unbounded-growth gap, and it blocks
ADR 0369's GC (an archived transient definition may hard-delete only when no
run references it — which is never true while runs are immortal). Full
survey: [`docs/research/run-retention-and-tour-authoring.md`](../research/run-retention-and-tour-authoring.md).

## Decision (the Camunda-shaped core, five pieces)

### 1. Removal time computed at WRITE, not evaluated at sweep

New nullable column `runs.removal_at` (pg + sqlite migrations, indexed).
Stamped when a run reaches a terminal status: `removal_at = completedAt +
TTL`. The sweeper's query is an index range scan (`removal_at < now LIMIT
batch`), never a policy engine pass over the table. Existing rows: a
one-time backfill migration stamps terminal runs from their `completedAt`
(repair-before-constrain; rows older than the default TTL get a grace floor
of `now + 7d` so the first sweep is never a mass extinction).

### 2. TTL resolution — one resolver, three layers

`ttlFor(run, definition)`: run-level pin → definition-level override
(`definition.metadata.retention.ttlDays` — the same metadata extension point
ADR 0369's lifecycle uses; a billing chain can carry 7 years, a tour 7 days)
→ tenant/host default (`OPENWOP_RUN_RETENTION_DAYS`, default **30**; `0` =
retention disabled, the today-posture escape hatch). A per-tenant **count
<!-- OPENWOP_RUN_RETENTION_MAX_PER_TENANT: documented pre-implementation, never built; removed from the operative table 2026-07-21 (cleanup) — shipped knobs are *_DAYS/BATCH/WINDOW/EXPORT. -->
oldest-terminal-first when age alone isn't enough — n8n's age-OR-count
shape.

### 3. Exemptions that beat TTL

- **Pinned** (`run.metadata.pinned = true`) — a USER act (the same spirit as
  the ADR 0369 promote gate): never swept; surfaced in run detail.
- **Legal hold** — tenant-level flag; held tenants' runs are skipped AND
  counted/logged (a hold that silently disables retention is an audit
  finding of its own).
- **Non-terminal runs** — never swept regardless of age (waiting-* runs are
  live HITL state; a stuck run is the dispatch sweeper's problem, not
  retention's).

### 4. Export-before-hard-delete (the Temporal Archival hook)

Optional (`OPENWOP_RUN_RETENTION_EXPORT=true`): before deletion the sweeper
writes one NDJSON blob per run (run row + events + interrupts) to the
existing media/blob store under a retention namespace. Compliance escape
without hot rows; OFF by default (the export store then owns its own
lifecycle — recorded, not solved here).

### 5. Quiet-window batched sweeper

The Camunda shape on existing precedent (collab heartbeat / orphan sweeps):
batch size (default 200) via `deleteRun` (the existing explicit cascade:
run + events + interrupts + invocation-log), optional window
(`OPENWOP_RUN_RETENTION_WINDOW=01:00-05:00` UTC), multi-instance-safe via
the existing claim/lease idiom, per-sweep observability (swept/skipped-
pinned/skipped-hold counts).

### Erasure interplay (recorded, mostly already true)

GDPR erasure ≠ run deletion: the account-erasure path pseudonymises
principals in retained runs (`subjectRekeyMigration` precedent). Retention
and erasure stay orthogonal: erasure rewrites identity, retention bounds
lifetime.

### The ADR 0369 GC consumer (the original trigger)

With removal in force, 0369 Phase 6 lands as a small follow-up in THIS
program: after each sweep, archived `lifecycle.transient` definitions where
`hasRunForWorkflow(id)` is false are hard-deleted (the P2 probe; the
Step-Functions-shaped refusal keeps protecting referenced ones).

## Correction note — composition with ADR 0077 (2026-07-15, P2 audit)

A retention sweep daemon ALREADY exists: ADR 0077's governance retention
(`retentionSweepDaemon.ts` — per-(tenant, DataClassification) purger fan-out,
hourly, leased, audit-tombstoned). Its purger seam is deliberately coarser
than this ADR's per-run `removal_at` model, so runs do NOT register as a
purger — but there is ONE loop: the run sweep runs as a second,
separately-gated task inside the same daemon tick (`OPENWOP_RUN_RETENTION_DAYS
> 0` vs `OPENWOP_RETENTION_SWEEP_ENABLED`), and the boot site starts the
daemon when either gate is on. The §5 sweeper drops its own scheduling; the
quiet-window check remains inside the run sweep. Leases: the governance half
keeps its per-slot claims; the run half is deliberately lease-free
(idempotent deletes).

## Boundaries audit

- `storage.deleteRun` (`storage.ts:72`) is the ONE deletion path — the
  sweeper composes it; no second cascade.
- `hasRunForWorkflow` (ADR 0369 P2) serves the GC consumer unchanged.
- `definition.metadata` is the established override channel (0369 lifecycle).
- Migrations: pg 33 + sqlite 35 (`removal_at` + index + backfill) —
  contiguous, `check-migration-integrity` gated; release ≥ minor.
- No route/namespace collisions (`retention` unclaimed); admin visibility
  rides the existing superadmin surface pattern (a `_debug`-style counters
  endpoint), not a new console.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| 1 | Migrations (`removal_at` + index + graced backfill) + `ttlFor` resolver + terminal-transition stamping | migration-integrity + vitest |
| 2 | Sweeper (batch, window, lease, counters) + pinned/hold/non-terminal exemptions — tests: exemptions survive, batch bounds hold, purged run 404s uniformly | vitest |
| 3 | Export-before-delete hook (opt-in) + superadmin counters endpoint | vitest |
| 4 | ADR 0369 GC consumer (archived transient defs with zero remaining runs) | vitest; closes 0369 P6 |
| 5 | FE: pinned toggle on run detail + a retention note in run history | FE build + /ux-review |

## Alternatives weighed

1. **Policy-evaluated sweep** (query per rule at sweep time) — rejected:
   table-scan economics; Camunda's removal-time precomputation is the
   industry-hardened answer.
2. **Hard ceiling only** (Step Functions' 90 d, no knobs) — rejected: B2B
   tenants need per-definition overrides (billing vs tours); kept as the
   simplicity benchmark.
3. **Soft-delete runs** (tombstones) — rejected: doubles every read path's
   filter surface; export-then-delete serves the recovery need without
   haunted rows.

## Correction note — the default was backwards (2026-07-15, pre-enable audit)

Phase 1 shipped `defaultRetentionDays()` returning **30 when the env var is
unset** — i.e. retention was ON-by-default the moment the code deployed,
directly contradicting this ADR's "absent ⇒ keep-forever (OFF)" contract and
every ROADMAP/FEATURES statement. A destructive data-deletion feature
activating by omission is exactly the default a reference host must never
ship. Fixed: **unset ⇒ 0 ⇒ OFF**, and **junk ⇒ 0** too (fail-safe: a typo in
the env value keeps data rather than starting to delete it). Turning retention
ON is now an explicit positive `OPENWOP_RUN_RETENTION_DAYS`, surfaced by the
admin run-retention endpoint for confirmation. Found while enabling it in the
demo deployment.

## Open questions

1. Should failed runs get a longer default TTL than completed (debug value)?
   Proposed: no — uniform TTL (n8n posture); a failed run worth keeping is
   what `pinned` is for.
2. Count-cap eviction order when everything is pinned: refuse-and-log vs
   evict-oldest-unpinned. Proposed: refuse-and-log (pins are promises).
3. Whether the export blob store needs its own retention row in
   DATA-ASSESSMENT at Phase 3 (yes, presumably — record it then).
