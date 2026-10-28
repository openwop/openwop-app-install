/**
 * EVID-5 (heartbeat half; the schedule daemon's change-token pattern) — the heartbeat daemon no longer
 * lists every tenant's roster every 30 s. It re-lists only when the roster-change
 * token moved or the backstop elapsed, and acts on a FRESH read of each due
 * entry, so a stale listing can delay a heartbeat but never run a deleted member
 * or run one a second time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createRosterEntry, deleteRosterEntry, listRosterTenants, readRosterVersion, recordHeartbeat,
  updateRosterEntry, __resetRosterStore, type RosterEntry,
} from '../src/host/rosterService.js';
import { createBoard, createCard, __resetKanbanStore } from '../src/host/kanbanService.js';
import { cachedRosterEntries, processDueHeartbeats, ROSTER_RELIST_BACKSTOP_MS } from '../src/host/heartbeatService.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};
const TENANT = 't1';
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
afterEach(() => { __resetHostExtPersistence(); });

async function member(persona = 'Sally'): Promise<RosterEntry> {
  const entry = await createRosterEntry({ tenantId: TENANT, persona, agentRef: { agentId: 'host:demo-sales' }, workflows: ['wf-1'], heartbeatIntervalMs: 60_000 });
  const board = await createBoard({ tenantId: TENANT, name: `${persona} board`, rosterId: entry.rosterId, triggerWorkflowId: 'wf-1' });
  const todo = board.columns.find((c) => c.id === 'todo' || c.name.toLowerCase() === 'to do')!;
  await createCard({ boardId: board.id, columnId: todo.id, title: 'Do the thing' });
  return entry;
}

/** Wrap the tenant lister so a test can count how many times the roster was listed. */
function counting(): { list: () => Promise<string[]>; calls: () => number } {
  let n = 0;
  return { list: async () => { n += 1; return listRosterTenants(); }, calls: () => n };
}

describe('the roster-change token', () => {
  it('moves on every membership or config write', async () => {
    const t0 = await readRosterVersion();
    const e = await member();
    const t1 = await readRosterVersion();
    expect(t1).not.toBe(t0);
    await updateRosterEntry(TENANT, e.rosterId, { persona: 'Sal' });
    const t2 = await readRosterVersion();
    expect(t2).not.toBe(t1);
    expect(await deleteRosterEntry(TENANT, e.rosterId)).toBe(true);
    expect(await readRosterVersion()).not.toBe(t2);
  });

  // ADR 0963 D5 — this file used to assert the OPPOSITE ("moves on every kind of
  // roster write", heartbeat included), which pinned the defect: every pass that
  // heartbeat anyone forced the next tick to re-list every tenant.
  it('does NOT move when a heartbeat is stamped — that is pass state, not membership', async () => {
    const e = await member();
    const before = await readRosterVersion();
    await recordHeartbeat(TENANT, e.rosterId);
    expect(await readRosterVersion()).toBe(before);
  });

  it('does not move on a delete that removed nothing', async () => {
    await member();
    const before = await readRosterVersion();
    expect(await deleteRosterEntry(TENANT, 'host:nobody')).toBe(false);
    expect(await readRosterVersion()).toBe(before);
  });
});

describe('cachedRosterEntries', () => {
  it('lists once while the roster is unchanged', async () => {
    await member();
    const c = counting();
    const entries = cachedRosterEntries(c.list, () => NOW);
    for (let i = 0; i < 5; i++) expect(await entries()).toHaveLength(1);
    expect(c.calls()).toBe(1);
  });

  it('re-lists after a roster write', async () => {
    await member();
    const c = counting();
    const entries = cachedRosterEntries(c.list, () => NOW);
    await entries();
    await member('Bob');
    expect(await entries()).toHaveLength(2);
    expect(c.calls()).toBe(2);
  });

  it('re-lists after the backstop even with no write', async () => {
    await member();
    const c = counting();
    let clock = NOW;
    const entries = cachedRosterEntries(c.list, () => clock);
    await entries();
    clock += ROSTER_RELIST_BACKSTOP_MS - 1;
    await entries();
    expect(c.calls()).toBe(1);
    clock += 1;
    await entries();
    expect(c.calls()).toBe(2);
  });
});

describe('a stale listing can delay, never misfire', () => {
  it('does not run a member deleted after the listing was taken', async () => {
    const e = await member();
    const snapshot = [e];
    await deleteRosterEntry(TENANT, e.rosterId);
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW, async () => snapshot)).toBe(0);
  });

  it('does not run a member another instance just ran', async () => {
    const e = await member();
    const snapshot = [e]; // listed before the other instance stamped it
    await recordHeartbeat(TENANT, e.rosterId);
    expect(await processDueHeartbeats(deps, listRosterTenants, Date.now(), async () => snapshot)).toBe(0);
  });

  it('runs a due member from the cached listing', async () => {
    await member();
    const entries = cachedRosterEntries(listRosterTenants, () => NOW);
    expect(await processDueHeartbeats(deps, listRosterTenants, NOW, entries)).toBe(1);
  });
});
