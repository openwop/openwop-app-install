/**
 * Postgres-backed Storage implementation.
 *
 * Targets Cloud SQL Postgres for the signed-in tier of the
 * app.openwop.dev demo (P3.3). Implements the same Storage interface
 * as sqlite + memory so the executor + routes don't care about the
 * backing store.
 *
 * Connection model:
 *   - One `pg.Pool` per process. Pool max is `OPENWOP_PG_POOL_MAX` (default 10),
 *     idleTimeoutMillis=30s.
 *   - **Connection BUDGET (load-bearing):** total connections ≈ `poolMax ×
 *     maxInstances`. This MUST stay under the Cloud SQL instance's
 *     `max_connections` (a `db-f1-micro` allows only ~25). Size it so
 *     `OPENWOP_PG_POOL_MAX × Cloud Run --max-instances ≤ max_connections − ~3`
 *     (the reserved superuser slots). Exceeding it manifests as
 *     `Connection terminated due to connection timeout` (the 10 s acquire wait) —
 *     which stalls in-flight runs (e.g. a chat stuck on "Thinking"). The
 *     app.openwop.dev demo runs db-f1-micro with maxScale=10, so it sets
 *     `OPENWOP_PG_POOL_MAX=4` + `--max-instances=5` (4×5=20 ≤ ~22).
 *   - The pool reconnects automatically on transient drops.
 *
 * Atomicity:
 *   - `appendEvent`         uses a single `WITH … INSERT` to read the
 *                            current max sequence and insert in one
 *                            statement (no explicit transaction needed).
 *   - `claimIdempotency`    uses `INSERT … ON CONFLICT DO NOTHING
 *                            RETURNING` to claim under a single round-trip.
 *   - `updateRun`           uses `UPDATE … RETURNING *` so we don't
 *                            need a SELECT-then-UPDATE pair.
 *
 * BYOK secrets carry an explicit tenant_id column (default `__global__`
 * for backward-compat). Sqlite/memory keep the flat shape; the
 * Postgres-backed flow gets per-tenant isolation for free.
 */

import { Pool, type PoolConfig } from 'pg';
import { aggregateHostExtTenantActivity, HOSTEXT_ACTIVITY_ROW_CAP } from '../hostExtActivity.js';
import { withRemovalStamp } from '../runRetentionStamp.js';
import { planHostExtRekey, rekeyTenantSegment, runBudgetBucketBelongsTo } from '../tenantMigration.js';
import { TERMINAL_RUN_STATUSES } from '@openwop/openwop';
import { randomUUID } from 'node:crypto';
import type { UsageLikeMatcher } from '../storage.js';
import type {
  ChatMessageRecord,
  ChatSessionRecord,
  DispatchOutboxRecord,
  EventRecord,
  InterruptRecord,
  NotificationRecord,
  PushSubscriptionRecord,
  RunRecord,
  UserAgentRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord,
} from '../../types.js';
import type {
  ChatEgressEnvelope,
  DeliveryLogRecord,
  MessagingConnectorRecord,
  MessagingIdentityRecord,
  MessagingPolicyRecord,
  MessagingRoutingRuleRecord,
  MessagingAllowlistEntry,
  MessagingPairingRecord,
  MessagingSessionRecord,
  MessagingTurnRecord,
  RelayDeviceRecord,
} from '../../messaging/types.js';
import { egressExtraJson, applyEgressExtra } from '../../messaging/types.js';
import { IdempotentCommitRejectedError, PAYLOAD_KEY_RE, RUN_FINAL_STATUSES, type Storage } from '../storage.js';
import { applyMigrations } from './schema.js';
import { createLogger } from '../../observability/logger.js';
import { isForwardExecutionEvent, RunLogClosedError, TERMINAL_RUN_EVENT_TYPES } from '../runLogClosure.js';

const log = createLogger('storage.postgres');

type Row = Record<string, unknown>;

/**
 * Serialize a value destined for a JSONB column.
 *
 * node-postgres marshals a JS ARRAY parameter as a Postgres ARRAY literal
 * (`{a,b}`) rather than JSON, and a JSONB column rejects that outright with
 * `invalid input syntax for type json`. Objects are unaffected — the driver
 * JSON-stringifies those — which is why the defect hid: every fixture in the
 * repo used object-shaped payloads, and the one test written to catch it
 * (`storage-adapter-parity-testcontainers.test.ts`) never executed, because its
 * `skipIf` predicate was computed before the `beforeAll` that probed for Docker.
 *
 * Use this for EVERY JSONB parameter whose type admits an array. Do NOT use it
 * for a column whose value is already a JSON STRING (e.g.
 * `webhook_deliveries.payload`, typed `string`) — that would double-encode.
 */
function jsonbParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function rowToRun(r: Row): RunRecord {
  return {
    runId: r.run_id as string,
    workflowId: r.workflow_id as string,
    tenantId: r.tenant_id as string,
    scopeId: (r.scope_id as string | null) ?? undefined,
    status: r.status as RunRecord['status'],
    inputs: r.inputs ?? null,
    metadata: (r.metadata as Record<string, unknown> | null) ?? {},
    configurable: (r.configurable as Record<string, unknown> | null) ?? {},
    callbackUrl: (r.callback_url as string | null) ?? undefined,
    idempotencyKey: (r.idempotency_key as string | null) ?? undefined,
    parentRunId: (r.parent_run_id as string | null) ?? undefined,
    parentSeq: (r.parent_seq as number | null) ?? undefined,
    forkMode: (r.fork_mode as RunRecord['forkMode'] | null) ?? undefined,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
    completedAt: r.completed_at ? (r.completed_at as Date).toISOString() : undefined,
    removalAt: r.removal_at ? (r.removal_at as Date).toISOString() : undefined,
    currentNodeId: (r.current_node_id as string | null) ?? undefined,
    schedulerSnapshot: (r.scheduler_snapshot as string | null) ?? undefined,
    dispatchOwner: (r.dispatch_owner as string | null) ?? null,
    // BIGINT — pg returns it as a string; coerce via Number(...), preserve null.
    dispatchLeaseExpiresAt:
      r.dispatch_lease_expires_at == null ? null : Number(r.dispatch_lease_expires_at),
    // v2 charter P4-C — the era key. `undefined` (not `2`) for a pre-cut row;
    // `eraOf()` is the single place absence becomes `2`.
    eventLogSchemaVersion:
      r.event_log_schema_version == null ? undefined : Number(r.event_log_schema_version),
    ...(r.error_code
      ? { error: { code: r.error_code as string, message: (r.error_message as string | null) ?? '' } }
      : {}),
  };
}

function rowToEvent(r: Row): EventRecord {
  return {
    eventId: r.event_id as string,
    runId: r.run_id as string,
    sequence: r.sequence as number,
    type: r.type as string,
    nodeId: (r.node_id as string | null) ?? undefined,
    payload: r.payload ?? null,
    timestamp: (r.timestamp as Date).toISOString(),
    causationId: (r.causation_id as string | null) ?? undefined,
  };
}

function rowToInterrupt(r: Row): InterruptRecord {
  return {
    interruptId: r.interrupt_id as string,
    runId: r.run_id as string,
    nodeId: r.node_id as string,
    kind: r.kind as InterruptRecord['kind'],
    token: r.token as string,
    data: r.data ?? null,
    resumeSchema: (r.resume_schema as Record<string, unknown> | null) ?? undefined,
    createdAt: (r.created_at as Date).toISOString(),
    expiresAt: r.expires_at ? (r.expires_at as Date).toISOString() : undefined,
    resolvedAt: r.resolved_at ? (r.resolved_at as Date).toISOString() : undefined,
    resolvedValue: r.resolved_value ?? undefined,
  };
}

function rowToNotification(r: Row): NotificationRecord {
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
    metadata: (r.metadata as Record<string, unknown> | null) ?? undefined,
    createdAt: (r.created_at as Date).toISOString(),
    readAt: r.read_at ? (r.read_at as Date).toISOString() : undefined,
    archivedAt: r.archived_at ? (r.archived_at as Date).toISOString() : undefined,
  };
}

function rowToPushSubscription(r: Row): PushSubscriptionRecord {
  return {
    subscriptionId: r.subscription_id as string,
    tenantId: r.tenant_id as string,
    userId: (r.user_id as string | null) ?? undefined,
    endpoint: r.endpoint as string,
    p256dhKey: r.p256dh_key as string,
    authKey: r.auth_key as string,
    userAgent: (r.user_agent as string | null) ?? undefined,
    createdAt: (r.created_at as Date).toISOString(),
    lastUsedAt: r.last_used_at ? (r.last_used_at as Date).toISOString() : undefined,
  };
}

function rowToUserAgent(r: Row): UserAgentRecord {
  return {
    agentId: r.agent_id as string,
    tenantId: r.tenant_id as string,
    persona: r.persona as string,
    label: (r.label as string | null) ?? undefined,
    description: (r.description as string | null) ?? undefined,
    modelClass: r.model_class as string,
    systemPrompt: r.system_prompt as string,
    // Postgres returns JSONB as a parsed object/array already — sqlite
    // returns a string; the two paths converge to a string[] here.
    toolAllowlist: Array.isArray(r.tool_allowlist)
      ? (r.tool_allowlist as string[])
      : (typeof r.tool_allowlist === 'string'
          ? (JSON.parse(r.tool_allowlist) as string[])
          : []),
    memoryShape: {
      scratchpad: r.memory_scratchpad === true,
      conversation: r.memory_conversation === true,
      longTerm: r.memory_long_term === true,
    },
    confidenceThreshold: (r.confidence_threshold as number | null) ?? undefined,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

function rowToWebhook(r: Row): WebhookSubscriptionRecord {
  return {
    subscriptionId: r.subscription_id as string,
    // Pre-migration rows carry NULL; they belong to the default tenant.
    tenantId: (r.tenant_id as string | null) ?? 'default',
    url: r.url as string,
    events: (r.events as string[] | null) ?? [],
    tags: (r.tags as string[] | null) ?? undefined,
    secret: r.secret as string,
    createdAt: (r.created_at as Date).toISOString(),
    // NULL (pre-migration or a v1 registration) MEANS major 1.
    ...(Number(r.protocol_major) === 2 ? { protocolMajor: 2 as const } : {}),
    // ADR 0747 — NULL means a non-opted (`["v1"]`) subscription; see the field doc.
    ...(Array.isArray(r.signature_algorithms) ? { signatureAlgorithms: r.signature_algorithms as string[] } : {}),
    ...(typeof r.previous_secret === 'string' ? { previousSecret: r.previous_secret } : {}),
    ...(r.previous_secret_expires_at != null ? { previousSecretExpiresAt: Number(r.previous_secret_expires_at) } : {}),
    ...(r.rotated_at != null ? { rotatedAt: Number(r.rotated_at) } : {}),
  };
}

function rowToDispatchOutbox(r: Row): DispatchOutboxRecord {
  // `next_attempt_at` / `claim_expires_at` are BIGINT — pg returns those as
  // strings, so coerce. `created_at` / `updated_at` are TEXT ISO-8601 here
  // (unlike webhook_deliveries' epoch-ms BIGINTs) because the outbox row is
  // written with the RUN's `createdAt`, which is already an ISO string.
  return {
    runId: r.run_id as string,
    tenantId: r.tenant_id as string,
    workflowId: r.workflow_id as string,
    status: r.status as DispatchOutboxRecord['status'],
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    claimedBy: (r.claimed_by as string | null) ?? null,
    claimExpiresAt: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
    lastError: (r.last_error as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function rowToWebhookDelivery(r: Row): WebhookDeliveryRecord {
  // Epoch-ms columns are BIGINT — pg returns them as strings, so coerce
  // every one via Number(...). `claim_expires_at` is nullable; preserve null.
  return {
    deliveryId: r.delivery_id as string,
    subscriptionId: r.subscription_id as string,
    wireSubscriptionId: (r.wire_subscription_id as string | null) ?? null,
    tenantId: (r.tenant_id as string | null | undefined) ?? null,
    url: r.url as string,
    secret: r.secret as string,
    eventType: r.event_type as string,
    payload: r.payload as string,
    status: r.status as WebhookDeliveryRecord['status'],
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    claimedBy: (r.claimed_by as string | null) ?? null,
    claimExpiresAt: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
    lastError: (r.last_error as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export interface PostgresStorageOptions extends PoolConfig {
  connectionString: string;
}

/** Every public table with a `tenant_id` column, from the live catalog (memoized
 *  per Pool). The single source of truth for tenant-scoped bulk ops (ADR 0003
 *  Phase 4c, mirrors the sqlite adapter) — introspection, so a new tenant table
 *  is covered automatically. */
const tenantTablesPgCache = new WeakMap<Pool, string[]>();
async function tenantScopedTablesPg(pool: Pool): Promise<string[]> {
  const cached = tenantTablesPgCache.get(pool);
  if (cached) return cached;
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'
     ORDER BY table_name`,
  );
  const names = rows.map((r) => r.table_name);
  tenantTablesPgCache.set(pool, names);
  return names;
}

/**
 * Build the `listAudit` query. Extracted (and exported) because the `sinceIso`
 * binding is a real prod-only failure mode worth a hermetic ratchet:
 * `audit_log.timestamp` is TIMESTAMPTZ, so an ABSENT `sinceIso` must DROP the
 * clause — binding `''` makes Postgres reject the empty string as a timestamp
 * and the whole read 500s. The sqlite adapter stores the column as TEXT, where
 * `>= ''` is a harmless always-true string compare, so every test passed while
 * the CDP compliance tab's governance-decision log (and the superadmin
 * `/governance/audit` read, which also defaults `since` to undefined) was dead
 * in production.
 */
export function buildListAuditQuery(
  filter?: { actionPrefix?: string; resource?: string; sinceIso?: string; beforeIso?: string; limit?: number },
): { sql: string; params: unknown[] } {
  const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
  const params: unknown[] = [`${(filter?.actionPrefix ?? '').replace(/[%_\\]/g, '\\$&')}%`];
  let sinceClause = '';
  // Exact-match subject pushdown (idx_audit_resource_ts). EXACT, not LIKE:
  // resource strings are structured ids (`user:<id>`), and a prefix semantics
  // here would let `user:a` read `user:ab`'s rows.
  if (filter?.resource) {
    params.push(filter.resource);
    sinceClause = ` AND resource = $${params.length}`;
  }
  if (filter?.sinceIso) {
    params.push(filter.sinceIso);
    sinceClause += ` AND timestamp >= $${params.length}::timestamptz`;
  }
  // Paging cursor (INCLUSIVE — pagers dedupe same-timestamp boundary rows).
  if (filter?.beforeIso) {
    params.push(filter.beforeIso);
    sinceClause += ` AND timestamp <= $${params.length}::timestamptz`;
  }
  params.push(limit);
  return {
    sql: `SELECT audit_id, timestamp, principal_id, action, resource, outcome, payload
           FROM audit_log
          WHERE action LIKE $1${sinceClause}
          ORDER BY timestamp DESC
          LIMIT $${params.length}`,
    params,
  };
}

export async function openPostgresStorage(options: PostgresStorageOptions | string): Promise<Storage> {
  const opts: PostgresStorageOptions =
    typeof options === 'string' ? { connectionString: options } : options;
  // Pool max is env-tunable so a deploy can fit the connection budget to its
  // Cloud SQL `max_connections` (see the header note): `poolMax × maxInstances`
  // MUST stay under it, or connection acquisition times out and stalls in-flight
  // runs. Default 10; clamped ≥ 1.
  const poolMax = Math.max(1, Number(process.env.OPENWOP_PG_POOL_MAX ?? 10) || 10);
  const pool = new Pool({
    max: poolMax,
    idleTimeoutMillis: 30_000,
    // Bound how long we wait to acquire a connection and how long a single
    // statement may run, so a stuck query can't hold a pool slot forever
    // (DATA-1). Both overridable through the caller's opts.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    // statement_timeout bounds a single statement; a multi-statement
    // transaction that stalls between statements could still pin a slot beyond
    // the per-statement budget. idle_in_transaction_session_timeout bounds that
    // idle gap (DATA-2) — server-side, widely supported (PG ≥ 9.6). Tunable via
    // OPENWOP_PG_IDLE_IN_TXN_TIMEOUT_MS for deploys whose batch transactions
    // legitimately idle longer (0 disables); still overridable through opts.
    idle_in_transaction_session_timeout:
      Number(process.env.OPENWOP_PG_IDLE_IN_TXN_TIMEOUT_MS ?? 60_000),
    ...opts,
  });

  // A pooled client can emit 'error' asynchronously while idle (server-side
  // termination, network reset). node-pg re-raises this on the Pool, and an
  // UNHANDLED 'error' here crashes the Node process — the classic pg footgun.
  // Log and swallow: the pool evicts the broken client and hands out a fresh
  // one on the next acquire (DATA-1). The LISTEN client has its own handler.
  pool.on('error', (err) => {
    log.error('pg_pool_idle_client_error', { error: err instanceof Error ? err.message : String(err) });
  });

  // Surface the effective pool max at startup — the connection-budget knob
  // (`poolMax × maxInstances` vs Cloud SQL max_connections) is the first thing to
  // check when runs stall on `Connection terminated due to connection timeout`.
  log.info('pg_pool_configured', { poolMax });

  // Run migrations once at boot. Single dedicated client; avoid
  // holding a pool slot for the duration of DDL.
  const migrationClient = await pool.connect();
  try {
    await applyMigrations(migrationClient);
  } finally {
    migrationClient.release();
  }

  // ── cross-instance pub/sub via LISTEN/NOTIFY ──
  // One physical channel (`openwop_host_ext`) multiplexes all logical
  // channels; the payload is `{ c: logicalChannel, p: payload }`. A single
  // dedicated connection (held out of the pool) LISTENs and fans incoming
  // notifications to the registered handlers. It self-heals on connection drop.
  const PUBSUB_CHANNEL = 'openwop_host_ext';
  const channelHandlers = new Map<string, Set<(payload: string) => void>>();
  let listenClient: import('pg').PoolClient | null = null;
  let listenStarting: Promise<void> | null = null;
  let closing = false;

  async function startListener(): Promise<void> {
    const client = await pool.connect();
    client.on('notification', (msg) => {
      if (msg.channel !== PUBSUB_CHANNEL || !msg.payload) return;
      try {
        const { c, p } = JSON.parse(msg.payload) as { c: string; p: string };
        const handlers = channelHandlers.get(c);
        if (handlers) for (const h of handlers) {
          try { h(p); } catch { /* a handler must not break delivery */ }
        }
      } catch { /* ignore a malformed payload */ }
    });
    client.on('error', () => {
      // Connection dropped: reset + re-establish if anyone is still listening.
      if (listenClient === client) listenClient = null;
      try { client.release(); } catch { /* already gone */ }
      if (!closing && channelHandlers.size > 0) {
        setTimeout(() => { void ensureListener().catch(() => undefined); }, 1000);
      }
    });
    await client.query(`LISTEN ${PUBSUB_CHANNEL}`);
    listenClient = client;
  }

  async function ensureListener(): Promise<void> {
    if (listenClient || closing) return;
    if (!listenStarting) {
      listenStarting = startListener().finally(() => { listenStarting = null; });
    }
    await listenStarting;
  }

  const INSERT_RUN_SQL = `INSERT INTO runs (
          run_id, workflow_id, tenant_id, scope_id, status,
          inputs, metadata, configurable, callback_url,
          idempotency_key, parent_run_id, parent_seq, fork_mode,
          created_at, updated_at, completed_at, error_code, error_message,
          current_node_id, scheduler_snapshot, event_log_schema_version
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
        )`;

  const insertRunParams = (run: RunRecord): unknown[] => [
    run.runId, run.workflowId, run.tenantId, run.scopeId ?? null, run.status,
    // ADR 0549 review — every one of these is a JSONB column, and
    // `inputs` is typed `unknown` and arrives VERBATIM from the
    // `POST /v1/runs` request body. A client sending a top-level array
    // (`"inputs": [1,2,3]`) made run creation fail outright on Postgres,
    // the production adapter. See `jsonbParam` for the mechanism.
    jsonbParam(run.inputs),
    jsonbParam(run.metadata ?? {}),
    jsonbParam(run.configurable ?? {}),
    run.callbackUrl ?? null,
    run.idempotencyKey ?? null,
    run.parentRunId ?? null,
    run.parentSeq ?? null,
    run.forkMode ?? null,
    run.createdAt, run.updatedAt, run.completedAt ?? null,
    run.error?.code ?? null, run.error?.message ?? null,
    run.currentNodeId ?? null,
    run.schedulerSnapshot ?? null,
    // v2 charter P4-C — the era key (schema mig 41). Mirrors the sqlite adapter:
    // NULL is the v1 era, and the storage seat is the only thing that ever puts
    // a non-NULL here.
    run.eventLogSchemaVersion ?? null,
  ];

  const INSERT_DISPATCH_OUTBOX_SQL = `INSERT INTO dispatch_outbox (
          run_id, tenant_id, workflow_id, status, attempts,
          next_attempt_at, claimed_by, claim_expires_at, last_error,
          created_at, updated_at
        ) VALUES ($1,$2,$3,'pending',0,$4,NULL,NULL,NULL,$5,$5)`;

  // ADR 0549 P1 compare-and-set commit; ONE text so `insertRun`'s in-transaction
  // commit (H56) and `completeIdempotentResponse` cannot drift apart.
  const COMPLETE_IDEMPOTENT_RESPONSE_SQL = `UPDATE idempotent_response
            SET state = 'completed', response_status = $4, response_body = $5,
                run_id = $6, updated_at = $7::timestamptz
          WHERE tenant_id = $1 AND endpoint_id = $2 AND idempotency_key = $3
            AND state <> 'completed' AND claim_token = $8`;

  const impl: Storage = {
    async insertRun(run, opts) {
      if (!opts?.dispatchOutbox && !opts?.idempotencyCommit) {
        await pool.query(INSERT_RUN_SQL, insertRunParams(run));
        return;
      }
      // ADR 0551 P1 — the run and its dispatch intent commit TOGETHER. A
      // pooled `pool.query` pair would be two autocommitted statements with a
      // crash window between them, which is precisely the window the outbox
      // exists to close, so this takes a dedicated connection and one
      // BEGIN/COMMIT.
      // ADR 0549 H56 — the HTTP idempotency commit rides in the SAME
      // BEGIN/COMMIT (`InsertRunOptions.idempotencyCommit`). Its UPDATE is the
      // compare-and-set from `completeIdempotentResponse`; zero rows means the
      // claim was reclaimed while this holder ran, and the ROLLBACK below takes
      // the run + outbox rows with it. Must match the SQLite adapter exactly.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(INSERT_RUN_SQL, insertRunParams(run));
        if (opts.dispatchOutbox) {
          await client.query(INSERT_DISPATCH_OUTBOX_SQL, [
            run.runId, run.tenantId, run.workflowId,
            opts.dispatchOutbox.nextAttemptAt, run.createdAt,
          ]);
        }
        if (opts.idempotencyCommit) {
          const c = opts.idempotencyCommit;
          const res = await client.query(COMPLETE_IDEMPOTENT_RESPONSE_SQL, [
            c.tenantId, c.endpoint, c.key, c.responseStatus, c.responseBody,
            run.runId, c.updatedAt, c.claimToken,
          ]);
          if ((res.rowCount ?? 0) === 0) throw new IdempotentCommitRejectedError(c.key);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
        throw err;
      } finally {
        client.release();
      }
    },

    async getRun(runId) {
      const { rows } = await pool.query<Row>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async updateRun(runId, rawPatch) {
      const patch = withRemovalStamp(rawPatch);
      const existing = await impl.getRun(runId);
      if (!existing) return;
      const merged: RunRecord = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      // COLUMN-SCOPED write: only the fields present in `patch` (plus
      // updated_at) are SET — see the sqlite adapter for the race this closes
      // (concurrent disjoint-field writers clobbering each other's columns).
      const has = (k: keyof RunRecord): boolean => Object.prototype.hasOwnProperty.call(patch, k);
      const sets: string[] = [];
      const values: unknown[] = [];
      const add = (column: string, value: unknown): void => {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      };
      add('updated_at', merged.updatedAt);
      if (has('status')) add('status', merged.status);
      if (has('removalAt')) add('removal_at', merged.removalAt ?? null);
      if (has('inputs')) add('inputs', merged.inputs ?? null);
      if (has('metadata')) add('metadata', merged.metadata ?? {});
      if (has('configurable')) add('configurable', merged.configurable ?? {});
      if (has('callbackUrl')) add('callback_url', merged.callbackUrl ?? null);
      if (has('completedAt')) add('completed_at', merged.completedAt ?? null);
      if (has('error')) {
        add('error_code', merged.error?.code ?? null);
        add('error_message', merged.error?.message ?? null);
      }
      if (has('currentNodeId')) add('current_node_id', merged.currentNodeId ?? null);
      if (has('schedulerSnapshot')) add('scheduler_snapshot', merged.schedulerSnapshot ?? null);
      values.push(runId);
      await pool.query(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = $${values.length}`, values);
    },

    async mergeRunMetadata(runId, patch, opts) {
      // ONE atomic statement — no read-modify-write window (grade-code H2).
      // `ifAbsentKey` folds the never-overwrite check into the same statement.
      // RFC 7396 semantics to match sqlite's json_patch: a `null` value
      // DELETES the key. Returns wrote (ADR 0482 C1 — the fold ticket).
      const removals = Object.keys(patch).filter((k) => patch[k] === null);
      const sets = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
      const res = await pool.query(
        `UPDATE runs
           SET metadata = (COALESCE(metadata, '{}'::jsonb) || $2::jsonb) - $5::text[],
               updated_at = $3
         WHERE run_id = $1
           AND ($4::text IS NULL OR NOT (COALESCE(metadata, '{}'::jsonb) ? $4::text))`,
        [runId, JSON.stringify(sets), new Date().toISOString(), opts?.ifAbsentKey ?? null, removals],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async listRuns({ tenantId, workflowId, status, limit = 100, before }) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM runs
         WHERE ($1::text IS NULL OR tenant_id = $1)
           AND ($2::text IS NULL OR status = $2)
           AND ($4::text IS NULL OR workflow_id = $4)
           AND ($5::timestamptz IS NULL
                OR created_at < $5::timestamptz
                OR (created_at = $5::timestamptz AND run_id < $6))
         ORDER BY created_at DESC, run_id DESC
         LIMIT $3`,
        [tenantId ?? null, status ?? null, limit, workflowId ?? null, before?.createdAt ?? null, before?.runId ?? null],
      );
      return rows.map(rowToRun);
    },

    async listRunsByParent(parentRunId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM runs WHERE parent_run_id = $1 ORDER BY created_at ASC`,
        [parentRunId],
      );
      return rows.map(rowToRun);
    },

    async hasRunForWorkflow(workflowId, filter) {
      const { rows } = filter?.status
        ? await pool.query<{ one: number }>(
            `SELECT 1 AS one FROM runs WHERE workflow_id = $1 AND status = $2 LIMIT 1`,
            [workflowId, filter.status],
          )
        : await pool.query<{ one: number }>(
            `SELECT 1 AS one FROM runs WHERE workflow_id = $1 LIMIT 1`,
            [workflowId],
          );
      return rows.length > 0;
    },

    async listRunsPastRemoval(now, limit) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM runs WHERE removal_at IS NOT NULL AND removal_at < $1 ORDER BY removal_at ASC LIMIT $2`,
        [now, limit],
      );
      return rows.map(rowToRun);
    },

    async clearRunRemoval(runId) {
      await pool.query(`UPDATE runs SET removal_at = NULL WHERE run_id = $1`, [runId]);
    },

    async listTenantActivity(tenantPrefix, limit) {
      // ADR 0372 — activity evidence per tenant. `metadata->>'schedule' IS
      // NULL` = a human/API-initiated run (the scheduler stamps every run it
      // fires; scheduleDaemon.ts spreads the block LAST so it can't be
      // spoofed away). Prefix matched on an escaped LIKE (tenant ids are
      // host-minted, but never trust a prefix into LIKE unescaped).
      const esc = tenantPrefix.replace(/[\\%_]/g, (m) => `\\${m}`);
      const { rows } = await pool.query<{ tenant_id: string; first_run_at: string | null; last_human_run_at: string | null; last_chat_at: string | null }>(
        `SELECT r.tenant_id,
                min(r.created_at)::text AS first_run_at,
                max(CASE WHEN r.metadata->>'schedule' IS NULL THEN r.created_at END)::text AS last_human_run_at,
                (SELECT to_char(max(c.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM chat_sessions c WHERE c.tenant_id = r.tenant_id) AS last_chat_at
         FROM runs r
         WHERE r.tenant_id LIKE $1
         GROUP BY r.tenant_id
         ORDER BY r.tenant_id
         LIMIT $2`,
        [`${esc}%`, limit],
      );
      return rows.map((x) => ({
        tenantId: x.tenant_id,
        firstRunAt: x.first_run_at ?? null,
        lastHumanRunAt: x.last_human_run_at ?? null,
        lastChatAt: x.last_chat_at ?? null,
      }));
    },

    async listHostExtTenantActivity(tenantPrefix, limit) {
      // Grade-pass DATA-1 (review H1) — SQL only PREFILTERS: `k LIKE
      // 'hostext:%'` restricts to the keyspace `purgeTenantHostExt` can
      // actually clear (indexed trailing-wildcard — never a whole-store scan
      // over durable-surface/bus payloads whose nested tenantIds the teardown
      // can't purge), the value LIKE narrows candidates. The AUTHORITATIVE
      // top-level extraction is the shared TS aggregator (adapter parity).
      const esc = tenantPrefix.replace(/[\\%_]/g, (m) => `\\${m}`);
      const { rows } = await pool.query<{ v: string; updated_at: string }>(
        `SELECT v, updated_at FROM host_ext_kv
         WHERE k LIKE 'hostext:%' AND v LIKE $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [`%"tenantId":"${esc}%`, HOSTEXT_ACTIVITY_ROW_CAP],
      );
      const agg = aggregateHostExtTenantActivity(rows.map((r) => ({ v: r.v, updatedAt: r.updated_at })), tenantPrefix, limit);
      if (agg.length === 0) return [];
      const { rows: chats } = await pool.query<{ tenant_id: string; last: string | null }>(
        // to_char at UTC (grade-pass F-7): the bare ::text render is
        // 'YYYY-MM-DD hh:mm:ss+00' — a SPACE at position 10 string-compares
        // below 'T', so a same-day chat touch read as stale vs the ISO cutoff.
        `SELECT tenant_id, to_char(max(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last FROM chat_sessions WHERE tenant_id = ANY($1::text[]) GROUP BY tenant_id`,
        [agg.map((a) => a.tenantId)],
      );
      const chatBy = new Map(chats.map((c) => [c.tenant_id, c.last]));
      return agg.map((a) => ({ ...a, lastChatAt: chatBy.get(a.tenantId) ?? null }));
    },

    async appendEvent(input) {
      const eventId = input.eventId || randomUUID();
      // Serialize per-run via a transaction-scoped advisory lock so
      // concurrent appends can't both read MAX(sequence) before either
      // INSERTs. Without this, parallel critic dispatches (Triple-AI
      // fan-out: 3 chat-responder nodes each emitting reasoning.delta
      // + openwop-app.node.message + node.completed events concurrently) race on
      // sequence-assignment and one INSERT loses to the unique
      // constraint `events_run_id_sequence_key`, crashing the run
      // with "inline dispatch failed" — observed 2026-05-25 against
      // run 31c2b04c-… (only chat_2 + chat_6 completed; chat_4 never
      // started because the executor crashed in mid-emit).
      //
      // pg_advisory_xact_lock takes two int4 keys; we partition the
      // 64-bit hashtext namespace into (run_id-hash, scope-tag). The
      // scope tag (1 = events.append) lets us add other per-run
      // serialized regions later without aliasing.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 1)', [input.runId]);
        // RFC 0194 §A — the STORE is the authority for the closed log: this
        // check runs under the per-run lock every appender takes, so it holds
        // across instances (a cancel on one, the executor on another).
        if (isForwardExecutionEvent(input.type)) {
          const closed = await client.query<{ type: string }>(
            `SELECT type FROM events WHERE run_id = $1 AND type = ANY($2) LIMIT 1`,
            [input.runId, TERMINAL_RUN_EVENT_TYPES],
          );
          if (closed.rows[0]) throw new RunLogClosedError(input.runId, input.type, closed.rows[0].type);
        }
        const { rows } = await client.query<Row>(
          `WITH next AS (
             SELECT COALESCE(MAX(sequence) + 1, 0) AS seq FROM events WHERE run_id = $1
           )
           INSERT INTO events (event_id, run_id, sequence, type, node_id, payload, timestamp, causation_id)
           SELECT $2, $1, next.seq, $3, $4, $5, $6, $7 FROM next
           RETURNING event_id, run_id, sequence, type, node_id, payload, timestamp, causation_id`,
          [
            input.runId, eventId, input.type, input.nodeId ?? null,
            jsonbParam(input.payload), input.timestamp, input.causationId ?? null,
          ],
        );
        await client.query('COMMIT');
        return rowToEvent(rows[0]!);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
        throw err;
      } finally {
        client.release();
      }
    },

    async appendEventsBatch(inputs) {
      if (inputs.length === 0) return [];
      const withIds = inputs.map((i) => ({ ...i, eventId: i.eventId || randomUUID() }));
      const runIds = [...new Set(withIds.map((i) => i.runId))];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Same per-run serialization as appendEvent (advisory lock per run), so a
        // concurrent appender can't race sequence assignment.
        for (const rid of runIds) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 1)', [rid]);
        }
        // One read of the current max sequence per run.
        const { rows: maxRows } = await client.query<{ run_id: string; max: string }>(
          `SELECT run_id, COALESCE(MAX(sequence), -1)::text AS max FROM events WHERE run_id = ANY($1) GROUP BY run_id`,
          [runIds],
        );
        // -1 = empty log ⇒ the first append of the batch takes sequence 0 (RFC 0171 §A.3).
        const nextSeq = new Map<string, number>(runIds.map((r) => [r, -1]));
        for (const row of maxRows) nextSeq.set(row.run_id, Number(row.max));

        const tuples: string[] = [];
        const params: unknown[] = [];
        const out: EventRecord[] = [];
        let p = 0;
        for (const e of withIds) {
          const seq = (nextSeq.get(e.runId) ?? -1) + 1;
          nextSeq.set(e.runId, seq);
          tuples.push(`($${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p},$${++p})`);
          params.push(e.eventId, e.runId, seq, e.type, e.nodeId ?? null, e.payload ?? null, e.timestamp, e.causationId ?? null);
          out.push({ ...e, sequence: seq });
        }
        // One multi-row INSERT — the round-trip win over N appendEvent calls.
        await client.query(
          `INSERT INTO events (event_id, run_id, sequence, type, node_id, payload, timestamp, causation_id) VALUES ${tuples.join(',')}`,
          params,
        );
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
        throw err;
      } finally {
        client.release();
      }
    },

    async listEvents(runId, opts = {}) {
      const fromSeq = opts.fromSeq ?? -1;
      const limit = opts.limit ?? 1000;
      const { rows } = await pool.query<Row>(
        `SELECT * FROM events
         WHERE run_id = $1 AND sequence > $2
         ORDER BY sequence ASC
         LIMIT $3`,
        [runId, fromSeq, limit],
      );
      return rows.map(rowToEvent);
    },

    async findFirstEventByPayload(runId, type, payloadKey, payloadValue) {
      if (!PAYLOAD_KEY_RE.test(payloadKey)) throw new Error(`findFirstEventByPayload: invalid payload key ${payloadKey}`);
      const { rows } = await pool.query<Row>(
        `SELECT * FROM events
         WHERE run_id = $1 AND type = $2 AND payload->>$3 = $4
         ORDER BY sequence ASC
         LIMIT 1`,
        [runId, type, payloadKey, payloadValue],
      );
      return rows[0] ? rowToEvent(rows[0]) : null;
    },

    async getMaxSequence(runId) {
      const { rows } = await pool.query<{ max: string | number | null }>(
        `SELECT COALESCE(MAX(sequence), -1) AS max FROM events WHERE run_id = $1`,
        [runId],
      );
      return Number(rows[0]?.max ?? -1);
    },

    async insertInterrupt(record) {
      await pool.query(
        `INSERT INTO interrupts (interrupt_id, run_id, node_id, kind, token, data, resume_schema, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          record.interruptId, record.runId, record.nodeId, record.kind, record.token,
          // Same JSONB marshalling trap as `insertWebhook` above, and confirmed
          // by probe: node-postgres turns a JS ARRAY into a Postgres array
          // literal that JSONB rejects. `data` and `resumeSchema` are typed
          // `unknown`, so an array is entirely legal here — an interrupt
          // offering a list of choices was simply unstorable on Postgres.
          // Objects were unaffected (node-postgres JSON-stringifies those),
          // which is why every existing fixture passed.
          jsonbParam(record.data),
          jsonbParam(record.resumeSchema),
          record.createdAt,
          record.expiresAt ?? null,
        ],
      );
    },

    async getInterrupt(interruptId) {
      const { rows } = await pool.query<Row>(`SELECT * FROM interrupts WHERE interrupt_id = $1`, [interruptId]);
      return rows[0] ? rowToInterrupt(rows[0]) : null;
    },

    async getInterruptByToken(token) {
      const { rows } = await pool.query<Row>(`SELECT * FROM interrupts WHERE token = $1`, [token]);
      return rows[0] ? rowToInterrupt(rows[0]) : null;
    },

    async getInterruptByNode(runId, nodeId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM interrupts
         WHERE run_id = $1 AND node_id = $2 AND resolved_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [runId, nodeId],
      );
      return rows[0] ? rowToInterrupt(rows[0]) : null;
    },

    async resolveInterrupt(interruptId, resolvedValue, resolvedAt) {
      // CONDITIONAL on resolved_at IS NULL — rowCount is 1 iff this call won the
      // resolve, 0 if it was already resolved (ENG-6).
      const res = await pool.query(
        `UPDATE interrupts SET resolved_at = $1, resolved_value = $2
         WHERE interrupt_id = $3 AND resolved_at IS NULL`,
        // `resolvedValue` is `unknown` and comes from the resume request body.
        [resolvedAt, jsonbParam(resolvedValue), interruptId],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async listOpenInterrupts(runId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM interrupts WHERE run_id = $1 AND resolved_at IS NULL`,
        [runId],
      );
      return rows.map(rowToInterrupt);
    },

    async listOpenInterruptsAll(limit) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM interrupts WHERE resolved_at IS NULL ORDER BY created_at ASC LIMIT $1`,
        [limit],
      );
      return rows.map(rowToInterrupt);
    },

    async insertWebhook(record) {
      await pool.query(
        `INSERT INTO webhooks (subscription_id, tenant_id, url, events, tags, secret, created_at, protocol_major, signature_algorithms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          record.subscriptionId, record.tenantId, record.url,
          // `events`/`tags` are JSONB columns, so the arrays MUST be serialized
          // by hand. Passing a JS array lets node-postgres marshal it as a
          // Postgres ARRAY literal (`{a,b}`), which JSONB rejects outright with
          // `invalid input syntax for type json` — i.e. webhook registration
          // was broken on every Postgres deployment.
          //
          // This is the first entry in this file's own `PG_MEM_INCOMPAT` list,
          // and `storage-adapter-parity-testcontainers.test.ts` was written to
          // catch exactly it. That test never ran: its `skipIf` predicate was a
          // module-level const computed before the `beforeAll` that probed for
          // Docker, so it was permanently `true`. Un-skipping the file is what
          // surfaced this.
          JSON.stringify(record.events),
          record.tags ? JSON.stringify(record.tags) : null,
          record.secret, record.createdAt,
          // NULL for a v1 registration — read back as major 1.
          record.protocolMajor ?? null,
          // JSONB — serialized by hand for the same reason as `events` above.
          record.signatureAlgorithms ? JSON.stringify(record.signatureAlgorithms) : null,
        ],
      );
    },

    async rotateWebhookSecret(subscriptionId, rotation) {
      // ONE statement: the SET list's right-hand sides read the row as it was
      // before this UPDATE, so `previous_secret = secret` captures the secret
      // being replaced (ADR 0747; see the Storage doc).
      const res = await pool.query(
        `UPDATE webhooks
            SET previous_secret = secret, secret = $2, previous_secret_expires_at = $3, rotated_at = $4
          WHERE subscription_id = $1`,
        [subscriptionId, rotation.secret, rotation.previousSecretExpiresAt, rotation.rotatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async retireExpiredWebhookSecrets(now) {
      // Row-atomic: a rotation racing this UPDATE either lands first (its new,
      // future expiry fails the WHERE on re-check) or after (it re-sets the column).
      const res = await pool.query(
        `UPDATE webhooks SET previous_secret = NULL
          WHERE previous_secret IS NOT NULL AND previous_secret_expires_at <= $1`,
        [now],
      );
      return res.rowCount ?? 0;
    },

    async blankTerminalDeliverySecrets(limit) {
      const res = await pool.query(
        `UPDATE webhook_deliveries SET secret = ''
          WHERE delivery_id IN (
            SELECT delivery_id FROM webhook_deliveries
             WHERE status IN ('delivered','dead') AND secret <> '' LIMIT $1)`,
        [limit],
      );
      return res.rowCount ?? 0;
    },

    async getWebhook(subscriptionId) {
      const { rows } = await pool.query<Row>(`SELECT * FROM webhooks WHERE subscription_id = $1`, [subscriptionId]);
      return rows[0] ? rowToWebhook(rows[0]) : null;
    },

    async deleteWebhook(subscriptionId) {
      // WHD-16 — unregistering STOPS delivery: the subscription's PENDING rows go
      // with it, in one statement. Left behind, they kept POSTing signed events to
      // a URL its owner had withdrawn — and, retrying, starved every live
      // subscription queued behind them. Delivered/dead rows are kept (history).
      //
      // RFC 0215 §B (ADR 0752) — and nothing enqueued CONCURRENTLY survives it. The
      // single-statement form could not promise that: its snapshot is taken when
      // the statement starts, so a fan-out INSERT committing mid-statement left a
      // fresh pending row for a subscription that no longer existed, and the
      // worker attempted it after the 204. Now the subscription row is locked
      // FIRST (`FOR UPDATE`), which waits out any in-progress conditional enqueue
      // (it holds `FOR SHARE` on the same row), and the delivery DELETE runs as a
      // later statement with a fresh READ COMMITTED snapshot that sees that
      // insert. An enqueue arriving after the lock sees no subscription, and
      // inserts nothing. A row claimed and in flight is still `pending`, so it
      // goes too: the attempt may complete (§B permits it), and its reschedule
      // then matches no row, so no retry is ever started.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM webhooks WHERE subscription_id = $1 FOR UPDATE`, [subscriptionId]);
        await client.query(
          `DELETE FROM webhook_deliveries WHERE subscription_id = $1 AND status = 'pending'`,
          [subscriptionId],
        );
        await client.query(`DELETE FROM webhooks WHERE subscription_id = $1`, [subscriptionId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async listWebhooks({ eventType, tags, tenantId }) {
      // WHDATA-2 — tenant scope is enforced in SQL, not only by the JS filter
      // below. RFC 0093 §A.3 makes cross-tenant delivery a protocol violation,
      // so the isolation should be structural: a future refactor that reorders
      // or short-circuits the predicate chain cannot widen it past the WHERE.
      // The JS check is deliberately KEPT as a redundant second gate (and it
      // still covers the pre-migration NULL -> 'default' mapping rowToWebhook
      // applies, which SQL alone would not).
      const { rows } = tenantId === undefined
        ? await pool.query<Row>(`SELECT * FROM webhooks`)
        : await pool.query<Row>(
            `SELECT * FROM webhooks WHERE tenant_id = $1 OR (tenant_id IS NULL AND $1 = 'default')`,
            [tenantId],
          );
      const all = rows.map(rowToWebhook);
      return all.filter((sub) => {
        // RFC 0093 §A.3 — tenant scope is exact-match; cross-tenant
        // subscriptions never match regardless of filter breadth.
        if (tenantId !== undefined && sub.tenantId !== tenantId) return false;
        if (eventType && !sub.events.includes(eventType) && !sub.events.includes('*')) return false;
        const subTags = sub.tags;
        if (tags && tags.length > 0 && subTags && subTags.length > 0) {
          const hasTag = tags.some((t) => subTags.includes(t));
          if (!hasTag) return false;
        }
        return true;
      });
    },

    // ── webhook deliveries (durable retry queue) ──
    async enqueueWebhookDelivery(record, opts) {
      // RFC 0215 §B — `requireSubscription` inserts only while the subscription
      // exists, holding `FOR SHARE` on it so `deleteWebhook` (which takes
      // `FOR UPDATE` first) cannot interleave. See `deleteWebhook`.
      const values = opts?.requireSubscription
        ? `SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
            WHERE EXISTS (SELECT 1 FROM webhooks WHERE subscription_id = $2 FOR SHARE)`
        : `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`;
      const res = await pool.query(
        `INSERT INTO webhook_deliveries (
          delivery_id, subscription_id, wire_subscription_id, url, secret, event_type, payload,
          status, attempts, max_attempts, next_attempt_at,
          claimed_by, claim_expires_at, last_error, created_at, updated_at, tenant_id
        ) ${values}`,
        [
          record.deliveryId, record.subscriptionId, record.wireSubscriptionId ?? null, record.url, record.secret,
          record.eventType, record.payload, record.status,
          record.attempts, record.maxAttempts, record.nextAttemptAt,
          record.claimedBy ?? null, record.claimExpiresAt ?? null,
          record.lastError ?? null, record.createdAt, record.updatedAt, record.tenantId ?? null,
        ],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async claimDueWebhookDeliveries(workerId, now, leaseMs, limit, opts) {
      // Multi-instance-safe claim: the locking SELECT picks the due rows and
      // takes a row lock with FOR UPDATE SKIP LOCKED so concurrent workers on
      // other instances skip rows already being claimed; the outer UPDATE then
      // stamps the lease and RETURNs the claimed rows in one statement.
      //
      // RFC 0215 §A lanes (ADR 0752): with `onePerSubscription` the candidates
      // are each subscription's OLDEST due row (`DISTINCT ON`), minus the
      // subscriptions this instance already has in flight. `DISTINCT ON` cannot
      // carry `FOR UPDATE`, so it narrows the candidates in an unlocked subquery
      // and the locking layer re-states the due predicate; READ COMMITTED
      // re-checks it against the latest row version when it takes the lock.
      const exclude = opts?.excludeSubscriptionIds ?? [];
      const excludeTenants = opts?.excludeTenantIds ?? [];
      const lanes = opts?.onePerSubscription === true;
      const params: unknown[] = [workerId, now + leaseMs, now, now, limit];
      const bind = (v: unknown): string => {
        params.push(v);
        return `$${params.length}`;
      };
      // §A.3 (ADR 0752 P2): tenants at their in-flight cap. A NULL tenant_id row
      // predates the column and is never excluded.
      const tenantClause = excludeTenants.length > 0
        ? `AND (tenant_id IS NULL OR NOT (tenant_id = ANY(${bind([...excludeTenants])}::text[])))`
        : '';
      const due = `status = 'pending'
               AND next_attempt_at <= $4
               AND (claim_expires_at IS NULL OR claim_expires_at < $4)
               ${tenantClause}`;
      const subClause = lanes || exclude.length > 0
        ? `AND NOT (subscription_id = ANY(${bind([...exclude])}::text[]))`
        : '';
      const candidates = lanes
        ? `AND delivery_id IN (
               SELECT DISTINCT ON (subscription_id) delivery_id FROM webhook_deliveries
                WHERE ${due} ${subClause}
                ORDER BY subscription_id, next_attempt_at ASC, delivery_id ASC
             )`
        : subClause;
      const { rows } = await pool.query<Row>(
        `UPDATE webhook_deliveries
            SET claimed_by = $1, claim_expires_at = $2, updated_at = $3
          WHERE delivery_id IN (
            SELECT delivery_id FROM webhook_deliveries
             WHERE ${due}
               ${candidates}
             ORDER BY next_attempt_at ASC
             LIMIT $5
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        params,
      );
      return rows.map(rowToWebhookDelivery);
    },

    async markWebhookDeliveryDelivered(deliveryId, now) {
      await pool.query(
        `UPDATE webhook_deliveries
            SET status = 'delivered', updated_at = $2,
                claimed_by = NULL, claim_expires_at = NULL, secret = ''
          WHERE delivery_id = $1`,
        [deliveryId, now],
      );
    },

    async rescheduleWebhookDelivery(deliveryId, now, nextAttemptAt, dead, error) {
      await pool.query(
        `UPDATE webhook_deliveries
            SET attempts = attempts + 1,
                last_error = $2,
                claimed_by = NULL,
                claim_expires_at = NULL,
                updated_at = $3,
                status = CASE WHEN $4 THEN 'dead' ELSE 'pending' END,
                secret = CASE WHEN $4 THEN '' ELSE secret END,
                next_attempt_at = $5
          WHERE delivery_id = $1 AND status != 'delivered'`,
        [deliveryId, error, now, dead, nextAttemptAt],
      );
    },

    async listWebhookDeliveries({ subscriptionIds, status, limit = 200 }) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (subscriptionIds !== undefined) {
        if (subscriptionIds.length === 0) return [];
        params.push([...subscriptionIds]);
        clauses.push(`subscription_id = ANY($${params.length})`);
      }
      if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      params.push(limit);
      const { rows } = await pool.query(
        `SELECT * FROM webhook_deliveries ${where} ORDER BY next_attempt_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToWebhookDelivery);
    },

    async retryWebhookDelivery(deliveryId, now) {
      // GRADE-CODE 2026-07-17 — never re-arm a row a worker is CURRENTLY
      // delivering (live lease); dead rows always re-arm (sqlite twin).
      const res = await pool.query(
        `UPDATE webhook_deliveries
            SET status = 'pending', attempts = 0, next_attempt_at = $2,
                claimed_by = NULL, claim_expires_at = NULL, updated_at = $2
          WHERE delivery_id = $1 AND status != 'delivered'
            AND (status = 'dead' OR claim_expires_at IS NULL OR claim_expires_at < $2)`,
        [deliveryId, now],
      );
      return (res.rowCount ?? 0) > 0;
    },

    // ── RFC 0059 workspace (ADR 0551 P0) ──
    async getWorkspaceFile(tenantId, workspaceId, path) {
      const { rows } = await pool.query(
        `SELECT path, content, content_type, version, etag, size_bytes, updated_at
           FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2 AND path = $3`,
        [tenantId, workspaceId, path],
      );
      const r = rows[0];
      return r
        ? {
            path: r.path as string, content: r.content as string,
            contentType: r.content_type as string, version: r.version as number,
            etag: r.etag as string, sizeBytes: r.size_bytes as number,
            updatedAt: (r.updated_at as Date).toISOString(),
          }
        : null;
    },
    async listWorkspaceFiles(tenantId, workspaceId, prefix) {
      const { rows } = prefix === undefined
        ? await pool.query(
            `SELECT path, content_type, version, etag, size_bytes, updated_at
               FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2 ORDER BY path`,
            [tenantId, workspaceId],
          )
        : await pool.query(
            `SELECT path, content_type, version, etag, size_bytes, updated_at
               FROM workspace_files
              WHERE tenant_id = $1 AND workspace_id = $2 AND path LIKE $3 ESCAPE '\\'
              ORDER BY path`,
            [tenantId, workspaceId, `${prefix.replace(/[%_\\]/g, '\\$&')}%`],
          );
      return rows.map((r) => ({
        path: r.path as string, contentType: r.content_type as string,
        version: r.version as number, etag: r.etag as string,
        sizeBytes: r.size_bytes as number, updatedAt: (r.updated_at as Date).toISOString(),
      }));
    },
    async putWorkspaceFile(input) {
      // ONE statement does the compare-and-set. The `WHERE` on the DO UPDATE is
      // the CAS: it applies only when the stored etag still matches what the
      // caller saw, so two instances racing the same file cannot both win —
      // which the module-Map version could not prevent, its CAS being
      // instance-local.
      const sizeBytes = Buffer.byteLength(input.content, 'utf8');
      if (input.ifMatch === undefined) {
        // No If-Match: create-or-replace, version = current + 1.
        //
        // ONE TRANSACTION, not two autocommitted statements (H59, 2026-08-18).
        // The etag depends on the final version, which only the upsert knows,
        // so it is stamped by a second statement. Left unsynchronised those two
        // interleave: A upserts to v2, B upserts to v3, B stamps etag(v3,B), A
        // then stamps etag(v2,A) OVER it — the row is (v3, contentB) carrying
        // an etag derived from content it never held. Everything downstream
        // treats the etag as content-derived (`workspace-durability.test.ts`
        // asserts exactly that), and an If-Match CAS would then accept a
        // caller who had never seen the current bytes.
        //
        // The upsert's row lock is held to COMMIT, so a racing writer blocks
        // rather than interleaving, and each writer stamps its own version.
        // The sqlite adapter already did this — it wraps the pair in
        // `db.transaction` — so this is also an adapter-parity fix.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(
            `INSERT INTO workspace_files
               (tenant_id, workspace_id, path, content, content_type, version, etag, size_bytes, updated_at)
             VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8::timestamptz)
             ON CONFLICT (tenant_id, workspace_id, path) DO UPDATE SET
               content = EXCLUDED.content, content_type = EXCLUDED.content_type,
               version = workspace_files.version + 1,
               size_bytes = EXCLUDED.size_bytes, updated_at = EXCLUDED.updated_at
             RETURNING version`,
            [input.tenantId, input.workspaceId, input.path, input.content, input.contentType,
             input.etagFor(1, input.content), sizeBytes, input.updatedAt],
          );
          const version = rows[0]!.version as number;
          const etag = input.etagFor(version, input.content);
          await client.query(
            `UPDATE workspace_files SET etag = $4
              WHERE tenant_id = $1 AND workspace_id = $2 AND path = $3`,
            [input.tenantId, input.workspaceId, input.path, etag],
          );
          await client.query('COMMIT');
          return {
            ok: true,
            row: { path: input.path, content: input.content, contentType: input.contentType,
                   version, etag, sizeBytes, updatedAt: input.updatedAt },
          };
        } catch (err) {
          await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
          throw err;
        } finally {
          client.release();
        }
      }
      const { rows: cur } = await pool.query(
        `SELECT version, etag FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2 AND path = $3`,
        [input.tenantId, input.workspaceId, input.path],
      );
      const existing = cur[0];
      if (!existing || (existing.etag as string) !== input.ifMatch) {
        return { ok: false, currentVersion: (existing?.version as number | undefined) ?? 0 };
      }
      const version = (existing.version as number) + 1;
      const etag = input.etagFor(version, input.content);
      const upd = await pool.query(
        `UPDATE workspace_files
            SET content = $4, content_type = $5, version = $6, etag = $7,
                size_bytes = $8, updated_at = $9::timestamptz
          WHERE tenant_id = $1 AND workspace_id = $2 AND path = $3 AND etag = $10`,
        [input.tenantId, input.workspaceId, input.path, input.content, input.contentType,
         version, etag, sizeBytes, input.updatedAt, input.ifMatch],
      );
      // The `AND etag = $10` predicate lost ⇒ another writer moved it between
      // our SELECT and UPDATE. Report a conflict rather than clobbering.
      if ((upd.rowCount ?? 0) === 0) {
        return { ok: false, currentVersion: existing.version as number };
      }
      return {
        ok: true,
        row: { path: input.path, content: input.content, contentType: input.contentType,
               version, etag, sizeBytes, updatedAt: input.updatedAt },
      };
    },
    async deleteWorkspaceFile(tenantId, workspaceId, path) {
      const { rowCount } = await pool.query(
        `DELETE FROM workspace_files WHERE tenant_id = $1 AND workspace_id = $2 AND path = $3`,
        [tenantId, workspaceId, path],
      );
      return (rowCount ?? 0) > 0;
    },

    async claimIdempotentResponse(input) {
      // ADR 0549 — one statement decides the outcome, so there is no window
      // between "is there a row" and "what does it say". The INSERT wins or
      // the ON CONFLICT DO NOTHING loses; only the loser reads.
      const claimExpiresAt = new Date(Date.parse(input.createdAt) + input.leaseMs).toISOString();
      const firstToken = randomUUID();
      const ins = await pool.query(
        `INSERT INTO idempotent_response
           (tenant_id, endpoint_id, idempotency_key, request_digest, state,
            claim_token, claim_expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'pending',$5,$6::timestamptz,$7::timestamptz,$7::timestamptz)
         ON CONFLICT (tenant_id, endpoint_id, idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [input.tenantId, input.endpoint, input.key, input.requestDigest, firstToken, claimExpiresAt, input.createdAt],
      );
      if (ins.rowCount === 1) return { outcome: 'claimed', claimToken: firstToken };
      const { rows } = await pool.query(
        `SELECT request_digest, state, response_status, response_body, claim_token, claim_expires_at
           FROM idempotent_response
          WHERE tenant_id = $1 AND endpoint_id = $2 AND idempotency_key = $3`,
        [input.tenantId, input.endpoint, input.key],
      );
      // NOT "reachable only when a row exists" — that comment was wrong, and the
      // `!` it justified was a 500 waiting for a race.
      //
      // The INSERT conflicted, so a row existed at THAT instant. Between the
      // conflict and this SELECT the winner can finish and its `finally` can
      // release the pending row (`DELETE ... WHERE claim_token = ...`), leaving
      // this read empty. `rows[0]!` then made `r.request_digest` throw a
      // TypeError, and the caller got a 500 for a request that should simply
      // have re-claimed. SQLite is immune — its claim is one transaction — so
      // this is a production-adapter-only defect, on the path that decides
      // whether a retry duplicates a run.
      //
      // The row vanishing means nobody owns the key any more, so the honest
      // answer is to try the claim again. Bounded to ONE retry: a second empty
      // read means something other than a race is happening, and a loop here
      // would turn a storage anomaly into a hot spin on the request path.
      if (rows.length === 0) {
        const retry = await pool.query(
          `INSERT INTO idempotent_response
             (tenant_id, endpoint_id, idempotency_key, request_digest, state,
              claim_token, claim_expires_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'pending',$5,$6::timestamptz,$7::timestamptz,$7::timestamptz)
           ON CONFLICT (tenant_id, endpoint_id, idempotency_key) DO NOTHING
           RETURNING idempotency_key`,
          [input.tenantId, input.endpoint, input.key, input.requestDigest, firstToken, claimExpiresAt, input.createdAt],
        );
        if (retry.rowCount === 1) return { outcome: 'claimed', claimToken: firstToken };
        const again = await pool.query(
          `SELECT request_digest, state, response_status, response_body, claim_token, claim_expires_at
             FROM idempotent_response
            WHERE tenant_id = $1 AND endpoint_id = $2 AND idempotency_key = $3`,
          [input.tenantId, input.endpoint, input.key],
        );
        if (again.rows.length === 0) {
          throw new Error(
            'idempotent_response row vanished twice between conflict and read — the claim keyspace is not behaving as a keyspace',
          );
        }
        rows.push(again.rows[0]);
      }
      const r = rows[0]!;
      if ((r.request_digest as string) !== input.requestDigest) return { outcome: 'mismatch' };
      if ((r.state as string) === 'completed') {
        return {
          outcome: 'replay',
          responseStatus: (r.response_status as number | null) ?? 200,
          responseBody: (r.response_body as string | null) ?? '',
        };
      }
      // ADR 0549 P1 — pending. An EXPIRED lease means the holder is dead (a
      // live one cannot outlive a lease derived from the request timeout), so
      // reclaim. The `claim_token IS NOT DISTINCT FROM` predicate is the
      // compare-and-set — two callers racing to reclaim the same dead claim
      // cannot both win, and it tolerates a NULL token on legacy rows.
      const reclaimToken = randomUUID();
      const re = await pool.query(
        `UPDATE idempotent_response
            SET claim_token = $4, claim_expires_at = $5::timestamptz, updated_at = $6::timestamptz
          WHERE tenant_id = $1 AND endpoint_id = $2 AND idempotency_key = $3
            AND state = 'pending'
            AND claim_expires_at < $6::timestamptz
            AND claim_token IS NOT DISTINCT FROM $7
          RETURNING idempotency_key`,
        [
          input.tenantId, input.endpoint, input.key,
          reclaimToken, claimExpiresAt, input.createdAt,
          (r.claim_token as string | null),
        ],
      );
      // `reclaimed` distinguishes THIS branch from a first claim for ADR 0556
      // P1's recovery signal — the CAS predicate above is what makes it a fact
      // rather than an assumption. Must match the SQLite adapter exactly; the
      // adapter-parity suite is what holds the two together.
      if (re.rowCount === 1) return { outcome: 'claimed', claimToken: reclaimToken, reclaimed: true };
      return { outcome: 'in-flight' };
    },
    async completeIdempotentResponse(input) {
      const res = await pool.query(
        COMPLETE_IDEMPOTENT_RESPONSE_SQL,
        [
          input.tenantId,
          input.endpoint,
          input.key,
          input.responseStatus,
          input.responseBody,
          input.runId ?? null,
          input.updatedAt,
          input.claimToken,
        ],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async releaseIdempotentResponse(input) {
      await pool.query(
        `DELETE FROM idempotent_response
          WHERE tenant_id = $1 AND endpoint_id = $2 AND idempotency_key = $3
            AND claim_token = $4 AND state <> 'completed'`,
        [input.tenantId, input.endpoint, input.key, input.claimToken],
      );
    },
    async pruneIdempotentResponses(olderThanIso) {
      const { rowCount } = await pool.query(
        `DELETE FROM idempotent_response WHERE created_at < $1::timestamptz`,
        [olderThanIso],
      );
      return rowCount ?? 0;
    },

    async claimOnce(key, createdAt) {
      // INSERT … ON CONFLICT DO NOTHING — returns row only if we won
      // the insert. If empty, fetch the existing record.
      const ins = await pool.query<Row>(
        `INSERT INTO idempotency (key, response_body, response_status, created_at)
         VALUES ($1, '__pending__', 0, $2)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, createdAt],
      );
      if (ins.rowCount === 1) return { claimed: true, existing: null };
      const { rows } = await pool.query<Row>(
        `SELECT key, response_body, response_status, created_at FROM idempotency WHERE key = $1`,
        [key],
      );
      // Reachable only when the INSERT hit the (key) UNIQUE conflict,
      // which means a row already exists with that key. The SELECT
      // therefore returns exactly one row.
      const r = rows[0]!;
      return {
        claimed: false,
        existing: {
          key: r.key as string,
          responseBody: r.response_body as string,
          responseStatus: r.response_status as number,
          createdAt: (r.created_at as Date).toISOString(),
        },
      };
    },

    async putOnce(record) {
      await pool.query(
        `INSERT INTO idempotency (key, response_body, response_status, created_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET
           response_body = EXCLUDED.response_body,
           response_status = EXCLUDED.response_status,
           created_at = EXCLUDED.created_at`,
        [record.key, record.responseBody, record.responseStatus, record.createdAt],
      );
    },
    async pruneOnceByPrefix(keyPrefix, olderThanIso) {
      const escaped = keyPrefix.replace(/[%_\\]/g, '\\$&');
      const { rowCount } = await pool.query(
        `DELETE FROM idempotency WHERE key LIKE $1 AND created_at < $2::timestamptz`,
        [`${escaped}%`, olderThanIso],
      );
      return rowCount ?? 0;
    },

    async countAuditRows() {
      const { rows } = await pool.query<{ n: string | number }>(`SELECT count(*) AS n FROM audit_log`);
      return Number(rows[0]?.n ?? 0);
    },

    async appendAudit(input) {
      await pool.query(
        `INSERT INTO audit_log (audit_id, timestamp, principal_id, action, resource, outcome, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(), input.timestamp, input.principalId ?? null,
          input.action, input.resource ?? null, input.outcome ?? null,
          input.payload ?? null,
        ],
      );
    },

    async listAudit(filter) {
      const { sql, params } = buildListAuditQuery(filter);
      const { rows } = await pool.query<{
        audit_id: string;
        timestamp: string;
        principal_id: string | null;
        action: string;
        resource: string | null;
        outcome: string | null;
        payload: unknown;
      }>(sql, params);
      return rows.map((r) => ({
        auditId: r.audit_id,
        timestamp: r.timestamp,
        action: r.action,
        ...(r.principal_id !== null ? { principalId: r.principal_id } : {}),
        ...(r.resource !== null ? { resource: r.resource } : {}),
        ...(r.outcome !== null ? { outcome: r.outcome } : {}),
        ...(r.payload !== null && r.payload !== undefined ? { payload: r.payload } : {}),
      }));
    },

    async getInvocation({ runId, nodeId, attempt, invocationId }) {
      const { rows } = await pool.query<{ result: unknown }>(
        `SELECT result FROM invocation_log
         WHERE run_id = $1 AND node_id = $2 AND attempt = $3 AND invocation_id = $4`,
        [runId, nodeId, attempt, invocationId],
      );
      return rows[0]?.result ?? null;
    },

    // ADR 0549 P3 — the retry-stable read (RFC 0150 §B). Newest outcome for the
    // logical effect identity, whatever attempt produced it.
    async getLatestInvocation({ runId, nodeId, invocationId }) {
      const { rows } = await pool.query<{ result: unknown }>(
        `SELECT result FROM invocation_log
         WHERE run_id = $1 AND node_id = $2 AND invocation_id = $3
         ORDER BY attempt DESC LIMIT 1`,
        [runId, nodeId, invocationId],
      );
      return rows[0]?.result ?? null;
    },

    async putInvocation({ runId, nodeId, attempt, invocationId }, result) {
      await pool.query(
        `INSERT INTO invocation_log (run_id, node_id, attempt, invocation_id, result, created_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (run_id, node_id, attempt, invocation_id) DO UPDATE SET
           result = EXCLUDED.result,
           created_at = EXCLUDED.created_at`,
        [runId, nodeId, attempt, invocationId, jsonbParam(result)],
      );
    },
    async claimInvocation({ runId, nodeId, invocationId }, { nowMs, staleAfterMs }) {
      // ONE statement: `INSERT … ON CONFLICT DO UPDATE … WHERE` is atomic, so the
      // insert-if-absent and the stale-takeover cannot interleave between two
      // instances. `rowCount > 0` iff THIS caller now holds the claim.
      const res = await pool.query(
        `INSERT INTO invocation_claim (run_id, node_id, invocation_id, claimed_at)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (run_id, node_id, invocation_id) DO UPDATE SET claimed_at = $4
           WHERE invocation_claim.claimed_at < $5`,
        [runId, nodeId, invocationId, nowMs, nowMs - staleAfterMs],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async releaseInvocationClaim({ runId, nodeId, invocationId }) {
      await pool.query(
        `DELETE FROM invocation_claim WHERE run_id = $1 AND node_id = $2 AND invocation_id = $3`,
        [runId, nodeId, invocationId],
      );
    },

    // ADR 0591 — plain INSERT with NO `ON CONFLICT DO UPDATE`. The upsert just
    // above is correct for the memo table; here an overwrite would destroy the
    // very evidence the row exists to preserve. A duplicate `escape_seq` SHOULD
    // raise rather than silently collapse.
    async appendEffectEscape({ runId, nodeId, invocationId, effectKind, createdAt }) {
      await pool.query(
        `INSERT INTO effect_escape_ledger
           (run_id, node_id, invocation_id, effect_kind, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [runId, nodeId, invocationId, effectKind, createdAt],
      );
    },

    async listRunEffects(runId) {
      // See the sqlite twin: `result IS NOT NULL` excludes the `__pending__`
      // placeholder the atomic claim writes, so an in-flight claim is not
      // projected as a completed effect.
      const res = await pool.query(
        `SELECT node_id AS "nodeId", attempt, invocation_id AS "invocationId",
                (result IS NOT NULL) AS completed, created_at AS at
           FROM invocation_log
          WHERE run_id = $1
          ORDER BY created_at, node_id, attempt`,
        [runId],
      );
      return res.rows.map((r: { nodeId: string; attempt: number; invocationId: string; completed: boolean; at: unknown }) => ({
        nodeId: r.nodeId,
        attempt: Number(r.attempt),
        invocationId: r.invocationId,
        completed: Boolean(r.completed),
        at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      }));
    },

    async listEffectEscapes(runId) {
      const res = await pool.query(
        `SELECT invocation_id AS "invocationId", node_id AS "nodeId", COUNT(*)::int AS count
           FROM effect_escape_ledger
          WHERE run_id = $1
          GROUP BY invocation_id, node_id
          ORDER BY invocation_id`,
        [runId],
      );
      return res.rows as Array<{ invocationId: string; nodeId: string; count: number }>;
    },

    async upsertEncryptedSecret(credentialRef, encryptedRecordJson, now) {
      // Backend signature stays flat (no tenantId) — sqlite has the same
      // shape. The byok_secrets table has tenant_id with a __global__
      // default so legacy callers keep working. KMS-encrypted per-tenant
      // BYOK (P3.4) writes via a different path that respects tenantId.
      await pool.query(
        `INSERT INTO byok_secrets (credential_ref, tenant_id, encrypted_record, created_at, updated_at)
         VALUES ($1, '__global__', $2, $3, $3)
         ON CONFLICT (tenant_id, credential_ref) DO UPDATE SET
           encrypted_record = EXCLUDED.encrypted_record,
           updated_at = EXCLUDED.updated_at`,
        [credentialRef, encryptedRecordJson, now],
      );
    },

    async getEncryptedSecret(credentialRef) {
      const { rows } = await pool.query<{ encrypted_record: string }>(
        `SELECT encrypted_record FROM byok_secrets WHERE tenant_id = '__global__' AND credential_ref = $1`,
        [credentialRef],
      );
      return rows[0]?.encrypted_record ?? null;
    },

    async deleteSecret(credentialRef) {
      await pool.query(
        `DELETE FROM byok_secrets WHERE tenant_id = '__global__' AND credential_ref = $1`,
        [credentialRef],
      );
    },

    async listSecretRefs() {
      const { rows } = await pool.query<{ credential_ref: string }>(
        `SELECT credential_ref FROM byok_secrets WHERE tenant_id = '__global__' ORDER BY credential_ref ASC`,
      );
      return rows.map((r) => r.credential_ref);
    },

    async upsertTenantSecret(tenantId, credentialRef, encryptedRecordJson, now) {
      await pool.query(
        `INSERT INTO byok_secrets (credential_ref, tenant_id, encrypted_record, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (tenant_id, credential_ref) DO UPDATE SET
           encrypted_record = EXCLUDED.encrypted_record,
           updated_at = EXCLUDED.updated_at`,
        [credentialRef, tenantId, encryptedRecordJson, now],
      );
    },

    async getTenantSecret(tenantId, credentialRef) {
      const { rows } = await pool.query<{ encrypted_record: string }>(
        `SELECT encrypted_record FROM byok_secrets WHERE tenant_id = $1 AND credential_ref = $2`,
        [tenantId, credentialRef],
      );
      return rows[0]?.encrypted_record ?? null;
    },

    async deleteTenantSecret(tenantId, credentialRef) {
      await pool.query(
        `DELETE FROM byok_secrets WHERE tenant_id = $1 AND credential_ref = $2`,
        [tenantId, credentialRef],
      );
    },

    async listTenantSecretRefs(tenantId) {
      const { rows } = await pool.query<{ credential_ref: string }>(
        `SELECT credential_ref FROM byok_secrets WHERE tenant_id = $1 ORDER BY credential_ref ASC`,
        [tenantId],
      );
      return rows.map((r) => r.credential_ref);
    },

    async deleteAllTenantSecrets(tenantId) {
      const res = await pool.query(`DELETE FROM byok_secrets WHERE tenant_id = $1`, [tenantId]);
      return res.rowCount ?? 0;
    },

    async deleteRun(runId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM events WHERE run_id = $1`, [runId]);
        await client.query(`DELETE FROM interrupts WHERE run_id = $1`, [runId]);
        await client.query(`DELETE FROM invocation_log WHERE run_id = $1`, [runId]);
        // ADR 0618 — see the sqlite adapter: run-keyed, cascades with the run.
        await client.query(`DELETE FROM invocation_claim WHERE run_id = $1`, [runId]);
        // ADR 0591 — mirrors sqlite: run-keyed, no tenant_id, retires with the run.
        await client.query(`DELETE FROM effect_escape_ledger WHERE run_id = $1`, [runId]);
        await client.query(`DELETE FROM annotations WHERE run_id = $1`, [runId]);
        // Grade-pass DEL-1 (2026-07-15) — cascade parity with pruneTerminalRuns:
        // the API delete previously orphaned envelope correlations, the agent
        // activity index row, AND every runartifact kv row (the same gap the
        // ADR 0287 correction closed for retention).
        await client.query(`DELETE FROM envelope_correlations WHERE run_id = $1`, [runId]);
        await client.query(`DELETE FROM agent_run_activity WHERE run_id = $1`, [runId]);
        // Grade-data G3 (2026-07-09) — per-run kv write-throughs (variable bag /
        // channel state / agent stamp) retire with the run (mirrors sqlite).
        await client.query(`DELETE FROM host_ext_kv WHERE k = ANY($1::text[])`, [[`runvars:${runId}`, `runchans:${runId}`, `runagent:${runId}`]]);
        const ridEsc = runId.replace(/[\\%_]/g, (m) => `\\${m}`);
        await client.query(`DELETE FROM host_ext_kv WHERE k LIKE $1`, [`hostext:runartifact:${ridEsc}:%`]);
        const rr = await client.query(`DELETE FROM runs WHERE run_id = $1`, [runId]);
        await client.query('COMMIT');
        return (rr.rowCount ?? 0) > 0;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    // ── run dispatch lease (multi-instance crash recovery) ──
    async setRunDispatchLease(runId, owner, leaseExpiresAt) {
      // Best-effort stamp; a missing run updates 0 rows (no-op). Does NOT
      // touch updated_at — the lease is a dispatch-control column, orthogonal
      // to the run's logical updated_at.
      await pool.query(
        `UPDATE runs SET dispatch_owner = $2, dispatch_lease_expires_at = $3
          WHERE run_id = $1`,
        [runId, owner, leaseExpiresAt],
      );
    },

    async claimRunExecution(runId, owner, nowMs, leaseExpiresAt) {
      // ADR 0740 — the EXECUTION CLAIM. Predicate kept IDENTICAL to the sqlite
      // arm; see `Storage.claimRunExecution` for why each disjunct exists. A
      // single UPDATE takes the row lock, so two contenders serialise and the
      // second re-evaluates the predicate against the first one's write.
      const res = await pool.query(
        `UPDATE runs SET dispatch_owner = $2, dispatch_lease_expires_at = $4
          WHERE run_id = $1
            AND status NOT IN ('completed', 'failed', 'cancelled')
            AND (
              dispatch_owner IS NULL
              OR dispatch_lease_expires_at IS NULL
              OR dispatch_lease_expires_at < $3
              OR status IN ('paused', 'waiting-approval', 'waiting-input', 'waiting-external')
            )`,
        [runId, owner, nowMs, leaseExpiresAt],
      );
      if ((res.rowCount ?? 0) > 0) return 'claimed';
      const row = await pool.query<{ status: string }>(`SELECT status FROM runs WHERE run_id = $1`, [runId]);
      const status = row.rows[0]?.status;
      if (status === undefined) return 'missing';
      return (RUN_FINAL_STATUSES as readonly string[]).includes(status) ? 'not-runnable' : 'held';
    },

    async renewRunDispatchLeaseIfOwner(runId, owner, leaseExpiresAt) {
      // ADR 0585 P0b — the RENEWAL form: same UPDATE plus `AND dispatch_owner
      // = $2`. `rowCount` is 0 when the run is gone OR the owner moved on; the
      // caller cannot distinguish those and must not try to, because both mean
      // "this instance no longer owns this run".
      const res = await pool.query(
        `UPDATE runs SET dispatch_lease_expires_at = $3
          WHERE run_id = $1 AND dispatch_owner = $2`,
        [runId, owner, leaseExpiresAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async claimOrphanedRuns(workerId, nowMs, staleBeforeIso, leaseMs, limit) {
      // Multi-instance-safe atomic claim: the inner SELECT picks orphaned runs
      // (pending/running, created before the grace window, lease absent or
      // expired) and takes a row lock with FOR UPDATE SKIP LOCKED so concurrent
      // re-dispatchers on other instances skip rows already being claimed; the
      // outer UPDATE stamps a fresh lease and RETURNs the claimed rows in one
      // statement. `created_at` is TIMESTAMPTZ, so compare against the ISO
      // stale-before bound cast to timestamptz.
      const { rows } = await pool.query<Row>(
        `UPDATE runs
            SET dispatch_owner = $1,
                dispatch_lease_expires_at = $2,
                updated_at = NOW()
          WHERE run_id IN (
            SELECT run_id FROM runs
             WHERE status IN ('pending','running')
               AND created_at < $3::timestamptz
               AND (dispatch_lease_expires_at IS NULL OR dispatch_lease_expires_at < $4)
             ORDER BY created_at ASC
             LIMIT $5
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [workerId, nowMs + leaseMs, staleBeforeIso, nowMs, limit],
      );
      return rows.map(rowToRun);
    },

    async claimDispatchOutbox(workerId, nowMs, leaseMs, limit) {
      // Same multi-instance-safe shape as claimDueWebhookDeliveries: the inner
      // SELECT takes FOR UPDATE SKIP LOCKED row locks so a concurrent claimer
      // on another instance skips rows this one is taking, and the outer UPDATE
      // stamps the lease + RETURNs in one statement.
      const { rows } = await pool.query<Row>(
        `UPDATE dispatch_outbox
            SET claimed_by = $1, claim_expires_at = $2, updated_at = $3
          WHERE run_id IN (
            SELECT run_id FROM dispatch_outbox
             WHERE status = 'pending'
               AND next_attempt_at <= $4
               AND (claim_expires_at IS NULL OR claim_expires_at < $4)
             ORDER BY next_attempt_at ASC
             LIMIT $5
             FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
        [workerId, nowMs + leaseMs, new Date(nowMs).toISOString(), nowMs, limit],
      );
      return rows.map(rowToDispatchOutbox);
    },

    async getDispatchOutbox(runId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM dispatch_outbox WHERE run_id = $1`,
        [runId],
      );
      return rows[0] ? rowToDispatchOutbox(rows[0]) : null;
    },

    async completeDispatchOutbox(runId) {
      await pool.query(`DELETE FROM dispatch_outbox WHERE run_id = $1`, [runId]);
    },

    async rescheduleDispatchOutbox(runId, nextAttemptAt, dead, error) {
      await pool.query(
        `UPDATE dispatch_outbox
            SET attempts = attempts + 1,
                status = $2,
                next_attempt_at = $3,
                last_error = $4,
                claimed_by = NULL,
                claim_expires_at = NULL,
                updated_at = $5
          WHERE run_id = $1`,
        [runId, dead ? 'dead' : 'pending', nextAttemptAt, error, new Date().toISOString()],
      );
    },

    // ── ADR 0551 P2 — operator projection + redrive ──

    async dispatchOutboxStats() {
      // ONE round trip. Aggregates over the whole table, never over a capped
      // page — a count taken from a listing under-reports exactly when the
      // backlog is deep enough for an operator to be looking at it.
      const { rows } = await pool.query<Row>(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE status = 'dead')    AS dead,
            MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
           FROM dispatch_outbox`,
      );
      const r = rows[0];
      return {
        pending: Number(r?.pending ?? 0),
        dead: Number(r?.dead ?? 0),
        oldestPendingCreatedAt: (r?.oldest_pending as string | null) ?? null,
      };
    },

    async listDispatchOutbox({ status, limit }) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM dispatch_outbox WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [status, limit],
      );
      return rows.map(rowToDispatchOutbox);
    },

    async redriveDispatchOutbox(runId, nextAttemptAt, reason) {
      // The CAS: `status = 'dead'` is in the WHERE of the writing statement, so
      // two concurrent redrives of one row yield exactly one `rowCount = 1`.
      const result = await pool.query(
        `UPDATE dispatch_outbox
            SET status = 'pending',
                attempts = 0,
                next_attempt_at = $2,
                last_error = $3,
                claimed_by = NULL,
                claim_expires_at = NULL,
                updated_at = $4
          WHERE run_id = $1 AND status = 'dead'`,
        [runId, nextAttemptAt, reason, new Date().toISOString()],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async insertAnnotation(record) {
      await pool.query(
        `INSERT INTO annotations (annotation_id, run_id, tenant_id, payload, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [record.annotationId, record.runId, record.tenantId, JSON.stringify(record.payload), record.createdAt],
      );
    },

    async listAnnotations(runId) {
      const res = await pool.query<{ annotation_id: string; run_id: string; tenant_id: string; payload: unknown; created_at: string }>(
        `SELECT annotation_id, run_id, tenant_id, payload, created_at FROM annotations WHERE run_id = $1 ORDER BY created_at ASC`,
        [runId],
      );
      return res.rows.map((r) => ({
        annotationId: r.annotation_id,
        runId: r.run_id,
        tenantId: r.tenant_id,
        payload: r.payload,
        createdAt: r.created_at,
      }));
    },

    async pruneTerminalRuns(cutoffIso, limit) {
      // ADR 0287 — whole-run retention: terminal runs past the cutoff go WITH
      // all their children in one transaction (never event-thinning under a
      // kept run). Racing instances may select overlapping batches; the second
      // instance's deletes no-op — idempotent, counts best-effort. The terminal
      // set is the SDK's wire constant — no hand-kept list to drift.
      const TERMINAL = [...TERMINAL_RUN_STATUSES];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const picked = await client.query<{ run_id: string }>(
          `SELECT run_id FROM runs WHERE status = ANY($1::text[]) AND updated_at < $2 ORDER BY updated_at ASC LIMIT $3`,
          [TERMINAL, cutoffIso, limit],
        );
        const runIds = picked.rows.map((r) => r.run_id);
        if (runIds.length === 0) {
          await client.query('COMMIT');
          return { runs: 0, childRows: 0 };
        }
        let childRows = 0;
        for (const child of ['events', 'interrupts', 'invocation_log', 'invocation_claim', 'effect_escape_ledger', 'envelope_correlations', 'annotations', 'agent_run_activity'] as const) {
          const cr = await client.query(`DELETE FROM ${child} WHERE run_id = ANY($1::text[])`, [runIds]);
          childRows += cr.rowCount ?? 0;
        }
        // Grade-data G3 — the runs' kv write-throughs retire with them.
        const kvKeys = runIds.flatMap((rid) => [`runvars:${rid}`, `runchans:${rid}`, `runagent:${rid}`]);
        const kvr = await client.query(`DELETE FROM host_ext_kv WHERE k = ANY($1::text[])`, [kvKeys]);
        childRows += kvr.rowCount ?? 0;
        // ADR 0287 correction — run ARTIFACTS retire with their run too. The
        // `runartifact` DurableCollection keys rows
        // `hostext:runartifact:<runId>:<nodeId>` (runArtifactStore.runArtifactKey)
        // with NO tenant index (2-arg constructor), so a per-run prefix delete is
        // complete; the prefix scan is served by host_ext_kv_k_pattern. Run ids
        // are server-minted UUIDs (no LIKE metacharacters). Without this the
        // sweep stranded every artifact row forever — 48k orphans-in-waiting
        // (half the KV table) found in prod 2026-07-15.
        for (const rid of runIds) {
          // Escape LIKE metacharacters defensively: run ids are host-minted
          // UUIDs today, but run_id is TEXT — an id containing %/_ must never
          // widen the delete to other runs' artifacts.
          // (Backslash is Postgres's DEFAULT LIKE escape char — no ESCAPE
          // clause needed, and pg-mem can't parse one.)
          const ridEsc = rid.replace(/[\\%_]/g, (m) => `\\${m}`);
          const ar = await client.query(`DELETE FROM host_ext_kv WHERE k LIKE $1`, [`hostext:runartifact:${ridEsc}:%`]);
          childRows += ar.rowCount ?? 0;
        }
        const rr = await client.query(`DELETE FROM runs WHERE run_id = ANY($1::text[])`, [runIds]);
        await client.query('COMMIT');
        return { runs: rr.rowCount ?? 0, childRows };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async pruneWebhookDeliveries(cutoffMs) {
      const r = await pool.query(
        `DELETE FROM webhook_deliveries WHERE status IN ('delivered','dead') AND updated_at < $1`,
        [cutoffMs],
      );
      return r.rowCount ?? 0;
    },

    async deleteAllTenantData(tenantId) {
      // ADR 0284 — introspection-complete teardown, the delete twin of
      // `reassignTenant` below (same doctrine: every `tenant_id` table is covered
      // by construction — the previous hand-kept 7-table list silently orphaned
      // chat, user_agents, webhooks, messaging, and the usage meters). `audit_log`
      // has no tenant column, so introspection excludes it naturally — security
      // events persist past deletion BY DESIGN. Children without `tenant_id`
      // (run-/session-/subscription-keyed) are cascaded explicitly first.
      const tables = await tenantScopedTablesPg(pool);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const runRows = await client.query<{ run_id: string }>(
          `SELECT run_id FROM runs WHERE tenant_id = $1`,
          [tenantId],
        );
        const runIds = runRows.rows.map((r) => r.run_id);
        let events = 0;
        let interrupts = 0;
        let otherRows = 0;
        if (runIds.length > 0) {
          const er = await client.query(`DELETE FROM events WHERE run_id = ANY($1::text[])`, [runIds]);
          events = er.rowCount ?? 0;
          const ir = await client.query(`DELETE FROM interrupts WHERE run_id = ANY($1::text[])`, [runIds]);
          interrupts = ir.rowCount ?? 0;
          // Grade-data G3 — per-run kv write-throughs (variables/channels/agent stamp).
          const kvKeys = runIds.flatMap((rid) => [`runvars:${rid}`, `runchans:${rid}`, `runagent:${rid}`]);
          otherRows += (await client.query(`DELETE FROM host_ext_kv WHERE k = ANY($1::text[])`, [kvKeys])).rowCount ?? 0;
          // NOTE: `idempotency` (the L1 HTTP response cache) is key-only BY DESIGN
          // on both backends — no run/tenant linkage exists to cascade on. Its rows
          // age out via `pruneIdempotencyByPrefix` retention. (An earlier revision
          // listed it here from a misread schema — the delete would have errored on
          // pg for any tenant with runs; caught before it ever ran in prod.)
          for (const child of ['invocation_log', 'invocation_claim', 'effect_escape_ledger', 'envelope_correlations'] as const) {
            const cr = await client.query(`DELETE FROM ${child} WHERE run_id = ANY($1::text[])`, [runIds]);
            otherRows += cr.rowCount ?? 0;
          }
        }
        const sessionRows = await client.query<{ session_id: string }>(
          `SELECT session_id FROM chat_sessions WHERE tenant_id = $1`,
          [tenantId],
        );
        if (sessionRows.rows.length > 0) {
          const mr = await client.query(`DELETE FROM chat_messages WHERE session_id = ANY($1::text[])`, [sessionRows.rows.map((r) => r.session_id)]);
          otherRows += mr.rowCount ?? 0;
        }
        const hookRows = await client.query<{ subscription_id: string }>(
          `SELECT subscription_id FROM webhooks WHERE tenant_id = $1`,
          [tenantId],
        );
        if (hookRows.rows.length > 0) {
          const dr = await client.query(`DELETE FROM webhook_deliveries WHERE subscription_id = ANY($1::text[])`, [hookRows.rows.map((r) => r.subscription_id)]);
          otherRows += dr.rowCount ?? 0;
        }
        const named: Record<string, number> = {};
        for (const t of tables) {
          // `t` comes from information_schema (trusted catalog), quoted defensively.
          const r = await client.query(`DELETE FROM "${t.replace(/"/g, '""')}" WHERE tenant_id = $1`, [tenantId]);
          named[t] = r.rowCount ?? 0;
        }
        // GEN-1c: run_budget has no tenant_id column (introspection skips it), so
        // delete the tenant's buckets by the encoded-tenant predicate. Counts into otherRows.
        const budgetRows = await client.query<{ bucket: string }>(`SELECT bucket FROM run_budget`);
        for (const { bucket } of budgetRows.rows) {
          if (!runBudgetBucketBelongsTo(bucket, tenantId)) continue;
          const br = await client.query(`DELETE FROM run_budget WHERE bucket = $1`, [bucket]);
          otherRows += br.rowCount ?? 0;
        }
        await client.query('COMMIT');
        const take = (t: string): number => {
          const n = named[t] ?? 0;
          delete named[t];
          return n;
        };
        const result = {
          runs: take('runs'),
          events,
          interrupts,
          workflows: take('workflows'),
          secrets: take('byok_secrets'),
          notifications: take('notifications'),
          pushSubscriptions: take('push_subscriptions'),
          otherRows: otherRows + Object.values(named).reduce((a, b) => a + b, 0),
          tablesCovered: tables.length,
        };
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async reassignTenant(fromTenant, toTenant) {
      // ADR 0003 Phase 4c — adopt-migration (see sqlite/index.ts + tenantMigration.ts
      // for the full contract). ONE transaction: every `tenant_id` SQL table
      // (discovered by introspection — complete by construction) + a read-modify-
      // write of host-ext KV content rows (re-key tenantId/orgId === from),
      // EXCLUDING the tenant-key-encoding access-control scaffolding. Atomic +
      // idempotent (a re-run finds nothing under `from`).
      const tables = await tenantScopedTablesPg(pool);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const counts: Record<string, number> = {};
        for (const t of tables) {
          // `t` comes from information_schema (trusted catalog), quoted defensively.
          const r = await client.query(
            `UPDATE "${t.replace(/"/g, '""')}" SET tenant_id = $1 WHERE tenant_id = $2`,
            [toTenant, fromTenant],
          );
          counts[t] = r.rowCount ?? 0;
        }
        // GEN-1c: run_budget has no tenant_id column (introspection skips it) — move
        // the tenant's buckets by rewriting the encoded-tenant segment; keep the
        // TARGET on a same-window collision (its own budget wins). Counts into `counts`.
        const budgetRows = await client.query<{ bucket: string; window_start: number; count: number }>(
          `SELECT bucket, window_start, count FROM run_budget`,
        );
        let runBudgetMoved = 0;
        for (const r of budgetRows.rows) {
          const nb = rekeyTenantSegment(r.bucket, fromTenant, toTenant);
          if (nb === r.bucket) continue;
          await client.query(
            `INSERT INTO run_budget (bucket, window_start, count) VALUES ($1, $2, $3) ON CONFLICT (bucket) DO NOTHING`,
            [nb, r.window_start, r.count],
          );
          await client.query(`DELETE FROM run_budget WHERE bucket = $1`, [r.bucket]);
          runBudgetMoved++;
        }
        if (runBudgetMoved > 0) counts.run_budget = runBudgetMoved;
        // host-ext KV: content re-key IN PLACE (tenantId/orgId value) + GEN-1b
        // tenant-embedded KEY move (primary PK rows + `hostextidx:` markers).
        // Excludes the access-control scaffolding in BOTH keyspaces (re-seeded at
        // the destination via ensurePersonalWorkspace, never moved). `planHostExtRekey`
        // decides each row's action purely; see tenantMigration.ts for the semantics.
        const now = new Date().toISOString();
        const kv = await client.query<{ k: string; v: string }>(
          `SELECT k, v FROM host_ext_kv
           WHERE k NOT LIKE 'hostext:access-orgs:%'    AND k NOT LIKE 'hostext:access-members:%'
             AND k NOT LIKE 'hostextidx:access-orgs:%' AND k NOT LIKE 'hostextidx:access-members:%'`,
        );
        let hostExt = 0;
        let hostExtKeysRekeyed = 0;
        let hostExtKeysDeduped = 0;
        for (const row of kv.rows) {
          const action = planHostExtRekey(row.k, row.v, fromTenant, toTenant);
          if (action.kind === 'none') continue;
          if (action.kind === 'value') {
            await client.query(`UPDATE host_ext_kv SET v = $1, updated_at = $2 WHERE k = $3`, [
              action.v, now, row.k,
            ]);
            hostExt++;
            continue;
          }
          // move: keep the destination's own row on collision (fold dedup), then
          // drop the source key either way.
          const ins = await client.query(
            `INSERT INTO host_ext_kv (k, v, updated_at) VALUES ($1, $2, $3) ON CONFLICT (k) DO NOTHING`,
            [action.k, action.v, now],
          );
          await client.query(`DELETE FROM host_ext_kv WHERE k = $1`, [row.k]);
          if ((ins.rowCount ?? 0) > 0) hostExtKeysRekeyed++; else hostExtKeysDeduped++;
        }
        await client.query('COMMIT');
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
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async incrementManagedUsage(tenantId, providerId, dateUtc, inputTokens, outputTokens) {
      await pool.query(
        `INSERT INTO managed_provider_usage (tenant_id, date, provider_id, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, date, provider_id) DO UPDATE SET
           input_tokens  = managed_provider_usage.input_tokens  + EXCLUDED.input_tokens,
           output_tokens = managed_provider_usage.output_tokens + EXCLUDED.output_tokens`,
        [tenantId, dateUtc, providerId, inputTokens, outputTokens],
      );
    },

    async deleteManagedUsageForTenant(tenantId: string, alsoLike?: UsageLikeMatcher) {
      // ADR 0693 §4 — subject erasure. Every date, every provider, one bucket.
      // `alsoLike` additionally reaches the per-subject buckets a TENANT owns
      // (ADR 0697 follow-up); the pattern is composed by the caller and escaped
      // there, never interpreted here.
      const { rowCount } = alsoLike
        ? await pool.query(
          `DELETE FROM managed_provider_usage WHERE tenant_id = $1 OR tenant_id LIKE $2 ESCAPE $3`,
          [tenantId, alsoLike.pattern, alsoLike.escape])
        : await pool.query(
          `DELETE FROM managed_provider_usage WHERE tenant_id = $1`, [tenantId]);
      return rowCount ?? 0;
    },

    async getManagedUsage(tenantId, providerId, dateUtc) {
      const { rows } = await pool.query<{ input_tokens: number; output_tokens: number }>(
        `SELECT input_tokens, output_tokens FROM managed_provider_usage
           WHERE tenant_id = $1 AND date = $2 AND provider_id = $3`,
        [tenantId, dateUtc, providerId],
      );
      const row = rows[0];
      if (!row) return { inputTokens: 0, outputTokens: 0 };
      // pg returns INTEGER as JS number; BIGINT would come back as string
      // (the daily cap is small enough that INTEGER suffices, but
      // belt-and-suspenders coerce in case a deployer widens the column).
      return {
        inputTokens: typeof row.input_tokens === 'number' ? row.input_tokens : Number(row.input_tokens),
        outputTokens: typeof row.output_tokens === 'number' ? row.output_tokens : Number(row.output_tokens),
      };
    },

    async deleteMediaUsageForTenant(tenantId: string, alsoLike?: UsageLikeMatcher) {
      // ADR 0693 §4 — subject erasure, media half.
      const { rowCount } = alsoLike
        ? await pool.query(
          `DELETE FROM media_provider_usage WHERE tenant_id = $1 OR tenant_id LIKE $2 ESCAPE $3`,
          [tenantId, alsoLike.pattern, alsoLike.escape])
        : await pool.query(
          `DELETE FROM media_provider_usage WHERE tenant_id = $1`, [tenantId]);
      return rowCount ?? 0;
    },

    async incrementMediaUsage(tenantId, dateUtc, ttsChars, sttBytes) {
      await pool.query(
        `INSERT INTO media_provider_usage (tenant_id, date, tts_chars, stt_bytes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, date) DO UPDATE SET
           tts_chars = media_provider_usage.tts_chars + EXCLUDED.tts_chars,
           stt_bytes = media_provider_usage.stt_bytes + EXCLUDED.stt_bytes`,
        [tenantId, dateUtc, ttsChars, sttBytes],
      );
    },

    async getMediaUsage(tenantId, dateUtc) {
      const { rows } = await pool.query<{ tts_chars: number | string; stt_bytes: number | string }>(
        `SELECT tts_chars, stt_bytes FROM media_provider_usage WHERE tenant_id = $1 AND date = $2`,
        [tenantId, dateUtc],
      );
      const row = rows[0];
      if (!row) return { ttsChars: 0, sttBytes: 0 };
      // BIGINT comes back as a string from pg — coerce.
      return {
        ttsChars: typeof row.tts_chars === 'number' ? row.tts_chars : Number(row.tts_chars),
        sttBytes: typeof row.stt_bytes === 'number' ? row.stt_bytes : Number(row.stt_bytes),
      };
    },

    async incrementByokChatUsage(tenantId, providerId, dateUtc, inputTokens, outputTokens) {
      await pool.query(
        `INSERT INTO byok_chat_usage (tenant_id, provider_id, date_utc, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, provider_id, date_utc) DO UPDATE SET
           input_tokens  = byok_chat_usage.input_tokens  + EXCLUDED.input_tokens,
           output_tokens = byok_chat_usage.output_tokens + EXCLUDED.output_tokens`,
        [tenantId, providerId, dateUtc, inputTokens, outputTokens],
      );
    },

    async getByokChatUsage(tenantId, providerId, dateUtc) {
      const { rows } = await pool.query<{ input_tokens: number | string; output_tokens: number | string }>(
        `SELECT input_tokens, output_tokens FROM byok_chat_usage
           WHERE tenant_id = $1 AND provider_id = $2 AND date_utc = $3`,
        [tenantId, providerId, dateUtc],
      );
      const row = rows[0];
      if (!row) return { inputTokens: 0, outputTokens: 0 };
      // BIGINT comes back as a string from pg — coerce.
      return {
        inputTokens: typeof row.input_tokens === 'number' ? row.input_tokens : Number(row.input_tokens),
        outputTokens: typeof row.output_tokens === 'number' ? row.output_tokens : Number(row.output_tokens),
      };
    },

    async getEnvelopeCorrelation(runId, correlationId) {
      const { rows } = await pool.query<{ outcome: string; envelope_type: string; recorded_at: Date | string }>(
        `SELECT outcome, envelope_type, recorded_at FROM envelope_correlations
           WHERE run_id = $1 AND correlation_id = $2`,
        [runId, correlationId],
      );
      const row = rows[0];
      if (!row) return null;
      // pg returns TIMESTAMPTZ as Date; the interface uses ISO-string
      // for backend-symmetry with the sqlite adapter.
      const recordedAt = row.recorded_at instanceof Date
        ? row.recorded_at.toISOString()
        : row.recorded_at;
      return {
        outcome: JSON.parse(row.outcome) as unknown,
        envelopeType: row.envelope_type,
        recordedAt,
      };
    },

    async putEnvelopeCorrelation(runId, correlationId, outcome, envelopeType, recordedAt) {
      await pool.query(
        `INSERT INTO envelope_correlations
           (run_id, correlation_id, outcome, envelope_type, recorded_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (run_id, correlation_id) DO UPDATE SET
           outcome       = EXCLUDED.outcome,
           envelope_type = EXCLUDED.envelope_type,
           recorded_at   = EXCLUDED.recorded_at`,
        [runId, correlationId, JSON.stringify(outcome), envelopeType, recordedAt],
      );
    },

    // ── chat sessions (Phase 2C.1) ────────────────────────────────────
    async listChatSessions(tenantId, limit) {
      const r = await pool.query<{
        session_id: string;
        tenant_id: string;
        title: string;
        title_source: string | null;
        created_at: Date;
        updated_at: Date;
        message_count: number;
      }>(
        `SELECT session_id, tenant_id, title, title_source, created_at, updated_at, message_count
         FROM chat_sessions
         WHERE tenant_id = $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [tenantId, limit ?? 200],
      );
      return r.rows.map((row): ChatSessionRecord => ({
        sessionId: row.session_id,
        tenantId: row.tenant_id,
        title: row.title,
        ...(row.title_source ? { titleSource: row.title_source as ChatSessionRecord['titleSource'] } : {}),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        messageCount: row.message_count,
      }));
    },

    async createChatSession(record) {
      await pool.query(
        `INSERT INTO chat_sessions (session_id, tenant_id, title, title_source, created_at, updated_at, message_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.sessionId,
          record.tenantId,
          record.title,
          record.titleSource ?? null,
          record.createdAt,
          record.updatedAt,
          record.messageCount,
        ],
      );
    },

    async getChatSession(tenantId, sessionId) {
      const r = await pool.query<{
        session_id: string;
        tenant_id: string;
        title: string;
        title_source: string | null;
        created_at: Date;
        updated_at: Date;
        message_count: number;
      }>(
        `SELECT session_id, tenant_id, title, title_source, created_at, updated_at, message_count
         FROM chat_sessions
         WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        sessionId: row.session_id,
        tenantId: row.tenant_id,
        title: row.title,
        ...(row.title_source ? { titleSource: row.title_source as ChatSessionRecord['titleSource'] } : {}),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        messageCount: row.message_count,
      };
    },

    async updateChatSession(tenantId, sessionId, patch) {
      await pool.query(
        `UPDATE chat_sessions
            SET title         = COALESCE($3, title),
                title_source  = COALESCE($4, title_source),
                updated_at    = COALESCE($5, updated_at),
                message_count = COALESCE($6, message_count)
          WHERE tenant_id = $1 AND session_id = $2`,
        [
          tenantId,
          sessionId,
          patch.title ?? null,
          patch.titleSource ?? null,
          patch.updatedAt ?? null,
          patch.messageCount ?? null,
        ],
      );
    },

    async casChatSessionTitle(tenantId, sessionId, patch, expectTitleSource) {
      const r = await pool.query(
        `UPDATE chat_sessions
            SET title = $3, title_source = $4, updated_at = $5
          WHERE tenant_id = $1 AND session_id = $2 AND COALESCE(title_source, 'default') = $6`,
        [tenantId, sessionId, patch.title, patch.titleSource, patch.updatedAt, expectTitleSource],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async deleteChatSession(tenantId, sessionId) {
      const r = await pool.query(
        `DELETE FROM chat_sessions WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sessionId],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async countChatSessionMessages(sessionId) {
      const r = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = $1', [sessionId]);
      return Number(r.rows[0]?.n ?? 0);
    },
    async listChatSessionMessages(sessionId, opts) {
      type Row = { message_id: string; session_id: string; role: string; content: string; meta: string | null; author_subject: string | null; created_at: Date };
      let rows: Row[];
      if (opts?.limit !== undefined) {
        // Bounded page: most-recent `limit` (optionally strictly older than the
        // cursor) DESC, then reversed to ASC. The row-value comparison
        // `(created_at, message_id) < ($2::timestamptz, $3)` pages
        // deterministically across millisecond ties (ADR 0043 Phase 3b). The
        // cursor's createdAt is an ISO string → cast to timestamptz so it
        // compares against the column type.
        const r = opts.before
          ? await pool.query<Row>(
              `SELECT message_id, session_id, role, content, meta, author_subject, created_at
               FROM chat_messages
               WHERE session_id = $1 AND (created_at, message_id) < ($2::timestamptz, $3)
               ORDER BY created_at DESC, message_id DESC
               LIMIT $4`,
              [sessionId, opts.before.createdAt, opts.before.messageId, opts.limit],
            )
          : await pool.query<Row>(
              `SELECT message_id, session_id, role, content, meta, author_subject, created_at
               FROM chat_messages
               WHERE session_id = $1
               ORDER BY created_at DESC, message_id DESC
               LIMIT $2`,
              [sessionId, opts.limit],
            );
        rows = r.rows.slice().reverse();
      } else {
        const r = await pool.query<Row>(
          `SELECT message_id, session_id, role, content, meta, author_subject, created_at
           FROM chat_messages
           WHERE session_id = $1
           ORDER BY created_at ASC, message_id ASC`,
          [sessionId],
        );
        rows = r.rows;
      }
      return rows.map((row): ChatMessageRecord => ({
        messageId: row.message_id,
        sessionId: row.session_id,
        role: row.role as ChatMessageRecord['role'],
        content: row.content,
        meta: row.meta,
        authorSubject: row.author_subject,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async appendChatMessage(record) {
      // Atomic insert + counter bump in one transaction — see the
      // sqlite mirror in `../sqlite/index.ts` for the rationale. Pool
      // checkout + BEGIN/COMMIT so concurrent appends serialize at the
      // row level instead of racing on read-then-write.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO chat_messages (message_id, session_id, role, content, meta, author_subject, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            record.messageId,
            record.sessionId,
            record.role,
            record.content,
            record.meta,
            record.authorSubject,
            record.createdAt,
          ],
        );
        await client.query(
          `UPDATE chat_sessions
              SET message_count = message_count + 1,
                  updated_at = $1
            WHERE session_id = $2`,
          [record.createdAt, record.sessionId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* */ });
        throw err;
      } finally {
        client.release();
      }
    },

    async updateChatMessageContent(sessionId, messageId, content, meta) {
      const res = await pool.query(
        `UPDATE chat_messages SET content = $1, meta = $2
          WHERE session_id = $3 AND message_id = $4`,
        [content, meta, sessionId, messageId],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async getChatMessageAuthor(sessionId, messageId) {
      const res = await pool.query<{ author_subject: string | null }>(
        `SELECT author_subject FROM chat_messages WHERE session_id = $1 AND message_id = $2`,
        [sessionId, messageId],
      );
      const row = res.rows[0];
      return row ? { authorSubject: row.author_subject } : undefined;
    },

    // ADR 0195 — one full row (role/content/meta) for edit/tombstone semantics.
    async getChatMessage(sessionId, messageId) {
      const res = await pool.query<{ message_id: string; session_id: string; role: string; content: string; meta: string | null; author_subject: string | null; created_at: string }>(
        `SELECT message_id, session_id, role, content, meta, author_subject, created_at
           FROM chat_messages WHERE session_id = $1 AND message_id = $2`,
        [sessionId, messageId],
      );
      const row = res.rows[0];
      if (!row) return undefined;
      return {
        messageId: row.message_id, sessionId: row.session_id,
        role: row.role as 'user' | 'assistant' | 'system' | 'workflow_run',
        content: row.content, meta: row.meta, authorSubject: row.author_subject, createdAt: row.created_at,
      };
    },

    async insertNotification(record) {
      await pool.query(
        `INSERT INTO notifications (
          notification_id, tenant_id, recipient_user_id, recipient_role, type, priority, status,
          title, message, run_id, workflow_id, node_id,
          interrupt_id, action_url, metadata,
          created_at, read_at, archived_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          record.notificationId, record.tenantId, record.recipientUserId ?? null, record.recipientRole ?? null,
          record.type, record.priority, record.status,
          record.title, record.message,
          record.runId ?? null, record.workflowId ?? null, record.nodeId ?? null,
          record.interruptId ?? null, record.actionUrl ?? null, record.metadata ?? null,
          record.createdAt, record.readAt ?? null, record.archivedAt ?? null,
        ],
      );
    },

    async listNotifications({ tenantId, recipientUserId, recipientRoles, status, includeArchived, ascending, limit = 100 }) {
      const wantStatuses: readonly string[] | null = status
        ? (Array.isArray(status) ? status : [status as string])
        : null;
      // Default: hide archived rows from the inbox view. The Archived
      // tab passes `includeArchived: true` to opt in.
      const params: unknown[] = [tenantId];
      let where = `tenant_id = $1`;
      // ADR 0050 — addressed rows for this user + TRUE broadcasts (both NULL) +
      // role-addressed rows the caller holds (Phase 3). A role row is never a plain
      // broadcast → default-deny when roles is empty.
      if (recipientUserId) {
        const roles = recipientRoles ?? [];
        params.push(recipientUserId);
        let clause = `(recipient_user_id = $${params.length} OR (recipient_user_id IS NULL AND (recipient_role IS NULL`;
        if (roles.length > 0) {
          const ph = roles.map((_, i) => `$${params.length + i + 1}`).join(', ');
          clause += ` OR recipient_role IN (${ph})`;
          for (const r of roles) params.push(r);
        }
        clause += ')))';
        where += ` AND ${clause}`;
      }
      if (wantStatuses && wantStatuses.length > 0) {
        const placeholders = wantStatuses.map((_, i) => `$${params.length + i + 1}`).join(', ');
        where += ` AND status IN (${placeholders})`;
        for (const s of wantStatuses) params.push(s);
      } else if (!includeArchived) {
        where += ` AND status <> 'archived'`;
      }
      params.push(limit);
      const order = ascending ? 'ASC' : 'DESC';
      const { rows } = await pool.query<Row>(
        `SELECT * FROM notifications WHERE ${where}
          ORDER BY created_at ${order}
          LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToNotification);
    },

    async getNotification(notificationId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM notifications WHERE notification_id = $1`,
        [notificationId],
      );
      return rows[0] ? rowToNotification(rows[0]) : null;
    },

    async updateNotificationStatus(notificationId, status, now) {
      // `read_at` and `archived_at` are set on transition. Re-reading or
      // re-archiving an already-archived row is a no-op for the timestamp
      // (COALESCE keeps the first transition's timestamp).
      const readAt = status === 'read' ? now : null;
      const archivedAt = status === 'archived' ? now : null;
      const { rows } = await pool.query<Row>(
        `UPDATE notifications
            SET status = $1,
                read_at = CASE WHEN $2::timestamptz IS NOT NULL
                                THEN COALESCE(read_at, $2)
                                ELSE read_at END,
                archived_at = CASE WHEN $3::timestamptz IS NOT NULL
                                    THEN COALESCE(archived_at, $3)
                                    ELSE archived_at END
          WHERE notification_id = $4
          RETURNING *`,
        [status, readAt, archivedAt, notificationId],
      );
      return rows[0] ? rowToNotification(rows[0]) : null;
    },

    async markAllNotificationsRead(tenantId, now, recipientUserId, recipientRoles) {
      // ADR 0050 — scoped to the rows this user can see (their addressed rows +
      // true broadcasts + role rows they hold, Phase 3), never another member's
      // addressed or unheld-role items.
      const params: unknown[] = [tenantId, now];
      let recipientClause = '';
      if (recipientUserId) {
        const roles = recipientRoles ?? [];
        params.push(recipientUserId);
        recipientClause = ` AND (recipient_user_id = $${params.length} OR (recipient_user_id IS NULL AND (recipient_role IS NULL`;
        if (roles.length > 0) {
          const ph = roles.map((_, i) => `$${params.length + i + 1}`).join(', ');
          recipientClause += ` OR recipient_role IN (${ph})`;
          for (const r of roles) params.push(r);
        }
        recipientClause += ')))';
      }
      const r = await pool.query(
        `UPDATE notifications
            SET status = 'read',
                read_at = COALESCE(read_at, $2)
          WHERE tenant_id = $1
            AND status = 'unread'
            ${recipientClause}`,
        params,
      );
      return r.rowCount ?? 0;
    },

    async deleteNotification(notificationId) {
      const r = await pool.query(
        `DELETE FROM notifications WHERE notification_id = $1`,
        [notificationId],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async deleteAllTenantNotifications(tenantId) {
      const r = await pool.query(
        `DELETE FROM notifications WHERE tenant_id = $1`,
        [tenantId],
      );
      return r.rowCount ?? 0;
    },

    // CMNT-11 — per-SUBJECT reclamation (the DSAR lane). Mirrors the sqlite
    // adapter: the addressed recipient column plus the two metadata keys the
    // emitters write. `metadata` is JSONB, so `->>` yields text or NULL and a
    // row with no metadata does not match. Fail-closed on a falsy tenant/subject.
    async deleteNotificationsForSubject(tenantId, subjectKey) {
      if (!tenantId || !subjectKey) return 0;
      const r = await pool.query(
        `DELETE FROM notifications
          WHERE tenant_id = $1
            AND (recipient_user_id = $2
              OR metadata->>'actorId' = $2
              OR metadata->>'recipientId' = $2)`,
        [tenantId, subjectKey],
      );
      return r.rowCount ?? 0;
    },

    async insertPushSubscription(record) {
      // Upsert by endpoint — the same browser re-subscribing after key
      // rotation / permission re-grant produces a fresh subscriptionId
      // server-side but keeps the unique endpoint constraint happy.
      await pool.query(
        `INSERT INTO push_subscriptions (
          subscription_id, tenant_id, user_id, endpoint, p256dh_key, auth_key,
          user_agent, created_at, last_used_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (endpoint) DO UPDATE SET
          p256dh_key = EXCLUDED.p256dh_key,
          auth_key = EXCLUDED.auth_key,
          user_agent = EXCLUDED.user_agent,
          tenant_id = EXCLUDED.tenant_id,
          user_id = EXCLUDED.user_id`,
        [
          record.subscriptionId, record.tenantId, record.userId ?? null, record.endpoint,
          record.p256dhKey, record.authKey,
          record.userAgent ?? null,
          record.createdAt, record.lastUsedAt ?? null,
        ],
      );
    },

    async listPushSubscriptions(tenantId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM push_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return rows.map(rowToPushSubscription);
    },

    async getPushSubscriptionByEndpoint(endpoint) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM push_subscriptions WHERE endpoint = $1`,
        [endpoint],
      );
      return rows[0] ? rowToPushSubscription(rows[0]) : null;
    },

    async deletePushSubscription(subscriptionId) {
      const r = await pool.query(
        `DELETE FROM push_subscriptions WHERE subscription_id = $1`,
        [subscriptionId],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async deleteAllTenantPushSubscriptions(tenantId) {
      const r = await pool.query(
        `DELETE FROM push_subscriptions WHERE tenant_id = $1`,
        [tenantId],
      );
      return r.rowCount ?? 0;
    },

    // ── user-authored agents (phase E1, 2026-05-28) ──
    async insertUserAgent(record) {
      await pool.query(
        `INSERT INTO user_agents (
          agent_id, tenant_id, persona, label, description, model_class,
          system_prompt, tool_allowlist,
          memory_scratchpad, memory_conversation, memory_long_term,
          confidence_threshold, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
        [
          record.agentId,
          record.tenantId,
          record.persona,
          record.label ?? null,
          record.description ?? null,
          record.modelClass,
          record.systemPrompt,
          JSON.stringify(record.toolAllowlist),
          record.memoryShape.scratchpad,
          record.memoryShape.conversation,
          record.memoryShape.longTerm,
          record.confidenceThreshold ?? null,
          record.createdAt,
        ],
      );
    },

    async listUserAgents(tenantId) {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT * FROM user_agents WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return r.rows.map(rowToUserAgent);
    },

    async listAllUserAgents() {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT * FROM user_agents ORDER BY created_at DESC`,
      );
      return r.rows.map(rowToUserAgent);
    },

    async getUserAgentAnyTenant(agentId) {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT * FROM user_agents WHERE agent_id = $1`,
        [agentId],
      );
      return r.rows[0] ? rowToUserAgent(r.rows[0]) : null;
    },

    async getUserAgent(tenantId, agentId) {
      const r = await pool.query<Record<string, unknown>>(
        `SELECT * FROM user_agents WHERE agent_id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      );
      return r.rows[0] ? rowToUserAgent(r.rows[0]) : null;
    },

    async deleteUserAgent(tenantId, agentId) {
      const r = await pool.query(
        `DELETE FROM user_agents WHERE agent_id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async updateUserAgent(expectedTenantId, record) {
      const r = await pool.query(
        `UPDATE user_agents SET
          tenant_id = $12,
          persona = $2, label = $3, description = $4, model_class = $5,
          system_prompt = $6, tool_allowlist = $7::jsonb,
          memory_scratchpad = $8, memory_conversation = $9, memory_long_term = $10,
          confidence_threshold = $11
        WHERE agent_id = $1 AND tenant_id = $13`,
        [
          record.agentId,
          record.persona,
          record.label ?? null,
          record.description ?? null,
          record.modelClass,
          record.systemPrompt,
          JSON.stringify(record.toolAllowlist),
          record.memoryShape.scratchpad,
          record.memoryShape.conversation,
          record.memoryShape.longTerm,
          record.confidenceThreshold ?? null,
          record.tenantId,
          expectedTenantId,
        ],
      );
      return (r.rowCount ?? 0) > 0;
    },

    // ── messaging relay-gateway (demo host-extension) ──
    async upsertRelayDevice(record) {
      await pool.query(
        `INSERT INTO relay_devices (
          relay_id, tenant_id, channel, device_name, status,
          device_token_hash, token_expires_at, activation_code, activation_expires_at,
          registered_at, last_heartbeat_at, last_reported_status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (relay_id) DO UPDATE SET
          channel=EXCLUDED.channel, device_name=EXCLUDED.device_name, status=EXCLUDED.status,
          device_token_hash=EXCLUDED.device_token_hash, token_expires_at=EXCLUDED.token_expires_at,
          activation_code=EXCLUDED.activation_code, activation_expires_at=EXCLUDED.activation_expires_at,
          last_heartbeat_at=EXCLUDED.last_heartbeat_at, last_reported_status=EXCLUDED.last_reported_status`,
        [
          record.relayId, record.tenantId, record.channel, record.deviceName ?? null, record.status,
          record.deviceTokenHash ?? null, record.tokenExpiresAt ?? null,
          record.activationCode ?? null, record.activationExpiresAt ?? null,
          record.registeredAt, record.lastHeartbeatAt ?? null, record.lastReportedStatus ?? null,
        ],
      );
    },
    async getRelayDevice(relayId) {
      const { rows } = await pool.query<Row>(`SELECT * FROM relay_devices WHERE relay_id = $1`, [relayId]);
      return rows[0] ? rowToRelayDevicePg(rows[0]) : null;
    },
    async getRelayDeviceByTokenHash(tokenHash) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM relay_devices WHERE device_token_hash = $1 AND status = 'active'`,
        [tokenHash],
      );
      return rows[0] ? rowToRelayDevicePg(rows[0]) : null;
    },
    async listRelayDevices(tenantId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM relay_devices WHERE tenant_id = $1 ORDER BY registered_at DESC`,
        [tenantId],
      );
      return rows.map(rowToRelayDevicePg);
    },
    async consumeRunBudget(bucket, windowStart) {
      const { rows } = await pool.query<{ count: string }>(
        `INSERT INTO run_budget (bucket, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (bucket) DO UPDATE SET count = run_budget.count + 1
         RETURNING count`,
        [bucket, windowStart],
      );
      // INSERT … RETURNING always yields exactly one row; default defensively.
      return rows[0] ? Number(rows[0].count) : 0;
    },
    async pruneRunBudget(olderThanWindowStart) {
      const { rowCount } = await pool.query(`DELETE FROM run_budget WHERE window_start < $1`, [olderThanWindowStart]);
      return rowCount ?? 0;
    },

    async recordAgentRunAttribution(row) {
      await pool.query(
        `INSERT INTO agent_run_activity (run_id, tenant_id, roster_id, agent_id, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz)
         ON CONFLICT (run_id) DO NOTHING`,
        [row.runId, row.tenantId, row.rosterId, row.agentId ?? null, row.source, row.createdAt],
      );
    },
    async deleteOrphanAgentRunActivity() {
      const { rowCount } = await pool.query(
        `DELETE FROM agent_run_activity a
          WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = a.run_id)`,
      );
      return rowCount ?? 0;
    },
    async listAgentRunActivity({ tenantId, rosterId, status, limit = 50 }) {
      const { rows } = await pool.query<Row>(
        `SELECT r.* FROM agent_run_activity a
           JOIN runs r ON r.run_id = a.run_id
          WHERE a.tenant_id = $1
            AND ($2::text IS NULL OR a.roster_id = $2)
            AND ($3::text IS NULL OR r.status = $3)
          ORDER BY r.created_at DESC
          LIMIT $4`,
        [tenantId, rosterId ?? null, status ?? null, limit],
      );
      return rows.map(rowToRun);
    },
    async enqueueRelayOutbound(record) {
      await pool.query(
        `INSERT INTO relay_outbound (egress_id, relay_id, channel, conversation_id, text, reply_to_message_id, enqueued_at, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [record.egressId, record.relayId, record.channel, record.conversationId, record.text, record.replyToMessageId ?? null, record.enqueuedAt, egressExtraJson(record)],
      );
    },
    async listRelayOutbound(relayId, limit) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM relay_outbound WHERE relay_id = $1 ORDER BY enqueued_at ASC, egress_id ASC LIMIT $2`,
        [relayId, limit],
      );
      return rows.map(rowToEgressPg);
    },
    async ackRelayOutbound(relayId, egressIds) {
      if (egressIds.length === 0) return 0;
      const r = await pool.query(
        `DELETE FROM relay_outbound WHERE relay_id = $1 AND egress_id = ANY($2::text[])`,
        [relayId, [...egressIds]],
      );
      return r.rowCount ?? 0;
    },
    async deleteRelayOutbound(relayId) {
      await pool.query(`DELETE FROM relay_outbound WHERE relay_id = $1`, [relayId]);
    },
    async upsertMessagingConnector(record) {
      await pool.query(
        `INSERT INTO messaging_connectors (connector_id, tenant_id, channel, display_name, enabled, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (connector_id) DO UPDATE SET
           channel=EXCLUDED.channel, display_name=EXCLUDED.display_name, enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at`,
        [record.connectorId, record.tenantId, record.channel, record.displayName, record.enabled, record.createdAt, record.updatedAt],
      );
    },
    async getMessagingConnector(connectorId) {
      const { rows } = await pool.query<Row>(`SELECT * FROM messaging_connectors WHERE connector_id = $1`, [connectorId]);
      return rows[0] ? rowToConnectorPg(rows[0]) : null;
    },
    async listMessagingConnectors(tenantId) {
      const { rows } = tenantId === undefined
        ? await pool.query<Row>(`SELECT * FROM messaging_connectors ORDER BY created_at ASC`)
        : await pool.query<Row>(`SELECT * FROM messaging_connectors WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]);
      return rows.map(rowToConnectorPg);
    },
    async upsertMessagingSession(record) {
      await pool.query(
        `INSERT INTO messaging_sessions (session_key, tenant_id, channel, conversation_id, peer_id, peer_display, last_inbound_at, message_count, last_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_key) DO UPDATE SET
           peer_id=EXCLUDED.peer_id, peer_display=EXCLUDED.peer_display,
           last_inbound_at=EXCLUDED.last_inbound_at, message_count=EXCLUDED.message_count, last_run_id=EXCLUDED.last_run_id`,
        [record.sessionKey, record.tenantId, record.channel, record.conversationId, record.peerId, record.peerDisplay ?? null, record.lastInboundAt, record.messageCount, record.lastRunId ?? null],
      );
    },
    async getMessagingSession(sessionKey) {
      const { rows } = await pool.query<Row>(`SELECT * FROM messaging_sessions WHERE session_key = $1`, [sessionKey]);
      return rows[0] ? rowToSessionPg(rows[0]) : null;
    },
    async listMessagingSessions(tenantId) {
      const { rows } = tenantId === undefined
        ? await pool.query<Row>(`SELECT * FROM messaging_sessions ORDER BY last_inbound_at DESC`)
        : await pool.query<Row>(`SELECT * FROM messaging_sessions WHERE tenant_id = $1 ORDER BY last_inbound_at DESC`, [tenantId]);
      return rows.map(rowToSessionPg);
    },
    async deleteMessagingSession(sessionKey) {
      const r = await pool.query(`DELETE FROM messaging_sessions WHERE session_key = $1`, [sessionKey]);
      return (r.rowCount ?? 0) > 0;
    },

    async upsertMessagingPolicy(record) {
      await pool.query(
        `INSERT INTO messaging_policies (connector_id, tenant_id, dm_policy, group_policy, require_mention, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (connector_id) DO UPDATE SET
           tenant_id=EXCLUDED.tenant_id, dm_policy=EXCLUDED.dm_policy, group_policy=EXCLUDED.group_policy,
           require_mention=EXCLUDED.require_mention, updated_at=EXCLUDED.updated_at`,
        [record.connectorId, record.tenantId, record.dmPolicy, record.groupPolicy, record.requireMention, record.updatedAt],
      );
    },
    async getMessagingPolicy(connectorId) {
      const { rows } = await pool.query<Row>(`SELECT * FROM messaging_policies WHERE connector_id = $1`, [connectorId]);
      return rows[0] ? rowToPolicyPg(rows[0]) : null;
    },
    async upsertMessagingRoutingRule(record) {
      await pool.query(
        `INSERT INTO messaging_routing_rules (rule_id, tenant_id, channel, pattern, workflow_id, agent_id, priority, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (rule_id) DO UPDATE SET
           tenant_id=EXCLUDED.tenant_id, channel=EXCLUDED.channel, pattern=EXCLUDED.pattern,
           workflow_id=EXCLUDED.workflow_id, agent_id=EXCLUDED.agent_id, priority=EXCLUDED.priority`,
        [record.ruleId, record.tenantId, record.channel ?? null, record.pattern,
         record.workflowId ?? null, record.agentId ?? null, record.priority, record.createdAt],
      );
    },
    async listMessagingRoutingRules(tenantId) {
      const { rows } = tenantId === undefined
        ? await pool.query<Row>(`SELECT * FROM messaging_routing_rules ORDER BY priority DESC, created_at ASC`)
        : await pool.query<Row>(`SELECT * FROM messaging_routing_rules WHERE tenant_id = $1 ORDER BY priority DESC, created_at ASC`, [tenantId]);
      return rows.map(rowToRoutingRulePg);
    },
    async deleteMessagingRoutingRule(ruleId) {
      const r = await pool.query(`DELETE FROM messaging_routing_rules WHERE rule_id = $1`, [ruleId]);
      return (r.rowCount ?? 0) > 0;
    },
    async upsertMessagingIdentity(record) {
      await pool.query(
        `INSERT INTO messaging_identities (identity_id, tenant_id, display_name, peers, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (identity_id) DO UPDATE SET
           tenant_id=EXCLUDED.tenant_id, display_name=EXCLUDED.display_name,
           peers=EXCLUDED.peers, updated_at=EXCLUDED.updated_at`,
        [record.identityId, record.tenantId, record.displayName ?? null, JSON.stringify(record.peers), record.createdAt, record.updatedAt],
      );
    },
    async getMessagingIdentity(identityId) {
      const { rows } = await pool.query<Row>(`SELECT * FROM messaging_identities WHERE identity_id = $1`, [identityId]);
      return rows[0] ? rowToIdentityPg(rows[0]) : null;
    },
    async listMessagingIdentities(tenantId) {
      const { rows } = tenantId === undefined
        ? await pool.query<Row>(`SELECT * FROM messaging_identities ORDER BY created_at ASC`)
        : await pool.query<Row>(`SELECT * FROM messaging_identities WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]);
      return rows.map(rowToIdentityPg);
    },
    async deleteMessagingIdentity(identityId) {
      const r = await pool.query(`DELETE FROM messaging_identities WHERE identity_id = $1`, [identityId]);
      return (r.rowCount ?? 0) > 0;
    },
    async appendDeliveryLog(record) {
      await pool.query(
        `INSERT INTO messaging_delivery_log (log_id, tenant_id, relay_id, channel, direction, conversation_id, status, detail, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [record.logId, record.tenantId, record.relayId ?? null, record.channel, record.direction, record.conversationId, record.status, record.detail ?? null, record.at],
      );
    },
    async listDeliveryLog(filter) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filter.tenantId !== undefined) { params.push(filter.tenantId); clauses.push(`tenant_id = $${params.length}`); }
      if (filter.channel !== undefined) { params.push(filter.channel); clauses.push(`channel = $${params.length}`); }
      if (filter.direction !== undefined) { params.push(filter.direction); clauses.push(`direction = $${params.length}`); }
      if (filter.status !== undefined) { params.push(filter.status); clauses.push(`status = $${params.length}`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      // Clamp to [1, 1000]; coerce a non-finite limit (e.g. NaN) to the default.
      const rawLimit = filter.limit ?? 100;
      const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), 1000) : 100;
      params.push(limit);
      const { rows } = await pool.query<Row>(
        `SELECT * FROM messaging_delivery_log ${where} ORDER BY at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToDeliveryLogPg);
    },

    async appendMessagingTurn(record) {
      await pool.query(
        `INSERT INTO messaging_turns (turn_id, session_key, tenant_id, role, content, run_id, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [record.turnId, record.sessionKey, record.tenantId, record.role, record.content, record.runId ?? null, record.at],
      );
    },
    async listMessagingTurns(sessionKey, limit, tenantId) {
      const lim = Number.isFinite(limit) && limit >= 1 ? Math.min(Math.floor(limit), 1000) : 100;
      // Fetch the most-recent N then return them oldest → newest (for
      // messages[]). tenant_id filter is defense-in-depth.
      const { rows } = await pool.query<Row>(
        `SELECT * FROM (
           SELECT * FROM messaging_turns
            WHERE session_key = $1 AND tenant_id = $2
            ORDER BY at DESC, turn_id DESC LIMIT $3
         ) t ORDER BY at ASC, turn_id ASC`,
        [sessionKey, tenantId, lim],
      );
      return rows.map(rowToTurnPg);
    },

    async appendMessagingPairing(record) {
      await pool.query(
        `INSERT INTO messaging_pairings (pairing_id, connector_id, tenant_id, channel, peer_id, code, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [record.pairingId, record.connectorId, record.tenantId, record.channel, record.peerId, record.code, record.expiresAt, record.createdAt],
      );
    },
    async getMessagingPairingByCode(connectorId, code) {
      const { rows } = await pool.query<Row>(`SELECT * FROM messaging_pairings WHERE connector_id = $1 AND code = $2`, [connectorId, code]);
      return rows[0] ? rowToPairingPg(rows[0]) : null;
    },
    async listMessagingPairings(connectorId) {
      const { rows } = connectorId === undefined
        ? await pool.query<Row>(`SELECT * FROM messaging_pairings ORDER BY created_at DESC`)
        : await pool.query<Row>(`SELECT * FROM messaging_pairings WHERE connector_id = $1 ORDER BY created_at DESC`, [connectorId]);
      return rows.map(rowToPairingPg);
    },
    async deleteMessagingPairing(pairingId) {
      const r = await pool.query(`DELETE FROM messaging_pairings WHERE pairing_id = $1`, [pairingId]);
      return (r.rowCount ?? 0) > 0;
    },
    async addMessagingAllowlist(entry) {
      await pool.query(
        `INSERT INTO messaging_allowlist (entry_id, connector_id, tenant_id, channel, peer_id, added_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (connector_id, channel, peer_id) DO NOTHING`,
        [entry.entryId, entry.connectorId, entry.tenantId, entry.channel, entry.peerId, entry.addedAt],
      );
    },
    async getMessagingAllowlist(connectorId, channel, peerId) {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM messaging_allowlist WHERE connector_id = $1 AND channel = $2 AND peer_id = $3`,
        [connectorId, channel, peerId],
      );
      return rows[0] ? rowToAllowlistPg(rows[0]) : null;
    },
    async listMessagingAllowlist(connectorId) {
      const { rows } = connectorId === undefined
        ? await pool.query<Row>(`SELECT * FROM messaging_allowlist ORDER BY added_at DESC`)
        : await pool.query<Row>(`SELECT * FROM messaging_allowlist WHERE connector_id = $1 ORDER BY added_at DESC`, [connectorId]);
      return rows.map(rowToAllowlistPg);
    },
    async deleteMessagingAllowlist(connectorId, channel, peerId) {
      const r = await pool.query(
        `DELETE FROM messaging_allowlist WHERE connector_id = $1 AND channel = $2 AND peer_id = $3`,
        [connectorId, channel, peerId],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async kvGet(key) {
      const { rows } = await pool.query<{ v: string }>(`SELECT v FROM host_ext_kv WHERE k = $1`, [key]);
      return rows[0]?.v ?? null;
    },
    async kvSet(key, value) {
      await pool.query(
        `INSERT INTO host_ext_kv (k, v, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at`,
        [key, value, new Date().toISOString()],
      );
    },
    async kvList(keyPrefix) {
      const escaped = keyPrefix.replace(/[\\%_]/g, '\\$&');
      const { rows } = await pool.query<{ k: string; v: string }>(
        `SELECT k, v FROM host_ext_kv WHERE k LIKE $1 ESCAPE '\\' ORDER BY k`,
        [`${escaped}%`],
      );
      return rows.map((r) => ({ key: r.k, value: r.v }));
    },
    async kvListContaining(keyPrefix, needle) {
      const esc = (s: string): string => s.replace(/[\\%_]/g, '\\$&');
      const { rows } = await pool.query<{ k: string; v: string }>(
        `SELECT k, v FROM host_ext_kv WHERE k LIKE $1 ESCAPE '\\' AND v LIKE $2 ESCAPE '\\' ORDER BY k`,
        [`${esc(keyPrefix)}%`, `%${esc(needle)}%`],
      );
      return rows.map((r) => ({ key: r.k, value: r.v }));
    },
    async kvDelete(key) {
      const { rowCount } = await pool.query(`DELETE FROM host_ext_kv WHERE k = $1`, [key]);
      return (rowCount ?? 0) > 0;
    },
    async kvCompareAndSwap(key, expected, next) {
      const ts = new Date().toISOString();
      if (expected === null) {
        // Swap only if absent: INSERT … ON CONFLICT DO NOTHING is atomic.
        const ins = await pool.query<{ v: string }>(
          `INSERT INTO host_ext_kv (k, v, updated_at) VALUES ($1, $2, $3)
           ON CONFLICT (k) DO NOTHING RETURNING v`,
          [key, next, ts],
        );
        if ((ins.rowCount ?? 0) > 0) return { swapped: true, actual: next };
        const cur = await pool.query<{ v: string }>(`SELECT v FROM host_ext_kv WHERE k = $1`, [key]);
        return { swapped: false, actual: cur.rows[0]?.v ?? null };
      }
      // Swap only if the current value matches: a single guarded UPDATE.
      const upd = await pool.query<{ v: string }>(
        `UPDATE host_ext_kv SET v = $3, updated_at = $4 WHERE k = $1 AND v = $2 RETURNING v`,
        [key, expected, next, ts],
      );
      if ((upd.rowCount ?? 0) > 0) return { swapped: true, actual: next };
      const cur = await pool.query<{ v: string }>(`SELECT v FROM host_ext_kv WHERE k = $1`, [key]);
      return { swapped: false, actual: cur.rows[0]?.v ?? null };
    },

    async publish(channel, payload) {
      await pool.query(`SELECT pg_notify($1, $2)`, [PUBSUB_CHANNEL, JSON.stringify({ c: channel, p: payload })]);
    },
    async subscribe(channel, handler) {
      let handlers = channelHandlers.get(channel);
      if (!handlers) {
        handlers = new Set();
        channelHandlers.set(channel, handlers);
      }
      handlers.add(handler);
      await ensureListener();
      return async () => {
        const set = channelHandlers.get(channel);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) channelHandlers.delete(channel);
      };
    },

    // ── app metadata (ADR 0052) ──
    async getAppMeta(key) {
      const { rows } = await pool.query<{ value: string }>(
        `SELECT value FROM __app_meta WHERE key = $1`, [key]);
      return rows[0] ? rows[0].value : null;
    },
    async setAppMeta(key, value) {
      await pool.query(
        `INSERT INTO __app_meta (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, value, new Date().toISOString()],
      );
    },

    async close() {
      closing = true;
      if (listenClient) {
        try { listenClient.release(); } catch { /* already gone */ }
        listenClient = null;
      }
      await pool.end();
    },
  };
  return impl;
}

function rowToRelayDevicePg(r: Row): RelayDeviceRecord {
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

function rowToEgressPg(r: Row): ChatEgressEnvelope {
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

function rowToConnectorPg(r: Row): MessagingConnectorRecord {
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

function rowToSessionPg(r: Row): MessagingSessionRecord {
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

function rowToPolicyPg(r: Row): MessagingPolicyRecord {
  return {
    connectorId: r.connector_id as string,
    tenantId: r.tenant_id as string,
    dmPolicy: r.dm_policy as MessagingPolicyRecord['dmPolicy'],
    groupPolicy: r.group_policy as MessagingPolicyRecord['groupPolicy'],
    requireMention: Boolean(r.require_mention),
    updatedAt: r.updated_at as string,
  };
}

function rowToRoutingRulePg(r: Row): MessagingRoutingRuleRecord {
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

function rowToIdentityPg(r: Row): MessagingIdentityRecord {
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

function rowToPairingPg(r: Row): MessagingPairingRecord {
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

function rowToAllowlistPg(r: Row): MessagingAllowlistEntry {
  return {
    entryId: r.entry_id as string,
    connectorId: r.connector_id as string,
    tenantId: r.tenant_id as string,
    channel: r.channel as MessagingAllowlistEntry['channel'],
    peerId: r.peer_id as string,
    addedAt: r.added_at as string,
  };
}

function rowToTurnPg(r: Row): MessagingTurnRecord {
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

function rowToDeliveryLogPg(r: Row): DeliveryLogRecord {
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
