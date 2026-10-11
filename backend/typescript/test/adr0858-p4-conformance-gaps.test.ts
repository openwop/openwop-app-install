/**
 * ADR 0858 P4 — the two host gaps the major-2 conformance lane found once
 * `multiAgent` was projected into v2 discovery and made two scenarios
 * applicable. Each leg replays its scenario's assertion through the HTTP
 * boundary and the real executor:
 *
 *   1. `v2-dispatch-loop` › every recorded decision is exactly ONE
 *      `OrchestratorDecision` branch. The no-plan supervisor used to record
 *      `{kind:'next-worker', nextWorkerIds: []}`, which no branch accepts
 *      (`nextWorkerIds` minItems 1).
 *   2. `v2-run-fork-ancestry` › a branch fork is not a composition child: its
 *      `getRunAncestry` parent is `null`. The route used to turn ANY
 *      `parentRunId` (a fork stamps one) into `{cause: 'core.subWorkflow'}`.
 *      A dispatched child keeps its parent — the control that a route answering
 *      `null` for everything cannot pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { CROSS_HOST_CAUSATION_HOST_ID } from '../src/routes/discovery.js';
import { bareRunId } from './support/bareRunId.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { randomUUID } from 'node:crypto';
import { corpusSchema } from './support/corpusSchema.js';

const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
const PHASE_3 = 'OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3';
const savedPhase3 = process.env[PHASE_3];

let server: http.Server;
let BASE = '';
let storage: Storage;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env[PHASE_3] = 'true'; // getRunAncestry is mounted from phase 3
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 120_000);
afterAll(async () => {
  if (savedPhase3 === undefined) delete process.env[PHASE_3]; else process.env[PHASE_3] = savedPhase3;
  await new Promise<void>((r) => server.close(() => r()));
});

type Json = Record<string, unknown>;
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function settled(runId: string): Promise<string> {
  let status = '';
  for (let i = 0; i < 300; i++) {
    status = (await api<{ status: string }>(`/runs/${encodeURIComponent(runId)}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return status;
}
async function createRun(workflowId: string): Promise<string> {
  const res = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(await settled(res.body.runId)).toBe('completed');
  return res.body.runId;
}

/** The scenario's rule (`decisionBranchValidator`): exactly one `oneOf` branch accepts. */
function decisionValidator(): (d: unknown) => { ok: boolean; errors: string } {
  const schema = corpusSchema('v2/orchestrator-decision.schema.json') as { oneOf: unknown[] };
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const branches = schema.oneOf.map((b) => ajv.compile(b as object));
  return (d) => {
    const results = branches.map((v) => ({ ok: v(d) as boolean, errors: ajv.errorsText(v.errors) }));
    const ok = results.filter((r) => r.ok).length === 1;
    return { ok, errors: results.map((r, i) => `branch ${i}: ${r.ok ? 'accepted' : r.errors}`).join(' | ') };
  };
}

describe('ADR 0858 P4 — v2-dispatch-loop: every recorded decision is one OrchestratorDecision', () => {
  it('conformance-dispatch-loop records only schema-valid decisions, ending in terminate', async () => {
    const runId = await createRun('conformance-dispatch-loop');
    const poll = await api<{ events: Array<{ type: string; sequence: number; payload: Json }> }>(`/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=-1&limit=1000`);
    expect(poll.status).toBe(200);
    const decided = (poll.body.events ?? []).filter((e) => /(^|\.)(runOrchestrator|orchestrator)\.decided$/.test(e.type));
    expect(decided.length, 'the loop records at least one decision').toBeGreaterThan(0);
    const validate = decisionValidator();
    for (const e of decided) {
      const v = validate(e.payload['decision']);
      expect(v.ok, `seq ${e.sequence} ${JSON.stringify(e.payload['decision'])}: ${v.errors}`).toBe(true);
    }
    expect((decided[decided.length - 1]!.payload['decision'] as Json)['kind']).toBe('terminate');
  }, 60_000);
});

describe('ADR 0858 P4 — v2-run-fork-ancestry: a fork is not a composition child', () => {
  it('a run created by POST /runs and its branch fork both answer ancestry parent null', async () => {
    const runId = await createRun('conformance-noop');
    const own = await api<{ parent: unknown }>(`/runs/${encodeURIComponent(runId)}/ancestry`);
    expect(own.status).toBe(200);
    expect(own.body.parent).toBeNull();

    const fork = await api<{ runId: string; sourceRunId: string }>(`/runs/${encodeURIComponent(runId)}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'branch', fromSeq: 0 }) });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(fork.body.sourceRunId).toBe(runId);
    // The fork really does carry the source as parentRunId — the field the route used to read.
    expect((await storage.getRun(bareRunId(fork.body.runId)))?.parentRunId).toBe(bareRunId(runId));

    const anc = await api<{ parent: unknown }>(`/runs/${encodeURIComponent(fork.body.runId)}/ancestry`);
    expect(anc.status).toBe(200);
    expect(anc.body.parent, `got ${JSON.stringify(anc.body.parent)}`).toBeNull();
  }, 60_000);

  it('control: a dispatched child (parentRunId, no forkMode) keeps its composition parent', async () => {
    const parentId = await createRun('conformance-noop');
    const parent = (await storage.getRun(bareRunId(parentId)))!;
    const childId = randomUUID();
    const now = new Date().toISOString();
    await storage.insertRun({ ...parent, runId: childId, parentRunId: parent.runId, forkMode: undefined, status: 'completed', createdAt: now, updatedAt: now });
    const anc = await api<{ parent: { runId?: string; hostId?: string; cause?: string } | null }>(`/runs/${encodeURIComponent(toWireRunId(childId, parent.tenantId))}/ancestry`);
    expect(anc.status, JSON.stringify(anc.body)).toBe(200);
    expect(anc.body.parent).not.toBeNull();
    expect(bareRunId(String(anc.body.parent?.runId))).toBe(parent.runId);
    expect(anc.body.parent?.hostId).toBe(CROSS_HOST_CAUSATION_HOST_ID);
    expect(anc.body.parent?.cause).toBe('core.subWorkflow');
  }, 60_000);
});
