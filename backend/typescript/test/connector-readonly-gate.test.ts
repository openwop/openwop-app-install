/**
 * ADR 0076 Phase 3 — host-side read-only connector gate (defense-in-depth).
 *
 * The gate (in connectorInvoker) fails closed on PUT/PATCH/DELETE for a `readOnly`
 * provider, BEFORE any credential is resolved — but is permissive to GET/POST (a
 * read POST like BigQuery jobs.query must pass). Plus the config invariant: a
 * readOnly provider must not declare a write scope group.
 */

import { describe, expect, it } from 'vitest';
import { getProvider, assertReadOnlyConsistent, type ProviderManifest } from '../src/features/connections/providerRegistry.js';
import { createConnectorInvoker } from '../src/host/connectorInvoker.js';

// Minimal storage stub — the gate returns before any storage access on a denied verb,
// and a read POST fails earlier at connection resolution (no connection) which proves
// the gate did NOT block it.
const storage = {} as Parameters<typeof createConnectorInvoker>[0]['storage'];
const invoker = createConnectorInvoker({ storage });
const ctx = { tenantId: 'demo', runId: 'r1', actingUserId: 'u1', orgId: 'demo' };

describe('ADR 0076 §3 — provider read-only flags', () => {
  it('bigquery is readOnly; microsoft-graph (drafts) is not', () => {
    expect(getProvider('bigquery')?.readOnly).toBe(true);
    expect(getProvider('microsoft-graph')?.readOnly).toBeFalsy();
  });

  it('invariant: a readOnly provider with a write scope group throws', () => {
    const bad: ProviderManifest = {
      id: 'x', label: 'X', kind: 'oauth2', authFlow: 'pkce', reach: 'openapi', readOnly: true,
      scopes: { read: [], write: [{ key: 'w', label: 'w', scopes: ['x'] }] },
      refreshable: false, defaultScopes: [], consumerNodes: [],
    };
    expect(() => assertReadOnlyConsistent(bad)).toThrow(/MUST NOT declare a write scope/);
    // The real bigquery builtin passes the invariant.
    expect(() => assertReadOnlyConsistent(getProvider('bigquery')!)).not.toThrow();
  });
});

describe('ADR 0076 §3 — connectorInvoker read-only gate', () => {
  it('denies PUT/PATCH/DELETE on a readOnly provider with connector_read_only', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const r = await invoker.invoke('bigquery', { context: ctx, request: { url: 'https://bigquery.googleapis.com/x', method } });
      expect(r).toEqual({ ok: false, error: 'connector_read_only' });
    }
  });

  it('ALLOWS POST on a readOnly provider (read-via-POST) — control reaches PAST the gate', async () => {
    // A DENIED verb RESOLVES with connector_read_only. POST is allowed, so it proceeds
    // into the broker — which (with persistence uninitialized in this unit) THROWS
    // downstream. The throw proves the read-only gate did not block POST.
    await expect(
      invoker.invoke('bigquery', { context: ctx, request: { url: 'https://bigquery.googleapis.com/x', method: 'POST' } }),
    ).rejects.toThrow(/persistence not initialized/);
  });

  it('ALLOWS an absent method (defaults GET) on a readOnly provider — reaches PAST the gate', async () => {
    await expect(
      invoker.invoke('bigquery', { context: ctx, request: { url: 'https://bigquery.googleapis.com/x' } }),
    ).rejects.toThrow(/persistence not initialized/);
  });
});
