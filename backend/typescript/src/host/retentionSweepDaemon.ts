/**
 * Retention sweep daemon (ADR 0077 Phase 3). Periodically deletes data past its
 * retention window, per (tenant, DataClassification), by fanning out to the
 * `registerRetentionPurger` seam. Time-based + subject-agnostic — distinct from the
 * subject-keyed GDPR erasure (`subjectErasure.ts`).
 *
 * DESTRUCTIVE → default OFF: the START is gated behind `OPENWOP_RETENTION_SWEEP_ENABLED`
 * at the boot call site (index.ts). Mirrors the `scheduleDaemon`/`refreshDaemon` pattern:
 * pure `processRetentionSweep(deps, now)` for deterministic tests; a re-entrancy-guarded
 * `setInterval(...).unref()` loop; a per-(tenant,classification,day) idempotency lease so
 * multiple fleet instances don't double-sweep; the audit row IS the tombstone (no separate
 * tombstone store exists — every purge emits `governance.retention.purged`).
 *
 * @see src/host/scheduleDaemon.ts — the daemon pattern this follows.
 */

import type { Storage } from '../storage/storage.js';
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import { __runRetentionSweepOnce, __runTransientDefGcOnce } from './runRetentionSweeper.js';
import { sweepExpiredWorkflowProposals } from './workflowComposeTool.js';
import { defaultRetentionDays } from '../storage/runRetentionStamp.js';
import { createLogger } from '../observability/logger.js';
import { getInstanceId } from './instanceId.js';
import { getGovernancePolicy, listGovernedTenants, type GovernancePolicy } from './governanceService.js';
import { purgeRetained } from './retentionPurger.js';
import type { DataClassification } from './dataClassification.js';
import { purgeTenantHostExt } from './hostExtPersistence.js';
import { purgeTenantOverrides } from './featureToggles/service.js';
import { purgeTenantOwnedWorkflowDefs } from './workflowOwnership.js';
import { deleteRegisteredWorkflow } from './workflowsRegistry.js';
import { purgeTenantVectors } from './vector/vectorTenantPurge.js';
import { clearTenantSecretCache } from '../byok/secretResolver.js';
import { __runKvAgeOutOnce } from './kvAgeOut.js';
import { eraseTenantOwnedUsage } from '../providers/managedProvider.js';
import { getRetentionHold } from './retentionHold.js';

const log = createLogger('host.retentionSweep');

const POLL_INTERVAL_MS = 60 * 60_000; // hourly — retention is day-granular
const DAY_MS = 86_400_000;
const CLAIM_KEY_PREFIX = 'retention-sweep:';   // the per-slot START lease (mutual exclusion)
const DONE_KEY_PREFIX = 'retention-swept:';    // the per-slot COMPLETION marker (GOV-3)
const CLAIM_PRUNE_AGE_MS = 2 * DAY_MS;
/** GOV-3 — a START claim older than this with NO completion marker is treated as a CRASHED
 *  holder, and the slot becomes eligible for same-day recovery instead of waiting for the
 *  next calendar day. Generous (2 poll intervals) so a normally-running sweep is never
 *  mistaken for a crash. Safe even if mis-tuned: the purge is idempotent (re-deleting an
 *  already-gone row is a no-op), so the lease is an EFFICIENCY guard, not a correctness one —
 *  a rare double-recovery is harmless redundant work, never data damage. */
const STALE_CLAIM_MS = 2 * POLL_INTERVAL_MS;
/** ADR 0380 §1 — TTL (days) for the Layer-1 HTTP idempotency cache. Default ON
 *  at 7 (generous vs Stripe's 24h window); `0` disables. Read per tick so tests
 *  and a live env update take effect without a restart. */
export function idempotencyTtlDays(): number {
  const raw = process.env.OPENWOP_IDEMPOTENCY_TTL_DAYS;
  if (raw === undefined || raw.trim() === '') return 7;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}
/** Classifications the sweep considers, with their default window (days) when unset.
 *  BOTH default to `null` (opt-in): retention purge only runs when an admin EXPLICITLY
 *  configures a window (`retention.confidentialPiiDays` / `retention.internalDays`).
 *  ADR 0081 P5 correction: the original `confidential-pii: 365` default meant registering
 *  ANY governance policy (e.g. a provider allowlist) silently armed a 365-day PII purge of
 *  durable, user-authored records (contacts/profiles/comments) once the sweep is enabled —
 *  a latent data-loss footgun. Making it opt-in (matching `internal`) requires deliberate
 *  intent before any personal data is auto-deleted. The PRD's 365 is now the recommended
 *  value an admin SETS, not an implicit default. */
const SWEPT: ReadonlyArray<{ classification: DataClassification; defaultDays: number | null }> = [
  { classification: 'confidential-pii', defaultDays: null },
  { classification: 'internal', defaultDays: null },
];

/** Resolve the retention window (days) for a classification, or null ⇒ never purge. */
export function windowDaysFor(policy: GovernancePolicy | null, classification: DataClassification, defaultDays: number | null): number | null {
  const r = policy?.retention;
  if (classification === 'confidential-pii') return r?.confidentialPiiDays ?? defaultDays;
  if (classification === 'internal') return r?.internalDays ?? defaultDays;
  return null; // 'public' is never retention-swept
}

export interface RetentionSweepDeps { storage: Storage }

/** Sweep every governed tenant × classification once. Returns the total rows purged by
 *  THIS instance. Exported pure for deterministic tests (pass `now`). */
export async function processRetentionSweep(deps: RetentionSweepDeps, now: number = Date.now()): Promise<number> {
  const tenants = await listGovernedTenants(); // explicit enumeration — never a wildcard
  const slot = Math.floor(now / DAY_MS); // one sweep per (tenant,classification) per day
  let purgedTotal = 0;
  let failedTotal = 0; // rows that matched the cutoff but could not be deleted (GOV-6 metrics)
  let claimedSlots = 0; // (tenant,classification) slots THIS instance owned + swept this tick
  let recoveredSlots = 0; // slots re-swept after a crashed holder (GOV-3)
  const nowIso = new Date(now).toISOString();
  for (const tenantId of tenants) {
    if (!tenantId) continue;
    const policy = await getGovernancePolicy(tenantId);
    for (const { classification, defaultDays } of SWEPT) {
      const days = windowDaysFor(policy, classification, defaultDays);
      if (days == null) continue; // no window ⇒ never purge this classification
      const slotKey = `${CLAIM_KEY_PREFIX}${tenantId}:${classification}:${slot}`;
      const doneKey = `${DONE_KEY_PREFIX}${tenantId}:${classification}:${slot}`;
      // GOV-3 — acquire the slot. The START claim gives mutual exclusion for the common
      // case; if it's already held, recover ONLY when that claim is STALE (its holder
      // crashed) AND the slot was never completed. We decide "completed?" by atomically
      // claiming the COMPLETION marker: winning it ⇒ not completed ⇒ recover; losing it ⇒
      // already done ⇒ skip. A normally-finished sweep writes the marker (below), so a
      // stale-but-completed slot is correctly skipped (no hourly re-scan regression).
      const start = await deps.storage.claimOnce(slotKey, nowIso);
      let sweep = start.claimed;
      let recovered = false;
      if (!sweep) {
        const ageMs = now - Date.parse(start.existing?.createdAt ?? nowIso);
        if (ageMs >= STALE_CLAIM_MS) {
          const done = await deps.storage.claimOnce(doneKey, nowIso);
          if (done.claimed) { sweep = true; recovered = true; } // marker absent ⇒ holder crashed
        }
      }
      if (!sweep) continue; // another instance owns this slot, or it's already completed
      claimedSlots += 1;
      if (recovered) { recoveredSlots += 1; log.warn('retention_slot_recovered', { tenantId, classification, slot }); }
      const cutoffIso = new Date(now - days * DAY_MS).toISOString();
      const results = await purgeRetained(tenantId, classification, cutoffIso);
      for (const r of results) {
        purgedTotal += r.deleted;
        failedTotal += r.failed;
        // The audit row IS the tombstone — never a silent cascade. Best-effort: an
        // audit-store failure must not abort the remaining tenants/classifications nor
        // suppress sibling tombstones (the delete already happened); log instead.
        // A purger that threw (`ok:false`) OR completed but could not delete some matched
        // rows (`failed>0`) is a partial_failure — the audit row carries the count + reason
        // so an operator can tell a clean no-op from a degraded purge (GOV-4).
        const outcome = !r.ok || r.failed > 0 ? 'partial_failure' : r.deleted > 0 ? 'success' : 'noop';
        await deps.storage.appendAudit({
          timestamp: new Date(now).toISOString(),
          action: 'governance.retention.purged',
          resource: `governance:${tenantId}`,
          outcome,
          payload: {
            tenantId, classification, feature: r.feature, cutoffIso, deleted: r.deleted,
            ...(r.failed > 0 ? { failed: r.failed } : {}),
            ...(r.error ? { error: r.error } : {}),
          },
        }).catch((err) => log.error('retention_audit_failed', {
          tenantId, classification, feature: r.feature, deleted: r.deleted,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
      // GOV-3 — mark the slot COMPLETED so a later stale-claim recovery tick knows this
      // slot finished and skips it (the marker reaching us via `done.claimed` in the
      // recovery path means it's already present; this overwrite is harmless). Best-effort:
      // if the write fails the slot may be redundantly re-swept later — idempotent, so safe.
      await deps.storage.putOnce({ key: doneKey, responseBody: 'done', responseStatus: 200, createdAt: nowIso })
        .catch((err) => log.error('retention_done_mark_failed', { tenantId, classification, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  // Sweep-completion metric (GOV-6): one structured line an operator/SRE can alert on —
  // how many slots this instance owned, how much it deleted, and whether any rows failed.
  if (claimedSlots > 0 || purgedTotal > 0) {
    log.info('retention_sweep_completed', { tenantsConsidered: tenants.length, claimedSlots, recoveredSlots, purged: purgedTotal, failed: failedTotal });
  }
  return purgedTotal;
}

export interface RetentionSweepDaemon {
  stop(): void;
  /** Run one tick immediately (grade-code C1 test seam — pins that the
   *  DEFAULT-posture tick, run retention disabled, still runs the
   *  proposal-hygiene sweep). Same body the interval runs. */
  tickNow(): Promise<void>;
}

/** WHROT-3 — batch size and per-tick batch cap for the delivery-secret backfill. */
const SECRET_BLANK_BATCH = 5_000;
const SECRET_BLANK_MAX_BATCHES = 20;

/** Drain up to `SECRET_BLANK_MAX_BATCHES` batches of the WHROT-3 backlog. Exported for tests. */
export async function blankTerminalDeliverySecretBacklog(storage: Storage): Promise<number> {
  let total = 0;
  for (let i = 0; i < SECRET_BLANK_MAX_BATCHES; i++) {
    const n = await storage.blankTerminalDeliverySecrets(SECRET_BLANK_BATCH);
    total += n;
    if (n < SECRET_BLANK_BATCH) break;
  }
  return total;
}

/** ADR 0287 — per-tick batch cap so engine pruning can't stall a sweep tick. */
const RUN_PRUNE_BATCH = 500;

/** Read a day-count env gate: unset/0/invalid = DISABLED (fail-closed for a
 *  destructive sweep — a reference host must never silently destroy run history). */
function retentionDaysEnv(name: string): number {
  const n = Number(process.env[name] ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * ADR 0287 — engine-table retention (grade-data RUN-2), operator OPT-IN:
 *  - `OPENWOP_RUN_RETENTION_DAYS` > 0 ⇒ prune TERMINAL runs older than that,
 *    WITH all children (whole-run only — event-thinning would be replay-
 *    dishonest), batched per tick.
 *  - `OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS` > 0 ⇒ prune delivered/dead
 *    delivery rows older than that.
 * Every purge emits the standard `governance.retention.purged` audit row (the
 * audit row IS the tombstone — the daemon's doctrine). Exported for tests.
 */
export async function pruneEngineTables(deps: RetentionSweepDeps, now: number = Date.now()): Promise<{ runs: number; childRows: number; deliveries: number }> {
  let runs = 0;
  let childRows = 0;
  let deliveries = 0;
  const runDays = retentionDaysEnv('OPENWOP_RUN_RETENTION_DAYS');
  if (runDays > 0) {
    const cutoffIso = new Date(now - runDays * 86_400_000).toISOString();
    const res = await deps.storage.pruneTerminalRuns(cutoffIso, RUN_PRUNE_BATCH);
    runs = res.runs;
    childRows = res.childRows;
    if (res.runs > 0) {
      await deps.storage.appendAudit({
        timestamp: new Date(now).toISOString(),
        action: 'governance.retention.purged',
        resource: 'governance:engine',
        outcome: 'success',
        payload: { feature: 'engine-runs', cutoffIso, deleted: res.runs, childRows: res.childRows },
      }).catch((err) => log.error('retention_audit_failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }
  const whDays = retentionDaysEnv('OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS');
  if (whDays > 0) {
    deliveries = await deps.storage.pruneWebhookDeliveries(now - whDays * 86_400_000);
    if (deliveries > 0) {
      await deps.storage.appendAudit({
        timestamp: new Date(now).toISOString(),
        action: 'governance.retention.purged',
        resource: 'governance:engine',
        outcome: 'success',
        payload: { feature: 'webhook-deliveries', cutoffMs: now - whDays * 86_400_000, deleted: deliveries },
      }).catch((err) => log.error('retention_audit_failed', { error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return { runs, childRows, deliveries };
}


/** Teardown steps that a test can substitute (the two run-INDEPENDENT purges).
 *  Defaults to the real module functions. */
export interface AnonTeardownHooks {
  purgeHostExt: (tenantId: string) => Promise<unknown>;
  purgeToggleOverrides: (tenantId: string) => Promise<unknown>;
  /** ADR 0595 — the `wfreg:` half. Defaulted, so an existing caller passing a
   *  partial hook object is a COMPILE error rather than a silently-skipped
   *  purge (the absence-is-a-claim shape). */
  purgeOwnedWorkflowDefs: (tenantId: string) => Promise<unknown>;
}

/** ADR 0372 — anon-tenant lifecycle (operator OPT-IN, default OFF):
 *  `OPENWOP_ANON_TENANT_RETENTION_DAYS` > 0 ⇒ tear down `anon:*` tenants with
 *  no HUMAN activity for that many days, via the SAME teardown steps the
 *  account-delete route uses (host-ext registry walk → per-tenant toggle
 *  overrides → SQL cascade → secret cache). Human activity = a NON-scheduler
 *  run (`metadata.schedule` absent) or a chat-session update — scheduler-fired
 *  runs never count (the 2026-07-15 lesson: 61 flood tenants looked "active"
 *  purely from their own runaway crons). A tenant with no human signal at all
 *  is abandoned once its FIRST run predates the cutoff. Anon tenants cannot
 *  hold shared-workspace memberships (sign-in required), so the route's
 *  membership cascade is deliberately not replicated. Batched — teardown
 *  walks ~180 host-ext collections per tenant. One audit tombstone each.
 *  Exported for tests. */
const ANON_TEARDOWN_BATCH = 5;
export async function pruneAbandonedAnonTenants(
  deps: RetentionSweepDeps,
  now: number = Date.now(),
  hooks: AnonTeardownHooks = {
    purgeHostExt: purgeTenantHostExt,
    purgeToggleOverrides: purgeTenantOverrides,
    purgeOwnedWorkflowDefs: (tenantId) => purgeTenantOwnedWorkflowDefs(tenantId, deleteRegisteredWorkflow),
  },
): Promise<number> {
  const days = retentionDaysEnv('OPENWOP_ANON_TENANT_RETENTION_DAYS');
  if (days <= 0) return 0;
  const cutoffIso = new Date(now - days * 86_400_000).toISOString();
  const activity = await deps.storage.listTenantActivity('anon:', 500);
  // Grade-pass DATA-1 — the RUNLESS leg: tenants with hostext rows but zero
  // runs (e.g. Studio provisioning on first touch) were permanently invisible
  // to the run-anchored enumerator above. A runless tenant is abandoned only
  // when BOTH its newest hostext write AND its newest chat touch predate the
  // cutoff — an active chat-only tenant is never torn down.
  const runAnchored = new Set(activity.map((t) => t.tenantId));
  const hostextOnly = (await deps.storage.listHostExtTenantActivity('anon:', 500))
    .filter((t) => !runAnchored.has(t.tenantId));
  const abandoned: Array<{ tenantId: string; anchor: 'runs' | 'hostext' }> = [
    ...activity
      .filter((t) => {
        const human = [t.lastHumanRunAt, t.lastChatAt].filter((x): x is string => x !== null).sort().pop() ?? null;
        return human !== null ? human < cutoffIso : t.firstRunAt !== null && t.firstRunAt < cutoffIso;
      })
      .map((t) => ({ tenantId: t.tenantId, anchor: 'runs' as const })),
    ...hostextOnly
      .filter((t) => t.lastHostExtAt < cutoffIso && (t.lastChatAt === null || t.lastChatAt < cutoffIso))
      .map((t) => ({ tenantId: t.tenantId, anchor: 'hostext' as const })),
  ];
  let torn = 0;
  let heldSkipped = 0;
  for (const t of abandoned) {
    // Grade-pass F-3: the batch counts TEARDOWNS, not candidates — an M2 skip
    // (runless entry that turns out to own runs) must not consume a slot, or
    // deterministic-order skips could starve real abandoned tenants forever.
    if (torn >= ANON_TEARDOWN_BATCH) break;
    try {
      // CONS-4 / review F2 — the LEGAL HOLD gate. This lane destroys a WHOLE
      // TENANT and had zero hold references, while ADR 0586 D2 claimed to gate
      // "every destructive lane". It is a background sweep with nobody waiting,
      // so the posture is SKIP-AND-REPORT, matching `purgeRetained` and
      // `runRetentionSweeper`'s `skippedHold` — not a throw, which would abort
      // the whole batch and starve the unheld tenants behind this one.
      //
      // Read per candidate rather than once per tick: the candidate list is
      // capped at 500 + 500 and the loop is capped at 5 teardowns, so this is
      // at most a handful of reads, and a hold placed mid-tick is honoured.
      // The same spoliation argument as the account lane applies with more
      // force here — nobody is watching, so an ungated teardown would delete a
      // held tenant AND its hold row with no operator in the loop at all.
      if (await getRetentionHold(t.tenantId)) {
        heldSkipped += 1;
        continue;
      }
      // RE-ENTRANT ORDERING (grade-pass RETENTION-DATA-1, extended by DATA-1's
      // runless leg): purge the ANCHOR-independent, idempotent stores FIRST;
      // delete the tenant's ANCHOR — the store its enumerator leg reads —
      // LAST. So a crash mid-teardown leaves the tenant re-surfaceable next
      // tick and the retry finishes the job, instead of stranding orphans the
      // enumerator can never reach again (the ADR 0287 lesson). For a
      // run-anchored tenant that's runs-last; for a hostext-anchored (runless)
      // tenant it is HOSTEXT-last — purging hostext first would deanchor it
      // with toggle rows still standing.
      // ADR 0595 (`WFAWF-8`) — the tenant's authored workflow DEFINITIONS.
      // `wfreg:` rows carry no JSON tenantId and sit outside the `hostext:`
      // walk by construction, so NONE of the purges below reach them: every
      // workflow an anon tenant authored was orphaned permanently, forever.
      // The account-delete route has called this since ADR 0473 D1; this leg
      // never did — the same purge, one lane short. Reachability is proved PER
      // LANE, and a shared helper with one caller is a helper with one lane.
      //
      // Placed FIRST in both legs, for the same reason `routes/account.ts`
      // states: it reads the ownership rows the hostext purge deletes. It is
      // also anchor-independent and idempotent, so the re-entrant ordering
      // rule above (anchor LAST) is preserved either way.
      //
      // The runless leg's run-EXISTS probe is HOISTED above this call. It was
      // a `continue` INSIDE the else-branch, so purging first would have
      // destroyed an active tenant's workflows and then declined to tear the
      // tenant down — a fix that is worse than the bug it closes. Hoisting
      // keeps ONE call site and leaves the probe's semantics identical.
      if (t.anchor !== 'runs') {
        // Review M2 — the dedupe set is built from a 500-capped run-anchored
        // list; past the cap an ACTIVE tenant could reach this leg on stale
        // hostext evidence alone. A run-EXISTS probe is the last line: any
        // runs ⇒ this tenant belongs to the run leg's evidence — skip, it
        // re-surfaces there next tick.
        const anyRun = await deps.storage.listRuns({ tenantId: t.tenantId, limit: 1 });
        if (anyRun.length > 0) continue;
      }
      await hooks.purgeOwnedWorkflowDefs(t.tenantId);
      if (t.anchor === 'runs') {
        await hooks.purgeHostExt(t.tenantId);
        await hooks.purgeToggleOverrides(t.tenantId);
        // ADR 0697 follow-up — the per-subject usage buckets this tenant owns are
        // keyed by a hash, so the exact-match introspection inside
        // `deleteAllTenantData` cannot reach them. Swept FIRST: if teardown
        // fails midway the orphans are already gone, which fails safe.
        await eraseTenantOwnedUsage(deps.storage, t.tenantId);
        await deps.storage.deleteAllTenantData(t.tenantId);
        await purgeTenantVectors(t.tenantId); // KB-2 — see the account-delete note
      } else {
        await hooks.purgeToggleOverrides(t.tenantId);
        // ADR 0697 follow-up — the per-subject usage buckets this tenant owns are
        // keyed by a hash, so the exact-match introspection inside
        // `deleteAllTenantData` cannot reach them. Swept FIRST: if teardown
        // fails midway the orphans are already gone, which fails safe.
        await eraseTenantOwnedUsage(deps.storage, t.tenantId);
        await deps.storage.deleteAllTenantData(t.tenantId);
        await hooks.purgeHostExt(t.tenantId);
        await purgeTenantVectors(t.tenantId); // KB-2 — see the account-delete note
      }
      clearTenantSecretCache(t.tenantId);
      torn += 1;
      await deps.storage.appendAudit({
        timestamp: new Date(now).toISOString(),
        action: 'governance.retention.purged',
        resource: 'governance:engine',
        outcome: 'success',
        payload: { feature: 'anon-tenant-lifecycle', tenantId: t.tenantId, cutoffIso },
      }).catch((err) => log.error('retention_audit_failed', { error: err instanceof Error ? err.message : String(err) }));
    } catch (err) {
      log.warn('anon tenant teardown failed', { tenantId: t.tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // A hold that BLOCKED a teardown is an audit finding, not a footnote: it is
  // the evidence that the hold did its job. Logged even when nothing was torn
  // down, because "held everything" and "found nothing" must not read alike.
  if (heldSkipped > 0) log.info('anon_teardown_skipped_hold', { heldSkipped, cutoffIso });
  if (torn > 0) log.info('anon_tenants_torn_down', { count: torn, cutoffIso, batch: ANON_TEARDOWN_BATCH });
  return torn;
}

/** Start the polling retention sweep for the running server. The ONE retention
 *  loop (ADR 0077 + ADR 0371 — no parallel daemons): each half self-gates
 *  inside the tick — governance fan-out behind `OPENWOP_RETENTION_SWEEP_ENABLED`,
 *  the ADR 0371 RUN sweep behind `OPENWOP_RUN_RETENTION_DAYS > 0`. The boot
 *  call site starts the loop when EITHER gate is on. */
export function startRetentionSweepDaemon(deps: RetentionSweepDeps): RetentionSweepDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // ADR 0371 — run retention (self-idempotent: deleteRun races are
      // harmless; no lease). Its own quiet-window check lives inside.
      if (defaultRetentionDays() > 0) {
        await __runRetentionSweepOnce(deps.storage).catch((err) =>
          log.warn('run retention tick error', { error: err instanceof Error ? err.message : String(err) }));
        // ADR 0371 P4 / ADR 0369 GC — archived transient defs whose runs all
        // aged out (retention is exactly what makes hasRunForWorkflow false).
        await __runTransientDefGcOnce(deps.storage).catch((err) =>
          log.warn('transient gc tick error', { error: err instanceof Error ? err.message : String(err) }));
      }
      // ADR 0473 (grade-code C1) — expired composed-workflow proposals resolve
      // (rejected, note `expired`) + their drafts archive. Deliberately OUTSIDE
      // the run-retention gate: this is HOLD HYGIENE (the ADR 0380 class, not
      // user-data retention) — on a default-posture host (`OPENWOP_RUN_
      // RETENTION_DAYS` unset) ignored proposals would otherwise pin the
      // transient cap forever and eventually brick the propose lane.
      await sweepExpiredWorkflowProposals().catch((err) =>
        log.warn('workflow proposal sweep tick error', { error: err instanceof Error ? err.message : String(err) }));
      // ADR 0380 — size-hygiene TTLs. Default ON (unlike the halves above):
      // these sweep CACHES and append-only ledgers, not user data — a cache
      // without expiry is a defect, not a policy choice. Both run BEFORE the
      // governance opt-in gate below.
      const idemDays = idempotencyTtlDays();
      if (idemDays > 0) {
        // '' prefix = EVERY row of the fire-once MUTEX table (ADR 0380 §1).
        // The scheduler claim/done slices above prune sooner at their own 2d
        // age; this is the backstop for daemon keys nobody prunes by prefix.
        // Post-TTL retry re-executes: acceptable for a fire-once slot (the
        // run-layer invocation_log rides deleteRun, untouched here).
        //
        // ADR 0549 — this line USED TO BE the HTTP dedupe cache's only cleaner
        // (the probe-confirmed ~5.8k rows/day). The HTTP lane has since moved
        // to its own `idempotent_response` table, so this call no longer
        // reaches it and the ledger needs its own sweep — immediately below.
        // Splitting the lanes without splitting their retention would have
        // left the new table growing unbounded, which is the same defect ADR
        // 0380 §1 was written to close.
        const idemBefore = new Date(Date.now() - idemDays * DAY_MS).toISOString();
        await deps.storage.pruneOnceByPrefix('', idemBefore)
          .then((n) => { if (n > 0) log.info('idempotency_ttl_pruned', { deleted: n, ttlDays: idemDays }); })
          .catch((err) => log.warn('idempotency ttl tick error', { error: err instanceof Error ? err.message : String(err) }));
        await deps.storage.pruneIdempotentResponses(idemBefore)
          .then((n) => { if (n > 0) log.info('idempotent_response_ttl_pruned', { deleted: n, ttlDays: idemDays }); })
          .catch((err) => log.warn('idempotent response ttl tick error', { error: err instanceof Error ? err.message : String(err) }));
      }
      // WHROT-1 (`/grade-data` 2026-09-26) — a rotated-out webhook secret leaves
      // the row once its RFC 0201 §E overlap ends. Default ON, like the TTLs
      // above: this is key hygiene, not user-data retention, and it deletes no
      // row — the worker already stopped signing with it at that instant.
      await deps.storage.retireExpiredWebhookSecrets(Date.now())
        .then((n) => { if (n > 0) log.info('webhook_previous_secrets_retired', { cleared: n }); })
        .catch((err) => log.warn('webhook secret retire tick error', { error: err instanceof Error ? err.message : String(err) }));
      // WHROT-3 — and the enqueue-time copies on terminal delivery rows written
      // before those rows started being blanked. Bounded batches, bounded per tick.
      await blankTerminalDeliverySecretBacklog(deps.storage)
        .then((n) => { if (n > 0) log.info('webhook_delivery_secret_copies_blanked', { cleared: n }); })
        .catch((err) => log.warn('webhook delivery secret blank tick error', { error: err instanceof Error ? err.message : String(err) }));
      // ADR 0380 §3 — registered append-only kv stores (fail-open per store inside).
      await __runKvAgeOutOnce(deps.storage).catch((err) =>
        log.warn('kv age-out tick error', { error: err instanceof Error ? err.message : String(err) }));
      if (process.env.OPENWOP_RETENTION_SWEEP_ENABLED !== 'true') return;
      await processRetentionSweep(deps);
      const pruneBefore = new Date(Date.now() - CLAIM_PRUNE_AGE_MS).toISOString();
      await deps.storage.pruneOnceByPrefix(CLAIM_KEY_PREFIX, pruneBefore).catch(() => undefined);
      await deps.storage.pruneOnceByPrefix(DONE_KEY_PREFIX, pruneBefore).catch(() => undefined); // GOV-3 completion markers
      await pruneEngineTables(deps).catch((err) => log.warn('engine retention tick error', { error: err instanceof Error ? err.message : String(err) }));
      await pruneAbandonedAnonTenants(deps).catch((err) => log.warn('anon lifecycle tick error', { error: err instanceof Error ? err.message : String(err) }));
      // RUNDATA-3 — audit_log growth gauge (unbounded BY DESIGN; measure first).
      await deps.storage.countAuditRows()
        .then((rows) => log.info('audit_log_gauge', { rows }))
        .catch(() => undefined);
    } catch (err) {
      log.warn('retention sweep tick error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void runUnderWorkerContract(tick), POLL_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('retention sweep daemon started', { pollIntervalMs: POLL_INTERVAL_MS, instanceId: getInstanceId() });
  return { stop: () => clearInterval(timer), tickNow: tick };
}
