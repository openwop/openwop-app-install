/**
 * Hermetic Postgres storage tests using `pg-mem`.
 *
 * pg-mem implements a Postgres-compatible SQL engine in pure JS. It
 * exposes the same `pg.Pool` shape that the production driver uses, so
 * the same Storage implementation runs against it without modification.
 * That lets us assert on real SQL (parameterized queries, JSONB
 * columns, ON CONFLICT semantics, UNIQUE constraints) without a real
 * server in CI.
 *
 * Caveats:
 *   - pg-mem does not implement all of Postgres. We avoid features it
 *     doesn't support (e.g., advisory locks). The shape we exercise
 *     here is the same shape the Cloud SQL deploy uses.
 *   - pg-mem's `INSERT … ON CONFLICT DO NOTHING RETURNING` honors the
 *     conflict + returns row only on insert, matching real Postgres.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { applyMigrations } from '../src/storage/postgres/schema.js';
import { buildListAuditQuery } from '../src/storage/postgres/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord, EventRecord } from '../src/types.js';

function rowToUserAgentTestImpl(r: Record<string, unknown>): import('../src/types.js').UserAgentRecord {
  return {
    agentId: r.agent_id as string,
    tenantId: r.tenant_id as string,
    persona: r.persona as string,
    label: (r.label as string | null) ?? undefined,
    description: (r.description as string | null) ?? undefined,
    modelClass: r.model_class as string,
    systemPrompt: r.system_prompt as string,
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
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function rowToDispatchOutboxTestImpl(r: Record<string, unknown>): import('../src/types.js').DispatchOutboxRecord {
  return {
    runId: r.run_id as string,
    tenantId: r.tenant_id as string,
    workflowId: r.workflow_id as string,
    status: r.status as 'pending' | 'dead',
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    claimedBy: (r.claimed_by as string | null) ?? null,
    claimExpiresAt: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
    lastError: (r.last_error as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// Build a pg-mem-backed Storage by reusing the same impl as production
// but with the pool replaced. The production `openPostgresStorage`
// connects via `pg.Pool`; pg-mem ships a compatible adapter.
async function makeStorage(): Promise<Storage> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  // Migrations expect a Client; pg-mem's Pool.connect returns a
  // compatible client.
  const client = await pool.connect();
  try {
    await applyMigrations(client);
  } finally {
    client.release();
  }

  // Hand-implement just enough of Storage to test the schema +
  // migration roundtrip. The production impl in src/storage/postgres
  // is exercised end-to-end by integration tests in CI; this hermetic
  // test verifies the schema applies cleanly and one round-trip works.
  return {
    // ADR 0591 — real implementations, not throwing stubs: the escape ledger's
    // whole point is that a repeat escape becomes a SECOND row, and this suite
    // is where the postgres side of that invariant gets exercised.
    // Real, for the same reason as the escape ledger below: this suite is where
    // the postgres side of the RFC 0173 §C.2 projection gets exercised, and a
    // throwing stub would make the effects route untested on the backend that
    // actually ships.
    async listRunEffects(runId) {
      const res = await pool.query(
        `SELECT node_id AS "nodeId", attempt, invocation_id AS "invocationId",
                (result IS NOT NULL) AS completed, created_at AS at
           FROM invocation_log WHERE run_id = $1 ORDER BY created_at, node_id, attempt`,
        [runId],
      );
      return res.rows.map((r: { nodeId: string; attempt: number; invocationId: string; completed: boolean; at: unknown }) => ({
        nodeId: r.nodeId, attempt: Number(r.attempt), invocationId: r.invocationId,
        completed: Boolean(r.completed), at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      }));
    },
    async appendEffectEscape({ runId, nodeId, invocationId, effectKind, createdAt }) {
      await pool.query(
        `INSERT INTO effect_escape_ledger
           (run_id, node_id, invocation_id, effect_kind, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [runId, nodeId, invocationId, effectKind, createdAt],
      );
    },
    async listEffectEscapes(runId: string) {
      const res = await pool.query(
        `SELECT invocation_id AS "invocationId", node_id AS "nodeId", COUNT(*)::int AS count
           FROM effect_escape_ledger WHERE run_id = $1
          GROUP BY invocation_id, node_id ORDER BY invocation_id`,
        [runId],
      );
      return res.rows as Array<{ invocationId: string; nodeId: string; count: number }>;
    },
    async deleteOrphanAgentRunActivity() {
      const { rowCount } = await pool.query(
        `DELETE FROM agent_run_activity a WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = a.run_id)`,
      );
      return rowCount ?? 0;
    },
    async hasRunForWorkflow(workflowId: string, filter?: { status?: RunRecord['status'] }) {
      const { rows } = filter?.status
        ? await pool.query(`SELECT 1 FROM runs WHERE workflow_id = $1 AND status = $2 LIMIT 1`, [workflowId, filter.status])
        : await pool.query(`SELECT 1 FROM runs WHERE workflow_id = $1 LIMIT 1`, [workflowId]);
      return rows.length > 0;
    },
    // ADR 0551 P1 — dispatch outbox. Mirrors the production SQL minus
    // `FOR UPDATE SKIP LOCKED`, which pg-mem does not implement (the same
    // caveat this file's header already records for advisory locks).
    async claimDispatchOutbox(workerId: string, nowMs: number, leaseMs: number, limit: number) {
      const { rows } = await pool.query(
        `UPDATE dispatch_outbox SET claimed_by = $1, claim_expires_at = $2, updated_at = $3
          WHERE run_id IN (
            SELECT run_id FROM dispatch_outbox
             WHERE status = 'pending' AND next_attempt_at <= $4
               AND (claim_expires_at IS NULL OR claim_expires_at < $4)
             ORDER BY next_attempt_at ASC LIMIT $5)
          RETURNING *`,
        [workerId, nowMs + leaseMs, new Date(nowMs).toISOString(), nowMs, limit],
      );
      return (rows as Array<Record<string, unknown>>).map(rowToDispatchOutboxTestImpl);
    },
    async getDispatchOutbox(runId: string) {
      const { rows } = await pool.query(`SELECT * FROM dispatch_outbox WHERE run_id = $1`, [runId]);
      return rows[0] ? rowToDispatchOutboxTestImpl(rows[0] as Record<string, unknown>) : null;
    },
    async completeDispatchOutbox(runId: string) {
      await pool.query(`DELETE FROM dispatch_outbox WHERE run_id = $1`, [runId]);
    },
    async rescheduleDispatchOutbox(runId: string, nextAttemptAt: number, dead: boolean, error: string) {
      await pool.query(
        `UPDATE dispatch_outbox
            SET attempts = attempts + 1, status = $2, next_attempt_at = $3,
                last_error = $4, claimed_by = NULL, claim_expires_at = NULL, updated_at = $5
          WHERE run_id = $1`,
        [runId, dead ? 'dead' : 'pending', nextAttemptAt, error, new Date().toISOString()],
      );
    },
    // ADR 0551 P2 — the operator projection + redrive, in the same hermetic
    // shape: real SQL against the real schema, so this double proves the
    // Postgres statements PARSE even where Docker is unavailable.
    async dispatchOutboxStats() {
      const { rows } = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE status = 'dead')    AS dead,
            MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
           FROM dispatch_outbox`,
      );
      const r = (rows as Array<Record<string, unknown>>)[0];
      return {
        pending: Number(r?.pending ?? 0),
        dead: Number(r?.dead ?? 0),
        oldestPendingCreatedAt: (r?.oldest_pending as string | null) ?? null,
      };
    },
    async listDispatchOutbox({ status, limit }: { status: 'pending' | 'dead'; limit: number }) {
      const { rows } = await pool.query(
        `SELECT * FROM dispatch_outbox WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
        [status, limit],
      );
      return (rows as Array<Record<string, unknown>>).map(rowToDispatchOutboxTestImpl);
    },
    async redriveDispatchOutbox(runId: string, nextAttemptAt: number, reason: string) {
      const result = await pool.query(
        `UPDATE dispatch_outbox
            SET status = 'pending', attempts = 0, next_attempt_at = $2,
                last_error = $3, claimed_by = NULL, claim_expires_at = NULL, updated_at = $4
          WHERE run_id = $1 AND status = 'dead'`,
        [runId, nextAttemptAt, reason, new Date().toISOString()],
      );
      return ((result as { rowCount?: number }).rowCount ?? 0) > 0;
    },
    async listRunsPastRemoval(now: string, limit: number) {
      // Hermetic mock: the sweeper only needs ids ordered by deadline; reuse
      // the object's own getRun via a second query round-trip.
      const { rows } = await pool.query(`SELECT run_id FROM runs WHERE removal_at IS NOT NULL AND removal_at < $1 ORDER BY removal_at ASC LIMIT $2`, [now, limit]);
      const out: RunRecord[] = [];
      for (const r of rows as Array<{ run_id: string }>) {
        const { rows: one } = await pool.query(`SELECT * FROM runs WHERE run_id = $1`, [r.run_id]);
        if (one[0]) out.push({ runId: one[0].run_id, workflowId: one[0].workflow_id, tenantId: one[0].tenant_id, status: one[0].status, inputs: one[0].inputs, metadata: one[0].metadata ?? {}, configurable: one[0].configurable ?? {}, createdAt: String(one[0].created_at), updatedAt: String(one[0].updated_at) } as RunRecord);
      }
      return out;
    },
    async clearRunRemoval(runId: string) {
      await pool.query(`UPDATE runs SET removal_at = NULL WHERE run_id = $1`, [runId]);
    },
    async mergeRunMetadata(runId: string, patch: Record<string, unknown>, opts?: { ifAbsentKey?: string }) {
      const removals = Object.keys(patch).filter((k) => patch[k] === null);
      const sets = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
      const res = await pool.query(
        `UPDATE runs
           SET metadata = (COALESCE(metadata, '{}'::jsonb) || $2::jsonb) - $4::text[]
         WHERE run_id = $1
           AND ($3::text IS NULL OR NOT (COALESCE(metadata, '{}'::jsonb) ? $3::text))`,
        [runId, JSON.stringify(sets), opts?.ifAbsentKey ?? null, removals],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async insertRun(run: RunRecord) {
      await pool.query(
        `INSERT INTO runs (
          run_id, workflow_id, tenant_id, status,
          inputs, metadata, configurable,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          run.runId, run.workflowId, run.tenantId, run.status,
          run.inputs ?? null,
          run.metadata ?? {},
          run.configurable ?? {},
          run.createdAt, run.updatedAt,
        ],
      );
    },
    async getRun(runId: string) {
      const { rows } = await pool.query(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        runId: r.run_id,
        workflowId: r.workflow_id,
        tenantId: r.tenant_id,
        status: r.status,
        inputs: r.inputs,
        metadata: r.metadata ?? {},
        configurable: r.configurable ?? {},
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      } as RunRecord;
    },
    // Minimum-viable stubs for the remaining methods — these tests
    // only cover the schema's run + event surface. Other methods
    // throw if accessed.
    updateRun: async () => { throw new Error('not exercised'); },
    listRunsByParent: async () => { throw new Error('not exercised'); },
    countAuditRows: async () => { throw new Error('not exercised'); },
    listTenantActivity: async () => { throw new Error('not exercised'); },
    listHostExtTenantActivity: async () => { throw new Error('not exercised'); },
    deleteRun: async () => { throw new Error('not exercised'); },
    insertAnnotation: async () => { throw new Error('not exercised'); },
    listAnnotations: async () => [],
    listRuns: async () => [],
    appendEvent: async (input) => {
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM events WHERE run_id = $1`,
        [input.runId],
      );
      const seq = Number((rows[0] as { seq: number }).seq);
      await pool.query(
        `INSERT INTO events (event_id, run_id, sequence, type, payload, timestamp)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [input.eventId, input.runId, seq, input.type, input.payload ?? null, input.timestamp],
      );
      return { ...input, sequence: seq } as EventRecord;
    },
    appendEventsBatch: async (inputs) => {
      const out: EventRecord[] = [];
      for (const input of inputs) {
        const { rows } = await pool.query(
          `SELECT COALESCE(MAX(sequence),0)+1 AS seq FROM events WHERE run_id = $1`,
          [input.runId],
        );
        const seq = Number((rows[0] as { seq: number }).seq);
        await pool.query(
          `INSERT INTO events (event_id, run_id, sequence, type, payload, timestamp)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [input.eventId, input.runId, seq, input.type, input.payload ?? null, input.timestamp],
        );
        out.push({ ...input, sequence: seq } as EventRecord);
      }
      return out;
    },
    // ADR 0754 — not exercised by this schema round-trip; the adapter-parity
    // suite covers the method on both backends.
    findFirstEventByPayload: async () => { throw new Error('not exercised'); },
    listEvents: async (runId, opts = {}) => {
      const fromSeq = opts.fromSeq ?? 0;
      const { rows } = await pool.query(
        `SELECT * FROM events WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC`,
        [runId, fromSeq],
      );
      return rows.map((r: Record<string, unknown>) => ({
        eventId: r.event_id as string,
        runId: r.run_id as string,
        sequence: r.sequence as number,
        type: r.type as string,
        nodeId: (r.node_id as string | null) ?? undefined,
        payload: r.payload ?? null,
        timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : (r.timestamp as string),
        causationId: (r.causation_id as string | null) ?? undefined,
      }));
    },
    getMaxSequence: async (runId) => {
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(sequence),0) AS max FROM events WHERE run_id = $1`,
        [runId],
      );
      return Number((rows[0] as { max: number } | undefined)?.max ?? 0);
    },
    insertInterrupt: async () => { throw new Error('not exercised'); },
    getInterrupt: async () => null,
    getInterruptByToken: async () => null,
    getInterruptByNode: async () => null,
    resolveInterrupt: async () => { throw new Error('not exercised'); },
    listOpenInterrupts: async () => [],
    listOpenInterruptsAll: async () => [],
    insertWebhook: async () => { throw new Error('not exercised'); },
    rotateWebhookSecret: async () => { throw new Error('not exercised'); },
    retireExpiredWebhookSecrets: async () => 0,
    blankTerminalDeliverySecrets: async () => 0,
    getWebhook: async () => null,
    deleteWebhook: async () => { throw new Error('not exercised'); },
    listWebhooks: async () => [],
    enqueueWebhookDelivery: async () => { throw new Error('not exercised'); },
    claimDueWebhookDeliveries: async () => [],
    markWebhookDeliveryDelivered: async () => { throw new Error('not exercised'); },
    rescheduleWebhookDelivery: async () => { throw new Error('not exercised'); },
    listWebhookDeliveries: async () => { throw new Error('not exercised'); },
    retryWebhookDelivery: async () => { throw new Error('not exercised'); },
    setRunDispatchLease: async () => { throw new Error('not exercised'); },
    renewRunDispatchLeaseIfOwner: async () => { throw new Error('not exercised'); },
    claimRunExecution: async () => { throw new Error('not exercised'); },
    claimOrphanedRuns: async () => [],
    claimOnce: async (key, createdAt) => {
      const ins = await pool.query(
        `INSERT INTO idempotency (key, response_body, response_status, created_at)
         VALUES ($1, '__pending__', 0, $2)
         ON CONFLICT (key) DO NOTHING
         RETURNING key`,
        [key, createdAt],
      );
      // pg returns rows.length === 1 on insert; 0 on conflict. (pg-mem
      // reports rowCount differently, so we key off rows.length.)
      if (ins.rows.length === 1) return { claimed: true, existing: null };
      const { rows } = await pool.query(
        `SELECT key, response_body, response_status, created_at FROM idempotency WHERE key = $1`,
        [key],
      );
      const r = rows[0];
      return {
        claimed: false,
        existing: {
          key: r.key,
          responseBody: r.response_body,
          responseStatus: r.response_status,
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        },
      };
    },
    putOnce: async () => { throw new Error('not exercised'); },
    pruneOnceByPrefix: async () => 0,
    // ADR 0549 — mirrors src/storage/postgres/index.ts, but keyed off
    // `rows.length` for the same pg-mem reason as `claimOnce` above. This
    // double exists to prove migration 35's DDL applies and round-trips under
    // pg-mem; the claim RACE is covered against a real Postgres in the
    // testcontainers parity suite, because pg-mem's `ON CONFLICT DO NOTHING
    // RETURNING` is not faithful (see the note at the end of this file).
    // ADR 0551 P0 — workspace. Not exercised under pg-mem; present so the
    // double still satisfies the Storage contract.
    //
    // CORRECTED H59 (2026-08-18). This comment used to assert that "the CAS
    // race is covered against real Postgres in the testcontainers parity
    // suite". It was not: `grep -c workspace` in that file returned 0, so the
    // Postgres workspace CAS was exercised NOWHERE — here by a stub that
    // throws, there not at all — while this note told every reader it was
    // covered. The legs now exist (`ADR 0551 P0 workspace CAS`: concurrent
    // If-Match, racing no-If-Match etag consistency, stale If-Match, WCT-1)
    // and `scripts/ci.sh` runs that file under `OPENWOP_CI_LIVE=1` with a
    // hard Docker require, so the claim is true as of H59 — but it is worth
    // knowing it was a claim before it was a fact.
    getWorkspaceFile: async () => null,
    listWorkspaceFiles: async () => [],
    putWorkspaceFile: async () => { throw new Error('not exercised'); },
    deleteWorkspaceFile: async () => false,
    claimIdempotentResponse: async (input) => {
      const ins = await pool.query(
        `INSERT INTO idempotent_response
           (tenant_id, endpoint_id, idempotency_key, request_digest, state, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'pending',$5::timestamptz,$5::timestamptz)
         ON CONFLICT (tenant_id, endpoint_id, idempotency_key) DO NOTHING
         RETURNING idempotency_key`,
        [input.tenantId, input.endpoint, input.key, input.requestDigest, input.createdAt],
      );
      if (ins.rows.length === 1) return { outcome: 'claimed' as const, claimToken: 'pgmem-token' };
      const { rows } = await pool.query(
        `SELECT request_digest, state, response_status, response_body
           FROM idempotent_response
          WHERE tenant_id = $1 AND endpoint_id = $2 AND idempotency_key = $3`,
        [input.tenantId, input.endpoint, input.key],
      );
      const r = rows[0]!;
      if (r.request_digest !== input.requestDigest) return { outcome: 'mismatch' as const };
      if (r.state === 'completed') {
        return {
          outcome: 'replay' as const,
          responseStatus: r.response_status ?? 200,
          responseBody: r.response_body ?? '',
        };
      }
      return { outcome: 'in-flight' as const };
    },
    pruneIdempotentResponses: async (olderThanIso) => {
      const { rowCount } = await pool.query(
        `DELETE FROM idempotent_response WHERE created_at < $1::timestamptz`,
        [olderThanIso],
      );
      return rowCount ?? 0;
    },
    releaseIdempotentResponse: async () => { /* not exercised under pg-mem */ },
    completeIdempotentResponse: async (input) => {
      await pool.query(
        `UPDATE idempotent_response
            SET state = 'completed', response_status = $4, response_body = $5,
                run_id = $6, updated_at = $7::timestamptz
          WHERE tenant_id = $1 AND endpoint_id = $2 AND idempotency_key = $3
            AND state <> 'completed'`,
        [input.tenantId, input.endpoint, input.key, input.responseStatus, input.responseBody, input.runId ?? null, input.updatedAt],
      );
      return true;
    },
    appendAudit: async () => { throw new Error('not exercised'); },
    listAudit: async () => [],
    getInvocation: async () => null,
    getLatestInvocation: async () => null,
    claimInvocation: async () => true,
  releaseInvocationClaim: async () => undefined,
  putInvocation: async () => { throw new Error('not exercised'); },
    upsertEncryptedSecret: async () => { throw new Error('not exercised'); },
    getEncryptedSecret: async () => null,
    deleteSecret: async () => { throw new Error('not exercised'); },
    listSecretRefs: async () => [],
    upsertTenantSecret: async () => { throw new Error('not exercised'); },
    getTenantSecret: async () => null,
    deleteTenantSecret: async () => { throw new Error('not exercised'); },
    listTenantSecretRefs: async () => [],
    deleteAllTenantSecrets: async () => 0,
    reassignTenant: async () => ({ tables: {}, hostExt: 0, hostExtKeysRekeyed: 0, hostExtKeysDeduped: 0, runs: 0, workflows: 0, notifications: 0, pushSubscriptions: 0 }),
    deleteAllTenantData: async () => ({ runs: 0, events: 0, interrupts: 0, workflows: 0, secrets: 0, notifications: 0, pushSubscriptions: 0, otherRows: 0, tablesCovered: 0 }),
    pruneTerminalRuns: async () => ({ runs: 0, childRows: 0 }),
    pruneWebhookDeliveries: async () => 0,
    incrementManagedUsage: async () => {},
    getManagedUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
    deleteManagedUsageForTenant: async () => 0,
    deleteMediaUsageForTenant: async () => 0,
    incrementMediaUsage: async () => {},
    getMediaUsage: async () => ({ ttsChars: 0, sttBytes: 0 }),
    incrementByokChatUsage: async () => {},
    getByokChatUsage: async () => ({ inputTokens: 0, outputTokens: 0 }),
    getEnvelopeCorrelation: async () => null,
    putEnvelopeCorrelation: async () => {},
    listChatSessions: async () => [],
    createChatSession: async () => { throw new Error('not exercised'); },
    getChatSession: async () => null,
    updateChatSession: async () => { throw new Error('not exercised'); },
    casChatSessionTitle: async () => { throw new Error('not exercised'); },
    deleteChatSession: async () => false,
    listChatSessionMessages: async () => [],
    countChatSessionMessages: async () => 0,
    appendChatMessage: async () => { throw new Error('not exercised'); },
    updateChatMessageContent: async () => { throw new Error('not exercised'); },
    getChatMessageAuthor: async () => { throw new Error('not exercised'); },
    getChatMessage: async () => { throw new Error('not exercised'); },
    insertNotification: async () => { throw new Error('not exercised'); },
    listNotifications: async () => [],
    getNotification: async () => null,
    updateNotificationStatus: async () => null,
    markAllNotificationsRead: async () => 0,
    deleteNotification: async () => false,
    deleteAllTenantNotifications: async () => 0,
    deleteNotificationsForSubject: async () => 0,
    insertPushSubscription: async () => { throw new Error('not exercised'); },
    listPushSubscriptions: async () => [],
    getPushSubscriptionByEndpoint: async () => null,
    deletePushSubscription: async () => false,
    deleteAllTenantPushSubscriptions: async () => 0,
    // Real impls — exercised by the `round-trips user_agents` test
    // below. Mirror the production postgres adapter shape.
    insertUserAgent: async (record) => {
      await pool.query(
        `INSERT INTO user_agents (
          agent_id, tenant_id, persona, label, description, model_class,
          system_prompt, tool_allowlist,
          memory_scratchpad, memory_conversation, memory_long_term,
          confidence_threshold, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
        [
          record.agentId, record.tenantId, record.persona,
          record.label ?? null, record.description ?? null, record.modelClass,
          record.systemPrompt, JSON.stringify(record.toolAllowlist),
          record.memoryShape.scratchpad,
          record.memoryShape.conversation,
          record.memoryShape.longTerm,
          record.confidenceThreshold ?? null, record.createdAt,
        ],
      );
    },
    listUserAgents: async (tenantId) => {
      const r = await pool.query(
        `SELECT * FROM user_agents WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return r.rows.map(rowToUserAgentTestImpl);
    },
    listAllUserAgents: async () => {
      const r = await pool.query(`SELECT * FROM user_agents ORDER BY created_at DESC`);
      return r.rows.map(rowToUserAgentTestImpl);
    },
    getUserAgent: async (tenantId, agentId) => {
      const r = await pool.query(
        `SELECT * FROM user_agents WHERE agent_id = $1 AND tenant_id = $2`,
        [agentId, tenantId],
      );
      return r.rows[0] ? rowToUserAgentTestImpl(r.rows[0]) : null;
    },
    getUserAgentAnyTenant: async (agentId) => {
      const r = await pool.query(
        `SELECT * FROM user_agents WHERE agent_id = $1`,
        [agentId],
      );
      return r.rows[0] ? rowToUserAgentTestImpl(r.rows[0]) : null;
    },
    deleteUserAgent: async (tenantId, agentId) => {
      const r = await pool.query(`DELETE FROM user_agents WHERE agent_id = $1 AND tenant_id = $2`, [agentId, tenantId]);
      return (r.rowCount ?? 0) > 0;
    },
    updateUserAgent: async () => { throw new Error('not exercised'); },
    // messaging relay-gateway — not exercised by this schema round-trip test
    upsertRelayDevice: async () => { throw new Error('not exercised'); },
    getRelayDevice: async () => null,
    getRelayDeviceByTokenHash: async () => null,
    listRelayDevices: async () => [],
    recordAgentRunAttribution: async () => {},
    listAgentRunActivity: async () => [],
    consumeRunBudget: async () => 1,
    pruneRunBudget: async () => 0,
    enqueueRelayOutbound: async () => { throw new Error('not exercised'); },
    listRelayOutbound: async () => [],
    ackRelayOutbound: async () => 0,
    deleteRelayOutbound: async () => { throw new Error('not exercised'); },
    upsertMessagingConnector: async () => { throw new Error('not exercised'); },
    getMessagingConnector: async () => null,
    listMessagingConnectors: async () => [],
    upsertMessagingSession: async () => { throw new Error('not exercised'); },
    getMessagingSession: async () => null,
    listMessagingSessions: async () => [],
    deleteMessagingSession: async () => false,
    upsertMessagingPolicy: async () => { throw new Error('not exercised'); },
    getMessagingPolicy: async () => null,
    upsertMessagingRoutingRule: async () => { throw new Error('not exercised'); },
    listMessagingRoutingRules: async () => [],
    deleteMessagingRoutingRule: async () => false,
    upsertMessagingIdentity: async () => { throw new Error('not exercised'); },
    getMessagingIdentity: async () => null,
    listMessagingIdentities: async () => [],
    deleteMessagingIdentity: async () => false,
    appendDeliveryLog: async () => { throw new Error('not exercised'); },
    listDeliveryLog: async () => [],
    appendMessagingTurn: async () => { throw new Error('not exercised'); },
    listMessagingTurns: async () => [],
    appendMessagingPairing: async () => { throw new Error('not exercised'); },
    getMessagingPairingByCode: async () => null,
    listMessagingPairings: async () => [],
    deleteMessagingPairing: async () => false,
    addMessagingAllowlist: async () => { throw new Error('not exercised'); },
    getMessagingAllowlist: async () => null,
    listMessagingAllowlist: async () => [],
    deleteMessagingAllowlist: async () => false,
    kvGet: async () => null,
    kvSet: async () => {},
    kvList: async () => [],
    kvDelete: async () => false,
    kvCompareAndSwap: async () => ({ swapped: false, actual: null }),
    publish: async () => {},
    subscribe: async () => async () => {},
    getAppMeta: async (key: string) => {
      const { rows } = await pool.query(`SELECT value FROM __app_meta WHERE key = $1`, [key]);
      return rows[0] ? (rows[0] as { value: string }).value : null;
    },
    setAppMeta: async (key: string, value: string) => {
      await pool.query(
        `INSERT INTO __app_meta (key, value, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, value, new Date().toISOString()],
      );
    },
    close: async () => { await pool.end(); },
  };
}

describe('Postgres storage (pg-mem)', () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = await makeStorage();
  });

  it('applies migrations idempotently', async () => {
    // Re-running migrations on the same database should be a no-op.
    // The CREATE TABLE IF NOT EXISTS + version-table guard means
    // applyMigrations runs once and stays stable.
    expect(await storage.getRun('non-existent')).toBeNull();
  });

  it('inserts and retrieves a run via JSONB columns', async () => {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: 'r-1',
      workflowId: 'wf-test',
      tenantId: 'anon:abc',
      status: 'running',
      inputs: { msg: 'hello' },
      metadata: { tag: 'demo' },
      configurable: { x: 42 },
      createdAt: now,
      updatedAt: now,
    };
    await storage.insertRun(run);

    const got = await storage.getRun('r-1');
    expect(got).not.toBeNull();
    expect(got!.runId).toBe('r-1');
    expect(got!.workflowId).toBe('wf-test');
    expect(got!.tenantId).toBe('anon:abc');
    expect(got!.status).toBe('running');
    expect(got!.inputs).toEqual({ msg: 'hello' });
    expect(got!.metadata).toEqual({ tag: 'demo' });
    expect(got!.configurable).toEqual({ x: 42 });
  });

  it('appends events with monotonic sequence per runId', async () => {
    const ts = new Date().toISOString();
    await storage.insertRun({
      runId: 'r-2', workflowId: 'wf', tenantId: 't',
      status: 'running', inputs: null, metadata: {}, configurable: {},
      createdAt: ts, updatedAt: ts,
    });

    const ev1 = await storage.appendEvent({
      eventId: 'e-1', runId: 'r-2', type: 'run.started',
      payload: null, timestamp: ts,
    });
    const ev2 = await storage.appendEvent({
      eventId: 'e-2', runId: 'r-2', type: 'node.completed',
      payload: { ok: true }, timestamp: ts,
    });

    expect(ev1.sequence).toBe(1);
    expect(ev2.sequence).toBe(2);

    const max = await storage.getMaxSequence('r-2');
    expect(max).toBe(2);

    const all = await storage.listEvents('r-2');
    expect(all).toHaveLength(2);
    expect(all[0]!.sequence).toBe(1);
    expect(all[1]!.sequence).toBe(2);
    expect(all[1]!.payload).toEqual({ ok: true });
  });

  it('round-trips user_agents (phase E1 migration v14)', async () => {
    // Verifies the postgres adapter's insertUserAgent / listUserAgents /
    // listAllUserAgents / getUserAgent / deleteUserAgent shape matches
    // the sqlite path exercised end-to-end through the routes. Storage
    // parity discipline: every method on Storage MUST behave the same
    // across adapters.
    const now = new Date().toISOString();
    // No `as const` — `toolAllowlist: string[]` on UserAgentRecord is
    // mutable; a readonly tuple literal won't satisfy it. (This test
    // shipped under PR #314 with `as const`; the corpus gate caught
    // it post-merge during the parallel-resume-race rebase. Fixing
    // inline here since we're already touching the file.)
    const record: import('../src/types.js').UserAgentRecord = {
      agentId: 'user.acme.reviewer',
      tenantId: 'acme',
      persona: 'Code Reviewer',
      label: 'Diff-aware reviewer',
      description: 'Reviews diffs for correctness.',
      modelClass: 'coding',
      systemPrompt: 'You are a senior code reviewer.',
      toolAllowlist: ['openwop:core.files.read'],
      memoryShape: { scratchpad: true, conversation: false, longTerm: false },
      confidenceThreshold: 0.7,
      createdAt: now,
    };
    await storage.insertUserAgent(record);

    const got = await storage.getUserAgent('acme', 'user.acme.reviewer');
    expect(got).not.toBeNull();
    expect(got!.persona).toBe('Code Reviewer');
    expect(got!.toolAllowlist).toEqual(['openwop:core.files.read']);
    expect(got!.memoryShape.scratchpad).toBe(true);
    expect(got!.memoryShape.conversation).toBe(false);
    expect(got!.confidenceThreshold).toBe(0.7);

    // Tenant-scoped list returns the row for the owning tenant.
    const acmeList = await storage.listUserAgents('acme');
    expect(acmeList).toHaveLength(1);
    expect(acmeList[0]!.agentId).toBe('user.acme.reviewer');

    // A different tenant sees nothing — this is the storage-layer
    // half of the cross-tenant isolation invariant (`agent-memory.md`
    // CTI-1). The route-layer filter in routes/agents.ts is the
    // other half.
    const betaList = await storage.listUserAgents('beta');
    expect(betaList).toHaveLength(0);

    // listAllUserAgents is cross-tenant for the boot-time registry
    // loader — by design, since the in-process AgentRegistry is
    // process-local. Tenant-isolation lives at the storage list
    // (above) + route filter + registry-projection layers.
    const allList = await storage.listAllUserAgents();
    expect(allList.length).toBeGreaterThanOrEqual(1);
    expect(allList.some((r) => r.agentId === 'user.acme.reviewer')).toBe(true);

    // ADR 0379 P1 — the tenant is in the predicate: a cross-tenant get/delete
    // is null/false, indistinguishable from absent.
    expect(await storage.getUserAgent('beta', 'user.acme.reviewer')).toBeNull();
    expect(await storage.deleteUserAgent('beta', 'user.acme.reviewer')).toBe(false);
    expect(await storage.getUserAgentAnyTenant('user.acme.reviewer')).not.toBeNull();

    const removed = await storage.deleteUserAgent('acme', 'user.acme.reviewer');
    expect(removed).toBe(true);
    expect(await storage.getUserAgent('acme', 'user.acme.reviewer')).toBeNull();
    expect(await storage.deleteUserAgent('acme', 'user.acme.reviewer')).toBe(false);
  });

  // Note: `claimOnce` round-trips through `INSERT … ON CONFLICT
  // DO NOTHING RETURNING`. pg-mem does not faithfully implement
  // RETURNING on conflict-suppressed inserts (it returns the proposed
  // row regardless of whether the conflict fired). Real Postgres
  // returns rows only on successful insert, which is the behavior the
  // production code depends on. We cover this path via integration
  // tests against a real Postgres instance in CI deploy smoke.
});

/**
 * `listAudit` SQL shape — the prod-only TIMESTAMPTZ trap.
 *
 * `audit_log.timestamp` is TIMESTAMPTZ on Postgres but TEXT on sqlite. The
 * adapter used to bind `filter.sinceIso ?? ''` unconditionally: harmless on
 * sqlite (`>= ''` is an always-true string compare), a hard 500 on Postgres
 * (`invalid input syntax for type timestamp with time zone: ""`). That killed
 * every unfiltered audit read in production — the CDP console's governance
 * decision log and the superadmin `/governance/audit` view — while the whole
 * test suite stayed green. These assert the clause is DROPPED when no
 * `sinceIso` is given, and that the SQL actually executes against the real
 * migrated schema.
 */
describe('buildListAuditQuery (TIMESTAMPTZ binding)', () => {
  it('omits the timestamp clause — and never binds an empty string — with no sinceIso', () => {
    const { sql, params } = buildListAuditQuery({ actionPrefix: 'governance.decision.', limit: 200 });
    expect(sql).not.toContain('timestamp >=');
    expect(params).not.toContain('');
    expect(params).toEqual(['governance.decision.%', 200]);
  });

  it('binds the timestamp clause when sinceIso IS given', () => {
    const { sql, params } = buildListAuditQuery({ actionPrefix: 'a.', sinceIso: '2026-01-01T00:00:00.000Z' });
    expect(sql).toContain('timestamp >= $2::timestamptz');
    expect(params).toEqual(['a.%', '2026-01-01T00:00:00.000Z', 100]);
  });

  it('clamps the limit into [1, 500] and escapes LIKE metacharacters in the prefix', () => {
    expect(buildListAuditQuery({ limit: 5000 }).params.at(-1)).toBe(500);
    expect(buildListAuditQuery({ limit: 0 }).params.at(-1)).toBe(1);
    expect(buildListAuditQuery({ actionPrefix: '50%_off' }).params[0]).toBe('50\\%\\_off%');
  });

  it('binds the resource pushdown as an EXACT match, never a pattern (PR #3409 F2)', () => {
    const { sql, params } = buildListAuditQuery({ actionPrefix: 'twin.recall', resource: 'user:u1', limit: 200 });
    expect(sql).toContain('resource = $2');
    expect(sql).not.toContain('resource LIKE'); // prefix semantics would let user:a read user:ab's rows
    expect(params).toEqual(['twin.recall%', 'user:u1', 200]);
    // Absent ⇒ no clause, no empty-string binding (the sinceIso lesson).
    const bare = buildListAuditQuery({ actionPrefix: 'twin.recall', limit: 200 });
    expect(bare.sql).not.toContain('resource =');
    expect(bare.params).toEqual(['twin.recall%', 200]);
  });

  it('executes against the real migrated audit_log schema (both shapes)', async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const pg = db.adapters.createPg();
    const pool = new pg.Pool();
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO audit_log (audit_id, timestamp, principal_id, action, resource, outcome, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      ['a-1', '2026-07-23T00:00:00.000Z', null, 'governance.decision.consent', null, 'allow', null],
    );

    const unfiltered = buildListAuditQuery({ actionPrefix: 'governance.decision.' });
    expect((await pool.query(unfiltered.sql, unfiltered.params)).rows).toHaveLength(1);

    const filtered = buildListAuditQuery({ actionPrefix: 'governance.decision.', sinceIso: '2027-01-01T00:00:00.000Z' });
    expect((await pool.query(filtered.sql, filtered.params)).rows).toHaveLength(0);

    await pool.end();
  });
});
