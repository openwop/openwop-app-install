# ADR 0287 — Engine-table retention: whole-run pruning, operator opt-in

Status: implemented

## Context

Grade-data **RUN-2** (`docs/steward/DATA-ASSESSMENT.md`): the engine SQL tables grow without bound —
`events` (every run's full event log), `invocation_log`, `envelope_correlations`,
`annotations`, `agent_run_activity`, and `webhook_deliveries`. The ADR 0077 retention
seam sweeps KV feature stores per (tenant, classification); nothing sweeps the engine
tables. On a long-lived deployment this is the one real unbounded-growth risk.

Two constraints shape the design:

1. **Events ARE replay/history.** A run's event log is what `:fork` and replay read.
   Thinning events under a run that still exists would be replay-dishonest — the run
   would claim a history it no longer has.
2. **A reference host must never silently destroy run history.** Conformance targets,
   demo deployments, and adopters evaluating the wire all rely on runs being inspectable.

## Decision

**Whole-run pruning, DEFAULT OFF, host-global cutoffs:**

- `Storage.pruneTerminalRuns(cutoffIso, limit)` — both adapters, one transaction:
  select up to `limit` runs in a TERMINAL status (`succeeded|failed|canceled|cancelled|
  completed`) whose `updated_at` precedes the cutoff, delete their children (events,
  interrupts, invocation_log, envelope_correlations, annotations, agent_run_activity —
  all run-keyed), then the run rows. Never a partial run. Racing fleet instances may
  select overlapping batches; the loser's deletes no-op (idempotent).
- `Storage.pruneWebhookDeliveries(cutoffMs)` — delivered/`dead` rows past the cutoff;
  pending/retrying rows are never touched.
- **Wiring:** the existing `retentionSweepDaemon` hourly tick calls `pruneEngineTables`,
  gated on `OPENWOP_RUN_RETENTION_DAYS` and `OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS`
  (unset/0/invalid ⇒ DISABLED — fail-closed for a destructive sweep). Batched
  (500 runs/tick) so a backlog drains across ticks without stalling one.
- **Auditability:** each purge emits the standard `governance.retention.purged` audit
  row (the daemon's audit-row-is-the-tombstone doctrine), with counts + cutoff.
- **Host-global, not per-tenant:** engine rows are host-operational; per-tenant policy
  would drag ADR 0077's (tenant × classification) plumbing into the engine with no
  driver. A tenant-scoped need later can compose `runs.tenant_id` into the SELECT.

## Alternatives weighed

1. **Event-thinning under kept runs** (cap events per run / drop old event bodies) —
   rejected: replay-dishonest (constraint 1).
2. **A generous default (e.g. 180d) instead of off** — rejected: constraint 2; an
   operator who wants retention states it in one env var, and the white-label docs can
   recommend a value.
3. **A separate engine-retention daemon** — rejected: the sweep daemon already owns
   retention cadence, mutual exclusion, and the audit doctrine.

## Phase → artifact

| Phase | Artifact |
|---|---|
| Storage methods (both adapters) + interface | `storage/storage.ts`, `storage/{postgres,sqlite}/index.ts` |
| Daemon wiring + env gates + audit | `host/retentionSweepDaemon.ts` (`pruneEngineTables`) |
| Tests | `test/engine-retention.test.ts` |

## Correction (2026-07-15) — run-artifact rows were missing from the cascade

The original whole-run cascade deleted the engine child tables and the three
exact-key kv write-throughs (`runvars:`/`runchans:`/`runagent:`) but NOT the
`runartifact` DurableCollection rows (`hostext:runartifact:<runId>:<nodeId>`).
Enabling the sweep would have stranded every artifact row forever — a prod
audit on 2026-07-15 found 48k artifact rows (half the KV table) that would have
become permanent orphans. Both adapters now delete the run's artifact rows in
the same transaction via a per-run prefix `LIKE` (metacharacter-escaped;
served by `host_ext_kv_k_pattern`). The `runartifact` collection has no tenant
index (2-arg constructor), so no `hostextidx:` markers exist to orphan.
Parity-tested on both adapters; the run-row `DELETE … ANY` arm is asserted on
real Postgres in `retention-sweep-pg-concurrency.test.ts` (pg-mem does not
implement `DELETE … WHERE = ANY`).
