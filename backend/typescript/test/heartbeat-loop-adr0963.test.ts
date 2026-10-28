/**
 * ADR 0963 — the guards behind the row-54 fixes, one test per guard so each can
 * be sabotage-witnessed on its own (the grade probes in `ws2-grade-probe.test.ts`
 * cover the headline behaviour and would stay green under some single sabotages,
 * because several guards layer).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createRosterEntry, getRosterEntry, listRosterTenants, recordHeartbeat, __resetRosterStore, type RosterEntry,
} from '../src/host/rosterService.js';
import {
  eraseSubjectKanban, RESTORE_NOTE_MARK, createBoard, createCard, getCard, moveCard, workingColumnOf, setCardLastRun, updateCardFields, __resetKanbanStore, type KanbanBoard,
} from '../src/host/kanbanService.js';
import { __resetHeartbeatBudgetBackoff, cachedRosterEntries, processDueHeartbeats, runHeartbeatOnce } from '../src/host/heartbeatService.js';
import { ERASED } from '../src/host/subjectErasureRedaction.js';
import { recoverCardForTerminalRun } from '../src/host/cardRunRecovery.js';
import { readBoardRanking } from '../src/features/work-selection/agentTools.js';
import { isWorkTwinMockArchive, WORKFLOW_TEMPLATE_CHAIN_IDS } from '../src/host/workflowTemplates.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};
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
  __resetHeartbeatBudgetBackoff();
  delete process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT;
  __resetHostExtPersistence();
});

async function member(tenantId: string, persona: string, withCard = true): Promise<{ entry: RosterEntry; board: KanbanBoard; cardId: string | null }> {
  const entry = await createRosterEntry({ tenantId, persona, agentRef: { agentId: 'host:demo-sales' }, workflows: ['wf-1'] });
  const board = await createBoard({ tenantId, name: `${persona} board`, rosterId: entry.rosterId, triggerWorkflowId: 'wf-1' });
  const card = withCard ? await createCard({ boardId: board.id, columnId: 'todo', title: `${persona} task` }) : null;
  return { entry, board, cardId: card?.id ?? null };
}

const stamped = async (tenantId: string, rosterId: string) => (await getRosterEntry(tenantId, rosterId))?.lastHeartbeatAt;

describe('D2 — fair batch', () => {
  it('serves the never-checked member before members checked earlier (stalest first)', async () => {
    const early: RosterEntry[] = [];
    for (let i = 0; i < 55; i += 1) {
      const m = await member('tenant-a', `A${i}`, false);
      await recordHeartbeat('tenant-a', m.entry.rosterId);
      early.push((await getRosterEntry('tenant-a', m.entry.rosterId))!);
    }
    const late = await member('tenant-a', 'Zed', false);
    // Due again: a pass far enough after every stamp. Listed LAST.
    const listing = async () => [...early, late.entry];
    await processDueHeartbeats(deps, listRosterTenants, Date.now() + 3_600_000, listing);
    expect(await stamped('tenant-a', late.entry.rosterId)).toBeDefined();
  });

  it('a member whose claim another instance holds does not use up a batch slot', async () => {
    const now = Date.parse('2026-06-02T12:00:00Z');
    const head: RosterEntry[] = [];
    for (let i = 0; i < 50; i += 1) head.push((await member('tenant-a', `A${i}`, false)).entry);
    const late = await member('tenant-b', 'Zed', false);
    // Another instance is mid-pass on all 50 for this slot.
    const slot = Math.floor(now / 600_000);
    for (const e of head) await storage.claimOnce(`heartbeat:${e.tenantId}:${e.rosterId}:${slot}`, new Date(now).toISOString());
    await processDueHeartbeats(deps, listRosterTenants, now, async () => [...head, late.entry]);
    expect(await stamped('tenant-b', late.entry.rosterId)).toBeDefined();
  });

  it('an over-budget tenant with more members than the examine cap does not starve the next tenant', async () => {
    process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT = '1';
    const head: RosterEntry[] = [];
    for (let i = 0; i < 210; i += 1) head.push((await member('tenant-a', `A${i}`, false)).entry);
    const late = await member('tenant-b', 'Zed', false);
    await processDueHeartbeats(deps, listRosterTenants, Date.parse('2026-06-02T12:00:00Z'), async () => [...head, late.entry]);
    expect(await stamped('tenant-b', late.entry.rosterId)).toBeDefined();
  }, 60_000);

  it('over-budget tenants do not burn a claim per tick until a slot serves nobody', async () => {
    // grade-code finding: the claim precedes the budget check, so each tick of
    // one slot burned one more claim per refused tenant; the burnt members stay
    // stalest and pile up at the head until MAX_EXAMINED is spent on them.
    process.env.OPENWOP_AUTONOMOUS_RUN_LIMIT = '1';
    const head: RosterEntry[] = [];
    for (let t = 0; t < 12; t += 1) {
      for (let i = 0; i < 20; i += 1) head.push((await member(`tenant-${String(t).padStart(2, '0')}`, `M${i}`, false)).entry);
    }
    const slotStart = Math.floor(Date.parse('2026-06-02T12:00:00Z') / 600_000) * 600_000;
    // Use up every refused tenant's budget on the first tick, then keep ticking
    // inside the same slot; a NEW tenant arriving late must still be served.
    await processDueHeartbeats(deps, listRosterTenants, slotStart, async () => head);
    for (let tick = 1; tick < 19; tick += 1) {
      await processDueHeartbeats(deps, listRosterTenants, slotStart + tick * 30_000, async () => head);
    }
    const late = await member('tenant-zz', 'Zed', false);
    await processDueHeartbeats(deps, listRosterTenants, slotStart + 19 * 30_000, async () => [...head, late.entry]);
    expect(await stamped('tenant-zz', late.entry.rosterId)).toBeDefined();
  }, 120_000);
});

describe('D5 — the cached listing learns from the pass', () => {
  it('a member the pass stamped reads as stamped in the cache, without a re-list', async () => {
    const m = await member('t1', 'Sally', false);
    const entries = cachedRosterEntries(listRosterTenants, () => Date.now());
    await processDueHeartbeats(deps, listRosterTenants, Date.parse('2026-06-02T12:00:00Z'), entries);
    const cached = (await entries()).find((e) => e.rosterId === m.entry.rosterId);
    expect(cached?.lastHeartbeatAt).toBeDefined();
  });
});

describe('D3 — held cards', () => {
  it('erases private hold prose while keeping work held and other subjects/tenants unchanged', async () => {
    const m = await member('t1', 'Sally');
    await updateCardFields(m.cardId!, { createdBy: 'alice', blockerNote: `private reason\n${RESTORE_NOTE_MARK} failed (private-run-id)` });
    const other = await createCard({ boardId: m.board.id, columnId: 'done', title: 'Other person', createdBy: 'bob', blockerNote: 'their private note' });
    const elsewhere = await createBoard({ tenantId: 't2', name: 'Other tenant' });
    const foreign = await createCard({ boardId: elsewhere.id, columnId: 'todo', title: 'Foreign', createdBy: 'alice', blockerNote: 'foreign private note' });
    const otherBefore = await getCard(other.id);
    const foreignBefore = await getCard(foreign.id);
    await eraseSubjectKanban('t1', 'user:alice');
    const erased = await getCard(m.cardId!);
    expect(erased).toMatchObject({ title: ERASED, createdBy: ERASED, blockerNote: `${ERASED}\n${RESTORE_NOTE_MARK}` });
    expect(await runHeartbeatOnce(deps, m.entry)).toMatchObject({ picked: false, reason: 'held' });
    expect(await storage.listRuns({ limit: 10 })).toHaveLength(0);
    expect(await getCard(other.id)).toEqual(otherBefore);
    expect(await getCard(foreign.id)).toEqual(foreignBefore);
    await eraseSubjectKanban('t1', 'user:alice');
    expect(await getCard(m.cardId!)).toEqual(erased);
  });

  it('a restore arriving during erasure keeps its hold and unrelated latest edits', async () => {
    const m = await member('t1', 'Sally');
    await updateCardFields(m.cardId!, { createdBy: 'alice', blockerNote: 'private text' });
    const cas = storage.kvCompareAndSwap.bind(storage);
    let raced = false;
    storage.kvCompareAndSwap = async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      if (!raced && args[0].includes('kanban:card')) {
        raced = true;
        await updateCardFields(m.cardId!, { blockerNote: `${RESTORE_NOTE_MARK} failed (private-run-id)`, priority: 'high' });
      }
      return cas(...args);
    };
    await eraseSubjectKanban('t1', 'alice');
    expect(raced).toBe(true);
    expect(await getCard(m.cardId!)).toMatchObject({ createdBy: ERASED, title: ERASED, priority: 'high', blockerNote: `${ERASED}\n${RESTORE_NOTE_MARK}` });
    expect(await runHeartbeatOnce(deps, m.entry)).toMatchObject({ picked: false, reason: 'held' });
    expect(await storage.listRuns({ limit: 10 })).toHaveLength(0);
  });

  it('reports incomplete erasure when every conditional card write loses', async () => {
    const m = await member('t1', 'Sally');
    await updateCardFields(m.cardId!, { createdBy: 'alice', blockerNote: 'private text' });
    const cas = storage.kvCompareAndSwap.bind(storage);
    let attempts = 0;
    storage.kvCompareAndSwap = async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      if (args[0].includes('kanban:card')) { attempts += 1; return { swapped: false, actual: args[1] }; }
      return cas(...args);
    };
    await expect(eraseSubjectKanban('t1', 'alice')).rejects.toThrow('kanban_subject_erasure_conflict');
    expect(attempts).toBe(5);
    expect(await getCard(m.cardId!)).toMatchObject({ createdBy: 'alice', blockerNote: 'private text' });
  });

  it('the ranking preview does not rank a held card, and lists it as held', async () => {
    const m = await member('t1', 'Sally');
    await updateCardFields(m.cardId!, { blockerNote: '[auto:run-restore] Held — its run failed (r0).' });
    await createCard({ boardId: m.board.id, columnId: 'todo', title: 'healthy' });
    const view = await readBoardRanking('t1', m.board.id, Date.now(), 'user:1');
    expect(view.ranked.map((r) => r.title)).toEqual(['healthy']);
    expect(view.held).toEqual([{ cardId: m.cardId, title: 'Sally task' }]);
  });

  it('a pass whose every To Do card is held says so', async () => {
    const m = await member('t1', 'Sally');
    await updateCardFields(m.cardId!, { blockerNote: '[auto:run-restore] Held — its run was cancelled (r0).' });
    expect(await runHeartbeatOnce(deps, m.entry)).toMatchObject({ picked: false, reason: 'held' });
  });

  it('a person\'s own blocker note does not hold a card', async () => {
    const m = await member('t1', 'Sally');
    await updateCardFields(m.cardId!, { blockerNote: 'waiting on legal' });
    expect((await runHeartbeatOnce(deps, m.entry)).runId).toBeDefined();
  });
});

describe('D8 — the loop never takes a Work-Twin mock archive on its own', () => {
  async function agentWith(cardWorkflowId: string | undefined, columnTrigger: string | undefined) {
    const entry = await createRosterEntry({ tenantId: 't1', persona: 'Ava', agentRef: { agentId: 'host:demo-sales' }, workflows: [] });
    const board = await createBoard({ tenantId: 't1', name: 'Ava board', rosterId: entry.rosterId, ...(columnTrigger ? { triggerWorkflowId: columnTrigger } : {}) });
    await createCard({ boardId: board.id, columnId: 'todo', title: 'mock work', ...(cardWorkflowId ? { workflowId: cardWorkflowId } : {}) });
    return { entry, board };
  }

  it('a card naming a mock archive is neither run nor proposed', async () => {
    const { entry } = await agentWith('tmpl.it.incident-triage', undefined);
    const result = await runHeartbeatOnce(deps, entry);
    expect(result).toMatchObject({ picked: false, reason: 'mock_archive' });
    expect(await storage.listRuns({ limit: 10 })).toHaveLength(0);
  });

  it('a column trigger naming a mock archive counts the same as the card naming it', async () => {
    const { entry } = await agentWith(undefined, 'tmpl.it.incident-triage');
    expect(await runHeartbeatOnce(deps, entry)).toMatchObject({ picked: false, reason: 'mock_archive' });
  });

  it('a real workflow beside it is still picked', async () => {
    const { entry, board } = await agentWith('tmpl.it.incident-triage', undefined);
    await createCard({ boardId: board.id, columnId: 'todo', title: 'real work', workflowId: 'wf-real' });
    expect((await runHeartbeatOnce(deps, entry)).cardTitle).toBe('real work');
  });

  it('the preview does not rank a mock-archive card', async () => {
    const { board } = await agentWith('tmpl.it.incident-triage', undefined);
    await createCard({ boardId: board.id, columnId: 'todo', title: 'real work', workflowId: 'wf-real' });
    expect((await readBoardRanking('t1', board.id, Date.now(), 'user:1')).ranked.map((r) => r.title)).toEqual(['real work']);
  });

  it('is keyed on the archive list, not on a prefix', () => {
    expect(isWorkTwinMockArchive('tmpl.it.incident-triage')).toBe(true);
    expect(isWorkTwinMockArchive('tmpl.not-an-archive')).toBe(false);
    expect(WORKFLOW_TEMPLATE_CHAIN_IDS).toHaveLength(44);
  });
});

describe('D9 — the autonomous daemon serves signed-in tenants only (user decision 2026-10-19)', () => {
  it('an anonymous sandbox member is never heartbeat by the daemon', async () => {
    const anon = await member('anon:visitor-1', 'Ava');
    const signed = await member('user:abc', 'Ava');
    expect(await processDueHeartbeats(deps, listRosterTenants, Date.parse('2026-06-02T12:00:00Z'))).toBe(1);
    expect(await stamped('anon:visitor-1', anon.entry.rosterId)).toBeUndefined();
    expect(await stamped('user:abc', signed.entry.rosterId)).toBeDefined();
  });

  it('a manual Check now still works for an anonymous sandbox', async () => {
    const anon = await member('anon:visitor-1', 'Ava');
    expect((await runHeartbeatOnce(deps, anon.entry)).runId).toBeDefined();
  });
});

describe('A1 — a note written from a snapshot never overwrites a person\'s edit', () => {
  async function inFlight(note: string | undefined): Promise<{ cardId: string; boardId: string }> {
    const m = await member('t1', 'Sally');
    if (note) await updateCardFields(m.cardId!, { blockerNote: note });
    await setCardLastRun(m.cardId!, 'r1', 'running');
    expect(await moveCard(m.cardId!, workingColumnOf(m.board)!.id)).not.toBeNull();
    return { cardId: m.cardId!, boardId: m.board.id };
  }

  /**
   * Make a person edit the note just before the `nth` card write lands (1-based).
   * Write 1 is the run-status stamp; write 2 is the note-writing step under
   * test, which read the card BEFORE this edit.
   */
  function editBeforeCardWrite(cardId: string, note: string, nth: number): void {
    const cas = storage.kvCompareAndSwap.bind(storage);
    let seen = 0;
    let editing = false;
    storage.kvCompareAndSwap = (async (...args: Parameters<Storage['kvCompareAndSwap']>) => {
      if (!editing && String(args[0]).includes('kanban:card') && (seen += 1) === nth) {
        editing = true;
        await updateCardFields(cardId, { blockerNote: note });
      }
      return cas(...args);
    }) as Storage['kvCompareAndSwap'];
  }

  async function seedRun(status: 'failed' | 'completed', meta: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: 'r1', tenantId: 't1', workflowId: 'wf-1', status, inputs: {}, metadata: meta, configurable: {},
      createdAt: now, updatedAt: now,
    });
  }

  it('the restore keeps a note a person wrote while it was deciding', async () => {
    const c = await inFlight(undefined);
    await seedRun('failed', { heartbeat: { boardId: c.boardId, cardId: c.cardId } });
    editBeforeCardWrite(c.cardId, 'looking into it — Sam', 2);
    await recoverCardForTerminalRun(storage, 'r1', 'failed');
    const after = await getCard(c.cardId);
    // The snapshot note would have erased Sam's line; the retry composes from
    // the fresh card, so both survive — and the card is restored, not stranded.
    expect(after?.blockerNote?.split('\n')[0]).toBe('looking into it — Sam');
    expect(after?.blockerNote).toContain('[auto:run-restore]');
    expect(after?.columnId).toBe('todo');
  });

  it('the completed-run note strip keeps a note a person wrote while it was deciding', async () => {
    const c = await inFlight('[auto:run-restore] Held — its run failed (r0).');
    await seedRun('completed', { kanban: { boardId: c.boardId, cardId: c.cardId } });
    editBeforeCardWrite(c.cardId, 'still broken — Sam', 2);
    await recoverCardForTerminalRun(storage, 'r1', 'completed');
    expect((await getCard(c.cardId))?.blockerNote).toBe('still broken — Sam');
  });
});
