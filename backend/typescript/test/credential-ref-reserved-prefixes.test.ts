/**
 * A run cannot name a system-owned credential ref (ADR 0779 D2, run lane).
 *
 * One tenant secret store holds every secret, including each connection's
 * credential at `connection:<id>`. ADR 0779 D2 refused the system-owned
 * namespaces on the Keys and vault routes, but the RUN lane resolves every ref a
 * workflow names (`node.config.credentialRefs`, `configurable.credentialRefs`)
 * straight into `ctx.secrets`. So a workflow author could name a colleague's
 * `connection:<id>` and read the raw credential, past `connections:use` and the
 * broker. Witnessed on unmodified main (2026-11-03): the node read the
 * colleague's secret and the run completed.
 *
 * Driven through the real routes: the definition lane via
 * `POST /host/openwop-app/workflows` and `POST /runs`, and the run-start lane via
 * `configurable` on `POST /runs`.
 *
 * The HTTP run-start lane was already closed (the v2 `configurable` is closed, and
 * ADR 0712 refuses an `ai.credentialRef` that names no provider); the in-process
 * starters, which build `configurable.credentialRefs` themselves, were not.
 *
 * Sabotage (2026-11-03), each alone then reverted:
 * - skip the refusal in `assertUserNameableRef` → definition, in-process and
 *   namespace cases red (3);
 * - mark `connection:` user-nameable in `USER_NAMEABLE` → the same 3 red;
 * - read a node's refs with plain `resolveSecret` in `prepareRunSecrets` →
 *   definition case and the classification ratchet red (2).
 * Re-measured w85 (each witnessed): the same three; `compat-key:` marked
 * user-nameable → the namespace case; the run-level refs read with plain
 * `resolveSecret` → in-process case + ratchet; a user-named door file
 * (`chatByokConfig.ts`) calling `resolveSecret(` → the ratchet; dropping the ADR
 * 0712 provider check → the HTTP case (its refusal code changes).
 *
 * The HTTP `ai.credentialRef` lane is a DOUBLE guard across two files: ADR 0712's
 * `refNamedProvider` (host/runCredentials.ts) answers `credential_forbidden`
 * first, and `resolveUserNamedSecret` (byok/userNamedSecret.ts) would refuse it
 * next. The definition case carries a positive control (a plain key named the
 * same way DOES reach ctx.secrets), so "never reaches" is not satisfied by a node
 * that reads nothing.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { OWNED_REF_PREFIXES, reservedCredentialRefOwner } from '../src/byok/refNamespaces.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { assertUserNameableRef } from '../src/byok/userNamedSecret.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { executeRun } from '../src/executor/executor.js';
import { registerWorkflow as registerHostWorkflow } from '../src/host/workflowsRegistry.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';
import { stripComments } from './helpers/stripComments.js';
import { declaredPathList, declaredPathTable } from './helpers/featureRatchetTables.js';

const T = 'default';
const SECRET = 'credref-ALICE-servicenow-key-0001';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
let server: http.Server;
let BASE = '';
let storage: Storage;
let aliceRef = '';
/** What the probe node read from `ctx.secrets` on its last execution. */
let seen: string | null | undefined;
const prevEnv = { dsn: process.env.OPENWOP_STORAGE_DSN, cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES };
const CONTROL_REF = 'byok:credref-control';
const CONTROL_SECRET = 'credref-control-plain-key-0002';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  getNodeRegistry().register({
    typeId: 'test.credref.read', version: '1.0.0', sideEffecting: false,
    async execute(ctx) {
      const ref = String((ctx.config as { ref?: unknown } | undefined)?.ref ?? '');
      seen = ctx.secrets[ref] ?? null;
      return { status: 'success', outputs: {} };
    },
  });
  // Alice's OWN connection: user-scoped, so nobody else may use it.
  const c = await createSecretConnection({ tenantId: T, provider: 'servicenow', kind: 'api_key', secret: SECRET, scope: 'user', userId: 'alice' });
  aliceRef = `connection:${c.connectionId}`;
  // A plain Keys-page key: the positive control that a user-named ref DOES resolve.
  await setSecret(CONTROL_REF, CONTROL_SECRET, { tenantId: T });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  if (prevEnv.dsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = prevEnv.dsn;
  if (prevEnv.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = prevEnv.cookies;
});

/** Waits (bounded) for the run row to reach a terminal state; no hook exists to await. */
async function waitTerminal(runId: string): Promise<{ status: string; error?: { code?: string; message?: string } }> {
  return vi.waitFor(async () => {
    const r = await storage.getRun(runId);
    if (!r || !['completed', 'failed', 'cancelled'].includes(r.status)) throw new Error(`run ${runId} is not terminal yet (${r?.status ?? 'missing'})`);
    return { status: r.status, ...(r.error ? { error: { code: r.error.code, message: r.error.message } } : {}) };
  }, { timeout: 5_000, interval: 20 });
}
const bare = (id: string): string => id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;

describe('ADR 0779 D2, run lane — a workflow cannot read a system-owned credential ref', () => {
  it('definition lane: a node naming a colleague\'s connection:<id> is refused, and the secret never reaches ctx.secrets', async () => {
    const workflowId = `wf.credref.def.${Date.now()}`;
    const reg = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n', typeId: 'test.credref.read', config: { credentialRefs: [aliceRef], ref: aliceRef } }], edges: [] }),
    });
    expect(reg.status, await reg.clone().text()).toBe(201);
    seen = undefined;
    const start = await fetch(`${BASE}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId, inputs: {} }) });
    const body = (await start.json()) as { runId?: string };
    expect([200, 201, 202], JSON.stringify(body)).toContain(start.status);
    const end = await waitTerminal(bare(body.runId ?? ''));
    expect(seen, 'the colleague\'s secret reached ctx.secrets').not.toBe(SECRET);
    expect(end).toMatchObject({ status: 'failed', error: { code: 'credential_ref_reserved' } });

    // Positive control: the same node, naming a plain key the same way, DOES read it.
    const controlId = `wf.credref.ctl.${Date.now()}`;
    const ctl = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ workflowId: controlId, nodes: [{ nodeId: 'n', typeId: 'test.credref.read', config: { credentialRefs: [CONTROL_REF], ref: CONTROL_REF } }], edges: [] }),
    });
    expect(ctl.status, await ctl.clone().text()).toBe(201);
    seen = undefined;
    const ctlStart = await fetch(`${BASE}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId: controlId, inputs: {} }) });
    const ctlBody = (await ctlStart.json()) as { runId?: string };
    expect(await waitTerminal(bare(ctlBody.runId ?? ''))).toMatchObject({ status: 'completed' });
    expect(seen, 'a plain user-named key reaches ctx.secrets').toBe(CONTROL_SECRET);
  });

  it('run-start lane over HTTP: the v2 configurable cannot carry credentialRefs, and ai.credentialRef cannot name a connection', async () => {
    const workflowId = `wf.credref.cfg.${Date.now()}`;
    const reg = await fetch(`${BASE}/host/openwop-app/workflows`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'n', typeId: 'test.credref.read', config: { ref: aliceRef } }], edges: [] }),
    });
    expect(reg.status, await reg.clone().text()).toBe(201);
    seen = undefined;
    const refs = await fetch(`${BASE}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId, inputs: {}, configurable: { version: 1, credentialRefs: [aliceRef] } }) });
    // Closed v2 configurable: `credentialRefs` is not a legal key. The `ai` request
    // below carries the same `version: 1` base and passes this check, so it is the
    // extra key that is refused, not the envelope.
    const refsBody = (await refs.json()) as { error?: string; message?: string };
    expect(refs.status, JSON.stringify(refsBody)).toBe(400);
    expect(refsBody.error).toBe('validation_error');
    expect(refsBody.message).toMatch(/^configurable is not valid under the v2 contract: .*additional properties/);
    const ai = await fetch(`${BASE}/runs`, { method: 'POST', headers: H, body: JSON.stringify({ workflowId, inputs: {}, configurable: { version: 1, ai: { credentialRef: aliceRef } } }) });
    const aiBody = await ai.text();
    expect(ai.status, aiBody).toBe(403);
    // Already closed before this fix: the ADR 0712 admission refuses a ref that names no provider.
    expect(aiBody).toMatch(/credential_forbidden/);
    expect(seen, 'no run started, so nothing was read').toBeUndefined();
  });

  it('in-process starters: a run whose configurable names connection:<id> fails typed before any node', async () => {
    // Host starters build `configurable.credentialRefs` themselves (byokRunConfigurable,
    // the agent-mention and Factory lanes) from refs a user picked, so the run lane
    // must refuse it whatever started the run.
    const workflowId = `wf.credref.inproc.${Date.now()}`;
    const def: WorkflowDefinition = { workflowId, nodes: [{ nodeId: 'n', typeId: 'test.credref.read', config: { ref: aliceRef } }], edges: [] };
    registerHostWorkflow(def);
    const now = new Date().toISOString();
    const run: RunRecord = { runId: `r-credref-${Date.now()}`, workflowId, tenantId: T, status: 'pending', inputs: {}, metadata: { actingUserId: 'bob' }, configurable: { credentialRefs: [aliceRef] }, createdAt: now, updatedAt: now };
    await insertRunWithStartContext(storage, run, { admission: { plan: 'exempt:test-fixture' } });
    seen = undefined;
    expect((await executeRun(storage, (await storage.getRun(run.runId)) ?? run, def)).status).toBe('failed');
    expect(seen, 'no node ran').toBeUndefined();
    expect((await storage.getRun(run.runId))?.error).toMatchObject({ code: 'credential_ref_reserved' });
  });
});

describe('ADR 0779 D2, run lane — which namespaces a user may name', () => {
  it('refuses every namespace another lifecycle owns, and allows subscription:, managed: and plain keys', () => {
    for (const ref of ['connection:abc', 'connection-inbound:abc', 'compat-key:abc', 'pm-peer:abc', 'email-webhook:abc']) {
      expect(reservedCredentialRefOwner(ref), ref).not.toBeNull();
      expect(() => assertUserNameableRef(ref), ref).toThrow(expect.objectContaining({ code: 'credential_ref_reserved', httpStatus: 403 }));
    }
    for (const ref of ['subscription:anthropic', 'managed:openwop-free', 'byok:google', 'google', 'xconnection:abc']) {
      expect(reservedCredentialRefOwner(ref), ref).toBeNull();
    }
    // Pinned to the SSoT: of every owned prefix, exactly these two are user-nameable,
    // so a new owner (or a flipped flag) cannot become nameable unnoticed.
    const nameable = Object.values(OWNED_REF_PREFIXES).filter((p) => reservedCredentialRefOwner(`${p}abc`) === null).sort();
    expect(nameable).toEqual(['managed:', 'subscription:']);
    const owned = Object.values(OWNED_REF_PREFIXES).filter((p) => p !== 'managed:' && p !== 'subscription:');
    expect(owned.length, 'positive control: some owned prefixes are reserved').toBeGreaterThan(0);
    for (const p of owned) expect(() => assertUserNameableRef(`${p}abc`), p).toThrow(expect.objectContaining({ code: 'credential_ref_reserved', httpStatus: 403 }));
    for (const p of ['managed:', 'subscription:']) expect(() => assertUserNameableRef(`${p}abc`), p).not.toThrow();
  });
});

/** Every non-test file that calls `resolveSecret(`, and why its ref is not user-named.
 *  A USER-named ref goes through `resolveUserNamedSecret` instead (USER_NAMED). */
const HOST_BUILT: Record<string, string> = {
  'byok/secretResolver.ts': 'the resolver itself',
  'byok/userNamedSecret.ts': 'the user-named door, after its refusal',
  'byok/subscriptionCredential.ts': 'owner: subscription:<provider>',
  'bootstrap/nodes.ts': 'conformance.secret.echo, canary allowlist only',
  'bootstrap/conformanceMemoryProbe.ts': 'canary allowlist only',
  'features/billing/routes.ts': 'host-global Stripe key',
  'features/commerce-connect/onboarding.ts': 'host-global Stripe key',
  'features/commerce-connect/orders.ts': 'host-global Stripe key',
  'features/commerce-connect/storefrontSettlement.ts': 'host-global Stripe key',
  'features/commerce-connect/stores.ts': 'host-global Stripe key',
  'features/commerce/commerceService.ts': 'host-global Stripe key',
  'features/commerce/routes.ts': 'host-global Stripe key and webhook secret',
  'features/commerce/subscriptions.ts': 'host-global Stripe key',
  'routes/account.ts': 'host-global Stripe key',
  'features/connections/connectionsService.ts': 'owner: connection:<id> (the broker)',
  'features/connections/inboundWebhooks.ts': 'owner: connection-inbound:<id>',
  'features/email/bounceWebhooks.ts': 'owner: email-webhook:<id>',
  'features/priority-matrix/federationService.ts': 'owner: pm-peer:<id>',
  'host/compatEndpoints.ts': 'the endpoint\'s own minted compat-key:<id>',
  'host/mcpOperatorServer.ts': 'operator config (env)',
  'host/webResearchSurface.ts': 'host-named web-search ref',
  'host/workloadIdentity.ts': 'host-named salt ref',
  'providers/managedProvider.ts': 'owner: the managed tier vault ref',
  'routes/adminVault.ts': 'superadmin vault, guarded by systemOwnedRefOwner',
  // ADR 1031 P2 — feature-owned rows live in `<feature>/ratchetTables.json`.
  ...declaredPathTable<string>('adr0779.hostBuiltSecretReaders'),
};
/** Files that resolve a USER-named ref: they call only `resolveUserNamedSecret`. */
const USER_NAMED = [
  'executor/executor.ts', 'routes/runs.ts', 'host/runCredentials.ts', 'host/chatByokConfig.ts',
  'host/conversationToolLoop.ts', 'host/exchange/dispatchTurn.ts', 'host/headlessAi.ts', 'host/promptCompose.ts',
  'features/media/imageGenRoutes.ts', 'features/voice/routes.ts', 'features/voice/realtime/routes.ts',
  'features/chat-widget/widgetCredential.ts', 'features/campaign-ops/agentBindingService.ts',
  // ADR 1031 P2 — feature-owned rows live in `<feature>/ratchetTables.json`.
  ...declaredPathList('adr0779.userNamedSecretReaders'),
];

describe('ADR 0779 D2, run lane — every secret read is classified', () => {
  const SRC = join(__dirname, '..', 'src');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
    }
    return out;
  };
  const files = walk(SRC).map((f) => ({ rel: relative(SRC, f).split('\\').join('/'), code: stripComments(readFileSync(f, 'utf8')) }));

  it('every resolveSecret( caller is host-built, and every user-named lane uses the door', () => {
    const direct = files.filter((f) => /\bresolveSecret\s*\(/.test(f.code)).map((f) => f.rel).sort();
    expect(direct.filter((f) => !(f in HOST_BUILT)), 'a new resolveSecret( caller: is its ref user-named? Use resolveUserNamedSecret, or classify it in HOST_BUILT').toEqual([]);
    expect(Object.keys(HOST_BUILT).filter((f) => !direct.includes(f)), 'a classified file stopped calling resolveSecret(: drop it').toEqual([]);
    const door = files.filter((f) => /\bresolveUserNamedSecret\s*\(/.test(f.code) && f.rel !== 'byok/userNamedSecret.ts').map((f) => f.rel).sort();
    expect(door).toEqual([...USER_NAMED].sort());
  });
});
