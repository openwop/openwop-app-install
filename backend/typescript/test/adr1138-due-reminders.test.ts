/**
 * ADR 1138 D4 — due-soon and overdue reminders.
 *
 * Bare persistence (sqlite memory + the notification backend), the real toggle
 * registry and service, and the real projects access resolver.
 *
 * Red if: a tenant with the toggle off is read or notified; a re-sweep of the
 * same due date sends twice; a moved due date does not re-arm; a finished card,
 * an unassigned card, a far-future card, or a long-overdue backlog card is
 * announced; a person who can no longer see the project still gets the notice;
 * or the per-tenant cap stops the sweep instead of resuming on the next tick;
 * or a killed toggle, or a tenant turned off under a global on, is swept;
 * or a workspace with boards but no roster agents is never visited.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { enableTenantOverride, getEffectiveConfig, saveConfig, toggleCandidateTenants } from '../src/host/featureToggles/service.js';
import { createMember, createWorkspace } from '../src/host/accessControlService.js';
import { registerSubjectAccessResolver } from '../src/host/subjectAccess.js';
import { addProjectMember, createProject, removeProjectMember, resolveProjectAccess, setProjectVisibility } from '../src/features/projects/projectsService.js';
import { createBoard, createCard, ensureSubjectBoard, moveCard, updateCardFields } from '../src/host/kanbanService.js';
import { kanbanDueRemindersFeature } from '../src/features/kanban-due-reminders/feature.js';
import {
  DUE_SOON_MS,
  MAX_CARDS_PER_TENANT_TICK,
  SWEEP_TENANTS_TTL_MS,
  __resetDueSweepCursor,
  dueNoticeFor,
  dueSweepTenantSource,
  noticeLabel,
  reminderTenants,
  sweepTenantDue,
} from '../src/features/kanban-due-reminders/dueSweep.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;

let store: Storage;
let on: string;
let off: string;

beforeAll(async () => {
  store = await openStorage('memory://');
  initHostExtPersistence(store);
  ensureNotificationEmitterInstalled(store);
  registerToggleDefault(kanbanDueRemindersFeature.toggleDefault!);
  registerSubjectAccessResolver('project', (t, subject, caller) => resolveProjectAccess(t, subject.id, caller));
  on = (await createWorkspace({ name: 'On', ownerSubject: 'user:owner' })).tenantId;
  off = (await createWorkspace({ name: 'Off', ownerSubject: 'user:owner' })).tenantId;
  for (const t of [on, off]) await createMember({ tenantId: t, orgId: t, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
  expect(await enableTenantOverride('kanban-due-reminders', on, 'test')).toBe('enabled');
});
beforeEach(() => __resetDueSweepCursor());
afterAll(async () => {
  __resetHostExtPersistence();
  await store.close();
});

const dueInbox = async (tenantId: string, cardId: string) =>
  (await store.listNotifications({ tenantId, recipientUserId: 'user:alice' }))
    .filter((n) => n.type === 'task.due' && n.metadata?.cardId === cardId);

describe('ADR 1138 D4 — due reminders', () => {
  it('the thresholds: soon inside two days, overdue once passed, nothing for old backlog', () => {
    expect(dueNoticeFor(iso(NOW + DUE_SOON_MS - 1), NOW)).toBe('soon');
    expect(dueNoticeFor(iso(NOW + DUE_SOON_MS + HOUR), NOW)).toBeNull();
    expect(dueNoticeFor(iso(NOW - HOUR), NOW)).toBe('overdue');
    expect(dueNoticeFor(iso(NOW - 8 * 24 * HOUR), NOW)).toBeNull();
  });

  it('the source label in a notice is cleaned and capped', () => {
    expect(noticeLabel(undefined)).toBe('');
    expect(noticeLabel('Selections\u0000 ·\n waiting on\u2028the client')).toBe(' Selections · waiting on the client.');
    expect(noticeLabel('x'.repeat(500)).length).toBeLessThanOrEqual(122);
  });

  it('only tenants with the toggle on are swept', async () => {
    expect(await reminderTenants(async () => [on, off])).toEqual([on]);
    const board = await createBoard({ tenantId: off, name: 'Off board' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'x', assigneeId: 'user:alice', dueAt: iso(NOW + HOUR) });
    expect((await sweepTenantDue(off, NOW)).sent).toBe(0);
    expect(await dueInbox(off, card.id)).toHaveLength(0);
  });

  it('sends once per state per date, and a moved date re-arms', async () => {
    const board = await createBoard({ tenantId: on, name: 'Build' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Order the sofa', assigneeId: 'user:alice', dueAt: iso(NOW + HOUR), sourceLabel: 'Selections · waiting on the client' });
    await sweepTenantDue(on, NOW);
    expect((await dueInbox(on, card.id))[0]?.message).toContain('waiting on the client');
    await sweepTenantDue(on, NOW + 10 * 60 * 1000);
    expect((await dueInbox(on, card.id)).map((n) => n.metadata?.state)).toEqual(['soon']);

    await sweepTenantDue(on, NOW + 2 * HOUR); // now past due
    await sweepTenantDue(on, NOW + 3 * HOUR);
    expect((await dueInbox(on, card.id)).map((n) => n.metadata?.state).sort()).toEqual(['overdue', 'soon']);

    await updateCardFields(card.id, { dueAt: iso(NOW + 30 * HOUR) }); // moved: re-arms "soon"
    await sweepTenantDue(on, NOW + 4 * HOUR);
    await sweepTenantDue(on, NOW + 5 * HOUR);
    // ADR 1155 D6 — the move archived the two notices about the old date; the
    // one fresh "soon" is the only open notice left.
    expect((await dueInbox(on, card.id)).map((n) => n.metadata?.state)).toEqual(['soon']);
    const all = (await store.listNotifications({ tenantId: on, recipientUserId: 'user:alice', includeArchived: true }))
      .filter((n) => n.type === 'task.due' && n.metadata?.cardId === card.id);
    expect(all.filter((n) => n.metadata?.state === 'soon')).toHaveLength(2);
    expect(all.filter((n) => n.status === 'archived')).toHaveLength(2);
  });

  it('skips finished, unassigned and far-future cards', async () => {
    const board = await createBoard({ tenantId: on, name: 'Skips' });
    const done = await createCard({ boardId: board.id, columnId: 'todo', title: 'Done', assigneeId: 'user:alice', dueAt: iso(NOW + HOUR) });
    await moveCard(done.id, 'done');
    const nobody = await createCard({ boardId: board.id, columnId: 'todo', title: 'Nobody', dueAt: iso(NOW + HOUR) });
    const later = await createCard({ boardId: board.id, columnId: 'todo', title: 'Later', assigneeId: 'user:alice', dueAt: iso(NOW + 10 * 24 * HOUR) });
    await sweepTenantDue(on, NOW);
    for (const c of [done, nobody, later]) expect(await dueInbox(on, c.id)).toHaveLength(0);
  });

  it('checks access at send time: someone removed from a private project stops getting its reminders', async () => {
    const project = await createProject(on, on, { name: 'Private house' }, 'user:owner');
    await addProjectMember(on, project.id, 'user:user:alice', 'lead', 'user:owner');
    await setProjectVisibility(on, project.id, 'private', 'user:owner');
    const board = await ensureSubjectBoard(on, { kind: 'project', id: project.id }, 'Private house');
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Private task', assigneeId: 'user:alice', dueAt: iso(NOW + HOUR) });
    await removeProjectMember(on, project.id, 'user:user:alice', 'user:owner');
    await sweepTenantDue(on, NOW);
    expect(await dueInbox(on, card.id)).toHaveLength(0);
  });

  it('a tenant over the cap is finished on the next tick, not dropped', async () => {
    const board = await createBoard({ tenantId: on, name: 'Big' });
    const total = MAX_CARDS_PER_TENANT_TICK + 3;
    for (let i = 0; i < total; i += 1) {
      await createCard({ boardId: board.id, columnId: 'todo', title: `t${i}`, assigneeId: 'user:alice', dueAt: iso(NOW + 2 * HOUR) });
    }
    const first = await sweepTenantDue(on, NOW);
    expect(first.capped).toBe(true);
    const second = await sweepTenantDue(on, NOW);
    expect(second.capped).toBe(false);
    expect(first.sent + second.sent).toBe(total);
    // A third visit finds every notice already sent.
    expect((await sweepTenantDue(on, NOW)).sent).toBe(0);
  }, 120_000);

  it('a killed toggle sweeps nobody; under a global on, a tenant turned off is left out', async () => {
    const original = (await getEffectiveConfig('kanban-due-reminders'))!;
    const third = 't-third';
    try {
      await saveConfig({ ...original, status: 'on', tenantOverrides: { [off]: { status: 'off' } } }, 'test');
      expect(await toggleCandidateTenants('kanban-due-reminders', async () => [on, off, third])).toEqual([off, on, third].sort());
      expect(await reminderTenants(async () => [on, off, third])).toEqual([on, third].sort());

      await saveConfig({ ...original, status: 'on', killed: true, tenantOverrides: { [on]: { status: 'on' } } }, 'test');
      expect(await toggleCandidateTenants('kanban-due-reminders', async () => [on, off, third])).toEqual([]);
      expect(await reminderTenants(async () => [on, off, third])).toEqual([]);
      expect((await sweepTenantDue(on, NOW)).sent).toBe(0);
    } finally {
      await saveConfig(original, 'test');
    }
  });
  it('a workspace with boards and no roster agents is swept (the roster is not the tenant list)', async () => {
    const original = (await getEffectiveConfig('kanban-due-reminders'))!;
    const noRoster = (await createWorkspace({ name: 'Boards only', ownerSubject: 'user:owner' })).tenantId;
    await createMember({ tenantId: noRoster, orgId: noRoster, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
    const board = await createBoard({ tenantId: noRoster, name: 'Studio' });
    const card = await createCard({ boardId: board.id, columnId: 'todo', title: 'Chase the rug', assigneeId: 'user:alice', dueAt: iso(NOW - HOUR) });
    try {
      await saveConfig({ ...original, status: 'on' }, 'test');
      const source = dueSweepTenantSource(async () => []);
      expect(await source()).toContain(noRoster);
      expect(await reminderTenants(source)).toContain(noRoster);
      expect((await sweepTenantDue(noRoster, NOW)).sent).toBe(1);
      expect(await dueInbox(noRoster, card.id)).toHaveLength(1);
    } finally {
      await saveConfig(original, 'test');
    }
  });

  it('the tenant list is the union of roster and board tenants, read once per round', async () => {
    let now = 0;
    let reads = 0;
    const source = dueSweepTenantSource(async () => ['t-b', 't-a'], async () => { reads += 1; return ['t-a', 't-c']; }, () => now);
    expect(await source()).toEqual(['t-a', 't-b', 't-c']);
    now = SWEEP_TENANTS_TTL_MS - 1;
    await source();
    expect(reads).toBe(1);
    now = SWEEP_TENANTS_TTL_MS;
    await source();
    expect(reads).toBe(2);
  });
});
