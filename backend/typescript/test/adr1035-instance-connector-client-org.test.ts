/**
 * ADR 1035 D2 — in a client-stamped run, an instance-scoped provider is served
 * only by the CLIENT org's connection, whoever calls.
 *
 * `ctx.connectors` builds its broker context with `orgId: run.tenantId`, so a run
 * for client A used the acting person's own connection or the workspace's, never
 * the client's: a ticket, a time-off request or a vendor bill for client A landed
 * in whichever vendor instance those credentials reach. The adapter now decides
 * it HOST-side: for an instance-scoped provider (ADR 1035 D1's classification) in
 * a client-stamped run, it reads the stamp itself and selects that org's
 * connection only, still behind `connections:use`, with no fall-through. The
 * caller passes nothing, so a pack cannot opt out. Non-instance-scoped providers
 * and unstamped runs are unchanged.
 *
 * The write is driven by a pack-like node inside a real run, calling
 * `ctx.connectors.invoke` with no flag of any kind.
 *
 * Sabotage (2026-11-03), each alone then reverted:
 * - ignore `orgOnly` in `authorizedCandidates` → the client-A and
 *   no-fall-through cases red (the user's own connection is used);
 * - skip the stamp read in `invoke` (treat every run as unstamped) → the
 *   client-A, no-fall-through and two-client cases red;
 * - put a client's instance-scoped providers back through the plain resolution
 *   in `forRun` → the capability case red.
 * Also measured by probe (w87): skipping the `connections:use` check on the
 * client org's row → the no-fall-through case (client B); ignoring the
 * two-client refusal (in `invoke` or in `runClientStamp`) → the two-client case;
 * treating every provider as instance-scoped → the "unchanged" case; dropping
 * `orgOnly` or the non-instance filter in `forRun`, or putting the client's own
 * providers last → the capability case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createMember, createOrg } from '../src/host/accessControlService.js';
import { makeConnectorsAdapter } from '../src/host/connectorsAdapter.js';
import { __setInstanceScopedSuffixesForTests } from '../src/host/connectorInstancePin.js';
import { registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection, setConnectionDataSource } from '../src/features/connections/connectionsService.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const T = 'adr1035-d2';
const PACK_NODE = 'test.pack.connector-write';
let storage: Storage;
let server: http.Server;
let inst = '';
let plainBase = '';
let auths: Array<string | undefined> = [];
let lastResult: { ok: boolean; error?: string } | null = null;
let orgA = '';
let orgB = '';
let orgC = '';
let n = 0;

const stamp = (orgId: string) => ({ 'openwop-app.campaignOps': { orgId } });

/** A third-party pack: `ctx.connectors.invoke` with a URL of its choosing, no flags. */
async function viaPack(metadata: Record<string, unknown>, provider: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const workflowId = `wf.adr1035-d2.${n++}`;
  const def: WorkflowDefinition = { workflowId, nodes: [{ nodeId: 'p', typeId: PACK_NODE, config: { provider, url } }], edges: [] };
  registerHostWorkflow(def);
  const now = new Date().toISOString();
  const run: RunRecord = { runId: `r-d2-${n}`, workflowId, tenantId: T, status: 'pending', inputs: {}, metadata: { actingUserId: 'u1', ...metadata }, configurable: {}, createdAt: now, updatedAt: now };
  await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
  lastResult = null;
  await executeRun(storage, (await storage.getRun(run.runId)) ?? run, def);
  if (!lastResult) throw new Error('the pack node never ran');
  return lastResult;
}

async function insertRun(runId: string, metadata: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  await storage.insertRun({ runId, workflowId: 'w', tenantId: T, status: 'running', inputs: null, metadata, configurable: {}, createdAt: now, updatedAt: now });
}

beforeAll(async () => {
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await __resetConnectionsStore();
  server = http.createServer((req, res) => { auths.push(req.headers.authorization); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  inst = `http://127.0.0.1:${port}`;
  plainBase = `http://localhost:${port}`;
  // 127.0.0.1 stands in for a vendor's shared suffix; `localhost` is a vendor-run host.
  __setInstanceScopedSuffixesForTests(['127.0.0.1']);
  const manifest = { kind: 'api_key' as const, authFlow: 'manual' as const, reach: 'openapi' as const, category: 'ticketing', scopes: { read: [], write: [] }, refreshable: false, defaultScopes: [], consumerNodes: [] };
  registerProvider({ ...manifest, id: 'd2-inst', label: 'd2-inst', apiHosts: ['127.0.0.1'] });
  registerProvider({ ...manifest, id: 'd2-plain', label: 'd2-plain', apiHosts: ['localhost'] });
  getNodeRegistry().register({
    typeId: PACK_NODE, version: '1.0.0',
    async execute(ctx) {
      const cfg = ctx.config as { provider: string; url: string };
      const r = await ctx.connectors!.invoke(cfg.provider, { url: cfg.url, method: 'POST', body: '{}', authScheme: 'bearer' });
      lastResult = { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
      return { status: 'success', outputs: {} };
    },
  });
  orgA = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client A', ownerSubject: 'u-owner' })).orgId;
  orgB = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client B', ownerSubject: 'u-owner' })).orgId;
  orgC = (await createOrg({ tenantId: T, createdBy: 'u-owner', name: 'Client C', ownerSubject: 'u-owner' })).orgId;
  await createMember({ tenantId: T, orgId: orgA, subject: 'u1', displayName: 'u1', roles: ['admin'] }); // connections:use in A
  await createMember({ tenantId: T, orgId: orgB, subject: 'u1', displayName: 'u1', roles: ['editor'] }); // none in B
  // Every candidate the precedence pick could reach, each bound to the instance.
  for (const [secret, scope] of [['U1-OWN', { scope: 'user', userId: 'u1' }], ['WORKSPACE', { scope: 'workspace' }], ['ORG-A', { scope: 'org', orgId: orgA }], ['ORG-B', { scope: 'org', orgId: orgB }]] as const) {
    const c = await createSecretConnection({ tenantId: T, provider: 'd2-inst', kind: 'api_key', secret, ...scope });
    await setConnectionDataSource(T, c.connectionId, inst);
  }
  await createSecretConnection({ tenantId: T, provider: 'd2-plain', kind: 'api_key', secret: 'PLAIN-U1', scope: 'user', userId: 'u1' });
  for (const [id, meta] of [['run-a', stamp(orgA)], ['run-c', stamp(orgC)], ['run-plain', {}]] as const) await insertRun(id, { actingUserId: 'u1', ...meta });
});
afterAll(async () => {
  __setInstanceScopedSuffixesForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => { auths = []; });

describe('ADR 1035 D2 — a pack writing through ctx.connectors with no flag', () => {
  it('a run for client A is narrowed to client A\'s connection', async () => {
    expect(await viaPack(stamp(orgA), 'd2-inst', `${inst}/x`)).toEqual({ ok: true });
    expect(auths).toEqual(['Bearer ORG-A']);
  });

  it('no fall-through: a client with no usable connection gets none, and nothing is sent', async () => {
    expect(await viaPack(stamp(orgC), 'd2-inst', `${inst}/x`), 'client C has no connection').toEqual({ ok: false, error: 'connector_no_connection' });
    expect(await viaPack(stamp(orgB), 'd2-inst', `${inst}/x`), 'u1 lacks connections:use in client B').toEqual({ ok: false, error: 'connector_no_connection' });
    expect(auths).toEqual([]);
  });

  it('a stamp naming two clients is refused, and nothing is sent', async () => {
    expect(await viaPack({ 'openwop-app.campaignOps': { orgId: orgA }, campaignOrchestration: { orgId: orgB } }, 'd2-inst', `${inst}/x`))
      .toEqual({ ok: false, error: 'connector_client_org_unreadable' });
    expect(auths).toEqual([]);
  });

  it('unchanged: an unstamped run, and a non-instance-scoped provider in a client run', async () => {
    expect(await viaPack({}, 'd2-inst', `${inst}/x`)).toEqual({ ok: true });
    expect(await viaPack(stamp(orgA), 'd2-plain', `${plainBase}/x`)).toEqual({ ok: true });
    expect(auths).toEqual(['Bearer U1-OWN', 'Bearer PLAIN-U1']);
  });
});

describe('ADR 1035 D2 — capability resolution follows the same rule', () => {
  const adapter = (runId: string) => makeConnectorsAdapter({ storage, tenantId: T, runId, actingUserId: 'u1', orgId: T });

  it('a client run sees its own instance-scoped connection first, and the plain providers as before', async () => {
    expect(await adapter('run-a').resolveAllForCapability('ticketing')).toEqual(['d2-inst', 'd2-plain']);
    expect(await adapter('run-c').resolveAllForCapability('ticketing'), 'client C: no instance-scoped connection of its own').toEqual(['d2-plain']);
    expect(await adapter('run-c').resolveForCapability('ticketing')).toBe('d2-plain');
    expect((await adapter('run-plain').resolveAllForCapability('ticketing')).sort()).toEqual(['d2-inst', 'd2-plain']);
  });
});
