/**
 * Projects (ADR 0046 / ADR 0045 Phase 3) — a `kind:'project'` Subject: a bare
 * work container that OWNS the same surfaces an agent/person does (board, memory,
 * assigned workflows) over the unified subject model. A project does NOT think
 * (no cognition) and has NO authority of its own (ADR 0045 boundary): it is an
 * org-scoped container; a *person* with `workspace:write` in its org acts on it.
 *
 * Composition, not new infrastructure:
 *   - board  → `ensureSubjectBoard(tenantId, {kind:'project', id})` (kanban, generic owner)
 *   - memory → the `project:<id>` scope (subjectMemory — free; ADR 0041)
 *   - workflows → an entity-local array (like `RosterEntry.workflows`)
 *
 * @see docs/adr/0046-project-subject.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { ensureSubjectBoard, subjectBoardId, deleteBoard } from '../../host/kanbanService.js';
import { clearSubjectNotes } from '../../host/subjectMemory.js';
import { clearSubjectKnowledge } from '../../host/subjectKnowledge.js';
import { listJobsForSubject, deleteJob } from '../../host/schedulingService.js';
import { clearMemoryScope } from '../../host/inMemorySurfaces.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { parseTurnPolicy, type TurnPolicy } from '../../host/turnPolicy.js';
import type { AccessLevel } from '../../host/subjectAccess.js';
import { subjectScope, type Subject } from '../../host/subject.js';

/** ADR 0054 D1 — the project's definition (a single optional sub-object). */
export interface ProjectMilestone { id: string; title: string; dueDate?: string; done: boolean }
export type ProjectStatus = 'planning' | 'active' | 'paused' | 'done' | 'archived';
export type ProjectHealth = 'on-track' | 'at-risk' | 'off-track';
export interface ProjectCharter {
  goal?: string;            // the one-line outcome
  objectives?: string[];    // measurable sub-goals
  brief?: string;           // free-text charter / context (markdown)
  startDate?: string;       // ISO-8601
  endDate?: string;         // ISO-8601 (target)
  status?: ProjectStatus;
  health?: ProjectHealth;
  milestones?: ProjectMilestone[];
}

/** ADR 0054 D2 — a project's descriptive membership. `ref` is `user:<userId>` or
 *  `agent:<rosterId>` (ADR 0043 vocab). `role` is a LABEL, never an RBAC scope. */
export type ProjectRole = 'lead' | 'contributor' | 'observer';
export type ProjectVisibility = 'org' | 'private';
export interface ProjectMember { ref: string; role: ProjectRole; addedAt: string }

export interface Project {
  id: string;
  tenantId: string;
  /** The owning org (RBAC scope; ADR 0045 — a project has no authority itself). */
  orgId: string;
  name: string;
  /** ADR 0084 — an optional sub-type marker. A project with `facet:'notebook'` IS
   *  a Research Notebook (the notebooks feature is a project + a bound KB collection
   *  + subject memory — no parallel container). Absent ⇒ a plain project. Purely
   *  additive: every existing project path is unchanged when it is undefined. */
  facet?: 'notebook';
  /** ADR 0045 — entity-local assigned workflows (mirrors `RosterEntry.workflows`). */
  workflows: string[];
  /** ADR 0054 D1 — the project's charter/definition (absent ⇒ unchanged). */
  charter?: ProjectCharter;
  /** ADR 0054 D2 — descriptive roster of people + agents (default empty). */
  members?: ProjectMember[];
  /** ADR 0054 D5 — read-visibility. `'org'` (default): any org reader sees it.
   *  `'private'`: only members (+ org writers). WRITE is always org-scoped. */
  visibility?: ProjectVisibility;
  /** ADR 0054 D6 — the project group chat's cadence. `moderatorRosterId` (the
   *  chair/synthesizer) MUST be a project AGENT member; `turnPolicy` is the shared
   *  `TurnPolicy` primitive the advisory board uses. Both absent ⇒ no structured
   *  cadence (the chat is a plain group conversation). */
  moderatorRosterId?: string;
  turnPolicy?: TurnPolicy;
  createdAt: string;
  updatedAt: string;
}

const PROJECT_ROLES: ProjectRole[] = ['lead', 'contributor', 'observer'];
const MAX_MEMBERS = 100;

const STATUSES: ProjectStatus[] = ['planning', 'active', 'paused', 'done', 'archived'];
const HEALTHS: ProjectHealth[] = ['on-track', 'at-risk', 'off-track'];
const MAX_OBJECTIVES = 20;
const MAX_MILESTONES = 50;

/** Validate + cap a charter patch, dropping unknown/empty fields (full replace). */
function parseCharter(input: unknown): ProjectCharter {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: ProjectCharter = {};
  const goal = cleanString(raw.goal, 200); if (goal) out.goal = goal;
  const brief = cleanString(raw.brief, 8000); if (brief) out.brief = brief;
  const startDate = cleanString(raw.startDate, 40); if (startDate) out.startDate = startDate;
  const endDate = cleanString(raw.endDate, 40); if (endDate) out.endDate = endDate;
  if (STATUSES.includes(raw.status as ProjectStatus)) out.status = raw.status as ProjectStatus;
  if (HEALTHS.includes(raw.health as ProjectHealth)) out.health = raw.health as ProjectHealth;
  if (Array.isArray(raw.objectives)) {
    const objectives = raw.objectives.slice(0, MAX_OBJECTIVES).map((o) => cleanString(o, 200)).filter((o): o is string => !!o);
    if (objectives.length) out.objectives = objectives;
  }
  if (Array.isArray(raw.milestones)) {
    const milestones = raw.milestones.slice(0, MAX_MILESTONES).map((m): ProjectMilestone | null => {
      const mm = (m ?? {}) as Record<string, unknown>;
      const title = cleanString(mm.title, 160);
      if (!title) return null;
      const due = cleanString(mm.dueDate, 40);
      return { id: typeof mm.id === 'string' && mm.id ? mm.id.slice(0, 64) : `ms-${randomUUID().slice(0, 8)}`, title, done: mm.done === true, ...(due ? { dueDate: due } : {}) };
    }).filter((m): m is ProjectMilestone => m !== null);
    if (milestones.length) out.milestones = milestones;
  }
  return out;
}

const store = new DurableCollection<Project>('projects:project', (p) => p.id);
const PROJECT_CAP = 200;

/** The project as a memory/board Subject. */
export const projectSubject = (id: string): Subject => ({ kind: 'project', id });

function nowIso(): string { return new Date().toISOString(); }

/** Create a project + provision its board (idempotent board). Org-scoped. */
export async function createProject(tenantId: string, orgId: string, input: { name?: unknown; facet?: 'notebook' }): Promise<Project> {
  const name = cleanString(input.name, 120);
  if (!name) throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
  // Best-effort cap (read-then-write, not CAS): concurrent creates could briefly
  // exceed PROJECT_CAP. Tolerated — a soft workspace guard, not a security boundary.
  if ((await listProjects(tenantId)).length >= PROJECT_CAP) {
    throw new OpenwopError('validation_error', `This workspace already has the maximum ${PROJECT_CAP} projects.`, 400, { cap: PROJECT_CAP });
  }
  const id = `project-${randomUUID().slice(0, 12)}`;
  const ts = nowIso();
  const project: Project = { id, tenantId, orgId, name, workflows: [], members: [], visibility: 'org', createdAt: ts, updatedAt: ts, ...(input.facet ? { facet: input.facet } : {}) };
  await store.put(project);
  await ensureSubjectBoard(tenantId, projectSubject(id), `${name} board`);
  return project;
}

/** A project by id, tenant-scoped (IDOR — a foreign-tenant project reads null). */
export async function getProject(tenantId: string, id: string): Promise<Project | null> {
  const p = await store.get(id);
  return p && p.tenantId === tenantId ? p : null;
}

export async function listProjects(tenantId: string): Promise<Project[]> {
  return (await store.list()).filter((p) => p.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Rename / set workflows / set the charter. Tenant-scoped. (Charter is a full
 *  replace: PATCH `{ charter: {...} }` overwrites; `{ charter: null }` clears.) */
export async function updateProject(tenantId: string, id: string, patch: { name?: unknown; workflows?: unknown; charter?: unknown; moderatorRosterId?: unknown; turnPolicy?: unknown }): Promise<Project> {
  const current = await getProject(tenantId, id);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id });
  const next: Project = { ...current, updatedAt: nowIso() };
  if ('name' in patch && patch.name !== undefined) {
    const name = cleanString(patch.name, 120);
    if (!name) throw new OpenwopError('validation_error', 'Field `name` must be a non-empty string.', 400, { field: 'name' });
    next.name = name;
  }
  if ('workflows' in patch && patch.workflows !== undefined) {
    if (!Array.isArray(patch.workflows) || patch.workflows.some((w) => typeof w !== 'string')) {
      throw new OpenwopError('validation_error', 'Field `workflows` must be an array of workflow ids.', 400, { field: 'workflows' });
    }
    next.workflows = patch.workflows as string[];
  }
  if ('charter' in patch && patch.charter !== undefined) {
    if (patch.charter === null) delete next.charter;
    else {
      const charter = parseCharter(patch.charter);
      if (Object.keys(charter).length) next.charter = charter; else delete next.charter;
    }
  }
  // ADR 0054 D6 — the group-chat cadence. `turnPolicy` rides the shared validator
  // (clamped for cost); `moderatorRosterId` MUST be a project AGENT member (the
  // chair speaks in the room, so it has to be IN the room — `members[]` stays the
  // single source of truth for who is on the project). `null` clears either.
  if ('turnPolicy' in patch && patch.turnPolicy !== undefined) {
    if (patch.turnPolicy === null) delete next.turnPolicy;
    else next.turnPolicy = parseTurnPolicy(patch.turnPolicy);
  }
  if ('moderatorRosterId' in patch && patch.moderatorRosterId !== undefined) {
    if (patch.moderatorRosterId === null) {
      delete next.moderatorRosterId;
    } else {
      const modId = cleanString(patch.moderatorRosterId, 200);
      if (!modId) throw new OpenwopError('validation_error', '`moderatorRosterId` must be a non-empty roster id.', 400, { field: 'moderatorRosterId' });
      const entry = await getRosterEntry(modId);
      if (!entry || entry.tenantId !== tenantId) throw new OpenwopError('not_found', 'Moderator not found in this workspace.', 404, { moderatorRosterId: modId });
      // This member check races a concurrent member removal, but that's benign: the
      // convene consumer (ChatSidebar) re-validates `moderator ∈ members` and falls
      // back to no chair, and `removeProjectMember` clears the moderator on removal.
      if (!(next.members ?? []).some((m) => m.ref === `agent:${modId}`)) {
        throw new OpenwopError('validation_error', 'The moderator MUST be a project agent member — add it on the Members tab first.', 422, { moderatorRosterId: modId });
      }
      next.moderatorRosterId = modId;
    }
  }
  await store.put(next);
  return next;
}

// ── ADR 0054 D2/D5 — membership + visibility + the access resolver ──

const userMemberRef = (userId: string): string => `user:${userId}`;

/** The caller's access LEVEL for a project (ADR 0054 D5 — the ONE place the
 *  visibility ≠ authority rule lives; the `subjectAccess` seam wraps this for
 *  kanban). WRITE ⟺ `workspace:write` in the project's org (membership NEVER
 *  grants write). READ = write OR (`org`-visible && org-read) OR (`private` &&
 *  the caller is a people-member). Fail-closed: unknown project ⇒ `'none'`. */
export async function resolveProjectAccess(tenantId: string, projectId: string, callerSubject: string | undefined): Promise<AccessLevel> {
  const p = await getProject(tenantId, projectId);
  if (!p) return 'none';
  const access = await resolveEffectiveAccess(tenantId, { subject: callerSubject, orgId: p.orgId });
  if (access.scopes.includes('workspace:write')) return 'write';
  const visibility = p.visibility ?? 'org';
  if (visibility === 'org' && access.scopes.includes('workspace:read')) return 'read';
  if (visibility === 'private' && callerSubject && (p.members ?? []).some((m) => m.ref === userMemberRef(callerSubject))) return 'read';
  return 'none';
}

/** Add (or re-role) a member. Validates the ref: a `user:` ref MUST be an org
 *  member of the project's org (can't add a stranger); an `agent:` ref MUST be a
 *  tenant roster entry. Caller authority is enforced at the route (write). */
export async function addProjectMember(tenantId: string, projectId: string, ref: unknown, role: unknown): Promise<Project> {
  const current = await getProject(tenantId, projectId);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id: projectId });
  const r = cleanString(ref, 200);
  const m = /^(user|agent):(.+)$/.exec(r);
  if (!m) throw new OpenwopError('validation_error', '`ref` must be `user:<userId>` or `agent:<rosterId>`.', 400, { field: 'ref' });
  const projectRole: ProjectRole = PROJECT_ROLES.includes(role as ProjectRole) ? (role as ProjectRole) : 'contributor';
  const [, kind, id] = m;
  if (kind === 'user') {
    const access = await resolveEffectiveAccess(tenantId, { subject: id, orgId: current.orgId });
    if (access.basis === 'none') throw new OpenwopError('validation_error', 'That person is not a member of this project’s org.', 400, { ref: r });
  } else {
    const entry = await getRosterEntry(id);
    if (!entry || entry.tenantId !== tenantId) throw new OpenwopError('validation_error', 'That agent is not in this workspace’s roster.', 400, { ref: r });
  }
  const members = (current.members ?? []).filter((x) => x.ref !== r);
  if (members.length >= MAX_MEMBERS) throw new OpenwopError('validation_error', `This project already has the maximum ${MAX_MEMBERS} members.`, 400, { cap: MAX_MEMBERS });
  members.push({ ref: r, role: projectRole, addedAt: nowIso() });
  const next: Project = { ...current, members, updatedAt: nowIso() };
  await store.put(next);
  return next;
}

/** Remove a member (descriptive only — never revokes org authority). */
export async function removeProjectMember(tenantId: string, projectId: string, ref: string): Promise<Project> {
  const current = await getProject(tenantId, projectId);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id: projectId });
  const next: Project = { ...current, members: (current.members ?? []).filter((m) => m.ref !== ref), updatedAt: nowIso() };
  // ADR 0054 D6 — keep `moderatorRosterId ∈ members`: removing the moderator agent
  // clears the now-stale chair (else it would point outside the room).
  if (current.moderatorRosterId && ref === `agent:${current.moderatorRosterId}`) delete next.moderatorRosterId;
  await store.put(next);
  return next;
}

/** Set the project's read-visibility (ADR 0054 D5). */
export async function setProjectVisibility(tenantId: string, projectId: string, visibility: unknown): Promise<Project> {
  const current = await getProject(tenantId, projectId);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id: projectId });
  if (visibility !== 'org' && visibility !== 'private') {
    throw new OpenwopError('validation_error', '`visibility` must be `org` or `private`.', 400, { field: 'visibility' });
  }
  const next: Project = { ...current, visibility, updatedAt: nowIso() };
  await store.put(next);
  return next;
}

/** Delete a project + cascade its owned surfaces (board + memory + knowledge
 *  binding + schedules). Returns the cleanup counts. Tenant-scoped fail-closed. */
export async function deleteProject(tenantId: string, id: string): Promise<{ deleted: boolean; memoryEntriesCleared: number; schedulesCleared: number }> {
  const current = await getProject(tenantId, id);
  if (!current) return { deleted: false, memoryEntriesCleared: 0, schedulesCleared: 0 };
  // Board first (so its cards are unreachable), then schedules (so they stop
  // firing), then memory + knowledge binding, then the record. (The bound KB
  // collections are shared — not deleted.)
  await deleteBoard(subjectBoardId(tenantId, projectSubject(id)));
  // Schedules: delete every job the project subject owns (the ONE scheduler; host
  // functions only — avoids a feature→feature cycle with projectScheduleService).
  const ownedJobs = await listJobsForSubject(tenantId, projectSubject(id));
  for (const j of ownedJobs) await deleteJob(j.jobId);
  const schedulesCleared = ownedJobs.length;
  const durableNotes = await clearSubjectNotes(tenantId, projectSubject(id));
  const memoryEntriesCleared = clearMemoryScope(tenantId, subjectScope(projectSubject(id))) + durableNotes;
  await clearSubjectKnowledge(tenantId, projectSubject(id));
  await store.delete(id);
  return { deleted: true, memoryEntriesCleared, schedulesCleared };
}

/**
 * A static "Project context" block for a Board of Advisors (ADR 0079/0100) — the
 * project counterpart of `buildStrategyContextBlock`. Given selected project ids +
 * the convener subject, returns a compact charter summary (goal / status / health /
 * objectives / milestones) for the readable projects, or `null` if none resolve.
 *
 * RBAC: each project is gated by `resolveProjectAccess` — a project the convener
 * cannot read (e.g. a `private` project they're not a member of) is silently
 * omitted, mirroring how the strategy block filters unreadable strategies.
 */
export async function buildProjectContextBlock(tenantId: string, projectIds: string[], subject: string | undefined): Promise<string | null> {
  const blocks: string[] = [];
  for (const id of projectIds) {
    if ((await resolveProjectAccess(tenantId, id, subject)) === 'none') continue; // RBAC filter
    const p = await getProject(tenantId, id);
    if (!p) continue;
    const c = p.charter ?? {};
    const parts = [`### Project: ${p.name}`];
    if (c.goal) parts.push(`Goal: ${c.goal}`);
    if (c.status || c.health) parts.push(`Status: ${c.status ?? 'unset'}${c.health ? ` · Health: ${c.health}` : ''}`);
    if (c.objectives && c.objectives.length > 0) parts.push(`Objectives:\n${c.objectives.map((o) => `- ${o}`).join('\n')}`);
    if (c.milestones && c.milestones.length > 0) {
      parts.push(`Milestones:\n${c.milestones.map((m) => `- ${m.title}${m.dueDate ? ` (due ${m.dueDate})` : ''}${m.done ? ' [done]' : ''}`).join('\n')}`);
    }
    if (c.brief) parts.push(c.brief);
    blocks.push(parts.join('\n'));
  }
  if (blocks.length === 0) return null;
  // "Projects" (not "Active projects") — the block carries every SELECTED project
  // regardless of status; each line states its own status, so the heading must not
  // imply they're all active.
  return `## Projects\n\n${blocks.join('\n\n')}`;
}
