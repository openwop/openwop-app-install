/**
 * ADR 1137 — work items carry an assignee (D1/D2) and can be refreshed (D3).
 *
 * Bare persistence (sqlite memory + the notification backend), no app boot. The
 * project access seam is the REAL projects resolver (`resolveProjectAccess`), so
 * the client-org leg proves the floor on the same rule every project surface uses.
 *
 * Red if: an assignee who cannot see the board is accepted (non-member, or a
 * member of client org A on a client-B project board), a bad assignee leaves a
 * partial write, the created card drops its assignee/reason/label, the assignee
 * is not notified or is notified twice on a retry, or a refresh moves, reassigns,
 * reopens or resurrects a card.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { registerSubjectAccessResolver, registerSubjectRoleResolver } from '../src/host/subjectAccess.js';
import {
  ADDRESSABLE_PROJECT_ROLES, addProjectMember, createProject, getProject, projectRoleOf, resolveProjectAccess,
} from '../src/features/projects/projectsService.js';
import {
  applyBoardCommand,
  createBoard,
  deleteCard,
  ensureSubjectBoard,
  getCard,
  listCardsAssignedToUser,
  listWorkItemsForBoard,
  moveCard,
  updateCardFields,
  type MaterializeKanbanWorkItemsCommand,
} from '../src/host/kanbanService.js';

let store: Storage;
let tenantId: string;

beforeAll(async () => {
  store = await openStorage('memory://');
  initHostExtPersistence(store);
  ensureNotificationEmitterInstalled(store);
  registerSubjectAccessResolver('project', (t, subject, caller) => resolveProjectAccess(t, subject.id, caller));
  // The same registration the projects feature makes at boot (feature.ts).
  registerSubjectRoleResolver('project', {
    addressable: ADDRESSABLE_PROJECT_ROLES,
    roleOf: async (t, subject, userId) => {
      const p = await getProject(t, subject.id);
      return p ? projectRoleOf(p, userId) ?? null : null;
    },
  });
  const ws = await createWorkspace({ name: 'Studio', ownerSubject: 'user:owner' });
  tenantId = ws.tenantId;
  await createMember({ tenantId, orgId: tenantId, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
});

afterAll(async () => {
  __resetHostExtPersistence();
  await store.close();
});

const inbox = async (who: string) =>
  (await store.listNotifications({ tenantId, recipientUserId: who })).filter((n) => n.type === 'task.assigned');

function command(boardId: string, over: Partial<MaterializeKanbanWorkItemsCommand> = {}): MaterializeKanbanWorkItemsCommand {
  return {
    type: 'work-items.materialize',
    tenantId,
    boardId,
    scope: { kind: 'adopter.tasks', externalRef: 'project-1' },
    source: { kind: 'adopter.record', id: 'rec-1' },
    idempotencyKey: 'first-delivery',
    items: [
      {
        key: 'order-sofa', title: 'Order the sofa', columnId: 'todo', dueAt: '2026-12-01T00:00:00.000Z',
        assigneeId: 'user:alice', assignmentReason: 'Lead designer', sourceLabel: 'Selections', labels: ['waiting-on'],
      },
    ],
    ...over,
  };
}

describe('ADR 1137 D1/D2 — a work item carries an assignee', () => {
  it('writes the assignee onto the card it creates and notifies them once, even on a retry', async () => {
    const board = await createBoard({ tenantId, name: 'Build' });
    const first = await applyBoardCommand(command(board.id));
    const card = first.cards[0]!;
    expect(card).toMatchObject({
      assigneeId: 'user:alice', assignmentReason: 'Lead designer', sourceLabel: 'Selections', labels: ['waiting-on'],
      dueAt: '2026-12-01T00:00:00.000Z',
    });
    expect(first.refreshedCardIds).toEqual([]);
    expect((await inbox('user:alice')).filter((n) => n.metadata?.cardId === card.id)).toHaveLength(1);

    await applyBoardCommand(command(board.id));
    await applyBoardCommand(command(board.id, { idempotencyKey: 'a-later-sync' }));
    expect((await inbox('user:alice')).filter((n) => n.metadata?.cardId === card.id)).toHaveLength(1);
  });

  it('a later materialize never overwrites who the board gave the card to', async () => {
    const board = await createBoard({ tenantId, name: 'Reassigned' });
    const { cards: [card] } = await applyBoardCommand(command(board.id));
    await updateCardFields(card!.id, { assigneeId: 'user:owner' });
    await applyBoardCommand(command(board.id, { idempotencyKey: 'again' }));
    expect((await getCard(card!.id))?.assigneeId).toBe('user:owner');
  });

  it('refuses a non-member assignee before writing anything', async () => {
    const board = await createBoard({ tenantId, name: 'Strangers' });
    const bad = command(board.id, {
      items: [
        { key: 'ok', title: 'Fine', columnId: 'todo', assigneeId: 'user:alice' },
        { key: 'bad', title: 'Not ours', columnId: 'todo', assigneeId: 'user:stranger' },
      ],
    });
    await expect(applyBoardCommand(bad)).rejects.toMatchObject({ code: 'kanban_assignee_invalid' });
    expect(await listWorkItemsForBoard(tenantId, board.id)).toHaveLength(0);
  });

  it('refuses both an assignee and a role on one item', async () => {
    const board = await createBoard({ tenantId, name: 'Both' });
    await expect(applyBoardCommand(command(board.id, {
      items: [{ key: 'x', title: 'x', columnId: 'todo', assigneeId: 'user:alice', assigneeRole: 'editor' }],
    }))).rejects.toMatchObject({ code: 'kanban_assignee_invalid' });
  });

  it('a role-addressed item notifies no one', async () => {
    const board = await createBoard({ tenantId, name: 'Roles' });
    const before = (await inbox('user:alice')).length;
    const { cards: [card] } = await applyBoardCommand(command(board.id, {
      items: [{ key: 'claim-me', title: 'Claim me', columnId: 'todo', assigneeRole: 'editor' }],
    }));
    expect(card?.assigneeRole).toBe('editor');
    expect(card?.assigneeId).toBeUndefined();
    expect(await inbox('user:alice')).toHaveLength(before);
  });

  it('client-org floor: a client-A member cannot be assigned a client-B project card', async () => {
    const clientA = await createOrg({ tenantId, createdBy: 'user:owner', name: 'Client A' });
    const clientB = await createOrg({ tenantId, createdBy: 'user:owner', name: 'Client B' });
    // Carol is in the workspace, but her only authority is in client A.
    await createMember({ tenantId, orgId: tenantId, subject: 'user:carol', displayName: 'Carol', roles: [] });
    await createMember({ tenantId, orgId: clientA.orgId, subject: 'user:carol', displayName: 'Carol', roles: ['editor'] });
    await createMember({ tenantId, orgId: clientB.orgId, subject: 'user:alice', displayName: 'Alice', roles: ['editor'] });
    const project = await createProject(tenantId, clientB.orgId, { name: 'B house' }, 'user:owner');
    expect(await resolveProjectAccess(tenantId, project.id, 'user:carol')).toBe('none');
    const board = await ensureSubjectBoard(tenantId, { kind: 'project', id: project.id }, 'B house');

    await expect(applyBoardCommand(command(board.id, {
      items: [{ key: 'b', title: 'B task', columnId: 'todo', assigneeId: 'user:carol' }],
    }))).rejects.toMatchObject({ code: 'kanban_assignee_invalid' });
    expect(await listWorkItemsForBoard(tenantId, board.id)).toHaveLength(0);

    const ok = await applyBoardCommand(command(board.id, {
      items: [{ key: 'b', title: 'B task', columnId: 'todo', assigneeId: 'user:alice' }],
    }));
    expect(ok.cards[0]?.assigneeId).toBe('user:alice');
  });
});

describe('ADR 1137 D3 — refresh updates the facts the source owns', () => {
  it('updates title, description, due date and source label, and keeps assignee, column and labels', async () => {
    const board = await createBoard({ tenantId, name: 'Refresh' });
    const { cards: [card] } = await applyBoardCommand(command(board.id));
    await moveCard(card!.id, 'doing');
    await updateCardFields(card!.id, { assigneeId: 'user:owner', labels: ['mine'] });

    const refreshed = await applyBoardCommand(command(board.id, {
      refresh: true,
      idempotencyKey: 'sync-2',
      items: [{
        key: 'order-sofa', title: 'Order the sofa (COM)', description: 'Fabric approved', columnId: 'todo',
        dueAt: '2026-12-15T00:00:00.000Z', sourceLabel: 'Selections · revised', assigneeId: 'user:alice', labels: ['waiting-on'],
      }],
    }));
    expect(refreshed.refreshedCardIds).toEqual([card!.id]);
    expect(await getCard(card!.id)).toMatchObject({
      title: 'Order the sofa (COM)', description: 'Fabric approved', dueAt: '2026-12-15T00:00:00.000Z',
      sourceLabel: 'Selections · revised', columnId: 'doing', assigneeId: 'user:owner', labels: ['mine'],
    });

    // Nothing changed ⇒ nothing written.
    const again = await applyBoardCommand(command(board.id, {
      refresh: true,
      idempotencyKey: 'sync-3',
      items: [{
        key: 'order-sofa', title: 'Order the sofa (COM)', description: 'Fabric approved', columnId: 'todo',
        dueAt: '2026-12-15T00:00:00.000Z', sourceLabel: 'Selections · revised',
      }],
    }));
    expect(again.refreshedCardIds).toEqual([]);
  });

  it('leaves a finished card as it was finished', async () => {
    const board = await createBoard({ tenantId, name: 'Finished' });
    const { cards: [card] } = await applyBoardCommand(command(board.id));
    await moveCard(card!.id, 'done');
    const r = await applyBoardCommand(command(board.id, {
      refresh: true, idempotencyKey: 'sync-done',
      items: [{ key: 'order-sofa', title: 'Renamed later', columnId: 'todo' }],
    }));
    expect(r.refreshedCardIds).toEqual([]);
    expect(await getCard(card!.id)).toMatchObject({ title: 'Order the sofa', columnId: 'done' });
  });

  it('never resurrects a card someone deleted', async () => {
    const board = await createBoard({ tenantId, name: 'Deleted' });
    const { cards: [card] } = await applyBoardCommand(command(board.id));
    await deleteCard(card!.id);
    const r = await applyBoardCommand(command(board.id, { refresh: true, idempotencyKey: 'sync-deleted' }));
    expect(r.cards).toHaveLength(0);
    expect(await getCard(card!.id)).toBeNull();
  });
});

describe('ADR 1137 D4 — a project role can address a card', () => {
  it('reaches the role holder on that project, and no one else', async () => {
    await createMember({ tenantId, orgId: tenantId, subject: 'user:dana', displayName: 'Dana', roles: ['editor'] });
    const project = await createProject(tenantId, tenantId, { name: 'Lake house' }, 'user:owner');
    await addProjectMember(tenantId, project.id, 'user:user:alice', 'lead', 'user:owner');
    await addProjectMember(tenantId, project.id, 'user:user:dana', 'contributor', 'user:owner');
    const board = await ensureSubjectBoard(tenantId, { kind: 'project', id: project.id }, 'Lake house');
    const other = await createProject(tenantId, tenantId, { name: 'Other' }, 'user:owner');
    await addProjectMember(tenantId, other.id, 'user:user:dana', 'lead', 'user:owner');

    const { cards: [card] } = await applyBoardCommand(command(board.id, {
      items: [{ key: 'walkthrough', title: 'Schedule the walkthrough', columnId: 'todo', assigneeRole: 'project:lead' }],
    }));
    expect(card?.assigneeRole).toBe('project:lead');
    expect((await listCardsAssignedToUser(tenantId, 'user:alice')).map((c) => c.id)).toContain(card!.id);
    // Dana leads a DIFFERENT project; a role is resolved against this board's own project.
    expect((await listCardsAssignedToUser(tenantId, 'user:dana')).map((c) => c.id)).not.toContain(card!.id);
    // A workspace role key spelled the same way matches nothing.
    expect((await listCardsAssignedToUser(tenantId, 'user:owner', ['project:lead'])).map((c) => c.id)).not.toContain(card!.id);
  });

  it('refuses an observer role, and a project role off a project board', async () => {
    const project = await createProject(tenantId, tenantId, { name: 'Roles only' }, 'user:owner');
    const board = await ensureSubjectBoard(tenantId, { kind: 'project', id: project.id }, 'Roles only');
    await expect(applyBoardCommand(command(board.id, {
      items: [{ key: 'o', title: 'Observe', columnId: 'todo', assigneeRole: 'project:observer' }],
    }))).rejects.toMatchObject({ code: 'kanban_assignee_invalid' });

    const plain = await createBoard({ tenantId, name: 'Plain' });
    await expect(applyBoardCommand(command(plain.id, {
      items: [{ key: 'p', title: 'Plain', columnId: 'todo', assigneeRole: 'project:lead' }],
    }))).rejects.toMatchObject({ code: 'kanban_assignee_invalid' });
    const { cards: [c] } = await applyBoardCommand(command(plain.id, {
      items: [{ key: 'p', title: 'Plain', columnId: 'todo' }],
    }));
    await expect(updateCardFields(c!.id, { assigneeRole: 'project:lead' })).rejects.toMatchObject({ code: 'kanban_assignee_invalid' });
    // A workspace role still works anywhere.
    expect((await updateCardFields(c!.id, { assigneeRole: 'editor' }))?.assigneeRole).toBe('editor');
  });
});
