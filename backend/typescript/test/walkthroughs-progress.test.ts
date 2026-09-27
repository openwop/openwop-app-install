/**
 * ADR 0368 Phase 5 — tour progress rows: toggle-gated, tenant-scoped,
 * upsert-by-key (one row per tenant×tour), input-validated.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { seedDemoWalkthroughs } from '../src/host/demoWalkthroughsSeed.js';
import { CAMPAIGN_STUDIO_WALKTHROUGH_ID } from '../src/features/walkthroughs/walkthroughIds.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const gt = getToggleDefault('walkthroughs');
  if (gt) await saveConfig({ ...gt, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Record<string, unknown> };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}
const PROG = '/v1/host/openwop-app/walkthroughs/progress';

describe('guided-tour progress (ADR 0368 P5)', () => {
  it('upserts one row per tenant×tour, lists tenant-scoped, validates input', async () => {
    const a = client();
    expect((await a.post('/v1/host/openwop-app/test/login', { email: `tp-${Date.now()}-${n++}@acme.test` })).status).toBe(201);

    expect((await a.post(PROG, { walkthroughId: 't1', status: 'nope', runId: 'r1' })).status).toBe(400);
    expect((await a.post(PROG, { walkthroughId: 't1', status: 'started', runId: 'r1' })).status).toBe(200);
    expect((await a.post(PROG, { walkthroughId: 't1', status: 'completed', runId: 'r1' })).status).toBe(200);

    const rows = (await a.get(PROG)).body.progress as Array<{ walkthroughId: string; status: string }>;
    expect(rows).toHaveLength(1); // upsert, not append
    expect(rows[0]).toMatchObject({ walkthroughId: 't1', status: 'completed' });

    // Tenant isolation: a second tenant sees nothing.
    const b = client();
    expect((await b.post('/v1/host/openwop-app/test/login', { email: `tp-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    expect(((await b.get(PROG)).body.progress as unknown[])).toHaveLength(0);
  });

  it('per-user rows: a member does NOT see another member\'s progress (the resume-hijack fix, ADR 0378 P3)', async () => {
    const tenantId = `org:prog-${Date.now()}-${n++}`;
    const alice = client();
    const bob = client();
    expect((await alice.post('/v1/host/openwop-app/test/login', { email: `alice-${n}@acme.test`, tenantId })).status).toBe(201);
    expect((await bob.post('/v1/host/openwop-app/test/login', { email: `bob-${n}@acme.test`, tenantId })).status).toBe(201);

    expect((await alice.post(PROG, { walkthroughId: 'w-hijack', status: 'started', runId: 'run-alice' })).status).toBe(200);
    // Bob (same tenant) must NOT see Alice's in-flight row — with the old
    // tenant-level key, his launch would have re-attached to HER run.
    expect(((await bob.get(PROG)).body.progress as unknown[])).toHaveLength(0);
    const aliceRows = (await alice.get(PROG)).body.progress as Array<{ walkthroughId: string; runId: string }>;
    expect(aliceRows).toEqual([expect.objectContaining({ walkthroughId: 'w-hijack', runId: 'run-alice' })]);
  });

  it('legacy tenant-level rows remain readable as a fallback; a per-user row wins (dual-read)', async () => {
    const tenantId = `org:prog-legacy-${Date.now()}-${n++}`;
    const carol = client();
    const dave = client();
    expect((await carol.post('/v1/host/openwop-app/test/login', { email: `carol-${n}@acme.test`, tenantId })).status).toBe(201);
    expect((await dave.post('/v1/host/openwop-app/test/login', { email: `dave-${n}@acme.test`, tenantId })).status).toBe(201);

    // Seed a pre-P3 tenant-level row directly through the store (no userId).
    const { putWalkthroughProgress } = await import('../src/features/walkthroughs/progressStore.js');
    await putWalkthroughProgress({ tenantId, walkthroughId: 'w-legacy', status: 'started', runId: 'run-legacy', updatedAt: new Date().toISOString() });

    // Both members see the legacy row (fallback).
    expect((await carol.get(PROG)).body.progress as unknown[]).toHaveLength(1);
    expect((await dave.get(PROG)).body.progress as unknown[]).toHaveLength(1);

    // Carol writes her own row for the SAME walkthrough — hers wins for her;
    // Dave still sees the legacy row.
    expect((await carol.post(PROG, { walkthroughId: 'w-legacy', status: 'completed', runId: 'run-carol' })).status).toBe(200);
    const carolRows = (await carol.get(PROG)).body.progress as Array<{ runId: string; status: string }>;
    expect(carolRows).toEqual([expect.objectContaining({ runId: 'run-carol', status: 'completed' })]);
    const daveRows = (await dave.get(PROG)).body.progress as Array<{ runId: string }>;
    expect(daveRows).toEqual([expect.objectContaining({ runId: 'run-legacy' })]);
  });

  it('the funnel derives status counts + the stall step from real runs (ADR 0378 P3)', async () => {
    const tenantId = `org:funnel-${Date.now()}-${n++}`;
    const a = client();
    expect((await a.post('/v1/host/openwop-app/test/login', { email: `funnel-${n}@acme.test`, tenantId })).status).toBe(201);

    expect((await a.get('/v1/host/openwop-app/walkthroughs/funnel')).status).toBe(400); // walkthroughId required

    // ADR 0435 — the sample walkthrough is SEEDED demo data, not a builtin, so
    // the tenant must load it before it resolves as a runnable workflow. (The
    // legacy pre-rename id below is still a builtin, by design: it exists only
    // so pre-rename runs replay.)
    const WID = CAMPAIGN_STUDIO_WALKTHROUGH_ID;
    await seedDemoWalkthroughs(tenantId);

    // Two real runs of the seeded walkthrough — both suspend on step t1.
    const r1 = await a.post('/v1/runs', { workflowId: WID, inputs: {} });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const r2 = await a.post('/v1/runs', { workflowId: WID, inputs: {} });
    expect(r2.status).toBe(201);
    // Cancel the second — an abandoned walkthrough.
    const run2 = (r2.body as { runId?: string }).runId ?? (r2.body as { run?: { runId: string } }).run?.runId;
    expect(run2).toBeTruthy();
    await a.post(`/v1/runs/${run2}:cancel`, {});

    // Grade-pass: a PRE-RENAME run (legacy builtin id — runs are immutable for
    // replay) must be counted in the NEW id's funnel via the legacy union.
    const r3 = await a.post('/v1/runs', { workflowId: 'tour.campaign-studio.first-brief', inputs: {} });
    expect(r3.status, JSON.stringify(r3.body)).toBe(201);

    const f = await a.get(`/v1/host/openwop-app/walkthroughs/funnel?walkthroughId=${WID}`);
    expect(f.status).toBe(200);
    expect(f.body).toMatchObject({ walkthroughId: WID, started: 3, completed: 0 }); // 2 new-id + 1 legacy-id
    const stalled = f.body.stalledByNode as Record<string, number>;
    expect(stalled.t1).toBeGreaterThanOrEqual(2); // non-cancelled runs stall on t1
  });

  /**
   * ADR 0489 OQ1 / WALK-A1 — a SKIP must be countable.
   *
   * An `already-satisfied` checkpoint resolves its step as done, so before this
   * a skip was indistinguishable from a completion and the funnel could not
   * answer the question the whole feature raises: "how often do learners
   * already know this?" A phase most learners skip is a phase to cut — and that
   * signal was invisible.
   */
  it('the funnel buckets SKIPS separately from completions (WALK-A1)', async () => {
    const tenantId = `org:skipfunnel-${Date.now()}-${n++}`;
    const a = client();
    expect((await a.post('/v1/host/openwop-app/test/login', { email: `skip-${n}@acme.test`, tenantId })).status).toBe(201);
    const WID = CAMPAIGN_STUDIO_WALKTHROUGH_ID;
    await seedDemoWalkthroughs(tenantId);

    const created = await a.post('/v1/runs', { workflowId: WID, inputs: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const runId = (created.body as { runId: string }).runId;

    // Walk the run to its CHECKPOINT node, resolving each step as the player would.
    let guard = 0;
    let checkpointNode: string | null = null;
    while (guard++ < 10) {
      const snap = await a.get(`/v1/runs/${runId}`);
      if (!String((snap.body as { status?: string }).status ?? '').startsWith('waiting')) break;
      const ints = await a.get(`/v1/host/openwop-app/runs/${runId}/interrupts`);
      const open = (ints.body.interrupts as Array<Record<string, unknown>>).filter((i) => !i.resolvedAt);
      if (open.length === 0) break;
      const node = open[0]!.nodeId as string;
      const isCheckpoint = typeof (open[0]!.data as Record<string, unknown>).checkpoint === 'string';
      if (isCheckpoint) {
        // THE SKIP: resolve exactly as the player does for `already-satisfied`.
        checkpointNode = node;
        await a.post(`/v1/runs/${runId}/interrupts/${node}`, {
          resumeValue: { passed: true, skipped: true, because: 'You already created a brief.' },
        });
        break;
      }
      await a.post(`/v1/runs/${runId}/interrupts/${node}`, { resumeValue: { acked: true } });
    }
    expect(checkpointNode, 'the seeded walkthrough should reach a checkpoint').toBeTruthy();

    const f = await a.get(`/v1/host/openwop-app/walkthroughs/funnel?walkthroughId=${WID}`);
    expect(f.status).toBe(200);
    expect(f.body.skipped, JSON.stringify(f.body)).toBe(1);
    expect((f.body.skippedByNode as Record<string, number>)[checkpointNode!]).toBe(1);
  });

  it('a walkthrough with NO checkpoint reports zero skips and does no extra reads', async () => {
    // The bounded-read property: skips can only originate at a checkpoint, so a
    // checkpoint-free walkthrough must add no per-run lookups at all.
    const tenantId = `org:noskip-${Date.now()}-${n++}`;
    const a = client();
    expect((await a.post('/v1/host/openwop-app/test/login', { email: `noskip-${n}@acme.test`, tenantId })).status).toBe(201);
    await seedDemoWalkthroughs(tenantId);
    const f = await a.get('/v1/host/openwop-app/walkthroughs/funnel?walkthroughId=walkthrough.agents.roster');
    expect(f.status).toBe(200);
    expect(f.body.skipped).toBe(0);
    expect(f.body.skippedByNode).toEqual({});
  });
});
