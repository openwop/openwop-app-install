/**
 * ADR 0643 D2 / R3 review (Should 6 + Should 3) — the `feature.kb.nodes.reindex-drain`
 * side-effect node is served the RECORDED outcome on a `mode:'replay'` fork, and the
 * finished driver workflow STILL RESOLVES for that fork (archived, not deleted).
 *
 * The `crm-node-replay.test.ts` shape, with two differences forced by what the node
 * IS: (1) the live run is a SCHEDULER fire (`processDueSchedules`), because after
 * Should 4 the surface refuses any run that carries an acting user — a human cannot
 * start this workflow, so a human-started "live run" would be the wrong witness;
 * (2) "no second drain" is asserted on the injected embedder's chunk-call count,
 * which a re-executed drain would move, and on the reindex row, which a re-executed
 * drain would 409 against (`No reindex is in progress`) and fail the fork.
 *
 * BORN RED two ways: with the node re-executing on the fork (the classification
 * dropped), the fork's run FAILS — the surface refuses a run that has an acting
 * user, or, with that check also gone, the drain 409s on the `done` row; with the
 * pre-R3 teardown (`deleteRegisteredWorkflow` the moment the job went terminal),
 * the fork cannot resolve its definition at all.
 *
 * Re-witnessed (grade-tests wave 6): removing `feature.kb.nodes.reindex-drain` from
 * `MANIFEST_FAST_PATH_SERVED` (the set the executor reads — NOT
 * `MANIFEST_SIDE_EFFECT_FLOOR`, which is generator input only) and dropping
 * `archivedAt` from the teardown each turn this case red. The surface's acting-user
 * refusal is a SECOND guard behind the fast path and is NOT reachable here; it is
 * witnessed by `kb-reindex-scheduled-drain.test.ts` ('HUMAN-started run').
 *
 * Ceiling: the two settles are `vi.waitFor` polls on the terminal condition — a
 * run-settle and a reindex-row settle have no hook to await.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';
import { __setHeadlessEmbedderForTest } from '../src/host/headlessAi.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { getJob } from '../src/host/schedulingService.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { lifecycleOf } from '../src/host/workflowLifecycle.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { getSetCookies } from './headerCookies.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { createCollection, getReindexJob, ingestDocument, kbReindexJobId, kbReindexWorkflowId, startReindex } from '../src/features/kb/kbService.js';

let server: http.Server;
let BASE = '';
let cookie = '';
const TENANT = `org:kb-replay-${Date.now()}`;
const ORG = 'org-replay';
let chunkEmbeds = 0;

function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | undefined }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
  // JSON.parse is the wire boundary: its result flows into the caller's declared shape.
  const parsed: T | undefined = await res.text().then((t) => { try { return t ? JSON.parse(t) : undefined; } catch { return undefined; } });
  return { status: res.status, body: parsed };
};
/** `wireRunId` is the tenant-BOUND id the v2 protocol path takes. */
const settleRun = async (wireRunId: string): Promise<string> => {
  let snap: { status?: string; error?: unknown } = {};
  // Ceiling: a run has no settle hook to await, so wait on the CONDITION (terminal status).
  await vi.waitFor(async () => {
    snap = (await call<{ status?: string; error?: unknown }>('GET', `/runs/${encodeURIComponent(wireRunId)}`)).body ?? snap;
    if (!['completed', 'failed', 'cancelled'].includes(snap.status ?? '')) throw new Error(`run ${wireRunId} still ${snap.status}`);
  }, { timeout: 5000, interval: 25 });
  return snap.status === 'completed' ? 'completed' : `${snap.status}:${JSON.stringify(snap.error)}`;
};
const daemonDeps = (): StartRunDeps => ({
  storage: tryDurableStorage()!,
  hostSuite: {
    workflowCatalog: {
      getWorkflow: async (workflowId: string) => {
        const definition = await getRegisteredWorkflowAsync(workflowId);
        return definition ? { workflowId, definition } : null;
      },
    },
    providerPolicyResolver: { resolveForRun: async () => [] },
  },
});

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  __setHeadlessEmbedderForTest(async () => ({
    provider: 'openai', model: 'text-embedding-3-small',
    embed: async (texts: readonly string[]) => { if (texts.length > 1) chunkEmbeds += texts.length; return texts.map((t) => { const v = new Array<number>(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
  }));
});
afterAll(async () => {
  __setHeadlessEmbedderForTest(null);
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('BEHAVIOURAL — a replay :fork of reindex-drain is served the recorded outcome and drains nothing', () => {
  it('scheduler-fired live run → done; replay fork → completed with the SOURCE outputs, zero new embeds, and the archived driver still resolves', async () => {
    const login = await call('POST', '/host/openwop-app/test/login', { email: 'kb-replay-owner@acme.test', tenantId: TENANT });
    expect(login.status, JSON.stringify(login.body)).toBe(201);

    const col = await createCollection(TENANT, ORG, 'actor', { name: 'Replayable' });
    for (let i = 0; i < 3; i++) await ingestDocument(TENANT, ORG, 'actor', col.collectionId, { title: `Doc ${i}`, text: `# Section ${i}\nBody of document ${i} with searchable content.` });
    const started = await startReindex(TENANT, ORG, col.collectionId, { provider: 'openai' });
    expect(started.driver, 'R3 Should 7 — the booted app has the chain pack, so the driver is the scheduler').toBe('scheduled');
    const workflowId = kbReindexWorkflowId(TENANT, ORG, col.collectionId);
    const jobId = kbReindexJobId(TENANT, ORG, col.collectionId);

    // The LIVE run: a scheduler fire, the only lane the surface admits.
    const due = (await getJob(jobId))!.nextFireAt!;
    expect(await processDueSchedules(daemonDeps(), due)).toBeGreaterThan(0);
    let job = await getReindexJob(TENANT, ORG, col.collectionId, { preAuthorized: true });
    await vi.waitFor(async () => {
      job = await getReindexJob(TENANT, ORG, col.collectionId, { preAuthorized: true });
      if (job && (job.status === 'running' || job.status === 'paused')) throw new Error(`reindex still ${job.status}`);
    }, { timeout: 5000, interval: 25 });
    expect(job?.status, `reindex did not finish (last: ${JSON.stringify(job)})`).toBe('done');
    const embedsAfterLive = chunkEmbeds;
    expect(embedsAfterLive, 'non-vacuity: the live drain embedded chunks').toBeGreaterThan(0);

    const runs = await tryDurableStorage()!.listRuns({ tenantId: TENANT, workflowId });
    expect(runs.length, 'the scheduler recorded exactly one run of the driver').toBe(1);
    // The stored id is bare; the v2 protocol path takes the tenant-bound one.
    const runId = toWireRunId(runs[0]!.runId, TENANT);
    expect(await settleRun(runId)).toBe('completed');

    // R3 Should 3 — the finished driver is ARCHIVED, not deleted: a run references it.
    expect(await getJob(jobId), 'the scheduler job IS gone').toBeFalsy();
    const def = await getRegisteredWorkflowAsync(workflowId);
    expect(def, 'a definition with recorded runs must still resolve (ADR 0369/0440 — runs replay against it)').not.toBeNull();
    expect(lifecycleOf(def!)).toMatchObject({ transient: true, generatedBy: 'kb.reindex' });
    expect(lifecycleOf(def!).archivedAt).toBeTruthy();
    const owned = await getOwned(TENANT, workflowId);
    expect(owned?.transient).toBe(true);
    expect(owned?.archivedAt).toBeTruthy();

    // The FORK, in replay mode, by a human — who could never START this workflow.
    const fork = await call<{ runId: string }>('POST', `/runs/${encodeURIComponent(runId)}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    const forkRunId = fork.body!.runId;
    expect(forkRunId).not.toBe(runId);
    expect(await settleRun(forkRunId), 'a replay fork that RE-EXECUTES the drain is refused by the surface (acting user) or 409s on the done row — either way it would not complete').toBe('completed');
    expect(chunkEmbeds, 'a replay fork re-executed the drain — the side-effect classification is not guarding it').toBe(embedsAfterLive);
    expect((await getReindexJob(TENANT, ORG, col.collectionId, { preAuthorized: true }))?.status).toBe('done');

    // The fork's node completed WITH the recorded outputs.
    const bundle = await call<{ events?: Array<{ type: string; nodeId?: string; payload?: { outputs?: { status?: string; done?: boolean; embeddedChunks?: number } } }> }>('GET', `/runs/${encodeURIComponent(forkRunId)}/debug-bundle`);
    const done = (bundle.body?.events ?? [])
      .find((e) => e.type === 'node.completed' && e.payload?.outputs && 'embeddedChunks' in e.payload.outputs);
    expect(done, 'the fork must carry the drain node\'s recorded completion').toBeTruthy();
    expect(done!.payload!.outputs).toMatchObject({ status: 'done', done: true, embeddedChunks: job!.totalChunks });
  }, 30_000);
});
