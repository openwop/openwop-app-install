/**
 * sqlite-backed Storage implementation. Default for the sample.
 *
 * Uses better-sqlite3 (synchronous API). The synchronous boundary is
 * fine here because the executor is single-process and the sample
 * doesn't claim multi-instance — production deployers swap for
 * Postgres / Firestore behind the same `Storage` interface.
 */

import Database from 'better-sqlite3';
import { aggregateHostExtTenantActivity, HOSTEXT_ACTIVITY_ROW_CAP } from '../hostExtActivity.js';
import { withRemovalStamp } from '../runRetentionStamp.js';
import { planHostExtRekey, rekeyTenantSegment, runBudgetBucketBelongsTo } from '../tenantMigration.js';
import { TERMINAL_RUN_STATUSES } from '@openwop/openwop';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UsageLikeMatcher, WebhookClaimOptions } from '../storage.js';
import type {
  ChatMessageRecord,
  ChatSessionRecord,
  DispatchOutboxRecord,
  EventRecord,
  IdempotencyRecord,
  InterruptRecord,
  NotificationRecord,
  PushSubscriptionRecord,
  RunRecord,
  UserAgentRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord,
} from '../../types.js';
import type { IdempotentClaim } from '../../host/idempotentResponse.js';
import type { WorkspaceFileRow } from '../../host/workspaceStore.js';
import type {
  ChatEgressEnvelope,
  DeliveryLogRecord,
  MessagingConnectorRecord,
  MessagingIdentityRecord,
  MessagingPolicyRecord,
  MessagingAllowlistEntry,
  MessagingPairingRecord,
  MessagingRoutingRuleRecord,
  MessagingSessionRecord,
  MessagingTurnRecord,
  RelayDeviceRecord,
} from '../../messaging/types.js';
import { egressExtraJson, applyEgressExtra } from '../../messaging/types.js';
import { IdempotentCommitRejectedError, PAYLOAD_KEY_RE, RUN_FINAL_STATUSES, type Storage } from '../storage.js';
import { applyMigrations } from './schema.js';
import { isForwardExecutionEvent, RunLogClosedError, TERMINAL_RUN_EVENT_TYPES } from '../runLogClosure.js';

/** Every table with a `tenant_id` column, read from the live schema (memoized
 *  per Database). The single source of truth for tenant-scoped bulk ops
 *  (ADR 0003 Phase 4c) — see `../tenantMigration.ts`. Introspection means a new
 *  tenant table is covered automatically; nothing to register, nothing to forget. */
const tenantTablesCache = new WeakMap<Database.Database, string[]>();
function tenantScopedTables(db: Database.Database): string[] {
  const cached = tenantTablesCache.get(db);
  if (cached) return cached;
  const rows = db
    .prepare(
      `SELECT m.name AS name FROM sqlite_master m
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
         AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'tenant_id')
       ORDER BY m.name`,
    )
    .all() as Array<{ name: string }>;
  const names = rows.map((r) => r.name);
  tenantTablesCache.set(db, names);
  return names;
}

/** better-sqlite3's in-memory sentinel. A `Database` opened on it is private to
 *  that instance — two opens are two independent databases. */
const SQLITE_MEMORY = ':memory:';

/**
 * Resolve a caller's argument to something `new Database(...)` should be handed
 * (H18).
 *
 * WHY THIS EXISTS. `openSqliteStorage` treated its argument as a bare filesystem
 * path, unconditionally. `openStorage()` in `../index.ts` maps `memory://` to
 * `:memory:` before calling here, so the app path was fine — but a DIRECT caller
 * passing the DSN went through `resolve('memory://')`, which normalises to
 * `<cwd>/memory:`, and the process quietly created a real sqlite FILE literally
 * named `memory:`. `test/egress-policy.unit.test.ts` was doing exactly that, so
 * `backend/typescript/memory:` appeared on developer machines (hence the
 * `.gitignore` entries).
 *
 * That is not merely untidy. ADR 0551 P1 found the compound failure: a stale
 * on-disk `memory:` DB stamped at a migration number that a later renumber
 * REUSED then SKIPPED the real migration at that number and reported itself
 * fully migrated. An in-memory database cannot be stale, so removing the file's
 * ability to exist removes the whole class.
 *
 * The rule: understood in-memory spellings become the sentinel; an unrecognised
 * `scheme://` argument THROWS rather than being silently turned into a filename.
 * Anything else is a path, exactly as before.
 */
export function resolveSqliteTarget(dbPath: string): string {
  if (dbPath === SQLITE_MEMORY) return SQLITE_MEMORY;
  // `memory://`, `memory://anything` — mirrors `openStorage`'s `startsWith`
  // test so the two entry points cannot disagree about what a DSN means.
  if (dbPath.startsWith('memory://')) return SQLITE_MEMORY;
  if (dbPath === 'sqlite://:memory:') return SQLITE_MEMORY;
  // A `sqlite://` DSN handed straight here is unambiguous; take the path half.
  // (`openStorage` normally strips it first — accepting it costs nothing and
  // means the two callers agree.)
  if (dbPath.startsWith('sqlite://')) {
    const path = dbPath.slice('sqlite://'.length);
    return path === SQLITE_MEMORY ? SQLITE_MEMORY : resolve(path);
  }
  // Fail LOUD on any other URL-shaped argument. Silently creating a file named
  // after the DSN is the defect above; a `postgres://` DSN reaching here would
  // otherwise produce an empty sqlite file called `postgres:` and a host that
  // looked like it had started.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(dbPath);
  if (scheme) {
    throw new Error(
      `openSqliteStorage: unsupported DSN scheme "${scheme[1]}://" (${dbPath}). `
        + 'This function takes a filesystem PATH, `:memory:`, `memory://`, or `sqlite://<path>`. '
        + 'Use openStorage() from ../index.js for full DSN routing — passing a DSN here used to '
        + 'create a file literally named after it.',
    );
  }
  return resolve(dbPath);
}

export function openSqliteStorage(dbPath: string): Storage {
  const resolvedPath = resolveSqliteTarget(dbPath);
  if (resolvedPath !== SQLITE_MEMORY) {
    const dir = dirname(resolvedPath);
    if (isAbsolute(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);

  // Cross-instance pub/sub is in-process here: sqlite is single-node, so an
  // EventEmitter delivers a publish to every subscriber in the one process.
  // (The Postgres adapter uses LISTEN/NOTIFY for true cross-instance fan-out.)
  const pubsub = new EventEmitter();
  pubsub.setMaxListeners(0); // many concurrent SSE subscribers

  // ── statements (prepared once for reuse) ──

  const insertRunStmt = db.prepare(`
    INSERT INTO runs (
      run_id, workflow_id, tenant_id, scope_id, status,
      inputs, metadata, configurable, callback_url,
      idempotency_key, parent_run_id, parent_seq, fork_mode,
      created_at, updated_at, completed_at, error_code, error_message,
      current_node_id, scheduler_snapshot, event_log_schema_version
    ) VALUES (
      @runId, @workflowId, @tenantId, @scopeId, @status,
      @inputs, @metadata, @configurable, @callbackUrl,
      @idempotencyKey, @parentRunId, @parentSeq, @forkMode,
      @createdAt, @updatedAt, @completedAt, @errorCode, @errorMessage,
      @currentNodeId, @schedulerSnapshot, @eventLogSchemaVersion
    )
  `);

  const getRunStmt = db.prepare(`SELECT * FROM runs WHERE run_id = ?`);

  const listRunsStmt = db.prepare(`
    SELECT * FROM runs
    WHERE (@tenantId IS NULL OR tenant_id = @tenantId)
      AND (@status IS NULL OR status = @status)
      AND (@workflowId IS NULL OR workflow_id = @workflowId)
      AND (@beforeCreatedAt IS NULL
           OR created_at < @beforeCreatedAt
           OR (created_at = @beforeCreatedAt AND run_id < @beforeRunId))
    ORDER BY created_at DESC, run_id DESC
    LIMIT @limit
  `);

  const listRunsByParentStmt = db.prepare(`
    SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC
  `);

  // ── run dispatch lease (multi-instance crash recovery, schema v20) ──
  const setRunDispatchLeaseStmt = db.prepare(`
    UPDATE runs
    SET dispatch_owner = @owner, dispatch_lease_expires_at = @lease
    WHERE run_id = @runId
  `);
  // ADR 0585 P0b — the RENEWAL form. Identical except for `AND dispatch_owner
  // = @owner`, and that predicate is the whole point: a renewal must never be
  // able to take a run back from a new owner. See `Storage.
  // renewRunDispatchLeaseIfOwner` for why the unconditional form above is
  // correct at dispatch and wrong as a heartbeat.
  // ADR 0740 — the EXECUTION CLAIM. One conditional UPDATE, so the predicate and
  // the write are a single atomic step even across processes sharing the file
  // (unlike `claimRunDispatchStmt` below, whose safety rests on better-sqlite3
  // serialising write transactions process-wide). Keep the predicate IDENTICAL
  // to the Postgres arm — `test/adr0740-run-execution-claim.test.ts` runs the
  // same table against whichever backend the suite boots.
  const claimRunExecutionStmt = db.prepare(`
    UPDATE runs
    SET dispatch_owner = @owner, dispatch_lease_expires_at = @lease
    WHERE run_id = @runId
      AND status NOT IN ('completed', 'failed', 'cancelled')
      AND (
        dispatch_owner IS NULL
        OR dispatch_lease_expires_at IS NULL
        OR dispatch_lease_expires_at < @nowMs
        OR status IN ('paused', 'waiting-approval', 'waiting-input', 'waiting-external')
      )
  `);
  const runStatusForClaimStmt = db.prepare(`SELECT status FROM runs WHERE run_id = ?`);
  const renewRunDispatchLeaseIfOwnerStmt = db.prepare(`
    UPDATE runs
    SET dispatch_lease_expires_at = @lease
    WHERE run_id = @runId AND dispatch_owner = @owner
  `);
  // Select up-to-`limit` ORPHAN run ids: pending/running, past the grace
  // window (createdAt < staleBeforeIso — created_at is ISO-8601 TEXT, so
  // lexicographic compare is chronological), and the lease absent/expired.
  const selectOrphanedRunIdsStmt = db.prepare(`
    SELECT run_id FROM runs
    WHERE status IN ('pending', 'running')
      AND created_at < @staleBeforeIso
      AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at < @nowMs)
    ORDER BY created_at ASC
    LIMIT @limit
  `);
  const claimRunDispatchStmt = db.prepare(`
    UPDATE runs
    SET dispatch_owner = @workerId, dispatch_lease_expires_at = @leaseExpiresAt
    WHERE run_id = @runId
  `);

  const appendEventStmt = db.prepare(`
    INSERT INTO events (event_id, run_id, sequence, type, node_id, payload, timestamp, causation_id)
    VALUES (@eventId, @runId, @sequence, @type, @nodeId, @payload, @timestamp, @causationId)
  `);

  // RFC 0171 §A.3 / `events.md` §Shape + `schemas/run-event.schema.json`: the FIRST
  // event of a run is sequence 0, so the empty-log sentinel is -1 and `max + 1`
  // assigns 0 to the first append. `COALESCE(..., 0)` numbered from 1 and made an
  // empty log indistinguishable from a log holding only event 0.
  const getMaxSeqStmt = db.prepare(`SELECT COALESCE(MAX(sequence), -1) AS max FROM events WHERE run_id = ?`);

  // ADR 0754 — one indexed read replaces paging the log (see storage.ts).
  const findFirstEventByPayloadStmt = db.prepare(`
    SELECT * FROM events
    WHERE run_id = @runId AND type = @type AND json_extract(payload, @path) = @value
    ORDER BY sequence ASC
    LIMIT 1
  `);
  const listEventsStmt = db.prepare(`
    SELECT * FROM events
    WHERE run_id = @runId AND sequence > @fromSeq
    ORDER BY sequence ASC
    LIMIT @limit
  `);

  const insertInterruptStmt = db.prepare(`
    INSERT INTO interrupts (
      interrupt_id, run_id, node_id, kind, token, data, resume_schema, created_at, expires_at
    ) VALUES (
      @interruptId, @runId, @nodeId, @kind, @token, @data, @resumeSchema, @createdAt, @expiresAt
    )
  `);

  const getInterruptStmt = db.prepare(`SELECT * FROM interrupts WHERE interrupt_id = ?`);
  const getInterruptByTokenStmt = db.prepare(`SELECT * FROM interrupts WHERE token = ?`);
  const getInterruptByNodeStmt = db.prepare(`
    SELECT * FROM interrupts
    WHERE run_id = ? AND node_id = ? AND resolved_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `);
  const resolveInterruptStmt = db.prepare(`
    UPDATE interrupts SET resolved_at = ?, resolved_value = ?
    WHERE interrupt_id = ? AND resolved_at IS NULL
  `);
  const listOpenInterruptsAllStmt = db.prepare(`
    SELECT * FROM interrupts WHERE resolved_at IS NULL ORDER BY created_at ASC LIMIT ?
  `);
  const listOpenInterruptsStmt = db.prepare(`
    SELECT * FROM interrupts WHERE run_id = ? AND resolved_at IS NULL
  `);

  const insertWebhookStmt = db.prepare(`
    INSERT INTO webhooks (subscription_id, tenant_id, url, events, tags, secret, created_at, protocol_major, signature_algorithms)
    VALUES (@subscriptionId, @tenantId, @url, @events, @tags, @secret, @createdAt, @protocolMajor, @signatureAlgorithms)
  `);
  // ADR 0747 — one statement; see the postgres adapter for why.
  const rotateWebhookSecretStmt = db.prepare(`
    UPDATE webhooks
       SET previous_secret = secret, secret = @secret, previous_secret_expires_at = @previousSecretExpiresAt, rotated_at = @rotatedAt
     WHERE subscription_id = @subscriptionId
  `);
  const getWebhookStmt = db.prepare(`SELECT * FROM webhooks WHERE subscription_id = ?`);
  const deleteWebhookStmt = db.prepare(`DELETE FROM webhooks WHERE subscription_id = ?`);
  // WHD-16 — unregistering stops delivery: pending rows go with the subscription.
  const deletePendingDeliveriesStmt = db.prepare(
    `DELETE FROM webhook_deliveries WHERE subscription_id = ? AND status = 'pending'`,
  );
  const deleteWebhookTxn = db.transaction((subscriptionId: string) => {
    deletePendingDeliveriesStmt.run(subscriptionId);
    deleteWebhookStmt.run(subscriptionId);
  });
  const listWebhooksStmt = db.prepare(`SELECT * FROM webhooks`);

  // ── webhook deliveries (durable retry queue) ──
  const enqueueWebhookDeliveryStmt = db.prepare(`
    INSERT INTO webhook_deliveries (
      delivery_id, subscription_id, wire_subscription_id, url, secret, event_type, payload,
      status, attempts, max_attempts, next_attempt_at,
      claimed_by, claim_expires_at, last_error, created_at, updated_at, tenant_id
    ) VALUES (
      @deliveryId, @subscriptionId, @wireSubscriptionId, @url, @secret, @eventType, @payload,
      @status, @attempts, @maxAttempts, @nextAttemptAt,
      @claimedBy, @claimExpiresAt, @lastError, @createdAt, @updatedAt, @tenantId
    )
  `);
  // RFC 0215 §B (ADR 0752) — the fan-out's insert, only while the subscription
  // exists. better-sqlite3 serializes writes, so this cannot interleave with
  // `deleteWebhookTxn`: an enqueue either lands before the delete (and the delete
  // removes it) or finds no subscription and inserts nothing.
  const enqueueWebhookDeliveryIfSubscribedStmt = db.prepare(`
    INSERT INTO webhook_deliveries (
      delivery_id, subscription_id, wire_subscription_id, url, secret, event_type, payload,
      status, attempts, max_attempts, next_attempt_at,
      claimed_by, claim_expires_at, last_error, created_at, updated_at, tenant_id
    ) SELECT
      @deliveryId, @subscriptionId, @wireSubscriptionId, @url, @secret, @eventType, @payload,
      @status, @attempts, @maxAttempts, @nextAttemptAt,
      @claimedBy, @claimExpiresAt, @lastError, @createdAt, @updatedAt, @tenantId
    WHERE EXISTS (SELECT 1 FROM webhooks WHERE subscription_id = @subscriptionId)
  `);
  // RFC 0215 §A lanes: every due row's id + subscription, oldest first. The
  // one-per-subscription / exclusion narrowing happens in the claim txn below,
  // which is atomic, so no other claimer can observe a half-applied pick.
  const selectDueWebhookDeliveryLaneRowsStmt = db.prepare(`
    SELECT delivery_id, subscription_id, tenant_id FROM webhook_deliveries
    WHERE status = 'pending'
      AND next_attempt_at <= @now
      AND (claim_expires_at IS NULL OR claim_expires_at < @now)
    ORDER BY next_attempt_at ASC, delivery_id ASC
  `);
  // Select the ids of up-to-`limit` DUE deliveries, oldest schedule first.
  const selectDueWebhookDeliveryIdsStmt = db.prepare(`
    SELECT delivery_id FROM webhook_deliveries
    WHERE status = 'pending'
      AND next_attempt_at <= @now
      AND (claim_expires_at IS NULL OR claim_expires_at < @now)
    ORDER BY next_attempt_at ASC
    LIMIT @limit
  `);
  const claimWebhookDeliveryStmt = db.prepare(`
    UPDATE webhook_deliveries
    SET claimed_by = @workerId, claim_expires_at = @claimExpiresAt, updated_at = @now
    WHERE delivery_id = @deliveryId
  `);
  const getWebhookDeliveryStmt = db.prepare(`SELECT * FROM webhook_deliveries WHERE delivery_id = ?`);
  const markWebhookDeliveryDeliveredStmt = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'delivered', updated_at = @now, claimed_by = NULL, claim_expires_at = NULL, secret = ''
    WHERE delivery_id = @deliveryId
  `);
  const rescheduleWebhookDeliveryStmt = db.prepare(`
    UPDATE webhook_deliveries
    SET attempts = attempts + 1,
        status = @status,
        secret = CASE WHEN @status = 'dead' THEN '' ELSE secret END,
        next_attempt_at = @nextAttemptAt,
        last_error = @error,
        claimed_by = NULL,
        claim_expires_at = NULL,
        updated_at = @now
    WHERE delivery_id = @deliveryId AND status != 'delivered'
  `);

  // Atomic claim: SELECT due ids + UPDATE the lease + re-SELECT the claimed
  // rows, all under one better-sqlite3 write transaction. better-sqlite3
  // serializes write txns process-wide, so two concurrent claimers cannot
  // grab the same row — the second sees the lease already set and its own
  // due-scan excludes those ids.
  const claimDueWebhookDeliveriesTxn = db.transaction(
    (workerId: string, now: number, leaseMs: number, limit: number, opts?: WebhookClaimOptions): WebhookDeliveryRecord[] => {
      let idRows: Array<{ delivery_id: string }>;
      const exclude = new Set(opts?.excludeSubscriptionIds ?? []);
      const excludeTenants = new Set(opts?.excludeTenantIds ?? []);
      if (opts?.onePerSubscription || exclude.size > 0 || excludeTenants.size > 0) {
        // Oldest-first scan; take a subscription's first due row, skip its rest
        // and any subscription already in flight here (RFC 0215 §A, ADR 0752).
        idRows = [];
        const taken = new Set<string>();
        for (const r of selectDueWebhookDeliveryLaneRowsStmt.iterate({ now }) as Iterable<{ delivery_id: string; subscription_id: string; tenant_id: string | null }>) {
          if (idRows.length >= limit) break;
          if (exclude.has(r.subscription_id)) continue;
          // §A.3 (ADR 0752 P2): a tenant at its in-flight cap. A NULL-tenant row
          // predates the column and is never excluded.
          if (r.tenant_id !== null && excludeTenants.has(r.tenant_id)) continue;
          if (opts?.onePerSubscription) {
            if (taken.has(r.subscription_id)) continue;
            taken.add(r.subscription_id);
          }
          idRows.push({ delivery_id: r.delivery_id });
        }
      } else {
        idRows = selectDueWebhookDeliveryIdsStmt.all({ now, limit }) as Array<{ delivery_id: string }>;
      }
      const claimExpiresAt = now + leaseMs;
      const claimed: WebhookDeliveryRecord[] = [];
      for (const { delivery_id } of idRows) {
        claimWebhookDeliveryStmt.run({ deliveryId: delivery_id, workerId, claimExpiresAt, now });
        const row = getWebhookDeliveryStmt.get(delivery_id);
        if (row) claimed.push(rowToWebhookDelivery(row));
      }
      return claimed;
    },
  );

  // Atomic orphan-run claim: SELECT due ids + UPDATE the lease + re-SELECT
  // the claimed rows, all under one better-sqlite3 write transaction — same
  // shape as claimDueWebhookDeliveriesTxn above. better-sqlite3 serializes
  // write txns process-wide, so two concurrent reapers can't grab the same
  // run: the second's due-scan excludes ids whose lease the first just set.
  const claimOrphanedRunsTxn = db.transaction(
    (
      workerId: string,
      nowMs: number,
      staleBeforeIso: string,
      leaseMs: number,
      limit: number,
    ): RunRecord[] => {
      const idRows = selectOrphanedRunIdsStmt.all({ staleBeforeIso, nowMs, limit }) as Array<{
        run_id: string;
      }>;
      const leaseExpiresAt = nowMs + leaseMs;
      const claimed: RunRecord[] = [];
      for (const { run_id } of idRows) {
        claimRunDispatchStmt.run({ runId: run_id, workerId, leaseExpiresAt });
        const row = getRunStmt.get(run_id);
        if (row) claimed.push(rowToRun(row));
      }
      return claimed;
    },
  );

  const getIdempotencyStmt = db.prepare(`SELECT * FROM idempotency WHERE key = ?`);
  const upsertIdempotencyStmt = db.prepare(`
    INSERT OR REPLACE INTO idempotency (key, response_body, response_status, created_at)
    VALUES (@key, @responseBody, @responseStatus, @createdAt)
  `);

  // ADR 0549 — HTTP idempotency ledger, keyed (tenant, endpoint, key).
  const getIdemResponseStmt = db.prepare(`
    SELECT request_digest, state, response_status, response_body,
           claim_token, claim_expires_at
      FROM idempotent_response
     WHERE tenant_id = @tenantId AND endpoint_id = @endpoint AND idempotency_key = @key
  `);
  const insertIdemResponseStmt = db.prepare(`
    INSERT INTO idempotent_response
      (tenant_id, endpoint_id, idempotency_key, request_digest, state,
       claim_token, claim_expires_at, created_at, updated_at)
    VALUES (@tenantId, @endpoint, @key, @requestDigest, 'pending',
            @claimToken, @claimExpiresAt, @createdAt, @createdAt)
  `);
  // ADR 0549 P1 — reclaim an EXPIRED pending claim. The `claim_token = @prevToken`
  // predicate is the compare-and-set: two callers racing to reclaim the same
  // dead claim cannot both win.
  const reclaimIdemResponseStmt = db.prepare(`
    UPDATE idempotent_response
       SET claim_token = @claimToken, claim_expires_at = @claimExpiresAt, updated_at = @now
     WHERE tenant_id = @tenantId AND endpoint_id = @endpoint AND idempotency_key = @key
       AND state = 'pending' AND claim_expires_at < @now AND claim_token IS @prevToken
  `);
  const completeIdemResponseStmt = db.prepare(`
    UPDATE idempotent_response
       SET state = 'completed', response_status = @responseStatus,
           response_body = @responseBody, run_id = @runId, updated_at = @updatedAt
     WHERE tenant_id = @tenantId AND endpoint_id = @endpoint AND idempotency_key = @key
       AND state != 'completed' AND claim_token = @claimToken
  `);
  const releaseIdemResponseStmt = db.prepare(`
    DELETE FROM idempotent_response
     WHERE tenant_id = @tenantId AND endpoint_id = @endpoint AND idempotency_key = @key
       AND claim_token = @claimToken AND state != 'completed'
  `);

  const upsertSecretStmt = db.prepare(`
    INSERT INTO byok_secrets (credential_ref, encrypted_record, created_at, updated_at)
    VALUES (@ref, @rec, @now, @now)
    ON CONFLICT(credential_ref) DO UPDATE SET
      encrypted_record = excluded.encrypted_record,
      updated_at       = excluded.updated_at
  `);
  const getSecretStmt = db.prepare(`SELECT encrypted_record FROM byok_secrets WHERE credential_ref = ?`);
  const deleteSecretStmt = db.prepare(`DELETE FROM byok_secrets WHERE credential_ref = ?`);
  const listSecretRefsStmt = db.prepare(`SELECT credential_ref FROM byok_secrets ORDER BY credential_ref ASC`);

  const upsertTenantSecretStmt = db.prepare(`
    INSERT INTO byok_tenant_secrets (tenant_id, credential_ref, encrypted_record, created_at, updated_at)
    VALUES (@tenant, @ref, @rec, @now, @now)
    ON CONFLICT(tenant_id, credential_ref) DO UPDATE SET
      encrypted_record = excluded.encrypted_record,
      updated_at       = excluded.updated_at
  `);
  const getTenantSecretStmt = db.prepare(
    `SELECT encrypted_record FROM byok_tenant_secrets WHERE tenant_id = ? AND credential_ref = ?`,
  );
  const deleteTenantSecretStmt = db.prepare(
    `DELETE FROM byok_tenant_secrets WHERE tenant_id = ? AND credential_ref = ?`,
  );
  const listTenantSecretRefsStmt = db.prepare(
    `SELECT credential_ref FROM byok_tenant_secrets WHERE tenant_id = ? ORDER BY credential_ref ASC`,
  );
  const deleteAllTenantSecretsStmt = db.prepare(
    `DELETE FROM byok_tenant_secrets WHERE tenant_id = ?`,
  );

  const incrManagedUsageStmt = db.prepare(`
    INSERT INTO managed_provider_usage (tenant_id, date, provider_id, input_tokens, output_tokens)
    VALUES (@tenant, @date, @provider, @inTok, @outTok)
    ON CONFLICT(tenant_id, date, provider_id) DO UPDATE SET
      input_tokens  = input_tokens  + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens
  `);
  const getManagedUsageStmt = db.prepare(
    `SELECT input_tokens, output_tokens FROM managed_provider_usage
       WHERE tenant_id = ? AND date = ? AND provider_id = ?`,
  );

  const incrMediaUsageStmt = db.prepare(`
    INSERT INTO media_provider_usage (tenant_id, date, tts_chars, stt_bytes)
    VALUES (@tenant, @date, @ttsChars, @sttBytes)
    ON CONFLICT(tenant_id, date) DO UPDATE SET
      tts_chars = tts_chars + excluded.tts_chars,
      stt_bytes = stt_bytes + excluded.stt_bytes
  `);
  const getMediaUsageStmt = db.prepare(
    `SELECT tts_chars, stt_bytes FROM media_provider_usage WHERE tenant_id = ? AND date = ?`,
  );

  const incrByokChatUsageStmt = db.prepare(`
    INSERT INTO byok_chat_usage (tenant_id, provider_id, date_utc, input_tokens, output_tokens)
    VALUES (@tenant, @provider, @date, @inTok, @outTok)
    ON CONFLICT(tenant_id, provider_id, date_utc) DO UPDATE SET
      input_tokens  = input_tokens  + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens
  `);
  const getByokChatUsageStmt = db.prepare(
    `SELECT input_tokens, output_tokens FROM byok_chat_usage
       WHERE tenant_id = ? AND provider_id = ? AND date_utc = ?`,
  );

  const getEnvelopeCorrelationStmt = db.prepare(
    `SELECT outcome, envelope_type, recorded_at FROM envelope_correlations
       WHERE run_id = ? AND correlation_id = ?`,
  );
  const putEnvelopeCorrelationStmt = db.prepare(`
    INSERT OR REPLACE INTO envelope_correlations
      (run_id, correlation_id, outcome, envelope_type, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  // ── chat sessions (Phase 2C.1) ─────────────────────────────────────
  const listChatSessionsStmt = db.prepare(`
    SELECT session_id, tenant_id, title, title_source, created_at, updated_at, message_count
    FROM chat_sessions
    WHERE tenant_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const createChatSessionStmt = db.prepare(`
    INSERT INTO chat_sessions (session_id, tenant_id, title, title_source, created_at, updated_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const getChatSessionStmt = db.prepare(`
    SELECT session_id, tenant_id, title, title_source, created_at, updated_at, message_count
    FROM chat_sessions
    WHERE tenant_id = ? AND session_id = ?
  `);
  // Patch-update: COALESCE keeps unchanged columns at their existing value
  // so callers don't have to read-then-write to update just one field.
  const updateChatSessionStmt = db.prepare(`
    UPDATE chat_sessions
       SET title = COALESCE(?, title),
           title_source = COALESCE(?, title_source),
           updated_at = COALESCE(?, updated_at),
           message_count = COALESCE(?, message_count)
     WHERE tenant_id = ? AND session_id = ?
  `);
  // ATC-3/4 — atomic compare-and-set of the title, gated on `title_source` so a
  // concurrent manual rename (which flips `title_source` to 'user') is never clobbered.
  // COALESCE so a fresh session (title_source NULL) matches the 'default' precondition,
  // exactly mirroring the binding's `titleSource ?? 'default'` read semantics.
  const casChatSessionTitleStmt = db.prepare(`
    UPDATE chat_sessions
       SET title = ?, title_source = ?, updated_at = ?
     WHERE tenant_id = ? AND session_id = ? AND COALESCE(title_source, 'default') = ?
  `);
  const deleteChatSessionStmt = db.prepare(`
    DELETE FROM chat_sessions WHERE tenant_id = ? AND session_id = ?
  `);
  const listChatMessagesStmt = db.prepare(`
    SELECT message_id, session_id, role, content, meta, author_subject, created_at
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, message_id ASC
  `);
  const countChatMessagesStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?
  `);
  // Reverse-pagination variants (ADR 0043 Phase 3b): most-recent-first so a
  // bounded page returns the newest messages; the caller reverses to ASC. The
  // row-value comparison `(created_at, message_id) < (?, ?)` pages strictly
  // older than the cursor, deterministic even when timestamps collide.
  const listChatMessagesRecentStmt = db.prepare(`
    SELECT message_id, session_id, role, content, meta, author_subject, created_at
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY created_at DESC, message_id DESC
    LIMIT ?
  `);
  const listChatMessagesBeforeStmt = db.prepare(`
    SELECT message_id, session_id, role, content, meta, author_subject, created_at
    FROM chat_messages
    WHERE session_id = ? AND (created_at, message_id) < (?, ?)
    ORDER BY created_at DESC, message_id DESC
    LIMIT ?
  `);
  const appendChatMessageStmt = db.prepare(`
    INSERT INTO chat_messages (message_id, session_id, role, content, meta, author_subject, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // ADR 0102 Phase 2 — read a single message's author for the edit-authz gate.
  const getChatMessageAuthorStmt = db.prepare(`
    SELECT author_subject FROM chat_messages WHERE session_id = ? AND message_id = ?
  `);
  // ADR 0195 — one full row (role/content/meta) for edit/tombstone semantics.
  const getChatMessageStmt = db.prepare(`
    SELECT message_id, session_id, role, content, meta, author_subject, created_at
      FROM chat_messages WHERE session_id = ? AND message_id = ?
  `);
  // Update an existing message's content/meta in place (ADR 0067 — a run-backed
  // workflow_run message's state grows across its lifecycle and must be re-saved,
  // not re-appended). `created_at` is immutable so the thread order is stable.
  const updateChatMessageStmt = db.prepare(`
    UPDATE chat_messages
       SET content = ?, meta = ?
     WHERE session_id = ? AND message_id = ?
  `);
  // Atomic counter bump — paired with appendChatMessageStmt in a single
  // transaction so concurrent appends don't lose increments. The route
  // previously did read-then-write on `session.messageCount`, which
  // collapsed parallel appends.
  const bumpChatSessionStmt = db.prepare(`
    UPDATE chat_sessions
       SET message_count = message_count + 1,
           updated_at = ?
     WHERE session_id = ?
  `);

  const insertAuditStmt = db.prepare(`
    INSERT INTO audit_log (audit_id, timestamp, principal_id, action, resource, outcome, payload)
    VALUES (@auditId, @timestamp, @principalId, @action, @resource, @outcome, @payload)
  `);

  const getInvocationStmt = db.prepare(`
    SELECT result FROM invocation_log
    WHERE run_id = ? AND node_id = ? AND attempt = ? AND invocation_id = ?
  `);
  // ADR 0549 P3 — the retry-stable read: newest outcome for this logical effect
  // identity regardless of which attempt produced it (RFC 0150 §B).
  const getLatestInvocationStmt = db.prepare(`
    SELECT result FROM invocation_log
    WHERE run_id = ? AND node_id = ? AND invocation_id = ?
    ORDER BY attempt DESC LIMIT 1
  `);
  // ADR 0618 — the Layer-2 atomic claim. ONE statement, so the insert-if-absent
  // and the stale-takeover cannot interleave: better-sqlite3 executes it
  // synchronously on a single connection, and the `WHERE` on the conflict arm is
  // evaluated inside the same statement. `changes > 0` iff THIS caller now holds
  // the claim — either it inserted, or it took over a claim that had gone stale.
  const claimInvocationStmt = db.prepare(`
    INSERT INTO invocation_claim (run_id, node_id, invocation_id, claimed_at)
    VALUES (@runId, @nodeId, @invocationId, @now)
    ON CONFLICT(run_id, node_id, invocation_id) DO UPDATE SET claimed_at = @now
      WHERE invocation_claim.claimed_at < @staleBefore
  `);

  const releaseInvocationClaimStmt = db.prepare(`
    DELETE FROM invocation_claim
    WHERE run_id = @runId AND node_id = @nodeId AND invocation_id = @invocationId
  `);

  const putInvocationStmt = db.prepare(`
    INSERT OR REPLACE INTO invocation_log (run_id, node_id, attempt, invocation_id, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // ADR 0591 — the escape ledger. Note the verb: plain INSERT, never INSERT OR
  // REPLACE. A repeat escape MUST become a second row; silently overwriting is
  // exactly the defect this table replaces.
  const appendEffectEscapeStmt = db.prepare(`
    INSERT INTO effect_escape_ledger
      (run_id, node_id, invocation_id, effect_kind, created_at)
    VALUES (@runId, @nodeId, @invocationId, @effectKind, @createdAt)
  `);
  // RFC 0173 §C.2 — the attempt rows behind GET /runs/{runId}/effects.
  // `result IS NOT NULL` distinguishes a recorded outcome from the
  // `__pending__` placeholder the atomic claim inserts, so an in-flight claim is
  // not reported as a completed effect.
  const listRunEffectsStmt = db.prepare(`
    SELECT node_id AS nodeId, attempt, invocation_id AS invocationId,
           CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END AS completed,
           created_at AS at
      FROM invocation_log
     WHERE run_id = ?
     ORDER BY created_at, node_id, attempt
  `);

  const listEffectEscapesStmt = db.prepare(`
    SELECT invocation_id AS invocationId, node_id AS nodeId, COUNT(*) AS count
      FROM effect_escape_ledger
     WHERE run_id = ?
     GROUP BY invocation_id, node_id
     ORDER BY invocation_id
  `);

  // Atomic claim: lookup, and if absent insert a `__pending__` placeholder
  // so concurrent same-key requests serialize on the sqlite write lock.
  const PENDING_BODY = '__pending__';
  // ── ADR 0551 P1 — durable dispatch outbox ──
  const insertDispatchOutboxStmt = db.prepare(`
    INSERT INTO dispatch_outbox (
      run_id, tenant_id, workflow_id, status, attempts,
      next_attempt_at, claimed_by, claim_expires_at, last_error,
      created_at, updated_at
    ) VALUES (
      @runId, @tenantId, @workflowId, 'pending', 0,
      @nextAttemptAt, NULL, NULL, NULL,
      @createdAt, @createdAt
    )
  `);
  const getDispatchOutboxStmt = db.prepare(`SELECT * FROM dispatch_outbox WHERE run_id = ?`);
  const selectDueDispatchOutboxIdsStmt = db.prepare(`
    SELECT run_id FROM dispatch_outbox
    WHERE status = 'pending'
      AND next_attempt_at <= @now
      AND (claim_expires_at IS NULL OR claim_expires_at < @now)
    ORDER BY next_attempt_at ASC
    LIMIT @limit
  `);
  const claimDispatchOutboxStmt = db.prepare(`
    UPDATE dispatch_outbox
    SET claimed_by = @workerId, claim_expires_at = @claimExpiresAt, updated_at = @updatedAt
    WHERE run_id = @runId
  `);
  const deleteDispatchOutboxStmt = db.prepare(`DELETE FROM dispatch_outbox WHERE run_id = ?`);
  // ── ADR 0551 P2 — operator projection + redrive ──
  // Aggregates over the WHOLE table, never over a capped listing: a count taken
  // from a page under-reports exactly when the backlog is deep enough to matter.
  const dispatchOutboxCountsStmt = db.prepare(`
    SELECT status, COUNT(*) AS n FROM dispatch_outbox GROUP BY status
  `);
  const dispatchOutboxOldestPendingStmt = db.prepare(`
    SELECT MIN(created_at) AS oldest FROM dispatch_outbox WHERE status = 'pending'
  `);
  const listDispatchOutboxStmt = db.prepare(`
    SELECT * FROM dispatch_outbox WHERE status = @status
    ORDER BY created_at DESC LIMIT @limit
  `);
  // The CAS. `status = 'dead'` is in the WHERE of the statement that writes, so
  // two concurrent redrives of one row cannot both succeed — `changes` is 1 for
  // exactly one of them. Attempts reset to 0 because a redrive is an operator
  // saying "try again", and re-queueing a row with its budget already spent
  // would have it die on the next claim.
  const redriveDispatchOutboxStmt = db.prepare(`
    UPDATE dispatch_outbox
    SET status = 'pending',
        attempts = 0,
        next_attempt_at = @nextAttemptAt,
        last_error = @reason,
        claimed_by = NULL,
        claim_expires_at = NULL,
        updated_at = @updatedAt
    WHERE run_id = @runId AND status = 'dead'
  `);
  const rescheduleDispatchOutboxStmt = db.prepare(`
    UPDATE dispatch_outbox
    SET attempts = attempts + 1,
        status = @status,
        next_attempt_at = @nextAttemptAt,
        last_error = @error,
        claimed_by = NULL,
        claim_expires_at = NULL,
        updated_at = @updatedAt
    WHERE run_id = @runId
  `);

  // The atomic half of the outbox pattern: the run row and its dispatch intent
  // land in ONE better-sqlite3 write transaction, so there is no instant at
  // which a reader can see an accepted run with no intent to start it. This is
  // the whole reason the outbox is in `Storage` and not in a route.
  //
  // ADR 0549 H56 extends the same transaction to the HTTP idempotency ledger:
  // when `idemParams` is present the claim is committed `completed` here, so the
  // run row and "the ledger says this run exists" are one fact. The commit is
  // the compare-and-set `completeIdemResponseStmt`; `changes === 0` means the
  // caller's token no longer holds the row (reclaimed) and the THROW rolls the
  // run + outbox rows back with it — better-sqlite3 rolls back a transaction
  // whose function throws.
  const insertRunWithOutboxTxn = db.transaction(
    (
      runParams: Record<string, unknown>,
      outboxParams: Record<string, unknown> | null,
      idemParams: (Record<string, unknown> & { key: string }) | null,
    ): void => {
      insertRunStmt.run(runParams);
      if (outboxParams) insertDispatchOutboxStmt.run(outboxParams);
      if (idemParams) {
        const res = completeIdemResponseStmt.run(idemParams);
        if (res.changes === 0) throw new IdempotentCommitRejectedError(idemParams.key);
      }
    },
  );

  // Atomic outbox claim — same shape as claimDueWebhookDeliveriesTxn: SELECT
  // due ids, stamp the lease, re-SELECT. better-sqlite3 serializes write txns
  // process-wide, so a second claimer's due-scan cannot see rows the first just
  // leased.
  const claimDispatchOutboxTxn = db.transaction(
    (workerId: string, nowMs: number, leaseMs: number, limit: number): DispatchOutboxRecord[] => {
      const idRows = selectDueDispatchOutboxIdsStmt.all({ now: nowMs, limit }) as Array<{ run_id: string }>;
      const claimExpiresAt = nowMs + leaseMs;
      const updatedAt = new Date(nowMs).toISOString();
      const claimed: DispatchOutboxRecord[] = [];
      for (const { run_id } of idRows) {
        claimDispatchOutboxStmt.run({ runId: run_id, workerId, claimExpiresAt, updatedAt });
        const row = getDispatchOutboxStmt.get(run_id);
        if (row) claimed.push(rowToDispatchOutbox(row));
      }
      return claimed;
    },
  );

  const claimIdempotencyTxn = db.transaction(
    (key: string, createdAt: string): { claimed: boolean; existing: IdempotencyRecord | null } => {
      const existing = getIdempotencyStmt.get(key) as
        | { key: string; response_body: string; response_status: number; created_at: string }
        | undefined;
      if (existing) {
        return {
          claimed: false,
          existing: {
            key: existing.key,
            responseBody: existing.response_body,
            responseStatus: existing.response_status,
            createdAt: existing.created_at,
          },
        };
      }
      upsertIdempotencyStmt.run({
        key,
        responseBody: PENDING_BODY,
        responseStatus: 0,
        createdAt,
      });
      return { claimed: true, existing: null };
    },
  );

  /**
   * ADR 0551 P0 — the workspace If-Match compare-and-set, inside ONE txn.
   *
   * Read-then-write across two statements would let another writer land in
   * between, which is exactly the defect the module-`Map` version had in a
   * distributed form: its CAS was instance-local, so two Cloud Run instances
   * could each conclude they had won. better-sqlite3 serializes write
   * transactions process-wide, and the owner triple is the primary key, so the
   * SELECT and the UPSERT are atomic against a concurrent write to the same
   * file.
   */
  const putWorkspaceFileTxn = db.transaction(
    (input: {
      tenantId: string; workspaceId: string; path: string; content: string;
      contentType: string; etagFor: (v: number, c: string) => string;
      ifMatch?: string; updatedAt: string;
    }): { ok: true; row: WorkspaceFileRow } | { ok: false; currentVersion: number } => {
      const existing = db
        .prepare(`SELECT version, etag FROM workspace_files WHERE tenant_id = ? AND workspace_id = ? AND path = ?`)
        .get(input.tenantId, input.workspaceId, input.path) as { version: number; etag: string } | undefined;
      // A supplied If-Match MUST equal the current etag. Absent row + supplied
      // If-Match is also a conflict: the caller believes a version exists.
      if (input.ifMatch !== undefined && (existing === undefined || existing.etag !== input.ifMatch)) {
        return { ok: false, currentVersion: existing?.version ?? 0 };
      }
      const version = (existing?.version ?? 0) + 1;
      const etag = input.etagFor(version, input.content);
      const sizeBytes = Buffer.byteLength(input.content, 'utf8');
      db.prepare(
        `INSERT INTO workspace_files
           (tenant_id, workspace_id, path, content, content_type, version, etag, size_bytes, updated_at)
         VALUES (@tenantId, @workspaceId, @path, @content, @contentType, @version, @etag, @sizeBytes, @updatedAt)
         ON CONFLICT(tenant_id, workspace_id, path) DO UPDATE SET
           content = excluded.content, content_type = excluded.content_type,
           version = excluded.version, etag = excluded.etag,
           size_bytes = excluded.size_bytes, updated_at = excluded.updated_at`,
      ).run({ ...input, version, etag, sizeBytes });
      return {
        ok: true,
        row: {
          path: input.path, content: input.content, contentType: input.contentType,
          version, etag, sizeBytes, updatedAt: input.updatedAt,
        },
      };
    },
  );

  /**
   * ADR 0549 — decide the claim outcome INSIDE the transaction.
   *
   * The route must not read the row and then decide, or two concurrent callers
   * both observing "no row" would both proceed. better-sqlite3 serializes write
   * transactions process-wide, so the SELECT-then-INSERT pair is atomic against
   * another claim for the same composite key.
   *
   * Digest comparison comes FIRST, before the state check: a caller who reused
   * a key with a different body has broken the contract regardless of whether
   * the original is still in flight, and telling them "in flight, retry" would
   * send them into a retry loop that can never succeed.
   */
  const claimIdempotentResponseTxn = db.transaction(
    (input: {
      tenantId: string;
      endpoint: string;
      key: string;
      requestDigest: string;
      createdAt: string;
      leaseMs: number;
    }): IdempotentClaim => {
      const existing = getIdemResponseStmt.get(input) as
        | {
            request_digest: string;
            state: string;
            response_status: number | null;
            response_body: string | null;
            claim_token: string | null;
            claim_expires_at: string | null;
          }
        | undefined;
      const claimExpiresAt = new Date(Date.parse(input.createdAt) + input.leaseMs).toISOString();
      if (!existing) {
        const claimToken = randomUUID();
        insertIdemResponseStmt.run({ ...input, claimToken, claimExpiresAt });
        return { outcome: 'claimed', claimToken };
      }
      if (existing.request_digest !== input.requestDigest) return { outcome: 'mismatch' };
      if (existing.state === 'completed') {
        return {
          outcome: 'replay',
          responseStatus: existing.response_status ?? 200,
          responseBody: existing.response_body ?? '',
        };
      }
      // Pending. Expired ⇒ the holder is DEAD (a live one cannot outlive the
      // lease, which is derived from the request timeout), so reclaim it.
      const expired = existing.claim_expires_at !== null && existing.claim_expires_at < input.createdAt;
      if (expired) {
        const claimToken = randomUUID();
        const res = reclaimIdemResponseStmt.run({
          tenantId: input.tenantId,
          endpoint: input.endpoint,
          key: input.key,
          claimToken,
          claimExpiresAt,
          now: input.createdAt,
          prevToken: existing.claim_token,
        });
        // `reclaimed` distinguishes THIS branch from a first claim for ADR 0556
        // P1's recovery signal. The CAS above is what makes it true rather than
        // hopeful: `changes > 0` means we replaced the dead holder's token.
        if (res.changes > 0) return { outcome: 'claimed', claimToken, reclaimed: true };
      }
      return { outcome: 'in-flight' };
    },
  );

  // Atomic append: read max sequence + insert in a single txn.
  // RFC 0194 §A — the closed-log rule, enforced in the same transaction as
  // the append (parity with Postgres; see storage/runLogClosure.ts).
  const terminalEventStmt = db.prepare(
    `SELECT type FROM events WHERE run_id = ? AND type IN (${TERMINAL_RUN_EVENT_TYPES.map(() => '?').join(',')}) LIMIT 1`,
  );
  const appendEventTxn = db.transaction((input: Omit<EventRecord, 'sequence'>): EventRecord => {
    if (isForwardExecutionEvent(input.type)) {
      const closed = terminalEventStmt.get(input.runId, ...TERMINAL_RUN_EVENT_TYPES) as { type: string } | undefined;
      if (closed) throw new RunLogClosedError(input.runId, input.type, closed.type);
    }
    const row = getMaxSeqStmt.get(input.runId) as { max: number };
    const sequence = row.max + 1;
    appendEventStmt.run({
      ...input,
      sequence,
      payload: JSON.stringify(input.payload ?? null),
      nodeId: input.nodeId ?? null,
      causationId: input.causationId ?? null,
    });
    return { ...input, sequence };
  });

  function rowToRun(row: any): RunRecord {
    return {
      runId: row.run_id,
      workflowId: row.workflow_id,
      tenantId: row.tenant_id,
      scopeId: row.scope_id ?? undefined,
      status: row.status,
      inputs: row.inputs ? JSON.parse(row.inputs) : null,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      configurable: row.configurable ? JSON.parse(row.configurable) : {},
      callbackUrl: row.callback_url ?? undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
      parentRunId: row.parent_run_id ?? undefined,
      parentSeq: row.parent_seq ?? undefined,
      forkMode: row.fork_mode ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      removalAt: row.removal_at ?? undefined,
      currentNodeId: row.current_node_id ?? undefined,
      // Per-run scheduler snapshot for DAG-aware resume — see schema
      // migration v17. Stored as opaque text (JSON-encoded
      // `SerializedSnapshot` from executor.ts) and surfaced raw so
      // the resume path can JSON.parse it without round-tripping
      // through a typed shape.
      schedulerSnapshot: (row.scheduler_snapshot as string | null) ?? undefined,
      // Multi-instance run-dispatch lease (schema migration v20). Both
      // columns are nullable; `dispatch_lease_expires_at` is epoch-ms.
      dispatchOwner: row.dispatch_owner ?? null,
      dispatchLeaseExpiresAt: row.dispatch_lease_expires_at == null ? null : Number(row.dispatch_lease_expires_at),
      // v2 charter P4-C — the era key. `undefined` (not `2`) for a pre-cut row:
      // the ABSENCE is the datum, and `eraOf()` is the single place that turns
      // it into `2`. Materialising a `2` here would make a historical row
      // indistinguishable from one this host deliberately stamped.
      eventLogSchemaVersion: row.event_log_schema_version ?? undefined,
      ...(row.error_code
        ? { error: { code: row.error_code, message: row.error_message ?? '' } }
        : {}),
    };
  }

  function rowToEvent(row: any): EventRecord {
    return {
      eventId: row.event_id,
      runId: row.run_id,
      sequence: row.sequence,
      type: row.type,
      nodeId: row.node_id ?? undefined,
      payload: row.payload ? JSON.parse(row.payload) : null,
      timestamp: row.timestamp,
      causationId: row.causation_id ?? undefined,
    };
  }

  function rowToInterrupt(row: any): InterruptRecord {
    return {
      interruptId: row.interrupt_id,
      runId: row.run_id,
      nodeId: row.node_id,
      kind: row.kind,
      token: row.token,
      data: row.data ? JSON.parse(row.data) : null,
      resumeSchema: row.resume_schema ? JSON.parse(row.resume_schema) : undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedValue: row.resolved_value ? JSON.parse(row.resolved_value) : undefined,
    };
  }

  function rowToWebhook(row: any): WebhookSubscriptionRecord {
    return {
      subscriptionId: row.subscription_id,
      // Pre-migration rows carry NULL; they belong to the default tenant.
      tenantId: row.tenant_id ?? 'default',
      url: row.url,
      events: row.events ? JSON.parse(row.events) : [],
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      secret: row.secret,
      createdAt: row.created_at,
      // Pre-migration + v1 rows carry NULL, which MEANS major 1 (see the field
      // doc on WebhookSubscriptionRecord): absent must keep bare ids.
      ...(row.protocol_major === 2 ? { protocolMajor: 2 as const } : {}),
      // ADR 0747 — NULL means a non-opted (`["v1"]`) subscription.
      ...(row.signature_algorithms ? { signatureAlgorithms: JSON.parse(row.signature_algorithms) as string[] } : {}),
      ...(typeof row.previous_secret === 'string' ? { previousSecret: row.previous_secret } : {}),
      ...(row.previous_secret_expires_at != null ? { previousSecretExpiresAt: Number(row.previous_secret_expires_at) } : {}),
      ...(row.rotated_at != null ? { rotatedAt: Number(row.rotated_at) } : {}),
    };
  }

  function rowToWebhookDelivery(row: any): WebhookDeliveryRecord {
    return {
      deliveryId: row.delivery_id,
      subscriptionId: row.subscription_id,
      wireSubscriptionId: row.wire_subscription_id ?? null,
      tenantId: row.tenant_id ?? null,
      url: row.url,
      secret: row.secret,
      eventType: row.event_type,
      payload: row.payload,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      nextAttemptAt: row.next_attempt_at,
      claimedBy: row.claimed_by ?? null,
      claimExpiresAt: row.claim_expires_at ?? null,
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToDispatchOutbox(row: any): DispatchOutboxRecord {
    return {
      runId: row.run_id,
      tenantId: row.tenant_id,
      workflowId: row.workflow_id,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      claimedBy: row.claimed_by ?? null,
      claimExpiresAt: row.claim_expires_at ?? null,
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToUserAgent(row: any): UserAgentRecord {
    return {
      agentId: row.agent_id,
      tenantId: row.tenant_id,
      persona: row.persona,
      label: row.label ?? undefined,
      description: row.description ?? undefined,
      modelClass: row.model_class,
      systemPrompt: row.system_prompt,
      toolAllowlist: row.tool_allowlist ? JSON.parse(row.tool_allowlist) : [],
      memoryShape: {
        scratchpad: row.memory_scratchpad === 1,
        conversation: row.memory_conversation === 1,
        longTerm: row.memory_long_term === 1,
      },
      confidenceThreshold: row.confidence_threshold ?? undefined,
      createdAt: row.created_at,
    };
  }

  return {
    async insertRun(run, opts) {
      const runParams = {
        runId: run.runId,
        workflowId: run.workflowId,
        tenantId: run.tenantId,
        scopeId: run.scopeId ?? null,
        status: run.status,
        inputs: JSON.stringify(run.inputs ?? null),
        metadata: JSON.stringify(run.metadata ?? {}),
        configurable: JSON.stringify(run.configurable ?? {}),
        callbackUrl: run.callbackUrl ?? null,
        idempotencyKey: run.idempotencyKey ?? null,
        parentRunId: run.parentRunId ?? null,
        parentSeq: run.parentSeq ?? null,
        forkMode: run.forkMode ?? null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt ?? null,
        errorCode: run.error?.code ?? null,
        errorMessage: run.error?.message ?? null,
        currentNodeId: run.currentNodeId ?? null,
        schedulerSnapshot: run.schedulerSnapshot ?? null,
        // v2 charter P4-C — the era key (schema mig 44). NULL is the v1 era and
        // is never written on purpose here: the storage seat stamps every run
        // this host creates, so a NULL landing in this column means the row came
        // from a path that bypassed `openStorage()`.
        eventLogSchemaVersion: run.eventLogSchemaVersion ?? null,
      };
      // ADR 0551 P1 — one transaction when a dispatch intent rides along, so
      // the run and the intent are visible together or not at all.
      // ADR 0549 H56 — and the HTTP idempotency commit rides in the SAME
      // transaction when present (see `InsertRunOptions.idempotencyCommit`).
      if (opts?.dispatchOutbox || opts?.idempotencyCommit) {
        insertRunWithOutboxTxn(
          runParams,
          opts.dispatchOutbox
            ? {
                runId: run.runId,
                tenantId: run.tenantId,
                workflowId: run.workflowId,
                nextAttemptAt: opts.dispatchOutbox.nextAttemptAt,
                createdAt: run.createdAt,
              }
            : null,
          opts.idempotencyCommit
            ? {
                tenantId: opts.idempotencyCommit.tenantId,
                endpoint: opts.idempotencyCommit.endpoint,
                key: opts.idempotencyCommit.key,
                responseStatus: opts.idempotencyCommit.responseStatus,
                responseBody: opts.idempotencyCommit.responseBody,
                runId: run.runId,
                updatedAt: opts.idempotencyCommit.updatedAt,
                claimToken: opts.idempotencyCommit.claimToken,
              }
            : null,
        );
        return;
      }
      insertRunStmt.run(runParams);
    },

    async getRun(runId) {
      const row = getRunStmt.get(runId);
      return row ? rowToRun(row) : null;
    },

    async updateRun(runId, rawPatch) {
      const patch = withRemovalStamp(rawPatch);
      const existing = await this.getRun(runId);
      if (!existing) return;
      const merged: RunRecord = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      // COLUMN-SCOPED write: only the fields present in `patch` (plus
      // updated_at) are SET. The previous full-row rewrite meant two
      // concurrent updateRun callers clobbered each other's DISJOINT fields —
      // e.g. a parallel node's `{currentNodeId}` write racing the ADR 0024
      // Phase D `metadata.connectionUse[]` stamp silently reverted the
      // metadata it had read before the stamp landed.
      const has = (k: keyof RunRecord): boolean => Object.prototype.hasOwnProperty.call(patch, k);
      const sets: string[] = ['updated_at = @updatedAt'];
      const params: Record<string, unknown> = { runId, updatedAt: merged.updatedAt };
      if (has('status')) {
        sets.push('status = @status');
        params.status = merged.status;
      }
      if (has('inputs')) {
        sets.push('inputs = @inputs');
        params.inputs = JSON.stringify(merged.inputs ?? null);
      }
      if (has('metadata')) {
        sets.push('metadata = @metadata');
        params.metadata = JSON.stringify(merged.metadata ?? {});
      }
      if (has('configurable')) {
        sets.push('configurable = @configurable');
        params.configurable = JSON.stringify(merged.configurable ?? {});
      }
      if (has('callbackUrl')) {
        sets.push('callback_url = @callbackUrl');
        params.callbackUrl = merged.callbackUrl ?? null;
      }
      if (has('completedAt')) {
        sets.push('completed_at = @completedAt');
        params.completedAt = merged.completedAt ?? null;
      }
      if (has('removalAt')) {
        sets.push('removal_at = @removalAt');
        params.removalAt = merged.removalAt ?? null;
      }
      if (has('error')) {
        sets.push('error_code = @errorCode', 'error_message = @errorMessage');
        params.errorCode = merged.error?.code ?? null;
        params.errorMessage = merged.error?.message ?? null;
      }
      if (has('currentNodeId')) {
        sets.push('current_node_id = @currentNodeId');
        params.currentNodeId = merged.currentNodeId ?? null;
      }
      if (has('schedulerSnapshot')) {
        sets.push('scheduler_snapshot = @schedulerSnapshot');
        params.schedulerSnapshot = merged.schedulerSnapshot ?? null;
      }
      db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = @runId`).run(params);
    },

    async mergeRunMetadata(runId, patch, opts) {
      // ONE atomic statement (better-sqlite3 is synchronous, single-writer) —
      // no read-modify-write window (grade-code H2). `json_patch` is RFC 7396:
      // top-level keys merge; a `null` value DELETES the key (the pg adapter
      // mirrors this with `|| sets - removals`).
      const res = db.prepare(
        `UPDATE runs
            SET metadata = json_patch(COALESCE(metadata, '{}'), @patch),
                updated_at = @updatedAt
          WHERE run_id = @runId
            AND (@absentKey IS NULL OR json_extract(COALESCE(metadata, '{}'), '$.' || @absentKey) IS NULL)`,
      ).run({
        runId,
        patch: JSON.stringify(patch),
        updatedAt: new Date().toISOString(),
        absentKey: opts?.ifAbsentKey ?? null,
      });
      return res.changes > 0;
    },

    async listRuns({ tenantId, workflowId, status, limit = 100, before }) {
      const rows = listRunsStmt.all({
        tenantId: tenantId ?? null,
        status: status ?? null,
        workflowId: workflowId ?? null,
        limit,
        beforeCreatedAt: before?.createdAt ?? null,
        beforeRunId: before?.runId ?? null,
      });
      return rows.map(rowToRun);
    },

    async listTenantActivity(tenantPrefix, limit) {
      // ADR 0372 — mirrors postgres; sqlite stores metadata as JSON TEXT, so
      // json_extract(...,'$.schedule') IS NULL = human/API-initiated.
      const esc = tenantPrefix.replace(/[\\%_]/g, (m) => `\\${m}`);
      const rows = db.prepare(
        `SELECT r.tenant_id AS tenantId,
                min(r.created_at) AS firstRunAt,
                max(CASE WHEN json_extract(r.metadata, '$.schedule') IS NULL THEN r.created_at END) AS lastHumanRunAt,
                (SELECT max(c.updated_at) FROM chat_sessions c WHERE c.tenant_id = r.tenant_id) AS lastChatAt
         FROM runs r
         WHERE r.tenant_id LIKE ? ESCAPE '\\'
         GROUP BY r.tenant_id
         ORDER BY r.tenant_id
         LIMIT ?`,
      ).all(`${esc}%`, limit) as Array<{ tenantId: string; firstRunAt: string | null; lastHumanRunAt: string | null; lastChatAt: string | null }>;
      return rows.map((x) => ({ tenantId: x.tenantId, firstRunAt: x.firstRunAt ?? null, lastHumanRunAt: x.lastHumanRunAt ?? null, lastChatAt: x.lastChatAt ?? null }));
    },

    async listHostExtTenantActivity(tenantPrefix, limit) {
      // Grade-pass DATA-1 (review H1) — mirrors postgres byte-for-byte in
      // SEMANTICS: SQL prefilters (`k LIKE 'hostext:%'` = the purgeable
      // keyspace, on the indexed column; value LIKE narrows), the shared TS
      // aggregator is the authority (top-level tenantId, malformed skipped).
      const esc = tenantPrefix.replace(/[\\%_]/g, (m) => `\\${m}`);
      const rows = db.prepare(
        `SELECT v, updated_at AS updatedAt FROM host_ext_kv
         WHERE k LIKE 'hostext:%' AND v LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC
         LIMIT ?`,
      ).all(`%"tenantId":"${esc}%`, HOSTEXT_ACTIVITY_ROW_CAP) as Array<{ v: string; updatedAt: string }>;
      const agg = aggregateHostExtTenantActivity(rows, tenantPrefix, limit);
      if (agg.length === 0) return [];
      const chats = db.prepare(
        `SELECT tenant_id AS tenantId, max(updated_at) AS last FROM chat_sessions
         WHERE tenant_id IN (${agg.map(() => '?').join(',')}) GROUP BY tenant_id`,
      ).all(...agg.map((a) => a.tenantId)) as Array<{ tenantId: string; last: string | null }>;
      const chatBy = new Map(chats.map((c) => [c.tenantId, c.last]));
      return agg.map((a) => ({ ...a, lastChatAt: chatBy.get(a.tenantId) ?? null }));
    },

    async listRunsByParent(parentRunId) {
      return listRunsByParentStmt.all(parentRunId).map(rowToRun);
    },

    async listRunsPastRemoval(now, limit) {
      return db.prepare(`SELECT * FROM runs WHERE removal_at IS NOT NULL AND removal_at < ? ORDER BY removal_at ASC LIMIT ?`)
        .all(now, limit).map(rowToRun);
    },

    async clearRunRemoval(runId) {
      db.prepare(`UPDATE runs SET removal_at = NULL WHERE run_id = ?`).run(runId);
    },

    async hasRunForWorkflow(workflowId, filter) {
      const row = filter?.status
        ? db.prepare(`SELECT 1 AS one FROM runs WHERE workflow_id = ? AND status = ? LIMIT 1`).get(workflowId, filter.status)
        : db.prepare(`SELECT 1 AS one FROM runs WHERE workflow_id = ? LIMIT 1`).get(workflowId);
      return row !== undefined;
    },

    async setRunDispatchLease(runId, owner, leaseExpiresAt) {
      // Best-effort: a missing run row is a no-op (zero rows updated).
      setRunDispatchLeaseStmt.run({ runId, owner: owner ?? null, lease: leaseExpiresAt ?? null });
    },

    async claimRunExecution(runId, owner, nowMs, leaseExpiresAt) {
      const res = claimRunExecutionStmt.run({ runId, owner, nowMs, lease: leaseExpiresAt });
      if (res.changes > 0) return 'claimed';
      // Zero rows: classify WHY, because the three reasons demand different
      // things of the caller (abandon / refuse / proceed).
      const row = runStatusForClaimStmt.get(runId) as { status?: string } | undefined;
      if (!row) return 'missing';
      return (RUN_FINAL_STATUSES as readonly string[]).includes(row.status ?? '') ? 'not-runnable' : 'held';
    },

    async renewRunDispatchLeaseIfOwner(runId, owner, leaseExpiresAt) {
      // `changes` is 0 when the run is gone OR when `dispatch_owner` moved on.
      // The caller cannot distinguish those and must not try to: both mean
      // "this instance no longer owns this run", which is the only question.
      const res = renewRunDispatchLeaseIfOwnerStmt.run({ runId, owner, lease: leaseExpiresAt });
      return res.changes > 0;
    },

    async claimOrphanedRuns(workerId, nowMs, staleBeforeIso, leaseMs, limit) {
      return claimOrphanedRunsTxn(workerId, nowMs, staleBeforeIso, leaseMs, limit);
    },

    async claimDispatchOutbox(workerId, nowMs, leaseMs, limit) {
      return claimDispatchOutboxTxn(workerId, nowMs, leaseMs, limit);
    },

    async getDispatchOutbox(runId) {
      const row = getDispatchOutboxStmt.get(runId);
      return row ? rowToDispatchOutbox(row) : null;
    },

    async completeDispatchOutbox(runId) {
      deleteDispatchOutboxStmt.run(runId);
    },

    async rescheduleDispatchOutbox(runId, nextAttemptAt, dead, error) {
      rescheduleDispatchOutboxStmt.run({
        runId,
        status: dead ? 'dead' : 'pending',
        nextAttemptAt,
        error,
        updatedAt: new Date().toISOString(),
      });
    },

    async dispatchOutboxStats() {
      const counts = dispatchOutboxCountsStmt.all() as Array<{ status: string; n: number }>;
      const oldest = dispatchOutboxOldestPendingStmt.get() as { oldest: string | null } | undefined;
      return {
        pending: counts.find((c) => c.status === 'pending')?.n ?? 0,
        dead: counts.find((c) => c.status === 'dead')?.n ?? 0,
        oldestPendingCreatedAt: oldest?.oldest ?? null,
      };
    },

    async listDispatchOutbox({ status, limit }) {
      const rows = listDispatchOutboxStmt.all({ status, limit }) as unknown[];
      return rows.map(rowToDispatchOutbox);
    },

    async redriveDispatchOutbox(runId, nextAttemptAt, reason) {
      const result = redriveDispatchOutboxStmt.run({
        runId,
        nextAttemptAt,
        reason,
        updatedAt: new Date().toISOString(),
      });
      return result.changes > 0;
    },

    async appendEvent(input) {
      const eventId = input.eventId || randomUUID();
      const result = appendEventTxn({ ...input, eventId });
      return result;
    },

    async appendEventsBatch(inputs) {
      if (inputs.length === 0) return [];
      // better-sqlite3 is synchronous + in-process, so one transaction IS the
      // batch — each insert sees prior inserts, so MAX(sequence)+1 stays correct
      // per run. Byte-identical to N appendEvent calls.
      const runBatch = db.transaction((events: readonly Omit<EventRecord, 'sequence'>[]): EventRecord[] =>
        events.map((e) => appendEventTxn({ ...e, eventId: e.eventId || randomUUID() })),
      );
      return runBatch(inputs);
    },

    // The cursor is EXCLUSIVE (`sequence > fromSeq`), so with 0-based numbering the
    // "give me everything" cursor is -1; a default of 0 silently dropped event 0.
    async listEvents(runId, { fromSeq = -1, limit = 1000 } = {}) {
      const rows = listEventsStmt.all({ runId, fromSeq, limit });
      return rows.map(rowToEvent);
    },

    async findFirstEventByPayload(runId, type, payloadKey, payloadValue) {
      if (!PAYLOAD_KEY_RE.test(payloadKey)) throw new Error(`findFirstEventByPayload: invalid payload key ${payloadKey}`);
      const row = findFirstEventByPayloadStmt.get({ runId, type, path: `$.${payloadKey}`, value: payloadValue });
      return row ? rowToEvent(row as Parameters<typeof rowToEvent>[0]) : null;
    },

    async getMaxSequence(runId) {
      const row = getMaxSeqStmt.get(runId) as { max: number };
      return row.max;
    },

    async insertInterrupt(record) {
      insertInterruptStmt.run({
        ...record,
        data: JSON.stringify(record.data ?? null),
        resumeSchema: record.resumeSchema ? JSON.stringify(record.resumeSchema) : null,
        expiresAt: record.expiresAt ?? null,
      });
    },

    async getInterrupt(interruptId) {
      const row = getInterruptStmt.get(interruptId);
      return row ? rowToInterrupt(row) : null;
    },

    async getInterruptByToken(token) {
      const row = getInterruptByTokenStmt.get(token);
      return row ? rowToInterrupt(row) : null;
    },

    async getInterruptByNode(runId, nodeId) {
      const row = getInterruptByNodeStmt.get(runId, nodeId);
      return row ? rowToInterrupt(row) : null;
    },

    async resolveInterrupt(interruptId, resolvedValue, resolvedAt) {
      // CONDITIONAL on resolved_at IS NULL — info.changes is 1 iff this call
      // won the resolve, 0 if it was already resolved (ENG-6).
      const info = resolveInterruptStmt.run(resolvedAt, JSON.stringify(resolvedValue ?? null), interruptId);
      return info.changes > 0;
    },

    async listOpenInterrupts(runId) {
      const rows = listOpenInterruptsStmt.all(runId);
      return rows.map(rowToInterrupt);
    },

    async listOpenInterruptsAll(limit) {
      const rows = listOpenInterruptsAllStmt.all(limit);
      return rows.map(rowToInterrupt);
    },

    async insertWebhook(record) {
      insertWebhookStmt.run({
        subscriptionId: record.subscriptionId,
        tenantId: record.tenantId,
        url: record.url,
        events: JSON.stringify(record.events),
        tags: record.tags ? JSON.stringify(record.tags) : null,
        secret: record.secret,
        createdAt: record.createdAt,
        // NULL for a v1 registration — `rowToWebhook` reads NULL as major 1, so
        // an unstamped row keeps the bare-id delivery it has always had.
        protocolMajor: record.protocolMajor ?? null,
        signatureAlgorithms: record.signatureAlgorithms ? JSON.stringify(record.signatureAlgorithms) : null,
      });
    },

    async rotateWebhookSecret(subscriptionId, rotation) {
      const r = rotateWebhookSecretStmt.run({ subscriptionId, ...rotation });
      return r.changes > 0;
    },

    async retireExpiredWebhookSecrets(now) {
      const r = db.prepare(
        `UPDATE webhooks SET previous_secret = NULL
          WHERE previous_secret IS NOT NULL AND previous_secret_expires_at <= ?`,
      ).run(now);
      return Number(r.changes ?? 0);
    },

    async blankTerminalDeliverySecrets(limit) {
      const r = db.prepare(
        `UPDATE webhook_deliveries SET secret = ''
          WHERE delivery_id IN (
            SELECT delivery_id FROM webhook_deliveries
             WHERE status IN ('delivered','dead') AND secret <> '' LIMIT ?)`,
      ).run(limit);
      return Number(r.changes ?? 0);
    },

    async getWebhook(subscriptionId) {
      const row = getWebhookStmt.get(subscriptionId);
      return row ? rowToWebhook(row) : null;
    },

    async deleteWebhook(subscriptionId) {
      deleteWebhookTxn(subscriptionId);
    },

    async listWebhooks({ eventType, tags, tenantId }) {
      const rows = listWebhooksStmt.all().map(rowToWebhook);
      return rows.filter((sub) => {
        // RFC 0093 §A.3 — tenant scope is exact-match; cross-tenant
        // subscriptions never match regardless of filter breadth.
        if (tenantId !== undefined && sub.tenantId !== tenantId) return false;
        if (eventType && !sub.events.includes(eventType) && !sub.events.includes('*')) {
          return false;
        }
        const subTags = sub.tags;
        if (tags && tags.length > 0 && subTags && subTags.length > 0) {
          const hasTag = tags.some((t) => subTags.includes(t));
          if (!hasTag) return false;
        }
        return true;
      });
    },

    async enqueueWebhookDelivery(record, opts) {
      const stmt = opts?.requireSubscription ? enqueueWebhookDeliveryIfSubscribedStmt : enqueueWebhookDeliveryStmt;
      const res = stmt.run({
        deliveryId: record.deliveryId,
        subscriptionId: record.subscriptionId,
        wireSubscriptionId: record.wireSubscriptionId ?? null,
        tenantId: record.tenantId ?? null,
        url: record.url,
        secret: record.secret,
        eventType: record.eventType,
        payload: record.payload,
        status: record.status,
        attempts: record.attempts,
        maxAttempts: record.maxAttempts,
        nextAttemptAt: record.nextAttemptAt,
        claimedBy: record.claimedBy ?? null,
        claimExpiresAt: record.claimExpiresAt ?? null,
        lastError: record.lastError ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      return res.changes > 0;
    },

    async claimDueWebhookDeliveries(workerId, now, leaseMs, limit, opts) {
      return claimDueWebhookDeliveriesTxn(workerId, now, leaseMs, limit, opts);
    },

    async markWebhookDeliveryDelivered(deliveryId, now) {
      markWebhookDeliveryDeliveredStmt.run({ deliveryId, now });
    },

    async rescheduleWebhookDelivery(deliveryId, now, nextAttemptAt, dead, error) {
      rescheduleWebhookDeliveryStmt.run({
        deliveryId,
        now,
        nextAttemptAt,
        status: dead ? 'dead' : 'pending',
        error,
      });
    },

    async listWebhookDeliveries({ subscriptionIds, status, limit = 200 }) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (subscriptionIds !== undefined) {
        if (subscriptionIds.length === 0) return [];
        clauses.push(`subscription_id IN (${subscriptionIds.map(() => '?').join(',')})`);
        params.push(...subscriptionIds);
      }
      if (status) { clauses.push('status = ?'); params.push(status); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM webhook_deliveries ${where} ORDER BY next_attempt_at DESC LIMIT ?`,
      ).all(...params, limit);
      return rows.map(rowToWebhookDelivery);
    },

    async retryWebhookDelivery(deliveryId, now) {
      // GRADE-CODE 2026-07-17 — never re-arm a row a worker is CURRENTLY
      // delivering (live lease): that would double-deliver and restart the
      // backoff ladder on a healthy in-flight row. Dead rows always re-arm.
      const res = db.prepare(
        `UPDATE webhook_deliveries
         SET status = 'pending', attempts = 0, next_attempt_at = @now,
             claimed_by = NULL, claim_expires_at = NULL, updated_at = @now
         WHERE delivery_id = @deliveryId AND status != 'delivered'
           AND (status = 'dead' OR claim_expires_at IS NULL OR claim_expires_at < @now)`,
      ).run({ deliveryId, now });
      return res.changes > 0;
    },

    async claimOnce(key, createdAt) {
      // Single sqlite txn: SELECT then INSERT under exclusive write lock.
      // better-sqlite3 serializes write txns process-wide, so two concurrent
      // claims for the same key see consistent state.
      return claimIdempotencyTxn(key, createdAt);
    },
    async putOnce(record) {
      upsertIdempotencyStmt.run({
        key: record.key,
        responseBody: record.responseBody,
        responseStatus: record.responseStatus,
        createdAt: record.createdAt,
      });
    },
    async pruneOnceByPrefix(keyPrefix, olderThanIso) {
      // created_at is an ISO-8601 string → lexicographic compare is chronological.
      const info = db
        .prepare(`DELETE FROM idempotency WHERE key LIKE ? ESCAPE '\\' AND created_at < ?`)
        .run(`${keyPrefix.replace(/[%_\\]/g, '\\$&')}%`, olderThanIso);
      return info.changes;
    },

    // ── RFC 0059 workspace (ADR 0551 P0) ──
    async getWorkspaceFile(tenantId, workspaceId, path) {
      const r = db
        .prepare(
          `SELECT path, content, content_type, version, etag, size_bytes, updated_at
             FROM workspace_files
            WHERE tenant_id = ? AND workspace_id = ? AND path = ?`,
        )
        .get(tenantId, workspaceId, path) as
        | { path: string; content: string; content_type: string; version: number; etag: string; size_bytes: number; updated_at: string }
        | undefined;
      return r
        ? {
            path: r.path, content: r.content, contentType: r.content_type,
            version: r.version, etag: r.etag, sizeBytes: r.size_bytes, updatedAt: r.updated_at,
          }
        : null;
    },
    async listWorkspaceFiles(tenantId, workspaceId, prefix) {
      // Prefix filtering happens in SQL, not after a full read: the owner's
      // file set is unbounded and pulling every body to drop it again is the
      // scan this list endpoint exists to avoid.
      const rows = (prefix === undefined
        ? db.prepare(
            `SELECT path, content_type, version, etag, size_bytes, updated_at
               FROM workspace_files WHERE tenant_id = ? AND workspace_id = ? ORDER BY path`,
          ).all(tenantId, workspaceId)
        : db.prepare(
            `SELECT path, content_type, version, etag, size_bytes, updated_at
               FROM workspace_files
              WHERE tenant_id = ? AND workspace_id = ? AND path LIKE ? ESCAPE '\\'
              ORDER BY path`,
          ).all(tenantId, workspaceId, `${prefix.replace(/[%_\\]/g, '\\$&')}%`)
      ) as { path: string; content_type: string; version: number; etag: string; size_bytes: number; updated_at: string }[];
      return rows.map((r) => ({
        path: r.path, contentType: r.content_type, version: r.version,
        etag: r.etag, sizeBytes: r.size_bytes, updatedAt: r.updated_at,
      }));
    },
    async putWorkspaceFile(input) {
      return putWorkspaceFileTxn(input);
    },
    async deleteWorkspaceFile(tenantId, workspaceId, path) {
      const info = db
        .prepare(`DELETE FROM workspace_files WHERE tenant_id = ? AND workspace_id = ? AND path = ?`)
        .run(tenantId, workspaceId, path);
      return info.changes > 0;
    },

    async claimIdempotentResponse(input) {
      return claimIdempotentResponseTxn(input);
    },
    async releaseIdempotentResponse(input) {
      releaseIdemResponseStmt.run(input);
    },
    async pruneIdempotentResponses(olderThanIso) {
      // created_at is an ISO-8601 string → lexicographic compare is chronological.
      const info = db
        .prepare(`DELETE FROM idempotent_response WHERE created_at < ?`)
        .run(olderThanIso);
      return info.changes;
    },
    async completeIdempotentResponse(input) {
      const res = completeIdemResponseStmt.run({
        tenantId: input.tenantId,
        endpoint: input.endpoint,
        key: input.key,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
        runId: input.runId ?? null,
        updatedAt: input.updatedAt,
        claimToken: input.claimToken,
      });
      return res.changes > 0;
    },

    async countAuditRows() {
      const row = db.prepare(`SELECT count(*) AS n FROM audit_log`).get() as { n: number };
      return Number(row?.n ?? 0);
    },

    async appendAudit(input) {
      insertAuditStmt.run({
        auditId: randomUUID(),
        timestamp: input.timestamp,
        principalId: input.principalId ?? null,
        action: input.action,
        resource: input.resource ?? null,
        outcome: input.outcome ?? null,
        payload: input.payload != null ? JSON.stringify(input.payload) : null,
      });
    },

    async listAudit(filter) {
      const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
      // Exact-match subject pushdown (idx_audit_resource_ts) — see the
      // Storage interface note: per-subject consumers must not window-scan.
      const resourceClause = filter?.resource ? ' AND resource = ?' : '';
      const rows = db
        .prepare(
          `SELECT audit_id, timestamp, principal_id, action, resource, outcome, payload
             FROM audit_log
            WHERE action LIKE ? ESCAPE '\\'${resourceClause} AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp DESC
            LIMIT ?`,
        )
        .all(
          `${(filter?.actionPrefix ?? '').replace(/[%_\\]/g, '\\$&')}%`,
          ...(filter?.resource ? [filter.resource] : []),
          filter?.sinceIso ?? '',
          filter?.beforeIso ?? '9999-12-31T23:59:59.999Z',
          limit,
        ) as Array<{
        audit_id: string;
        timestamp: string;
        principal_id: string | null;
        action: string;
        resource: string | null;
        outcome: string | null;
        payload: string | null;
      }>;
      return rows.map((r) => ({
        auditId: r.audit_id,
        timestamp: r.timestamp,
        action: r.action,
        ...(r.principal_id !== null ? { principalId: r.principal_id } : {}),
        ...(r.resource !== null ? { resource: r.resource } : {}),
        ...(r.outcome !== null ? { outcome: r.outcome } : {}),
        ...(r.payload !== null ? { payload: JSON.parse(r.payload) as unknown } : {}),
      }));
    },

    async getInvocation({ runId, nodeId, attempt, invocationId }) {
      const row = getInvocationStmt.get(runId, nodeId, attempt, invocationId) as
        | { result: string }
        | undefined;
      return row?.result ? JSON.parse(row.result) : null;
    },

    async getLatestInvocation({ runId, nodeId, invocationId }) {
      const row = getLatestInvocationStmt.get(runId, nodeId, invocationId) as
        | { result: string }
        | undefined;
      return row?.result ? JSON.parse(row.result) : null;
    },

    async putInvocation({ runId, nodeId, attempt, invocationId }, result) {
      putInvocationStmt.run(
        runId,
        nodeId,
        attempt,
        invocationId,
        JSON.stringify(result ?? null),
        new Date().toISOString(),
      );
    },
    async claimInvocation({ runId, nodeId, invocationId }, { nowMs, staleAfterMs }) {
      const res = claimInvocationStmt.run({
        runId,
        nodeId,
        invocationId,
        now: nowMs,
        staleBefore: nowMs - staleAfterMs,
      });
      return res.changes > 0;
    },
    async releaseInvocationClaim({ runId, nodeId, invocationId }) {
      releaseInvocationClaimStmt.run({ runId, nodeId, invocationId });
    },

    async appendEffectEscape(entry) {
      appendEffectEscapeStmt.run(entry);
    },

    listRunEffects(runId: string) {
      const rows = listRunEffectsStmt.all(runId) as Array<{
        nodeId: string; attempt: number; invocationId: string; completed: number; at: string;
      }>;
      return Promise.resolve(rows.map((r) => ({
        nodeId: r.nodeId, attempt: r.attempt, invocationId: r.invocationId,
        completed: r.completed === 1, at: r.at,
      })));
    },

    async listEffectEscapes(runId) {
      return listEffectEscapesStmt.all(runId) as Array<{
        invocationId: string;
        nodeId: string;
        count: number;
      }>;
    },

    async upsertEncryptedSecret(credentialRef, encryptedRecordJson, now) {
      upsertSecretStmt.run({ ref: credentialRef, rec: encryptedRecordJson, now });
    },

    async getEncryptedSecret(credentialRef) {
      const row = getSecretStmt.get(credentialRef) as { encrypted_record: string } | undefined;
      return row?.encrypted_record ?? null;
    },

    async deleteSecret(credentialRef) {
      deleteSecretStmt.run(credentialRef);
    },

    async listSecretRefs() {
      const rows = listSecretRefsStmt.all() as Array<{ credential_ref: string }>;
      return rows.map((r) => r.credential_ref);
    },

    async upsertTenantSecret(tenantId, credentialRef, encryptedRecordJson, now) {
      upsertTenantSecretStmt.run({
        tenant: tenantId, ref: credentialRef, rec: encryptedRecordJson, now,
      });
    },

    async getTenantSecret(tenantId, credentialRef) {
      const row = getTenantSecretStmt.get(tenantId, credentialRef) as
        | { encrypted_record: string }
        | undefined;
      return row?.encrypted_record ?? null;
    },

    async deleteTenantSecret(tenantId, credentialRef) {
      deleteTenantSecretStmt.run(tenantId, credentialRef);
    },

    async listTenantSecretRefs(tenantId) {
      const rows = listTenantSecretRefsStmt.all(tenantId) as Array<{ credential_ref: string }>;
      return rows.map((r) => r.credential_ref);
    },

    async deleteAllTenantSecrets(tenantId) {
      const res = deleteAllTenantSecretsStmt.run(tenantId);
      return Number(res.changes ?? 0);
    },

    async deleteRun(runId) {
      // Single-run cascade — mirrors deleteAllTenantData's explicit delete
      // order (no FK constraints in this schema). Atomic via transaction.
      // Grade-data G3 (2026-07-09): the per-run kv rows (variable bag /
      // channel state / agent stamp write-throughs) were ORPHANED by every
      // run delete — the runtime modules' clear* helpers had no production
      // callers. The cascade now owns them (key = '<prefix><runId>').
      const txn = db.transaction((rid: string) => {
        db.prepare(`DELETE FROM events WHERE run_id = ?`).run(rid);
        db.prepare(`DELETE FROM interrupts WHERE run_id = ?`).run(rid);
        db.prepare(`DELETE FROM invocation_log WHERE run_id = ?`).run(rid);
        // ADR 0618 — the Layer-2 claim is run-keyed with no tenant column, so it
        // cascades with the run exactly like the memo beside it. Caught by the
        // GEN-5 teardown drift guard, which is what that guard is for.
        db.prepare(`DELETE FROM invocation_claim WHERE run_id = ?`).run(rid);
        // ADR 0591 — the effect escape ledger is run-keyed with NO tenant_id, so
        // it only leaves with the run. Caught by the GEN-5 teardown drift guard.
        db.prepare(`DELETE FROM effect_escape_ledger WHERE run_id = ?`).run(rid);
        db.prepare(`DELETE FROM annotations WHERE run_id = ?`).run(rid);
        // Grade-pass DEL-1 (2026-07-15) — cascade parity with pruneTerminalRuns:
        // envelope correlations, the agent activity row, and runartifact kv rows
        // retire with the run (mirrors postgres; LIKE escape as in the pruner).
        db.prepare(`DELETE FROM envelope_correlations WHERE run_id = ?`).run(rid);
        db.prepare(`DELETE FROM agent_run_activity WHERE run_id = ?`).run(rid);
        db.prepare(`DELETE FROM host_ext_kv WHERE k IN (?, ?, ?)`).run(`runvars:${rid}`, `runchans:${rid}`, `runagent:${rid}`);
        const ridEsc = rid.replace(/[\\%_]/g, (m) => `\\${m}`);
        db.prepare(`DELETE FROM host_ext_kv WHERE k LIKE ? ESCAPE '\\'`).run(`hostext:runartifact:${ridEsc}:%`);
        const rr = db.prepare(`DELETE FROM runs WHERE run_id = ?`).run(rid);
        return Number(rr.changes ?? 0) > 0;
      });
      return txn(runId);
    },

    async insertAnnotation(record) {
      db.prepare(
        `INSERT INTO annotations (annotation_id, run_id, tenant_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(record.annotationId, record.runId, record.tenantId, JSON.stringify(record.payload), record.createdAt);
    },

    async listAnnotations(runId) {
      const rows = db
        .prepare(`SELECT annotation_id, run_id, tenant_id, payload, created_at FROM annotations WHERE run_id = ? ORDER BY created_at ASC`)
        .all(runId) as Array<{ annotation_id: string; run_id: string; tenant_id: string; payload: string; created_at: string }>;
      return rows.map((r) => ({
        annotationId: r.annotation_id,
        runId: r.run_id,
        tenantId: r.tenant_id,
        payload: JSON.parse(r.payload) as unknown,
        createdAt: r.created_at,
      }));
    },

    async pruneTerminalRuns(cutoffIso, limit) {
      // ADR 0287 — whole-run retention (mirrors postgres/index.ts). The terminal
      // set is the SDK's wire constant — placeholders built from it, no drift.
      const terminalPlaceholders = TERMINAL_RUN_STATUSES.map(() => '?').join(',');
      const txn = db.transaction((cut: string, lim: number) => {
        const picked = db.prepare(
          `SELECT run_id FROM runs WHERE status IN (${terminalPlaceholders}) AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
        ).all(...TERMINAL_RUN_STATUSES, cut, lim) as Array<{ run_id: string }>;
        if (picked.length === 0) return { runs: 0, childRows: 0 };
        let childRows = 0;
        let runs = 0;
        for (const { run_id } of picked) {
          for (const child of ['events', 'interrupts', 'invocation_log', 'invocation_claim', 'effect_escape_ledger', 'envelope_correlations', 'annotations', 'agent_run_activity'] as const) {
            const cr = db.prepare(`DELETE FROM ${child} WHERE run_id = ?`).run(run_id);
            childRows += Number(cr.changes ?? 0);
          }
          // Grade-data G3 — the run's kv write-throughs retire with it.
          childRows += Number(db.prepare(`DELETE FROM host_ext_kv WHERE k IN (?, ?, ?)`).run(`runvars:${run_id}`, `runchans:${run_id}`, `runagent:${run_id}`).changes ?? 0);
          // ADR 0287 correction — run artifacts retire too (mirrors postgres:
          // `hostext:runartifact:<runId>:<nodeId>`, no tenant index). LIKE
          // metacharacters escaped defensively, same as the postgres arm.
          const ridEsc = run_id.replace(/[\\%_]/g, (m) => `\\${m}`);
          childRows += Number(db.prepare(`DELETE FROM host_ext_kv WHERE k LIKE ? ESCAPE '\\'`).run(`hostext:runartifact:${ridEsc}:%`).changes ?? 0);
          runs += Number(db.prepare(`DELETE FROM runs WHERE run_id = ?`).run(run_id).changes ?? 0);
        }
        return { runs, childRows };
      });
      return txn(cutoffIso, limit);
    },

    async pruneWebhookDeliveries(cutoffMs) {
      const r = db.prepare(`DELETE FROM webhook_deliveries WHERE status IN ('delivered','dead') AND updated_at < ?`).run(cutoffMs);
      return Number(r.changes ?? 0);
    },

    async deleteAllTenantData(tenantId) {
      // ADR 0284 — introspection-complete teardown, the delete twin of
      // `reassignTenant` (the previous hand-kept 7-table list silently orphaned
      // chat, user_agents, webhooks, messaging, and the usage meters). `audit_log`
      // has no tenant column, so introspection excludes it naturally — security
      // events persist past deletion BY DESIGN. Children without `tenant_id`
      // (run-/session-/subscription-keyed) are cascaded explicitly; no FK
      // enforcement is assumed. Mirrors postgres/index.ts.
      const deleteTxn = db.transaction((tid: string) => {
        const runRows = db.prepare(`SELECT run_id FROM runs WHERE tenant_id = ?`).all(tid) as Array<{ run_id: string }>;
        const runIds = runRows.map((r) => r.run_id);
        let events = 0;
        let interrupts = 0;
        let otherRows = 0;
        for (const rid of runIds) {
          const er = db.prepare(`DELETE FROM events WHERE run_id = ?`).run(rid);
          events += Number(er.changes ?? 0);
          const ir = db.prepare(`DELETE FROM interrupts WHERE run_id = ?`).run(rid);
          interrupts += Number(ir.changes ?? 0);
          // Grade-data G3 — per-run kv write-throughs (variables/channels/agent stamp).
          otherRows += Number(db.prepare(`DELETE FROM host_ext_kv WHERE k IN (?, ?, ?)`).run(`runvars:${rid}`, `runchans:${rid}`, `runagent:${rid}`).changes ?? 0);
          // NOTE: `idempotency` (the L1 HTTP response cache) is key-only BY DESIGN
          // on BOTH backends — no run/tenant linkage to cascade on; rows age out
          // via `pruneIdempotencyByPrefix` retention. (The "sqlite lacks pg's
          // run_id" drift note from an earlier revision was a misread — the two
          // schemas are identical here.)
          for (const child of ['invocation_log', 'invocation_claim', 'effect_escape_ledger', 'envelope_correlations'] as const) {
            const cr = db.prepare(`DELETE FROM ${child} WHERE run_id = ?`).run(rid);
            otherRows += Number(cr.changes ?? 0);
          }
        }
        const sessionRows = db.prepare(`SELECT session_id FROM chat_sessions WHERE tenant_id = ?`).all(tid) as Array<{ session_id: string }>;
        for (const s of sessionRows) {
          const mr = db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(s.session_id);
          otherRows += Number(mr.changes ?? 0);
        }
        const hookRows = db.prepare(`SELECT subscription_id FROM webhooks WHERE tenant_id = ?`).all(tid) as Array<{ subscription_id: string }>;
        for (const h of hookRows) {
          const dr = db.prepare(`DELETE FROM webhook_deliveries WHERE subscription_id = ?`).run(h.subscription_id);
          otherRows += Number(dr.changes ?? 0);
        }
        const named: Record<string, number> = {};
        for (const t of tenantScopedTables(db)) {
          // `t` comes from the sqlite catalog (trusted), quoted defensively.
          const r = db.prepare(`DELETE FROM "${t.replace(/"/g, '""')}" WHERE tenant_id = ?`).run(tid);
          named[t] = Number(r.changes ?? 0);
        }
        // GEN-1c: run_budget has no tenant_id column (introspection skips it), so
        // delete the tenant's buckets by the encoded-tenant predicate. Counts into otherRows.
        for (const { bucket } of db.prepare(`SELECT bucket FROM run_budget`).all() as Array<{ bucket: string }>) {
          if (!runBudgetBucketBelongsTo(bucket, tid)) continue;
          otherRows += Number(db.prepare(`DELETE FROM run_budget WHERE bucket = ?`).run(bucket).changes ?? 0);
        }
        const take = (t: string): number => {
          const n = named[t] ?? 0;
          delete named[t];
          return n;
        };
        return {
          runs: take('runs'),
          events,
          interrupts,
          workflows: take('workflows'),
          secrets: take('byok_tenant_secrets') + take('byok_secrets'),
          notifications: take('notifications'),
          pushSubscriptions: take('push_subscriptions'),
          otherRows: otherRows + Object.values(named).reduce((a, b) => a + b, 0),
          tablesCovered: tenantScopedTables(db).length,
        };
      });
      return deleteTxn(tenantId);
    },

    async reassignTenant(fromTenant, toTenant) {
      // ADR 0003 Phase 4c — adopt-migration. Re-key the ENTIRE source tenant's
      // content into the destination in ONE transaction (atomic; a partial
      // failure rolls back, never splitting data across two tenants). Idempotent:
      // a re-run finds nothing under `from`. Two layers:
      //  (1) every SQL table with a `tenant_id` column — discovered by schema
      //      INTROSPECTION, not a hand-kept list, so a future tenant table is
      //      covered automatically (no silent orphan). Cascade children keyed by
      //      run_id/session_id (events, interrupts, chat_messages, run_budget…)
      //      follow their parent row and need no re-key.
      //  (2) host-ext KV content rows — a read-modify-write of any row whose JSON
      //      carries `tenantId`/`orgId === from`. EXCLUDES the access-control
      //      scaffolding (the personal-workspace org `orgId == tenant` and the
      //      deterministic owner member `mbr-<hash(tenant,subject)>`), whose KEYS
      //      encode the tenant — the destination re-seeds canonical scaffolding
      //      via ensurePersonalWorkspace, so migrating them would collide.
      const tables = tenantScopedTables(db);
      const reassignTxn = db.transaction((from: string, to: string) => {
        const counts: Record<string, number> = {};
        for (const t of tables) {
          const r = db.prepare(`UPDATE "${t}" SET tenant_id = ? WHERE tenant_id = ?`).run(to, from);
          counts[t] = Number(r.changes ?? 0);
        }
        // GEN-1c: run_budget has no tenant_id column (introspection skips it) — move
        // the tenant's buckets by rewriting the encoded-tenant segment; keep the
        // TARGET on a same-window collision (its own budget wins). Counts into `tables`.
        const budgetMoveIns = db.prepare(`INSERT OR IGNORE INTO run_budget (bucket, window_start, count) VALUES (?, ?, ?)`);
        const budgetMoveDel = db.prepare(`DELETE FROM run_budget WHERE bucket = ?`);
        let runBudgetMoved = 0;
        for (const r of db.prepare(`SELECT bucket, window_start, count FROM run_budget`).all() as Array<{ bucket: string; window_start: number; count: number }>) {
          const nb = rekeyTenantSegment(r.bucket, from, to);
          if (nb === r.bucket) continue;
          budgetMoveIns.run(nb, r.window_start, r.count);
          budgetMoveDel.run(r.bucket);
          runBudgetMoved++;
        }
        if (runBudgetMoved > 0) counts.run_budget = runBudgetMoved;
        // host-ext KV: content re-key IN PLACE (tenantId/orgId value) + GEN-1b
        // tenant-embedded KEY move (primary PK rows + `hostextidx:` markers),
        // excluding access-control scaffolding in BOTH keyspaces (re-seeded at the
        // destination, never moved). `planHostExtRekey` decides each action purely
        // (see ../tenantMigration.ts) so both adapters stay in lockstep.
        const now = new Date().toISOString();
        const rows = db
          .prepare(
            `SELECT k, v FROM host_ext_kv
             WHERE k NOT LIKE 'hostext:access-orgs:%'    AND k NOT LIKE 'hostext:access-members:%'
               AND k NOT LIKE 'hostextidx:access-orgs:%' AND k NOT LIKE 'hostextidx:access-members:%'`,
          )
          .all() as Array<{ k: string; v: string }>;
        const upd = db.prepare(`UPDATE host_ext_kv SET v = ?, updated_at = ? WHERE k = ?`);
        const insIfAbsent = db.prepare(`INSERT OR IGNORE INTO host_ext_kv (k, v, updated_at) VALUES (?, ?, ?)`);
        const del = db.prepare(`DELETE FROM host_ext_kv WHERE k = ?`);
        let hostExt = 0;
        let hostExtKeysRekeyed = 0;
        let hostExtKeysDeduped = 0;
        for (const row of rows) {
          const action = planHostExtRekey(row.k, row.v, from, to);
          if (action.kind === 'none') continue;
          if (action.kind === 'value') { upd.run(action.v, now, row.k); hostExt++; continue; }
          // move: keep the destination row on collision (fold dedup), drop the source either way.
          const inserted = Number(insIfAbsent.run(action.k, action.v, now).changes ?? 0) > 0;
          del.run(row.k);
          if (inserted) hostExtKeysRekeyed++; else hostExtKeysDeduped++;
        }
        return {
          tables: counts,
          hostExt,
          hostExtKeysRekeyed,
          hostExtKeysDeduped,
          runs: counts.runs ?? 0,
          workflows: counts.workflows ?? 0,
          notifications: counts.notifications ?? 0,
          pushSubscriptions: counts.push_subscriptions ?? 0,
        };
      });
      return reassignTxn(fromTenant, toTenant);
    },

    async incrementManagedUsage(tenantId, providerId, dateUtc, inputTokens, outputTokens) {
      incrManagedUsageStmt.run({
        tenant: tenantId,
        date: dateUtc,
        provider: providerId,
        inTok: inputTokens,
        outTok: outputTokens,
      });
    },

    async deleteManagedUsageForTenant(tenantId: string, alsoLike?: UsageLikeMatcher) {
      // ADR 0693 §4 — subject erasure. Prepared inline rather than hoisted: it
      // runs on a DSAR, not a hot path, and a statement cached for a delete that
      // fires once per erasure buys nothing.
      // `alsoLike` additionally reaches the per-subject buckets this TENANT
      // owns (ADR 0697 follow-up). The pattern is composed and escaped by the
      // caller; sqlite needs the ESCAPE clause spelled out exactly as postgres
      // does, or a `_` in a tenant id silently matches any character.
      const info = alsoLike
        ? db.prepare('DELETE FROM managed_provider_usage WHERE tenant_id = ? OR tenant_id LIKE ? ESCAPE ?')
          .run(tenantId, alsoLike.pattern, alsoLike.escape)
        : db.prepare('DELETE FROM managed_provider_usage WHERE tenant_id = ?').run(tenantId);
      return info.changes ?? 0;
    },

    async getManagedUsage(tenantId, providerId, dateUtc) {
      const row = getManagedUsageStmt.get(tenantId, dateUtc, providerId) as
        | { input_tokens: number; output_tokens: number }
        | undefined;
      if (!row) return { inputTokens: 0, outputTokens: 0 };
      return { inputTokens: row.input_tokens, outputTokens: row.output_tokens };
    },

    async deleteMediaUsageForTenant(tenantId: string, alsoLike?: UsageLikeMatcher) {
      // ADR 0693 §4 — subject erasure, media half. Prepared inline: DSAR path,
      // not a hot one.
      // `alsoLike` additionally reaches the per-subject buckets this TENANT
      // owns (ADR 0697 follow-up). The pattern is composed and escaped by the
      // caller; sqlite needs the ESCAPE clause spelled out exactly as postgres
      // does, or a `_` in a tenant id silently matches any character.
      const info = alsoLike
        ? db.prepare('DELETE FROM media_provider_usage WHERE tenant_id = ? OR tenant_id LIKE ? ESCAPE ?')
          .run(tenantId, alsoLike.pattern, alsoLike.escape)
        : db.prepare('DELETE FROM media_provider_usage WHERE tenant_id = ?').run(tenantId);
      return info.changes ?? 0;
    },

    async incrementMediaUsage(tenantId, dateUtc, ttsChars, sttBytes) {
      incrMediaUsageStmt.run({ tenant: tenantId, date: dateUtc, ttsChars, sttBytes });
    },

    async getMediaUsage(tenantId, dateUtc) {
      const row = getMediaUsageStmt.get(tenantId, dateUtc) as
        | { tts_chars: number; stt_bytes: number }
        | undefined;
      if (!row) return { ttsChars: 0, sttBytes: 0 };
      return { ttsChars: row.tts_chars, sttBytes: row.stt_bytes };
    },

    async incrementByokChatUsage(tenantId, providerId, dateUtc, inputTokens, outputTokens) {
      incrByokChatUsageStmt.run({
        tenant: tenantId,
        provider: providerId,
        date: dateUtc,
        inTok: inputTokens,
        outTok: outputTokens,
      });
    },

    async getByokChatUsage(tenantId, providerId, dateUtc) {
      const row = getByokChatUsageStmt.get(tenantId, providerId, dateUtc) as
        | { input_tokens: number; output_tokens: number }
        | undefined;
      if (!row) return { inputTokens: 0, outputTokens: 0 };
      return { inputTokens: row.input_tokens, outputTokens: row.output_tokens };
    },

    async getEnvelopeCorrelation(runId, correlationId) {
      const row = getEnvelopeCorrelationStmt.get(runId, correlationId) as
        | { outcome: string; envelope_type: string; recorded_at: string }
        | undefined;
      if (!row) return null;
      return {
        outcome: JSON.parse(row.outcome) as unknown,
        envelopeType: row.envelope_type,
        recordedAt: row.recorded_at,
      };
    },

    async putEnvelopeCorrelation(runId, correlationId, outcome, envelopeType, recordedAt) {
      putEnvelopeCorrelationStmt.run(
        runId,
        correlationId,
        JSON.stringify(outcome),
        envelopeType,
        recordedAt,
      );
    },

    // ── chat sessions (Phase 2C.1) ────────────────────────────────────
    async listChatSessions(tenantId, limit) {
      const rows = listChatSessionsStmt.all(tenantId, limit ?? 200) as Array<{
        session_id: string;
        tenant_id: string;
        title: string;
        title_source: string | null;
        created_at: string;
        updated_at: string;
        message_count: number;
      }>;
      return rows.map((r): ChatSessionRecord => ({
        sessionId: r.session_id,
        tenantId: r.tenant_id,
        title: r.title,
        ...(r.title_source ? { titleSource: r.title_source as ChatSessionRecord['titleSource'] } : {}),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        messageCount: r.message_count,
      }));
    },

    async createChatSession(record) {
      createChatSessionStmt.run(
        record.sessionId,
        record.tenantId,
        record.title,
        record.titleSource ?? null,
        record.createdAt,
        record.updatedAt,
        record.messageCount,
      );
    },

    async getChatSession(tenantId, sessionId) {
      const row = getChatSessionStmt.get(tenantId, sessionId) as
        | {
            session_id: string;
            tenant_id: string;
            title: string;
            title_source: string | null;
            created_at: string;
            updated_at: string;
            message_count: number;
          }
        | undefined;
      if (!row) return null;
      return {
        sessionId: row.session_id,
        tenantId: row.tenant_id,
        title: row.title,
        ...(row.title_source ? { titleSource: row.title_source as ChatSessionRecord['titleSource'] } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
      };
    },

    async updateChatSession(tenantId, sessionId, patch) {
      updateChatSessionStmt.run(
        patch.title ?? null,
        patch.titleSource ?? null,
        patch.updatedAt ?? null,
        patch.messageCount ?? null,
        tenantId,
        sessionId,
      );
    },

    async casChatSessionTitle(tenantId, sessionId, patch, expectTitleSource) {
      const info = casChatSessionTitleStmt.run(
        patch.title,
        patch.titleSource,
        patch.updatedAt,
        tenantId,
        sessionId,
        expectTitleSource,
      );
      return info.changes > 0;
    },

    async deleteChatSession(tenantId, sessionId) {
      const info = deleteChatSessionStmt.run(tenantId, sessionId);
      return info.changes > 0;
    },

    async countChatSessionMessages(sessionId) {
      const row = countChatMessagesStmt.get(sessionId) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    async listChatSessionMessages(sessionId, opts) {
      type Row = { message_id: string; session_id: string; role: string; content: string; meta: string | null; author_subject: string | null; created_at: string };
      let rows: Row[];
      if (opts?.limit !== undefined) {
        // Bounded page: fetch the most-recent `limit` (optionally before the
        // cursor) DESC, then reverse to ASC so the thread reads top-to-bottom.
        rows = (opts.before
          ? listChatMessagesBeforeStmt.all(sessionId, opts.before.createdAt, opts.before.messageId, opts.limit)
          : listChatMessagesRecentStmt.all(sessionId, opts.limit)) as Row[];
        rows.reverse();
      } else {
        rows = listChatMessagesStmt.all(sessionId) as Row[];
      }
      return rows.map((r): ChatMessageRecord => ({
        messageId: r.message_id,
        sessionId: r.session_id,
        role: r.role as ChatMessageRecord['role'],
        content: r.content,
        meta: r.meta,
        authorSubject: r.author_subject,
        createdAt: r.created_at,
      }));
    },

    async appendChatMessage(record) {
      // Atomic: insert the message AND bump the parent session's
      // message_count + updated_at in one transaction. The previous
      // pattern (route reads session.messageCount, route increments,
      // route writes back) lost increments under concurrent appends.
      // better-sqlite3 transactions are synchronous — wrap into the
      // async signature with a thin Promise resolve.
      db.transaction(() => {
        appendChatMessageStmt.run(
          record.messageId,
          record.sessionId,
          record.role,
          record.content,
          record.meta,
          record.authorSubject,
          record.createdAt,
        );
        bumpChatSessionStmt.run(record.createdAt, record.sessionId);
      })();
    },

    async updateChatMessageContent(sessionId, messageId, content, meta) {
      const info = updateChatMessageStmt.run(content, meta ?? null, sessionId, messageId);
      return info.changes > 0;
    },

    async getChatMessage(sessionId, messageId) {
      const row = getChatMessageStmt.get(sessionId, messageId) as
        | { message_id: string; session_id: string; role: string; content: string; meta: string | null; author_subject: string | null; created_at: string }
        | undefined;
      if (!row) return undefined;
      return {
        messageId: row.message_id, sessionId: row.session_id,
        role: row.role as 'user' | 'assistant' | 'system' | 'workflow_run',
        content: row.content, meta: row.meta, authorSubject: row.author_subject, createdAt: row.created_at,
      };
    },
    async getChatMessageAuthor(sessionId, messageId) {
      const row = getChatMessageAuthorStmt.get(sessionId, messageId) as { author_subject: string | null } | undefined;
      return row ? { authorSubject: row.author_subject } : undefined;
    },

    async insertNotification(record) {
      db.prepare(
        `INSERT INTO notifications (
          notification_id, tenant_id, recipient_user_id, recipient_role, type, priority, status,
          title, message, run_id, workflow_id, node_id,
          interrupt_id, action_url, metadata,
          created_at, read_at, archived_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.notificationId, record.tenantId, record.recipientUserId ?? null, record.recipientRole ?? null,
        record.type, record.priority, record.status,
        record.title, record.message,
        record.runId ?? null, record.workflowId ?? null, record.nodeId ?? null,
        record.interruptId ?? null, record.actionUrl ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt, record.readAt ?? null, record.archivedAt ?? null,
      );
    },

    async listNotifications({ tenantId, recipientUserId, recipientRoles, status, includeArchived, ascending, limit = 100 }) {
      const wantStatuses: readonly string[] | null = status
        ? (Array.isArray(status) ? status : [status as string])
        : null;
      const conditions: string[] = ['tenant_id = ?'];
      const params: unknown[] = [tenantId];
      // ADR 0050 — when a recipient is given, return that user's addressed rows,
      // the tenant's TRUE broadcasts (recipient_user_id IS NULL AND recipient_role
      // IS NULL), and role-addressed rows whose role the caller holds (Phase 3).
      // A role row is NEVER a plain broadcast → default-deny when roles is empty.
      // Omitting recipientUserId returns every tenant row (admin / pre-0050 callers).
      if (recipientUserId) {
        const roles = recipientRoles ?? [];
        let clause = '(recipient_user_id = ? OR (recipient_user_id IS NULL AND (recipient_role IS NULL';
        params.push(recipientUserId);
        if (roles.length > 0) {
          clause += ` OR recipient_role IN (${roles.map(() => '?').join(', ')})`;
          for (const r of roles) params.push(r);
        }
        clause += ')))';
        conditions.push(clause);
      }
      if (wantStatuses && wantStatuses.length > 0) {
        conditions.push(`status IN (${wantStatuses.map(() => '?').join(', ')})`);
        for (const s of wantStatuses) params.push(s);
      } else if (!includeArchived) {
        conditions.push(`status <> 'archived'`);
      }
      params.push(limit);
      const order = ascending ? 'ASC' : 'DESC';
      const rows = db.prepare(
        `SELECT * FROM notifications WHERE ${conditions.join(' AND ')}
          ORDER BY created_at ${order} LIMIT ?`,
      ).all(...params) as Array<Record<string, unknown>>;
      return rows.map(rowToNotificationSqlite);
    },

    async getNotification(notificationId) {
      const row = db.prepare(
        `SELECT * FROM notifications WHERE notification_id = ?`,
      ).get(notificationId) as Record<string, unknown> | undefined;
      return row ? rowToNotificationSqlite(row) : null;
    },

    async updateNotificationStatus(notificationId, status, now) {
      // Mirror the Postgres semantics: read_at / archived_at are set
      // once at first transition and preserved afterward (COALESCE).
      const readAt = status === 'read' ? now : null;
      const archivedAt = status === 'archived' ? now : null;
      db.prepare(
        `UPDATE notifications
            SET status = ?,
                read_at = CASE WHEN ? IS NOT NULL THEN COALESCE(read_at, ?) ELSE read_at END,
                archived_at = CASE WHEN ? IS NOT NULL THEN COALESCE(archived_at, ?) ELSE archived_at END
          WHERE notification_id = ?`,
      ).run(status, readAt, readAt, archivedAt, archivedAt, notificationId);
      const row = db.prepare(
        `SELECT * FROM notifications WHERE notification_id = ?`,
      ).get(notificationId) as Record<string, unknown> | undefined;
      return row ? rowToNotificationSqlite(row) : null;
    },

    async markAllNotificationsRead(tenantId, now, recipientUserId, recipientRoles) {
      // ADR 0050 — when scoped to a recipient, clear only the rows that user can
      // see (their addressed rows + true broadcasts + role rows they hold, Phase 3),
      // never another member's addressed or unheld-role items.
      const params: unknown[] = [now, tenantId];
      let recipientClause = '';
      if (recipientUserId) {
        const roles = recipientRoles ?? [];
        recipientClause = 'AND (recipient_user_id = ? OR (recipient_user_id IS NULL AND (recipient_role IS NULL';
        params.push(recipientUserId);
        if (roles.length > 0) {
          recipientClause += ` OR recipient_role IN (${roles.map(() => '?').join(', ')})`;
          for (const r of roles) params.push(r);
        }
        recipientClause += ')))';
      }
      const r = db.prepare(
        `UPDATE notifications
            SET status = 'read',
                read_at = COALESCE(read_at, ?)
          WHERE tenant_id = ?
            AND status = 'unread'
            ${recipientClause}`,
      ).run(...params);
      return r.changes;
    },

    async deleteNotification(notificationId) {
      const r = db.prepare(
        `DELETE FROM notifications WHERE notification_id = ?`,
      ).run(notificationId);
      return r.changes > 0;
    },

    async deleteAllTenantNotifications(tenantId) {
      const r = db.prepare(
        `DELETE FROM notifications WHERE tenant_id = ?`,
      ).run(tenantId);
      return r.changes;
    },

    // CMNT-11 — per-SUBJECT reclamation (the DSAR lane). All three places a
    // subject can be named: the addressed recipient column, and the two
    // metadata keys the emitters write (`actorId` = who caused it,
    // `recipientId` = who it is about, mirrored for the FE presentation map).
    // `json_extract` returns NULL for absent/non-JSON metadata, so a row with
    // no metadata simply does not match. Fail-closed on a falsy tenant/subject.
    async deleteNotificationsForSubject(tenantId, subjectKey) {
      if (!tenantId || !subjectKey) return 0;
      const r = db.prepare(
        `DELETE FROM notifications
          WHERE tenant_id = ?
            AND (recipient_user_id = ?
              OR json_extract(metadata, '$.actorId') = ?
              OR json_extract(metadata, '$.recipientId') = ?)`,
      ).run(tenantId, subjectKey, subjectKey, subjectKey);
      return r.changes;
    },

    async insertPushSubscription(record) {
      // ON CONFLICT(endpoint) — same-browser re-subscribe updates the
      // keys + user-agent without a duplicate row. Mirrors postgres.
      db.prepare(
        `INSERT INTO push_subscriptions (
          subscription_id, tenant_id, user_id, endpoint, p256dh_key, auth_key,
          user_agent, created_at, last_used_at
        ) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET
          p256dh_key = excluded.p256dh_key,
          auth_key = excluded.auth_key,
          user_agent = excluded.user_agent,
          tenant_id = excluded.tenant_id,
          user_id = excluded.user_id`,
      ).run(
        record.subscriptionId, record.tenantId, record.userId ?? null, record.endpoint,
        record.p256dhKey, record.authKey,
        record.userAgent ?? null,
        record.createdAt, record.lastUsedAt ?? null,
      );
    },

    async listPushSubscriptions(tenantId) {
      const rows = db.prepare(
        `SELECT * FROM push_subscriptions WHERE tenant_id = ? ORDER BY created_at DESC`,
      ).all(tenantId) as Array<Record<string, unknown>>;
      return rows.map(rowToPushSubscriptionSqlite);
    },

    async getPushSubscriptionByEndpoint(endpoint) {
      const row = db.prepare(
        `SELECT * FROM push_subscriptions WHERE endpoint = ?`,
      ).get(endpoint) as Record<string, unknown> | undefined;
      return row ? rowToPushSubscriptionSqlite(row) : null;
    },

    async deletePushSubscription(subscriptionId) {
      const r = db.prepare(
        `DELETE FROM push_subscriptions WHERE subscription_id = ?`,
      ).run(subscriptionId);
      return r.changes > 0;
    },

    async deleteAllTenantPushSubscriptions(tenantId) {
      const r = db.prepare(
        `DELETE FROM push_subscriptions WHERE tenant_id = ?`,
      ).run(tenantId);
      return r.changes;
    },

    // ── user-authored agents (phase E1, 2026-05-28) ──
    async insertUserAgent(record) {
      db.prepare(
        `INSERT INTO user_agents (
          agent_id, tenant_id, persona, label, description, model_class,
          system_prompt, tool_allowlist,
          memory_scratchpad, memory_conversation, memory_long_term,
          confidence_threshold, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.agentId,
        record.tenantId,
        record.persona,
        record.label ?? null,
        record.description ?? null,
        record.modelClass,
        record.systemPrompt,
        JSON.stringify(record.toolAllowlist),
        record.memoryShape.scratchpad ? 1 : 0,
        record.memoryShape.conversation ? 1 : 0,
        record.memoryShape.longTerm ? 1 : 0,
        record.confidenceThreshold ?? null,
        record.createdAt,
      );
    },

    async listUserAgents(tenantId) {
      const rows = db.prepare(
        `SELECT * FROM user_agents WHERE tenant_id = ? ORDER BY created_at DESC`,
      ).all(tenantId) as Array<Record<string, unknown>>;
      return rows.map(rowToUserAgent);
    },

    async listAllUserAgents() {
      const rows = db.prepare(
        `SELECT * FROM user_agents ORDER BY created_at DESC`,
      ).all() as Array<Record<string, unknown>>;
      return rows.map(rowToUserAgent);
    },

    async getUserAgentAnyTenant(agentId) {
      const row = db.prepare(
        `SELECT * FROM user_agents WHERE agent_id = ?`,
      ).get(agentId) as Record<string, unknown> | undefined;
      return row ? rowToUserAgent(row) : null;
    },

    async getUserAgent(tenantId, agentId) {
      const row = db.prepare(
        `SELECT * FROM user_agents WHERE agent_id = ? AND tenant_id = ?`,
      ).get(agentId, tenantId) as Record<string, unknown> | undefined;
      return row ? rowToUserAgent(row) : null;
    },

    async deleteUserAgent(tenantId, agentId) {
      const r = db.prepare(`DELETE FROM user_agents WHERE agent_id = ? AND tenant_id = ?`).run(agentId, tenantId);
      return r.changes > 0;
    },

    async updateUserAgent(expectedTenantId, record) {
      const r = db.prepare(
        `UPDATE user_agents SET
          tenant_id = ?,
          persona = ?, label = ?, description = ?, model_class = ?,
          system_prompt = ?, tool_allowlist = ?,
          memory_scratchpad = ?, memory_conversation = ?, memory_long_term = ?,
          confidence_threshold = ?
        WHERE agent_id = ? AND tenant_id = ?`,
      ).run(
        record.tenantId,
        record.persona,
        record.label ?? null,
        record.description ?? null,
        record.modelClass,
        record.systemPrompt,
        JSON.stringify(record.toolAllowlist),
        record.memoryShape.scratchpad ? 1 : 0,
        record.memoryShape.conversation ? 1 : 0,
        record.memoryShape.longTerm ? 1 : 0,
        record.confidenceThreshold ?? null,
        record.agentId,
        expectedTenantId,
      );
      return r.changes > 0;
    },

    // ── messaging relay-gateway (demo host-extension) ──
    async upsertRelayDevice(record) {
      db.prepare(
        `INSERT INTO relay_devices (
          relay_id, tenant_id, channel, device_name, status,
          device_token_hash, token_expires_at, activation_code, activation_expires_at,
          registered_at, last_heartbeat_at, last_reported_status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(relay_id) DO UPDATE SET
          channel=excluded.channel, device_name=excluded.device_name, status=excluded.status,
          device_token_hash=excluded.device_token_hash, token_expires_at=excluded.token_expires_at,
          activation_code=excluded.activation_code, activation_expires_at=excluded.activation_expires_at,
          last_heartbeat_at=excluded.last_heartbeat_at, last_reported_status=excluded.last_reported_status`,
      ).run(
        record.relayId, record.tenantId, record.channel, record.deviceName ?? null, record.status,
        record.deviceTokenHash ?? null, record.tokenExpiresAt ?? null,
        record.activationCode ?? null, record.activationExpiresAt ?? null,
        record.registeredAt, record.lastHeartbeatAt ?? null, record.lastReportedStatus ?? null,
      );
    },
    async getRelayDevice(relayId) {
      const row = db.prepare(`SELECT * FROM relay_devices WHERE relay_id = ?`).get(relayId) as Record<string, unknown> | undefined;
      return row ? rowToRelayDeviceSqlite(row) : null;
    },
    async getRelayDeviceByTokenHash(tokenHash) {
      const row = db.prepare(
        `SELECT * FROM relay_devices WHERE device_token_hash = ? AND status = 'active'`,
      ).get(tokenHash) as Record<string, unknown> | undefined;
      return row ? rowToRelayDeviceSqlite(row) : null;
    },
    async listRelayDevices(tenantId) {
      const rows = db
        .prepare(`SELECT * FROM relay_devices WHERE tenant_id = ? ORDER BY registered_at DESC`)
        .all(tenantId) as Record<string, unknown>[];
      return rows.map(rowToRelayDeviceSqlite);
    },

    async consumeRunBudget(bucket, windowStart) {
      const row = db
        .prepare(
          `INSERT INTO run_budget (bucket, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(bucket) DO UPDATE SET count = count + 1
           RETURNING count`,
        )
        .get(bucket, windowStart) as { count: number };
      return row.count;
    },
    async pruneRunBudget(olderThanWindowStart) {
      const info = db.prepare(`DELETE FROM run_budget WHERE window_start < ?`).run(olderThanWindowStart);
      return info.changes;
    },

    async recordAgentRunAttribution(row) {
      db.prepare(
        `INSERT OR IGNORE INTO agent_run_activity (run_id, tenant_id, roster_id, agent_id, source, created_at)
         VALUES (@runId, @tenantId, @rosterId, @agentId, @source, @createdAt)`,
      ).run({
        runId: row.runId,
        tenantId: row.tenantId,
        rosterId: row.rosterId,
        agentId: row.agentId ?? null,
        source: row.source,
        createdAt: row.createdAt,
      });
    },
    async deleteOrphanAgentRunActivity() {
      const info = db
        .prepare(
          `DELETE FROM agent_run_activity
            WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = agent_run_activity.run_id)`,
        )
        .run();
      return info.changes;
    },
    async listAgentRunActivity({ tenantId, rosterId, status, limit = 50 }) {
      const rows = db
        .prepare(
          `SELECT r.* FROM agent_run_activity a
             JOIN runs r ON r.run_id = a.run_id
            WHERE a.tenant_id = @tenantId
              AND (@rosterId IS NULL OR a.roster_id = @rosterId)
              AND (@status IS NULL OR r.status = @status)
            ORDER BY r.created_at DESC
            LIMIT @limit`,
        )
        .all({ tenantId, rosterId: rosterId ?? null, status: status ?? null, limit });
      return rows.map(rowToRun);
    },
    async enqueueRelayOutbound(record) {
      db.prepare(
        `INSERT INTO relay_outbound (egress_id, relay_id, channel, conversation_id, text, reply_to_message_id, enqueued_at, extra)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        record.egressId, record.relayId, record.channel, record.conversationId,
        record.text, record.replyToMessageId ?? null, record.enqueuedAt, egressExtraJson(record),
      );
    },
    async listRelayOutbound(relayId, limit) {
      const rows = db.prepare(
        `SELECT * FROM relay_outbound WHERE relay_id = ? ORDER BY enqueued_at ASC, egress_id ASC LIMIT ?`,
      ).all(relayId, limit) as Array<Record<string, unknown>>;
      return rows.map(rowToEgressSqlite);
    },
    async ackRelayOutbound(relayId, egressIds) {
      if (egressIds.length === 0) return 0;
      const placeholders = egressIds.map(() => '?').join(', ');
      const r = db.prepare(
        `DELETE FROM relay_outbound WHERE relay_id = ? AND egress_id IN (${placeholders})`,
      ).run(relayId, ...egressIds);
      return r.changes;
    },
    async deleteRelayOutbound(relayId) {
      db.prepare(`DELETE FROM relay_outbound WHERE relay_id = ?`).run(relayId);
    },
    async upsertMessagingConnector(record) {
      db.prepare(
        `INSERT INTO messaging_connectors (connector_id, tenant_id, channel, display_name, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(connector_id) DO UPDATE SET
           channel=excluded.channel, display_name=excluded.display_name, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      ).run(
        record.connectorId, record.tenantId, record.channel, record.displayName,
        record.enabled ? 1 : 0, record.createdAt, record.updatedAt,
      );
    },
    async getMessagingConnector(connectorId) {
      const row = db.prepare(`SELECT * FROM messaging_connectors WHERE connector_id = ?`).get(connectorId) as Record<string, unknown> | undefined;
      return row ? rowToConnectorSqlite(row) : null;
    },
    async listMessagingConnectors(tenantId) {
      const rows = tenantId === undefined
        ? db.prepare(`SELECT * FROM messaging_connectors ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>
        : db.prepare(`SELECT * FROM messaging_connectors WHERE tenant_id = ? ORDER BY created_at ASC`).all(tenantId) as Array<Record<string, unknown>>;
      return rows.map(rowToConnectorSqlite);
    },
    async upsertMessagingSession(record) {
      db.prepare(
        `INSERT INTO messaging_sessions (session_key, tenant_id, channel, conversation_id, peer_id, peer_display, last_inbound_at, message_count, last_run_id)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_key) DO UPDATE SET
           peer_id=excluded.peer_id, peer_display=excluded.peer_display,
           last_inbound_at=excluded.last_inbound_at, message_count=excluded.message_count, last_run_id=excluded.last_run_id`,
      ).run(
        record.sessionKey, record.tenantId, record.channel, record.conversationId, record.peerId,
        record.peerDisplay ?? null, record.lastInboundAt, record.messageCount, record.lastRunId ?? null,
      );
    },
    async getMessagingSession(sessionKey) {
      const row = db.prepare(`SELECT * FROM messaging_sessions WHERE session_key = ?`).get(sessionKey) as Record<string, unknown> | undefined;
      return row ? rowToSessionSqlite(row) : null;
    },
    async listMessagingSessions(tenantId) {
      const rows = tenantId === undefined
        ? db.prepare(`SELECT * FROM messaging_sessions ORDER BY last_inbound_at DESC`).all() as Array<Record<string, unknown>>
        : db.prepare(`SELECT * FROM messaging_sessions WHERE tenant_id = ? ORDER BY last_inbound_at DESC`).all(tenantId) as Array<Record<string, unknown>>;
      return rows.map(rowToSessionSqlite);
    },
    async deleteMessagingSession(sessionKey) {
      const r = db.prepare(`DELETE FROM messaging_sessions WHERE session_key = ?`).run(sessionKey);
      return r.changes > 0;
    },

    async upsertMessagingPolicy(record) {
      db.prepare(
        `INSERT INTO messaging_policies (connector_id, tenant_id, dm_policy, group_policy, require_mention, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(connector_id) DO UPDATE SET
           dm_policy=excluded.dm_policy, group_policy=excluded.group_policy,
           require_mention=excluded.require_mention, updated_at=excluded.updated_at`,
      ).run(record.connectorId, record.tenantId, record.dmPolicy, record.groupPolicy, record.requireMention ? 1 : 0, record.updatedAt);
    },
    async getMessagingPolicy(connectorId) {
      const row = db.prepare(`SELECT * FROM messaging_policies WHERE connector_id = ?`).get(connectorId) as Record<string, unknown> | undefined;
      return row ? rowToPolicySqlite(row) : null;
    },
    async upsertMessagingRoutingRule(record) {
      db.prepare(
        `INSERT INTO messaging_routing_rules (rule_id, tenant_id, channel, pattern, workflow_id, agent_id, priority, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(rule_id) DO UPDATE SET
           channel=excluded.channel, pattern=excluded.pattern,
           workflow_id=excluded.workflow_id, agent_id=excluded.agent_id, priority=excluded.priority`,
      ).run(
        record.ruleId, record.tenantId, record.channel ?? null, record.pattern,
        record.workflowId ?? null, record.agentId ?? null, record.priority, record.createdAt,
      );
    },
    async listMessagingRoutingRules(tenantId) {
      const rows = tenantId === undefined
        ? db.prepare(`SELECT * FROM messaging_routing_rules ORDER BY priority DESC, created_at ASC`).all() as Array<Record<string, unknown>>
        : db.prepare(`SELECT * FROM messaging_routing_rules WHERE tenant_id = ? ORDER BY priority DESC, created_at ASC`).all(tenantId) as Array<Record<string, unknown>>;
      return rows.map(rowToRoutingRuleSqlite);
    },
    async deleteMessagingRoutingRule(ruleId) {
      return db.prepare(`DELETE FROM messaging_routing_rules WHERE rule_id = ?`).run(ruleId).changes > 0;
    },
    async upsertMessagingIdentity(record) {
      db.prepare(
        `INSERT INTO messaging_identities (identity_id, tenant_id, display_name, peers, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(identity_id) DO UPDATE SET
           display_name=excluded.display_name, peers=excluded.peers, updated_at=excluded.updated_at`,
      ).run(record.identityId, record.tenantId, record.displayName ?? null, JSON.stringify(record.peers ?? []), record.createdAt, record.updatedAt);
    },
    async getMessagingIdentity(identityId) {
      const row = db.prepare(`SELECT * FROM messaging_identities WHERE identity_id = ?`).get(identityId) as Record<string, unknown> | undefined;
      return row ? rowToIdentitySqlite(row) : null;
    },
    async listMessagingIdentities(tenantId) {
      const rows = tenantId === undefined
        ? db.prepare(`SELECT * FROM messaging_identities ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>
        : db.prepare(`SELECT * FROM messaging_identities WHERE tenant_id = ? ORDER BY created_at ASC`).all(tenantId) as Array<Record<string, unknown>>;
      return rows.map(rowToIdentitySqlite);
    },
    async deleteMessagingIdentity(identityId) {
      return db.prepare(`DELETE FROM messaging_identities WHERE identity_id = ?`).run(identityId).changes > 0;
    },
    async appendDeliveryLog(record) {
      db.prepare(
        `INSERT INTO messaging_delivery_log (log_id, tenant_id, relay_id, channel, direction, conversation_id, status, detail, at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(record.logId, record.tenantId, record.relayId ?? null, record.channel, record.direction, record.conversationId, record.status, record.detail ?? null, record.at);
    },
    async listDeliveryLog({ tenantId, channel, direction, status, limit = 100 }) {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (tenantId !== undefined) { conds.push('tenant_id = ?'); params.push(tenantId); }
      if (channel) { conds.push('channel = ?'); params.push(channel); }
      if (direction) { conds.push('direction = ?'); params.push(direction); }
      if (status) { conds.push('status = ?'); params.push(status); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      // Clamp to [1, 1000]: SQLite reads a negative LIMIT as "unbounded", so a
      // negative/NaN value must never reach the query.
      const lim = Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), 1000) : 100;
      params.push(lim);
      const rows = db.prepare(`SELECT * FROM messaging_delivery_log ${where} ORDER BY at DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
      return rows.map(rowToDeliveryLogSqlite);
    },

    async appendMessagingTurn(record) {
      db.prepare(
        `INSERT INTO messaging_turns (turn_id, session_key, tenant_id, role, content, run_id, at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(
        record.turnId, record.sessionKey, record.tenantId, record.role, record.content,
        record.runId ?? null, record.at,
      );
    },
    async listMessagingTurns(sessionKey, limit, tenantId) {
      // Clamp to [1,1000] (negative LIMIT is unbounded in SQLite).
      const lim = Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), 1000) : 100;
      // Get the N MOST RECENT turns, then return them oldest → newest so a
      // caller can append them to messages[] in conversation order. The
      // tenant_id filter is defense-in-depth (sessionKey alone could collide).
      const rows = db.prepare(
        `SELECT * FROM (
           SELECT * FROM messaging_turns
            WHERE session_key = ? AND tenant_id = ?
            ORDER BY at DESC, turn_id DESC LIMIT ?
         ) ORDER BY at ASC, turn_id ASC`,
      ).all(sessionKey, tenantId, lim) as Array<Record<string, unknown>>;
      return rows.map(rowToTurnSqlite);
    },

    async appendMessagingPairing(record) {
      db.prepare(
        `INSERT INTO messaging_pairings (pairing_id, connector_id, tenant_id, channel, peer_id, code, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(record.pairingId, record.connectorId, record.tenantId, record.channel, record.peerId, record.code, record.expiresAt, record.createdAt);
    },
    async getMessagingPairingByCode(connectorId, code) {
      const row = db.prepare(`SELECT * FROM messaging_pairings WHERE connector_id = ? AND code = ?`).get(connectorId, code) as Record<string, unknown> | undefined;
      return row ? rowToPairingSqlite(row) : null;
    },
    async listMessagingPairings(connectorId) {
      const rows = connectorId === undefined
        ? db.prepare(`SELECT * FROM messaging_pairings ORDER BY created_at DESC`).all()
        : db.prepare(`SELECT * FROM messaging_pairings WHERE connector_id = ? ORDER BY created_at DESC`).all(connectorId);
      return (rows as Array<Record<string, unknown>>).map(rowToPairingSqlite);
    },
    async deleteMessagingPairing(pairingId) {
      const info = db.prepare(`DELETE FROM messaging_pairings WHERE pairing_id = ?`).run(pairingId);
      return info.changes > 0;
    },
    async addMessagingAllowlist(entry) {
      db.prepare(
        `INSERT OR IGNORE INTO messaging_allowlist (entry_id, connector_id, tenant_id, channel, peer_id, added_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(entry.entryId, entry.connectorId, entry.tenantId, entry.channel, entry.peerId, entry.addedAt);
    },
    async getMessagingAllowlist(connectorId, channel, peerId) {
      const row = db.prepare(`SELECT * FROM messaging_allowlist WHERE connector_id = ? AND channel = ? AND peer_id = ?`).get(connectorId, channel, peerId) as Record<string, unknown> | undefined;
      return row ? rowToAllowlistSqlite(row) : null;
    },
    async listMessagingAllowlist(connectorId) {
      const rows = connectorId === undefined
        ? db.prepare(`SELECT * FROM messaging_allowlist ORDER BY added_at DESC`).all()
        : db.prepare(`SELECT * FROM messaging_allowlist WHERE connector_id = ? ORDER BY added_at DESC`).all(connectorId);
      return (rows as Array<Record<string, unknown>>).map(rowToAllowlistSqlite);
    },
    async deleteMessagingAllowlist(connectorId, channel, peerId) {
      const info = db.prepare(`DELETE FROM messaging_allowlist WHERE connector_id = ? AND channel = ? AND peer_id = ?`).run(connectorId, channel, peerId);
      return info.changes > 0;
    },

    async kvGet(key) {
      const row = db.prepare(`SELECT v FROM host_ext_kv WHERE k = ?`).get(key) as { v: string } | undefined;
      return row?.v ?? null;
    },
    async kvSet(key, value) {
      db.prepare(
        `INSERT INTO host_ext_kv (k, v, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      ).run(key, value, new Date().toISOString());
    },
    async kvList(keyPrefix) {
      const escaped = keyPrefix.replace(/[\\%_]/g, '\\$&');
      const rows = db
        .prepare(`SELECT k, v FROM host_ext_kv WHERE k LIKE ? ESCAPE '\\' ORDER BY k`)
        .all(`${escaped}%`) as Array<{ k: string; v: string }>;
      return rows.map((r) => ({ key: r.k, value: r.v }));
    },
    async kvListContaining(keyPrefix, needle) {
      // SQLite LIKE is case-INSENSITIVE for ASCII, which only WIDENS the superset —
      // the caller's exact filter still decides. Never narrower than the text.
      const esc = (s: string): string => s.replace(/[\\%_]/g, '\\$&');
      const rows = db
        .prepare(`SELECT k, v FROM host_ext_kv WHERE k LIKE ? ESCAPE '\\' AND v LIKE ? ESCAPE '\\' ORDER BY k`)
        .all(`${esc(keyPrefix)}%`, `%${esc(needle)}%`) as Array<{ k: string; v: string }>;
      return rows.map((r) => ({ key: r.k, value: r.v }));
    },
    async kvDelete(key) {
      const info = db.prepare(`DELETE FROM host_ext_kv WHERE k = ?`).run(key);
      return info.changes > 0;
    },
    async kvCompareAndSwap(key, expected, next) {
      // better-sqlite3 is synchronous + single-connection, so a transaction
      // gives a true atomic compare-then-set.
      const swap = db.transaction((k: string, exp: string | null, nxt: string) => {
        const row = db.prepare(`SELECT v FROM host_ext_kv WHERE k = ?`).get(k) as { v: string } | undefined;
        const actual = row?.v ?? null;
        if (actual !== exp) return { swapped: false, actual };
        db.prepare(
          `INSERT INTO host_ext_kv (k, v, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
        ).run(k, nxt, new Date().toISOString());
        return { swapped: true, actual: nxt };
      });
      return swap(key, expected, next);
    },

    async publish(channel, payload) {
      pubsub.emit(channel, payload);
    },
    async subscribe(channel, handler) {
      pubsub.on(channel, handler);
      return async () => {
        pubsub.off(channel, handler);
      };
    },

    // ── app metadata (ADR 0052) ──
    async getAppMeta(key) {
      const row = db.prepare(`SELECT value FROM __app_meta WHERE key = ?`).get(key) as
        | { value: string } | undefined;
      return row ? row.value : null;
    },
    async setAppMeta(key, value) {
      db.prepare(
        `INSERT INTO __app_meta (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, value, new Date().toISOString());
    },

    async close() {
      pubsub.removeAllListeners();
      db.close();
    },
  };
}

function rowToRelayDeviceSqlite(r: Record<string, unknown>): RelayDeviceRecord {
  return {
    relayId: r.relay_id as string,
    tenantId: r.tenant_id as string,
    channel: r.channel as RelayDeviceRecord['channel'],
    deviceName: (r.device_name as string | null) ?? undefined,
    status: r.status as RelayDeviceRecord['status'],
    deviceTokenHash: (r.device_token_hash as string | null) ?? undefined,
    tokenExpiresAt: (r.token_expires_at as string | null) ?? undefined,
    activationCode: (r.activation_code as string | null) ?? undefined,
    activationExpiresAt: (r.activation_expires_at as string | null) ?? undefined,
    registeredAt: r.registered_at as string,
    lastHeartbeatAt: (r.last_heartbeat_at as string | null) ?? undefined,
    lastReportedStatus: (r.last_reported_status as string | null) ?? undefined,
  };
}

function rowToEgressSqlite(r: Record<string, unknown>): ChatEgressEnvelope {
  return applyEgressExtra({
    egressId: r.egress_id as string,
    relayId: r.relay_id as string,
    channel: r.channel as ChatEgressEnvelope['channel'],
    conversationId: r.conversation_id as string,
    text: r.text as string,
    replyToMessageId: (r.reply_to_message_id as string | null) ?? undefined,
    enqueuedAt: r.enqueued_at as string,
  }, r.extra as string | null | undefined);
}

function rowToConnectorSqlite(r: Record<string, unknown>): MessagingConnectorRecord {
  return {
    connectorId: r.connector_id as string,
    tenantId: r.tenant_id as string,
    channel: r.channel as MessagingConnectorRecord['channel'],
    displayName: r.display_name as string,
    enabled: Boolean(r.enabled),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToSessionSqlite(r: Record<string, unknown>): MessagingSessionRecord {
  return {
    sessionKey: r.session_key as string,
    tenantId: r.tenant_id as string,
    channel: r.channel as MessagingSessionRecord['channel'],
    conversationId: r.conversation_id as string,
    peerId: r.peer_id as string,
    peerDisplay: (r.peer_display as string | null) ?? undefined,
    lastInboundAt: r.last_inbound_at as string,
    messageCount: Number(r.message_count),
    lastRunId: (r.last_run_id as string | null) ?? undefined,
  };
}

function rowToPolicySqlite(r: Record<string, unknown>): MessagingPolicyRecord {
  return {
    connectorId: r.connector_id as string,
    tenantId: r.tenant_id as string,
    dmPolicy: r.dm_policy as MessagingPolicyRecord['dmPolicy'],
    groupPolicy: r.group_policy as MessagingPolicyRecord['groupPolicy'],
    requireMention: Boolean(r.require_mention),
    updatedAt: r.updated_at as string,
  };
}

function rowToRoutingRuleSqlite(r: Record<string, unknown>): MessagingRoutingRuleRecord {
  return {
    ruleId: r.rule_id as string,
    tenantId: r.tenant_id as string,
    channel: (r.channel as MessagingRoutingRuleRecord['channel'] | null) ?? undefined,
    pattern: r.pattern as string,
    ...(r.workflow_id ? { workflowId: r.workflow_id as string } : {}),
    ...(r.agent_id ? { agentId: r.agent_id as string } : {}),
    priority: Number(r.priority),
    createdAt: r.created_at as string,
  };
}

function rowToIdentitySqlite(r: Record<string, unknown>): MessagingIdentityRecord {
  let peers: MessagingIdentityRecord['peers'] = [];
  try { peers = JSON.parse((r.peers as string) || '[]'); } catch { peers = []; }
  return {
    identityId: r.identity_id as string,
    tenantId: r.tenant_id as string,
    displayName: (r.display_name as string | null) ?? undefined,
    peers,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToPairingSqlite(r: Record<string, unknown>): MessagingPairingRecord {
  return {
    pairingId: r.pairing_id as string,
    connectorId: r.connector_id as string,
    tenantId: r.tenant_id as string,
    channel: r.channel as MessagingPairingRecord['channel'],
    peerId: r.peer_id as string,
    code: r.code as string,
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
  };
}

function rowToAllowlistSqlite(r: Record<string, unknown>): MessagingAllowlistEntry {
  return {
    entryId: r.entry_id as string,
    connectorId: r.connector_id as string,
    tenantId: r.tenant_id as string,
    channel: r.channel as MessagingAllowlistEntry['channel'],
    peerId: r.peer_id as string,
    addedAt: r.added_at as string,
  };
}

function rowToTurnSqlite(r: Record<string, unknown>): MessagingTurnRecord {
  return {
    turnId: r.turn_id as string,
    sessionKey: r.session_key as string,
    tenantId: r.tenant_id as string,
    role: r.role as MessagingTurnRecord['role'],
    content: r.content as string,
    runId: (r.run_id as string | null) ?? undefined,
    at: r.at as string,
  };
}

function rowToDeliveryLogSqlite(r: Record<string, unknown>): DeliveryLogRecord {
  return {
    logId: r.log_id as string,
    tenantId: r.tenant_id as string,
    relayId: (r.relay_id as string | null) ?? undefined,
    channel: r.channel as DeliveryLogRecord['channel'],
    direction: r.direction as DeliveryLogRecord['direction'],
    conversationId: r.conversation_id as string,
    status: r.status as string,
    detail: (r.detail as string | null) ?? undefined,
    at: r.at as string,
  };
}

function rowToPushSubscriptionSqlite(r: Record<string, unknown>): PushSubscriptionRecord {
  return {
    subscriptionId: r.subscription_id as string,
    tenantId: r.tenant_id as string,
    userId: (r.user_id as string | null) ?? undefined,
    endpoint: r.endpoint as string,
    p256dhKey: r.p256dh_key as string,
    authKey: r.auth_key as string,
    userAgent: (r.user_agent as string | null) ?? undefined,
    createdAt: r.created_at as string,
    lastUsedAt: (r.last_used_at as string | null) ?? undefined,
  };
}

function rowToNotificationSqlite(r: Record<string, unknown>): NotificationRecord {
  // sqlite stores metadata as a JSON string; parse opportunistically and
  // fall back to undefined on malformed data rather than crashing the list.
  let metadata: Record<string, unknown> | undefined;
  if (typeof r.metadata === 'string' && r.metadata.length > 0) {
    try { metadata = JSON.parse(r.metadata); } catch { metadata = undefined; }
  }
  return {
    notificationId: r.notification_id as string,
    tenantId: r.tenant_id as string,
    recipientUserId: (r.recipient_user_id as string | null) ?? undefined,
    recipientRole: (r.recipient_role as string | null) ?? undefined,
    type: r.type as string,
    priority: r.priority as NotificationRecord['priority'],
    status: r.status as NotificationRecord['status'],
    title: r.title as string,
    message: r.message as string,
    runId: (r.run_id as string | null) ?? undefined,
    workflowId: (r.workflow_id as string | null) ?? undefined,
    nodeId: (r.node_id as string | null) ?? undefined,
    interruptId: (r.interrupt_id as string | null) ?? undefined,
    actionUrl: (r.action_url as string | null) ?? undefined,
    metadata,
    createdAt: r.created_at as string,
    readAt: (r.read_at as string | null) ?? undefined,
    archivedAt: (r.archived_at as string | null) ?? undefined,
  };
}
