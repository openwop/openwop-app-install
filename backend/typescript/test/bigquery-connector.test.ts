/**
 * ADR 0076 Phase 1 — BigQuery read-only connector.
 *
 * Verifies (a) a dedicated read-only `bigquery` provider pinned to bigquery.googleapis.com
 * (override-immune; deliberately not the broad `google` provider), and (b) the
 * `core.bigquery.query` node calls `ctx.connectors` correctly, maps the
 * BigQuery jobs.query response, stamps deterministic provenance (sql/projectId/jobId),
 * and fails closed (no connector surface, missing config, connector error).
 *
 * Tracker TST-BED-3 (w66). Red when: the provider loses `readOnly: true` and
 * gains a write scope group (double guard: the provider registry refuses a
 * `readOnly` provider that declares a write group at LOAD, so adding a write
 * group alone fails the whole file, not a case); the apiHosts pin moves; row mapping, the jobs.query URL, jobId provenance or
 * the connector error code drift; a missing projectId/sql or connector surface
 * stops failing closed.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { getProvider } from '../src/features/connections/providerRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

function makeCtx(over: Partial<NodeContext>): NodeContext {
  const base: NodeContext = {
    runId: 'run_1',
    nodeId: 'n1',
    tenantId: 'demo',
    inputs: {},
    configurable: {},
    attempt: 1,
    secrets: {},
    emit: async () => ({ eventId: 'e1', sequence: 1 }),
  };
  return { ...base, ...over };
}

describe('ADR 0076 §1 — dedicated read-only bigquery provider', () => {
  it('registers a bigquery provider pinned to bigquery.googleapis.com with NO write scope', () => {
    const bq = getProvider('bigquery');
    expect(bq).toBeTruthy();
    // Read-only: a read scope, and NO write scope group at all.
    expect((bq?.scopes.read ?? []).flatMap((g) => g.scopes)).toContain('https://www.googleapis.com/auth/bigquery.readonly');
    expect(bq?.scopes.write).toBeUndefined();
    expect(bq?.readOnly).toBe(true); // the host gate denies PUT/PATCH/DELETE for it
    // apiHosts pinned to the BigQuery API host (override-immune dedicated provider).
    expect(bq?.apiHosts).toContain('bigquery.googleapis.com');
  });
});

describe('ADR 0076 §1 — core.bigquery.query node', () => {
  beforeAll(() => ensureNodesRegistered());

  const getNode = () => {
    const node = getNodeRegistry().get('core.bigquery.query');
    expect(node).toBeTruthy();
    return node!;
  };

  it('maps the jobs.query response to rows + stamps deterministic provenance', async () => {
    let invoked: { connectorId: string; url: string; body?: string } | null = null;
    const ctx = makeCtx({
      config: { projectId: 'my-proj', sql: 'SELECT store, sales FROM t' },
      connectors: {
        invoke: async (connectorId, request) => {
          invoked = { connectorId, url: request.url, ...(request.body ? { body: request.body } : {}) };
          return {
            ok: true,
            status: 200,
            data: {
              jobReference: { jobId: 'job-123' },
              schema: { fields: [{ name: 'store' }, { name: 'sales' }] },
              rows: [{ f: [{ v: 'TX-1' }, { v: '4200' }] }, { f: [{ v: 'TX-2' }, { v: '5100' }] }],
              totalRows: '2',
            },
          };
        },
      },
    });
    const out = await getNode().execute(ctx);
    if (out.status !== 'success') throw new Error(`expected success, got ${out.status}`);
    const outputs = out.outputs;
    if (typeof outputs !== 'object' || outputs === null) throw new Error('expected an outputs object');
    const o: Record<string, unknown> = Object.fromEntries(Object.entries(outputs));
    expect(o.rows).toEqual([{ store: 'TX-1', sales: '4200' }, { store: 'TX-2', sales: '5100' }]);
    expect(o.rowCount).toBe(2);
    // Provenance — the "Verify Source" feed (ADR 0078).
    expect(o.sql).toBe('SELECT store, sales FROM t');
    expect(o.projectId).toBe('my-proj');
    expect(o.jobId).toBe('job-123');
    // Routed to the bigquery connector at the jobs.query endpoint.
    expect(invoked!.connectorId).toBe('bigquery');
    expect(invoked!.url).toContain('bigquery.googleapis.com/bigquery/v2/projects/my-proj/queries');
  });

  it('fails closed when the connector surface is absent', async () => {
    const out = await getNode().execute(makeCtx({ config: { projectId: 'p', sql: 'SELECT 1' } }));
    if (out.status !== 'failure') throw new Error(`expected failure, got ${out.status}`);
    expect(out.error.code).toBe('host_capability_missing');
  });

  it('fails with invalid_config when projectId or sql is missing', async () => {
    const noProj = await getNode().execute(makeCtx({ config: { sql: 'SELECT 1' }, connectors: { invoke: async () => ({ ok: true }) } }));
    if (noProj.status !== 'failure') throw new Error(`expected failure, got ${noProj.status}`);
    expect(noProj.error.code).toBe('invalid_config');
    expect(noProj.error.message).toContain('projectId');
    const noSql = await getNode().execute(makeCtx({ config: { projectId: 'p' }, connectors: { invoke: async () => ({ ok: true }) } }));
    if (noSql.status !== 'failure') throw new Error(`expected failure, got ${noSql.status}`);
    expect(noSql.error.code).toBe('invalid_config');
    expect(noSql.error.message).toContain('config.sql');
  });

  it('propagates the connector fail-closed error (e.g. no connection)', async () => {
    const ctx = makeCtx({
      config: { projectId: 'p', sql: 'SELECT 1' },
      connectors: { invoke: async () => ({ ok: false, error: 'connector_no_connection' }) },
    });
    const out = await getNode().execute(ctx);
    if (out.status !== 'failure') throw new Error(`expected failure, got ${out.status}`);
    expect(out.error.code).toBe('connector_no_connection');
  });
});
