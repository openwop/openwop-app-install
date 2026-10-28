/**
 * ADR 0904 D9 / P3 — a PERSISTED lexical (keyword) index beside the pgvector table.
 *
 * The KB's BM25 channel re-read and re-chunked a whole collection for every query
 * (O(corpus)). This is a Postgres side table `kb_lexical (tenant, namespace, chunk_id,
 * tsv, metadata)` with a GIN index and the existing BM25 scoring formula. The KB switches to it per
 * collection above a size trigger; below it the in-memory BM25 stays (it is exact and
 * cheap there).
 *
 * Host-level and feature-agnostic: callers pass TERMS (already tokenized — the KB passes
 * its own diacritic-folded tokens, so Postgres indexes exactly the tokens BM25 would
 * see) and get back ids, a 0–1 rank and the stored metadata. The `simple` text-search
 * configuration does no stemming or stop-words, so it is locale-neutral.
 *
 * It runs on the pgvector adapter's EXISTING runner — no second pool (the deploy's
 * Postgres connection budget, `preflight-deploy.sh` Gate 5, counts pools, and
 * production runs this one at 1). Reads use it while pgvector is selected;
 * maintenance still reaches a configured backend after a switch. Teardown
 * purgers are registered beside the pgvector ones (`pgVectorVector.ts`), because rows
 * carry chunk text and the account-delete introspection only sees `tenant_id` columns.
 */
import type { SqlRunner } from './pgVectorVector.js';
import { randomUUID } from 'node:crypto';

const ident = (table: string): string => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw new Error(`unsafe table identifier: ${table}`);
  return table;
};

export const LEXICAL_TABLE = 'kb_lexical';

/** Stable collection owner; physical namespaces can change at embedding cutover. */
export function createLexicalStateTableSql(table = LEXICAL_TABLE): string {
  return `CREATE TABLE IF NOT EXISTS ${ident(`${table}_state`)} (` +
    'tenant text NOT NULL, owner_key text NOT NULL, generation text NOT NULL, ' +
    'ready_generation text, ready_namespace text, pending text[] NOT NULL DEFAULT ARRAY[]::text[], ' +
    'document_count integer NOT NULL DEFAULT 0, total_tokens bigint NOT NULL DEFAULT 0, index_format integer NOT NULL DEFAULT 0, source_revision text NOT NULL DEFAULT \'\', ' +
    'retired boolean NOT NULL DEFAULT false, PRIMARY KEY (tenant, owner_key))';
}

/** Additive upgrade from the unpublished ts_rank_cd prototype; old readiness
 * cannot certify a row without the current format and its corpus statistics. */
export function lexicalStorageUpgradeSql(table = LEXICAL_TABLE): string[] {
  return [
    `ALTER TABLE ${ident(table)} ADD COLUMN IF NOT EXISTS token_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS term_counts jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE ${ident(`${table}_state`)} ADD COLUMN IF NOT EXISTS document_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS total_tokens bigint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS index_format integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS source_revision text NOT NULL DEFAULT ''`,
  ];
}

/** The UPDATE is the lock and freshness gate. Both content mutations depend on
 *  its returned row; empty input still deletes the whole old namespace. */
export function replaceLexicalNamespaceSql(table = LEXICAL_TABLE): string {
  const state = ident(`${table}_state`); const content = ident(table);
  return `WITH tenant_gate AS (
    UPDATE ${state} SET generation = generation
    WHERE tenant = $1 AND owner_key = '' AND NOT retired RETURNING tenant
  ), gate AS (
    UPDATE ${state} s SET ready_generation = s.generation, index_format = 1,
      document_count = cardinality($5::text[]),
      total_tokens = (SELECT COALESCE(sum(n), 0) FROM unnest($9::integer[]) n)
    FROM tenant_gate t
    WHERE s.tenant = t.tenant AND s.owner_key = $2 AND s.ready_namespace = $3
      AND s.generation = $4 AND cardinality(s.pending) = 0 AND NOT s.retired
    RETURNING s.tenant, s.ready_namespace
  ), removed AS (
    DELETE FROM ${content} l USING gate g
    WHERE l.tenant = g.tenant AND l.namespace = g.ready_namespace AND NOT (l.chunk_id = ANY($5::text[]))
    RETURNING l.chunk_id
  ), written AS (
    INSERT INTO ${content} (tenant, namespace, chunk_id, tsv, metadata, term_counts, token_count)
    SELECT g.tenant, g.ready_namespace, u.id, to_tsvector('simple', u.terms), u.meta::jsonb, u.counts::jsonb, u.tokens
    FROM gate g CROSS JOIN unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::integer[]) u(id, terms, meta, counts, tokens)
    ON CONFLICT (tenant, namespace, chunk_id) DO UPDATE SET tsv = EXCLUDED.tsv, metadata = EXCLUDED.metadata,
      term_counts = EXCLUDED.term_counts, token_count = EXCLUDED.token_count
    RETURNING chunk_id
  ) SELECT true AS replaced FROM gate`;
}

/** Readiness and rows share one SQL snapshot. No gate row means unavailable;
 *  a gate with an empty hits array is a complete, genuinely empty answer. */
export function searchReadyLexicalSql(table = LEXICAL_TABLE): string {
  const content = ident(table); const state = ident(`${table}_state`);
  // GIN supplies matching rows and per-term document frequencies. Corpus
  // totals were committed with readiness, so queries neither re-read text nor
  // scan every document for length/count statistics. k1=1.5, b=.75 and the
  // score/(score+10) calibration match features/kb/lexicalIndex + kbService.
  return `WITH ready AS MATERIALIZED (
    SELECT s.document_count, s.total_tokens FROM ${state} s
    WHERE s.tenant = $1 AND s.owner_key = $2 AND s.ready_namespace = $3
      AND s.ready_generation = s.generation AND s.index_format = 1 AND s.source_revision = $7
      AND cardinality(s.pending) = 0 AND NOT s.retired
      AND EXISTS (SELECT 1 FROM ${state} t WHERE t.tenant = s.tenant AND t.owner_key = '' AND NOT t.retired)
  ), terms AS MATERIALIZED (
    SELECT q.term, count(*)::double precision AS df
    FROM unnest($6::text[]) q(term) CROSS JOIN ready r
    JOIN ${content} l ON l.tenant = $1 AND l.namespace = $3 AND l.tsv @@ plainto_tsquery('simple', q.term)
    GROUP BY q.term
  ), ranked AS (
    SELECT l.chunk_id AS id, weights.score
    FROM ${content} l CROSS JOIN ready r CROSS JOIN LATERAL (
      SELECT sum(ln(1 + (r.document_count - t.df + .5) / (t.df + .5)) *
        ((l.term_counts->>t.term)::double precision * 2.5) /
        ((l.term_counts->>t.term)::double precision + 1.5 *
          (.25 + .75 * l.token_count / (r.total_tokens::double precision / NULLIF(r.document_count, 0))))) AS score
      FROM terms t WHERE l.term_counts ? t.term
    ) weights
    WHERE l.tenant = $1 AND l.namespace = $3 AND l.tsv @@ to_tsquery('simple', $4)
      AND r.document_count > 0 AND r.total_tokens > 0 AND weights.score > 0
    ORDER BY weights.score DESC, l.chunk_id COLLATE "C" ASC LIMIT $5
  ) SELECT COALESCE((SELECT jsonb_agg(h ORDER BY h.score DESC, h.id COLLATE "C" ASC) FROM (
    SELECT ranked.id, ranked.score / (ranked.score + 10) AS score, l.metadata
    FROM ranked JOIN ${content} l ON l.tenant = $1 AND l.namespace = $3 AND l.chunk_id = ranked.id
  ) h), '[]'::jsonb) AS hits FROM ready`;
}

export function createLexicalTableSql(table = LEXICAL_TABLE): string {
  return `CREATE TABLE IF NOT EXISTS ${ident(table)} (` +
    'tenant text NOT NULL, namespace text NOT NULL, chunk_id text NOT NULL, ' +
    "tsv tsvector NOT NULL, metadata jsonb, token_count integer NOT NULL DEFAULT 0, term_counts jsonb NOT NULL DEFAULT '{}'::jsonb, " +
    'PRIMARY KEY (tenant, namespace, chunk_id))';
}
export function createLexicalIndexSql(table = LEXICAL_TABLE): string {
  return `CREATE INDEX IF NOT EXISTS ${ident(table)}_tsv_gin ON ${ident(table)} USING gin (tsv)`;
}
export function purgeLexicalTenantSql(table = LEXICAL_TABLE): string {
  return `DELETE FROM ${ident(table)} WHERE tenant = $1`;
}
export function purgeLexicalNamespaceSql(table = LEXICAL_TABLE): string {
  return `DELETE FROM ${ident(table)} WHERE tenant = $1 AND namespace = $2`;
}

/** The OR-query for a set of terms; null when there is nothing to search for. Terms must
 *  be letters/digits only (the KB tokenizer guarantees it) — anything else is dropped,
 *  so no tsquery operator can reach the parser. Still sent as a bound parameter. */
export function lexicalQueryString(terms: readonly string[]): string | null {
  const safe = [...new Set(terms.filter((t) => /^[\p{L}\p{N}]+$/u.test(t)))];
  return safe.length > 0 ? safe.join(' | ') : null;
}

export interface LexicalItem { id: string; terms: string; metadata: Record<string, unknown> }
export interface LexicalHit { id: string; score: number; metadata: Record<string, unknown> | null }

export interface LexicalOwnerSnapshot { generation: string; namespace: string | null; pending: boolean; ready: boolean; sourceRevision?: string }
export interface LexicalIndex {
  ensureOwner(tenant: string, owner: string, namespace: string): Promise<void>;
  beginMutation(tenant: string, owner: string, namespace: string, operation: string): Promise<void>;
  finishMutation(tenant: string, owner: string, operation: string): Promise<void>;
  ownerSnapshot(tenant: string, owner: string): Promise<LexicalOwnerSnapshot | null>;
  admitNamespace(tenant: string, owner: string, generation: string, namespace: string, sourceRevision?: string): Promise<string | null>;
  replaceNamespace(tenant: string, owner: string, namespace: string, generation: string, items: readonly LexicalItem[]): Promise<boolean>;
  searchReady(tenant: string, owner: string, namespace: string, terms: readonly string[], topK: number, sourceRevision?: string): Promise<LexicalHit[] | null>;
  deleteDocument(tenant: string, owner: string, operation: string, namespace: string, documentId: string): Promise<void>;
  retireOwner(tenant: string, owner: string): Promise<void>;
  purgeNamespace(tenant: string, namespace: string): Promise<number>;
  purgeTenant(tenant: string): Promise<number>;
}

export function createPgLexical(run: SqlRunner, table = LEXICAL_TABLE): LexicalIndex {
  const state = ident(`${table}_state`);
  const ensureOwner = async (tenant: string, owner: string, namespace: string): Promise<void> => {
    if (!owner) throw new Error('kb_lexical_owner_required');
    // The empty owner is the tenant's content-free admission/retirement row.
    // Every content publisher locks it; teardown retires it before its fresh
    // DELETE snapshot. It must survive teardown to fence late in-flight calls.
    await run(`INSERT INTO ${state} (tenant, owner_key, generation)
      VALUES ($1, '', $2) ON CONFLICT (tenant, owner_key) DO NOTHING`, [tenant, randomUUID()]);
    await run(`WITH tenant_gate AS (
      UPDATE ${state} SET generation = generation
      WHERE tenant = $1 AND owner_key = '' AND NOT retired RETURNING tenant
    ) INSERT INTO ${state} (tenant, owner_key, generation, ready_namespace)
      SELECT tenant, $2, $3, $4 FROM tenant_gate
      ON CONFLICT (tenant, owner_key) DO NOTHING`, [tenant, owner, randomUUID(), namespace]);
  };
  return {
    ensureOwner,
    async beginMutation(tenant, owner, namespace, operation) {
      await ensureOwner(tenant, owner, namespace);
      const result = await run(`WITH tenant_gate AS (
        UPDATE ${state} SET generation = generation
        WHERE tenant = $1 AND owner_key = '' AND NOT retired RETURNING tenant
      ) UPDATE ${state} s SET generation = $3,
          pending = CASE WHEN $4 = ANY(s.pending) THEN s.pending ELSE array_append(s.pending, $4) END
        FROM tenant_gate t WHERE s.tenant = t.tenant AND s.owner_key = $2 AND NOT s.retired
          AND (cardinality(s.pending) < 1024 OR $4 = ANY(s.pending))
        RETURNING s.owner_key`, [tenant, owner, randomUUID(), operation]);
      if (!result.rows.length) throw new Error('kb_lexical_owner_unavailable');
    },
    async finishMutation(tenant, owner, operation) {
      // Removes only this operation and never certifies readiness. Idempotent
      // after a lost acknowledgement; failures leave durable pending state.
      await run(`UPDATE ${state} SET pending = array_remove(pending, $3) WHERE tenant = $1 AND owner_key = $2`, [tenant, owner, operation]);
    },
    async ownerSnapshot(tenant, owner) {
      const { rows } = await run(`SELECT s.generation, s.ready_namespace, s.source_revision, cardinality(s.pending) > 0 AS pending,
        s.ready_generation = s.generation AND s.index_format = 1 AS ready FROM ${state} s
        WHERE s.tenant = $1 AND s.owner_key = $2 AND NOT s.retired
          AND EXISTS (SELECT 1 FROM ${state} t WHERE t.tenant = s.tenant AND t.owner_key = '' AND NOT t.retired)`, [tenant, owner]);
      const row = rows[0];
      return row ? { generation: String(row.generation), namespace: typeof row.ready_namespace === 'string' ? row.ready_namespace : null, pending: row.pending === true, ready: row.ready === true, sourceRevision: typeof row.source_revision === 'string' ? row.source_revision : '' } : null;
    },
    async admitNamespace(tenant, owner, generation, namespace, sourceRevision = '') {
      const { rows } = await run(`UPDATE ${state} SET ready_namespace = $4,
        generation = CASE WHEN ready_namespace IS DISTINCT FROM $4 OR source_revision IS DISTINCT FROM $6 THEN $5 ELSE generation END,
        ready_generation = CASE WHEN ready_namespace IS DISTINCT FROM $4 OR source_revision IS DISTINCT FROM $6 THEN NULL ELSE ready_generation END,
        source_revision = $6
        WHERE tenant = $1 AND owner_key = $2 AND generation = $3 AND cardinality(pending) = 0 AND NOT retired
        RETURNING generation`, [tenant, owner, generation, namespace, randomUUID(), sourceRevision]);
      return rows[0] ? String(rows[0].generation) : null;
    },
    async replaceNamespace(tenant, owner, namespace, generation, items) {
      const counts: string[] = []; const lengths: number[] = [];
      for (const item of items) {
        const words = item.terms.split(' ').filter(Boolean);
        const frequencies: Record<string, number> = Object.create(null);
        for (const word of words) frequencies[word] = (frequencies[word] ?? 0) + 1;
        counts.push(JSON.stringify(frequencies)); lengths.push(words.length);
      }
      const { rows } = await run(replaceLexicalNamespaceSql(table), [tenant, owner, namespace, generation,
        items.map((i) => i.id), items.map((i) => i.terms), items.map((i) => JSON.stringify(i.metadata)), counts, lengths]);
      return rows.length > 0;
    },
    async searchReady(tenant, owner, namespace, terms, topK, sourceRevision = '') {
      const query = lexicalQueryString(terms);
      if (!query) return null;
      const { rows } = await run(searchReadyLexicalSql(table), [tenant, owner, namespace, query, topK, query.split(' | '), sourceRevision]);
      if (!rows.length) return null;
      const hits = rows[0]!.hits;
      if (!Array.isArray(hits)) throw new Error('kb_lexical_invalid_search_result');
      return hits.map((hit: Record<string, unknown>) => ({ id: String(hit.id), score: Number(hit.score), metadata: (hit.metadata ?? null) as Record<string, unknown> | null }));
    },
    async deleteDocument(tenant, owner, operation, namespace, documentId) {
      // beginMutation already waited for prior reconciles and durably invalidated
      // readiness. Check its operation, then take a NEW DELETE snapshot: a CTE that
      // waits on a row lock can otherwise miss lexical rows committed during the wait.
      const { rows } = await run(`SELECT owner_key FROM ${state}
        WHERE tenant = $1 AND owner_key = $2 AND $3 = ANY(pending)`, [tenant, owner, operation]);
      if (!rows.length) throw new Error('kb_lexical_mutation_claim_missing');
      await run(`DELETE FROM ${ident(table)} WHERE tenant = $1 AND namespace = $2
        AND (metadata->>'documentId' = $3 OR (left(chunk_id, char_length($3) + 1) = $3 || ':'
          AND substring(chunk_id FROM char_length($3) + 2) ~ '^[0-9]+$'))`, [tenant, namespace, documentId]);
    },
    async retireOwner(tenant, owner) {
      // Retiring an owner that has not indexed yet must still fence a late writer.
      await run(`INSERT INTO ${state} (tenant, owner_key, generation, retired)
        VALUES ($1, $2, $3, true) ON CONFLICT (tenant, owner_key) DO UPDATE
        SET retired = true, generation = EXCLUDED.generation, ready_generation = NULL`, [tenant, owner, randomUUID()]);
    },
    async purgeNamespace(tenant, namespace) {
      // Invalidate and wait for earlier reconciles BEFORE taking the content
      // DELETE's fresh snapshot. A single old-snapshot CTE can miss their rows.
      await run(`UPDATE ${state} SET generation = $3, ready_generation = NULL
        WHERE tenant = $1 AND ready_namespace = $2`, [tenant, namespace, randomUUID()]);
      const { rows } = await run(`${purgeLexicalNamespaceSql(table)} RETURNING chunk_id`, [tenant, namespace]);
      return rows.length;
    },
    async purgeTenant(tenant) {
      await run(`INSERT INTO ${state} (tenant, owner_key, generation, retired)
        VALUES ($1, '', $2, true) ON CONFLICT (tenant, owner_key) DO UPDATE
        SET retired = true, generation = EXCLUDED.generation, ready_generation = NULL`, [tenant, randomUUID()]);
      await run(`UPDATE ${state} SET retired = true, generation = $2, ready_generation = NULL, pending = ARRAY[]::text[]
        WHERE tenant = $1`, [tenant, randomUUID()]);
      const { rows } = await run(`${purgeLexicalTenantSql(table)} RETURNING chunk_id`, [tenant]);
      // Keep only opaque, content-free retirement markers. Removing them lets
      // a caller paused before teardown recreate a searchable namespace.
      return rows.length;
    },

  };
}

let active: LexicalIndex | null = null;
let configured: LexicalIndex | null = null;
/** The persisted lexical index while one is configured (pgvector selected), else null. */
export function lexicalIndex(): LexicalIndex | null { return active; }
/** Deletes and invalidation must still reach residue after switching vector backends. */
export function lexicalMaintenanceIndex(): LexicalIndex | null { return configured; }
/** Set by the pgvector registration; tests inject a fake. */
export function setLexicalIndex(index: LexicalIndex | null, forReads = true): void {
  configured = index;
  active = forReads ? index : null;
}
