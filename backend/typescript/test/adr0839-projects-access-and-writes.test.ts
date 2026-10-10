/**
 * ADR 0839 — projects: an absent caller reads nothing (D1), a schedule cannot outlive its
 * project (D3), project writes are compare-and-swap (D4), and the creator stamp is erasable
 * and is what demo-clear keys on (D5). Service level; the route-level delete cascade (D2) is
 * `adr0839-projects-delete-dependents.test.ts`.
 *
 * Every leg was run RED against `origin/main` @ `557f95faa` before the fix:
 *  - D1: `resolveProjectAccess(t, privateId, undefined)` answered `'write'` (the tenant-owner
 *    arm), the list scan returned the private project, and the seam answered `'write'`;
 *  - D3: a schedule created after the delete's job listing survived the delete;
 *  - D4: an edit that read before a delete and wrote after it brought the row back, and two
 *    concurrent member adds kept one;
 *  - D5: demo-clear deleted a person's project because its name matched a demo name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerSubjectAccessResolver, resolveSubjectAccess } from '../src/host/subjectAccess.js';
import { listJobsForSubject } from '../src/host/schedulingService.js';
import { ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import { registerSubjectDependent, __swapSubjectDependentForTest } from '../src/host/subjectDependents.js';
import { getBoard, subjectBoardId } from '../src/host/kanbanService.js';
import { isVisibleToAsync } from '../src/host/conversationVisibility.js';

// D4 needs a window between an edit's read and its write. `updateProject` awaits
// `getRosterEntry` while validating a moderator; the hook runs inside that await.
const rosterHook: { fn: (() => Promise<void>) | null } = { fn: null };
vi.mock('../src/host/rosterService.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/rosterService.js')>();
  return {
    ...real,
    getRosterEntry: async (tenantId: string, rosterId: string) => {
      const hook = rosterHook.fn; rosterHook.fn = null;
      if (hook) await hook();
      return { rosterId, persona: rosterId, agentRef: { agentId: rosterId }, workflows: [], tenantId, enabled: true };
    },
  };
});

// D3's delete half needs a window between `deleteProject`'s job listing and its row delete;
// `clearSubjectNotes` runs inside it.
const notesHook: { fn: (() => Promise<void>) | null } = { fn: null };
vi.mock('../src/host/subjectMemory.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/subjectMemory.js')>();
  return {
    ...real,
    clearSubjectNotes: async (...args: Parameters<typeof real.clearSubjectNotes>) => {
      const hook = notesHook.fn; notesHook.fn = null;
      if (hook) await hook();
      return real.clearSubjectNotes(...args);
    },
  };
});

const {
  createProject, deleteProject, getProject, updateProject, addProjectMember, setProjectVisibility,
  resolveProjectAccess, listVisibleProjects, buildProjectContextBlock, eraseSubjectProjects,
} = await import('../src/features/projects/projectsService.js');
const { createProjectSchedule } = await import('../src/features/projects/projectScheduleService.js');
const { clearDemoOpsPlanning } = await import('../src/host/demoOpsPlanningSeed.js');

const T = 'tAdr0839';
const ORG = 'org-adr0839';
let storage: Storage;

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0839-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  rosterHook.fn = null;
  notesHook.fn = null;
});

async function privateProject(name = 'Secret plan') {
  const p = await createProject(T, ORG, { name });
  await updateProject(T, p.id, { charter: { goal: 'acquire the competitor', status: 'active' } });
  await setProjectVisibility(T, p.id, 'private');
  return p;
}

describe('D1 — an absent caller is nobody, not the tenant owner', () => {
  it('BORN RED — the per-id door answers none for an absent caller on a private project', async () => {
    const p = await privateProject();
    expect(await resolveProjectAccess(T, p.id, undefined)).toBe('none');
  });

  it('BORN RED — the list scan and the context block withhold it too (same rule, every path)', async () => {
    const p = await privateProject();
    expect(await listVisibleProjects(T, undefined)).toEqual([]);
    expect((await buildProjectContextBlock(T, [p.id], undefined)).block).toBeNull();
  });

  it('BORN RED — the shared seam refuses an absent caller for a membership-scoped kind', async () => {
    const p = await privateProject();
    // Registered exactly as `projects/feature.ts` does.
    registerSubjectAccessResolver('project', async (tenantId, subject, caller) => resolveProjectAccess(tenantId, subject.id, caller));
    expect(await resolveSubjectAccess(T, { kind: 'project', id: p.id }, undefined)).toBe('none');
  });

  it('ratchet — the seam refuses an absent caller for ANY registered kind, even a resolver that would grant', async () => {
    // A resolver that grants unconditionally: the seam must not hand it an absent caller.
    registerSubjectAccessResolver('board', async () => 'write');
    expect(await resolveSubjectAccess(T, { kind: 'board', id: 'b1' }, undefined)).toBe('none');
    expect(await resolveSubjectAccess(T, { kind: 'board', id: 'b1' }, 'user:someone'), 'a named caller still reaches the resolver').toBe('write');
    expect(await resolveSubjectAccess(T, { kind: 'agent', id: 'a1' }, undefined), 'an unregistered kind keeps null').toBeNull();
  });

  it('positive control — a NAMED caller with no membership is still refused, and nothing else changed', async () => {
    const p = await privateProject();
    expect(await resolveProjectAccess(T, p.id, 'user:stranger')).toBe('none');
  });

  it('the strategy surface passes the run actor, never a hard-coded undefined', () => {
    const src = readFileSync(new URL('../src/features/strategy/surface.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/resolveStrategy(Context|Health)\([^)]*,\s*undefined\s*,/);
  });
});

describe('D1 — the conversation gate hands the seam the PRINCIPAL when there is no canonical user', () => {
  it('an anonymous demo owner / an owk_ key is resolved by principal; no principal at all is refused', async () => {
    registerSubjectAccessResolver('board', async (_t, _s, caller) => (caller === 'session:owner' ? 'write' : 'none'));
    const meta = { ownerSubject: { kind: 'board' as const, id: 'b1' } } as unknown as Parameters<typeof isVisibleToAsync>[0];
    expect(await isVisibleToAsync(meta, T, undefined, 'session:owner')).toBe(true);
    expect(await isVisibleToAsync(meta, T, undefined, 'session:stranger')).toBe(false);
    expect(await isVisibleToAsync(meta, T, undefined)).toBe(false);
  });
});

describe('D2 — a failing dependent keeps the project deletable', () => {
  it('a throw leaves the project and its board intact, names the dependent, and a retry converges', async () => {
    const p = await createProject(T, ORG, { name: 'Retry me' });
    let fail = true;
    let purged = 0;
    registerSubjectDependent('project', 'zzFlaky', {
      count: async () => (fail ? 1 : 0),
      purge: async () => { if (fail) throw new Error('store unreachable'); purged += 1; return 1; },
    });
    try {
      await expect(deleteProject(T, p.id)).rejects.toMatchObject({ details: { dependent: 'zzFlaky' } });
      expect(await getProject(T, p.id), 'the project survives').toBeTruthy();
      expect(await getBoard(subjectBoardId(T, { kind: 'project', id: p.id })), 'and nothing after the purge ran').toBeTruthy();
      fail = false;
      const out = await deleteProject(T, p.id);
      expect(out.deleted).toBe(true);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(await getProject(T, p.id)).toBeNull();
    } finally { __swapSubjectDependentForTest('project', 'zzFlaky', undefined); }
  });
});

describe('D3 — a schedule cannot outlive its project', () => {
  it('BORN RED — a create authorized before the delete but landing after it leaves no job behind', async () => {
    const p = await createProject(T, ORG, { name: 'Short-lived' });
    // The route authorized against a live project; then a delete ran.
    await deleteProject(T, p.id);
    await expect(createProjectSchedule(T, p.id, { cronExpr: '0 9 * * *', workflowId: 'wf-x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await listJobsForSubject(T, { kind: 'project', id: p.id })).toEqual([]);
  });

  it('a create that lands INSIDE the delete (after its job listing) is swept by the re-list', async () => {
    const p = await createProject(T, ORG, { name: 'Raced' });
    // Lands after `listJobsForSubject` and before the row delete: the create's own re-check
    // still sees the project, so only the delete's second listing can catch it.
    notesHook.fn = async () => { await createProjectSchedule(T, p.id, { cronExpr: '0 9 * * *', workflowId: 'wf-x' }); };
    const out = await deleteProject(T, p.id);
    expect(out.schedulesCleared).toBe(1);
    expect(await listJobsForSubject(T, { kind: 'project', id: p.id })).toEqual([]);
  });

  it('positive control — on a live project the schedule is created', async () => {
    const p = await createProject(T, ORG, { name: 'Alive' });
    await createProjectSchedule(T, p.id, { cronExpr: '0 9 * * *', workflowId: 'wf-x' });
    expect(await listJobsForSubject(T, { kind: 'project', id: p.id })).toHaveLength(1);
  });
});

describe('D4 — project writes are compare-and-swap', () => {
  it('BORN RED — an edit that read before a delete and writes after it does NOT resurrect the project', async () => {
    const p = await createProject(T, ORG, { name: 'Doomed' });
    await addProjectMember(T, p.id, 'agent:host:chair', 'lead');
    rosterHook.fn = async () => { await deleteProject(T, p.id); };
    await expect(updateProject(T, p.id, { moderatorRosterId: 'host:chair' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await getProject(T, p.id), 'the deleted row must stay deleted').toBeNull();
  });

  it('BORN RED — two concurrent member adds both land', async () => {
    const p = await createProject(T, ORG, { name: 'Busy' });
    await Promise.all([
      addProjectMember(T, p.id, 'agent:host:a', 'contributor'),
      addProjectMember(T, p.id, 'agent:host:b', 'contributor'),
    ]);
    expect((await getProject(T, p.id))?.members?.map((m) => m.ref).sort()).toEqual(['agent:host:a', 'agent:host:b']);
  });
});

describe('D5 — the creator stamp', () => {
  it('is erased by a DSAR in either key form, and counted', async () => {
    const p = await createProject(T, ORG, { name: 'Mine' }, 'user:u-hash-1');
    expect((await getProject(T, p.id))?.createdBy).toBe('user:u-hash-1');
    expect((await eraseSubjectProjects(T, 'user:u-hash-1')).rowsTouched).toBe(1);
    expect((await getProject(T, p.id))?.createdBy).toBe(ERASED_USER_REF);
    expect((await eraseSubjectProjects(T, 'user:u-hash-1')).rowsTouched, 'idempotent').toBe(0);
  });

  it('an AGENT-keyed DSAR never redacts a person\'s creator stamp (no tag bridging)', async () => {
    const p = await createProject(T, ORG, { name: 'Bridged?' }, 'user:x1');
    expect((await eraseSubjectProjects(T, 'agent:x1')).rowsTouched).toBe(0);
    expect((await getProject(T, p.id))?.createdBy).toBe('user:x1');
  });

  it('BORN RED — demo-clear does not delete a person\'s project that shares a demo name', async () => {
    const mine = await createProject(T, ORG, { name: 'Storefront Revamp' }, 'user:u-hash-2');
    await clearDemoOpsPlanning(T, storage);
    expect(await getProject(T, mine.id), 'a name is not a seed mark').toBeTruthy();
  });

  it('positive control — demo-clear still clears its own rows, stamped and pre-stamp', async () => {
    const stamped = await createProject(T, ORG, { name: 'Subscription Growth' }, 'demo:ops-planning');
    const legacy = await createProject(T, ORG, { name: 'Roastery Capacity' });
    await updateProject(T, legacy.id, { charter: { goal: 'Deliver roastery capacity for Solstice Roasters.' } });
    await clearDemoOpsPlanning(T, storage);
    expect(await getProject(T, stamped.id)).toBeNull();
    expect(await getProject(T, legacy.id)).toBeNull();
  });
});
