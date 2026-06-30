/**
 * ADR 0076 Phase 1 — BigQuery read-only connector.
 *
 * Verifies (a) a dedicated read-only `bigquery` provider pinned to bigquery.googleapis.com
 * (override-immune; deliberately not the broad `google` provider), and (b) the
 * `core.bigquery.query` node calls `ctx.connectors` correctly, maps the
 * BigQuery jobs.query response, stamps deterministic provenance (sql/projectId/jobId),
 * and fails closed (no connector surface, missing config, connector error).
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
    expect(out.status).toBe('success');
    const o = (out as { outputs: Record<string, unknown> }).outputs;
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
    expect(out.status).toBe('failure');
    expect((out as { error: { code: string } }).error.code).toBe('host_capability_missing');
  });

  it('fails with invalid_config when projectId or sql is missing', async () => {
    const noProj = await getNode().execute(makeCtx({ config: { sql: 'SELECT 1' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(noProj.status).toBe('failure');
    const noSql = await getNode().execute(makeCtx({ config: { projectId: 'p' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(noSql.status).toBe('failure');
  });

  it('propagates the connector fail-closed error (e.g. no connection)', async () => {
    const ctx = makeCtx({
      config: { projectId: 'p', sql: 'SELECT 1' },
      connectors: { invoke: async () => ({ ok: false, error: 'connector_no_connection' }) },
    });
    const out = await getNode().execute(ctx);
    expect(out.status).toBe('failure');
    expect((out as { error: { code: string } }).error.code).toBe('connector_no_connection');
  });
});
