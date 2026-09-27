/**
 * ADR 0622 D2 — `feature.orgs.nodes.invite` must never re-fire on a `:fork`.
 * The `users-node-replay.test.ts` shape: both LEGS of the classification are
 * asserted independently (the #2871 two-leg lesson — a pack `.mjs` cannot set
 * `module.sideEffecting`, so the manifest declaration and the explicit typeId
 * pattern are two independent paths to the same protection), the DERIVED floor
 * holds it, the fast path SERVES it (floor membership alone is undischarged),
 * and the exact predicate `executor.ts` branches on returns true.
 *
 * What a re-execution on a fork would do, which is why this is not optional: a
 * NEW `inviteId` (a fresh token) minted and emailed through the inviter's
 * brokered connection, SUPERSEDING — killing — the link already in the
 * recipient's inbox, plus a second `host.orgs.invitation.created` a binding
 * would turn into a second run.
 *
 * Also pins the pack's shape: three nodes, `invite` is `side-effect` +
 * `side-effectful`, each node has all THREE schema refs resolving to a file
 * whose `$id` is the ADR 0525 form, the invite output schema is closed and
 * ids-only (`inviteId`, `orgId`, `delivery` — never the token), and the
 * feature's `requiredPacks` pin equals the manifest version.
 *
 * BEHAVIOURAL LEG. Classification is a claim about a mechanism; the last
 * describe RUNS it: a real run of the real pack node over `createApp` mints ONE
 * invitation and sends ONE real (fake-endpoint) email; a `:fork` in replay mode
 * completes WITH the recorded outputs, mints NO second row, sends NO second
 * email, and emits NO second `created`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// `index.js` FIRST: importing a feature module before the app entry evaluates
// `features/index.ts` mid-cycle and leaves a BACKEND_FEATURES slot undefined.
import { createApp } from '../src/index.js';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { orgsFeature } from '../src/features/orgs/feature.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setSenderAddress } from '../src/features/email/emailService.js';
import { listInvitations } from '../src/features/orgs/invitationsService.js';
import { getSetCookies } from './headerCookies.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = join(REPO, 'packs/feature.orgs.nodes');
const INVITE = 'feature.orgs.nodes.invite';
const NODES = [INVITE, 'feature.orgs.nodes.list-invitations', 'feature.orgs.nodes.revoke-invitation'] as const;

interface Manifest {
  name: string;
  version: string;
  nodes: Array<{ typeId: string; role?: string; capabilities?: string[]; configSchemaRef?: string; inputSchemaRef?: string; outputSchemaRef?: string }>;
}
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as Manifest;

describe('ADR 0622 D2 — the invite node is classified, on both legs', () => {
  it('leg 1: the pack manifest declares role side-effect AND the side-effectful capability for `invite`', () => {
    expect(manifest.nodes.map((n) => n.typeId).sort()).toEqual([...NODES].sort());
    const node = manifest.nodes.find((n) => n.typeId === INVITE);
    expect(node, `${INVITE} not found in the manifest — this test would pass vacuously`).toBeTruthy();
    expect(node!.role).toBe('side-effect');
    expect(node!.capabilities ?? []).toContain('side-effectful');
  });

  it('leg 2: sideEffects.ts carries the explicit typeId pattern (independent of the manifest)', () => {
    const src = readFileSync(join(REPO, 'backend/typescript/src/executor/sideEffects.ts'), 'utf8');
    const patterns = /const SIDE_EFFECTING_TYPE_PATTERNS: readonly RegExp\[\] = \[([\s\S]*?)\n\];/.exec(src);
    expect(patterns, 'SIDE_EFFECTING_TYPE_PATTERNS literal not found — this gate is inert').toBeTruthy();
    expect(patterns![1]).toContain(String.raw`/^feature\.orgs\.nodes\.invite$/`);
  });

  it('the derived floor holds invite AND the fast path SERVES it', () => {
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(INVITE), `${INVITE} not in the derived floor`).toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(INVITE), `${INVITE} held but NOT served — undischarged`).toBe(true);
  });

  it('isSideEffectingNode — the exact predicate executor.ts branches on — returns true for invite', () => {
    expect(isSideEffectingNode(INVITE, null)).toBe(true);
  });
});

describe('ADR 0622 D2 — pack shape: schemas with ADR 0525 $ids, closed ids-only invite output, and the feature pin', () => {
  it('every node declares config/input/output schema refs that resolve to files with the <pack>/<version>/<file> $id', () => {
    for (const node of manifest.nodes) {
      for (const key of ['configSchemaRef', 'inputSchemaRef', 'outputSchemaRef'] as const) {
        const ref = node[key];
        expect(ref, `${node.typeId} lacks ${key}`).toBeTruthy();
        const path = join(PACK_DIR, ref!);
        expect(existsSync(path), `${node.typeId} ${key} → ${ref} does not exist`).toBe(true);
        const schema = JSON.parse(readFileSync(path, 'utf8')) as { $id?: string; type?: string };
        expect(schema.$id).toBe(`https://packs.openwop.dev/${manifest.name}/${manifest.version}/${ref!.replace(/^schemas\//, '')}`);
        expect(schema.type).toBe('object');
      }
    }
  });

  it('the invite output is closed and names exactly {inviteId, orgId, delivery} — never the token; no output schema mentions a token', () => {
    const inviteNode = manifest.nodes.find((n) => n.typeId === INVITE)!;
    const out = JSON.parse(readFileSync(join(PACK_DIR, inviteNode.outputSchemaRef!), 'utf8')) as { properties: Record<string, unknown>; additionalProperties?: boolean; required?: string[] };
    expect(Object.keys(out.properties).sort()).toEqual(['delivery', 'inviteId', 'orgId']);
    expect(out.additionalProperties).toBe(false);
    expect(out.required?.sort()).toEqual(['delivery', 'inviteId', 'orgId']);
    for (const node of manifest.nodes) {
      const schema = JSON.parse(readFileSync(join(PACK_DIR, node.outputSchemaRef!), 'utf8')) as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties).join(',')).not.toMatch(/token|email/i);
    }
  });

  it('the orgs feature registers the surface and pins the pack at the manifest version', () => {
    expect(orgsFeature.surface?.id).toBe('orgs');
    expect(orgsFeature.requiredPacks).toEqual([{ name: 'feature.orgs.nodes', version: manifest.version }]);
  });
});

describe('BEHAVIOURAL — a replay :fork is served the recorded outcome and never re-mints', () => {
  let server: http.Server;
  let sg: http.Server;
  let BASE = '';
  let cookie = '';
  let requests: Array<{ body: string }> = [];
  const delivered: HostEventEnvelope[] = [];
  const TENANT = `org:u622-replay-${Date.now()}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  /** Terminal status, with the run's error folded in so a red names the cause. */
  const settleRun = async (runId: string): Promise<string> => {
    let snap: { status?: string; error?: unknown } = {};
    for (let i = 0; i < 200; i++) {
      snap = (await call('GET', `/v1/runs/${runId}`)).body ?? snap;
      if (['completed', 'failed', 'cancelled'].includes(snap.status ?? '')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return snap.status === 'completed' ? 'completed' : `${snap.status}:${JSON.stringify(snap.error)}`;
  };
  const ofType = (t: string) => delivered.filter((e) => e.type === t);

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.replay.test';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_DEMO_MODE;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    await __resetConnectionsStore();
    sg = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => { requests.push({ body: raw }); res.writeHead(202, { 'x-message-id': 'sg-replay-1' }); res.end(); });
    });
    await new Promise<void>((r) => sg.listen(0, '127.0.0.1', r));
    process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sg.address() as AddressInfo).port}`;
    // The surface is toggle-gated at the seam (orgs is OFF by default).
    const def = getToggleDefault('orgs');
    if (def) await saveConfig({ ...def, status: 'on' }, 'test');
    // Observe every emit (the fanout is re-pointed at a capture; bindings are irrelevant here).
    const hostSuite: StartRunDeps['hostSuite'] = {
      workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
      providerPolicyResolver: { resolveForRun: async () => [] },
    };
    initHostEventDispatcher({
      storage: app.locals.storage as Storage,
      hostSuite,
      deliverWebhooks: async (event) => { delivered.push(event); },
      startRun: async () => null,
    });
  });
  afterAll(async () => {
    delete process.env.OPENWOP_SENDGRID_API_BASE;
    delete process.env.OPENWOP_PUBLIC_BASE_URL;
    await new Promise<void>((r) => sg.close(() => r()));
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('live run mints ONE invitation + ONE email + ONE created; the replay fork completes with the RECORDED outputs, mints nothing, sends nothing, emits nothing', async () => {
    // The first login into an explicit, absent workspace FOUNDS and OWNS it —
    // the owner holds host:members:manage at the root org, so the surface's
    // authority check passes; the owner's own brokered connection delivers.
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: 'replay-owner@acme.test', tenantId: TENANT, displayName: 'Rae Owner' });
    expect(login.status).toBe(201);
    const ownerId = login.body.user.userId as string;
    await setSenderAddress(TENANT, TENANT, 'invites@acme.test', 'test');
    await createSecretConnection({ tenantId: TENANT, provider: 'sendgrid', kind: 'api_key', secret: 'SG.replay', scope: 'user', userId: ownerId });

    const workflowId = 'orgs.replay.invite';
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'n1', typeId: INVITE, config: { email: 'newhire@acme.test', role: 'editor' } }], edges: [] });
    const create = await call('POST', '/v1/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    expect(await settleRun(runId)).toBe('completed');
    const afterLive = await listInvitations(TENANT, TENANT);
    expect(afterLive).toHaveLength(1);
    expect(afterLive[0]).toMatchObject({ email: 'newhire@acme.test', role: 'editor', createdBy: ownerId, createdByName: 'Rae Owner' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toContain('https://app.replay.test/invitations/accept?token=');
    await new Promise((r) => setTimeout(r, 15));
    expect(ofType('host.orgs.invitation.created')).toHaveLength(1);
    expect(ofType('host.orgs.invitation.created')[0]!.payload).toMatchObject({ inviteId: afterLive[0]!.inviteId, delivery: 'sent', superseded: false });
    const liveBundle = await call('GET', `/v1/runs/${runId}/debug-bundle`);
    const liveDone = ((liveBundle.body?.events as Array<{ type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown> } }>) ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'n1');
    expect(liveDone?.payload?.outputs).toEqual({ inviteId: afterLive[0]!.inviteId, orgId: TENANT, delivery: 'sent' });

    // Fork in replay mode: the side-effect node must be SERVED its recorded
    // outcome, never re-executed — a re-mint would be a NEW inviteId that
    // supersedes (kills) the link already in the recipient's inbox.
    const before = delivered.length;
    const fork = await call('POST', `/v1/runs/${runId}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(await settleRun(fork.body.runId as string)).toBe('completed');
    const afterFork = await listInvitations(TENANT, TENANT);
    expect(afterFork.map((i) => i.inviteId)).toEqual([afterLive[0]!.inviteId]); // same row, no second mint
    expect(afterFork[0]!.tokenHash).toBe(afterLive[0]!.tokenHash); // the emailed link still resolves
    expect(requests).toHaveLength(1); // no second email
    await new Promise((r) => setTimeout(r, 15));
    expect(delivered.length).toBe(before);
    expect(ofType('host.orgs.invitation.created')).toHaveLength(1);
    // The fork's node completed WITH the recorded outputs.
    const bundle = await call('GET', `/v1/runs/${fork.body.runId}/debug-bundle`);
    const done = ((bundle.body?.events as Array<{ type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown> } }>) ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'n1');
    expect(done?.payload?.outputs).toEqual({ inviteId: afterLive[0]!.inviteId, orgId: TENANT, delivery: 'sent' });
  });
});
