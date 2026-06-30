/**
 * ADR 0082 Phase 1 — Workday read-only HCM source connector.
 *
 * Verifies (a) a dedicated read-only `workday` provider pinned to *.workday.com
 * (override-immune; the connection pack carries no apiHosts so it would fail closed),
 * (b) readOnly consistency (no write scope group), and (c) the `core.workday.query` node
 * calls `ctx.connectors` correctly (GET, bearer), maps the Workday `{data:[…]}` collection
 * to rows, stamps deterministic provenance (resource/baseUrl), and fails closed (no
 * connector surface, missing/invalid config, connector error).
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { getProvider, assertReadOnlyConsistent } from '../src/features/connections/providerRegistry.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

function makeCtx(over: Partial<NodeContext>): NodeContext {
  const base: NodeContext = {
    runId: 'run_1', nodeId: 'n1', tenantId: 'demo', inputs: {}, configurable: {},
    attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e1', sequence: 1 }),
  };
  return { ...base, ...over };
}

describe('ADR 0082 §1 — dedicated read-only workday provider', () => {
  it('registers a workday provider pinned to *.workday.com with NO write scope', () => {
    const wd = getProvider('workday');
    expect(wd).toBeTruthy();
    expect(wd?.apiHosts).toContain('workday.com');
    expect(wd?.apiHosts).toContain('myworkday.com');
    expect(wd?.readOnly).toBe(true);
    // Read-only: a read scope group, and NO write group at all (HCM/succession is read).
    expect((wd?.scopes.read ?? []).length).toBeGreaterThan(0);
    expect(wd?.scopes.write).toBeUndefined();
    // The readOnly invariant holds (would throw if a write group were declared).
    expect(() => assertReadOnlyConsistent(wd!)).not.toThrow();
  });
});

describe('ADR 0082 §1 — core.workday.query node', () => {
  beforeAll(() => ensureNodesRegistered());
  const getNode = () => {
    const node = getNodeRegistry().get('core.workday.query');
    expect(node).toBeTruthy();
    return node!;
  };

  it('GETs the tenant REST base, maps {data:[…]} to rows, stamps provenance', async () => {
    let invoked: { url: string; method?: string; authScheme?: string } | null = null;
    const ctx = makeCtx({
      config: { baseUrl: 'https://acme.workday.com/ccx/api/v1/acme_tenant', resource: 'serviceDates', params: { effective: '2026-06-01' }, maxRows: 50 },
      connectors: {
        invoke: async (_id, request) => {
          invoked = { url: request.url, method: request.method, authScheme: request.authScheme };
          return { ok: true, status: 200, data: { data: [{ workerId: 'w1', anniversary: '2016-06-20' }, { workerId: 'w2', anniversary: '2014-06-20' }], total: 2 } };
        },
      },
    });
    const out = await getNode().execute(ctx);
    expect(out.status).toBe('success');
    const o = (out as { outputs: Record<string, unknown> }).outputs;
    expect(o.rowCount).toBe(2);
    expect((o.rows as unknown[]).length).toBe(2);
    expect(o.resource).toBe('serviceDates');
    expect(o.baseUrl).toBe('https://acme.workday.com/ccx/api/v1/acme_tenant');
    // GET, bearer, to the tenant base + resource + the limit/params query.
    expect(invoked!.method).toBe('GET');
    expect(invoked!.authScheme).toBe('bearer');
    expect(invoked!.url).toContain('https://acme.workday.com/ccx/api/v1/acme_tenant/serviceDates?');
    expect(invoked!.url).toContain('limit=50');
    expect(invoked!.url).toContain('effective=2026-06-01');
  });

  it('tolerates a bare-array response body', async () => {
    const ctx = makeCtx({
      config: { baseUrl: 'https://acme.workday.com/x', resource: 'workers' },
      connectors: { invoke: async () => ({ ok: true, data: [{ workerId: 'w1' }] }) },
    });
    const out = await getNode().execute(ctx);
    expect((out as { outputs: Record<string, unknown> }).outputs.rowCount).toBe(1);
  });

  it('fails closed: no connector surface, missing baseUrl, invalid resource, connector error', async () => {
    // no connectors surface
    expect((await getNode().execute(makeCtx({ config: { baseUrl: 'https://acme.workday.com/x', resource: 'workers' } }))).status).toBe('failure');
    // missing baseUrl
    const noBase = await getNode().execute(makeCtx({ config: { resource: 'workers' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(noBase.status).toBe('failure');
    // invalid resource (not in the allowlist)
    const badRes = await getNode().execute(makeCtx({ config: { baseUrl: 'https://acme.workday.com/x', resource: 'salaries' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(badRes.status).toBe('failure');
    expect((badRes as { error: { code: string } }).error.code).toBe('invalid_config');
    // connector error propagates
    const connErr = await getNode().execute(makeCtx({ config: { baseUrl: 'https://acme.workday.com/x', resource: 'workers' }, connectors: { invoke: async () => ({ ok: false, error: 'connector_no_connection' }) } }));
    expect(connErr.status).toBe('failure');
    expect((connErr as { error: { code: string } }).error.code).toBe('connector_no_connection');
  });
});
