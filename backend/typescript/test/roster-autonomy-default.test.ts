/**
 * ADR 1159 — roster autonomy defaults to `review` ("agents propose, humans dispose").
 *
 * Covers:
 *   1. A new entry with no level is stored `review`, and `autonomyOf` reads it as review.
 *   2. An explicit `auto` is stored and read as auto (it is opt-in, not the absent default).
 *   3. A PATCH to `auto` persists the explicit value instead of deleting the field.
 *   4. A legacy row with no level reads as `review` (fail closed).
 *   5. App-migration 27 (`stampLegacyAutonomyLevels`) stamps `auto` on legacy absent rows only,
 *      leaves rows with a level alone, and is idempotent under a concurrent second run.
 *
 * Breaks it: reverting `autonomyOf` to "absent ⇒ auto" fails 1 and 4; restoring the
 * absent-normalization in create or patch fails 1–3; dropping the `!== undefined` skip
 * in the migration fails 5 (the review row would be overwritten).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { DurableCollection, initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __resetRosterStore,
  autonomyOf,
  createRosterEntry,
  getRosterEntry,
  stampLegacyAutonomyLevels,
  updateRosterEntry,
  type RosterEntry,
} from '../src/host/rosterService.js';

// The roster's own row collection, used to plant a row as older code stored it.
const rawRoster = new DurableCollection<RosterEntry>('roster', (e) => `${e.tenantId}:${e.rosterId}`);

function legacyRow(tenantId: string, rosterId: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  const now = new Date().toISOString();
  return {
    tenantId,
    rosterId,
    persona: rosterId.replace('host:', ''),
    agentRef: { agentId: 'assistant' },
    workflows: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...extra,
  } as RosterEntry;
}

describe('roster autonomy default (ADR 1159)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => {
    initHostExtPersistence(storage);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetRosterStore();
  });

  it('stores review for a new entry with no level', async () => {
    const e = await createRosterEntry({ tenantId: 't1', persona: 'Sally', agentRef: { agentId: 'assistant' }, workflows: [] });
    expect(e.autonomyLevel).toBe('review');
    expect(autonomyOf(e)).toBe('review');
    expect((await getRosterEntry('t1', e.rosterId))?.autonomyLevel).toBe('review');
  });

  it('stores an explicit auto as auto', async () => {
    const e = await createRosterEntry({ tenantId: 't1', persona: 'Otto', agentRef: { agentId: 'assistant' }, workflows: [], autonomyLevel: 'auto' });
    expect((await getRosterEntry('t1', e.rosterId))?.autonomyLevel).toBe('auto');
    expect(autonomyOf(e)).toBe('auto');
  });

  it('persists a PATCH to auto instead of deleting the field', async () => {
    const e = await createRosterEntry({ tenantId: 't1', persona: 'Pat', agentRef: { agentId: 'assistant' }, workflows: [] });
    await updateRosterEntry('t1', e.rosterId, { autonomyLevel: 'auto' });
    const after = await getRosterEntry('t1', e.rosterId);
    expect(after?.autonomyLevel).toBe('auto');
    expect(autonomyOf(after!)).toBe('auto');
  });

  it('reads a legacy row with no level as review', async () => {
    await rawRoster.put(legacyRow('t1', 'host:legacy'));
    const row = await getRosterEntry('t1', 'host:legacy');
    expect(row?.autonomyLevel).toBeUndefined();
    expect(autonomyOf(row!)).toBe('review');
  });

  it('app-migration 27 stamps auto on absent rows only, idempotently and under concurrency', async () => {
    await rawRoster.put(legacyRow('t1', 'host:legacy-a'));
    await rawRoster.put(legacyRow('t2', 'host:legacy-b'));
    await rawRoster.put(legacyRow('t1', 'host:chose-review', { autonomyLevel: 'review' }));
    await rawRoster.put(legacyRow('t1', 'host:chose-guided', { autonomyLevel: 'guided' }));

    const [first, second] = await Promise.all([stampLegacyAutonomyLevels(), stampLegacyAutonomyLevels()]);
    expect(first + second).toBe(2); // each absent row stamped exactly once across both runs

    expect((await getRosterEntry('t1', 'host:legacy-a'))?.autonomyLevel).toBe('auto');
    expect((await getRosterEntry('t2', 'host:legacy-b'))?.autonomyLevel).toBe('auto');
    expect((await getRosterEntry('t1', 'host:chose-review'))?.autonomyLevel).toBe('review');
    expect((await getRosterEntry('t1', 'host:chose-guided'))?.autonomyLevel).toBe('guided');

    expect(await stampLegacyAutonomyLevels()).toBe(0); // re-run is a no-op
  });
});
