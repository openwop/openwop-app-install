/**
 * ADR 0627 D1 — the 13 `feature.crm.nodes` WRITE nodes must never re-execute on
 * a `mode:'replay'` fork. The `users-node-replay.test.ts` shape.
 *
 * WHY (CRMWF-1): at 1.9.0 the 13 write nodes were `role:"action"` with no
 * `side-effectful` capability, so only `gmail-sync` sat in the derived floor.
 * The executor's fork branch re-executed the others live, and the pack's
 * `idFor = <prefix>:<runId>:<nodeId>` keyed on the FORK's runId — so a replay
 * fork of `crm-ops.route-new-lead` minted a SECOND follow-up task, and a fork of
 * `sign-request` re-created an e-sign request (emailing the signers). The pack
 * header claimed "fork-safe — no re-mint". `idFor` is a PER-RUN dedupe key; the
 * classification is the guard, and this file asserts the guard on every leg.
 *
 * Legs:
 *   1. the manifest declares `side-effect` + `side-effectful` for all 13 (and
 *      ONLY those: the 9 reads stay `action`, the 4 pure nodes `pure`);
 *   2. the derived floor holds them AND the fast path SERVES them (membership
 *      alone is undischarged — ADR 0572);
 *   3. `isSideEffectingNode` — the exact predicate `executor.ts` branches on —
 *      returns true for each;
 *   4. pack shape: input + output schemas resolve with the ADR 0525 `$id`, inputs
 *      declare NO `required` (the node reads `{...config, ...inputs}`, so a
 *      required INPUT would be a false claim the chain-conformance ceiling
 *      counts), outputs are closed and require `success`; the feature pin equals
 *      the manifest version;
 *   5. BEHAVIOURAL: a real run of `create-task` through `createApp` creates ONE
 *      task; a `:fork` in replay mode is served the recorded outcome — still ONE
 *      task, and the fork's node completed with the SOURCE run's outputs (the
 *      source run's `task:<runId>:n1` id, not a `task:<forkRunId>:n1`).
 *
 * BORN RED: with the 1.9.0 `action` role this last leg fails at "still ONE task"
 * — the fork re-executes `create-task` under its own runId and a second row
 * appears. Verified by flipping the role back (the sabotage pass in the ADR's
 * P3 record).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// `index.js` FIRST (see users-node-replay.test.ts — feature-module import order).
import { createApp } from '../src/index.js';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { crmFeature } from '../src/features/crm/feature.js';
import { listTasks } from '../src/features/crm/crmEntitiesService.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getSetCookies } from './headerCookies.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = join(REPO, 'packs/feature.crm.nodes');

/** The 13 write nodes ADR 0627 D1 classifies. */
export const CRM_WRITE_NODES = [
  'feature.crm.nodes.create-contact',
  'feature.crm.nodes.update-contact-stage',
  'feature.crm.nodes.update-contact-owner',
  'feature.crm.nodes.convert-contact',
  'feature.crm.nodes.create-company',
  'feature.crm.nodes.create-deal',
  'feature.crm.nodes.move-deal-stage',
  'feature.crm.nodes.create-task',
  'feature.crm.nodes.complete-task',
  'feature.crm.nodes.log-activity',
  'feature.crm.nodes.persist-segment',
  'feature.crm.nodes.booking-create-link',
  'feature.crm.nodes.sign-request',
] as const;
const READ_NODES = [
  'feature.crm.nodes.list-companies',
  'feature.crm.nodes.get-company',
  'feature.crm.nodes.suppression-summary',
  'feature.crm.nodes.list-deals',
  'feature.crm.nodes.get-deal',
  'feature.crm.nodes.list-tasks',
  'feature.crm.nodes.list-segment-members',
  'feature.crm.nodes.booking-list',
  'feature.crm.nodes.sign-status',
] as const;
const PURE_NODES = ['feature.crm.nodes.triage', 'feature.crm.nodes.triage-enriched', 'feature.crm.nodes.segment-vocabulary', 'feature.crm.nodes.validate-segment'] as const;

interface Manifest {
  name: string;
  version: string;
  nodes: Array<{ typeId: string; role?: string; capabilities?: string[]; inputSchemaRef?: string; outputSchemaRef?: string }>;
}
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as Manifest;
const byId = new Map(manifest.nodes.map((n) => [n.typeId, n]));

describe('ADR 0627 D1 — the 13 CRM write nodes are classified, on every leg', () => {
  it('the manifest names exactly 27 nodes: 13 side-effect writes, 9 action reads, 4 pure (+ gmail-sync, side-effect since 1.4.0)', () => {
    expect(manifest.nodes).toHaveLength(27);
    expect(manifest.version).toBe('1.10.0');
    for (const id of CRM_WRITE_NODES) {
      const node = byId.get(id);
      expect(node, `${id} not found in the manifest — this test would pass vacuously`).toBeTruthy();
      expect(node!.role, id).toBe('side-effect');
      expect(node!.capabilities ?? [], id).toContain('side-effectful');
    }
    for (const id of READ_NODES) {
      expect(byId.get(id)?.role, id).toBe('action');
      expect(byId.get(id)?.capabilities ?? [], id).not.toContain('side-effectful');
    }
    for (const id of PURE_NODES) expect(byId.get(id)?.role, id).toBe('pure');
    expect(byId.get('feature.crm.nodes.gmail-sync')?.capabilities).toContain('side-effectful');
  });

  it('the derived floor holds all 13 AND the fast path SERVES all 13 (membership alone is undischarged)', () => {
    for (const id of CRM_WRITE_NODES) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} not in the derived floor`).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id), `${id} held but NOT served — undischarged`).toBe(true);
    }
    // …and the reads are NOT in the floor: a read served from a recording is
    // correct, but a read classified side-effecting would be over-classification.
    for (const id of READ_NODES) expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} is a read`).toBe(false);
  });

  it('isSideEffectingNode — the exact predicate executor.ts branches on — returns true for all 13 and false for the reads', () => {
    for (const id of CRM_WRITE_NODES) expect(isSideEffectingNode(id, null), id).toBe(true);
    for (const id of READ_NODES) expect(isSideEffectingNode(id, null), id).toBe(false);
  });
});

describe('ADR 0627 D1 — pack shape: ADR 0525 schemas on the 13 writes; the feature pin', () => {
  it('every write node declares input + output refs resolving to files with the <pack>/<version>/<file> $id', () => {
    for (const id of CRM_WRITE_NODES) {
      const node = byId.get(id)!;
      for (const key of ['inputSchemaRef', 'outputSchemaRef'] as const) {
        const ref = node[key];
        expect(ref, `${id} lacks ${key}`).toBeTruthy();
        const path = join(PACK_DIR, ref!);
        expect(existsSync(path), `${id} ${key} → ${ref} does not exist`).toBe(true);
        const schema = JSON.parse(readFileSync(path, 'utf8')) as { $id?: string; type?: string };
        expect(schema.$id).toBe(`https://packs.openwop.dev/${manifest.name}/${manifest.version}/${ref!.replace(/^schemas\//, '')}`);
        expect(schema.type).toBe('object');
      }
    }
  });

  it('inputs declare NO required keys (the node reads {...config, ...inputs}); outputs are closed and require `success`', () => {
    for (const id of CRM_WRITE_NODES) {
      const node = byId.get(id)!;
      const input = JSON.parse(readFileSync(join(PACK_DIR, node.inputSchemaRef!), 'utf8')) as { required?: string[]; additionalProperties?: boolean; properties: Record<string, unknown> };
      expect(input.required ?? [], `${id} input.required — a required INPUT is a false claim when config may supply the key`).toEqual([]);
      expect(Object.keys(input.properties).length, `${id} input declares no properties`).toBeGreaterThan(0);
      const output = JSON.parse(readFileSync(join(PACK_DIR, node.outputSchemaRef!), 'utf8')) as { required?: string[]; additionalProperties?: boolean; properties: Record<string, unknown> };
      expect(output.additionalProperties, `${id} output is open`).toBe(false);
      expect(output.required ?? [], `${id} output.required`).toContain('success');
    }
  });

  it('the crm feature pins the pack at the manifest version and registers the surface', () => {
    expect(crmFeature.surface?.id).toBe('crm');
    expect(crmFeature.requiredPacks?.find((p) => p.name === 'feature.crm.nodes')).toEqual({ name: 'feature.crm.nodes', version: manifest.version });
  });
});

describe('BEHAVIOURAL — a replay :fork of create-task is served the recorded outcome and mints no second task', () => {
  let server: http.Server;
  let BASE = '';
  let cookie = '';
  const TENANT = `org:crm625-replay-${Date.now()}`;
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const settleRun = async (runId: string): Promise<string> => {
    let snap: { status?: string; error?: unknown } = {};
    for (let i = 0; i < 200; i++) {
      snap = (await call('GET', `/v1/runs/${runId}`)).body ?? snap;
      if (['completed', 'failed', 'cancelled'].includes(snap.status ?? '')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return snap.status === 'completed' ? 'completed' : `${snap.status}:${JSON.stringify(snap.error)}`;
  };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_DEMO_MODE;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const crm = getToggleDefault('crm');
    if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('live run → ONE task keyed task:<runId>:n1; replay fork → still ONE task, and the fork completed with the SOURCE outputs', async () => {
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: 'crm625-replay-owner@acme.test', tenantId: TENANT });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    const orgId = org.body.orgId as string;

    const workflowId = 'crm.replay.create-task';
    const title = 'Follow up with the replay-witness lead';
    registerWorkflow({ workflowId, nodes: [{ nodeId: 'n1', typeId: 'feature.crm.nodes.create-task', config: { orgId, title } }], edges: [] });

    const create = await call('POST', '/v1/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    expect(await settleRun(runId)).toBe('completed');

    const afterLive = await listTasks(TENANT, orgId);
    expect(afterLive.map((t) => t.taskId)).toEqual([`task:${runId}:n1`]);

    // The fork runs under its OWN runId — so `idFor` alone would mint
    // `task:<forkRunId>:n1`. Only the side-effect classification (the fast path
    // serving the recorded outcome) keeps the count at one.
    const fork = await call('POST', `/v1/runs/${runId}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkRunId = fork.body.runId as string;
    expect(forkRunId).not.toBe(runId);
    expect(await settleRun(forkRunId)).toBe('completed');

    const afterFork = await listTasks(TENANT, orgId);
    expect(afterFork.map((t) => t.taskId), 'a replay fork re-executed create-task — the classification is not guarding it').toEqual([`task:${runId}:n1`]);

    // The fork's node completed WITH the recorded outputs: the SOURCE run's id.
    const bundle = await call('GET', `/v1/runs/${forkRunId}/debug-bundle`);
    const done = ((bundle.body?.events as Array<{ type: string; nodeId?: string; payload?: { outputs?: { success?: boolean; task?: { taskId?: string; title?: string } } } }>) ?? [])
      .find((e) => e.type === 'node.completed' && e.nodeId === 'n1');
    expect(done?.payload?.outputs?.success).toBe(true);
    expect(done?.payload?.outputs?.task?.taskId).toBe(`task:${runId}:n1`);
    expect(done?.payload?.outputs?.task?.title).toBe(title);
  });
});
