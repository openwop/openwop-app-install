/**
 * ADR 0311 P1 — `openwop:kanban.add-todo`: the third grounding path. Files a
 * real host.kanban card in the agent's own board's `todo` column (the roster
 * heartbeat's work-intake contract) — deliberately WITHOUT a workflow binding
 * (a bare todo is a visible backlog item, not auto-executed work).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds, builtinToolNamespaces } from '../src/host/agentToolProvider.js';
import { getBoard, subjectBoardId, listCards } from '../src/host/kanbanService.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { TOOL_GROUNDED_COMMITMENTS } from '../src/host/chatContext.js';

const TENANT = 'default';
const TOOL = 'openwop:kanban.add-todo';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function runTool(input: Record<string, unknown>, scope: { actingUserId?: string; agentProfileId?: string; runId?: string }): Promise<{ content: string; isError?: boolean }> {
  const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-adr0311', ...scope });
  return provider.executeTool({ name: TOOL, input });
}

describe('ADR 0311 P1 — openwop:kanban.add-todo', () => {
  it('registers as a core builtin (namespace derived for the per-tool gate)', () => {
    expect(builtinAgentToolIds()).toContain(TOOL);
    expect(builtinToolNamespaces()).toContain('openwop:kanban');
  });

  it('fails closed without an acting user / an agent', async () => {
    expect(JSON.parse((await runTool({ title: 'T' }, { agentProfileId: 'host:iris' })).content)).toMatchObject({ error: 'acting_user_required' });
    expect(JSON.parse((await runTool({ title: 'T' }, { actingUserId: 'u-1' })).content)).toMatchObject({ error: 'agent_required' });
  });

  it('validates the title and the tz-explicit due date (the GC-R3 rule)', async () => {
    const scope = { actingUserId: 'u-1', agentProfileId: 'host:iris' };
    expect(JSON.parse((await runTool({ title: '  ' }, scope)).content)).toMatchObject({ error: 'validation_error' });
    expect(JSON.parse((await runTool({ title: 'T', dueAtISO: '2026-08-01T15:00:00' }, scope)).content)).toMatchObject({ error: 'validation_error' });
  });

  it('provisions the agent’s own board and files the card in the heartbeat-compatible todo column — with NO workflow binding', async () => {
    const entry = await createRosterEntry({ tenantId: TENANT, persona: 'Iris Todo', agentRef: { agentId: 'user.default.iris-todo' } });
    const out = await runTool(
      { title: 'Chase the platform team for mitigation plans', detail: 'Context: Q3 rollout uptime.', dueAtISO: '2026-08-01T15:00:00Z' },
      { actingUserId: 'u-filer', agentProfileId: entry.rosterId },
    );
    expect(out.isError, out.content).toBeFalsy();
    const payload = JSON.parse(out.content) as { filed: boolean; cardId: string; title: string; column: string };
    expect(payload.filed).toBe(true);
    expect(payload.column).toBe('To Do');
    const board = await getBoard(subjectBoardId(TENANT, { kind: 'agent', id: entry.rosterId }));
    expect(board?.ownerSubject).toEqual({ kind: 'agent', id: entry.rosterId });
    const todo = board!.columns.find((c) => c.id === 'todo')!;
    const card = (await listCards(board!.id)).find((c) => c.id === payload.cardId);
    expect(card?.columnId).toBe(todo.id);
    expect(card?.source).toBe('agent');
    expect(card?.sourceLabel).toBe('Iris Todo');
    expect(card?.createdBy).toBe('u-filer');
    expect(card?.dueAt).toBe('2026-08-01T15:00:00.000Z');
    // The honest floor: a bare todo carries NO workflow — the heartbeat's
    // `if (!workflowId) continue` skips it until a human (or the column
    // trigger) arms it. Filed work item, not auto-executed work.
    expect(card?.workflowId).toBeUndefined();
  });

  it('an identical retried call returns the SAME card (deterministic id — no duplicate todos)', async () => {
    const entry = await createRosterEntry({ tenantId: TENANT, persona: 'Retry Agent', agentRef: { agentId: 'user.default.retry-todo' } });
    const scope = { actingUserId: 'u-filer', agentProfileId: entry.rosterId };
    const input = { title: 'Same commitment', detail: 'Same detail.' };
    const a = JSON.parse((await runTool(input, scope)).content) as { cardId: string };
    const b = JSON.parse((await runTool(input, scope)).content) as { cardId: string };
    expect(b.cardId).toBe(a.cardId);
    const board = await getBoard(subjectBoardId(TENANT, { kind: 'agent', id: entry.rosterId }));
    expect((await listCards(board!.id)).filter((c) => c.title === 'Same commitment')).toHaveLength(1);
  });

  it('the P0 scaffold names the three grounding paths (ADR 0311 D1)', () => {
    expect(TOOL_GROUNDED_COMMITMENTS).toContain('DO it now with tools');
    expect(TOOL_GROUNDED_COMMITMENTS).toContain('SCHEDULE it with a scheduling tool');
    expect(TOOL_GROUNDED_COMMITMENTS).toContain('FILE it as a todo');
    expect(TOOL_GROUNDED_COMMITMENTS).toContain('A bare unfiled promise is forbidden');
  });
});

describe('ADR 0311 P2 — the provenance chain: chat-filed todo → heartbeat proposal → the originating chat', () => {
  it('carries the conversation from the filed card onto the approval and the review projection filter finds it', async () => {
    const { updateRosterEntry } = await import('../src/host/rosterService.js');
    const { updateCardFields } = await import('../src/host/kanbanService.js');
    const { runHeartbeatOnce } = await import('../src/host/heartbeatService.js');
    const { getApproval } = await import('../src/host/approvalService.js');
    const { listReviews } = await import('../src/host/reviewProjection.js');
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');

    const entry = await createRosterEntry({ tenantId: TENANT, persona: 'Chain Agent', agentRef: { agentId: 'user.default.chain-todo' } });
    await updateRosterEntry(entry.tenantId, entry.rosterId, { autonomyLevel: 'review' }); // "agents propose, humans dispose"

    // 1. Filed FROM a chat (the tool scope carries the conversation, ADR 0309 threading).
    const provider = createAgentToolProvider({ tenantId: TENANT, runId: 'run-chain', actingUserId: 'u-chain', agentProfileId: entry.rosterId, conversationId: 'conv-origin' });
    const out = await provider.executeTool({ name: TOOL, input: { title: 'Prepare the uptime digest' } });
    const payload = JSON.parse(out.content) as { cardId: string };
    const board = await getBoard(subjectBoardId(TENANT, { kind: 'agent', id: entry.rosterId }));
    const card = (await listCards(board!.id)).find((c) => c.id === payload.cardId)!;
    expect(card.sourceConversationId).toBe('conv-origin');

    // 2. A human arms the card with a workflow; the review-autonomy heartbeat PROPOSES.
    await updateCardFields(card.id, { workflowId: 'wf-digest' });
    const fresh = (await import('../src/host/rosterService.js')).getRosterEntry;
    const armed = (await fresh(entry.tenantId, entry.rosterId))!;
    const hostSuite: import('../src/host/runStarter.js').StartRunDeps['hostSuite'] = {
      workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
      providerPolicyResolver: { resolveForRun: async () => [] },
    };
    const deps: import('../src/host/runStarter.js').StartRunDeps = { storage: hostExtStorage(), hostSuite };
    const result = await runHeartbeatOnce(deps, armed);
    expect(result.proposed, JSON.stringify(result)).toBe(true);

    // 3. The approval traces back to the ORIGINATING conversation…
    const approval = (await getApproval(result.approvalId!))!;
    expect(approval.conversationId).toBe('conv-origin');
    expect(approval.cardId).toBe(card.id);

    // 4. …and the projection's conversation filter surfaces it (post-authz narrowing).
    const reviews = await listReviews(hostExtStorage(), { tenantId: TENANT }, { conversationId: 'conv-origin' });
    expect(reviews.some((r) => r.approvalId === approval.approvalId)).toBe(true);
    const other = await listReviews(hostExtStorage(), { tenantId: TENANT }, { conversationId: 'conv-unrelated' });
    expect(other.some((r) => r.approvalId === approval.approvalId)).toBe(false);

    // 5. …and the P3 board filter narrows the same way (the board's Needs-review lane).
    const byBoard = await listReviews(hostExtStorage(), { tenantId: TENANT }, { boardId: board!.id });
    expect(byBoard.some((r) => r.approvalId === approval.approvalId)).toBe(true);
    const wrongBoard = await listReviews(hostExtStorage(), { tenantId: TENANT }, { boardId: 'board-nope' });
    expect(wrongBoard.some((r) => r.approvalId === approval.approvalId)).toBe(false);
  });
});

describe('grade-pass GC-0311-1 — a caller-supplied cardId never overwrites another board\u2019s card', () => {
  it('createCard fails closed on a cross-board id collision', async () => {
    const { createCard, ensureSubjectBoard } = await import('../src/host/kanbanService.js');
    const a = await ensureSubjectBoard(TENANT, { kind: 'agent', id: 'host:collide-a' });
    const b = await ensureSubjectBoard(TENANT, { kind: 'agent', id: 'host:collide-b' });
    const todoA = a.columns.find((c) => c.id === 'todo')!;
    const todoB = b.columns.find((c) => c.id === 'todo')!;
    const first = await createCard({ boardId: a.id, columnId: todoA.id, title: 'Original', cardId: 'card-todo-collide' });
    await expect(createCard({ boardId: b.id, columnId: todoB.id, title: 'Impostor', cardId: 'card-todo-collide' })).rejects.toThrow(/collision/);
    // The original card is untouched.
    const survivors = (await listCards(a.id)).filter((c) => c.id === first.id);
    expect(survivors[0]?.title).toBe('Original');
  });

  it('two agents filing IDENTICAL text in the same run get DISTINCT cards (agent discriminator in the hash)', async () => {
    const e1 = await createRosterEntry({ tenantId: TENANT, persona: 'Twin One', agentRef: { agentId: 'user.default.twin-1' } });
    const e2 = await createRosterEntry({ tenantId: TENANT, persona: 'Twin Two', agentRef: { agentId: 'user.default.twin-2' } });
    const input = { title: 'Identical commitment' };
    const p1 = createAgentToolProvider({ tenantId: TENANT, runId: 'run-twins', actingUserId: 'u-twin', agentProfileId: e1.rosterId });
    const p2 = createAgentToolProvider({ tenantId: TENANT, runId: 'run-twins', actingUserId: 'u-twin', agentProfileId: e2.rosterId });
    const c1 = JSON.parse((await p1.executeTool({ name: TOOL, input })).content) as { cardId: string; filed?: boolean; error?: string };
    const c2 = JSON.parse((await p2.executeTool({ name: TOOL, input })).content) as { cardId: string; filed?: boolean; error?: string };
    expect(c1.filed, JSON.stringify(c1)).toBe(true);
    expect(c2.filed, JSON.stringify(c2)).toBe(true);
    expect(c2.cardId).not.toBe(c1.cardId);
  });
});
