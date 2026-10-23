/**
 * Live Postgres schema-per-tenant SQL test — exercises the `postgres` sql
 * adapter against a REAL Postgres (testcontainers), validating the part the
 * unit tests can't: real DDL/DML, transaction commit/rollback, and — the whole
 * point — cross-tenant isolation via actual restricted LOGIN roles, including qualified
 * foreign reads, role resets, PUBLIC grants, and account erasure.
 *
 * Gated on Docker. It does NOT run in the default gate (`npm run ci` sets
 * OPENWOP_SKIP_TESTCONTAINERS=1): the only runner is `npm run ci:full`
 * (OPENWOP_CI_LIVE=1, `scripts/ci.sh`), which sets OPENWOP_PG_SQL_LIVE=1 to
 * hard-require the run, so a green live lane means validated, never a silent
 * skip. (Hosted CI, which this header used to cite as "the dedicated CI job", is
 * disabled.) The isolation claims here — qualified foreign reads, SET ROLE,
 * PUBLIC grants, SECURITY DEFINER, large objects — have NO gate-lane twin:
 * `pg-sql.test.ts` pins only the issued statement sequence.
 *
 * Order: within one image's describe, the count assertions (`n === 3`) depend on
 * the earlier cases' inserts into `t1.items`, so this file is NOT shuffle-safe.
 * It is not restructured because this machine has no Docker to verify a rewrite
 * (/grade-tests 8f w1: an honest ceiling, recorded).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, escapeIdentifier } from 'pg';
import { createPgSqlRuntime } from '../src/host/sql/pgSqlRuntime.js';
import type { SqlSurface } from '../src/host/inMemorySurfaces.js';
import { createPgSql, schemaForTenant, roleForTenant } from '../src/host/sql/pgSql.js';

async function isDockerReachable(): Promise<boolean> {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    const { execSync } = await import('node:child_process');
    execSync('docker info > /dev/null 2>&1', { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const forceLive = process.env.OPENWOP_PG_SQL_LIVE === '1';
const dockerAvailable = forceLive || await isDockerReachable();
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[pg-sql-live] Docker not reachable — skipping. Set OPENWOP_PG_SQL_LIVE=1 to require it.');
}

describe.each(['postgres:15-alpine', 'postgres:16-alpine'])('pg sql restricted-login live matrix (%s)', (image) => {
let container: StartedPostgreSqlContainer | null = null;
let pgPool: Pool | null = null;
let runtime: Awaited<ReturnType<typeof createPgSqlRuntime>>;

beforeAll(async () => {
  if (!dockerAvailable) return;
  container = await new PostgreSqlContainer(image).start();
  pgPool = new Pool({ connectionString: container.getConnectionUri() });
  runtime = await createPgSqlRuntime({ dsn: container.getConnectionUri(), rolePasswordKey: 'disposable-live-test-key-minimum-32-characters', max: 3 });
  await runtime.verify();
}, 180_000);

afterAll(async () => {
  if (runtime) await runtime.end();
  if (pgPool) { try { await pgPool.end(); } catch { /* ignore */ } }
  if (container) { try { await container.stop(); } catch { /* ignore */ } }
}, 60_000);

const sqlFor = (tenantId: string): SqlSurface => createPgSql({ tenantId }, runtime);

describe('pg sql live integration (schema-per-tenant)', () => {
  it.skipIf(!dockerAvailable)('create/insert/query round-trips in the tenant schema', async () => {
    const sql = sqlFor('t1');
    await sql.execute({ sql: 'CREATE TABLE items (id serial PRIMARY KEY, name text)' });
    const ins = await sql.execute({ sql: 'INSERT INTO items (name) VALUES ($1)', params: ['widget'] }) as { changes: number };
    expect(ins.changes).toBe(1);
    const res = await sql.query({ sql: 'SELECT name FROM items WHERE name = $1', params: ['widget'] }) as { rows: Array<{ name: string }>; count: number };
    expect(res.rows[0].name).toBe('widget');
    expect(res.count).toBe(1);
  });

  it.skipIf(!dockerAvailable)('transaction commits all statements', async () => {
    const sql = sqlFor('t1');
    await sql.transaction({ statements: [
      { sql: 'INSERT INTO items (name) VALUES ($1)', params: ['a'] },
      { sql: 'INSERT INTO items (name) VALUES ($1)', params: ['b'] },
    ] });
    expect((await sql.query({ sql: 'SELECT count(*)::int AS n FROM items' }) as { rows: Array<{ n: number }> }).rows[0].n).toBe(3);
  });

  it.skipIf(!dockerAvailable)('transaction rolls back on error', async () => {
    const sql = sqlFor('t1');
    await expect(sql.transaction({ statements: [
      { sql: 'INSERT INTO items (name) VALUES ($1)', params: ['c'] },
      { sql: 'INSERT INTO nonexistent_table VALUES ($1)', params: ['x'] },
    ] })).rejects.toThrow();
    // the 'c' insert must have rolled back → still 3 rows
    expect((await sql.query({ sql: 'SELECT count(*)::int AS n FROM items' }) as { rows: Array<{ n: number }> }).rows[0].n).toBe(3);
  });

  it.skipIf(!dockerAvailable)('isolates tenants — t2 cannot see t1 tables (separate schema)', async () => {
    // Unqualified lookup is functional; later qualified and escalation
    // probes prove the authorization boundary.
    await expect(sqlFor('t2').query({ sql: 'SELECT * FROM items' })).rejects.toThrow(/does not exist|relation/i);
  });

  it.skipIf(!dockerAvailable)('rejects qualified foreign schema reads and writes, regardless of search_path', async () => {
    const foreign = escapeIdentifier(schemaForTenant('t1'));
    await expect(sqlFor('t2').query({ sql: `SELECT * FROM ${foreign}.items` })).rejects.toThrow(/permission denied/i);
    await expect(sqlFor('t2').execute({ sql: `INSERT INTO ${foreign}.items(name) VALUES ($1)`, params: ['stolen'] })).rejects.toThrow(/permission denied/i);
    await expect(sqlFor('t2').execute({ sql: `SET search_path TO ${foreign}` })).resolves.toBeDefined();
    await expect(sqlFor('t2').query({ sql: 'SELECT * FROM items' })).rejects.toThrow();
  });

  it.skipIf(!dockerAvailable)('keeps exact tenant identities separate across punctuation, case, and long suffixes', async () => {
    const identities = ['acme-a', 'acme_a', 'Acme_A', '!!!', '???', 'x'.repeat(60) + 'a', 'x'.repeat(60) + 'b'];
    for (const id of identities) {
      await sqlFor(id).execute({ sql: 'CREATE TABLE identity(value text)' });
      await sqlFor(id).execute({ sql: 'INSERT INTO identity VALUES ($1)', params: [id] });
    }
    for (const id of identities) {
      expect(await sqlFor(id).query({ sql: 'SELECT value FROM identity' })).toMatchObject({ rows: [{ value: id }] });
    }
  });

  it.skipIf(!dockerAvailable)('cannot reset session authorization or SET ROLE to the host or another tenant', async () => {
    const sql = sqlFor('t2');
    if (!container) throw new Error('fixture container missing');
    for (const role of [container.getUsername(), roleForTenant('t1')]) {
      await expect(sql.execute({ sql: `SET ROLE ${escapeIdentifier(role)}` })).rejects.toThrow(/permission denied/i);
      await expect(sql.execute({ sql: `SET SESSION AUTHORIZATION ${escapeIdentifier(role)}` })).rejects.toThrow(/permission denied/i);
    }
    const c = await runtime.connectTenant('t2');
    try {
      await c.query('RESET ROLE'); await c.query('RESET SESSION AUTHORIZATION');
      expect((await c.query('SELECT current_user AS u, session_user AS s')).rows).toEqual([{ u: roleForTenant('t2'), s: roleForTenant('t2') }]);
    } finally { await c.release(); }
  });

  it.skipIf(!dockerAvailable)('cannot read public application tables, and fails closed on new PUBLIC grants', async () => {
    if (!pgPool) throw new Error('fixture pool missing');
    await pgPool.query('CREATE TABLE public.host_private_fixture(secret text)');
    try {
      await expect(sqlFor('t2').query({ sql: 'SELECT * FROM public.host_private_fixture' })).rejects.toThrow(/permission denied/i);
      await pgPool.query('GRANT SELECT ON public.host_private_fixture TO PUBLIC');
      await expect(sqlFor('t2').query({ sql: 'SELECT 1' })).rejects.toThrow(/unsafe foreign-schema privileges/i);
    } finally { await pgPool.query('DROP TABLE public.host_private_fixture'); }
  });

  it.skipIf(!dockerAvailable)('refuses a publicly executable SECURITY DEFINER escape hatch', async () => {
    if (!pgPool) throw new Error('fixture pool missing');
    await pgPool.query("CREATE FUNCTION public.host_escape_fixture() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT current_user::text $$");
    try { await expect(sqlFor('t2').query({ sql: 'SELECT public.host_escape_fixture()' })).rejects.toThrow(/unsafe foreign-schema privileges/i); }
    finally { await pgPool.query('DROP FUNCTION public.host_escape_fixture()'); }
  });

  it.skipIf(!dockerAvailable)('refuses PUBLIC access to a foreign large object outside all schemas', async () => {
    if (!pgPool) throw new Error('fixture pool missing');
    const { rows } = await pgPool.query('SELECT lo_create(0) AS oid');
    const oid = Number(rows[0].oid);
    await pgPool.query(`GRANT SELECT ON LARGE OBJECT ${oid} TO PUBLIC`);
    try { await expect(sqlFor('t2').query({ sql: 'SELECT 1' })).rejects.toThrow(/unsafe foreign-schema privileges/i); }
    finally { await pgPool.query('SELECT lo_unlink($1)', [oid]); }
  });

  it.skipIf(!dockerAvailable)('rechecks a cached tenant role after an unexpected administrator membership grant', async () => {
    if (!pgPool || !container) throw new Error('fixture missing');
    const unexpected = 'sql_unexpected_member_fixture';
    await pgPool.query(`CREATE ROLE ${unexpected} CREATEROLE`);
    await pgPool.query(`GRANT ${unexpected} TO ${escapeIdentifier(roleForTenant('t2'))}`);
    try { await expect(sqlFor('t2').query({ sql: 'SELECT 1' })).rejects.toThrow(/unsafe foreign-schema privileges/i); }
    finally { await pgPool.query(`REVOKE ${unexpected} FROM ${escapeIdentifier(roleForTenant('t2'))}; DROP ROLE ${unexpected}`); }
    await expect(sqlFor('t2').query({ sql: 'SELECT 1' })).resolves.toBeDefined();
  });

  it.skipIf(!dockerAvailable)('checks custom schemas beginning with pg without treating them as system catalogs', async () => {
    if (!pgPool) throw new Error('fixture missing');
    await pgPool.query('CREATE SCHEMA pgt_fixture; CREATE TABLE pgt_fixture.content(value text); GRANT USAGE ON SCHEMA pgt_fixture TO PUBLIC; GRANT SELECT ON pgt_fixture.content TO PUBLIC');
    try { await expect(sqlFor('t2').query({ sql: 'SELECT 1' })).rejects.toThrow(/unsafe foreign-schema privileges/i); }
    finally { await pgPool.query('DROP SCHEMA pgt_fixture CASCADE'); }
  });

  it.skipIf(!dockerAvailable)('limits all tenant sessions to the declared shared connection budget', async () => {
    if (!pgPool) throw new Error('fixture pool missing');
    let peak = 0;
    const requests = Array.from({ length: 6 }, (_, i) => sqlFor(i % 2 ? 't1' : 't2').query({ sql: 'SELECT pg_sleep(0.15)' }));
    const sampler = setInterval(() => {
      void pgPool?.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename LIKE 'owp_sql_role_%'").then((r) => { peak = Math.max(peak, Number(r.rows[0].n)); });
    }, 15);
    try { await Promise.all(requests); } finally { clearInterval(sampler); }
    expect(peak).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(2);
  });

  it.skipIf(!dockerAvailable)('shares existing data across independent runtime instances with the same stable key', async () => {
    if (!container) throw new Error('fixture container missing');
    const next = await createPgSqlRuntime({ dsn: container.getConnectionUri(), rolePasswordKey: 'disposable-live-test-key-minimum-32-characters', max: 2 });
    try { expect(await createPgSql({ tenantId: 't1' }, next).query({ sql: 'SELECT count(*)::int AS n FROM items' })).toMatchObject({ rows: [{ n: 3 }] }); }
    finally { await next.end(); }
  });

  it.skipIf(!dockerAvailable)('drains a timed-out server query before admitting the next session, with a non-superuser provisioner', async () => {
    if (!container || !pgPool) throw new Error('fixture missing');
    const provisioner = 'sql_timeout_provisioner_fixture';
    const tenant = 'timed-out-session';
    await pgPool.query(`CREATE ROLE ${provisioner} LOGIN CREATEROLE PASSWORD 'disposable-timeout-fixture'`);
    await pgPool.query(`GRANT CREATE ON DATABASE ${escapeIdentifier(container.getDatabase())} TO ${provisioner}`);
    const uri = new URL(container.getConnectionUri()); uri.username = provisioner; uri.password = 'disposable-timeout-fixture';
    const limited = await createPgSqlRuntime({ dsn: uri.toString(), rolePasswordKey: 'disposable-timeout-role-key-32-characters', max: 2 });
    let held: Awaited<ReturnType<typeof limited.connectTenant>> | undefined;
    let next: Awaited<ReturnType<typeof limited.connectTenant>> | undefined;
    try {
      held = await limited.connectTenant(tenant);
      const row = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0];
      if (!row || typeof row !== 'object' || !('pid' in row) || typeof row.pid !== 'number') throw new Error('fixture session PID missing');
      const pid = row.pid;
      await held.query('SET statement_timeout=0');
      await expect(held.query('SELECT pg_sleep(600)')).rejects.toThrow(/Query read timeout/);
      expect((await pgPool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND usename=$2', [pid, roleForTenant(tenant)])).rows).toEqual([{ n: 1 }]);
      const queued = limited.connectTenant(tenant);
      await Promise.all([held.release(), held.release()]);
      next = await queued;
      // pg_stat_activity proves actual drain, rather than just driver rejection.
      expect((await pgPool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND usename=$2', [pid, roleForTenant(tenant)])).rows).toEqual([{ n: 0 }]);
      expect((await pgPool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1', [roleForTenant(tenant)])).rows).toEqual([{ n: 1 }]);
      expect((await next.query('SELECT 1 AS n')).rows).toEqual([{ n: 1 }]);
    } finally {
      await next?.release();
      await held?.release();
      await limited.purgeTenant(tenant);
      await limited.end();
      await pgPool.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleForTenant(tenant))}`);
      await pgPool.query(`DROP OWNED BY ${provisioner}; DROP ROLE ${provisioner}`);
    }
  }, 45_000); // Exercises the real 30-second driver deadline, not a widened production timeout.

  it.skipIf(!dockerAvailable)('rejects queued and fresh admission when administrator visibility cannot prove server drain', async () => {
    if (!container || !pgPool) throw new Error('fixture missing');
    const provisioner = 'sql_drain_provisioner_fixture';
    const tenant = 'unconfirmed-session';
    await pgPool.query(`CREATE ROLE ${provisioner} LOGIN CREATEROLE PASSWORD 'disposable-drain-fixture'`);
    await pgPool.query(`GRANT CREATE ON DATABASE ${escapeIdentifier(container.getDatabase())} TO ${provisioner}`);
    const uri = new URL(container.getConnectionUri()); uri.username = provisioner; uri.password = 'disposable-drain-fixture';
    const limited = await createPgSqlRuntime({ dsn: uri.toString(), rolePasswordKey: 'disposable-drain-role-key-32-characters', max: 2 });
    try {
      const held = await limited.connectTenant(tenant);
      // Attach a handler before exercising failure, so queued rejection is observed.
      const queued = limited.connectTenant(tenant).then(() => 'unexpected admission', (error: Error) => error.message);
      await pgPool.query(`REVOKE ${escapeIdentifier(roleForTenant(tenant))} FROM ${provisioner} CASCADE`);
      await expect(held.release()).rejects.toThrow(/could not confirm session termination/);
      expect(await queued).toMatch(/could not confirm session termination/);
      await expect(limited.connectTenant(tenant)).rejects.toThrow(/runtime disabled until restart/);
    } finally {
      await pgPool.query(`GRANT ${escapeIdentifier(roleForTenant(tenant))} TO ${provisioner} WITH ADMIN OPTION`);
      try { await limited.purgeTenant(tenant); } finally { await limited.end(); }
      await pgPool.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleForTenant(tenant))}`);
      await pgPool.query(`DROP OWNED BY ${provisioner}; DROP ROLE ${provisioner}`);
    }
  });

  it.skipIf(!dockerAvailable)('erases only the target schema and disables cached and fresh access across revisions', async () => {
    await sqlFor('t2').query({ sql: 'SELECT lo_create(0)' });
    const held = await runtime.connectTenant('t2');
    await runtime.purgeTenant('t2');
    await expect(held.query('SELECT 1')).rejects.toThrow();
    await held.release();
    await expect(sqlFor('t2').query({ sql: 'SELECT 1' })).rejects.toThrow(/disabled|not permitted to log in/i);
    if (!pgPool) throw new Error('fixture pool missing');
    expect((await pgPool.query('SELECT count(*)::int AS n FROM pg_largeobject_metadata m JOIN pg_roles r ON m.lomowner = r.oid WHERE r.rolname = $1', [roleForTenant('t2')])).rows).toEqual([{ n: 0 }]);
    expect(await sqlFor('t1').query({ sql: 'SELECT count(*)::int AS n FROM items' })).toMatchObject({ rows: [{ n: 3 }] });
    await runtime.purgeTenant('never-used');
    await expect(sqlFor('never-used').query({ sql: 'SELECT 1' })).rejects.toThrow(/disabled/i);
  });

  it.skipIf(!dockerAvailable)('blocks activation over populated legacy schemas without modifying their data', async () => {
    if (!pgPool) throw new Error('fixture pool missing');
    await pgPool.query('CREATE SCHEMA tenant_legacy; CREATE TABLE tenant_legacy.saved(value text); INSERT INTO tenant_legacy.saved VALUES ($$keep$$)');
    try {
      await expect(runtime.verify()).rejects.toThrow(/populated legacy tenant schemas/i);
      expect((await pgPool.query('SELECT value FROM tenant_legacy.saved')).rows).toEqual([{ value: 'keep' }]);
    } finally { await pgPool.query('DROP SCHEMA tenant_legacy CASCADE'); }
  });

  it.skipIf(!dockerAvailable)('provisions, authenticates, and erases with a non-superuser CREATEROLE administrator', async () => {
    if (!container || !pgPool) throw new Error('fixture missing');
    const role = 'sql_provisioner_fixture';
    await pgPool.query(`CREATE ROLE ${role} LOGIN CREATEROLE PASSWORD 'disposable-nonsuper-fixture'`);
    await pgPool.query(`GRANT CREATE ON DATABASE ${escapeIdentifier(container.getDatabase())} TO ${role}`);
    const uri = new URL(container.getConnectionUri()); uri.username = role; uri.password = 'disposable-nonsuper-fixture';
    const nonSuper = await createPgSqlRuntime({ dsn: uri.toString(), rolePasswordKey: 'disposable-nonsuper-role-key-32-characters', max: 2 });
    const tenant = 'non-super-provisioned';
    try {
      await nonSuper.verify();
      const sql = createPgSql({ tenantId: tenant }, nonSuper);
      await sql.execute({ sql: 'CREATE TABLE content(value text)' });
      await sql.execute({ sql: 'INSERT INTO content VALUES ($1)', params: ['retained'] });
      await sql.query({ sql: 'SELECT lo_create(0)' });
      const active = await nonSuper.connectTenant(tenant);
      try {
        await nonSuper.purgeTenant(tenant);
        await expect(active.query('SELECT 1')).rejects.toThrow();
      } finally { await active.release(); }
      await expect(sql.query({ sql: 'SELECT 1' })).rejects.toThrow(/disabled/i);
    } finally {
      await nonSuper.end();
      await pgPool.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schemaForTenant(tenant))} CASCADE`);
      await pgPool.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleForTenant(tenant))}`);
      await pgPool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  });

  it.skipIf(!dockerAvailable)('requires PG15 INHERIT or explicit PG16 membership options for non-superuser erasure', async () => {
    if (!container || !pgPool) throw new Error('fixture missing');
    const provisioner = 'sql_noinherit_fixture';
    await pgPool.query(`CREATE ROLE ${provisioner} LOGIN CREATEROLE NOINHERIT PASSWORD 'disposable-noinherit-fixture'`);
    await pgPool.query(`GRANT CREATE ON DATABASE ${escapeIdentifier(container.getDatabase())} TO ${provisioner}`);
    const uri = new URL(container.getConnectionUri()); uri.username = provisioner; uri.password = 'disposable-noinherit-fixture';
    const restricted = await createPgSqlRuntime({ dsn: uri.toString(), rolePasswordKey: 'disposable-noinherit-role-key-32-characters', max: 2 });
    const tenant = 'noinherit-provisioned';
    try {
      if (image === 'postgres:15-alpine') {
        await expect(restricted.verify()).rejects.toThrow(/INHERIT provisioning user/);
        await expect(restricted.connectTenant(tenant)).rejects.toThrow(/INHERIT provisioning user/);
      } else {
        await restricted.verify();
        const sql = createPgSql({ tenantId: tenant }, restricted);
        await sql.execute({ sql: 'CREATE TABLE content(value text)' });
        await sql.query({ sql: 'SELECT lo_create(0)' });
        await restricted.purgeTenant(tenant);
        await expect(sql.query({ sql: 'SELECT 1' })).rejects.toThrow(/disabled/i);
        expect((await pgPool.query('SELECT count(*)::int AS n FROM pg_largeobject_metadata m JOIN pg_roles r ON m.lomowner=r.oid WHERE r.rolname=$1', [roleForTenant(tenant)])).rows).toEqual([{ n: 0 }]);
      }
    } finally {
      await restricted.end();
      await pgPool.query(`DROP SCHEMA IF EXISTS ${escapeIdentifier(schemaForTenant(tenant))} CASCADE`);
      await pgPool.query(`DROP ROLE IF EXISTS ${escapeIdentifier(roleForTenant(tenant))}`);
      await pgPool.query(`DROP OWNED BY ${provisioner}; DROP ROLE ${provisioner}`);
    }
  });

  it.skipIf(!dockerAvailable)('refuses a database CREATE grant without CREATEROLE before accepting traffic', async () => {
    if (!container || !pgPool) throw new Error('fixture missing');
    const role = 'sql_unprivileged_fixture';
    await pgPool.query(`CREATE ROLE ${role} LOGIN PASSWORD 'disposable-unprivileged-fixture'`);
    await pgPool.query(`GRANT CREATE ON DATABASE ${escapeIdentifier(container.getDatabase())} TO ${role}`);
    const uri = new URL(container.getConnectionUri()); uri.username = role; uri.password = 'disposable-unprivileged-fixture';
    const denied = await createPgSqlRuntime({ dsn: uri.toString(), rolePasswordKey: 'disposable-unprivileged-role-key-32-characters', max: 2 });
    try { await expect(denied.verify()).rejects.toThrow(/CREATEROLE/); }
    finally { await denied.end(); await pgPool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`); }
  });
});

});
