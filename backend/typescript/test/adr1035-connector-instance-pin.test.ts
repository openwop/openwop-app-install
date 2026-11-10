/**
 * ADR 1035 D1 — a credential for an instance-scoped provider reaches only the
 * instance its connection is bound to.
 *
 * ServiceNow, Workday, NetSuite, Zendesk and Salesforce pin their API hosts to a
 * suffix every customer shares (`*.service-now.com`), so a caller-chosen URL
 * (a node's `baseUrl`, a pack's `ctx.connectors.invoke`, a `ctx.http.safeFetch`)
 * could carry this tenant's credential to ANOTHER customer's instance. The pin
 * runs inside `resolveConnectionCredential`, before any secret is read: the
 * request origin must equal the origin of the connection's data source.
 *
 * Witnessed without real egress: a test provider pinned to the loopback host is
 * classified instance-scoped (`__setInstanceScopedSuffixesForTests`), and the two
 * "instances" are two loopback servers on different ports (different origins).
 *
 * Sabotage (2026-11-03), each alone then reverted:
 * - skip the pin in `resolveConnectionCredential` (take the precedence pick) →
 *   the mismatch, unbound and safeFetch cases go red (the credential is sent);
 * - drop the `instance_refused` mapping in `connectorInvoker` → mismatch/unbound red;
 * - pick by precedence instead of by origin → the URL-aware selection case red;
 * - drop the brokeredPost refusal → its case red.
 * - empty the sticky builtin ids → the override case red.
 * Re-witnessed w86 grade-tests (2026-11-05): those five plus picking the first
 * bound candidate instead of the origin match, swapping the two refusal codes,
 * dropping safeFetch's refusal branch, dropping the reverse suffix match, and
 * removing `zendesk.com` from the curated suffixes.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createConnectorInvoker } from '../src/host/connectorInvoker.js';
import { makeConnectionSafeFetch } from '../src/host/connectionInjection.js';
import { brokeredPost } from '../src/host/brokeredEgress.js';
import { getProvider, registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection, setConnectionDataSource } from '../src/features/connections/connectionsService.js';
import { __setInstanceScopedSuffixesForTests, apiHostsAreInstanceScoped, isInstanceScopedProvider } from '../src/host/connectorInstancePin.js';

const T = 'adr1035';
let storage: Storage;
const servers: http.Server[] = [];
/** Per server: the Authorization header each request carried. */
const seen: Record<'acme' | 'other', Array<string | undefined>> = { acme: [], other: [] };
let acme = '';
let other = '';

async function listen(name: 'acme' | 'other'): Promise<string> {
  const srv = http.createServer((req, res) => {
    seen[name].push(req.headers.authorization);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

function provider(id: string): void {
  registerProvider({ id, label: id, kind: 'api_key', authFlow: 'manual', reach: 'openapi', scopes: { read: [], write: [] }, refreshable: false, defaultScopes: [], consumerNodes: [], apiHosts: ['127.0.0.1'] });
}

beforeAll(async () => {
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await __resetConnectionsStore();
  acme = await listen('acme');
  other = await listen('other');
  __setInstanceScopedSuffixesForTests(['127.0.0.1']);
  for (const id of ['inst-bound', 'inst-unbound', 'inst-two', 'inst-bearer']) provider(id);
  await storage.insertRun({ runId: 'run-1035', workflowId: 'w', tenantId: T, status: 'running', inputs: null, metadata: {}, configurable: {}, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' });
  // u1's connection, bound to the acme instance.
  const bound = await createSecretConnection({ tenantId: T, provider: 'inst-bound', kind: 'api_key', secret: 'ACME-KEY', scope: 'user', userId: 'u1' });
  await setConnectionDataSource(T, bound.connectionId, acme);
  // A connection with no data source.
  await createSecretConnection({ tenantId: T, provider: 'inst-unbound', kind: 'api_key', secret: 'UNBOUND-KEY', scope: 'user', userId: 'u1' });
  // Two authorized candidates: u1's own bound to acme, the workspace's bound to other.
  const mine = await createSecretConnection({ tenantId: T, provider: 'inst-two', kind: 'api_key', secret: 'MINE-ACME', scope: 'user', userId: 'u1' });
  await setConnectionDataSource(T, mine.connectionId, acme);
  const ws = await createSecretConnection({ tenantId: T, provider: 'inst-two', kind: 'api_key', secret: 'WS-OTHER', scope: 'workspace' });
  await setConnectionDataSource(T, ws.connectionId, other);
  // A bearer connection, so the safeFetch lane would inject it.
  const bearer = await createSecretConnection({ tenantId: T, provider: 'inst-bearer', kind: 'bearer', secret: 'BEARER-ACME', scope: 'user', userId: 'u1' });
  await setConnectionDataSource(T, bearer.connectionId, acme);
}, 120_000);
afterAll(async () => {
  __setInstanceScopedSuffixesForTests(null);
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});
beforeEach(() => { seen.acme = []; seen.other = []; });

const invoke = (provider: string, url: string) => createConnectorInvoker({ storage }).invoke(provider, {
  context: { tenantId: T, runId: 'run-1035', actingUserId: 'u1' },
  request: { url, method: 'POST', body: '{}', authScheme: 'bearer' },
});

describe('ADR 1035 D1 — ctx.connectors (brokeredFetch)', () => {
  it('the bound instance gets the credential', async () => {
    expect(await invoke('inst-bound', `${acme}/api/now/table/incident`)).toMatchObject({ ok: true });
    expect(seen.acme).toEqual(['Bearer ACME-KEY']);
  });

  it('another instance under the same pin is refused, and nothing is sent', async () => {
    expect(await invoke('inst-bound', `${other}/api/now/table/incident`)).toEqual({ ok: false, error: 'connector_instance_mismatch' });
    expect(seen.other).toEqual([]);
  });

  it('a connection with no data source is refused, reads included, and nothing is sent', async () => {
    expect(await invoke('inst-unbound', `${acme}/api/now/table/incident`)).toEqual({ ok: false, error: 'connector_instance_unbound' });
    expect(seen.acme).toEqual([]);
  });

  it('URL-aware selection: the request picks the authorized connection bound to its instance', async () => {
    // Precedence alone would pick u1's own (acme) connection for both.
    expect(await invoke('inst-two', `${other}/x`)).toMatchObject({ ok: true });
    expect(seen.other).toEqual(['Bearer WS-OTHER']);
    expect(await invoke('inst-two', `${acme}/x`)).toMatchObject({ ok: true });
    expect(seen.acme).toEqual(['Bearer MINE-ACME']);
  });
});

describe('ADR 1035 D1 — ctx.http.safeFetch (the injection lane)', () => {
  const safeFetch = () => makeConnectionSafeFetch({ storage, tenantId: T, runId: 'run-1035', actingUserId: 'u1', allowedProviders: ['inst-bearer'] });

  it('injects only for the bound instance, and refuses another instance without sending', async () => {
    await safeFetch()(`${acme}/ok`, { method: 'GET' });
    expect(seen.acme).toEqual(['Bearer BEARER-ACME']);
    await expect(safeFetch()(`${other}/steal`, { method: 'GET' })).rejects.toThrow(/connector_instance_mismatch/);
    expect(seen.other).toEqual([]);
  });
});

describe('ADR 1035 D1 — brokeredPost (fixed adapter URLs) refuses an instance-scoped provider', () => {
  it('never attaches the credential', async () => {
    expect(await brokeredPost({ tenantId: T, actingUserId: 'u1' }, { provider: 'inst-bound', url: `${acme}/fixed`, body: '{}' })).toEqual({ outcome: 'no_connection' });
    expect(seen.acme).toEqual([]);
  });
});

describe('ADR 1035 D1 — classification', () => {
  it('curated suffixes match in both directions; vendor-run hosts do not', () => {
    expect(isInstanceScopedProvider('servicenow')).toBe(true);
    expect(isInstanceScopedProvider('workday')).toBe(true);
    expect(apiHostsAreInstanceScoped(['now.service-now.com'])).toBe(true);
    expect(apiHostsAreInstanceScoped(['salesforce.com'])).toBe(true); // a pin ABOVE my.salesforce.com
    for (const h of ['googleapis.com', 'slack.com', 'graph.microsoft.com', 'box.com', 'zoom.us']) expect(apiHostsAreInstanceScoped([h]), h).toBe(false);
  });

  it('every shipped connection pack on a multi-tenant SaaS suffix is classified', () => {
    const dir = join(__dirname, '..', '..', '..', 'examples', 'connection-packs');
    const classified: string[] = [];
    const dirs = readdirSync(dir);
    let scanned = 0;
    for (const name of dirs) {
      // Two-sided: every pack directory is read and parsed. A missing or broken
      // pack.json fails here rather than silently dropping out of the scan.
      const file = join(dir, name, 'pack.json');
      expect(existsSync(file), `${name} has no pack.json`).toBe(true);
      const pack: unknown = JSON.parse(readFileSync(file, 'utf8'));
      scanned += 1;
      const hosts = JSON.stringify(pack).match(/"apiHosts":\[[^\]]*\]/g)?.flatMap((m) => JSON.parse(m.slice('"apiHosts":'.length)) as string[]) ?? [];
      if (apiHostsAreInstanceScoped(hosts)) classified.push(name);
    }
    expect(scanned).toBe(dirs.length);
    expect(scanned).toBeGreaterThan(4);
    expect(classified.sort()).toEqual(['netsuite', 'salesforce', 'workday', 'zendesk']);
  });

  it('a pack overriding a builtin id cannot drop its classification', () => {
    const builtin = getProvider('servicenow');
    expect(builtin, 'fixture: the builtin servicenow provider is registered').not.toBeNull();
    try {
      registerProvider({ id: 'servicenow', label: 'override', kind: 'api_key', authFlow: 'manual', reach: 'openapi', scopes: { read: [], write: [] }, refreshable: false, defaultScopes: [], consumerNodes: [], apiHosts: ['example.org'] });
      expect(getProvider('servicenow')?.apiHosts).toEqual(['example.org']);
      expect(isInstanceScopedProvider('servicenow')).toBe(true);
    } finally {
      if (builtin) registerProvider(builtin);
    }
  });
});
