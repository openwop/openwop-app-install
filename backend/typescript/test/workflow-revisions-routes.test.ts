/**
 * ADR 0474 P1a-3 — the history HTTP surface. Drives the real app: owner-gated
 * revisions list (isHead/published flags), promote stamping publishedRevision,
 * rollback restoring a prior revision as the new head (append-only history,
 * re-head by seq), and the IDOR 404 posture.
 *
 * Every case seeds its OWN workflow (wave 64: the cases used to share one
 * workflow and each read the state the previous case left, so they reddened
 * under `--sequence.shuffle`). Settle waits THROW on timeout.
 *
 * IDOR: revision rows are keyed by (workflowId, hash), not by tenant, so the
 * rollback route's `row.tenantId !== tenantId` fence is what stops a caller
 * restoring ANOTHER tenant's content into its own workflow. The 404 case seeds
 * exactly that foreign row (round 1 only requested a nonexistent hash, so the
 * fence was never reached: probe 8fw5g2-rvr-rollback-tenant, vacuous).
 *
 * Sabotage that turns it red (wave 64 probes): isHead (8fw5g2-rvr-ishead), the
 * owner gate (-rvr-owner-gate), promote's pin (-rvr-promote-pin), rollback's
 * lifecycle merge and append (-rvr-rollback-lifecycle, -rvr-rollback-append),
 * the tenant fence (-rvr-rollback-tenant-r2), the spoof strip (-rvr-spoof-strip),
 * the fork stamp (-rvr-fork-stamp), and published-vs-head launch resolution
 * (-rvr-published-def, -rvr-draft-head).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { recordRevision } from '../src/host/workflowRevisions.js';
import { bareRunId } from './support/bareRunId.js';

interface RevisionItem { revisionHash: string; isHead: boolean; published: boolean; nodeCount: number; supersedes?: string }
interface RunRevisionInfo { definitionRevision?: string; definitionResolvedFrom?: string }
interface ErrorBody { error: string; message: string; details?: Record<string, unknown> }

describe('workflow revisions routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';
  const API = '/host/openwop-app/workflows';
  const savedEnv = { dsn: process.env.OPENWOP_STORAGE_DSN, cookies: process.env.OPENWOP_AUTH_DISABLE_COOKIES };
  let seq = 0;
  /** A fresh workflow id per case: no case reads another's state. */
  const freshWf = (tag: string): string => `rev-route-${tag}-${seq++}`;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    if (savedEnv.dsn === undefined) delete process.env.OPENWOP_STORAGE_DSN; else process.env.OPENWOP_STORAGE_DSN = savedEnv.dsn;
    if (savedEnv.cookies === undefined) delete process.env.OPENWOP_AUTH_DISABLE_COOKIES; else process.env.OPENWOP_AUTH_DISABLE_COOKIES = savedEnv.cookies;
  });

  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  }

  async function settle(runId: string): Promise<string> {
    for (let i = 0; i < 100; i += 1) {
      const r = await call<{ status: string }>('GET', `/runs/${runId}`);
      if (r.body.status && r.body.status !== 'pending' && r.body.status !== 'running') return r.body.status;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`run ${runId} did not settle after 100 polls (25 ms apart)`);
  }

  const ONE = [{ nodeId: 'a', typeId: 'core.noop' }];
  const TWO = [{ nodeId: 'a', typeId: 'core.noop' }, { nodeId: 'b', typeId: 'core.noop' }];
  const defV = (workflowId: string, nodes: Array<{ nodeId: string; typeId: string }>, name: string) => ({
    workflowId, nodes, edges: [], metadata: { name, lifecycle: { transient: true, generatedBy: 'test' } },
  });
  const revisions = async (wf: string): Promise<RevisionItem[]> => {
    const list = await call<{ items: RevisionItem[] }>('GET', `${API}/${wf}/revisions`);
    expect(list.status).toBe(200);
    return list.body.items;
  };
  /** v1 (one node) then v2 (two nodes): the history this surface lists. */
  async function seedTwoRevisions(wf: string): Promise<RevisionItem[]> {
    expect((await call('POST', API, defV(wf, ONE, 'v1'))).status).toBe(201);
    expect((await call('POST', API, defV(wf, TWO, 'v2'))).status).toBe(201);
    const items = await revisions(wf);
    expect(items).toHaveLength(2);
    return items;
  }
  /** Run the workflow to completion (promote requires a completed run). */
  async function completeOneRun(wf: string): Promise<string> {
    const run = await call<{ runId: string }>('POST', '/runs', { workflowId: wf, inputs: {} });
    expect(run.status).toBe(201);
    expect(await settle(run.body.runId)).toBe('completed');
    return run.body.runId;
  }
  async function promote(wf: string): Promise<string> {
    const p = await call<{ publishedRevision?: string }>('POST', `${API}/${wf}/promote`);
    expect(p.status).toBe(200);
    expect(p.body.publishedRevision).toMatch(/^[0-9a-f]+$/);
    return p.body.publishedRevision!;
  }

  it('save → edit → history lists both revisions with isHead on the newest', async () => {
    const wf = freshWf('list');
    const items = await seedTwoRevisions(wf);
    expect(items[0]!.isHead).toBe(true);
    expect(items[0]!.nodeCount).toBe(2);
    expect(items[0]!.supersedes).toBe(items[1]!.revisionHash);
    expect(items[1]!.isHead).toBe(false);
    expect(items[1]!.nodeCount).toBe(1);
    expect(items[1]!.supersedes).toBeUndefined();
  });

  it('promote stamps publishedRevision (visible in the list)', async () => {
    const wf = freshWf('promote');
    const [head] = await seedTwoRevisions(wf);
    await completeOneRun(wf);
    expect(await promote(wf)).toBe(head!.revisionHash); // the HEAD is what gets published
    const items = await revisions(wf);
    expect(items.filter((r) => r.published).map((r) => r.revisionHash)).toEqual([head!.revisionHash]);
    expect(items.find((r) => r.published)?.isHead).toBe(true);
  });

  it('rollback restores a prior revision as the new head (history stays append-only)', async () => {
    const wf = freshWf('rollback');
    const items = await seedTwoRevisions(wf);
    const v1row = items.find((r) => r.nodeCount === 1)!;

    const rb = await call<{ restoredRevision: string }>('POST', `${API}/${wf}/rollback`, { revisionHash: v1row.revisionHash });
    expect(rb.status).toBe(200);
    expect(rb.body.restoredRevision).toBe(v1row.revisionHash);

    const after = await revisions(wf);
    expect(after.length).toBe(2); // append-only: same two rows, re-headed
    expect(after[0]!.revisionHash).toBe(v1row.revisionHash);
    expect(after[0]!.isHead).toBe(true);
    expect(after[0]!.nodeCount).toBe(1);
    expect(after[1]!.isHead).toBe(false);
  });

  it('unknown revision and unknown workflow are 404s; bad body is a 400', async () => {
    const wf = freshWf('idor');
    const items = await seedTwoRevisions(wf);
    const REV_404: ErrorBody = { error: 'not_found', message: 'revision not found', details: { workflowId: wf } };
    expect(await call('POST', `${API}/${wf}/rollback`, { revisionHash: 'nope'.repeat(16) })).toEqual({ status: 404, body: REV_404 });
    // IDOR: a revision row of THIS workflow id, written by ANOTHER tenant. The
    // route must refuse it exactly like a missing one, and the head must not move.
    const foreignHash = await recordRevision('tenant-someone-else', {
      workflowId: wf, nodes: [...TWO, { nodeId: 'c', typeId: 'core.noop' }], edges: [], metadata: { name: 'foreign' },
    });
    expect(foreignHash, 'fixture: the foreign revision row was written').toMatch(/^[0-9a-f]+$/);
    expect(await call('POST', `${API}/${wf}/rollback`, { revisionHash: foreignHash })).toEqual({ status: 404, body: REV_404 });
    expect((await revisions(wf)).find((r) => r.isHead)?.revisionHash).toBe(items[0]!.revisionHash);
    // Positive control: the owner's own prior revision restores on the same route.
    expect((await call('POST', `${API}/${wf}/rollback`, { revisionHash: items[1]!.revisionHash })).status).toBe(200);

    expect(await call('GET', `${API}/does-not-exist/revisions`)).toMatchObject({ status: 404, body: { error: 'not_found', message: 'workflow not found' } });
    expect(await call('POST', `${API}/${wf}/rollback`, {})).toMatchObject({ status: 400, body: { error: 'validation_error', message: 'revisionHash is required.' } });
  });

  it('a fork persists definitionResolvedFrom + the inherited pin (review H1)', async () => {
    const wf = freshWf('fork');
    const [head] = await seedTwoRevisions(wf);
    const runId = await completeOneRun(wf);
    const fork = await call<{ runId: string }>('POST', `/runs/${runId}:fork`, { mode: 'replay' });
    expect(fork.status).toBe(201);
    const info = await call<RunRevisionInfo>('GET', `/host/openwop-app/runs/${bareRunId(fork.body.runId)}/revision`);
    expect(info.status).toBe(200);
    expect(info.body.definitionRevision).toBe(head!.revisionHash); // inherited pin persisted
    expect(info.body.definitionResolvedFrom).toBe('revision');   // the honesty stamp persisted
  });

  it('rollback preserves the CURRENT lifecycle — a promoted workflow never reverts to a hidden draft (review H2)', async () => {
    // Every stored snapshot carries transient:true from its save-time
    // lifecycle. Promote, roll back, and confirm the workflow is STILL
    // visible/promoted (transient falsy on the scoped list).
    const wf = freshWf('lifecycle');
    const items = await seedTwoRevisions(wf);
    await completeOneRun(wf);
    await promote(wf);
    const before = (await call<{ workflows: Array<{ workflowId: string; transient?: boolean }> }>('GET', API)).body.workflows.find((w) => w.workflowId === wf);
    expect(before?.transient ?? false, 'fixture: promote cleared transient').toBe(false);
    const nonHead = items.find((r) => !r.isHead)!;
    const rb = await call('POST', `${API}/${wf}/rollback`, { revisionHash: nonHead.revisionHash });
    expect(rb.status).toBe(200);
    const scoped = await call<{ workflows: Array<{ workflowId: string; transient?: boolean; archivedAt?: string }> }>('GET', API);
    const row = scoped.body.workflows.find((w) => w.workflowId === wf);
    expect(row).toBeTruthy();
    expect(row!.transient ?? false).toBe(false);
    expect(row!.archivedAt ?? undefined).toBeUndefined();
  });

  it('a client-spoofed definitionRevision is stripped at run creation (review M1)', async () => {
    const wf = freshWf('spoof');
    const [head] = await seedTwoRevisions(wf);
    const spoof = 'f'.repeat(64);
    const run = await call<{ runId: string }>('POST', '/runs', { workflowId: wf, inputs: {}, metadata: { definitionRevision: spoof, definitionResolvedFrom: 'revision' } });
    expect(run.status).toBe(201);
    const info = await call<RunRevisionInfo>('GET', `/host/openwop-app/runs/${bareRunId(run.body.runId)}/revision`);
    expect(info.status).toBe(200);
    expect(info.body.definitionRevision).toBe(head!.revisionHash); // the host stamped the truth
    expect(info.body.definitionResolvedFrom).toBeUndefined(); // spoof stripped; only forks set it
  });


  describe('published-launch resolution (ADR 0474 P1b)', () => {
    /** v1 → completed run → promote → v2: the head is now PAST the published revision. */
    async function publishedBehindHead(wf: string): Promise<{ publishedHash: string; headHash: string }> {
      expect((await call('POST', API, defV(wf, ONE, 'v1'))).status).toBe(201);
      await completeOneRun(wf);
      const publishedHash = await promote(wf);
      expect((await call('POST', API, defV(wf, TWO, 'v2'))).status).toBe(201);
      const head = (await revisions(wf)).find((r) => r.isHead)!;
      expect(head.revisionHash, 'fixture: the head moved past the published revision').not.toBe(publishedHash);
      return { publishedHash, headHash: head.revisionHash };
    }

    it('a production launch runs the PUBLISHED revision after the head moves', async () => {
      const wf = freshWf('launch');
      const { publishedHash } = await publishedBehindHead(wf);
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: wf, inputs: {} });
      expect(run.status).toBe(201);
      const info = await call<RunRevisionInfo>('GET', `/host/openwop-app/runs/${bareRunId(run.body.runId)}/revision`);
      expect(info.body.definitionRevision).toBe(publishedHash); // ran the PUBLISHED def
    });

    it("the builder's draft run (metadata.launch='draft') runs the head", async () => {
      const wf = freshWf('draft');
      const { headHash } = await publishedBehindHead(wf);
      const run = await call<{ runId: string }>('POST', '/runs', { workflowId: wf, inputs: {}, metadata: { launch: 'draft' } });
      expect(run.status).toBe(201);
      const info = await call<RunRevisionInfo>('GET', `/host/openwop-app/runs/${bareRunId(run.body.runId)}/revision`);
      expect(info.body.definitionRevision).toBe(headHash); // the HEAD, not published
    });

    it('the scoped list surfaces publishedBehindHead', async () => {
      const wf = freshWf('behind');
      const { publishedHash } = await publishedBehindHead(wf);
      const scoped = await call<{ workflows: Array<{ workflowId: string; publishedRevision?: string; publishedBehindHead?: boolean }> }>('GET', API);
      const row = scoped.body.workflows.find((w) => w.workflowId === wf)!;
      expect(row.publishedRevision).toBe(publishedHash);
      expect(row.publishedBehindHead).toBe(true);
    });
  });

});
