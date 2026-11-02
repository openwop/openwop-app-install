/**
 * Autonomous heartbeat daemon (host/heartbeatService.ts).
 *
 *   - a member with no heartbeatIntervalMs is never auto-checked (manual only)
 *   - a member due for a heartbeat picks a To Do card and starts its run
 *   - a member checked within its interval is not re-run
 *   - a disabled member is never auto-checked
 *   - MULTI-INSTANCE: two concurrent passes run the member's heartbeat once
 *
 * The interval and multi-instance cases give the member TWO To Do cards, so a
 * second pick would find work: with one card the moved card alone made a re-run
 * pick nothing, and the interval / slot-claim guards were never the reason for the
 * "0". The concurrent case FORCES both passes into `claimOnce` together (a one-shot
 * hold on the first caller), so the slot claim is what decides.
 *
 * Tracker TST-DFB-4. Red when (w71g1, witnessed): a disabled member is due; the
 * interval check is dropped; the per-slot claim is ignored; a bare-card fallback
 * pick runs instead of proposing, or its frozen task drops the description; an
 * unregistered fallback still picks bare cards; the host default cadence is 0.
 *
 * @see RFCS/0086-standing-agent-roster-and-workflow-portfolio.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createRosterEntry,
  updateRosterEntry,
  __resetRosterStore,
  listRosterTenants,
  autonomyOf,
  type RosterEntry,
} from '../src/host/rosterService.js';
import { createBoard, createCard, __resetKanbanStore } from '../src/host/kanbanService.js';
import { processDueHeartbeats, registerAgentTurnFallback } from '../src/host/heartbeatService.js';
import { getApproval, listApprovals } from '../src/host/approvalService.js';
import { createHostAdapterSuite } from '../src/host/index.js';
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
async function makeAgentWithTask(over: Partial<Parameters<typeof createRosterEntry>[0]> = {}, cardCount = 1): Promise<RosterEntry> {
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
  for (let i = 0; i < cardCount; i += 1) await createCard({ boardId: board.id, columnId: todo.id, title: `Do the thing ${i + 1}` });
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
    // The stamp is written with the wall clock, so fake only Date to put it at the pass
    // time. The second pass is in the NEXT slot (NOW is hour-aligned; slot = 1 h), so
    // the per-slot claim cannot be what refuses it — only the interval check can.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const entry = await makeAgentWithTask({ heartbeatIntervalMs: 3_600_000 }, 2);
      const t1 = NOW + 1_800_000;
      vi.setSystemTime(t1);
      expect(await processDueHeartbeats(deps, listRosterTenants, t1)).toBe(1); // stamps t1
      const t2 = NOW + 3_660_000; // next slot, 31 min after the stamp → not due
      vi.setSystemTime(t2);
      expect(await processDueHeartbeats(deps, listRosterTenants, t2)).toBe(0);
      expect(await heartbeatRuns(entry.rosterId)).toHaveLength(1);
      // Positive control: one full interval after the stamp it IS due, and the second card is picked.
      const t3 = t1 + 3_600_000;
      vi.setSystemTime(t3);
      expect(await processDueHeartbeats(deps, listRosterTenants, t3)).toBe(1);
      expect(await heartbeatRuns(entry.rosterId)).toHaveLength(2);
    } finally { vi.useRealTimers(); }
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
    const entry = await makeAgentWithTask({ heartbeatIntervalMs: 60_000 }, 2);
    // Force the race: park the first claimOnce caller until the second arrives (2 s
    // fallback), so both passes have listed the member as due and both reach the claim.
    const realClaim = storage.claimOnce.bind(storage);
    let arrivals = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((r) => { release = r; });
    storage.claimOnce = async (key, createdAt) => {
      if (key.startsWith('heartbeat:')) {
        arrivals += 1;
        if (arrivals === 1) await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 2_000))]);
        else release();
      }
      return realClaim(key, createdAt);
    };
    try {
      const [a, b] = await Promise.all([
        processDueHeartbeats(deps, listRosterTenants, NOW),
        processDueHeartbeats(deps, listRosterTenants, NOW),
      ]);
      expect(arrivals).toBe(2);
      expect(a + b).toBe(1);
      expect(await heartbeatRuns(entry.rosterId)).toHaveLength(1);
    } finally { storage.claimOnce = realClaim; }
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
    expect(autonomyOf(entry)).toBe('auto'); // the claim is "even for auto": the default level
    const res = await processDueHeartbeats(deps, listRosterTenants, NOW);
    expect(res).toBe(1); // a proposal IS a pick — but it must NOT have started a run:
    expect(await heartbeatRuns(entry.rosterId)).toHaveLength(0);
    const pending = (await listApprovals(TENANT, 'pending')).filter((a) => a.rosterId === entry.rosterId);
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
    const a = (await listApprovals(TENANT, 'pending')).find((x) => x.rosterId === entry.rosterId)!;
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
    expect((await listApprovals(TENANT, 'pending')).filter((a) => a.rosterId === entry.rosterId)).toHaveLength(0);
  });
});
