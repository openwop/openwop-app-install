/**
 * Autonomous heartbeat daemon (host/heartbeatService.ts).
 *
 *   - a member with no heartbeatIntervalMs is never auto-checked (manual only)
 *   - a member due for a heartbeat picks a To Do card and starts its run
 *   - a member checked within its interval is not re-run
 *   - a disabled member is never auto-checked
 *   - MULTI-INSTANCE: two concurrent passes run the member's heartbeat once
 *
 * @see RFCS/0086-standing-agent-roster-and-workflow-portfolio.md
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createRosterEntry,
  updateRosterEntry,
  __resetRosterStore,
  listRosterTenants,
  type RosterEntry,
} from '../src/host/rosterService.js';
import { createBoard, createCard, __resetKanbanStore } from '../src/host/kanbanService.js';
import { processDueHeartbeats, registerAgentTurnFallback } from '../src/host/heartbeatService.js';
import { getApproval } from '../src/host/approvalService.js';
import { claimApproval } from '../src/host/approvalDecision.js';

// Fully typed against the narrowed StartRunDeps['hostSuite'] — no cast.
const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let deps: StartRunDeps;

const TENANT = 't1';
const NOW = Date.parse('2026-06-02T12:00:00Z');

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetRosterStore();
  await __resetKanbanStore();
  deps = { storage, hostSuite };
});
afterEach(() => {
  __resetHostExtPersistence();
});

/** Create a member with a board carrying one To Do card that triggers a wf. */
async function makeAgentWithTask(over: Partial<Parameters<typeof createRosterEntry>[0]> = {}): Promise<RosterEntry> {
  const entry = await createRosterEntry({
    tenantId: TENANT,
    persona: 'Sally',
    agentRef: { agentId: 'host:demo-sales' },
    workflows: ['wf-1'],
    ...over,
  });
  const board = await createBoard({
    tenantId: TENANT,
    name: 'Sally board',
    rosterId: entry.rosterId,
    triggerWorkflowId: 'wf-1',
  });
  const todo = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do')!;
  await createCard({ boardId: board.id, columnId: todo.id, title: 'Do the thing' });
  return entry;
}

async function heartbeatRuns(rosterId: string) {
  const runs = await storage.listRuns({ limit: 100 });
  return runs.filter((r) => {
    const block = (r.metadata as Record<string, unknown>)?.heartbeat as Record<string, unknown> | undefined;
    return block?.rosterId === rosterId;
  });
}

describe('heartbeatService — autonomous daemon', () => {
  it('ADR 0313 D1: an UNCONFIGURED member is auto-checked on the host default cadence', async () => {
    const entry = await makeAgentWithTask(); // no interval -> host default applies
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(1);
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(1);
  });

  it('ADR 0313 D1: OPENWOP_HEARTBEAT_DEFAULT_MS=0 restores the opt-in world (manual only)', async () => {
    process.env.OPENWOP_HEARTBEAT_DEFAULT_MS = '0';
    try {
      const entry = await makeAgentWithTask(); // no interval
      expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(0);
      expect(await heartbeatRuns(entry.rosterId)).toHaveLength(0);
    } finally { delete process.env.OPENWOP_HEARTBEAT_DEFAULT_MS; }
  });

  it('ADR 0313 D1: explicit -1 is deliberately OFF even under the host default', async () => {
    const entry = await makeAgentWithTask({ heartbeatIntervalMs: -1 });
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(0);
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(0);
  });

  it('auto-checks a due member: picks a To Do card and starts its run', async () => {
    const entry = await makeAgentWithTask({ heartbeatIntervalMs: 60_000 });
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(1);
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(1);
  });

  it('does not re-run a member checked within its interval', async () => {
    const entry = await makeAgentWithTask({ heartbeatIntervalMs: 3_600_000 });
    // First pass checks it (stamps lastHeartbeatAt = NOW).
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(1);
    // 10 minutes later — still inside the 1h interval → not due.
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW + 600_000)).toBe(0);
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(1);
  });

  it('does not auto-check a disabled member', async () => {
    const entry = await makeAgentWithTask({ heartbeatIntervalMs: 60_000, enabled: false });
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(0);
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(0);

    // Re-enabling makes it eligible.
    await updateRosterEntry(entry.tenantId, entry.rosterId, { enabled: true });
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(1);
  });

  it('runs a due member once across two concurrent instances', async () => {
    const entry = await makeAgentWithTask({ heartbeatIntervalMs: 60_000 });
    const [a, b] = await Promise.all([
      processDueHeartbeats(deps, listRosterTenants, NOW),
      processDueHeartbeats(deps, listRosterTenants, NOW),
    ]);
    expect(a + b).toBe(1);
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(1);
  });
});


describe('ADR 0313 D2 — the bare-card fallback (always through the propose gate)', () => {
  afterEach(() => registerAgentTurnFallback(null));

  async function makeAgentWithBareCard(sourceConversationId?: string) {
    const entry = await createRosterEntry({ tenantId: TENANT, persona: 'Bare Bob', agentRef: { agentId: 'host:bare-bob' }, workflows: [] });
    const board = await createBoard({ tenantId: TENANT, name: 'Bob board', rosterId: entry.rosterId }); // NO trigger
    const todo = board.columns.find((c) => c.id === 'todo')!;
    await createCard({ boardId: board.id, columnId: todo.id, title: 'Summarize the incident log', description: 'Focus on the last 24h.', ...(sourceConversationId ? { sourceConversationId } : {}) });
    return entry;
  }

  it('a bare card PROPOSES the agent-turn even for auto autonomy, freezing the task onto the approval', async () => {
    registerAgentTurnFallback({ workflowId: 'openwop-app.scheduled-chat.turn', credentialRef: 'managed:openwop-free' });
    const entry = await makeAgentWithBareCard('conv-bare-origin');
    const res = await processDueHeartbeats(deps, listRosterTenants, NOW);
    expect(res).toBe(1); // a proposal IS a pick — but it must NOT have started a run:
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(0);
    const approvals = (await import('../src/host/approvalService.js')).listApprovals;
    const pending = (await approvals(TENANT, 'pending')).filter((a) => a.rosterId === entry.rosterId);
    expect(pending).toHaveLength(1);
    const a = pending[0]!;
    expect(a.workflowId).toBe('openwop-app.scheduled-chat.turn');
    expect(a.conversationId).toBe('conv-bare-origin'); // ADR 0311 chain intact
    expect(a.configurable).toMatchObject({ agentId: 'host:bare-bob', credentialRef: 'managed:openwop-free', conversationId: 'conv-bare-origin' });
    expect(String(a.configurable?.['task'])).toContain('Summarize the incident log');
    expect(String(a.configurable?.['task'])).toContain('Focus on the last 24h.');
  });

  it('approving the fallback dispatches WITH the frozen configurable (agent-runner gets its variables)', async () => {
    registerAgentTurnFallback({ workflowId: 'openwop-app.scheduled-chat.turn', credentialRef: 'managed:openwop-free' });
    const entry = await makeAgentWithBareCard();
    await processDueHeartbeats(deps, listRosterTenants, NOW);
    const listApprovals = (await import('../src/host/approvalService.js')).listApprovals;
    const a = (await listApprovals(TENANT, 'pending')).find((x) => x.rosterId === entry.rosterId)!;
    const { createHostAdapterSuite } = await import('../src/host/index.js');
    // Full suite for the decision path, but keep the harness's permissive catalog
    // so the registered fallback workflow id resolves.
    const decisionDeps = { storage, hostSuite: { ...createHostAdapterSuite({ storage }), workflowCatalog: hostSuite.workflowCatalog } };
    const decided = await claimApproval(decisionDeps, { tenantId: TENANT, decidedBy: 'approver-1' }, a.approvalId);
    expect(decided.status).toBe('approved');
    const approved = (await getApproval(a.approvalId))!;
    const run = await storage.getRun(approved.runId!);
    expect(run?.configurable).toMatchObject({ agentId: 'host:bare-bob' });
    expect(String((run?.configurable as Record<string, unknown>)?.['task'])).toContain('Summarize the incident log');
  });

  it('an UNREGISTERED fallback seam skips bare cards exactly as before (honest degradation)', async () => {
    const entry = await makeAgentWithBareCard();
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(0);
    const listApprovals = (await import('../src/host/approvalService.js')).listApprovals;
    expect((await listApprovals(TENANT, 'pending')).filter((a) => a.rosterId === entry.rosterId)).toHaveLength(0);
  });
});
