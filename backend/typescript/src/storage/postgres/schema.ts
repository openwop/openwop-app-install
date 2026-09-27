/**
 * Postgres schema for the workflow-engine sample.
 *
 * Migrations are forward-only; each version adds DDL and bumps
 * LATEST_SCHEMA_VERSION. Tracks the same surface as
 * src/storage/sqlite/schema.ts so behavior is identical regardless of
 * backend. Reference-impl convention only — production deployers
 * should use a real migrator (knex / flyway / drizzle).
 *
 * Tables:
 *   runs              one row per run, indexed by (tenant_id, created_at desc)
 *   events            per-run sequence-ordered event log
 *   interrupts        suspend records with signed-token lookup
 *   webhooks          subscription registry
 *   idempotency       Layer-1 HTTP idempotency key cache
 *   invocation_log    Layer-2 engine-side idempotency cache
 *   workflows         saved workflow definitions, tenant-scoped
 *   audit_log         security + auth audit trail
 *   byok_secrets      encrypted-at-rest BYOK credential records
 */

/**
 * Minimal client surface the migrations need. `pg.Client` and
 * `pg.PoolClient` both satisfy it (their `query` method shape is
 * identical for our usage). Accepting the narrower type lets callers
 * pass a `pool.connect()` result without unsafe casts.
 */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

export const MIGRATIONS: Record<number, (client: Queryable) => Promise<void>> = {
  1: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        scope_id TEXT,
        status TEXT NOT NULL,
        inputs JSONB,
        metadata JSONB,
        configurable JSONB,
        callback_url TEXT,
        idempotency_key TEXT,
        parent_run_id TEXT,
        parent_seq INTEGER,
        fork_mode TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        error_code TEXT,
        error_message TEXT,
        current_node_id TEXT,
        scheduler_snapshot TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_tenant_status
        ON runs (tenant_id, status, created_at DESC);
      -- The tenant-recency read (listRuns: WHERE tenant_id ORDER BY created_at
      -- DESC LIMIT n) canNOT use idx_runs_tenant_status for its ordering —
      -- status sits between tenant_id and created_at — so at ~4k runs/tenant
      -- it degraded to a 35s bitmap+sort on Cloud SQL and blew the 30s
      -- statement timeout (the 2026-07-14 silent-board incident: every
      -- GET /v1/runs/:id 500ed inside its child-run scan). The ordered index
      -- turns it into an early-terminating LIMIT walk. (Applied to prod live
      -- via CREATE INDEX CONCURRENTLY the same day; IF NOT EXISTS makes this
      -- a no-op there.)
      CREATE INDEX IF NOT EXISTS idx_runs_tenant_created
        ON runs (tenant_id, created_at DESC);
      -- Child-run lookup (snapshot childRuns + the cancel cascade) by parent —
      -- replaces the O(tenant) listRuns+filter scan.
      CREATE INDEX IF NOT EXISTS idx_runs_parent
        ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        node_id TEXT,
        payload JSONB,
        timestamp TIMESTAMPTZ NOT NULL,
        causation_id TEXT,
        UNIQUE (run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events (run_id, sequence);

      CREATE TABLE IF NOT EXISTS interrupts (
        interrupt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        data JSONB,
        resume_schema JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        resolved_value JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_interrupts_run_node
        ON interrupts (run_id, node_id, resolved_at);

      -- RFC 0056 annotations: created in migration v20 (NOT here). It was
      -- briefly declared in this v1 block, but forward-only migrations never
      -- re-run v1, so long-lived DBs initialized before that edit never got the
      -- table. Creating it once in v20 fixes those DBs and keeps fresh DBs to a
      -- single CREATE (avoids a redundant no-op create that pg-mem rejects).

      CREATE TABLE IF NOT EXISTS webhooks (
        subscription_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events JSONB NOT NULL,
        tags JSONB,
        secret TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        response_body TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      -- ADR 0618's invocation_claim: created in migration v44 (NOT here) — the
      -- same trap as annotations above, a third time. The v1 block is FROZEN;
      -- test/postgres-v1-migration-frozen.test.ts pins its table set.

      CREATE TABLE IF NOT EXISTS invocation_log (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        provider_key TEXT NOT NULL,
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (run_id, node_id, attempt, provider_key)
      );

      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        definition JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, workflow_id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id TEXT PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        principal_id TEXT,
        action TEXT NOT NULL,
        resource TEXT,
        outcome TEXT,
        payload JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (timestamp DESC);

      CREATE TABLE IF NOT EXISTS byok_secrets (
        credential_ref TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '__global__',
        encrypted_record TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, credential_ref)
      );
    `);
  },
  2: async (client) => {
    // Per-tenant, per-day token usage for managed (server-held-key)
    // providers — see src/providers/managedProvider.ts. Mirrors the
    // sqlite-side migration v4. `date` is the UTC calendar day in
    // YYYY-MM-DD form (TEXT, not DATE, to match the sqlite shape so
    // the Storage interface can stay backend-agnostic).
    await client.query(`
      CREATE TABLE IF NOT EXISTS managed_provider_usage (
        tenant_id TEXT NOT NULL,
        date TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, date, provider_id)
      );
    `);
  },
  3: async (client) => {
    // Envelope-correlation persistence — mirrors sqlite migration v5.
    // Backs the cross-process replay contract from
    // `ai-envelope.md §"Replay determinism"`. Outcome JSON carries the
    // already-redacted payload from envelopeAcceptor.ts §"Step 7", so
    // plaintext envelopes never enter this table (SR-1 redaction-
    // carry-forward holds across the persistence boundary).
    await client.query(`
      CREATE TABLE IF NOT EXISTS envelope_correlations (
        run_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        envelope_type TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (run_id, correlation_id)
      );
    `);
  },
  4: async (client) => {
    // Run-scoped index for future cleanup-on-run-terminal queries
    // (`DELETE FROM envelope_correlations WHERE run_id = $1`). The
    // composite PK's leftmost-prefix usually covers this, but the
    // explicit index makes the intent visible and matches the sqlite
    // v6 mirror. Mirrors `sqlite/schema.ts` v6.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_envelope_correlations_run
        ON envelope_correlations (run_id);
    `);
  },
  5: async (client) => {
    // Host-extension chat-session history backing the new
    // `/v1/host/openwop-app/chat/sessions/*` routes (chat improvements
    // plan §2C.1). Mirrors `sqlite/schema.ts` v7 — two tables,
    // tenant-scoped index, cascade-on-delete from sessions to
    // messages. TIMESTAMPTZ columns round-trip ISO-8601-Z strings.
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        session_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant
        ON chat_sessions (tenant_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        meta TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages (session_id, created_at);
    `);
  },
  6: async (client) => {
    // Per-tenant notification inbox (PR #143). Backs the bell + panel
    // surface in the FE app. The `metadata` column is a free-form JSONB
    // payload — `kind`, `resumeSchema` digest, originating event-log
    // sequence, etc. The `(tenant_id, status, created_at DESC)` index
    // covers the panel's "unread first" listing.
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        notification_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'unread',
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        run_id TEXT,
        workflow_id TEXT,
        node_id TEXT,
        interrupt_id TEXT,
        action_url TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        read_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created
        ON notifications (tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_tenant_status
        ON notifications (tenant_id, status, created_at DESC);
    `);
  },
  7: async (client) => {
    // Web Push subscriptions (RFC 8030 / Web Push Protocol). Each row
    // is one browser/device per tenant — a user with two laptops + a
    // phone produces three rows. The BE pushes a notification to every
    // subscription owned by the tenant on every emit.
    //
    // `endpoint` is the pushService URL the browser handed us at
    // subscribe time (FCM / Mozilla / Apple). `p256dh_key` + `auth_key`
    // are the ECDH + HMAC keys the pushService uses to encrypt the
    // payload before delivering to the browser — these MUST be stored
    // verbatim per the Web Push spec; the `web-push` library handles
    // the cryptography.
    //
    // No PII beyond the tenant id; everything else is a browser-
    // generated opaque identifier. The endpoint URL is sensitive only
    // in the sense that anyone with both keys could push to that
    // browser, so we treat it like a credential.
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh_key TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        last_used_at TIMESTAMPTZ
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subs_endpoint
        ON push_subscriptions (endpoint);
      CREATE INDEX IF NOT EXISTS idx_push_subs_tenant
        ON push_subscriptions (tenant_id, created_at DESC);
    `);
  },
  8: async (client) => {
    // Messaging relay-gateway (demo host-extension; NON-normative). Mirrors
    // ../sqlite/schema.ts migration 10. TEXT timestamps (ISO strings) for
    // string-identity with the sqlite backend + the ChatEgressEnvelope shape.
    // Device tokens persisted as SHA-256 hash only.
    await client.query(`
      CREATE TABLE IF NOT EXISTS relay_devices (
        relay_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        device_name TEXT,
        status TEXT NOT NULL,
        device_token_hash TEXT,
        token_expires_at TEXT,
        activation_code TEXT,
        activation_expires_at TEXT,
        registered_at TEXT NOT NULL,
        last_heartbeat_at TEXT,
        last_reported_status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_relay_devices_token
        ON relay_devices (device_token_hash);
      CREATE TABLE IF NOT EXISTS relay_outbound (
        egress_id TEXT PRIMARY KEY,
        relay_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to_message_id TEXT,
        enqueued_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_outbound_relay
        ON relay_outbound (relay_id, enqueued_at ASC);
      CREATE TABLE IF NOT EXISTS messaging_connectors (
        connector_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_connectors_tenant
        ON messaging_connectors (tenant_id);
      CREATE TABLE IF NOT EXISTS messaging_sessions (
        session_key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        peer_display TEXT,
        last_inbound_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_run_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_sessions_tenant
        ON messaging_sessions (tenant_id, last_inbound_at DESC);
    `);
  },
  9: async (client) => {
    // Messaging policies / routing / identities / delivery log (demo
    // host-extension; NON-normative). Mirrors ../sqlite/schema.ts migration 11.
    await client.query(`
      CREATE TABLE IF NOT EXISTS messaging_policies (
        connector_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        dm_policy TEXT NOT NULL,
        group_policy TEXT NOT NULL,
        require_mention BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messaging_routing_rules (
        rule_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        channel TEXT,
        pattern TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_routing_tenant
        ON messaging_routing_rules (tenant_id, priority DESC);
      CREATE TABLE IF NOT EXISTS messaging_identities (
        identity_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        display_name TEXT,
        peers TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_identities_tenant
        ON messaging_identities (tenant_id);
      CREATE TABLE IF NOT EXISTS messaging_delivery_log (
        log_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        relay_id TEXT,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_delivery_log_tenant
        ON messaging_delivery_log (tenant_id, at DESC);
    `);
  },
  10: async (client) => {
    // Envelope v2: rich outbound fields (media/components/reactions) as a JSON
    // blob so they survive the relay outbound queue. Mirrors sqlite mig 12.
    await client.query(`ALTER TABLE relay_outbound ADD COLUMN IF NOT EXISTS extra TEXT;`);
  },
  11: async (client) => {
    // Per-session turn history for chat-style continuity. Mirrors sqlite mig 13.
    await client.query(`
      CREATE TABLE IF NOT EXISTS messaging_turns (
        turn_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        run_id TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_turns_session
        ON messaging_turns (session_key, at);
    `);
  },
  12: async (client) => {
    // Per-connector access gates: pairing + allowlist. Mirrors sqlite mig 14.
    await client.query(`
      CREATE TABLE IF NOT EXISTS messaging_pairings (
        pairing_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_pairings_lookup
        ON messaging_pairings (connector_id, code);
      CREATE INDEX IF NOT EXISTS idx_messaging_pairings_peer
        ON messaging_pairings (connector_id, channel, peer_id);
      CREATE TABLE IF NOT EXISTS messaging_allowlist (
        entry_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        added_at TEXT NOT NULL,
        UNIQUE (connector_id, channel, peer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messaging_allowlist_connector
        ON messaging_allowlist (connector_id);
    `);
  },
  13: async (client) => {
    // Routing rules may bind to an agent instead of a workflow. Mirrors sqlite mig 15.
    await client.query(`ALTER TABLE messaging_routing_rules ADD COLUMN IF NOT EXISTS agent_id TEXT;`);
  },
  14: async (client) => {
    // User-authored agents — mirrors sqlite mig 16. Backs
    // `POST /v1/host/openwop-app/agents` (Agents-tab authoring form,
    // 2026-05-28). Shape parity with sqlite: `tool_allowlist` is
    // JSONB (postgres prefers it over text); booleans are
    // bool-typed; `confidence_threshold` is double-precision.
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_agents (
        agent_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        persona TEXT NOT NULL,
        label TEXT,
        description TEXT,
        model_class TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        tool_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
        memory_scratchpad BOOLEAN NOT NULL DEFAULT FALSE,
        memory_conversation BOOLEAN NOT NULL DEFAULT FALSE,
        memory_long_term BOOLEAN NOT NULL DEFAULT FALSE,
        confidence_threshold DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_agents_tenant
        ON user_agents (tenant_id, created_at DESC);
    `);
  },
  15: async (client) => {
    // Generic key→JSON store backing the reference app-extension stores (Kanban
    // boards, agent roster, org-chart) so they survive a restart. Coarse by
    // design — each service serializes its whole collection to one key.
    await client.query(`
      CREATE TABLE IF NOT EXISTS host_ext_kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
  16: async (client) => {
    // Durable webhook-delivery retry queue (backs `webhookWorker.ts`). One
    // row per delivery attempt-stream; the worker claims DUE rows with a
    // lease (FOR UPDATE SKIP LOCKED so it is multi-instance-safe), POSTs,
    // then marks delivered or reschedules with a backoff. Epoch-ms columns
    // are BIGINT (pg returns them as strings — the adapter coerces via
    // Number(...)). Mirrors sqlite mig 17.
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        next_attempt_at BIGINT NOT NULL,
        claimed_by TEXT,
        claim_expires_at BIGINT,
        last_error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
        ON webhook_deliveries (status, next_attempt_at);
    `);
  },
  17: async (client) => {
    // Run-dispatch lease (multi-instance crash recovery). A worker stamps
    // `dispatch_owner` + `dispatch_lease_expires_at` (epoch ms, BIGINT — pg
    // returns it as a string, the adapter coerces via Number(...)) when it
    // begins executing a run; `claimOrphanedRuns` re-claims runs whose lease
    // is absent or expired via FOR UPDATE SKIP LOCKED so it is multi-instance-
    // safe. The partial index covers the orphan scan (status + lease expiry).
    // Mirrors sqlite mig 18.
    await client.query(`
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_owner TEXT;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_lease_expires_at BIGINT;
      CREATE INDEX IF NOT EXISTS idx_runs_dispatch_lease
        ON runs (status, dispatch_lease_expires_at);
    `);
  },
  18: async (client) => {
    // Append-only agent-attributed-run index (RFC 0086). Mirrors sqlite mig 21:
    // written once at run creation; live status joined from runs at query time.
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_run_activity (
        run_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        roster_id TEXT NOT NULL,
        agent_id TEXT,
        source TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_run_activity_tenant_roster
        ON agent_run_activity (tenant_id, roster_id, created_at);

      -- Backfill from existing runs (metadata is JSONB) so the activity feed
      -- isn't empty after this migration. First present attribution block wins,
      -- matching recordRunAttribution's priority.
      INSERT INTO agent_run_activity (run_id, tenant_id, roster_id, agent_id, source, created_at)
      SELECT run_id, tenant_id,
        COALESCE(metadata->'heartbeat'->>'rosterId', metadata->'schedule'->>'rosterId',
                 metadata->'kanban'->>'rosterId',    metadata->'approval'->>'rosterId'),
        COALESCE(metadata->'heartbeat'->>'agentId',  metadata->'schedule'->>'agentId',
                 metadata->'kanban'->>'agentId',     metadata->'approval'->>'agentId'),
        CASE
          WHEN metadata->'heartbeat'->>'rosterId' IS NOT NULL THEN 'heartbeat'
          WHEN metadata->'schedule'->>'rosterId'  IS NOT NULL THEN 'schedule'
          WHEN metadata->'kanban'->>'rosterId'    IS NOT NULL THEN 'kanban'
          ELSE 'approval'
        END,
        created_at
      FROM runs
      WHERE COALESCE(metadata->'heartbeat'->>'rosterId', metadata->'schedule'->>'rosterId',
                     metadata->'kanban'->>'rosterId',    metadata->'approval'->>'rosterId') IS NOT NULL
      ON CONFLICT (run_id) DO NOTHING;
    `);
  },
  19: async (client) => {
    // Windowed run-budget counter for the autonomous daemons. Mirrors sqlite
    // mig 22: atomic upsert-increment per (tenant, window) bucket.
    await client.query(`
      CREATE TABLE IF NOT EXISTS run_budget (
        bucket TEXT PRIMARY KEY,
        window_start BIGINT NOT NULL,
        count BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_budget_window ON run_budget (window_start);
    `);
  },
  20: async (client) => {
    // FORWARD-FIX for the RFC 0056 annotations table. It was originally declared
    // in migration v1, but a long-lived DB initialized before that declaration
    // was added to the v1 block never re-runs v1 (migrations are forward-only),
    // so production hit `relation "annotations" does not exist` on the first
    // annotation write (e.g. the workforce demo seed). This idempotent migration
    // creates it on existing DBs; fresh DBs already have it from v1 (no-op).
    // Mirrors sqlite mig 23.
    await client.query(`
      CREATE TABLE IF NOT EXISTS annotations (
        annotation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_run
        ON annotations (run_id, created_at);
    `);
  },
  21: async (client) => {
    // RFC 0093 §A.3 — webhook subscriptions are tenant-scoped end-to-end.
    // `tenant_id` is the tenant established at registration (the membership
    // gate in routes/webhooks.ts); list/delete and the delivery fanout all
    // filter on it. Pre-existing rows migrate to the 'default' tenant — the
    // tenant every pre-RFC registration actually ran under (tenantOf()
    // fallback). Mirrors sqlite mig 24.
    await client.query(`
      ALTER TABLE webhooks ADD COLUMN tenant_id TEXT;
      UPDATE webhooks SET tenant_id = 'default' WHERE tenant_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks (tenant_id);
    `);
  },
  22: async (client) => {
    // RFC 0093 §B.1 — interrupt signed-token expiry. Minted at creation by
    // the suspend manager (default 30 min via OPENWOP_INTERRUPT_TOKEN_TTL_SEC,
    // capped at the interrupt's own timeoutMs deadline when one exists); the
    // signed-token endpoints refuse an expired token with 410
    // interrupt_expired. Pre-existing rows keep NULL (non-expiring) — see
    // sqlite mig 25 for the rationale.
    await client.query(`
      ALTER TABLE interrupts ADD COLUMN expires_at TIMESTAMPTZ;
    `);
  },
  23: async (client) => {
    // ADR 0050 — per-recipient notification targeting. NULL = broadcast
    // (tenant-wide, the pre-0050 behavior every existing row keeps); non-NULL
    // = addressed to that one user. Inbox returns recipient_user_id = me OR
    // IS NULL. Mirrors sqlite mig 26.
    await client.query(`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recipient_user_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_notifications_tenant_recipient
        ON notifications (tenant_id, recipient_user_id, created_at DESC);
    `);
    // ADR 0050 Phase 3 — role-addressed broadcast (visible only to role-holders).
    await client.query(`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recipient_role TEXT;
    `);
  },
  24: async (client) => {
    // ADR 0050 — push subscriptions record their owning user so addressed
    // notifications push only to that user's devices. Legacy rows keep NULL
    // (broadcast-only). Mirrors sqlite mig 27.
    await client.query(`
      ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_push_subs_tenant_user
        ON push_subscriptions (tenant_id, user_id);
    `);
  },
  25: async (client) => {
    // ADR 0052 §D4/§D5 — app-tier metadata, sibling to __schema_version (app
    // version for fresh-vs-upgrade detection + the app-migration counter).
    // Mirrors sqlite mig 28.
    await client.query(`
      CREATE TABLE IF NOT EXISTS __app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `);
  },
  26: async (client) => {
    // ADR 0102 Phase 2 — per-message author for the edit-authz gate. Nullable +
    // additive; existing rows get a null author (⇒ owner-writable). Mirrors
    // sqlite mig 29.
    await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS author_subject TEXT;`);
  },
  27: async (client) => {
    // ADR 0106 — per-org daily media-generation usage (TTS chars + STT bytes) for
    // the media cost-governance budget. Mirrors managed_provider_usage + sqlite
    // mig 30. `date` is the UTC calendar day in YYYY-MM-DD form (TEXT to match the
    // sqlite shape, so the Storage interface stays backend-agnostic).
    await client.query(`
      CREATE TABLE IF NOT EXISTS media_provider_usage (
        tenant_id TEXT NOT NULL,
        date TEXT NOT NULL,
        tts_chars BIGINT NOT NULL DEFAULT 0,
        stt_bytes BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, date)
      );
    `);
  },
  28: async (client) => {
    // ADR 0050 Phase 3 (drift repair) — re-apply the role-addressed notification
    // column. It was originally appended as a SECOND statement INSIDE mig 23, so a
    // DB that recorded v23 before that line was added never got the column and the
    // forward-only migrator (runs version > recorded) never re-runs 23 → the
    // notifications list 500s with `column "recipient_role" does not exist`. This is
    // a NEW version so every drifted DB applies it; IF NOT EXISTS makes it a no-op
    // on DBs (incl. fresh ones) that already have it. Mirrors sqlite mig 31.
    await client.query(`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS recipient_role TEXT;
    `);
  },
  29: async (client) => {
    // ADR 0151 — title provenance for conversation auto-titling. Nullable +
    // additive; existing rows keep NULL (⇒ treated as 'default', still auto-
    // titleable). 'auto' = LLM-titled (don't re-run), 'user' = manual rename
    // (never overwrite). Mirrors sqlite mig 32.
    await client.query(`
      ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS title_source TEXT;
    `);
  },
  30: async (client) => {
    // ADR 0178 — per-org daily BYOK LLM chat token usage (input + output tokens),
    // keyed by provider, for the BYOK chat spend-governance budget. Mirrors
    // managed_provider_usage / media_provider_usage + sqlite mig 33. `date_utc` is
    // the UTC calendar day in YYYY-MM-DD form (TEXT to match the sqlite shape, so
    // the Storage interface stays backend-agnostic).
    await client.query(`
      CREATE TABLE IF NOT EXISTS byok_chat_usage (
        tenant_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        date_utc TEXT NOT NULL,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, provider_id, date_utc)
      );
    `);
  },
  31: async (client) => {
    // PERF (incident 2026-07-13): host_ext_kv is read almost entirely via
    // `k LIKE 'hostext:<name>:%'` prefix scans (DurableCollection.list /
    // listByPrefix / listForTenantIndexed). The PRIMARY-KEY btree on `k` CANNOT
    // serve `LIKE 'prefix%'` under the db's en_US.UTF8 collation, so every such
    // read was a FULL SEQ SCAN of the table — at ~87k rows that measured ~1–3.7s
    // EACH, and a screen firing several of them loaded in 10–15s. A
    // `text_pattern_ops` index makes prefix LIKE an index range scan (~5ms).
    // (Prod was hotfixed via CREATE INDEX CONCURRENTLY; this migration is the
    // durable/replayable form — IF NOT EXISTS ⇒ no-op there. Non-concurrent here
    // because migrations may run in a txn; only a pre-existing LARGE db without
    // the index would block on boot, and the sole such db already has it.)
    // Postgres-only: SQLite (dev/test) DBs are tiny and never hit this.
    try {
      await client.query(`
        CREATE INDEX IF NOT EXISTS host_ext_kv_k_pattern ON host_ext_kv (k text_pattern_ops);
      `);
    } catch (err) {
      // pg-mem (the vitest harness) cannot parse index OPERATOR CLASSES — it
      // broke every pg-mem suite at boot the day this migration landed. A
      // plain same-named index is a functional no-op there (tests never
      // measure LIKE plans); REAL Postgres always succeeds on the first
      // statement and never reaches this branch. Anything other than the
      // opclass parse failure still throws — never swallow a prod error.
      if (!(err instanceof Error) || !err.message.includes('text_pattern_ops')) throw err;
      // Grade-pass: NEVER degrade silently — if this ever fires on real
      // Postgres (a stripped build missing the opclass), the LIKE-plan fix
      // is absent and the operator must know.
      console.warn('[storage] host_ext_kv_k_pattern: opclass index failed; created a PLAIN (k) index instead:', err.message);
      await client.query(`
        CREATE INDEX IF NOT EXISTS host_ext_kv_k_pattern ON host_ext_kv (k);
      `);
    }
  },
  32: async (client) => {
    // ADR 0369 — the runs-reference probe (`hasRunForWorkflow`) serves the
    // workflow DELETE guard + the promote gate. Runs are looked up by
    // workflow_id, which only had per-tenant/status indexes; without this,
    // the probe would seq-scan runs. Mirrors sqlite mig 34.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs (workflow_id);
    `);
  },
  33: async (client) => {
    // ADR 0371 — run retention. removal_at is precomputed at terminal
    // transition (storage-layer stamp); the sweeper range-scans the index.
    // Backfill: pre-policy terminal runs get a GRACE floor of now + 7 days
    // (repair-before-constrain — the first sweep must never be a mass
    // extinction of history nobody chose to expire). Mirrors sqlite mig 35.
    await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS removal_at TIMESTAMPTZ;`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_runs_removal ON runs (removal_at) WHERE removal_at IS NOT NULL;`);
    await client.query(`
      UPDATE runs SET removal_at = NOW() + INTERVAL '7 days'
      WHERE removal_at IS NULL AND status IN ('completed', 'failed', 'cancelled');
    `);
  },
  34: async (client) => {
    // ADR 0379 P2 (PR-A) — user_agents PK becomes COMPOSITE (tenant_id,
    // agent_id): the prerequisite for persona-scoped ids (`user.<slug>`), and
    // the structural fold-collision mechanism (two tenants' same-persona rows
    // share a per-tenant key, so the adopt fold's tenant move collides instead
    // of duplicating). Mirrors sqlite mig 36 (which rebuilds the table —
    // sqlite can't ALTER a PK).
    await client.query(`
      ALTER TABLE user_agents DROP CONSTRAINT user_agents_pkey;
      ALTER TABLE user_agents ADD PRIMARY KEY (tenant_id, agent_id);
    `);
  },
  35: async (client) => {
    // ADR 0549 P0 — the HTTP idempotency ledger, keyed (tenant_id,
    // endpoint_id, idempotency_key). Mirrors sqlite mig 37.
    //
    // A NEW table, not an ALTER of `idempotency`: the old table keeps serving
    // the daemons' fire-once mutex and is deliberately NOT dropped (ADR 0549
    // CORRECTION 4). Separating the lanes is what makes a caller-supplied key
    // structurally unable to collide with a host-generated one.
    //
    // No backfill — a raw legacy key cannot be attributed to a tenant after
    // the fact, and guessing an owner is the defect being fixed.
    //
    // Every primary-key column is NOT NULL. That is not decoration: Postgres
    // implies NOT NULL on a PK, but SQLITE DOES NOT — it permits NULLs in a
    // PK and treats multiple NULL rows as non-conflicting, which would make
    // the atomic claim silently non-atomic on one adapter and hard-fail on the
    // other. Writing it explicitly keeps the two schemas honestly identical.
    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotent_response (
        tenant_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'completed', 'released')),
        claim_token TEXT,
        claim_expires_at TIMESTAMPTZ,
        response_status INTEGER,
        response_body TEXT,
        run_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, endpoint_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_idempotent_response_age
        ON idempotent_response (created_at);
    `);
  },
  36: async (client) => {
    // ADR 0551 P0 — durable RFC 0059 agent workspace. Mirrors sqlite mig 38.
    // See that migration for why every key column is explicitly NOT NULL.
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_files (
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL,
        version INTEGER NOT NULL,
        etag TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, workspace_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_files_owner
        ON workspace_files (tenant_id, workspace_id, path);
    `);
  },
  37: async (client) => {
    // ADR 0549 P3 — RFC 0150 §B logical effect identity. Mirrors sqlite mig 39;
    // see that migration for why this is a RENAME and why `attempt` stays.
    //
    // `IF EXISTS` because a database whose `invocation_log` was created after
    // this migration landed already carries the new name; Postgres has no
    // `RENAME COLUMN IF EXISTS`, so the guard is the information_schema probe.
    const { rows } = await client.query<{ present: number }>(
      `SELECT 1 AS present FROM information_schema.columns
       WHERE table_name = 'invocation_log' AND column_name = 'provider_key'`,
    );
    if (rows.length > 0) {
      await client.query(`ALTER TABLE invocation_log RENAME COLUMN provider_key TO invocation_id`);
    }
  },
  38: async (client) => {
    // ADR 0551 P1 — the durable dispatch outbox. Mirrors sqlite mig 40; see
    // that migration for why `run_id` is the primary key, why there is no
    // backfill, and why a discharged intent is deleted rather than marked.
    //
    // Epoch-ms columns are BIGINT, matching `webhook_deliveries` (mig 16) — the
    // other leased queue in this schema — so the two claim paths compare
    // timestamps the same way on both adapters.
    await client.query(`
      CREATE TABLE IF NOT EXISTS dispatch_outbox (
        run_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at BIGINT NOT NULL,
        claimed_by TEXT,
        claim_expires_at BIGINT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_outbox_due
        ON dispatch_outbox (status, next_attempt_at);
    `);
  },
  39: async (client) => {
    // PR #3409 review fold-in — the `listAudit` exact-match `resource`
    // pushdown. Mirrors sqlite mig 41; see that migration for the two
    // window-scan consumers this replaces. Partial index: most audit rows
    // carry no resource, and NULL never matches the exact-match pushdown.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_resource_ts
        ON audit_log (resource, timestamp DESC)
        WHERE resource IS NOT NULL;
    `);
  },
  40: async (client) => {
    // ADR 0591 P1 — the durable effect ESCAPE ledger. Mirrors sqlite mig 42;
    // see that migration for why this is a SECOND table rather than a count
    // over `invocation_log` (whose REPLACE-over-constant-`attempt` collapses
    // two escapes into one row — measured, not assumed).
    //
    // The row id is GENERATED, not caller-supplied — see mig 42 for the
    // measurement that forced this: a caller-supplied sequence is process-local,
    // restarts at 0 in the process that resumes after the kill, and so collides
    // with the pre-kill row for the same identity. Under this schema an append
    // cannot address an existing row at all, on either backend.
    await client.query(`
      CREATE TABLE IF NOT EXISTS effect_escape_ledger (
        escape_id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        effect_kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_effect_escape_run
        ON effect_escape_ledger (run_id, invocation_id);
    `);
  },
  41: async (client) => {
    // v2 charter Phase 4 (P4-C) — THE ERA KEY. Mirrors sqlite mig 44; see that
    // migration for why the column is nullable and why there is no backfill
    // (`spec/v2/core/persistence.md` §"The era key": absent stays era `2`
    // forever, a host MUST NOT rewrite historical rows to add an explicit `2`,
    // and the snapshot field is synthesized at read time instead).
    //
    // `ADD COLUMN` with no DEFAULT takes no table rewrite on any supported
    // Postgres, so this is safe on a large `runs` table.
    await client.query(`
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS event_log_schema_version INTEGER;
    `);
  },
  42: async (client) => {
    // v2 charter Phase 4 (P4-D) — THE SUBSCRIBER'S CONTRACT MAJOR. Mirrors
    // sqlite mig 45; see that migration for why a delivery cannot negotiate a
    // contract (it is an emission, not a response) and why NULL MUST read as
    // major 1 rather than being backfilled to 2.
    await client.query(`
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS protocol_major INTEGER;
    `);
  },
  43: async (client) => {
    // RFC 0187 §A.1 — the delivery header carries the same tenant-bound
    // subscription id minted by POST /webhooks. Persist the exact wire value
    // on the durable row so crash recovery/retry cannot revert to the raw
    // storage id. NULL preserves every historical and major-1 row.
    await client.query(`
      ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS wire_subscription_id TEXT;
    `);
  },
  44: async (client) => {
    // FORWARD-FIX for ADR 0618's invocation_claim (the Layer-2 atomic claim —
    // idempotency.md, "Concurrent duplicates (Layer 2)"). It was added to the
    // v1 block on 2026-09-01, which no existing DB re-runs, so production never
    // had it: MEASURED 2026-09-21, every run-retention tick since at least
    // 2026-09-14 failed on `relation "invocation_claim" does not exist` (99
    // logged in a week — runs were never purged), and the notification emitter
    // ran with duplicate suppression OFF. Idempotent. Mirrors sqlite, which
    // created it in its own forward migration from the start.
    await client.query(`
      CREATE TABLE IF NOT EXISTS invocation_claim (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        claimed_at BIGINT NOT NULL,
        PRIMARY KEY (run_id, node_id, invocation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_invocation_claim_run ON invocation_claim(run_id);
    `);
  },
  45: async (client) => {
    // RFC 0201 / ADR 0747 — the Standard Webhooks companion scheme. Mirrors
    // sqlite mig 47; see it for why every column is NULLABLE WITH NO BACKFILL
    // (NULL `signature_algorithms` = `["v1"]`, today's behaviour byte for byte)
    // and why `previous_secret` carries the sealed at-rest form. `ADD COLUMN`
    // with no DEFAULT takes no table rewrite.
    await client.query(`
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS signature_algorithms JSONB;
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret TEXT;
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret_expires_at BIGINT;
      ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS rotated_at BIGINT;
    `);
  },
  46: async (client) => {
    // RFC 0215 §A.3 / ADR 0752 P2 — the owning tenant on each delivery row, so
    // one tenant's unanswered attempts cannot take capacity another tenant
    // needs. Mirrors sqlite mig 48. NULLABLE WITH NO BACKFILL: only rows queued
    // before this deploy are NULL, they drain within minutes, and a NULL row is
    // simply not tenant-capped (never excluded) — the pre-P2 behaviour.
    await client.query(`
      ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    `);
  },
};

/** Highest defined migration — DERIVED from MIGRATIONS, never a hand-bumped cap.
 *  A separate literal silently skipped a newly-added migration (the `recipient_role`
 *  drift, #935): the runner loops `current+1 … LATEST`, so a stale cap means the
 *  migration never executes. Deriving makes "add a migration, forget the cap"
 *  structurally impossible. */
export const LATEST_SCHEMA_VERSION = Math.max(...Object.keys(MIGRATIONS).map(Number));

export async function applyMigrations(client: Queryable): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS __schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL
    );
  `);
  const cur = await client.query<{ version: number }>(
    `SELECT version FROM __schema_version WHERE id = 1`,
  );
  const current = cur.rows[0]?.version ?? 0;

  for (let v = current + 1; v <= LATEST_SCHEMA_VERSION; v++) {
    const migration = MIGRATIONS[v];
    if (!migration) throw new Error(`Missing Postgres migration for schema version ${v}`);
    await migration(client);
  }

  if (current === 0) {
    await client.query(
      `INSERT INTO __schema_version (id, version, applied_at) VALUES (1, $1, NOW())`,
      [LATEST_SCHEMA_VERSION],
    );
  } else if (current < LATEST_SCHEMA_VERSION) {
    await client.query(
      `UPDATE __schema_version SET version = $1, applied_at = NOW() WHERE id = 1`,
      [LATEST_SCHEMA_VERSION],
    );
  }
}
