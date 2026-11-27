/**
 * ADR 1138 D4 — the due sweep picks its tenant slice from the clock.
 *
 * The daemon used a per-boot counter starting at 0, so every deploy restarted at
 * slice 0: with deploys closer than an hour apart the later slices waited, and two
 * overlapping instances both swept slice 0. The slice is now
 * `floor(now / DUE_SWEEP_TICK_MS) % TICKS_PER_ROUND`.
 *
 * The daemon is driven through the feature's real `onStart`, with only
 * `setInterval` and `Date` faked, over bare persistence (sqlite memory and the
 * notification backend) and the real toggle service.
 *
 * Red if: a fresh boot sweeps slice 0 instead of the clock's slice (the per-boot
 * counter); or two instances booted at the same instant sweep different slices,
 * or their overlapping sweeps of one slice send a notice twice.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { createBoard, createCard } from '../src/host/kanbanService.js';
import type { FeatureDaemonHandle } from '../src/features/types.js';
import { kanbanDueRemindersFeature } from '../src/features/kanban-due-reminders/feature.js';
import {
  DUE_SWEEP_TICK_MS,
  TICKS_PER_ROUND,
  __resetDueSweepCursor,
  dueSweepTenantSource,
  dueSweepTickAt,
  reminderTenants,
} from '../src/features/kanban-due-reminders/dueSweep.js';

/** On the hour, so the boot instant is slice 0 and the first sweep is slice 1. */
const BASE = Date.parse('2026-11-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

let store: Storage;
let tenants: string[] = [];
const daemons: FeatureDaemonHandle[] = [];

beforeAll(async () => {
  store = await openStorage('memory://');
  initHostExtPersistence(store);
  ensureNotificationEmitterInstalled(store);
  registerToggleDefault(kanbanDueRemindersFeature.toggleDefault!);
  for (const name of ['A', 'B']) {
    const t = (await createWorkspace({ name, ownerSubject: 'user:owner' })).tenantId;
    await createMember({ tenantId: t, orgId: t, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
    expect(await enableTenantOverride('kanban-due-reminders', t, 'test')).toBe('enabled');
  }
  // The order the sweep walks: the source sorts, the toggle filter keeps it.
  tenants = await reminderTenants(dueSweepTenantSource(async () => []));
  expect(tenants).toHaveLength(2);
});
beforeEach(() => __resetDueSweepCursor());
afterEach(() => {
  while (daemons.length) daemons.pop()!.stop();
  vi.useRealTimers();
});
afterAll(async () => {
  __resetHostExtPersistence();
  await store.close();
});

const dueInbox = async (tenantId: string, cardId: string) =>
  (await store.listNotifications({ tenantId, recipientUserId: 'user:alice' }))
    .filter((n) => n.type === 'task.due' && n.metadata?.cardId === cardId);

/** A card in each tenant, due soon after `at`. */
async function cardEach(at: number): Promise<string[]> {
  const ids: string[] = [];
  for (const t of tenants) {
    const board = await createBoard({ tenantId: t, name: `Board ${ids.length}` });
    ids.push((await createCard({ boardId: board.id, columnId: 'todo', title: 'Order the sofa', assigneeId: 'user:alice', dueAt: iso(at + 3 * HOUR) })).id);
  }
  return ids;
}

/** Boot `n` daemons at `bootAt`, fire their first tick together, and wait for the
 *  expected tenant's notice (real timeouts; only setInterval and Date are fake). */
async function bootAndTick(n: number, bootAt: number, expected: { tenantId: string; cardId: string }): Promise<void> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: bootAt });
  for (let i = 0; i < n; i += 1) {
    const d = kanbanDueRemindersFeature.onStart!({ storage: store, hostSuite: {} as HostAdapterSuite, listRosterTenants: async () => [] });
    if (d) daemons.push(d);
  }
  vi.advanceTimersByTime(DUE_SWEEP_TICK_MS);
  for (let i = 0; i < 100 && (await dueInbox(expected.tenantId, expected.cardId)).length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  // Let an overlapping second sweep finish too before anything is counted.
  await new Promise((r) => setTimeout(r, 200));
}

describe('ADR 1138 D4 — the due sweep slice comes from the clock', () => {
  it('dueSweepTickAt: the same instant is the same slice, and one hour visits each slice once', () => {
    expect(dueSweepTickAt(BASE)).toBe(0);
    expect(dueSweepTickAt(BASE + DUE_SWEEP_TICK_MS - 1)).toBe(0);
    expect(dueSweepTickAt(BASE + DUE_SWEEP_TICK_MS)).toBe(1);
    const t = BASE + 7 * DUE_SWEEP_TICK_MS + 1234;
    expect(dueSweepTickAt(t)).toBe(dueSweepTickAt(t)); // two instances, one instant
    const hour = Array.from({ length: TICKS_PER_ROUND }, (_, k) => dueSweepTickAt(BASE + 30_000 + k * DUE_SWEEP_TICK_MS));
    expect([...hour].sort((a, b) => a - b)).toEqual(Array.from({ length: TICKS_PER_ROUND }, (_, k) => k));
  });

  it('a fresh boot sweeps the slice the clock is in, not slice 0', async () => {
    const [a, b] = await cardEach(BASE);
    // First sweep at BASE + one tick: slice 1 of a two-tenant list is tenants[1].
    // The old per-boot counter swept slice 0, tenants[0].
    expect(dueSweepTickAt(BASE + DUE_SWEEP_TICK_MS) % tenants.length).toBe(1);
    await bootAndTick(1, BASE, { tenantId: tenants[1]!, cardId: b! });
    expect(await dueInbox(tenants[1]!, b!)).toHaveLength(1);
    expect(await dueInbox(tenants[0]!, a!)).toHaveLength(0);
  });

  it('two instances booted at the same instant sweep the same slice, and send each notice once', async () => {
    const boot = BASE + HOUR; // on the hour again: slice 0 at boot, slice 1 at the first tick
    const [a, b] = await cardEach(boot);
    await bootAndTick(2, boot, { tenantId: tenants[1]!, cardId: b! });
    expect((await dueInbox(tenants[1]!, b!)).map((n) => n.metadata?.state)).toEqual(['soon']);
    expect(await dueInbox(tenants[0]!, a!)).toHaveLength(0);
  });
});
