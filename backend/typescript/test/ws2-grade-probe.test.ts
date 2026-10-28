/**
 * ADR 0963 — the phase witnesses for the heartbeat work loop's fairness and stop
 * fixes. Feature loop round 2 (row 54) wrote these as grade probes; all were red
 * on `ea8f54f81`, and ADR 0963 D1–D6 turned each one green. The ADR's phase table
 * cites this file by name, so keep the name and keep one `describe` per finding:
 *
 *   - `WS2WF-1` (D1 + D2, P1): every tenant gets its heartbeat in one pass, even
 *     when its members' persona-scoped roster ids collide, and members the pass
 *     skips cannot crowd a later tenant out of the batch. That second case rests
 *     on TWO guards (sabotage, 8f W6): a budget-refused member is examined but not
 *     served, so it never fills `CHECK_BATCH`; and from the next pass the budget
 *     backoff skips its tenant uncounted. Removing either alone stays green, and
 *     removing both is red. The stalest-first order is not what it tests;
 *   - `WS2WF-2/3` (D3, P2): a cancelled or failed run's card is held, not re-run;
 *   - `WS2WF-4` (D5, P3): the loop's own heartbeat writes do not defeat the
 *     ADR 0804 roster cache;
 *   - `WS2WF-5` (D6, P4): the replay stamp comes from the pass's own decisions, so
 *     another workspace ranking mid-pick cannot erase it;
 *   - `WS2WF-6` (D4, P2): a completed run clears the machine restore note.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createRosterEntry, getRosterEntry, listRosterTenants, __resetRosterStore, type RosterEntry,
} from '../src/host/rosterService.js';
import { createBoard, createCard, getCard, moveCard, workingColumnOf, setCardLastRun, updateCardFields, __resetKanbanStore, type KanbanBoard } from '../src/host/kanbanService.js';
import {
  __resetHeartbeatBudgetBackoff, cachedRosterEntries, rankWorkCandidates, processDueHeartbeats, registerWorkSelectionCompiler, runHeartbeatOnce,
} from '../src/host/heartbeatService.js';
import { recoverCardForTerminalRun } from '../src/host/cardRunRecovery.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};
const NOW = Date.parse('2026-06-02T12:00:00Z');
let storage: Storage;
let deps: StartRunDeps;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetRosterStore();
  await __resetKanbanStore();
  deps = { storage, hostSuite };
});
afterEach(() => {
  registerWorkSelectionCompiler(null);
  __resetHeartbeatBudgetBackoff();
  delete process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT;
  __resetHostExtPersistence();
});

async function member(tenantId: string, persona = 'Sally'): Promise<{ entry: RosterEntry; board: KanbanBoard; cardId: string }> {
  const entry = await createRosterEntry({ tenantId, persona, agentRef: { agentId: 'host:demo-sales' }, workflows: ['wf-1'] });
  const board = await createBoard({ tenantId, name: `${persona} board`, rosterId: entry.rosterId, triggerWorkflowId: 'wf-1' });
  const todo = board.columns.find((c) => c.id === 'todo')!;
  const card = await createCard({ boardId: board.id, columnId: todo.id, title: 'Do the thing' });
  return { entry, board, cardId: card.id };
}

describe('WS2WF-1 — the fleet pass serves every tenant', () => {
  it('two tenants whose agents share a persona both get their heartbeat in one pass', async () => {
    const a = await member('tenant-a');
    const b = await member('tenant-b');
    expect(a.entry.rosterId).toBe(b.entry.rosterId); // ADR 0379: persona-scoped ids collide across tenants
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW)).toBe(2);
  });

  it('members the pass skips do not keep a later tenant out of the batch', async () => {
    process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT = '1';
    const head: RosterEntry[] = [];
    for (let i = 0; i < 50; i += 1) head.push((await member('tenant-a', `A${i}`)).entry);
    const late = await member('tenant-z', 'Zed');
    // The listing order is the store's; pin it so tenant-a's 50 members lead.
    const listing = async () => [...head, late.entry];
    expect((await getRosterEntry('tenant-z', late.entry.rosterId))?.lastHeartbeatAt).toBeUndefined();
    for (let pass = 0; pass < 3; pass += 1) {
      await processDueHeartbeats(deps, listRosterTenants, NOW + pass * 700_000, listing);
    }
    expect((await getRosterEntry('tenant-z', late.entry.rosterId))?.lastHeartbeatAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});

describe('WS2WF-2/3 — a run the loop started does not come straight back', () => {
  for (const status of ['cancelled', 'failed'] as const) {
    it(`a ${status} run's card is not re-run by the next pass`, async () => {
      const m = await member('t1');
      const first = await runHeartbeatOnce(deps, m.entry);
      expect(first.runId).toBeDefined();
      await storage.updateRun(first.runId!, { status });
      expect(await recoverCardForTerminalRun(storage, first.runId!, status)).toBe(true);
      const second = await runHeartbeatOnce(deps, (await getRosterEntry('t1', m.entry.rosterId))!);
      expect(second.runId).toBeUndefined();
    });
  }
});

describe('WS2WF-4 — the roster cache survives the loop doing its job', () => {
  it('a pass that heartbeats a member does not force the next tick to re-list every tenant', async () => {
    await member('t1');
    let lists = 0;
    const entries = cachedRosterEntries(async () => { lists += 1; return listRosterTenants(); }, () => NOW);
    await processDueHeartbeats(deps, listRosterTenants, NOW, entries);
    await processDueHeartbeats(deps, listRosterTenants, NOW + 30_000, entries);
    expect(lists).toBe(1);
  });
});

describe('WS2WF-5 — the ranking stamp belongs to the pass that ranked', () => {
  it('a pass that ranks while another is mid-pick does not erase the other pass\'s decision', async () => {
    const a = await member('t-a');
    registerWorkSelectionCompiler((cards) => cards.map((card, i) => ({ card, rank: i + 1, score: 1, scores: { x: 1 } })));
    // Another workspace's pass ranks at the moment this pass claims its card —
    // the window between ranking and run start that the stamp has to survive.
    const cas = storage.kvCompareAndSwap.bind(storage);
    let fired = false;
    storage.kvCompareAndSwap = (async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      if (!fired && String(args[0]).includes('kanban:card')) { fired = true; void rankWorkCandidates([], NOW, 't-b'); }
      return cas(...args);
    }) as Storage['kvCompareAndSwap'];
    const ra = await runHeartbeatOnce(deps, a.entry);
    expect(fired).toBe(true);
    // Rank 1 of the ONE card this pass ranked; another pass's empty ranking must not
    // reach this stamp (it would read null, or `candidates: 0`).
    expect(((await storage.getRun(ra.runId!))?.metadata as Record<string, unknown>).workSelection).toMatchObject({ rank: 1, candidates: 1 });
  });
});

describe('WS2WF-6 — a machine restore note does not outlive the next good run', () => {
  it('a completed run on the card clears the restore note it no longer describes', async () => {
    const m = await member('t1');
    await updateCardFields(m.cardId, { blockerNote: 'waiting on legal\n[auto:run-restore] Returned to To Do — its run (r0) failed.' });
    await setCardLastRun(m.cardId, 'r1', 'running');
    expect(await moveCard(m.cardId, workingColumnOf(m.board)!.id)).not.toBeNull();
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: 'r1', tenantId: 't1', workflowId: 'wf-1', status: 'completed', inputs: {},
      metadata: { kanban: { boardId: m.board.id, cardId: m.cardId } }, configurable: {}, createdAt: now, updatedAt: now,
    });
    await recoverCardForTerminalRun(storage, 'r1', 'completed');
    expect((await getCard(m.cardId))?.blockerNote).toBe('waiting on legal');
  });
});
