# ADR 0284 — Complete tenant teardown: host-ext purge + introspected SQL coverage

Status: implemented

## Context

`docs/steward/DATA-ASSESSMENT.md` RI-1 (= `docs/research/data-gaps.md` DG-INT-1) recorded "no tenant
teardown exists — offboarding orphans every `host_ext_kv` row across ~60 features."
Implementation investigation **corrected the diagnosis** (the audit's third correction of
this program): a teardown flow DOES exist — `DELETE /v1/host/openwop-app/account`
(`routes/account.ts`, P3.6.5) with a sole-owner guard, `storage.deleteAllTenantData`,
secret-cache invalidation, membership cascade, and an audit row. Its two real holes:

1. **It never touched `host_ext_kv`** — the ~180 `DurableCollection` namespaces holding all
   business data (CRM, commerce, boards, agents, conversations meta, …). Account deletion
   wiped the engine and left the entire business layer orphaned.
2. **`deleteAllTenantData` hand-listed 7 SQL tables**, silently orphaning every other
   tenant-keyed table (chat_sessions/messages, user_agents, webhooks + deliveries, the 11
   messaging tables, the 3 usage meters, annotations, agent_run_activity).

## Decision

Close both holes inside the existing flow — no new route, no parallel teardown system:

1. **`purgeTenantHostExt(tenantId)`** (`host/hostExtPersistence.ts`): every
   `DurableCollection` self-registers at construction (`HOSTEXT_COLLECTIONS`), and the purge
   walks (a) all live collections and (b) a **ghost sweep** of `hostext:` rows in namespaces
   no live collection owns (retired features), matched on their JSON `tenantId` — the same
   field `reassignTenant`'s host-ext scan keys on. Per-collection deletion goes through
   `DurableCollection.delete()` so tenant-index markers stay coherent.
   - **Deliberately `list()` + exact filter, NOT `listForTenantIndexed`:** the tenant index
     tolerates missing markers ("delayed, not lost" — fine for retention); a teardown miss
     is a permanent orphan. Teardown is rare; completeness wins.
   - Fail-closed on a falsy tenant; idempotent (a re-run finds nothing).
2. **`deleteAllTenantData` rebuilt on schema introspection** (both adapters), the delete
   twin of `reassignTenant`: every table with a `tenant_id` column — complete by
   construction, no manifest to forget — plus explicit child cascades for the
   run-/session-/subscription-keyed tables that carry no tenant column (events, interrupts,
   idempotency, invocation_log, envelope_correlations, chat_messages, webhook_deliveries).
   Return shape gains `otherRows` + `tablesCovered` (additive).
3. **`routes/account.ts`** calls the host-ext purge beside the SQL wipe and stamps all
   counts onto the audit row.

### Correction note (architect ruling, 2026-07-06)

The pre-implementation architect review ruled for a *registry walk* and assumed
"collections already self-register" — they did not (the registry is created by this ADR),
and the review did not know the account-deletion flow existed. Two deviations, recorded
per the correct-don't-rewrite rule:

- **No new superadmin route / two-phase tombstone in this phase.** The existing
  self-service account-deletion flow is the offboarding path; it already sequences
  guard → wipe → cascade → audit. The purge is idempotent and re-runnable, which covers
  the resumability motivation for two-phase. A superadmin "purge arbitrary tenant" surface
  can ride `purgeTenantHostExt` + `deleteAllTenantData` later if operations need it.
- **Hybrid, not registry-only:** the live-collection walk alone would miss rows from
  retired feature namespaces; the storage-level ghost sweep (the `reassignTenant`
  precedent) catches those.

## Accepted residue (stated, not hidden)

- `hostextidx:`/`hostextidxmeta:` markers of **ghost** namespaces (live collections clean
  their own): index markers only, no payload/PII.
- Non-`hostext:` host markers (e.g. the `demo:seed-claimed:<tenant>` CAS row): marker-only.
- `run_budget` (windowed rate counters, opaque bucket keys): entries expire with their window.
- In-memory best-effort caches (subject-memory vector index): process-local, rebuilt from
  the (now empty) durable SoT.
- **`idempotency` rows** (both backends): the L1 HTTP response cache is key-only BY
  DESIGN — no run/tenant linkage exists to cascade on; rows age out via
  `pruneIdempotencyByPrefix` retention. *Correction note (2026-07-06):* the original
  revision claimed pg's table carried `run_id` and called the sqlite mirror "schema
  drift" (DG-INT-9) — that was a grep-window misread (the `run_id` line belonged to the
  adjacent `invocation_log` CREATE). Worse, the pg adapter briefly shipped an
  `idempotency … WHERE run_id` cascade that would have errored for any tenant with runs
  (unreachable in the memory-backed suite; caught same-day before any pg deployment ran
  the path). Both adapters now skip `idempotency` with this rationale; DG-INT-9/INFRA-5
  are closed as audit artifacts.

## Alternatives weighed

1. **Raw SQL `DELETE FROM host_ext_kv WHERE v::jsonb->>'tenantId' = $1`** — rejected as the
   primary mechanism: bypasses `DurableCollection.delete()`'s tenant-index cleanup and is
   Postgres-specific (the sqlite mirror would need `json_extract` drift); kept conceptually
   for the ghost sweep, but implemented through the backend-agnostic `kvList`/`kvDelete`.
2. **Hand-extending the 7-table list** — rejected: the exact failure mode being fixed;
   introspection is the in-repo completeness doctrine (`tenantMigration.ts` rationale).
3. **Two-phase tombstone-then-sweep** — deferred (see correction note): adds a per-request
   tombstone check to the hot path for a flow whose idempotent re-run already converges.

## Phase → artifact

| Phase | Artifact |
|---|---|
| Host-ext purge + registry + ghost sweep | `host/hostExtPersistence.ts` |
| Introspected SQL teardown (both adapters) + widened return | `storage/{postgres,sqlite}/index.ts`, `storage/storage.ts` |
| Flow wiring + audit counts | `routes/account.ts` |
| Tests | `test/tenant-teardown.test.ts` + `test/account-delete.test.ts` (extended) |
