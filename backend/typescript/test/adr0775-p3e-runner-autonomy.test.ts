/**
 * ADR 0775 P3e — the agent-runner node, where an agent acts inside a workflow
 * that a trigger, webhook, event binding or kanban work item started:
 *
 *  1. a paused roster agent, or a workflow on its `never` list, fails the node
 *     when the run has no acting person and no conversation (the agent acting on
 *     its own). A run a person started stays ungated, as chat does.
 *  2. an agent that opts into long-term memory records its turn, as chat does:
 *     one upserted entry per run node, always fenced as untrusted, none on a
 *     replay.
 *
 * Each refusal has a control that differs in exactly one input, so a pass is
 * never "the node failed for some other reason".
 *
 * Red when (wave 60 probes, tracker TST-BRC-6): a run a person started is gated; the
 * paused or never-list refusal is dropped; the verdict loses the run's workflowId; a
 * run that cannot pause is let through; a rejection is accepted; the memory entry id
 * stops being per run node, a replay writes, or the entry is not marked untrusted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import agentRunnerNode from '../src/host/agentRunnerNode.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { createRosterEntry, updateRosterEntry } from '../src/host/rosterService.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { agentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { listMemoryEntries } from '../src/host/inMemorySurfaces.js';
import { MEMORY_UNTRUSTED_TAG } from '../src/host/memoryTrust.js';
import { runWithEffectContext } from '../src/host/runEffectContext.js';
import type { AiCallRequest, AiCallResult, NodeContext, NodeOutcome } from '../src/executor/types.js';
import { startWorkflowRun, type StartRunDeps } from '../src/host/runStarter.js';
import type { Storage } from '../src/storage/storage.js';
import { toWireRunId } from '../src/host/v2Ids.js';

let server: http.Server;
let BASE: string;
let deps: StartRunDeps;
const T = 'tenant-p3e';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'p3e', serviceVersion: '0.0.1', enableConsoleTracer: false });
  deps = { storage: app.locals.storage, hostSuite: app.locals.hostSuite };
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function member(opts: { longTerm?: boolean } = {}): Promise<string> {
  const agentId = `test.p3e-agent-${n++}`;
  getAgentRegistry().register({
    agentId, persona: 'P3e', modelClass: 'chat', systemPrompt: 'You triage invoices.',
    packName: 'test', packVersion: '0', toolAllowlist: [],
    ...(opts.longTerm ? { memoryShape: { longTerm: true } } : {}),
  });
  const entry = await createRosterEntry({ tenantId: T, persona: `P3e ${n++}`, agentRef: { agentId, version: '0' } });
  return entry.rosterId;
}

async function run(rosterId: string, over: Partial<NodeContext> & { conversationId?: string } = {}): Promise<NodeOutcome> {
  const { conversationId, ...ctxOver } = over;
  const callAI = vi.fn<(req: AiCallRequest) => Promise<AiCallResult>>(async () => ({ content: 'triaged 3 invoices' }));
  const ctx: NodeContext = {
    tenantId: T, runId: `run-p3e-${n++}`, nodeId: 'agent', workflowId: 'wf.p3e', attempt: 1, secrets: {},
    config: { offerTools: [] }, configurable: {},
    inputs: { agentId: rosterId, task: 'triage the inbox', credentialRef: 'managed:openwop-free', ...(conversationId ? { conversationId } : {}) },
    emit: async () => ({ eventId: 'evt-p3e', sequence: 0 }), callAI, callAIWithTools: vi.fn(async () => { throw new Error('no tools offered'); }),
    ...ctxOver,
  };
  // ADR 0944 resolves the client binding from the durable run, even for an
  // unscoped agent. An absent run correctly refuses shared-memory writes.
  if (!await deps.storage.getRun(ctx.runId)) {
    const at = new Date().toISOString();
    await deps.storage.insertRun({ runId: ctx.runId, tenantId: T, workflowId: ctx.workflowId!, status: 'running',
      inputs: {}, configurable: {}, metadata: {}, createdAt: at, updatedAt: at });
  }
  return agentRunnerNode.execute(ctx);
}

const code = (out: NodeOutcome): string | undefined => (out as { error?: { code?: string } }).error?.code;

describe('an agent acting on its own inside a workflow', () => {
  it('a paused agent fails the node as agent_paused; resumed, the same run succeeds', async () => {
    const rosterId = await member();
    await updateRosterEntry(T, rosterId, { enabled: false });
    const out = await run(rosterId);
    expect(out.status).toBe('failure');
    expect(code(out)).toBe('agent_paused');
    expect((out as { retryable?: boolean }).retryable).toBe(false);
    await updateRosterEntry(T, rosterId, { enabled: true });
    expect((await run(rosterId)).status).toBe('success');
  });

  it('a run a PERSON started is the test pane: a paused agent still answers', async () => {
    const rosterId = await member();
    await updateRosterEntry(T, rosterId, { enabled: false });
    expect((await run(rosterId, { actingUserId: 'user-p3e' })).status).toBe('success');
  });

  it('a workflow on the agent\'s never list fails the node as policy_denied; another workflow runs', async () => {
    const rosterId = await member();
    await upsertAgentProfile(T, rosterId, { roleKey: 'p3e', autonomy: { specLevel: 'recommend' }, permissions: { read: [], write: [], never: ['wf.p3e-forbidden'] } });
    const denied = await run(rosterId, { workflowId: 'wf.p3e-forbidden' });
    expect(code(denied)).toBe('policy_denied');
    expect((await run(rosterId, { workflowId: 'wf.p3e' })).status).toBe('success');
  });
});

// ADR 0775 P3f — `hitl` on this lane pauses the node on an approval interrupt.
describe('a workflow on the agent\'s hitl list', () => {
  async function hitlMember(): Promise<string> {
    const rosterId = await member();
    await upsertAgentProfile(T, rosterId, { roleKey: 'p3e', autonomy: { specLevel: 'recommend' }, hitl: ['wf.p3e'] });
    return rosterId;
  }

  it('pauses the node for approval before the agent acts', async () => {
    const rosterId = await hitlMember();
    const suspend = vi.fn(async (_payload: Record<string, unknown>): Promise<unknown> => { throw new Error('suspended'); });
    await expect(run(rosterId, { suspend })).rejects.toThrow('suspended');
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(suspend.mock.calls[0]![0]).toMatchObject({ kind: 'approval', key: `agent-hitl:${rosterId}`, actions: ['approve', 'reject'] });
  });

  it('approved, the agent acts; rejected, the node fails as approval_rejected', async () => {
    const rosterId = await hitlMember();
    for (const action of ['approve', 'accept']) {
      expect((await run(rosterId, { suspend: async () => ({ action }) })).status).toBe('success');
    }
    const rejected = await run(rosterId, { suspend: async () => ({ action: 'reject' }) });
    expect(code(rejected)).toBe('approval_rejected');
    expect((rejected as { retryable?: boolean }).retryable).toBe(false);
  });

  it('a run that cannot pause fails closed as approval_required', async () => {
    expect(code(await run(await hitlMember()))).toBe('approval_required');
  });

  it('another workflow, or a run a person started, does not ask', async () => {
    const rosterId = await hitlMember();
    const suspend = vi.fn(async (_payload: Record<string, unknown>): Promise<unknown> => ({ action: 'reject' }));
    expect((await run(rosterId, { suspend, workflowId: 'wf.p3e-other' })).status).toBe('success');
    expect((await run(rosterId, { suspend, actingUserId: 'user-p3e' })).status).toBe('success');
    expect(suspend).not.toHaveBeenCalled();
  });
});

describe('cross-run memory on the run lane', () => {
  const entries = async (rosterId: string) => listMemoryEntries(T, agentMemoryScope(rosterId));

  it('an opted-in agent records ONE untrusted summary per run node; a re-execution upserts it', async () => {
    const rosterId = await member({ longTerm: true });
    const ctx = { runId: `run-p3e-mem-${n++}`, nodeId: 'agent' };
    expect((await run(rosterId, ctx)).status).toBe('success');
    let rows = await entries(rosterId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content, rows[0]!.content).toContain('triaged 3 invoices');
    expect(rows[0]!.tags).toContain(MEMORY_UNTRUSTED_TAG);
    // A crash-resume re-executes the same node of the same run.
    await run(rosterId, ctx);
    rows = await entries(rosterId);
    expect(rows).toHaveLength(1);
    // A different run is a new entry.
    await run(rosterId);
    expect(await entries(rosterId)).toHaveLength(2);
  });

  it('a replay re-executing history writes nothing', async () => {
    const rosterId = await member({ longTerm: true });
    const runId = `run-p3e-replay-${n++}`;
    const out = await runWithEffectContext({ runId, replaying: true }, () => run(rosterId, { runId }));
    expect(out.status).toBe('success');
    expect(await entries(rosterId)).toHaveLength(0);
  });

  it('an agent that did not opt in writes nothing', async () => {
    const rosterId = await member();
    await run(rosterId);
    expect(await entries(rosterId)).toHaveLength(0);
  });
});

describe('through the executor: a run nobody started', () => {
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${BASE}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  it('the run\'s workflowId reaches the node, so a never-listed workflow fails the run as policy_denied', async () => {
    const created = await call('POST', '/host/openwop-app/roster', { persona: `P3e e2e ${n++}`, agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    expect(created.status).toBe(201);
    const rosterId = created.body.rosterId as string;
    const tenantId = created.body.tenantId as string;
    const wf = `wf.p3e-e2e-${Date.now()}`;
    expect((await call('POST', '/host/openwop-app/workflows', {
      workflowId: wf, nodes: [{ nodeId: 'agent', typeId: 'local.openwop-app.agent-runner', config: { agentId: rosterId, task: 'go', offerTools: [] } }], edges: [],
    })).status).toBe(201);
    await upsertAgentProfile(tenantId, rosterId, { roleKey: 'p3e', autonomy: { specLevel: 'recommend' }, permissions: { read: [], write: [], never: [wf] } });

    const runId = await startWorkflowRun(deps, { tenantId, workflowId: wf });
    expect(runId).toBeTruthy();
    const storage = deps.storage as Storage;
    let run = await storage.getRun(runId!);
    for (let i = 0; i < 200 && run && !['completed', 'failed', 'cancelled'].includes(run.status); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      run = await storage.getRun(runId!);
    }
    expect(run?.status).toBe('failed');
    expect(run?.error?.code, JSON.stringify(run?.error)).toBe('policy_denied');
  });

  it('a hitl-listed workflow pauses the run on an approval; rejecting it fails the run as approval_rejected', async () => {
    const created = await call('POST', '/host/openwop-app/roster', { persona: `P3f e2e ${n++}`, agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    const rosterId = created.body.rosterId as string;
    const tenantId = created.body.tenantId as string;
    const wf = `wf.p3f-e2e-${Date.now()}`;
    expect((await call('POST', '/host/openwop-app/workflows', {
      workflowId: wf, nodes: [{ nodeId: 'agent', typeId: 'local.openwop-app.agent-runner', config: { agentId: rosterId, task: 'go', offerTools: [] } }], edges: [],
    })).status).toBe(201);
    await upsertAgentProfile(tenantId, rosterId, { roleKey: 'p3e', autonomy: { specLevel: 'recommend' }, hitl: [wf] });

    const runId = await startWorkflowRun(deps, { tenantId, workflowId: wf });
    const storage = deps.storage as Storage;
    const settle = async (done: string[]) => {
      let r = await storage.getRun(runId!);
      for (let i = 0; i < 200 && r && !done.includes(r.status); i += 1) {
        await new Promise((res) => setTimeout(res, 25));
        r = await storage.getRun(runId!);
      }
      return r;
    };
    expect((await settle(['waiting-approval', 'completed', 'failed']))?.status).toBe('waiting-approval');
    const open = await call('GET', `/host/openwop-app/runs/${runId}/interrupts`);
    const interrupts = (open.body.interrupts ?? []) as Array<{ kind?: string; nodeId?: string }>;
    expect(interrupts.map((i) => [i.kind, i.nodeId]), JSON.stringify(open.body)).toEqual([['approval', 'agent']]);

    const resolved = await call('POST', `/runs/${encodeURIComponent(toWireRunId(runId!, tenantId))}/interrupts/agent`, { resumeValue: { action: 'reject' } });
    expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300);
    const after = await settle(['completed', 'failed', 'cancelled']);
    expect(after?.status).toBe('failed');
    expect(after?.error?.code, JSON.stringify(after?.error)).toBe('approval_rejected');
  });
});
