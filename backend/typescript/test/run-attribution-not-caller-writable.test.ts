/**
 * The run-attribution blocks are host-written only.
 *
 * `heartbeat` / `schedule` / `kanban` / `approval` say which agent a run belongs
 * to; `recordRunAttribution` indexes a run under the `rosterId` they carry. They
 * were not reserved, so a caller of `POST /runs` could attach one and attribute
 * its run to ANY agent. Real route, real storage: the forged blocks must not be
 * on the stored run, and the run must not be attributable. Ordinary caller
 * metadata must still come through (the strip is a list, not a wipe).
 *
 * The strip is at the ROUTE (`stripCallerAttribution`), not in the shared
 * reserved list: host paths (scheduler, kanban trigger, heartbeat, approval
 * claim) compose these blocks on purpose and reach the same constructors. A
 * first cut that reserved them globally broke 14 host-path test files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { extractRunAttribution } from '../src/host/agentRunActivityIndex.js';
import { fromWireRunId } from '../src/host/v2Ids.js';
import { getJob } from '../src/host/schedulingService.js';

describe('run attribution is not caller-writable (POST /runs)', () => {
  let server: http.Server;
  let storage: Storage;
  let BASE = '';
  let workflowId = '';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const disco = await (await fetch(`${BASE}/.well-known/openwop`, { headers: { authorization: 'Bearer dev-token' } })).json() as { fixtures?: string[] };
    workflowId = disco.fixtures?.[0] ?? 'openwop-app.uppercase';
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('forged heartbeat/schedule/kanban/approval blocks are stripped; other metadata survives', async () => {
    const forged = { rosterId: 'ros_someone_else', agentId: 'vendor.openwop-app.agents.victim', boardId: 'board-x', ownerScope: 'project:p-x' };
    const res = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      body: JSON.stringify({ workflowId, inputs: {}, metadata: { heartbeat: forged, schedule: forged, kanban: forged, approval: forged, note: 'mine' } }),
    });
    const body = await res.json() as { runId: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const id = fromWireRunId(body.runId, 'default');
    if (!id.ok) throw new Error(`unexpected tenant segment in ${body.runId}`);
    const run = await storage.getRun(id.runId);
    expect(run, 'the run was not stored — the leg would be vacuous').not.toBeNull();
    const md = run!.metadata as Record<string, unknown>;
    for (const k of ['heartbeat', 'schedule', 'kanban', 'approval']) expect(md[k], k).toBeUndefined();
    expect(extractRunAttribution(md)).toBeUndefined();
    expect(md.note).toBe('mine');
  });

  // ADR 0075 §D4 — `approverOrgId` names the org whose admins approve the run. POST
  // /runs wrote the host value only for workflows with group/role gates, so on any
  // other workflow a caller's value survived; the scheduler copied job metadata onto
  // every run it starts. Both entry points now strip it.
  it('a caller-supplied approverOrgId is stripped on POST /runs; other metadata survives', async () => {
    const res = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      body: JSON.stringify({ workflowId, inputs: {}, metadata: { approverOrgId: 'org-chosen-by-caller', note: 'mine' } }),
    });
    const body = await res.json() as { runId: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const id = fromWireRunId(body.runId, 'default');
    if (!id.ok) throw new Error(`unexpected tenant segment in ${body.runId}`);
    const md = (await storage.getRun(id.runId))!.metadata as Record<string, unknown>;
    expect(md.approverOrgId).toBeUndefined();
    expect(md.note).toBe('mine');
  });

  it('a caller-supplied approverOrgId is stripped from a scheduled job\'s metadata (it would ride every run the job starts)', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/scheduler/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      body: JSON.stringify({ cronExpr: '0 9 * * *', workflowId, enabled: false, metadata: { approverOrgId: 'org-chosen-by-caller', note: 'mine' } }),
    });
    const body = await res.json() as { jobId?: string; job?: { jobId?: string } };
    expect([200, 201], JSON.stringify(body)).toContain(res.status);
    const jobId = body.jobId ?? body.job?.jobId;
    expect(jobId, JSON.stringify(body)).toBeTruthy();
    const job = await getJob(jobId!);
    expect(job, 'the job was not stored — the leg would be vacuous').toBeTruthy();
    expect((job!.metadata ?? {}).approverOrgId).toBeUndefined();
    expect((job!.metadata ?? {}).note).toBe('mine');
  });
});
