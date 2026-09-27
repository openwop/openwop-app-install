/**
 * ADR 0617 D2 — `feature.users.nodes.{deactivate,reactivate}` must never
 * re-fire on a `:fork`. The `comments-node-replay.test.ts` shape: both LEGS of
 * the classification are asserted independently (the #2871 two-leg lesson — a
 * pack `.mjs` cannot set `module.sideEffecting`, so the manifest declaration and
 * the explicit typeId pattern are two independent paths to the same protection),
 * plus the DERIVED floor holds them, the fast path SERVES them (floor membership
 * alone is undischarged), and the exact predicate `executor.ts` branches on
 * returns true.
 *
 * What a re-execution on a fork would do, which is why this is not optional: an
 * unrecorded authz decision + status write against LIVE identity (an epoch bump
 * that ends sessions), and — if the target had been re-enabled in between — a
 * second `host.users.user.deactivated` event starting a second offboarding run.
 *
 * Also pins the pack's shape: two nodes, both `side-effect` + `side-effectful`,
 * each with all THREE schema refs resolving to a file whose `$id` is the ADR 0525
 * form (`NP-CMS-2`'s no-schema shape is not repeated here), and the feature's
 * `requiredPacks` pin equals the manifest version.
 *
 * BEHAVIOURAL LEG (review SHOULD-1). Classification is a claim about a mechanism;
 * the last describe RUNS it: a real run of the real pack node over `createApp`
 * disables the target; the target is re-enabled; a `:fork` in replay mode is
 * served the recorded outcome — the target STAYS active and no second
 * `host.users.user.deactivated` leaves the emitter. (`comments-node-replay`
 * deliberately stops short of this — its live probe is `PROBE-CMNT-3`.)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// `index.js` FIRST: importing a feature module before the app entry evaluates
// `features/index.ts` mid-cycle and leaves a BACKEND_FEATURES slot undefined
// (createApp → featurePackRefs then throws on `.requiredPacks`).
import { createApp } from '../src/index.js';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { usersFeature } from '../src/features/users/feature.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { createUser, getUser, sessionEpochOf, setUserStatus } from '../src/features/users/usersService.js';
import { getSetCookies } from './headerCookies.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = join(REPO, 'packs/feature.users.nodes');
const NODES = ['feature.users.nodes.deactivate', 'feature.users.nodes.reactivate'] as const;

interface Manifest {
  name: string;
  version: string;
  nodes: Array<{ typeId: string; role?: string; capabilities?: string[]; configSchemaRef?: string; inputSchemaRef?: string; outputSchemaRef?: string }>;
}
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as Manifest;

describe('ADR 0617 D2 — both users lifecycle nodes are classified, on both legs', () => {
  it('leg 1: the pack manifest declares role side-effect AND the side-effectful capability for BOTH nodes', () => {
    expect(manifest.nodes.map((n) => n.typeId).sort()).toEqual([...NODES].sort());
    for (const id of NODES) {
      const node = manifest.nodes.find((n) => n.typeId === id);
      expect(node, `${id} not found in the manifest — this test would pass vacuously`).toBeTruthy();
      expect(node!.role).toBe('side-effect');
      expect(node!.capabilities ?? []).toContain('side-effectful');
    }
  });

  it('leg 2: sideEffects.ts carries the explicit typeId pattern (independent of the manifest)', () => {
    const src = readFileSync(join(REPO, 'backend/typescript/src/executor/sideEffects.ts'), 'utf8');
    const patterns = /const SIDE_EFFECTING_TYPE_PATTERNS: readonly RegExp\[\] = \[([\s\S]*?)\n\];/.exec(src);
    expect(patterns, 'SIDE_EFFECTING_TYPE_PATTERNS literal not found — this gate is inert').toBeTruthy();
    expect(patterns![1]).toContain(String.raw`/^feature\.users\.nodes\.(deactivate|reactivate)$/`);
  });

  it('the derived floor holds both AND the fast path SERVES both', () => {
    for (const id of NODES) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} not in the derived floor`).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id), `${id} held but NOT served — undischarged`).toBe(true);
    }
  });

  it('isSideEffectingNode — the exact predicate executor.ts branches on — returns true for both', () => {
    for (const id of NODES) expect(isSideEffectingNode(id, null)).toBe(true);
  });
});

describe('ADR 0617 D2 — pack shape: schemas with ADR 0525 $ids, and the feature pin', () => {
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

  it('outputs are ids-only: the output schema is closed and names exactly {userId, status}', () => {
    for (const node of manifest.nodes) {
      const out = JSON.parse(readFileSync(join(PACK_DIR, node.outputSchemaRef!), 'utf8')) as { properties: Record<string, unknown>; additionalProperties?: boolean; required?: string[] };
      expect(Object.keys(out.properties).sort()).toEqual(['status', 'userId']);
      expect(out.additionalProperties).toBe(false);
      expect(out.required?.sort()).toEqual(['status', 'userId']);
    }
  });

  it('the users feature registers the surface and pins the pack at the manifest version', () => {
    expect(usersFeature.surface?.id).toBe('users');
    expect(usersFeature.requiredPacks).toEqual([{ name: 'feature.users.nodes', version: manifest.version }]);
  });
});

describe('BEHAVIOURAL (review SHOULD-1) — a replay :fork is served the recorded outcome and never re-runs the status write', () => {
  let server: http.Server;
  let BASE = '';
  let cookie = '';
  const delivered: HostEventEnvelope[] = [];
  const TENANT = `org:u617-replay-${Date.now()}`;
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
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_DEMO_MODE;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('live run disables the target (one deactivated event); after a re-enable, the replay fork leaves it ACTIVE and emits nothing', async () => {
    // The first login into an explicit, absent workspace FOUNDS and OWNS it —
    // the owner holds host:members:manage, so the node's authority check passes.
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: 'replay-owner@acme.test', tenantId: TENANT });
    expect(login.status).toBe(201);
    const target = await createUser({ tenantId: TENANT, principalId: 'oidc:u617-replay-target', source: 'manual' }, { silent: true });

    const workflowId = 'users.replay.deactivate';
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'n1', typeId: 'feature.users.nodes.deactivate', config: { userId: target.userId } }], edges: [] });
    const create = await call('POST', '/v1/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    expect(await settleRun(runId)).toBe('completed');
    const afterLive = (await getUser(target.userId))!;
    expect(afterLive.status).toBe('disabled');
    expect(sessionEpochOf(afterLive)).toBe(1);
    await new Promise((r) => setTimeout(r, 15));
    expect(ofType('host.users.user.deactivated')).toHaveLength(1);
    expect(ofType('host.users.user.deactivated')[0]!.payload).toMatchObject({ userId: target.userId, reason: 'workflow' });

    // Re-enable, then fork in replay mode: the side-effect node must be SERVED
    // its recorded outcome, never re-executed against live identity.
    await setUserStatus(target.userId, 'active', { reason: 'admin' });
    await new Promise((r) => setTimeout(r, 15));
    const before = delivered.length;
    const fork = await call('POST', `/v1/runs/${runId}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(await settleRun(fork.body.runId as string)).toBe('completed');
    const afterFork = (await getUser(target.userId))!;
    expect(afterFork.status).toBe('active');
    expect(sessionEpochOf(afterFork)).toBe(1); // no second epoch bump either
    await new Promise((r) => setTimeout(r, 15));
    expect(delivered.length).toBe(before);
    expect(ofType('host.users.user.deactivated')).toHaveLength(1);
    // The fork's node completed WITH the recorded (disabled) outputs.
    const bundle = await call('GET', `/v1/runs/${fork.body.runId}/debug-bundle`);
    const done = ((bundle.body?.events as Array<{ type: string; nodeId?: string; payload?: { outputs?: Record<string, unknown> } }>) ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'n1');
    expect(done?.payload?.outputs).toEqual({ userId: target.userId, status: 'disabled' });
  });
});
