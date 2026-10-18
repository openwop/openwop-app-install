/**
 * ADR 0774 — the kanban stack's pick loop, witnessed on a DEFAULT-column board.
 *
 * Every earlier recovery test built its board by hand WITH a `working` lane
 * (GEN-KST-1), which is exactly how `KSTWF-1` survived: the boards real users get
 * (`DEFAULT_COLUMNS` = To Do / Doing / Done — the add-todo board, the career
 * board, a user-created roster board) have no lane named `working`. So these
 * witnesses drive the REAL `runHeartbeatOnce` + `startWorkflowRun` +
 * `reconcileStrandedCards` + the run-terminal handler against the board shape
 * `createBoard` actually mints, and each asserts the thing a work queue exists
 * to guarantee — a card is started ONCE.
 *
 *   D1  the pick claims into `doing`; a second pass starts nothing; a board
 *       with no in-progress lane is refused (`no_working_lane`);
 *   D2  two concurrent passes start exactly one run; a WorkItem card is left to
 *       the ADR 0738 dispatcher; a failed start hands the card back;
 *   D3  a completed run's status outlives the run row, so retention does not
 *       re-queue finished work; a loop-owned claim whose row never appeared is
 *       restored only after the grace window; a legacy card is never touched.
 *
 * Witnessed (w37 probes w37g1-hb-*): the lane table, the claim move into the
 * working lane + its version CAS, the no-lane / KSCD-10 cause, the WorkItem skip,
 * the release on a failed start, the terminal status stamp, the retention and
 * grace guards, the failed-run restore, the fresh-read precondition, KSCD-1/2,
 * and the approved-dispatch move + human-wins precondition.
 *
 * @see docs/adr/0774-kanban-stack-claim-integrity.md
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createRosterEntry, __resetRosterStore, type RosterEntry } from '../src/host/rosterService.js';
import {
  applyBoardCommand,
  columnLaneKind,
  createBoard,
  createCard,
  getCard,
  listCards,
  moveCard,
  pickRunIdFor,
  updateCardFields,
  __resetKanbanStore,
  type KanbanBoard,
} from '../src/host/kanbanService.js';
import { runHeartbeatOnce, registerAgentTurnFallback } from '../src/host/heartbeatService.js';
import { listApprovals, getApproval } from '../src/host/approvalService.js';
import { claimApproval } from '../src/host/approvalDecision.js';
import { reconcileStrandedCards, recoverCardForTerminalRun, PICK_CLAIM_GRACE_MS } from '../src/host/cardRunRecovery.js';

const WF = 'wf-stack';
const TENANT = 't-stack';

const workingCatalog: StartRunDeps['hostSuite'] = {
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
  deps = { storage, hostSuite: workingCatalog };
});
afterEach(() => {
  __resetHostExtPersistence();
});

let seq = 0;
/** An `auto` agent whose board is the DEFAULT column set (no `columns` passed),
 *  exactly as add-todo / the career board / a user-created roster board get. */
async function agentWithDefaultBoard(): Promise<{ entry: RosterEntry; board: KanbanBoard }> {
  const entry = await createRosterEntry({
    tenantId: TENANT,
    persona: `Stacker ${++seq}`,
    agentRef: { agentId: 'host:it-service-desk' },
    workflows: [WF],
  });
  const board = await createBoard({ tenantId: TENANT, name: 'Default lanes', rosterId: entry.rosterId });
  return { entry, board };
}

describe('ADR 0774 D1 — one lane vocabulary (server twin of the SPA laneKind)', () => {
  // The SAME case table the SPA pins in `kanban/__tests__/laneKind.test.ts`.
  it.each([
    [{ id: 'todo', name: 'To Do' }, 'todo'],
    [{ id: 'x', name: 'to do' }, 'todo'],
    [{ id: 'working', name: 'Working' }, 'working'],
    [{ id: 'doing', name: 'Doing' }, 'working'],
    [{ id: 'col-2', name: 'Doing' }, 'working'],
    [{ id: 'in-progress', name: 'Started' }, 'working'],
    [{ id: 'col-5', name: 'In Progress' }, 'working'],
    [{ id: 'waiting', name: 'Waiting on Human' }, 'waiting'],
    [{ id: 'col-3', name: 'Waiting for review' }, 'waiting'],
    [{ id: 'done', name: 'Done' }, 'done'],
    [{ id: 'backlog', name: 'Backlog' }, null],
  ] as const)('%o → %s', (col, kind) => {
    expect(columnLaneKind(col)).toBe(kind);
  });
});

describe('ADR 0774 D1/D2 — the pick on a default board', () => {
  it('claims the card into Doing with a running status, and a second pass starts nothing', async () => {
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Do the thing', workflowId: WF });

    const first = await runHeartbeatOnce(deps, entry);
    expect(first.picked).toBe(true);
    expect(first.runId).toMatch(/^kanban-pick-run-/);
    const after = await getCard(card.id);
    expect(after?.columnId).toBe('doing');
    expect(after?.lastRunId).toBe(first.runId);
    expect(after?.lastRunStatus).toBe('running');

    // KSTWF-1: before ADR 0774 the card stayed in To Do and this started run #2.
    const second = await runHeartbeatOnce(deps, entry);
    expect(second.picked).toBe(false);
    expect(second.runId).toBeUndefined();
  });

  it('refuses a board with a To Do lane but no in-progress lane rather than re-running forever', async () => {
    const entry = await createRosterEntry({
      tenantId: TENANT, persona: `NoLane ${++seq}`, agentRef: { agentId: 'host:it-service-desk' }, workflows: [WF],
    });
    const board = await createBoard({
      tenantId: TENANT, name: 'Two lanes', rosterId: entry.rosterId,
      columns: [{ id: 'todo', name: 'To Do' }, { id: 'done', name: 'Done', terminal: true }],
    });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Stuck?', workflowId: WF });

    const result = await runHeartbeatOnce(deps, entry);
    expect(result).toMatchObject({ picked: false, reason: 'no_working_lane' });
    expect((await getCard(card.id))?.lastRunId).toBeUndefined();
  });

  it('two concurrent passes over one card start exactly ONE run (the claim CAS)', async () => {
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Race me', workflowId: WF });

    const results = await Promise.all([runHeartbeatOnce(deps, entry), runHeartbeatOnce(deps, entry), runHeartbeatOnce(deps, entry)]);
    const started = results.filter((r) => r.picked && r.runId);
    expect(started).toHaveLength(1);
    expect((await getCard(card.id))?.lastRunId).toBe(started[0]!.runId);
  });

  it('leaves a WorkItem-backed card to the ADR 0738 dispatcher (never two engines on one card)', async () => {
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Owned elsewhere', workflowId: WF, workItemId: 'wi-1' });

    const result = await runHeartbeatOnce(deps, entry);
    expect(result.picked).toBe(false);
    expect((await getCard(card.id))?.columnId).toBe('todo');
  });

  it('hands the card back to To Do when the run cannot start', async () => {
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Unresolvable', workflowId: 'wf-missing' });
    const noWorkflow: StartRunDeps = {
      storage,
      hostSuite: { workflowCatalog: { getWorkflow: async () => null }, providerPolicyResolver: { resolveForRun: async () => [] } },
    };

    const result = await runHeartbeatOnce(noWorkflow, entry);
    expect(result.picked).toBe(false);
    const after = await getCard(card.id);
    expect(after?.columnId).toBe('todo');
    expect(after?.lastRunStatus).toBeUndefined();
  });
});

describe('ADR 0774 D3 — the run status outlives the run row', () => {
  it('a completed run is stamped on the card, and losing the row to retention does NOT re-queue it', async () => {
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Finish once', workflowId: WF });
    const picked = await runHeartbeatOnce(deps, entry);
    const runId = picked.runId!;

    // The real run-terminal handler (registered at boot as ADR 0535's seam).
    await recoverCardForTerminalRun(storage, runId, 'completed');
    expect((await getCard(card.id))?.lastRunStatus).toBe('completed');
    expect((await getCard(card.id))?.columnId).toBe('doing'); // finishing is not closing (ADR 0535)

    // Retention deletes the row. Before ADR 0774 reconcile restored the card
    // as "outcome unknown" and the next pass ran it again (KSTWF-3).
    await storage.deleteRun(runId);
    const restored = await reconcileStrandedCards(storage, board, await listCards(board.id), Date.now() + PICK_CLAIM_GRACE_MS * 10);
    expect(restored).toBe(0);
    expect((await getCard(card.id))?.columnId).toBe('doing');
    const again = await runHeartbeatOnce(deps, entry);
    expect(again.picked).toBe(false);
  });

  it('a failed run is stamped and restored to To Do (the ADR 0535 disposition is unchanged)', async () => {
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Fail once', workflowId: WF });
    const picked = await runHeartbeatOnce(deps, entry);
    await storage.updateRun(picked.runId!, { status: 'failed' });

    expect(await recoverCardForTerminalRun(storage, picked.runId!, 'failed')).toBe(true);
    const after = await getCard(card.id);
    expect(after?.columnId).toBe('todo');
    expect(after?.lastRunStatus).toBe('failed');
  });

  it('a loop claim whose run row never appeared is restored only AFTER the grace window', async () => {
    const { board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'doing', title: 'Crashed mid-start', workflowId: WF });
    // Exactly what a claim leaves behind when the process dies before
    // `startWorkflowRun` writes the row.
    await updateCardFields(card.id, { lastRunId: 'kanban-pick-run-never-written', lastRunStatus: 'running' });

    expect(await reconcileStrandedCards(storage, board, await listCards(board.id), Date.now())).toBe(0);
    expect((await getCard(card.id))?.columnId).toBe('doing');

    expect(await reconcileStrandedCards(storage, board, await listCards(board.id), Date.now() + PICK_CLAIM_GRACE_MS + 1_000)).toBe(1);
    const after = await getCard(card.id);
    expect(after?.columnId).toBe('todo');
    expect(after?.lastRunStatus).toBeUndefined();
  });

  it('never restores a card the loop did not put in flight (a legacy or human card in Doing)', async () => {
    const { board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'doing', title: 'A human is on it', workflowId: WF });
    // A trigger-lane or pre-ADR run id with no status and no row (retention).
    await updateCardFields(card.id, { lastRunId: 'run-from-a-human-drag' });

    expect(await reconcileStrandedCards(storage, board, await listCards(board.id), Date.now() + PICK_CLAIM_GRACE_MS * 10)).toBe(0);
    expect((await getCard(card.id))?.columnId).toBe('doing');
  });
});

describe('ADR 0774 D2/D4 — the command precondition is checked on the FRESH read', () => {
  it('refuses, and writes nothing, when the card changed after the caller\'s snapshot', async () => {
    const { board } = await agentWithDefaultBoard();
    const snapshot = await createCard({ boardId: board.id, columnId: 'todo', title: 'Role card', assigneeRole: 'editor' });
    // Someone else claims between the caller's read and its write.
    await updateCardFields(snapshot.id, { assigneeId: 'user:first', assigneeRole: null });

    await expect(applyBoardCommand({
      type: 'card.patch', tenantId: TENANT, boardId: board.id, cardId: snapshot.id,
      patch: { assigneeId: 'user:second', assigneeRole: null },
      precondition: (fresh) => Boolean(fresh.assigneeRole) && !fresh.assigneeId,
    })).rejects.toMatchObject({ code: 'kanban_card_precondition_failed' });
    expect((await getCard(snapshot.id))?.assigneeId).toBe('user:first');
  });
});

describe('grade-code fixes inside the ADR 0774 cut', () => {
  it('KSCD-1 — a restore working from a STALE snapshot never yanks a card another pass re-claimed', async () => {
    const { board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'doing', title: 'Re-claimed', workflowId: WF });
    await updateCardFields(card.id, { lastRunId: 'run-r1', lastRunStatus: 'running' });
    const now = new Date().toISOString();
    await storage.insertRun({
      runId: 'run-r1', tenantId: TENANT, workflowId: WF, status: 'failed', inputs: {},
      metadata: { heartbeat: { boardId: board.id, cardId: card.id, source: 'heartbeat' } },
      configurable: {}, createdAt: now, updatedAt: now,
    });
    // Pass A holds this snapshot while it awaits getRun…
    const stale = await listCards(board.id);
    // …meanwhile pass B restored the card and RE-CLAIMED it with a new run.
    await updateCardFields(card.id, { lastRunId: 'run-r2', lastRunStatus: 'running' });

    expect(await reconcileStrandedCards(storage, board, stale)).toBe(0);
    const after = await getCard(card.id);
    expect(after?.columnId).toBe('doing');
    expect(after?.lastRunId).toBe('run-r2');
    expect(after?.lastRunStatus).toBe('running');
  });

  it('KSCD-2 — a card re-created under the same deterministic id never re-presents the old pick run', () => {
    const a = pickRunIdFor({ id: 'card-todo-x', version: 1, createdAt: '2026-09-01T00:00:00.000Z' });
    const b = pickRunIdFor({ id: 'card-todo-x', version: 1, createdAt: '2026-09-28T00:00:00.000Z' });
    expect(a).not.toBe(b);
    expect(pickRunIdFor({ id: 'card-todo-x', version: 1, createdAt: '2026-09-01T00:00:00.000Z' })).toBe(a);
  });

  it('KSCD-10 — an extra EMPTY board without a working lane does not mask the real board\'s cause', async () => {
    const { entry } = await agentWithDefaultBoard();
    await createBoard({
      tenantId: TENANT, name: 'Scratch', rosterId: entry.rosterId,
      columns: [{ id: 'todo', name: 'To Do' }, { id: 'done', name: 'Done', terminal: true }],
    });
    const result = await runHeartbeatOnce(deps, entry);
    expect(result).toMatchObject({ picked: false, reason: 'empty_board' });
  });
});

describe('ADR 0774 D2 + KSCD-5 — the approved-proposal dispatch on a default board', () => {
  afterEach(() => registerAgentTurnFallback(null));
  const decisionDeps = async (): Promise<Parameters<typeof claimApproval>[0]> => {
    const { createHostAdapterSuite } = await import('../src/host/index.js');
    return { storage, hostSuite: { ...createHostAdapterSuite({ storage }), workflowCatalog: workingCatalog.workflowCatalog } };
  };

  it('approving moves the card into Doing as running, and the next pass does NOT re-propose it', async () => {
    registerAgentTurnFallback({ workflowId: 'openwop-app.scheduled-chat.turn', credentialRef: 'managed:openwop-free' });
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Bare todo' });
    const proposed = await runHeartbeatOnce(deps, entry);
    expect(proposed.proposed).toBe(true);

    await claimApproval(await decisionDeps(), { tenantId: TENANT, decidedBy: 'approver-1' }, proposed.approvalId!);
    const runId = (await getApproval(proposed.approvalId!))!.runId!;
    const after = await getCard(card.id);
    expect(after).toMatchObject({ columnId: 'doing', lastRunId: runId, lastRunStatus: 'running' });

    // KSTWF-1 on the review path: before ADR 0774 the card stayed in To Do and
    // this pass queued a SECOND proposal for the same work.
    const again = await runHeartbeatOnce(deps, entry);
    expect(again.proposed).toBeFalsy();
    const pending = (await listApprovals(TENANT, 'pending')).filter((a) => a.cardId === card.id);
    expect(pending).toHaveLength(0);
  });

  it('a card a human moved on before the decision stays where they put it (the run is still recorded)', async () => {
    registerAgentTurnFallback({ workflowId: 'openwop-app.scheduled-chat.turn', credentialRef: 'managed:openwop-free' });
    const { entry, board } = await agentWithDefaultBoard();
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Handled by hand' });
    const proposed = await runHeartbeatOnce(deps, entry);
    await moveCard(card.id, 'done');

    await claimApproval(await decisionDeps(), { tenantId: TENANT, decidedBy: 'approver-1' }, proposed.approvalId!);
    const after = await getCard(card.id);
    expect(after?.columnId).toBe('done');
    expect(after?.lastRunId).toBe((await getApproval(proposed.approvalId!))!.runId);
  });
});
