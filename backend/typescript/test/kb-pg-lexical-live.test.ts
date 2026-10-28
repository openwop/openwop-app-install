/**
 * ADR 0904 P3 (D9) — the persisted lexical index against a REAL Postgres
 * (testcontainers; `tsvector` / GIN / `ts_rank_cd` are core Postgres). Pins:
 *  - the DDL, batched upsert, delete, tenant/namespace purge actually execute;
 *  - tenant + namespace isolation on search;
 *  - RANK-SET AGREEMENT with the in-memory BM25 on the eval corpus: `ts_rank_cd` and
 *    Okapi BM25 rank differently, so this pins the tolerance — the mean top-5 overlap of
 *    the two channels over the 60 labelled queries — instead of pretending they match.
 *
 * Docker or a task-owned native Postgres fixture; no production database.
 * `OPENWOP_PGVECTOR_LIVE=1` hard-requires the live lane.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import type { SqlRunner } from '../src/host/vector/pgVectorVector.js';
import { createLexicalIndexSql, createLexicalTableSql, createLexicalStateTableSql, lexicalStorageUpgradeSql, createPgLexical, type LexicalIndex, type LexicalItem } from '../src/host/vector/pgLexical.js';
import { bm25Search, tokenize } from '../src/features/kb/lexicalIndex.js';
import { chunkText } from '../src/features/kb/kbService.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDsn = process.env.OPENWOP_KB_LEXICAL_TEST_DSN;
if (fixtureDsn) {
  const parsed = new URL(fixtureDsn);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || !parsed.pathname.startsWith('/kb_lexical_test')) throw new Error('A local dedicated KB test database is required');
}

async function isDockerReachable(): Promise<boolean> {
  if (process.env.OPENWOP_SKIP_TESTCONTAINERS === '1') return false;
  try {
    const { execSync } = await import('node:child_process');
    // Some desktop Docker CLIs print a daemon error yet exit zero. Require a
    // real server value as well, otherwise the container runner hangs later.
    const server = execSync("docker version --format '{{.Server.Version}}'", { timeout: 15_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^\d+\./.test(server);
  } catch { return false; }
}
const dockerAvailable = Boolean(fixtureDsn) || process.env.OPENWOP_PGVECTOR_LIVE === '1' || await isDockerReachable();
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn('[kb-pg-lexical-live] Docker not reachable — skipping. Set OPENWOP_PGVECTOR_LIVE=1 to require it.');
}

let container: StartedPostgreSqlContainer | null = null;
let pool: Pool | null = null;
let run: SqlRunner;

beforeAll(async () => {
  if (!dockerAvailable) return;
  if (!fixtureDsn) container = await new PostgreSqlContainer('postgres:16-alpine').withResourcesQuota({ memory: 0.5, cpu: 1 }).start();
  pool = new Pool({ connectionString: fixtureDsn ?? container!.getConnectionUri(), max: 3 });
  await pool.query(createLexicalTableSql());
  await pool.query(createLexicalIndexSql());
  await pool.query(createLexicalStateTableSql());
  for (const sql of lexicalStorageUpgradeSql()) await pool.query(sql);
  run = async (sql, params) => pool!.query(sql, params as unknown[]).then((r) => ({ rows: r.rows }));
}, 180_000);

afterAll(async () => {
  if (pool) { try { await pool.end(); } catch { /* ignore */ } }
  if (container) { try { await container.stop(); } catch { /* ignore */ } }
}, 60_000);

async function publish(lex: LexicalIndex, tenant: string, owner: string, ns: string, items: LexicalItem[], revision = '') {
  await lex.ensureOwner(tenant, owner, ns);
  const snapshot = await lex.ownerSnapshot(tenant, owner);
  if (!snapshot) throw new Error('missing owner');
  const generation = await lex.admitNamespace(tenant, owner, snapshot.generation, ns, revision);
  if (!generation) throw new Error('owner unavailable');
  return lex.replaceNamespace(tenant, owner, ns, generation, items);
}
const item = (id: string, text: string, documentId = id) => ({ id, terms: tokenize(text).join(' '), metadata: { text, documentId } });

describe('kb_lexical live', () => {
  it.skipIf(!dockerAvailable)('replaces complete namespaces, searches with isolation, and purges text', async () => {
    const lex = createPgLexical(run);
    await publish(lex, 't1', 'owner', 'ns', [item('a', 'Forklift recertification every three years'), item('b', 'Cold chain pallets')]);
    await publish(lex, 't1', 'other-owner', 'other', [item('c', 'Forklift manual')]);
    await publish(lex, 't2', 'owner', 'ns', [item('d', 'Forklift policy')]);
    const hits = await lex.searchReady('t1', 'owner', 'ns', tokenize('forklift'), 5);
    expect(hits?.map(h => h.id)).toEqual(['a']);
    expect(hits?.[0]?.score).toBeGreaterThan(0);
    expect(hits?.[0]?.score).toBeLessThan(1);
    await publish(lex, 't1', 'owner', 'ns', [item('a', 'Now about badges')]);
    expect(await lex.searchReady('t1', 'owner', 'ns', ['pallets'], 5)).toEqual([]);
    expect((await run('SELECT chunk_id FROM kb_lexical WHERE tenant=$1 AND namespace=$2', ['t1', 'ns'])).rows.map(r => r.chunk_id)).toEqual(['a']);
    await lex.purgeNamespace('t1', 'other');
    expect(await lex.searchReady('t1', 'other-owner', 'other', ['forklift'], 5)).toBeNull();
    await lex.purgeTenant('t2');
    expect(await lex.ownerSnapshot('t2', 'owner')).toBeNull();
    expect((await run('SELECT chunk_id FROM kb_lexical WHERE tenant=$1', ['t2'])).rows).toEqual([]);
  });

  it.skipIf(!dockerAvailable)('two replicas invalidate readiness; a paused old rebuild cannot resurrect a deleted document', async () => {
    const a = createPgLexical(run); const b = createPgLexical(run);
    await publish(a, 'race-doc', 'owner', 'ns', [item('doc:0', 'Private forklift text', 'doc')]);
    const before = await a.ownerSnapshot('race-doc', 'owner');
    await b.beginMutation('race-doc', 'owner', 'ns', 'delete-op');
    expect(await a.searchReady('race-doc', 'owner', 'ns', ['forklift'], 5)).toBeNull();
    await b.deleteDocument('race-doc', 'owner', 'delete-op', 'ns', 'doc');
    await b.finishMutation('race-doc', 'owner', 'delete-op');
    expect(await a.replaceNamespace('race-doc', 'owner', 'ns', before!.generation, [item('doc:0', 'Private forklift text', 'doc')])).toBe(false);
    expect((await run('SELECT chunk_id FROM kb_lexical WHERE tenant=$1', ['race-doc'])).rows).toEqual([]);
    expect(await publish(a, 'race-doc', 'owner', 'ns', [])).toBe(true);
    expect(await a.searchReady('race-doc', 'owner', 'ns', ['forklift'], 5)).toEqual([]);
  });

  it.skipIf(!dockerAvailable)('lost publication acknowledgements retry idempotently and lost mutation acknowledgements stay unavailable', async () => {
    const lex = createPgLexical(run);
    await publish(lex, 'lost-ack', 'owner', 'ns', [item('a', 'forklift')]);
    const snapshot = await lex.ownerSnapshot('lost-ack', 'owner');
    let lose = true;
    const uncertain = createPgLexical(async (sql, params) => {
      const result = await run(sql, params);
      if (lose && sql.includes('written AS')) { lose = false; throw new Error('lost commit acknowledgement'); }
      return result;
    });
    await expect(uncertain.replaceNamespace('lost-ack', 'owner', 'ns', snapshot!.generation, [item('a', 'forklift')])).rejects.toThrow('lost commit acknowledgement');
    expect(await uncertain.replaceNamespace('lost-ack', 'owner', 'ns', snapshot!.generation, [item('a', 'forklift')])).toBe(true);
    expect((await lex.searchReady('lost-ack', 'owner', 'ns', ['forklift'], 5))?.map(h => h.id)).toEqual(['a']);
    const pending = createPgLexical(async (sql, params) => {
      const result = await run(sql, params);
      if (sql.includes('array_append(s.pending')) throw new Error('uncertain source admission');
      return result;
    });
    await expect(pending.beginMutation('lost-ack', 'owner', 'ns', 'uncertain')).rejects.toThrow('uncertain source admission');
    expect(await createPgLexical(run).searchReady('lost-ack', 'owner', 'ns', ['forklift'], 5)).toBeNull();
  });

  it.skipIf(!dockerAvailable)('collection retirement fences a first delayed publisher and cannot be undone by ensureOwner', async () => {
    const lex = createPgLexical(run);
    await lex.ensureOwner('retired-owner', 'owner', 'ns');
    const snapshot = await lex.ownerSnapshot('retired-owner', 'owner');
    await lex.retireOwner('retired-owner', 'owner'); await lex.purgeNamespace('retired-owner', 'ns');
    await lex.ensureOwner('retired-owner', 'owner', 'ns');
    expect(await lex.replaceNamespace('retired-owner', 'owner', 'ns', snapshot!.generation, [item('x', 'private')])).toBe(false);
    await expect(lex.beginMutation('retired-owner', 'owner', 'ns', 'late')).rejects.toThrow('kb_lexical_owner_unavailable');
    expect((await run('SELECT chunk_id FROM kb_lexical WHERE tenant=$1', ['retired-owner'])).rows).toEqual([]);
  });

  it.skipIf(!dockerAvailable)('tenant teardown waits for a committing publisher then deletes its newly committed rows', async () => {
    const lex = createPgLexical(run);
    await lex.ensureOwner('tenant-race', 'owner', 'ns');
    const snapshot = await lex.ownerSnapshot('tenant-race', 'owner');
    const writer = await pool!.connect(); const eraser = await pool!.connect();
    let deleting: Promise<number> | undefined;
    try {
      await writer.query('BEGIN');
      const inTransaction = createPgLexical((sql, params) => writer.query(sql, params).then(r => ({ rows: r.rows })));
      expect(await inTransaction.replaceNamespace('tenant-race', 'owner', 'ns', snapshot!.generation, [item('late', 'private text')])).toBe(true);
      const pid = Number((await eraser.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      deleting = createPgLexical((sql, params) => eraser.query(sql, params).then(r => ({ rows: r.rows }))).purgeTenant('tenant-race');
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const { rows } = await pool!.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [pid]);
        waiting = rows[0].waiting === true;
      }
      expect(waiting, 'the eraser really waited for the uncommitted publisher').toBe(true);
      await writer.query('COMMIT'); await deleting;
      expect((await run('SELECT chunk_id FROM kb_lexical WHERE tenant=$1', ['tenant-race'])).rows).toEqual([]);
      await lex.ensureOwner('tenant-race', 'new-late-owner', 'new-ns');
      expect(await lex.ownerSnapshot('tenant-race', 'new-late-owner')).toBeNull();
    } finally {
      await writer.query('ROLLBACK');
      await deleting?.catch(() => undefined);
      writer.release(); eraser.release();
    }
  });

  it.skipIf(!dockerAvailable)('additively upgrades prototype rows without trusting their old readiness or losing their content', async () => {
    const table = 'kb_lexical_legacy';
    await run(`CREATE TABLE ${table} (tenant text NOT NULL, namespace text NOT NULL, chunk_id text NOT NULL,
      tsv tsvector NOT NULL, metadata jsonb, PRIMARY KEY (tenant, namespace, chunk_id))`, []);
    await run(`CREATE TABLE ${table}_state (tenant text NOT NULL, owner_key text NOT NULL, generation text NOT NULL,
      ready_generation text, ready_namespace text, pending text[] NOT NULL DEFAULT ARRAY[]::text[],
      retired boolean NOT NULL DEFAULT false, PRIMARY KEY (tenant, owner_key))`, []);
    await run(`INSERT INTO ${table} VALUES ('migration', 'ns', 'a', to_tsvector('simple', 'forklift'), '{"text":"forklift"}')`, []);
    await run(`INSERT INTO ${table}_state (tenant, owner_key, generation, ready_generation, ready_namespace)
      VALUES ('migration', 'owner', 'old-generation', 'old-generation', 'ns')`, []);
    for (const sql of lexicalStorageUpgradeSql(table)) await run(sql, []);
    const lex = createPgLexical(run, table); await lex.ensureOwner('migration', 'owner', 'ns');
    expect((await lex.ownerSnapshot('migration', 'owner'))?.ready).toBe(false);
    expect(await lex.searchReady('migration', 'owner', 'ns', ['forklift'], 5)).toBeNull();
    expect((await run(`SELECT metadata FROM ${table}`, [])).rows[0]?.metadata).toEqual({ text: 'forklift' });
    expect(await publish(lex, 'migration', 'owner', 'ns', [item('a', 'forklift')])).toBe(true);
    expect((await lex.searchReady('migration', 'owner', 'ns', ['forklift'], 5))?.map(h => h.id)).toEqual(['a']);
  });

  it.skipIf(!dockerAvailable)('the same physical namespace cannot serve another enrichment or chunker revision', async () => {
    const lex = createPgLexical(run);
    await publish(lex, 'source-revision', 'owner', 'ns', [item('a', 'alpha')], 'provider-A');
    expect((await lex.searchReady('source-revision', 'owner', 'ns', ['alpha'], 5, 'provider-A'))?.map(h => h.id)).toEqual(['a']);
    expect(await lex.searchReady('source-revision', 'owner', 'ns', ['alpha'], 5, 'provider-B')).toBeNull();
    const old = await lex.ownerSnapshot('source-revision', 'owner');
    const next = await lex.admitNamespace('source-revision', 'owner', old!.generation, 'ns', 'provider-B');
    expect(next).not.toBe(old!.generation);
    expect(await lex.replaceNamespace('source-revision', 'owner', 'ns', old!.generation, [item('a', 'alpha')])).toBe(false);
    expect(await lex.replaceNamespace('source-revision', 'owner', 'ns', next!, [item('b', 'beta')])).toBe(true);
    expect(await lex.searchReady('source-revision', 'owner', 'ns', ['alpha'], 5, 'provider-A')).toBeNull();
    expect((await lex.searchReady('source-revision', 'owner', 'ns', ['beta'], 5, 'provider-B'))?.map(h => h.id)).toEqual(['b']);
  });

  it.skipIf(!dockerAvailable)('agrees with in-memory BM25 on the eval corpus within the pinned tolerance', async () => {
    const corpus = JSON.parse(readFileSync(join(here, 'fixtures/kb-eval/corpus.json'), 'utf8')) as {
      documents: Array<{ id: string; text: string }>; queries: Array<{ query: string }>;
    };
    const chunks = corpus.documents.flatMap((d) => chunkText(d.text).map((text, i) => ({ id: `${d.id}:${i}`, text })));
    const lex = createPgLexical(run);
    await publish(lex, 'eval', 'owner', 'corpus', chunks.map((c) => ({ id: c.id, terms: tokenize(c.text).join(' '), metadata: { text: c.text } })));
    let overlap = 0;
    for (const q of corpus.queries) {
      const mem = new Set(bm25Search(chunks, q.query, 5).map((h) => h.id));
      const pg = (await lex.searchReady('eval', 'owner', 'corpus', tokenize(q.query), 5))!.map((h) => h.id);
      overlap += pg.filter((id) => mem.has(id)).length / Math.max(1, Math.min(5, mem.size));
    }
    const mean = overlap / corpus.queries.length;
    // eslint-disable-next-line no-console
    console.log(`[kb-pg-lexical-live] mean top-5 overlap with in-memory BM25: ${mean.toFixed(3)}`);
    expect(mean).toBeGreaterThanOrEqual(0.5);
  }, 60_000);
});
