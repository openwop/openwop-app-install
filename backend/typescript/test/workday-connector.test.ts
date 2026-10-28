/**
 * ADR 0082 Phase 1 — Workday read-only HCM source connector.
 *
 * Verifies (a) a dedicated read-only `workday` provider pinned to *.workday.com
 * (override-immune; the connection pack carries no apiHosts so it would fail closed),
 * (b) readOnly consistency (no write scope group), and (c) the `core.workday.query` node
 * calls `ctx.connectors` correctly (GET, bearer), maps the Workday `{data:[…]}` collection
 * to rows, stamps deterministic provenance (resource/baseUrl), and fails closed (no
 * connector surface, missing/invalid config, connector error).
 *
 * Sabotage-witnessed (wave 64, probes 8fw5g1-wd-*): read-only flag, the egress pin
 * (wd-apihosts-r2 — now an exact list, so a widened pin is red), the resource
 * allowlist, the rows mapping, the GET method, the connector error code and the
 * no-connectors guard each turn their case red.
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
    // The pin IS the claim: exactly these two eTLD+1s, nothing wider.
    expect(wd?.apiHosts).toEqual(['workday.com', 'myworkday.com']);
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
    expect(out).toEqual({
      status: 'success',
      outputs: {
        rows: [{ workerId: 'w1', anniversary: '2016-06-20' }, { workerId: 'w2', anniversary: '2014-06-20' }],
        rowCount: 2,
        resource: 'serviceDates',
        baseUrl: 'https://acme.workday.com/ccx/api/v1/acme_tenant',
      },
    });
    // GET, bearer, to the tenant base + resource + the limit/params query — the exact URL.
    expect(invoked).toEqual({
      url: 'https://acme.workday.com/ccx/api/v1/acme_tenant/serviceDates?limit=50&effective=2026-06-01',
      method: 'GET',
      authScheme: 'bearer',
    });
  });

  it('tolerates a bare-array response body', async () => {
    const ctx = makeCtx({
      config: { baseUrl: 'https://acme.workday.com/x', resource: 'workers' },
      connectors: { invoke: async () => ({ ok: true, data: [{ workerId: 'w1' }] }) },
    });
    const out = await getNode().execute(ctx);
    expect(out).toEqual({ status: 'success', outputs: { rows: [{ workerId: 'w1' }], rowCount: 1, resource: 'workers', baseUrl: 'https://acme.workday.com/x' } });
  });

  it('fails closed: no connector surface, missing baseUrl, invalid resource, connector error', async () => {
    // no connectors surface
    expect(await getNode().execute(makeCtx({ config: { baseUrl: 'https://acme.workday.com/x', resource: 'workers' } })))
      .toEqual({ status: 'failure', error: { code: 'host_capability_missing', message: 'host.connectors surface is not available.' } });
    // missing baseUrl
    const noBase = await getNode().execute(makeCtx({ config: { resource: 'workers' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(noBase).toMatchObject({ status: 'failure', error: { code: 'invalid_config', message: expect.stringContaining('requires config.baseUrl') } });
    // invalid resource (not in the allowlist)
    const badRes = await getNode().execute(makeCtx({ config: { baseUrl: 'https://acme.workday.com/x', resource: 'salaries' }, connectors: { invoke: async () => ({ ok: true }) } }));
    expect(badRes).toMatchObject({ status: 'failure', error: { code: 'invalid_config', message: expect.stringContaining('requires config.resource') } });
    // connector error propagates
    const connErr = await getNode().execute(makeCtx({ config: { baseUrl: 'https://acme.workday.com/x', resource: 'workers' }, connectors: { invoke: async () => ({ ok: false, error: 'connector_no_connection' }) } }));
    expect(connErr).toMatchObject({ status: 'failure', error: { code: 'connector_no_connection' } });
  });
});
