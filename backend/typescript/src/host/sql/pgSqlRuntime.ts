/** Privileged SQL provisioning stays outside the pack-facing surface (ADR 0867). */
import { createHmac } from 'node:crypto';
import { Client, Pool, escapeIdentifier, escapeLiteral, type PoolClient } from 'pg';
import { parseIntoClientConfig } from 'pg-connection-string';
import { roleForTenant, schemaForTenant, type PgClient } from './pgSql.js';

/** PUBLIC grants are inherited even by NOINHERIT roles. Never ignore them. */
const UNSAFE_PRIVILEGES = `SELECT has_database_privilege(current_user, current_database(), 'CREATE') OR EXISTS (
  SELECT 1 FROM pg_roles r WHERE r.rolname = current_user
    AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid))
) OR EXISTS (
  SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_'
    AND n.nspname <> 'information_schema' AND n.nspname <> $1 AND (
      has_schema_privilege(current_user, n.oid, 'CREATE') OR
      (has_schema_privilege(current_user, n.oid, 'USAGE') AND (
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid
          AND c.relkind IN ('r','p','v','m','f')
          AND has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR
        EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid AND c.relkind = 'S'
          AND has_sequence_privilege(current_user, c.oid, 'USAGE,SELECT,UPDATE')) OR
        EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = n.oid AND p.prosecdef
          AND has_function_privilege(current_user, p.oid, 'EXECUTE'))
      ))
    )
) OR EXISTS (
  SELECT 1 FROM pg_largeobject_metadata m, LATERAL aclexplode(m.lomacl) a
    WHERE m.lomowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND a.privilege_type IN ('SELECT', 'UPDATE')
      AND (a.grantee = 0 OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user))
) AS unsafe, pg_backend_pid() AS pid,
  (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS backend_start`;

function provisioningVersion(row: Record<string, unknown> | undefined): number {
  const version = Number(row?.version);
  if (!Number.isInteger(version) || version < 150000) {
    throw new Error('Postgres SQL tenant provisioning requires PostgreSQL 15 or later.');
  }
  // PG15 has no per-membership INHERIT option. A non-superuser provisioner
  // must inherit its one-way tenant membership to erase tenant-owned objects.
  if (version < 160000 && row?.is_super !== true && row?.can_inherit !== true) {
    throw new Error('Postgres SQL on PostgreSQL 15 requires an INHERIT provisioning user for tenant object erasure.');
  }
  return version;
}

export async function createPgSqlRuntime(config: { dsn: string; rolePasswordKey: string; max: number }) {
  if (!Number.isInteger(config.max) || config.max < 2 || config.rolePasswordKey.length < 32) {
    throw new Error('Postgres SQL requires a stable role password key and a total connection budget >= 2.');
  }
  // Driver parser also accepts Cloud SQL's empty-host Unix socket DSNs.
  let connection;
  try { connection = parseIntoClientConfig(config.dsn); }
  catch { throw new Error('Invalid Postgres SQL connection configuration.'); }
  const admin = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000, statement_timeout: 30_000, query_timeout: 35_000 });
  const ensured = new Map<string, Promise<void>>();
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  let active = 0;
  let admissionFailure: Error | undefined;
  const failAdmission = () => {
    admissionFailure ??= new Error('Postgres SQL could not confirm session termination; runtime disabled until restart.');
    for (const waiter of pending.splice(0)) waiter.reject(admissionFailure);
    return admissionFailure;
  };
  // Idle provisioning connection failures must also fail closed, rather than
  // becoming unhandled Pool error events that expose driver connection details.
  admin.on('error', failAdmission);
  const acquire = async () => {
    if (admissionFailure) throw admissionFailure;
    if (active >= config.max - 1) {
      if (pending.length >= 256) throw new Error('Postgres SQL connection queue is full.');
      await new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
      if (admissionFailure) throw admissionFailure;
    }
    else active++;
  };
  const release = () => { const next = pending.shift(); if (next) next.resolve(); else active--; };
  const signature = (tenant: string, purpose: string) => createHmac('sha256', config.rolePasswordKey)
    .update(`openwop.sql.${purpose}\0${tenant}`).digest('hex');
  const withAdminLock = async <T>(tenant: string, run: (client: PoolClient) => Promise<T>) => {
    const c = await admin.connect();
    const lock = signature(tenant, 'lock').slice(0, 16);
    const lockId = BigInt.asIntN(64, BigInt(`0x${lock}`)).toString();
    try {
      await c.query('SELECT pg_advisory_lock($1::bigint)', [lockId]);
      return await run(c);
    } finally {
      // Destroy the session if unlocking fails; never return a locked admin client.
      try { await c.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]); c.release(); }
      catch { c.release(true); }
    }
  };
  const ensure = async (tenant: string) => {
    const role = roleForTenant(tenant), schema = schemaForTenant(tenant);
    await withAdminLock(tenant, async (c) => {
      const policy = await c.query(`SELECT current_setting('server_version_num')::int AS version,
        rolinherit AS can_inherit, rolsuper AS is_super FROM pg_roles WHERE rolname = current_user`);
      const version = provisioningVersion(policy.rows[0]);
      await c.query('BEGIN');
      try {
        const { rows } = await c.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
          rolreplication, rolbypassrls, shobj_description(oid, 'pg_authid') AS marker,
          EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS member
          FROM pg_roles r WHERE rolname = $1`, [role]);
        const prior = rows[0];
        const marker = `openwop-sql:${signature(tenant, 'owner')}`;
        if (prior && (!prior.rolcanlogin || prior.rolsuper || prior.rolcreatedb || prior.rolcreaterole ||
          prior.rolreplication || prior.rolbypassrls || prior.member || prior.marker !== marker)) {
          throw new Error('Postgres SQL tenant role is disabled or has unexpected ownership/privileges.');
        }
        if (!prior) {
          await c.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
            NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(signature(tenant, 'password'))}`);
          await c.query(`COMMENT ON ROLE ${escapeIdentifier(role)} IS ${escapeLiteral(marker)}`);
          // One-way membership lets a non-superuser provisioner terminate its
          // tenant sessions during erasure. Tenants never join the host role.
          await c.query(`GRANT ${escapeIdentifier(role)} TO CURRENT_USER${version >= 160000 ? ' WITH INHERIT TRUE, SET TRUE' : ''}`);
        }
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(schema)}`);
        // Schema stays owned by the provisioner: tenants cannot grant its USAGE
        // to PUBLIC and cause other tenants' privilege checks to fail.
        await c.query(`REVOKE ALL ON SCHEMA ${escapeIdentifier(schema)} FROM PUBLIC`);
        await c.query(`GRANT USAGE, CREATE ON SCHEMA ${escapeIdentifier(schema)} TO ${escapeIdentifier(role)}`);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    });
  };
  const connectTenant = async (tenant: string): Promise<PgClient> => {
    schemaForTenant(tenant); // Reject an empty identity before touching PostgreSQL.
    if (admissionFailure) throw admissionFailure;
    let ready = ensured.get(tenant);
    if (!ready) {
      ready = ensure(tenant); ensured.set(tenant, ready);
      if (ensured.size > 256) ensured.delete(ensured.keys().next().value ?? tenant);
      ready.catch(() => { if (ensured.get(tenant) === ready) ensured.delete(tenant); });
    }
    await ready;
    await acquire();
    const client = new Client({ ...connection, user: roleForTenant(tenant), password: signature(tenant, 'password'),
      connectionTimeoutMillis: 10_000, query_timeout: 30_000, statement_timeout: 30_000 });
    // Termination during teardown is an expected asynchronous session failure.
    // Requests still reject; avoid an unhandled EventEmitter error in the host.
    client.on('error', () => {});
    let connected = false;
    let session: { pid: number; startedAt: string } | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      let drained = !connected;
      try {
        if (connected) {
          if (!session) throw failAdmission();
          // A driver read timeout does not cancel server work, and tenants can
          // SET statement_timeout=0. Keep the slot until PostgreSQL confirms
          // this exact session has ended, before closing its client socket.
          // Start time preserves microseconds and prevents stale PID adoption.
          const stopped = await admin.query(`SELECT CASE WHEN backend_start IS NULL THEN FALSE
            ELSE pg_terminate_backend(pid, 5000) END AS stopped FROM pg_stat_activity
            WHERE pid = $1 AND usename = $3 AND datname = current_database()
              AND (backend_start = $2::timestamptz OR backend_start IS NULL)`,
          [session.pid, session.startedAt, roleForTenant(tenant)]);
          if (stopped.rows.some((row) => row.stopped !== true)) {
            // An independently erased session may vanish between observation
            // and signaling. Missing stats visibility is never proof of drain.
            const remaining = await admin.query(`SELECT 1 FROM pg_stat_activity
              WHERE pid = $1 AND usename = $3 AND datname = current_database()
                AND (backend_start = $2::timestamptz OR backend_start IS NULL)`,
            [session.pid, session.startedAt, roleForTenant(tenant)]);
            if (remaining.rows.length) throw failAdmission();
          }
          drained = true;
        }
      } catch {
        // An unconfirmed backend still consumes its slot. Reject queued and
        // fresh operations instead of allowing an outage to exceed the budget.
        throw failAdmission();
      } finally {
        try { await client.end(); } finally { if (drained) release(); }
      }
    })();
    try {
      await client.connect();
      connected = true;
      const { rows } = await client.query(UNSAFE_PRIVILEGES, [schemaForTenant(tenant)]);
      const row = rows[0];
      if (!Number.isInteger(row?.pid) || row.pid <= 0 || typeof row.backend_start !== 'string' || !row.backend_start) {
        throw new Error('Postgres SQL could not identify its authenticated server session.');
      }
      session = { pid: row.pid, startedAt: row.backend_start };
      if (rows[0]?.unsafe !== false) throw new Error('Postgres SQL tenant has unsafe foreign-schema privileges. Revoke broad PUBLIC grants before activation.');
      return { query: (sql, params) => client.query(sql, params), release: close };
    } catch (e) { await close(); throw e; }
  };
  const purgeTenant = async (tenant: string): Promise<number> => {
    const role = roleForTenant(tenant), schema = schemaForTenant(tenant);
    return withAdminLock(tenant, async (c) => {
      const { rows } = await c.query("SELECT oid, shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1", [role]);
      const marker = `openwop-sql:${signature(tenant, 'owner')}`;
      if (rows.length && rows[0].marker !== marker) throw new Error('Postgres SQL erasure refused unexpected tenant role ownership.');
      if (rows.length) {
        // Autocommit first: no new authenticated session may race the sweep.
        await c.query(`ALTER ROLE ${escapeIdentifier(role)} NOLOGIN`);
        const terminated = await c.query('SELECT pg_terminate_backend(pid, 5000) AS stopped FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()', [role]);
        if (terminated.rows.some((r) => r.stopped !== true)) throw new Error('Postgres SQL tenant sessions did not drain during erasure.');
      } else {
        await c.query(`CREATE ROLE ${escapeIdentifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
        await c.query(`COMMENT ON ROLE ${escapeIdentifier(role)} IS ${escapeLiteral(marker)}`);
      }
      const { rows: objects } = await c.query('SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = $1', [schema]);
      const largeObjects = await c.query('SELECT lo_unlink(m.oid) FROM pg_largeobject_metadata m JOIN pg_roles r ON r.oid = m.lomowner WHERE r.rolname = $1', [role]);
      await c.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schema)} CASCADE`);
      ensured.delete(tenant);
      return Number(objects[0]?.n ?? 0) + largeObjects.rows.length;
    });
  };
  const verify = async () => {
    const { rows } = await admin.query(`SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
      (SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = current_user) AS can_create_role,
      (SELECT rolinherit FROM pg_roles WHERE rolname = current_user) AS can_inherit,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super,
      current_setting('server_version_num')::int AS version,
      current_setting('max_prepared_transactions')::int AS prepared_transactions`);
    provisioningVersion(rows[0]);
    if (Number(rows[0]?.prepared_transactions) !== 0) throw new Error('Postgres SQL requires max_prepared_transactions=0 so erasure cannot leave detached prepared transactions.');
    if (rows[0]?.can_create !== true || rows[0]?.can_create_role !== true) {
      throw new Error('Postgres SQL provisioning user lacks CREATE on the database or CREATEROLE.');
    }
    const legacy = await admin.query(`SELECT 1 FROM pg_namespace n WHERE n.nspname LIKE 'tenant\\_%' ESCAPE '\\'
      AND (EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = n.oid)
        OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = n.oid)) LIMIT 1`);
    if (legacy.rows.length) throw new Error('Postgres SQL contains populated legacy tenant schemas; migrate explicitly under a maintenance hold before activation.');
    // Prove actual restricted login, privileges, and teardown at boot, not just
    // the administrator's SELECT 1. A unique probe cannot erase another revision.
    const { randomUUID } = await import('node:crypto');
    const probe = `__openwop_sql_boot__:${randomUUID()}`;
    try {
      const c = await connectTenant(probe);
      try { await c.query('SELECT 1'); } finally { await c.release(); }
    } finally {
      await purgeTenant(probe);
      // Boot-only identities have never represented a customer; no tombstone needed.
      await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleForTenant(probe))}`);
    }
  };
  return { connectTenant, purgeTenant, verify, end: () => admin.end() };
}
